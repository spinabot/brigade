/**
 * Brave Search web-search provider — bundled, API-key-gated.
 *
 * Brave is the most reliable non-DDG fallback when the operator has an API
 * key. Endpoint: `https://api.search.brave.com/res/v1/web/search`. Auth via
 * `X-Subscription-Token`.
 *
 * Brigade exposes only Brave's `web` mode for v1 (their `llm/context`
 * pre-extracted mode is a future bolt-on once the operator surface for
 * mode-switching exists). Web mode returns the usual title/url/description
 * triple plus optional `age`.
 *
 * Operator config (`brigade.json` →) `tools.web.search.providers.brave`:
 *   { apiKey?, country?, search_lang?, ui_lang?, freshness?, dateAfter?, dateBefore? }
 *
 * Run-time arguments forwarded from the agent's `web_search` call: `query`
 * + `count` (1-25). Operator-configured `country` / `freshness` etc. ride
 * on every call.
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
	makeProviderCacheKey,
	normalizeFreshnessPreset,
	readProviderConfigSlot,
	resolveProviderApiKey,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchConfig {
	apiKey?: string;
	country?: string;
	search_lang?: string;
	ui_lang?: string;
	freshness?: string;
	dateAfter?: string;
	dateBefore?: string;
}

/**
 * Brave's documented country codes. Anything else is silently dropped so
 * we don't pass an invalid code that would 400 the request.
 */
const BRAVE_COUNTRY_CODES = new Set([
	"AR","AU","AT","BE","BR","CA","CL","DK","FI","FR","DE","HK","IN","ID","IT","JP","KR","MY",
	"MX","NL","NZ","NO","CN","PL","PT","PH","RU","SA","ZA","ES","SE","CH","TW","TR","GB","US",
	"ALL",
]);

const BRAVE_SEARCH_LANG_CODES = new Set([
	"ar","bg","cs","da","de","el","en","en-gb","es","et","fi","fr","he","hi","hr","hu","id",
	"it","ja","ko","lt","lv","nb","nl","pl","pt-br","pt-pt","ro","ru","sk","sl","sr","sv","th",
	"tr","uk","vi","zh-hans","zh-hant",
]);

const UI_LANG_REGEX = /^[a-z]{2}-[a-z]{2}$/i;

function normalizeBraveCountry(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const upper = raw.trim().toUpperCase();
	return BRAVE_COUNTRY_CODES.has(upper) ? upper : undefined;
}

function normalizeBraveSearchLang(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const lower = raw.trim().toLowerCase();
	if (BRAVE_SEARCH_LANG_CODES.has(lower)) return lower;
	// Common aliases.
	if (lower === "ja" || lower === "jp") return "ja";
	if (lower === "zh") return "zh-hans";
	return undefined;
}

function normalizeBraveUiLang(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const v = raw.trim();
	return UI_LANG_REGEX.test(v) ? v : undefined;
}

function isValidIsoDate(raw: string | undefined): boolean {
	if (!raw) return false;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
	return Number.isFinite(Date.parse(`${raw}T00:00:00Z`));
}

interface BraveSearchHit {
	title?: string;
	url?: string;
	description?: string;
	age?: string;
}

interface BraveSearchResponse {
	web?: { results?: BraveSearchHit[] };
}

function createBraveSearchProvider(): WebSearchProvider {
	return {
		id: "brave",
		label: "Brave Search",
		hint: "Brave's web-search API. Structured JSON, no HTML scraping.",
		requiresCredential: true,
		envVars: ["BRAVE_API_KEY"],
		signupUrl: "https://brave.com/search/api/",
		docsUrl: "https://api-dashboard.search.brave.com/app/documentation",
		placeholder: "BSA…",
		// Beats Firecrawl-search (50) when the operator has both — structured
		// JSON over a search endpoint is preferred over a fallback-routing
		// provider. Still loses to operator-pinned providers.
		autoDetectOrder: 30,
		isConfigured(cfg, env) {
			return (
				resolveProviderApiKey({
					cfg,
					env,
					providerId: "brave",
					kind: "search",
					envVars: ["BRAVE_API_KEY"],
				}) !== undefined
			);
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveProviderApiKey({
				cfg: ctx.config,
				env: ctx.env,
				providerId: "brave",
				kind: "search",
				envVars: ["BRAVE_API_KEY"],
			});
			if (!apiKey) return null;
			const cfgSlot = readProviderConfigSlot<BraveSearchConfig>({
				cfg: ctx.config,
				providerId: "brave",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Brave Search — structured JSON results with title, URL, and snippet.",
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
					if (!query) throw new Error("brave: missing query");
					const count = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);

					const url = new URL(BRAVE_SEARCH_ENDPOINT);
					url.searchParams.set("q", query);
					url.searchParams.set("count", String(count));
					// Validate locale/country codes against Brave's documented
					// set before forwarding. Invalid values are dropped silently
					// so the request still goes through with safe defaults.
					const country = normalizeBraveCountry(cfgSlot.country);
					const searchLang = normalizeBraveSearchLang(cfgSlot.search_lang);
					const uiLang = normalizeBraveUiLang(cfgSlot.ui_lang);
					if (country) url.searchParams.set("country", country);
					if (searchLang) url.searchParams.set("search_lang", searchLang);
					if (uiLang) url.searchParams.set("ui_lang", uiLang);
					const freshness = normalizeFreshnessPreset(cfgSlot.freshness);
					if (freshness) {
						url.searchParams.set("freshness", freshness);
					} else {
						// Validate dates against YYYY-MM-DD format + parseable.
						const after = isValidIsoDate(cfgSlot.dateAfter) ? cfgSlot.dateAfter : undefined;
						const before = isValidIsoDate(cfgSlot.dateBefore) ? cfgSlot.dateBefore : undefined;
						if (after && before) {
							url.searchParams.set("freshness", `${after}to${before}`);
						} else if (after) {
							const today = new Date().toISOString().slice(0, 10);
							url.searchParams.set("freshness", `${after}to${today}`);
						} else if (before) {
							url.searchParams.set("freshness", `1970-01-01to${before}`);
						}
					}

					// Use a manual fetch with cache-key + timeout. SSRF guard not
					// applied here — Brave's endpoint is a fixed public host.
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers: {
								accept: "application/json",
								"x-subscription-token": apiKey,
							},
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`brave: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(body) as BraveSearchResponse;
							} catch {
								throw new Error("brave: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.web?.results) ? data.web!.results : [];
						const results = rawHits
							.map((hit) => {
								const title = (hit.title ?? "").trim();
								const u = (hit.url ?? "").trim();
								if (!title || !u) return null;
								return wrapSearchHit({
									title,
									url: u,
									snippet: (hit.description ?? "").trim() || undefined,
									siteName: resolveSiteName(u),
									published: hit.age,
								});
							})
							.filter((h): h is NonNullable<typeof h> => h !== null);
						return {
							provider: "brave",
							results,
							_cacheKey: makeProviderCacheKey([
								"brave",
								query,
								count,
								country,
								searchLang,
								uiLang,
								freshness,
								cfgSlot.dateAfter,
								cfgSlot.dateBefore,
							]),
						};
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

export const braveModule = defineModule({
	id: "brave",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createBraveSearchProvider());
	},
});

export { createBraveSearchProvider };
