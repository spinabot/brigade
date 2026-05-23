/**
 * Perplexity web-search provider — structured search results.
 *
 * Two transports exist in Perplexity's ecosystem: the structured Search API
 * (`/search`) and the Sonar chat-completions API (`/chat/completions` with
 * built-in citations). Brigade ships the Search API for v1 because it
 * returns clean URL hits without an extra "extract synthesized answer"
 * step. The Sonar path is a future bolt-on.
 *
 * Endpoint: `https://api.perplexity.ai/search`. Auth: `Authorization: Bearer`.
 *
 * Operator config (`tools.web.search.providers.perplexity`):
 *   { apiKey?, country?, searchRecencyFilter?, searchDomainFilter?[] }
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
	resolveProviderApiKey,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";

const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/search";

interface PerplexityConfig {
	apiKey?: string;
	country?: string;
	searchRecencyFilter?: "day" | "week" | "month" | "year";
	searchDomainFilter?: string[];
	/** ISO 639-1 language codes (e.g. ["en", "de"]). */
	searchLanguageFilter?: string[];
	/** YYYY-MM-DD lower-bound on publication date. */
	searchAfterDate?: string;
	/** YYYY-MM-DD upper-bound. */
	searchBeforeDate?: string;
	/** Total content budget across results (per-call). */
	maxTokens?: number;
	/** Per-page content budget. */
	maxTokensPerPage?: number;
}

function isValidIsoDate(raw: string | undefined): boolean {
	if (!raw) return false;
	return /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`));
}

interface PerplexityHit {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	date?: unknown;
}

interface PerplexityResponse {
	results?: PerplexityHit[];
}

function createPerplexitySearchProvider(): WebSearchProvider {
	return {
		id: "perplexity",
		label: "Perplexity",
		hint: "Perplexity Search API — research-grade ranked URL hits.",
		requiresCredential: true,
		envVars: ["PERPLEXITY_API_KEY"],
		signupUrl: "https://www.perplexity.ai/settings/api",
		docsUrl: "https://docs.perplexity.ai/api-reference/search-post",
		placeholder: "pplx-…",
		autoDetectOrder: 45,
		isConfigured(cfg, env) {
			return (
				resolveProviderApiKey({
					cfg,
					env,
					providerId: "perplexity",
					kind: "search",
					envVars: ["PERPLEXITY_API_KEY"],
				}) !== undefined
			);
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveProviderApiKey({
				cfg: ctx.config,
				env: ctx.env,
				providerId: "perplexity",
				kind: "search",
				envVars: ["PERPLEXITY_API_KEY"],
			});
			if (!apiKey) return null;
			const cfgSlot = readProviderConfigSlot<PerplexityConfig>({
				cfg: ctx.config,
				providerId: "perplexity",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Perplexity Search — research-mode ranked results with date metadata.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 10 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("perplexity: missing query");
					const max_results = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						10,
					);
					const body: Record<string, unknown> = { query, max_results };
					if (cfgSlot.country) body.country = cfgSlot.country;
					if (cfgSlot.searchRecencyFilter) body.search_recency_filter = cfgSlot.searchRecencyFilter;
					if (cfgSlot.searchDomainFilter?.length) {
						body.search_domain_filter = cfgSlot.searchDomainFilter.slice(0, 20);
					}
					if (cfgSlot.searchLanguageFilter?.length) {
						body.search_language_filter = cfgSlot.searchLanguageFilter
							.filter((l) => /^[a-z]{2}$/i.test(l))
							.map((l) => l.toLowerCase());
					}
					if (isValidIsoDate(cfgSlot.searchAfterDate)) {
						body.search_after_date = cfgSlot.searchAfterDate;
					}
					if (isValidIsoDate(cfgSlot.searchBeforeDate)) {
						body.search_before_date = cfgSlot.searchBeforeDate;
					}
					if (typeof cfgSlot.maxTokens === "number" && cfgSlot.maxTokens > 0) {
						body.max_tokens = cfgSlot.maxTokens | 0;
					}
					if (typeof cfgSlot.maxTokensPerPage === "number" && cfgSlot.maxTokensPerPage > 0) {
						body.max_tokens_per_page = cfgSlot.maxTokensPerPage | 0;
					}

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(PERPLEXITY_ENDPOINT, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${apiKey}`,
								// Telemetry hints — Perplexity uses these to bucket
								// usage for OpenRouter-routed flows + ranking.
								"http-referer": "https://github.com/Bhasvanth-Dev9380/brigade",
								"x-title": "Brigade",
							},
							body: JSON.stringify(body),
							signal: combined,
						});
						const { text: rawBody } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = rawBody.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`perplexity: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(rawBody) as PerplexityResponse;
							} catch {
								throw new Error("perplexity: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.results) ? data.results : [];
						const results = rawHits
							.map((h) => {
								const title = typeof h.title === "string" ? h.title.trim() : "";
								const url = typeof h.url === "string" ? h.url.trim() : "";
								if (!title || !url) return null;
								return wrapSearchHit({
									title,
									url,
									snippet: typeof h.snippet === "string" ? h.snippet.trim() : undefined,
									siteName: resolveSiteName(url),
									published: typeof h.date === "string" ? h.date : undefined,
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "perplexity", results };
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

export const perplexityModule = defineModule({
	id: "perplexity",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createPerplexitySearchProvider());
	},
});

export { createPerplexitySearchProvider };
