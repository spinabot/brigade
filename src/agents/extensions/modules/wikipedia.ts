/**
 * Wikipedia REST API provider — keyless, generous rate-limit.
 *
 * Hits `https://en.wikipedia.org/w/api.php` (the MediaWiki Action API) and
 * returns title + URL + extract snippet for each match. For "what is X"
 * questions this is dramatically more accurate than generic web search.
 *
 * Operator config (`tools.web.search.providers.wikipedia`):
 *   { lang?, snippetMaxChars? }   // lang: ISO 639-1 code, default "en"
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

const DEFAULT_SNIPPET_MAX = 600;

interface WikipediaConfig {
	lang?: string;
	snippetMaxChars?: number;
}

interface MwSearchHit {
	title?: unknown;
	snippet?: unknown;
	pageid?: unknown;
}

interface MwSearchResponse {
	query?: { search?: MwSearchHit[] };
}

function stripMwMarkup(html: string): string {
	// MediaWiki returns snippets with `<span class="searchmatch">…</span>`
	// wrappers around hit terms. Drop the tags but keep the text. Then
	// decode the few entities the API uses.
	return html
		.replace(/<\/?[a-z][^>]*>/gi, "")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.trim();
}

function createWikipediaSearchProvider(): WebSearchProvider {
	return {
		id: "wikipedia",
		label: "Wikipedia",
		hint: "MediaWiki REST API — keyless, perfect for definitions + topic overviews.",
		requiresCredential: false,
		envVars: [],
		signupUrl: "https://en.wikipedia.org",
		docsUrl: "https://www.mediawiki.org/wiki/API:Search",
		// Beats DDG (100) when the query looks encyclopedic — but agents
		// usually call this explicitly via per-call `provider: "wikipedia"`.
		autoDetectOrder: 150,
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const cfgSlot = readProviderConfigSlot<WikipediaConfig>({
				cfg: ctx.config,
				providerId: "wikipedia",
				kind: "search",
			});
			const lang = (cfgSlot.lang || "en").toLowerCase().replace(/[^a-z-]/g, "") || "en";
			const snippetMax = typeof cfgSlot.snippetMaxChars === "number" && cfgSlot.snippetMaxChars > 0
				? Math.floor(cfgSlot.snippetMaxChars)
				: DEFAULT_SNIPPET_MAX;
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description:
					"Wikipedia search via the MediaWiki API. Returns article titles + URLs + extract snippets.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 25 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("wikipedia: missing query");
					const count = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);
					const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
					url.searchParams.set("action", "query");
					url.searchParams.set("list", "search");
					url.searchParams.set("srsearch", query);
					url.searchParams.set("srlimit", String(count));
					url.searchParams.set("srprop", "snippet");
					url.searchParams.set("format", "json");
					url.searchParams.set("formatversion", "2");
					url.searchParams.set("origin", "*");

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers: {
								accept: "application/json",
								// MediaWiki asks API consumers to identify themselves.
								"user-agent": "Brigade/1.0 (https://github.com/Bhasvanth-Dev9380/brigade) Node.js",
							},
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`wikipedia: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(body) as MwSearchResponse;
							} catch {
								throw new Error("wikipedia: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.query?.search) ? data.query!.search! : [];
						const results = rawHits
							.map((h) => {
								const title = typeof h.title === "string" ? h.title.trim() : "";
								if (!title) return null;
								const articleUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s/g, "_"))}`;
								const snippet = typeof h.snippet === "string"
									? stripMwMarkup(h.snippet).slice(0, snippetMax)
									: undefined;
								return wrapSearchHit({
									title,
									url: articleUrl,
									snippet: snippet && snippet.length > 0 ? snippet : undefined,
									siteName: resolveSiteName(articleUrl),
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "wikipedia", results };
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

export const wikipediaModule = defineModule({
	id: "wikipedia",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createWikipediaSearchProvider());
	},
});

export { createWikipediaSearchProvider, stripMwMarkup };
