/**
 * `fetch_url` tool — built-in HTTP fetcher with structured payload + provider
 * fallback.
 *
 * Two-tier path:
 *
 *   1. **Built-in raw** — guarded `fetch` (SSRF + manual redirect + cap-based
 *      streaming reader) → content-type router → Readability+linkedom (HTML)
 *      / pretty-printed (JSON) / passthrough (text/markdown) → markdown body.
 *
 *   2. **Provider fallback** — when the built-in path errors or returns
 *      non-OK (JS-heavy SPAs, bot-blocked sites), the agent loop delegates
 *      to whichever `WebFetchProvider` the registry resolves (Firecrawl /
 *      Jina-Reader / Browserless). The fallback is opt-in (operator must
 *      have a provider configured); when no provider is registered the
 *      built-in error is what the model sees.
 *
 * Result shape — every fetch ends in the SAME `{content, details}` payload
 * (the normalizer below). The model gets one JSON blob with `text` (wrapped
 * in the untrusted-content envelope), plus metadata (status, contentType,
 * extractor, fetchedAt, tookMs, truncated, cached). Errors throw, matching
 * Pi convention.
 *
 * Closes two gaps in the upstream reference:
 *   - `onUpdate` callbacks fire so a long fetch reports "fetching →
 *     extracting → done" to the channel/TUI.
 *   - `AbortSignal` is threaded into `fetch()` so a mid-turn cancel
 *     actually aborts the in-flight request.
 */

import { Type, type Static } from "typebox";

import { guardedFetch, SsrfBlockedError } from "../../infra/net/fetch-guard.js";
import { buildExternalContentMeta, wrapWebContent } from "../../security/external-content.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	buildFetchCacheKey,
	type CacheEntry,
	clampMaxBytes,
	DEFAULT_CACHE_TTL_MINUTES,
	DEFAULT_MAX_RESPONSE_BYTES,
	DEFAULT_TIMEOUT_SECONDS,
	readCache,
	readResponseText,
	redactUrlForDebugLog,
	resolveCacheTtlMs,
	writeCache,
} from "./web-shared.js";
import {
	composeFetchBody,
	extractBasicHtmlContent,
	extractReadableContent,
	type ExtractedContent,
} from "./web-fetch-utils.js";
import type { AgentToolResult, AgentToolUpdateCallback, AnyBrigadeTool, BrigadeTool } from "./types.js";
import type { WebFetchProvider, WebProviderContext } from "../extensions/types.js";

const log = createSubsystemLogger("brigade/web");

/* ─────────────────────────── tool schema + result shape ─────────────────────────── */

/** TypeBox schema for the `fetch_url` tool's parameters. */
const FetchUrlSchema = Type.Object({
	url: Type.String({
		description:
			"Absolute URL to fetch (http:// or https://). The body is sanitized + extracted to markdown by default.",
	}),
	extractMode: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
			description:
				"Output flavor. `markdown` (default) keeps formatting; `text` strips all markdown for plain text consumption.",
		}),
	),
	maxChars: Type.Optional(
		Type.Integer({
			description:
				"Maximum characters of body to return (default 20000). Excess content is truncated with a marker.",
			minimum: 100,
		}),
	),
});

const DEFAULT_MAX_CHARS = 20_000;

/** Canonical payload returned by every fetch path (raw or provider). */
export interface FetchUrlDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	extractMode: "markdown" | "text";
	extractor: ExtractedContent["extractor"];
	externalContent: { untrusted: true; source: "web_fetch"; provider?: string; wrapped: boolean };
	truncated: boolean;
	length: number;
	rawLength: number;
	fetchedAt: string;
	tookMs: number;
	text: string;
	warning?: string;
	cached?: true;
	/**
	 * Internal hint: the primary raw extractor returned an unusable result
	 * (Readability bailed on JS-heavy page) and the provider is preferred
	 * over the basic-html fallback. Stripped before the payload reaches
	 * the model — never on the wire.
	 */
	_fallbackPreferred?: true;
}

/* ─────────────────────────── cache ─────────────────────────── */

const FETCH_CACHE = new Map<string, CacheEntry<FetchUrlDetails>>();

/* ─────────────────────────── public factory ─────────────────────────── */

export interface MakeFetchUrlToolOptions {
	/** Optional configured `WebFetchProvider` that runs as fallback when built-in fetch fails or 4xx/5xx. */
	provider?: WebFetchProvider | null;
	/** Provider context (cfg + env + workspace) — required when `provider` is set. */
	providerCtx?: WebProviderContext;
	/** Override default timeout (seconds). Defaults to 30. */
	timeoutSeconds?: number;
	/** Override default cache TTL (minutes). Defaults to 15. */
	cacheTtlMinutes?: number;
	/** Override default User-Agent. */
	userAgent?: string;
	/** Override default max response bytes. Clamped to [32 KiB, 10 MiB]. */
	maxResponseBytes?: number;
}

