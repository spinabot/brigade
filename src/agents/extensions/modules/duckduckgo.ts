/**
 * DuckDuckGo web-search provider — bundled, zero-config.
 *
 * Hits the `html.duckduckgo.com/html` endpoint (the lite, no-JS search page)
 * with a normal browser User-Agent, parses the resulting HTML for result
 * rows, and returns title/url/snippet triples. No API key required, no
 * card-on-file, no signup — works on a clean Brigade install.
 *
 * Trade-off: HTML scraping breaks when DDG changes its layout. Pair with
 * a JSON-API-backed provider (Tavily / Brave) as a second module when
 * production reliability matters.
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import { guardedFetch } from "../../../infra/net/fetch-guard.js";
import { decodeHtmlEntities } from "../../tools/web-fetch-utils.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import { resolveSiteName, wrapSearchHit } from "./web-provider-helpers.js";

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Result-row HTML pattern. The DDG layout uses `<a class="result__a" href="…">title</a>`
 * for the title-link + `<a class="result__snippet">snippet</a>` for the
 * snippet. The href is URL-encoded inside a `/l/?uddg=<encoded>` redirector;
 * we unwrap it back to the original URL.
 */
const RESULT_BLOCK_RE = /<div class="result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
const TITLE_LINK_RE = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

/** Unwrap DDG's `/l/?uddg=<encoded>` redirector to the original URL. */
function unwrapDdgUrl(rawHref: string): string {
	if (!rawHref.startsWith("/")) return rawHref;
	try {
		const absolute = new URL(rawHref, "https://duckduckgo.com").toString();
		const u = new URL(absolute);
		const uddg = u.searchParams.get("uddg");
		if (uddg) return decodeURIComponent(uddg);
		return absolute;
	} catch {
		return rawHref;
	}
}

/** Strip ALL HTML tags from a fragment + decode entities. */
function stripHtmlToText(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Parse the DDG HTML response into normalized hit objects. */
function parseDdgResults(html: string, count: number): Array<{ title: string; url: string; snippet?: string }> {
	const hits: Array<{ title: string; url: string; snippet?: string }> = [];
	let match: RegExpExecArray | null = null;
	const re = new RegExp(RESULT_BLOCK_RE.source, "gi");
	while ((match = re.exec(html)) !== null && hits.length < count) {
		const block = match[1] ?? "";
		const titleMatch = block.match(TITLE_LINK_RE);
		if (!titleMatch) continue;
		const href = titleMatch[1] as string;
		const titleHtml = titleMatch[2] as string;
		const title = stripHtmlToText(titleHtml);
		const url = unwrapDdgUrl(href);
		if (!title || !url) continue;
		const snippetMatch = block.match(SNIPPET_RE);
		const snippet = snippetMatch ? stripHtmlToText(snippetMatch[1] as string) : undefined;
		hits.push({ title, url, snippet });
	}
	return hits;
}

/**
 * Detect DDG's anti-bot challenge page so we can fail loud instead of
 * silently empty. Whitelist check first: if the page contains a
 * `result__a` link, treat as legitimate even if a marker word slipped in.
 * Otherwise scan for known challenge markers.
 */
function looksLikeBotChallenge(html: string): boolean {
	// Whitelist: if real result markup is present, accept the page.
	if (/class="[^"]*\bresult__a\b/i.test(html.slice(0, 5_000))) return false;
	const head = html.slice(0, 5_000);
	return /g-recaptcha|id="challenge-form"|name="challenge"|anomaly|unusual\s+traffic|please\s+verify|captcha|are\s+you\s+a\s+(?:human|robot)/i.test(
		head,
	);
}

