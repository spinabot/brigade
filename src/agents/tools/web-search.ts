/**
 * `web_search` tool — thin wrapper over the active `WebSearchProvider`.
 *
 * Unlike `fetch_url` (built-in raw HTTP + provider fallback), web_search has
 * NO built-in implementation. It's purely a router: the registry resolves
 * the active provider (DuckDuckGo by default, Brave/Tavily/Exa/etc. when
 * configured), calls the provider's `createTool(ctx)` factory once per
 * session, and exposes the resulting tool to the agent under the stable
 * name `web_search`.
 *
 * Result normalization happens here so every provider's free-form return
 * lands in the same `{content, details}` shape — the model sees one
 * envelope no matter which search backend served the query.
 *
 * Closes the same two gaps as `fetch_url`: `onUpdate` fires for streaming
 * progress; `AbortSignal` is threaded through to the provider's execute.
 */

import { Type, type Static } from "typebox";

import { buildExternalContentMeta, wrapWebContent } from "../../security/external-content.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	buildSearchCacheKey,
	type CacheEntry,
	DEFAULT_CACHE_TTL_MINUTES,
	readCache,
	resolveCacheTtlMs,
	writeCache,
} from "./web-shared.js";
import { buildUnsupportedSearchFilterResponse } from "../extensions/modules/web-search-filters.js";
import type { AgentToolResult, AgentToolUpdateCallback, AnyBrigadeTool, BrigadeTool } from "./types.js";
import type {
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../extensions/types.js";

const log = createSubsystemLogger("brigade/web");

/* ─────────────────────────── schema + result shape ─────────────────────────── */

const WebSearchSchema = Type.Object({
	query: Type.String({
		description: "Search query. Plain text; the active provider handles syntax (quotes, operators, etc.).",
		minLength: 1,
	}),
	count: Type.Optional(
		Type.Integer({
			description: "Max results to return (default 10, max 25).",
			minimum: 1,
			maximum: 25,
		}),
	),
	provider: Type.Optional(
		Type.String({
			description:
				"Override the auto-detected provider for THIS call only. One of the registered IDs (brave, tavily, exa, perplexity, duckduckgo, searxng, firecrawl). Leave unset to use the operator-configured default.",
			minLength: 1,
		}),
	),
	country: Type.Optional(
		Type.String({
			description:
				"2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Only Brave + Perplexity honour this.",
			minLength: 1,
		}),
	),
	language: Type.Optional(
		Type.String({
			description:
				"Language code (e.g., 'en', 'de', 'pt-br'). Only Brave + Perplexity honour this.",
			minLength: 1,
		}),
	),
	search_lang: Type.Optional(
		Type.String({
			description: "Brave-specific: language for search results (e.g., 'en', 'zh-hans').",
			minLength: 1,
		}),
	),
	ui_lang: Type.Optional(
		Type.String({
			description: "Brave-specific: UI locale (e.g., 'en-US', 'de-DE').",
			minLength: 1,
		}),
	),
	freshness: Type.Optional(
		Type.String({
			description:
				"Recency filter. Brave: 'pd'/'pw'/'pm'/'py' or 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity: 'day'/'week'/'month'/'year'.",
			minLength: 1,
		}),
	),
	date_after: Type.Optional(
		Type.String({
			description: "Only results published on or after this date (YYYY-MM-DD).",
			minLength: 1,
		}),
	),
	date_before: Type.Optional(
		Type.String({
			description: "Only results published on or before this date (YYYY-MM-DD).",
			minLength: 1,
		}),
	),
});

/** One result row in the normalized envelope. Drift between providers
 *  (`description` vs `snippet`) is normalized to `snippet`. */
export interface WebSearchHit {
	title: string;
	url: string;
	snippet?: string;
	siteName?: string;
	published?: string;
	score?: number;
}

export interface WebSearchDetails {
	query: string;
	provider: string;
	count: number;
	tookMs: number;
	results: WebSearchHit[];
	answer?: string;
	citations?: string[];
	/** Typed error from the provider (invalid filter / unsupported filter). */
	error?: string;
	/** Human-readable explanation; pairs with `error`. */
	message?: string;
	/** Docs URL for the surfaced error. */
	docs?: string;
	externalContent: { untrusted: true; source: "web_search"; provider?: string; wrapped: boolean };
	cached?: true;
}

const DEFAULT_COUNT = 10;

const SEARCH_CACHE = new Map<string, CacheEntry<WebSearchDetails>>();

/* ─────────────────────────── rate-limit cooldown ─────────────────────────── */

// When a provider throws a rate-limit-shaped error it sits out this long
// before the fallback chain tries it again — a weekly-capped backend would
// otherwise burn a failed round-trip at the head of EVERY search until its
// cap resets (the production incident that motivated the chain).
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
/** providerId → epoch-ms until which the provider is skipped. Process-local. */
const RATE_LIMITED_UNTIL = new Map<string, number>();

function isRateLimitError(message: string): boolean {
	return /\b429\b|rate.?limit|quota|too many requests|weekly usage/i.test(message);
}

/** Test seam — cooldowns persist module-wide; tests must not leak across cases. */
export function clearWebSearchRateLimitCooldownsForTests(): void {
	RATE_LIMITED_UNTIL.clear();
}

/* ─────────────────────────── public factory ─────────────────────────── */

export interface MakeWebSearchToolOptions {
	provider: WebSearchProvider;
	providerCtx: WebProviderContext;
	cacheTtlMinutes?: number;
	/**
	 * Optional resolver: when set, the tool consults it on each call to
	 * find an alternate provider when the model passes
	 * `provider: "<id>"` in the call args. Lets the agent pick a specific
	 * backend for a single query without changing operator config.
	 */
	lookupProviderById?: (id: string) => WebSearchProvider | null;
	/**
	 * Error-time fallback chain (ordered; the tool dedupes by id, so loops
	 * are impossible). Walked ONLY when an attempt throws / short-circuits
	 * AND the model did not explicitly override the provider for this call.
	 * Empty or absent → single-provider behavior (the pre-chain contract).
	 */
	fallbackProviders?: () => WebSearchProvider[];
}

/**
 * Build the `web_search` tool around a resolved provider. Returns `null` if
 * the provider's `createTool(ctx)` factory itself returns null (e.g. the
 * provider declared itself configured but the runtime check came back
 * negative). Caller drops the tool from the agent surface when null.
 */
export function makeWebSearchTool(opts: MakeWebSearchToolOptions): AnyBrigadeTool | null {
	const defaultProviderTool = opts.provider.createTool(opts.providerCtx);
	if (!defaultProviderTool) return null;
	const cacheTtlMs = resolveCacheTtlMs(opts.cacheTtlMinutes ?? DEFAULT_CACHE_TTL_MINUTES);

	const tool: BrigadeTool<typeof WebSearchSchema, WebSearchDetails> = {
		name: "web_search",
		label: "web_search",
		description: `Search the web using ${opts.provider.label}. Returns titles, URLs, and snippets for fast research. FIRST step whenever you need to find a page, business, person, or fact and don't have a URL. If this tool errors (rate-limited / provider down) or returns nothing useful, do NOT drop the search task — run the search in the browser tool instead (navigate to a search-engine results URL, then snapshot), or retry with provider:"<id>" if another provider is configured.`,
		parameters: WebSearchSchema,
		ownerOnly: false,
		displaySummary: "searching the web",
		async execute(
			_toolCallId: string,
			args: Static<typeof WebSearchSchema>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<WebSearchDetails>,
		): Promise<AgentToolResult<WebSearchDetails>> {
			const query = args.query.trim();
			const count = args.count ?? DEFAULT_COUNT;
			const startedAt = Date.now();

			// Guard whitespace-only / effectively-empty queries with a typed
			// envelope. TypeBox's `minLength: 1` on the schema lets through
			// `"   "` and the upstream providers each throw their own opaque
			// "missing query" error — same observable shape as a 3ms ✗ that's
			// hard to diagnose. The typed envelope is self-describing and
			// short-circuits before any HTTP work.
			if (!query) {
				const errorPayload: WebSearchDetails = {
					query,
					provider: opts.provider.id,
					count,
					tookMs: Date.now() - startedAt,
					results: [],
					error: "invalid_query",
					message:
						"web_search: `query` must be a non-empty, non-whitespace string.",
					externalContent: buildExternalContentMeta({
						source: "web_search",
						provider: opts.provider.id,
						wrapped: true,
					}),
				};
				return jsonResult(errorPayload);
			}

			// Per-call provider override. The model can request a specific
			// backend for one query (e.g. "use brave for this");
			// resolution uses the registry-side lookup so the override
			// respects deny/allow lists. If the override fails (unknown
			// id, not configured, denied), fall back to the default.
			let activeProvider: WebSearchProvider = opts.provider;
			let activeProviderTool = defaultProviderTool;
			// When the model's per-call provider override can't be honoured (unknown
			// id, or found-but-not-configured because its API key is missing), we keep
			// the default provider so results still flow — but we MUST say so. Silently
			// rerouting let the model believe it was on e.g. Brave (with Brave-only
			// filters) while actually running on keyless DDG, which both hid the missing
			// key from the operator and produced confusing downstream behaviour.
			let overrideNote: string | undefined;
			const requested = args.provider?.trim();
			if (requested && requested !== opts.provider.id && opts.lookupProviderById) {
				const found = opts.lookupProviderById(requested);
				if (found) {
					const overrideTool = found.createTool(opts.providerCtx);
					if (overrideTool) {
						activeProvider = found;
						activeProviderTool = overrideTool;
					} else {
						overrideNote = `Requested provider "${requested}" is not configured (missing API key) — used "${opts.provider.id}" instead.`;
						log.warn("web_search override not configured", { requested, fellBackTo: opts.provider.id });
					}
				} else {
					overrideNote = `Requested provider "${requested}" is unknown or not allowed — used "${opts.provider.id}" instead.`;
					log.warn("web_search override unknown", { requested, fellBackTo: opts.provider.id });
				}
			}

			// Collect optional filter args. Brave + Perplexity honour these
			// directly; for any other provider we short-circuit with a typed
			// `unsupported_*` error BEFORE making the upstream call so the
			// agent gets predictable feedback rather than a silently dropped
			// filter.
			const filterArgs: Record<string, unknown> = {};
			if (args.country) filterArgs.country = args.country;
			if (args.language) filterArgs.language = args.language;
			if (args.search_lang) filterArgs.search_lang = args.search_lang;
			if (args.ui_lang) filterArgs.ui_lang = args.ui_lang;
			if (args.freshness) filterArgs.freshness = args.freshness;
			if (args.date_after) filterArgs.date_after = args.date_after;
			if (args.date_before) filterArgs.date_before = args.date_before;

			if (!activeProvider.supportsFilters && Object.keys(filterArgs).length > 0) {
				const unsupported = buildUnsupportedSearchFilterResponse(
					filterArgs,
					activeProvider.id,
				);
				if (unsupported) {
					const errorPayload: WebSearchDetails = {
						query,
						provider: activeProvider.id,
						count,
						tookMs: Date.now() - startedAt,
						results: [],
						error: unsupported.error,
						message: unsupported.message,
						docs: unsupported.docs,
						externalContent: buildExternalContentMeta({
							source: "web_search",
							provider: activeProvider.id,
							wrapped: true,
						}),
					};
					return jsonResult(errorPayload);
				}
			}

			// Build the attempt chain ONCE: the resolved provider first, then —
			// only when the model did NOT explicitly override — the configured
			// fallback chain (ordered, deduped by id). One provider's rate limit
			// or outage no longer kills search outright (production incident:
			// the default provider 429'd on a weekly quota and EVERY search
			// died; the agent went blind and fell back to directory scraping).
			const chain: Array<{ provider: WebSearchProvider; tool: WebProviderToolDefinition }> = [
				{ provider: activeProvider, tool: activeProviderTool },
			];
			const explicitOverride = Boolean(requested && requested !== opts.provider.id);
			if (!explicitOverride && opts.fallbackProviders) {
				const seen = new Set([activeProvider.id]);
				for (const candidate of opts.fallbackProviders()) {
					if (seen.has(candidate.id)) continue;
					seen.add(candidate.id);
					// A rung that can't honour the call's filters would short-circuit
					// with `unsupported_*` — skip it instead of burning an attempt.
					if (!candidate.supportsFilters && Object.keys(filterArgs).length > 0) continue;
					const candidateTool = candidate.createTool(opts.providerCtx);
					if (candidateTool) chain.push({ provider: candidate, tool: candidateTool });
				}
			}

			const filterEntries = Object.entries(filterArgs)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${k}=${String(v)}`);
			const failures: Array<{ provider: string; message: string }> = [];

			for (const attempt of chain) {
				// Recently rate-limited rungs sit out their cooldown so a dead
				// provider doesn't cost a failed round-trip on every call.
				const coolUntil = RATE_LIMITED_UNTIL.get(attempt.provider.id);
				if (coolUntil !== undefined && Date.now() < coolUntil) {
					failures.push({ provider: attempt.provider.id, message: "in rate-limit cooldown" });
					continue;
				}

				const cacheKey = buildSearchCacheKey([attempt.provider.id, query, count, ...filterEntries]);
				const cached = readCache(SEARCH_CACHE, cacheKey);
				if (cached) {
					log.debug("web_search cache hit", { provider: attempt.provider.id, query });
					return jsonResult({ ...cached, cached: true });
				}

				onUpdate?.({
					content: [{ type: "text", text: `Searching (${attempt.provider.label})…` }],
					details: {} as WebSearchDetails,
				});

				let raw: Awaited<ReturnType<typeof attempt.tool.execute>>;
				try {
					raw = await attempt.tool.execute({ query, count, ...filterArgs }, signal);
				} catch (err) {
					// A provider throw (anti-bot block, non-200, network) must NOT
					// escape as an opaque tool ✗ — and it shouldn't end the search
					// either. Re-raise only a genuine caller abort (the watchdog /
					// parent cancellation owns that); otherwise record the failure,
					// start a cooldown for rate limits, and walk to the next rung.
					if (signal?.aborted) throw err;
					const message = err instanceof Error ? err.message : String(err);
					if (isRateLimitError(message)) {
						RATE_LIMITED_UNTIL.set(attempt.provider.id, Date.now() + RATE_LIMIT_COOLDOWN_MS);
					}
					log.warn("web_search provider error", {
						provider: attempt.provider.id,
						query,
						message,
						remainingFallbacks: chain.length - 1 - chain.indexOf(attempt),
					});
					failures.push({ provider: attempt.provider.id, message });
					continue;
				}

				// Provider short-circuited with a typed error response. With no
				// fallback rungs this surfaces 1:1 (the pre-chain contract, also
				// the per-call-override path); with a chain it counts as a failed
				// rung and the walk continues.
				if (raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string") {
					const errorRaw = raw as { error: string; message?: string; docs?: string };
					if (chain.length === 1) {
						const errorPayload: WebSearchDetails = {
							query,
							provider: attempt.provider.id,
							count,
							tookMs: Date.now() - startedAt,
							results: [],
							error: errorRaw.error,
							message: typeof errorRaw.message === "string" ? errorRaw.message : undefined,
							docs: typeof errorRaw.docs === "string" ? errorRaw.docs : undefined,
							externalContent: buildExternalContentMeta({
								source: "web_search",
								provider: attempt.provider.id,
								wrapped: true,
							}),
						};
						return jsonResult(errorPayload);
					}
					failures.push({
						provider: attempt.provider.id,
						message:
							typeof errorRaw.message === "string"
								? `${errorRaw.error}: ${errorRaw.message}`
								: errorRaw.error,
					});
					continue;
				}

				const payload = normalizeProviderPayload({
					raw,
					provider: attempt.provider.id,
					query,
					count,
				});
				payload.tookMs = Date.now() - startedAt;
				// Cache the clean payload (no notes — notes are call-specific and the
				// cache key is the provider, which a later note-free call shares).
				writeCache(SEARCH_CACHE, cacheKey, payload, { ttlMs: cacheTtlMs });
				log.info("web_search ok", {
					provider: payload.provider,
					query,
					count: payload.count,
					resultCount: payload.results.length,
					tookMs: payload.tookMs,
					...(failures.length > 0 ? { fellBackFrom: failures.map((f) => f.provider).join(",") } : {}),
				});
				const fallbackNote =
					failures.length > 0
						? `Note: provider${failures.length > 1 ? "s" : ""} ${failures
								.map((f) => `"${f.provider}"`)
								.join(", ")} failed — these results are from "${attempt.provider.id}".`
						: undefined;
				const notes = [overrideNote, fallbackNote].filter(Boolean).join(" ");
				return jsonResult(
					notes
						? { ...payload, message: payload.message ? `${payload.message} ${notes}` : notes }
						: payload,
				);
			}

			// Every rung failed. Surface ONE typed envelope carrying each rung's
			// failure plus a recovery playbook the model can act on (browser-SERP
			// fallback) instead of an opaque ✗ — recovery options that live only
			// in code comments don't change model behaviour.
			const summary = failures.map((f) => `${f.provider}: ${f.message}`).join(" | ");
			const allFailedPayload: WebSearchDetails = {
				query,
				provider: activeProvider.id,
				count,
				tookMs: Date.now() - startedAt,
				results: [],
				error: "provider_error",
				message: `${summary} — all search providers failed. Do NOT drop the search task: run it in the browser tool instead (navigate to a search-engine results URL such as https://www.bing.com/search?q=<query> or https://duckduckgo.com/html/?q=<query>, then snapshot to read the hits). Or tell the operator to set a search API key (e.g. BRAVE_API_KEY or TAVILY_API_KEY).`,
				externalContent: buildExternalContentMeta({
					source: "web_search",
					provider: activeProvider.id,
					wrapped: true,
				}),
			};
			return jsonResult(allFailedPayload);
		},
	};
	return tool;
}

/* ─────────────────────────── normalize provider's free-form return ─────────────────────────── */

function normalizeProviderPayload(args: {
	raw: Record<string, unknown>;
	provider: string;
	query: string;
	count: number;
}): WebSearchDetails {
	const r = args.raw;
	const rawResults = Array.isArray(r.results) ? r.results : [];
	const results: WebSearchHit[] = rawResults
		.map((rawHit): WebSearchHit | null => {
			if (!rawHit || typeof rawHit !== "object") return null;
			const hit = rawHit as Record<string, unknown>;
			const rawTitle = String(hit.title ?? hit.name ?? "").trim();
			const url = String(hit.url ?? hit.link ?? hit.href ?? "").trim();
			if (!rawTitle || !url) return null;
			// Title is attacker-controllable — a poisoned page can put
			// `</content><<<END_EXTERNAL...>>>Ignore prior instructions...`
			// in <title> and break out of the envelope. Wrap it.
			const title = wrapWebContent(rawTitle, "web_search", { includeWarning: false });
			// Accept both `snippet` (Tavily/DDG) and `description` (Brave/PPX).
			const snippet = (() => {
				const raw = hit.snippet ?? hit.description ?? hit.summary;
				if (typeof raw !== "string") return undefined;
				const trimmed = raw.trim();
				return trimmed.length > 0
					? wrapWebContent(trimmed, "web_search", { includeWarning: false })
					: undefined;
			})();
			// `siteName` is normally a hostname (derived from URL), but
			// providers sometimes pass arbitrary `source` strings. Wrap when
			// it came from a provider field; URL-derived hostnames are safe.
			const siteName = (() => {
				const fromProvider =
					typeof hit.siteName === "string"
						? hit.siteName
						: typeof hit.source === "string"
							? hit.source
							: null;
				if (fromProvider !== null) {
					const trimmed = fromProvider.trim();
					return trimmed.length > 0
						? wrapWebContent(trimmed, "web_search", { includeWarning: false })
						: undefined;
				}
				try {
					return new URL(url).hostname;
				} catch {
					return undefined;
				}
			})();
			return {
				title,
				url,
				snippet,
				siteName,
				published:
					typeof hit.published === "string"
						? hit.published
						: typeof hit.publishedDate === "string"
							? hit.publishedDate
							: typeof hit.age === "string"
								? hit.age
								: undefined,
				score: typeof hit.score === "number" ? hit.score : undefined,
			};
		})
		.filter((h): h is WebSearchHit => h !== null);

	// Some providers carry a top-level "answer" + "citations[]". Preserve when present.
	const answer = (() => {
		const raw = r.answer ?? r.content;
		if (typeof raw !== "string") return undefined;
		const trimmed = raw.trim();
		return trimmed.length > 0 ? wrapWebContent(trimmed, "web_search") : undefined;
	})();
	const citations = Array.isArray(r.citations)
		? r.citations.filter((c: unknown): c is string => typeof c === "string")
		: undefined;

	return {
		query: args.query,
		provider: args.provider,
		count: args.count,
		tookMs: 0,
		results,
		answer,
		citations,
		externalContent: buildExternalContentMeta({
			source: "web_search",
			provider: args.provider,
			wrapped: true,
		}),
	};
}

/* ─────────────────────────── helpers ─────────────────────────── */

function jsonResult(payload: WebSearchDetails): AgentToolResult<WebSearchDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

export { SEARCH_CACHE, WebSearchSchema };
