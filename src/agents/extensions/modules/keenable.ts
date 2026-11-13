/**
 * Keenable web-search provider — works without an API key.
 *
 * Without a key it calls Keenable's free public endpoint
 * (`POST https://api.keenable.ai/v1/search/public`). When `KEENABLE_API_KEY`
 * (or `tools.web.search.providers.keenable.apiKey`) is set it calls the keyed
 * `/v1/search` endpoint instead, with the key in `X-API-Key`.
 *
 * Sorted after DuckDuckGo so it never changes the default provider; the model
 * or operator picks it via `provider: "keenable"`.
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
	mergeSignals,
	resolveProviderApiKey,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";

const KEENABLE_PUBLIC_URL = "https://api.keenable.ai/v1/search/public";
const KEENABLE_KEYED_URL = "https://api.keenable.ai/v1/search";
const SNIPPET_MAX_CHARS = 1_000;

/** Resolve endpoint + headers. Exported for tests. */
function buildKeenableRequest(apiKey: string | undefined): { url: string; headers: Record<string, string> } {
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
		// Identifies Brigade as the caller in Keenable usage stats.
		"x-keenable-title": "Brigade",
	};
	if (apiKey) {
		headers["x-api-key"] = apiKey;
		return { url: KEENABLE_KEYED_URL, headers };
	}
	return { url: KEENABLE_PUBLIC_URL, headers };
}

/** Prefer the short `description`; fall back to a truncated `snippet`. Exported for tests. */
function pickKeenableSnippet(r: Record<string, unknown>): string | undefined {
	const description = typeof r.description === "string" ? r.description.trim() : "";
	if (description) return description;
	const snippet = typeof r.snippet === "string" ? r.snippet.trim() : "";
	if (!snippet) return undefined;
	return snippet.length > SNIPPET_MAX_CHARS ? `${snippet.slice(0, SNIPPET_MAX_CHARS)}…` : snippet;
}

function createKeenableSearchProvider(): WebSearchProvider {
	return {
		id: "keenable",
		label: "Keenable",
		hint: "Search API for AI agents — free public endpoint, optional KEENABLE_API_KEY.",
		requiresCredential: false,
		envVars: [],
		signupUrl: "https://keenable.ai/",
		docsUrl: "https://keenable.ai/",
		// Below DuckDuckGo (100) so the default provider is unchanged.
		autoDetectOrder: 120,
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const apiKey = resolveProviderApiKey({
				cfg: ctx.config,
				env: ctx.env,
				providerId: "keenable",
				kind: "search",
				envVars: ["KEENABLE_API_KEY"],
			});
			const { url, headers } = buildKeenableRequest(apiKey);
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Keenable web search — ranked URL hits with short descriptions.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 20 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("keenable: missing query");
					const count = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						20,
					);
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					try {
						const response = await fetch(url, {
							method: "POST",
							headers,
							body: JSON.stringify({ query, max_results: count }),
							signal: mergeSignals([signal, controller.signal]),
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`keenable: HTTP ${response.status} — ${safe}`);
						}
						let data: { results?: unknown };
						try {
							data = JSON.parse(body) as { results?: unknown };
						} catch {
							throw new Error("keenable: invalid JSON from upstream");
						}
						const rawHits = Array.isArray(data.results) ? data.results : [];
						const results = rawHits
							.map((rh) => {
								if (!rh || typeof rh !== "object") return null;
								const r = rh as Record<string, unknown>;
								const hitUrl = typeof r.url === "string" ? r.url.trim() : "";
								if (!hitUrl) return null;
								const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : hitUrl;
								return wrapSearchHit({
									title,
									url: hitUrl,
									snippet: pickKeenableSnippet(r),
									siteName: resolveSiteName(hitUrl),
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "keenable", query, count: results.length, results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

/** Brigade module — registers the Keenable provider via `b.webSearch`. */
export const keenableModule = defineModule({
	id: "keenable",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createKeenableSearchProvider());
	},
});

export { buildKeenableRequest, createKeenableSearchProvider, pickKeenableSnippet };
