/**
 * Ollama local web-search provider — keyless when paired with a local
 * Ollama instance running the experimental web-search endpoint.
 *
 * Ollama (the local model runtime) ships an `/api/experimental/web_search`
 * endpoint that proxies the host's own search provider (the Ollama Cloud
 * tier or a self-hosted SearchAPI). For Brigade, this is a clean keyless
 * path: if the operator has `ollama` running locally, web_search is free.
 *
 * Endpoint: `${baseUrl}/api/experimental/web_search` (default base
 * `http://localhost:11434`).
 *
 * Auth: usually none (local sockets). When the operator routes through
 * Ollama Cloud, set `OLLAMA_API_KEY` and we send `Authorization: Bearer`.
 *
 * Operator config (`tools.web.search.providers.ollama`):
 *   { baseUrl?, apiKey?, snippetMaxChars? }
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
	mergeSignals,
} from "./web-provider-helpers.js";

const OLLAMA_DEFAULT_BASE = "http://localhost:11434";
const OLLAMA_SEARCH_PATH = "/api/experimental/web_search";
const DEFAULT_SNIPPET_MAX = 300;

interface OllamaConfig {
	baseUrl?: string;
	apiKey?: string;
	snippetMaxChars?: number;
}

interface OllamaSearchResult {
	title?: string;
	url?: string;
	content?: string;
}

interface OllamaSearchResponse {
	results?: OllamaSearchResult[];
}

function resolveOllamaBaseUrl(cfgSlot: Partial<OllamaConfig>, env?: NodeJS.ProcessEnv): string {
	const cfg = cfgSlot.baseUrl?.trim();
	if (cfg) return cfg.replace(/\/$/, "");
	const e = env?.OLLAMA_HOST?.trim();
	if (e) return e.replace(/\/$/, "");
	return OLLAMA_DEFAULT_BASE;
}

function resolveOllamaApiKey(cfgSlot: Partial<OllamaConfig>, env?: NodeJS.ProcessEnv): string | undefined {
	const cfg = cfgSlot.apiKey?.trim();
	const e = env?.OLLAMA_API_KEY?.trim();
	const raw = cfg || e;
	if (!raw) return undefined;
	const cleaned = sanitizeHeaderToken(raw);
	return cleaned.length > 0 ? cleaned : undefined;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}…`;
}

function createOllamaSearchProvider(): WebSearchProvider {
	return {
		id: "ollama",
		label: "Ollama (local web search)",
		hint: "Use the Ollama runtime's web_search proxy. Free when Ollama runs locally.",
		// Keyless when local; the apiKey path is OPTIONAL for Ollama Cloud users.
		requiresCredential: false,
		envVars: ["OLLAMA_HOST", "OLLAMA_API_KEY"],
		signupUrl: "https://ollama.ai/download",
		docsUrl: "https://docs.ollama.com/cloud",
		placeholder: "http://localhost:11434",
		// Loses to commercial keyed backends but beats DDG when the operator
		// has OPTED IN — typically more reliable than HTML scraping.
		autoDetectOrder: 90,
		// OPT-IN ONLY. This endpoint proxies ollama.com's account-metered cloud
		// search with a hard weekly quota — it must never be the silent default.
		// (Production incident: a fresh-ish install auto-resolved here, burned
		// the weekly quota dry mid-research, and with no fallback chain the
		// agent lost web search entirely.) Configured =
		//   - the operator wrote `tools.web.search.providers.ollama` in config
		//     (even `{}` counts — presence is the opt-in), OR
		//   - OLLAMA_API_KEY is exported (explicit Ollama Cloud setup).
		// OLLAMA_HOST alone is NOT opt-in — that env var configures the chat
		// runtime, and treating it as search opt-in would silently re-default
		// every Ollama chat user onto the metered endpoint.
		isConfigured: (cfg, env) => {
			const slot = (cfg as {
				tools?: { web?: { search?: { providers?: Record<string, unknown> } } };
			}).tools?.web?.search?.providers?.ollama;
			return slot !== undefined || Boolean(env?.OLLAMA_API_KEY?.trim());
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const cfgSlot = readProviderConfigSlot<OllamaConfig>({
				cfg: ctx.config,
				providerId: "ollama",
				kind: "search",
			});
			const baseUrl = resolveOllamaBaseUrl(cfgSlot, ctx.env);
			const apiKey = resolveOllamaApiKey(cfgSlot, ctx.env);
			const snippetMax = typeof cfgSlot.snippetMaxChars === "number" && cfgSlot.snippetMaxChars > 0
				? Math.floor(cfgSlot.snippetMaxChars)
				: DEFAULT_SNIPPET_MAX;
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Ollama runtime's web_search proxy (uses Ollama Cloud or a configured host backend).",
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
					if (!query) throw new Error("ollama: missing query");
					const max_results = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);
					const headers: Record<string, string> = { "content-type": "application/json" };
					if (apiKey) headers.authorization = `Bearer ${apiKey}`;

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(`${baseUrl}${OLLAMA_SEARCH_PATH}`, {
							method: "POST",
							headers,
							body: JSON.stringify({ query, max_results }),
							signal: combined,
						});
						const { text: rawBody } = await readResponseText(response.body, 2_000_000);
						if (response.status === 401) {
							throw new Error(
								"ollama: web_search authentication failed. Run `ollama signin` for Ollama Cloud access, or unset OLLAMA_API_KEY for local use.",
							);
						}
						if (response.status === 403) {
							throw new Error(
								"ollama: web_search not enabled on this host. Enable cloud-backed web search in your Ollama settings.",
							);
						}
						if (response.status !== 200) {
							const safe = rawBody.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`ollama: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(rawBody) as OllamaSearchResponse;
							} catch {
								throw new Error("ollama: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.results) ? data.results : [];
						const results = rawHits
							.slice(0, max_results)
							.map((h) => {
								const title = (h.title ?? "").trim();
								const url = (h.url ?? "").trim();
								if (!title || !url) return null;
								const snippet = (h.content ?? "").trim();
								return wrapSearchHit({
									title,
									url,
									snippet: snippet.length > 0 ? truncate(snippet, snippetMax) : undefined,
									siteName: resolveSiteName(url),
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "ollama", results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

export const ollamaSearchModule = defineModule({
	id: "ollama-search",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createOllamaSearchProvider());
	},
});

export { createOllamaSearchProvider, resolveOllamaBaseUrl, resolveOllamaApiKey };