interface DuckDuckGoConfig {
	/** SafeSearch level — DDG `kp` param: -2=off, -1=moderate, 1=strict. */
	safeSearch?: "off" | "moderate" | "strict";
	/** Region code — DDG `kl` param: e.g. "us-en", "uk-en", "de-de". */
	region?: string;
	/**
	 * Enable the Instant Answer JSON API fast-path. When `true` (default),
	 * Brigade tries `api.duckduckgo.com/?q=…&format=json` BEFORE the HTML
	 * scrape. For factual queries ("what is python", "capital of france",
	 * "len() python") this returns a structured zero-click answer in
	 * ~50ms vs. ~500ms for the scrape. The HTML scrape still runs in
	 * parallel as a fallback when the Instant Answer is empty.
	 */
	instantAnswer?: boolean;
}

interface InstantAnswerResponse {
	AbstractText?: unknown;
	AbstractURL?: unknown;
	AbstractSource?: unknown;
	Answer?: unknown;
	Heading?: unknown;
	Image?: unknown;
	RelatedTopics?: unknown;
}

/**
 * Hit DDG's Instant Answer JSON API. Returns a structured zero-click
 * answer when DDG has one (Wikipedia abstract, calculator result,
 * dictionary definition, package info, …). Returns null on empty/blank
 * response so the caller can fall back to the HTML scrape.
 */
