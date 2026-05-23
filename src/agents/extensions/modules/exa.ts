/**
 * Exa AI web-search provider — neural-search backend.
 *
 * Exa offers neural + keyword + auto search modes plus per-result content
 * extraction (highlights / summary / text). Brigade exposes the search side
 * with text extraction enabled by default; advanced modes (deep-reasoning,
 * highlights config) are operator-tunable via the `tools.web.search.providers.exa`
 * config slot.
 *
 * Endpoint: `https://api.exa.ai/search` (POST). Auth: `x-api-key`.
 *
 * Operator config:
 *   { apiKey?, type?, includeText?, includeSummary?, summaryQuery? }
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

const EXA_ENDPOINT = "https://api.exa.ai/search";

type ExaSearchType = "auto" | "neural" | "fast" | "keyword" | "deep" | "deep-reasoning" | "instant";

interface ExaConfig {
	apiKey?: string;
	type?: ExaSearchType;
	includeText?: boolean;
	includeSummary?: boolean;
	summaryQuery?: string;
	includeHighlights?: boolean;
	highlightsQuery?: string;
	highlightsPerUrl?: number;
	numSentences?: number;
	/** Freshness preset: day / week / month / year. Computed into startPublishedDate. */
	freshness?: "day" | "week" | "month" | "year";
	/** Explicit YYYY-MM-DD lower bound on publishedDate. Overrides freshness. */
	dateAfter?: string;
	/** Explicit YYYY-MM-DD upper bound on publishedDate. */
	dateBefore?: string;
}

/**
 * Compute the start-published-date for Exa's API from a freshness preset.
 * Returns YYYY-MM-DD or undefined when no/invalid preset.
 */
function resolveFreshnessStart(preset: ExaConfig["freshness"]): string | undefined {
	if (!preset) return undefined;
	const now = new Date();
	switch (preset) {
		case "day": now.setUTCDate(now.getUTCDate() - 1); break;
		case "week": now.setUTCDate(now.getUTCDate() - 7); break;
		case "month": now.setUTCMonth(now.getUTCMonth() - 1); break;
		case "year": now.setUTCFullYear(now.getUTCFullYear() - 1); break;
	}
	return now.toISOString().slice(0, 10);
}

function isValidIsoDate(raw: string | undefined): boolean {
	if (!raw) return false;
	return /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`));
}

interface ExaHit {
	title?: unknown;
	url?: unknown;
	publishedDate?: unknown;
	text?: unknown;
	summary?: unknown;
	highlights?: unknown;
}

interface ExaResponse {
	results?: ExaHit[];
}

function createExaSearchProvider(): WebSearchProvider {
	return {
		id: "exa",
		label: "Exa",
		hint: "Neural search — embedding-based ranking with content extraction.",
		requiresCredential: true,
		envVars: ["EXA_API_KEY"],
		signupUrl: "https://exa.ai/",
		docsUrl: "https://docs.exa.ai/reference/search",
		placeholder: "exa-…",
		autoDetectOrder: 40,
		isConfigured(cfg, env) {
			return (
				resolveProviderApiKey({
					cfg,
					env,
					providerId: "exa",
					kind: "search",
					envVars: ["EXA_API_KEY"],
				}) !== undefined
			);
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveProviderApiKey({
				cfg: ctx.config,
				env: ctx.env,
				providerId: "exa",
				kind: "search",
				envVars: ["EXA_API_KEY"],
			});
			if (!apiKey) return null;
			const cfgSlot = readProviderConfigSlot<ExaConfig>({
				cfg: ctx.config,
				providerId: "exa",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Exa neural search — embedding-based discovery with optional content extraction.",
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
					if (!query) throw new Error("exa: missing query");
					const numResults = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);
					const contents: Record<string, unknown> = {};
					if (cfgSlot.includeText !== false) contents.text = { maxCharacters: 2_000 };
					if (cfgSlot.includeSummary) {
						contents.summary = cfgSlot.summaryQuery ? { query: cfgSlot.summaryQuery } : true;
					}
					if (cfgSlot.includeHighlights) {
						const hl: Record<string, unknown> = {};
						if (cfgSlot.highlightsQuery) hl.query = cfgSlot.highlightsQuery;
						if (typeof cfgSlot.highlightsPerUrl === "number") hl.highlightsPerUrl = cfgSlot.highlightsPerUrl;
						if (typeof cfgSlot.numSentences === "number") hl.numSentences = cfgSlot.numSentences;
						contents.highlights = Object.keys(hl).length > 0 ? hl : true;
					}
					const body: Record<string, unknown> = {
						query,
						numResults,
						type: cfgSlot.type ?? "auto",
					};
					if (Object.keys(contents).length > 0) body.contents = contents;
					// Date filtering — explicit YYYY-MM-DD beats freshness preset.
					if (isValidIsoDate(cfgSlot.dateAfter)) {
						body.startPublishedDate = cfgSlot.dateAfter;
					} else {
						const fromPreset = resolveFreshnessStart(cfgSlot.freshness);
						if (fromPreset) body.startPublishedDate = fromPreset;
					}
					if (isValidIsoDate(cfgSlot.dateBefore)) {
						body.endPublishedDate = cfgSlot.dateBefore;
					}

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(EXA_ENDPOINT, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"x-api-key": apiKey,
								"x-exa-integration": "brigade",
							},
							body: JSON.stringify(body),
							signal: combined,
						});
						const { text: rawBody } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = rawBody.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`exa: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(rawBody) as ExaResponse;
							} catch {
								throw new Error("exa: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.results) ? data.results : [];
						const results = rawHits
							.map((h) => {
								const title = typeof h.title === "string" ? h.title.trim() : "";
								const url = typeof h.url === "string" ? h.url.trim() : "";
								if (!title || !url) return null;
								// Prefer summary > first highlight > text snippet.
								const snippet = (() => {
									if (typeof h.summary === "string" && h.summary.trim()) {
										return h.summary.trim();
									}
									if (Array.isArray(h.highlights) && typeof h.highlights[0] === "string") {
										return (h.highlights[0] as string).trim();
									}
									if (typeof h.text === "string" && h.text.trim()) {
										return h.text.trim().slice(0, 500);
									}
									return undefined;
								})();
								return wrapSearchHit({
									title,
									url,
									snippet,
									siteName: resolveSiteName(url),
									published: typeof h.publishedDate === "string" ? h.publishedDate : undefined,
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "exa", results };
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

export const exaModule = defineModule({
	id: "exa",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createExaSearchProvider());
	},
});

export { createExaSearchProvider };