/**
 * Build the `fetch_url` tool. Pass an optional fallback provider — the tool
 * tries the built-in raw HTTP path first, and falls back to the provider's
 * `createTool(ctx).execute({url, ...})` when the raw path errors or returns
 * non-OK. When no provider is set, raw failures propagate to the model.
 */
export function makeFetchUrlTool(opts: MakeFetchUrlToolOptions = {}): AnyBrigadeTool {
	const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
	const cacheTtlMs = resolveCacheTtlMs(opts.cacheTtlMinutes ?? DEFAULT_CACHE_TTL_MINUTES);
	const maxBytes = clampMaxBytes(opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
	const userAgent =
		opts.userAgent?.trim() ||
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Brigade/1.0";

	const tool: BrigadeTool<typeof FetchUrlSchema, FetchUrlDetails> = {
		name: "fetch_url",
		label: "fetch_url",
		description:
			"Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation — best for static/server-rendered pages (articles, docs, READMEs). If the result comes back near-empty or blocked, escalate to the browser tool (navigate + snapshot) instead of switching to a different low-quality source.",
		parameters: FetchUrlSchema,
		ownerOnly: false,
		displaySummary: "fetching URL",
		async execute(
			_toolCallId: string,
			args: Static<typeof FetchUrlSchema>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<FetchUrlDetails>,
		): Promise<AgentToolResult<FetchUrlDetails>> {
			const url = args.url.trim();
			const extractMode: "markdown" | "text" = args.extractMode ?? "markdown";
			const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
			const startedAt = Date.now();

			// Cache hit short-circuits.
			const cacheKey = buildFetchCacheKey({ url, extractMode, maxChars });
			const cached = readCache(FETCH_CACHE, cacheKey);
			if (cached) {
				log.debug("web_fetch cache hit", {
					url: redactUrlForDebugLog(url),
					extractor: cached.extractor,
				});
				return jsonResult({ ...cached, cached: true });
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${redactUrlForDebugLog(url)}…` }],
				details: {} as FetchUrlDetails,
			});

			// Try the built-in raw path first.
			let payload: FetchUrlDetails | null = null;
			let rawError: unknown = null;
			try {
				payload = await fetchRawAndExtract({
					url,
					extractMode,
					maxChars,
					timeoutMs,
					maxBytes,
					userAgent,
					signal,
					onUpdate,
				});
			} catch (err) {
				rawError = err;
			}

			// Provider fallback when raw failed, returned non-OK, returned
			// effectively-empty content (SPAs that 200 with a shell HTML), OR
			// the raw extractor signalled it would do worse than the provider
			// (Readability bailed on JS-heavy markup — basic-html regex would
			// be a poor substitute for a real headless renderer).
			const looksEmpty = payload?.status !== undefined
				&& payload.status < 400
				&& payload.rawLength < 200;
			const readabilityBailed = payload?._fallbackPreferred === true;
			const shouldFallback =
				(!payload || payload.status >= 400 || looksEmpty || readabilityBailed)
				&& opts.provider
				&& opts.providerCtx;
			if (shouldFallback) {
				onUpdate?.({
					content: [{ type: "text", text: `Built-in fetch failed — falling back to ${opts.provider!.id}…` }],
					details: payload ?? ({} as FetchUrlDetails),
				});
				try {
					const fromProvider = await runProviderFetch({
						provider: opts.provider!,
						providerCtx: opts.providerCtx!,
						url,
						extractMode,
						maxChars,
						signal,
					});
					if (fromProvider) payload = fromProvider;
				} catch (provErr) {
					// Provider failure: surface the ORIGINAL error if there is one;
					// otherwise surface the provider error.
					if (!payload) throw rawError ?? provErr;
				}
			}

			if (!payload) {
				// Built-in failed AND no provider available — surface the raw error.
				throw rawError ?? new Error(`fetch_url: no result for ${url}`);
			}

			// Empty-but-200 (or Readability bailed) with nothing better available means
			// the page is almost certainly JS-rendered or bot-walled — justdial-class
			// directory sites are the canonical example: they 200 with a ~14-char shell
			// that strips to nothing. Brigade already ships a real `browser` tool (system
			// Chrome via Playwright) that renders these pages; the model just doesn't know
			// to pivot unless we tell it. Attach an actionable warning + log at warn so the
			// result no longer ships as a silent "ok" carrying an empty body.
			const finalLooksEmpty =
				payload.status !== undefined && payload.status < 400 && payload.rawLength < 200;
			if (finalLooksEmpty || payload._fallbackPreferred === true) {
				const hint = `This page returned little or no extractable text (rawLength=${payload.rawLength}) — it is most likely JavaScript-rendered or bot-walled. Use the "browser" tool (navigate + snapshot) to read the rendered page${opts.provider ? "" : ", or set FIRECRAWL_API_KEY for a server-side render fallback"}. If this URL is an aggregator/directory listing, prefer re-searching for the business's own website or reading its map listing instead of rendering the directory.`;
				payload.warning = payload.warning ? `${payload.warning} ${hint}` : hint;
				log.warn("web_fetch empty/blocked", {
					url: redactUrlForDebugLog(url),
					status: payload.status,
					rawLength: payload.rawLength,
					extractor: payload.extractor,
				});
			}

			payload.tookMs = Date.now() - startedAt;
			writeCache(FETCH_CACHE, cacheKey, payload, { ttlMs: cacheTtlMs });
			log.info("web_fetch ok", {
				url: redactUrlForDebugLog(url),
				finalUrl: redactUrlForDebugLog(payload.finalUrl),
				status: payload.status,
				extractor: payload.extractor,
				rawLength: payload.rawLength,
				length: payload.length,
				truncated: payload.truncated,
				tookMs: payload.tookMs,
			});
			return jsonResult(payload);
		},
	};
	return tool;
}

/* ─────────────────────────── raw fetch + extract ─────────────────────────── */

async function fetchRawAndExtract(args: {
	url: string;
	extractMode: "markdown" | "text";
	maxChars: number;
	timeoutMs: number;
	maxBytes: number;
	userAgent: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<FetchUrlDetails>;
}): Promise<FetchUrlDetails> {
	const { response, finalUrl } = await guardedFetch(args.url, {
		method: "GET",
		headers: {
			"user-agent": args.userAgent,
			accept: "text/markdown, text/html;q=0.9, application/json;q=0.8, */*;q=0.1",
			"accept-language": "en-US,en;q=0.9",
		},
		timeoutMs: args.timeoutMs,
		signal: args.signal,
		// Transient-failure backoff for the built-in fetcher. 3 attempts,
		// 500 ms base. Honors Retry-After when set by the upstream.
		retry: {
			maxAttempts: 3,
			baseDelayMs: 500,
			onRetry: ({ attempt, delayMs, reason }) =>
				log.debug("fetch_url retry", { attempt, delayMs, reason }),
		},
	});

	const status = response.status;
	const contentType = normalizeContentType(response.headers.get("content-type"));

	// Cloudflare's "Markdown for Agents" responds with `text/markdown` plus an
	// `x-markdown-tokens` header carrying the precomputed token count. We log
	// it as a capacity-planning hint — useful when the operator needs to know
	// whether their fetch budget will land before the LLM call.
	const cfTokens = response.headers.get("x-markdown-tokens");
	if (cfTokens) log.debug("cf pre-rendered markdown", { tokens: cfTokens });

	const body = await readResponseText(response.body, args.maxBytes);
	const rawLength = body.text.length;

	args.onUpdate?.({
		content: [{ type: "text", text: `Extracting (${contentType ?? "unknown"})…` }],
		details: {} as FetchUrlDetails,
	});

	let extracted: ExtractedContent;
	// `fallbackPreferred` flags an attempt where the primary extractor returned
	// nothing useful (e.g. Readability bailed on a JS-heavy SPA). The outer
	// fallback gate then prefers the configured provider over basic-html.
	let fallbackPreferred = false;
	if (status >= 400) {
		// Non-OK: still try to extract a useful error body for the model.
		extracted = extractBasicHtmlContent(body.text);
		extracted.extractor = "raw";
	} else if (contentType?.startsWith("text/markdown")) {
		// CF Markdown-for-Agents pre-renders. Tag with `cf-markdown` when the
		// CF header is present so logs/details show provenance.
		extracted = { text: body.text, extractor: cfTokens ? "cf-markdown" : "raw" };
	} else if (contentType?.startsWith("application/json")) {
		extracted = { text: prettyJson(body.text), extractor: "json" };
	} else if (contentType?.startsWith("text/html") || looksLikeHtml(body.text)) {
		const fromReadability = await extractReadableContent(body.text, finalUrl).catch(() => null);
		if (fromReadability) {
			extracted = fromReadability;
		} else {
			// Readability bailed — fall through to basic-html but signal the
			// outer gate that the provider would do better than regex here.
			extracted = extractBasicHtmlContent(body.text);
			fallbackPreferred = true;
		}
	} else {
		// Plain text / unknown — passthrough.
		extracted = { text: body.text, extractor: "raw" };
	}

	const composed = composeFetchBody(extracted, {
		extractMode: args.extractMode,
		maxChars: args.maxChars,
	});
	const wrapped = wrapWebContent(composed.text, "web_fetch");

	const truncated = body.truncated || composed.truncated;
	const warning = body.truncated
		? `Response body truncated at ${args.maxBytes} bytes.`
		: composed.truncated
			? `Output truncated at ${args.maxChars} characters.`
			: undefined;

	// Title is attacker-controllable. Wrap it so an injection-laced
	// `<title>` tag can't pose as a top-level instruction.
	const wrappedTitle = extracted.title
		? wrapWebContent(extracted.title, "web_fetch", { includeWarning: false })
		: undefined;
	return {
		url: args.url,
		finalUrl,
		status,
		contentType,
		title: wrappedTitle,
		extractMode: args.extractMode,
		extractor: extracted.extractor,
		externalContent: buildExternalContentMeta({ source: "web_fetch", wrapped: true }),
		truncated,
		length: wrapped.length,
		rawLength,
		fetchedAt: new Date().toISOString(),
		tookMs: 0, // filled in by caller after end-to-end timing
		text: wrapped,
		warning,
		...(fallbackPreferred ? { _fallbackPreferred: true as const } : {}),
	};
}

/* ─────────────────────────── provider fallback ─────────────────────────── */

async function runProviderFetch(args: {
	provider: WebFetchProvider;
	providerCtx: WebProviderContext;
	url: string;
	extractMode: "markdown" | "text";
	maxChars: number;
	signal?: AbortSignal;
}): Promise<FetchUrlDetails | null> {
	const def = args.provider.createTool(args.providerCtx);
	if (!def) return null;
	const raw = await def.execute(
		{ url: args.url, extractMode: args.extractMode, maxChars: args.maxChars },
		args.signal,
	);
	// Normalize the provider's free-form return into our canonical payload.
	return normalizeProviderPayload({
		raw,
		providerId: args.provider.id,
		requestedUrl: args.url,
		extractMode: args.extractMode,
		maxChars: args.maxChars,
	});
}

function normalizeProviderPayload(args: {
	raw: Record<string, unknown>;
	providerId: string;
	requestedUrl: string;
	extractMode: "markdown" | "text";
	maxChars: number;
}): FetchUrlDetails {
	const r = args.raw;
	const text = String(r.text ?? r.markdown ?? r.content ?? "");
	const wrapped = wrapWebContent(text, "web_fetch");
	const status = typeof r.status === "number" ? r.status : 200;
	const finalUrl = typeof r.finalUrl === "string" ? r.finalUrl : args.requestedUrl;
	const contentType = typeof r.contentType === "string" ? normalizeContentType(r.contentType) : undefined;
	const title = typeof r.title === "string"
		? wrapWebContent(r.title, "web_fetch", { includeWarning: false })
		: undefined;
	const rawLength = typeof r.rawLength === "number" ? r.rawLength : text.length;
	const truncated = Boolean(r.truncated);
	return {
		url: args.requestedUrl,
		finalUrl,
		status,
		contentType,
		title,
		extractMode: args.extractMode,
		extractor: typeof r.extractor === "string"
			? (r.extractor as ExtractedContent["extractor"])
			: "raw",
		externalContent: buildExternalContentMeta({
			source: "web_fetch",
			provider: args.providerId,
			wrapped: true,
		}),
		truncated,
		length: wrapped.length,
		rawLength,
		fetchedAt: new Date().toISOString(),
		tookMs: 0,
		text: wrapped,
		warning: typeof r.warning === "string" ? r.warning : undefined,
	};
}

/* ─────────────────────────── helpers ─────────────────────────── */

function jsonResult(payload: FetchUrlDetails): AgentToolResult<FetchUrlDetails> {
	// Strip internal-only hints (the `_fallbackPreferred` flag is for the
	// runtime's decision tree, never for the model).
	const { _fallbackPreferred: _omit, ...sanitized } = payload;
	void _omit;
	return {
		content: [{ type: "text", text: JSON.stringify(sanitized, null, 2) }],
		details: sanitized as FetchUrlDetails,
	};
}

function normalizeContentType(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	return raw.split(";")[0]?.trim().toLowerCase();
}

function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function looksLikeHtml(text: string): boolean {
	const head = text.slice(0, 200).trim().toLowerCase();
	return head.startsWith("<!doctype html") || head.startsWith("<html") || /^<\w+/.test(head);
}

/** Re-export for tests / inspection. */
export { FETCH_CACHE, FetchUrlSchema, SsrfBlockedError };
