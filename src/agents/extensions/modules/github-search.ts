/**
 * GitHub search provider — keyless by default.
 *
 * GitHub's REST search API is open without auth (capped at 60 req/hr per
 * IP). With a token (PAT or `gh auth token`), the cap rises to 5 000/hr.
 *
 * Endpoint family: `https://api.github.com/search/{repositories|code|issues|users}`
 *
 * Operator config (`tools.web.search.providers.github`):
 *   { token?, target?, sort?, order? }
 *     target: 'repositories' | 'code' | 'issues' | 'users' (default 'repositories')
 *     sort:   'stars' | 'forks' | 'updated' | 'help-wanted-issues'  (per target)
 *     order:  'asc' | 'desc' (default desc)
 *
 * Auth: optional `GITHUB_TOKEN` env or config.token.
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import {
	readProviderConfigSlot,
	resolveSiteName,
	sanitizeHeaderToken,
	wrapSearchHit,
} from "./web-provider-helpers.js";

type GhTarget = "repositories" | "code" | "issues" | "users";

interface GithubConfig {
	token?: string;
	target?: GhTarget;
	sort?: string;
	order?: "asc" | "desc";
}

interface GhRepoItem {
	full_name?: unknown;
	html_url?: unknown;
	description?: unknown;
	stargazers_count?: unknown;
	updated_at?: unknown;
}
interface GhCodeItem {
	name?: unknown;
	path?: unknown;
	html_url?: unknown;
	repository?: { full_name?: unknown };
}
interface GhIssueItem {
	title?: unknown;
	html_url?: unknown;
	body?: unknown;
	state?: unknown;
	created_at?: unknown;
	user?: { login?: unknown };
}
interface GhUserItem {
	login?: unknown;
	html_url?: unknown;
	type?: unknown;
}
interface GhSearchResponse {
	items?: Array<GhRepoItem | GhCodeItem | GhIssueItem | GhUserItem>;
}

function resolveGithubToken(cfgSlot: Partial<GithubConfig>, env?: NodeJS.ProcessEnv): string | undefined {
	const cfg = cfgSlot.token?.trim();
	const e = env?.GITHUB_TOKEN?.trim() ?? env?.GH_TOKEN?.trim();
	const raw = cfg || e;
	if (!raw) return undefined;
	const cleaned = sanitizeHeaderToken(raw);
	return cleaned.length > 0 ? cleaned : undefined;
}

function createGithubSearchProvider(): WebSearchProvider {
	return {
		id: "github",
		label: "GitHub",
		hint: "GitHub's REST search API. Keyless (60 req/hr); token raises cap to 5 000/hr.",
		// Technically keyless — we mark requiresCredential false so the
		// provider activates without a token. The token is OPTIONAL.
		requiresCredential: false,
		envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
		signupUrl: "https://github.com",
		docsUrl: "https://docs.github.com/en/rest/search/search",
		autoDetectOrder: 170,
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const cfgSlot = readProviderConfigSlot<GithubConfig>({
				cfg: ctx.config,
				providerId: "github",
				kind: "search",
			});
			const token = resolveGithubToken(cfgSlot, ctx.env);
			const target: GhTarget = (cfgSlot.target as GhTarget) || "repositories";
			const sort = cfgSlot.sort?.trim();
			const order = cfgSlot.order === "asc" ? "asc" : "desc";
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: `GitHub search (${target}). Returns repo / code / issue / user matches with stars + author metadata.`,
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 50 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("github: missing query");
					const per_page = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						50,
					);
					const url = new URL(`https://api.github.com/search/${target}`);
					url.searchParams.set("q", query);
					url.searchParams.set("per_page", String(per_page));
					if (sort) url.searchParams.set("sort", sort);
					url.searchParams.set("order", order);
					const headers: Record<string, string> = {
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
						"user-agent": "Brigade/1.0",
					};
					if (token) headers.authorization = `Bearer ${token}`;

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers,
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status === 403 && /rate limit/i.test(body)) {
							throw new Error(
								"github: rate-limit hit (60 req/hr keyless). Set GITHUB_TOKEN env or tools.web.search.providers.github.token for 5 000/hr.",
							);
						}
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`github: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(body) as GhSearchResponse;
							} catch {
								throw new Error("github: invalid JSON from upstream");
							}
						})();
						const items = Array.isArray(data.items) ? data.items : [];
						const results = items
							.map((raw) => mapGhItem(raw, target))
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "github", target, results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

function mapGhItem(
	raw: GhRepoItem | GhCodeItem | GhIssueItem | GhUserItem,
	target: GhTarget,
): ReturnType<typeof wrapSearchHit> | null {
	switch (target) {
		case "repositories": {
			const r = raw as GhRepoItem;
			const title = typeof r.full_name === "string" ? r.full_name : "";
			const url = typeof r.html_url === "string" ? r.html_url : "";
			if (!title || !url) return null;
			const snippetParts: string[] = [];
			if (typeof r.description === "string" && r.description) snippetParts.push(r.description);
			if (typeof r.stargazers_count === "number") snippetParts.push(`★ ${r.stargazers_count}`);
			return wrapSearchHit({
				title,
				url,
				snippet: snippetParts.join(" · ") || undefined,
				siteName: resolveSiteName(url),
				published: typeof r.updated_at === "string" ? r.updated_at : undefined,
			});
		}
		case "code": {
			const r = raw as GhCodeItem;
			const repo = typeof r.repository?.full_name === "string" ? r.repository.full_name : "";
			const path = typeof r.path === "string" ? r.path : "";
			const title = repo && path ? `${repo}/${path}` : (typeof r.name === "string" ? r.name : "");
			const url = typeof r.html_url === "string" ? r.html_url : "";
			if (!title || !url) return null;
			return wrapSearchHit({ title, url, siteName: resolveSiteName(url) });
		}
		case "issues": {
			const r = raw as GhIssueItem;
			const title = typeof r.title === "string" ? r.title : "";
			const url = typeof r.html_url === "string" ? r.html_url : "";
			if (!title || !url) return null;
			const author = typeof r.user?.login === "string" ? r.user.login : null;
			const state = typeof r.state === "string" ? r.state : null;
			const parts: string[] = [];
			if (state) parts.push(state);
			if (author) parts.push(`by ${author}`);
			if (typeof r.body === "string" && r.body) parts.push(r.body.slice(0, 200));
			return wrapSearchHit({
				title,
				url,
				snippet: parts.join(" · ") || undefined,
				siteName: resolveSiteName(url),
				published: typeof r.created_at === "string" ? r.created_at : undefined,
			});
		}
		case "users": {
			const r = raw as GhUserItem;
			const title = typeof r.login === "string" ? r.login : "";
			const url = typeof r.html_url === "string" ? r.html_url : "";
			if (!title || !url) return null;
			return wrapSearchHit({
				title,
				url,
				snippet: typeof r.type === "string" ? r.type : undefined,
				siteName: resolveSiteName(url),
			});
		}
	}
}

function mergeSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
	const real = signals.filter((s): s is AbortSignal => s !== undefined);
	if (real.length === 0) return undefined;
	if (real.length === 1) return real[0];
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn.call(AbortSignal, real);
	const ctl = new AbortController();
	for (const s of real) {
		if (s.aborted) {
			ctl.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
	}
	return ctl.signal;
}

export const githubSearchModule = defineModule({
	id: "github-search",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createGithubSearchProvider());
	},
});

export { createGithubSearchProvider, resolveGithubToken };
