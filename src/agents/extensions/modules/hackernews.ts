/**
 * Hacker News search via Algolia — keyless.
 *
 * Endpoint: `https://hn.algolia.com/api/v1/search` (Algolia-powered HN
 * mirror). No auth, no rate-limit short of abuse. Ideal for "what does HN
 * think of X" / tech-news / startup-signal queries.
 *
 * Operator config (`tools.web.search.providers.hackernews`):
 *   { tags?, sortBy? }
 *     tags: 'story' | 'comment' | 'poll' | 'show_hn' | 'ask_hn' (or compound, e.g. "story,show_hn")
 *     sortBy: 'relevance' (default) | 'date' (use `/search_by_date` endpoint)
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
	wrapSearchHit,
} from "./web-provider-helpers.js";

const HN_ENDPOINT_RELEVANCE = "https://hn.algolia.com/api/v1/search";
const HN_ENDPOINT_DATE = "https://hn.algolia.com/api/v1/search_by_date";

interface HnConfig {
	tags?: string;
	sortBy?: "relevance" | "date";
}

interface HnHit {
	title?: unknown;
	url?: unknown;
	story_title?: unknown;
	story_url?: unknown;
	objectID?: unknown;
	author?: unknown;
	points?: unknown;
	num_comments?: unknown;
	created_at?: unknown;
}

interface HnResponse {
	hits?: HnHit[];
}

function createHackerNewsSearchProvider(): WebSearchProvider {
	return {
		id: "hackernews",
		label: "Hacker News",
		hint: "Algolia-powered HN search. Keyless. Best for tech/startup signal.",
		requiresCredential: false,
		envVars: [],
		signupUrl: "https://news.ycombinator.com",
		docsUrl: "https://hn.algolia.com/api",
		autoDetectOrder: 160,
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const cfgSlot = readProviderConfigSlot<HnConfig>({
				cfg: ctx.config,
				providerId: "hackernews",
				kind: "search",
			});
			const sortByDate = cfgSlot.sortBy === "date";
			const tags = cfgSlot.tags?.trim();
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Hacker News search via Algolia — tech-news, startup signal, dev opinions.",
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
					if (!query) throw new Error("hackernews: missing query");
					const hitsPerPage = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						50,
					);
					const url = new URL(sortByDate ? HN_ENDPOINT_DATE : HN_ENDPOINT_RELEVANCE);
					url.searchParams.set("query", query);
					url.searchParams.set("hitsPerPage", String(hitsPerPage));
					if (tags) url.searchParams.set("tags", tags);

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers: { accept: "application/json" },
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`hackernews: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(body) as HnResponse;
							} catch {
								throw new Error("hackernews: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.hits) ? data.hits : [];
						const results = rawHits
							.map((h) => {
								const title = typeof h.title === "string"
									? h.title.trim()
									: typeof h.story_title === "string"
										? (h.story_title as string).trim()
										: "";
								// External URL when the story has one (link post); else fall
								// back to the HN item page (text post / comment).
								const itemId = typeof h.objectID === "string" ? h.objectID : "";
								const externalUrl = typeof h.url === "string"
									? h.url
									: typeof h.story_url === "string"
										? (h.story_url as string)
										: "";
								const hnPermalink = itemId
									? `https://news.ycombinator.com/item?id=${itemId}`
									: "";
								const finalUrl = externalUrl || hnPermalink;
								if (!title || !finalUrl) return null;
								// Snippet: author + score + comment count — gives the model
								// signal beyond the headline.
								const score = typeof h.points === "number" ? h.points : null;
								const comments = typeof h.num_comments === "number" ? h.num_comments : null;
								const author = typeof h.author === "string" ? h.author : null;
								const snippetParts: string[] = [];
								if (author) snippetParts.push(`by ${author}`);
								if (score !== null) snippetParts.push(`${score} points`);
								if (comments !== null) snippetParts.push(`${comments} comments`);
								const snippet = snippetParts.join(" · ") || undefined;
								const published = typeof h.created_at === "string" ? h.created_at : undefined;
								return wrapSearchHit({
									title,
									url: finalUrl,
									snippet,
									siteName: resolveSiteName(finalUrl),
									published,
									score: typeof score === "number" ? score : undefined,
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "hackernews", results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
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

export const hackerNewsModule = defineModule({
	id: "hackernews",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createHackerNewsSearchProvider());
	},
});

export { createHackerNewsSearchProvider };