async function tryInstantAnswer(args: {
	query: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ title: string; url: string; snippet?: string } | null> {
	const url = new URL("https://api.duckduckgo.com/");
	url.searchParams.set("q", args.query);
	url.searchParams.set("format", "json");
	url.searchParams.set("no_html", "1");
	url.searchParams.set("no_redirect", "1");
	url.searchParams.set("t", "brigade");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), args.timeoutMs);
	timer.unref?.();
	const merged = (() => {
		const real = [args.signal, controller.signal].filter((s): s is AbortSignal => s !== undefined);
		const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
		if (typeof anyFn === "function" && real.length > 1) return anyFn.call(AbortSignal, real);
		return real[0];
	})();
	try {
		const response = await fetch(url.toString(), {
			method: "GET",
			headers: { accept: "application/json" },
			signal: merged,
		});
		if (response.status !== 200) return null;
		const data = (await response.json().catch(() => null)) as InstantAnswerResponse | null;
		if (!data) return null;
		const abstract = typeof data.AbstractText === "string" ? data.AbstractText.trim() : "";
		const answer = typeof data.Answer === "string" ? data.Answer.trim() : "";
		const abstractUrl = typeof data.AbstractURL === "string" ? data.AbstractURL.trim() : "";
		const heading = typeof data.Heading === "string" ? data.Heading.trim() : "";
		// Prefer the explicit `Answer` (calculator / unit-conversion / package
		// info) over `AbstractText` (wiki blurb). Skip when both empty.
		const snippet = answer || abstract;
		if (!snippet) return null;
		const title = heading || args.query;
		const finalUrl = abstractUrl || `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`;
		return { title, url: finalUrl, snippet };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function resolveDdgConfig(cfg: unknown): DuckDuckGoConfig {
	const slot = (cfg as {
		tools?: { web?: { search?: { providers?: { duckduckgo?: DuckDuckGoConfig } } } };
	}).tools?.web?.search?.providers?.duckduckgo;
	return slot ?? {};
}

function safeSearchToKp(value: DuckDuckGoConfig["safeSearch"]): string | undefined {
	if (value === "off") return "-2";
	if (value === "moderate") return "-1";
	if (value === "strict") return "1";
	return undefined;
}

/** Build the DuckDuckGo provider. Zero-config — no envVar, no API key. */
function createDuckDuckGoProvider(): WebSearchProvider {
	return {
		id: "duckduckgo",
		label: "DuckDuckGo",
		hint: "Free, no API key. HTML-scraping the no-JS search page.",
		requiresCredential: false,
		envVars: [],
		signupUrl: "https://duckduckgo.com",
		docsUrl: "https://duckduckgo.com/duckduckgo-help-pages/",
		autoDetectOrder: 100, // keyless providers sort last; pinned providers win
		isConfigured: () => true,
		createTool(ctx: WebProviderContext): WebProviderToolDefinition {
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			const ddgCfg = resolveDdgConfig(ctx.config);
			const kp = safeSearchToKp(ddgCfg.safeSearch);
			const kl = ddgCfg.region?.trim();
			return {
				description: "DuckDuckGo web search (HTML lite endpoint).",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query." },
						count: { type: "integer", description: "Max results to return.", minimum: 1, maximum: 25 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("duckduckgo: missing query");
					const count = Math.max(1, Math.min(25, Number((args as { count?: unknown }).count ?? 10)));

					// Instant Answer fast-path. Default ON. For factual queries
					// this returns a structured answer ~10× faster than HTML
					// scraping. On miss we proceed straight to the scrape.
					const instantOn = ddgCfg.instantAnswer !== false;
					const instantHit = instantOn
						? await tryInstantAnswer({ query, timeoutMs: Math.min(timeoutMs, 5000), signal })
						: null;

					const form = new URLSearchParams({ q: query });
					if (kp) form.set("kp", kp);
					if (kl) form.set("kl", kl);
					const { response, finalUrl } = await guardedFetch(DDG_ENDPOINT, {
						method: "POST",
						headers: {
							"user-agent": DDG_USER_AGENT,
							accept: "text/html",
							"accept-language": "en-US,en;q=0.9",
							"content-type": "application/x-www-form-urlencoded",
						},
						body: form.toString(),
						timeoutMs,
						signal,
					});
					if (response.status !== 200) {
						throw new Error(
							`duckduckgo: HTTP ${response.status} from ${finalUrl} (likely anti-bot or temporary block). DO NOT retry web_search with a different query — DDG's keyless endpoint blocks at the source IP, not the query. Instead: (a) call the \`browser\` tool to navigate to a known URL for the content you need (e.g. unsplash.com, picsum.photos, wikipedia.org, the user's named site), OR (b) tell the operator to set BRAVE_SEARCH_API_KEY / TAVILY_API_KEY / EXA_API_KEY in the gateway env to switch to a JSON-API provider.`,
						);
					}
					const { text: html } = await readResponseText(response.body, 2_000_000);
					if (looksLikeBotChallenge(html)) {
						throw new Error(
							"duckduckgo: anti-bot challenge page returned. DO NOT retry web_search with a different query — DDG's anti-bot is IP-based, not query-based, and will block the same way. Instead: (a) call the `browser` tool to navigate to a known URL for the content you need, OR (b) tell the operator to set BRAVE_SEARCH_API_KEY / TAVILY_API_KEY / EXA_API_KEY in the gateway env.",
						);
					}
					const htmlResults = parseDdgResults(html, instantHit ? count - 1 : count);
					// Prepend the Instant Answer when we got one — it's almost
					// always the top-quality result for factual queries.
					const merged = instantHit
						? [
							{
								title: instantHit.title,
								url: instantHit.url,
								snippet: instantHit.snippet,
							},
							...htmlResults,
						]
						: htmlResults;
					// Route every hit through `wrapSearchHit` so DDG's HTML-scraped
					// title + snippet land inside the untrusted-content envelope.
					// Previously these strings were returned raw, which let a
					// poisoned page title escape the envelope (same security
					// gap we closed for Firecrawl). Every other provider does
					// this — DDG was the outlier.
					const results = merged
						.map((h) => {
							const title = h.title?.trim() ?? "";
							const url = h.url?.trim() ?? "";
							if (!title || !url) return null;
							const snippet = h.snippet?.trim();
							return wrapSearchHit({
								title,
								url,
								snippet: snippet && snippet.length > 0 ? snippet : undefined,
								siteName: resolveSiteName(url),
							});
						})
						.filter((r): r is NonNullable<typeof r> => r !== null);
					return { provider: "duckduckgo", query, count: results.length, results };
				},
			};
		},
	};
}

/** Brigade module — registers the DuckDuckGo provider via `b.webSearch`. */
export const duckduckgoModule = defineModule({
	id: "duckduckgo",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createDuckDuckGoProvider());
	},
});

// Re-exports for tests / direct construction.
export { createDuckDuckGoProvider, parseDdgResults, unwrapDdgUrl };
