/**
 * SSRF guard + manual redirect loop for outbound web fetches.
 *
 * Why this exists: Brigade runs LLM-controllable URLs through `fetch`.
 * Without a guard, a model can be tricked into hitting `http://169.254.169.254/`
 * (cloud metadata) or `http://localhost:1234/` (developer service) and
 * leaking credentials. The guard:
 *
 *   1. Parses the URL — rejects non-http(s), malformed
 *   2. Classifies the hostname/IP — rejects loopback, RFC1918, link-local,
 *      `.local`, `.internal`, cloud-metadata, IPv6 ULA/link-local, etc.
 *   3. Drives the request with `redirect: "manual"` and re-checks every hop
 *      so a 301 → `http://10.0.0.1/` can't bypass the initial check
 *   4. Strips `Authorization` + `Cookie` on cross-origin redirects so a
 *      redirect to attacker.com can't exfiltrate creds
 *
 * Lifted in shape from the upstream reference. Brigade ships this in v1 —
 * SSRF is one of the cheapest-to-write, highest-impact security gates.
 */

import { isIP, isIPv4, isIPv6 } from "node:net";
import { promises as dnsPromises } from "node:dns";

import { DEFAULT_TIMEOUT_SECONDS } from "../../agents/tools/web-shared.js";

/** Default redirect cap — matches the upstream reference. */
export const DEFAULT_MAX_REDIRECTS = 3;

/** Custom error thrown when an SSRF gate rejects a URL or resolved IP. */
export class SsrfBlockedError extends Error {
	readonly url: string;
	readonly reason: string;
	constructor(url: string, reason: string) {
		super(`SSRF guard: refused to fetch ${url} (${reason})`);
		this.name = "SsrfBlockedError";
		this.url = url;
		this.reason = reason;
	}
}

/** Custom error thrown when a redirect loop / cycle / cap-exceed is hit. */
export class RedirectError extends Error {
	readonly url: string;
	constructor(url: string, reason: string) {
		super(`Redirect loop: ${reason} (${url})`);
		this.name = "RedirectError";
		this.url = url;
	}
}

/**
 * Hostnames that are flat-out refused — cloud metadata services + the
 * literal "localhost" variants + reserved TLDs that shouldn't escape an
 * internal network.
 */
const FORBIDDEN_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"metadata.google.internal",
	"metadata.aws.amazon.com",
	"metadata.azure.com",
	"169.254.169.254",
	"fd00:ec2::254",
]);

/** Hostname suffixes that flag a host as private/internal. */
const FORBIDDEN_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * Detect non-canonical IPv4 literals — `0177.0.0.1` (octal), `0x7f.0.0.1`
 * (hex), `2130706433` (decimal-int), `127.1` (short). All of these resolve
 * to `127.0.0.1` in `inet_aton` parsers but slip past a plain dotted-quad
 * regex. We refuse them outright — a fetch URL has no business carrying a
 * legacy form, and accepting them is a known SSRF bypass.
 */
function isLegacyIpv4Literal(host: string): boolean {
	// Single decimal integer that fits a 32-bit IPv4 address.
	if (/^\d+$/.test(host) && Number(host) <= 0xFFFFFFFF && Number(host) >= 256) return true;
	const parts = host.split(".");
	// Short forms (1-, 2-, 3-part dotted) — not canonical, refuse.
	if (parts.length > 0 && parts.length < 4 && parts.every((p) => /^\d+$/.test(p))) return true;
	// Octal prefix (`0` + digits, length > 1) or hex prefix (`0x`).
	for (const p of parts) {
		if (/^0\d+$/.test(p)) return true;
		if (/^0[xX][0-9a-fA-F]+$/.test(p)) return true;
	}
	return false;
}

/**
 * Classify an IPv4 address. Returns a reason string when the IP is in a
 * forbidden range, or `null` when it's safe to fetch.
 */
function classifyIPv4(ip: string): string | null {
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return "invalid IPv4";
	}
	const [a, b] = parts as [number, number, number, number];
	// 0.0.0.0/8 — "this network"
	if (a === 0) return "0.0.0.0/8 unspecified";
	// 10.0.0.0/8 — RFC1918 private
	if (a === 10) return "RFC1918 private (10/8)";
	// 100.64.0.0/10 — CGNAT
	if (a === 100 && b >= 64 && b <= 127) return "CGNAT (100.64/10)";
	// 127.0.0.0/8 — loopback
	if (a === 127) return "loopback (127/8)";
	// 169.254.0.0/16 — link-local + cloud metadata
	if (a === 169 && b === 254) return "link-local / cloud-metadata (169.254/16)";
	// 172.16.0.0/12 — RFC1918 private
	if (a === 172 && b >= 16 && b <= 31) return "RFC1918 private (172.16/12)";
	// 192.168.0.0/16 — RFC1918 private
	if (a === 192 && b === 168) return "RFC1918 private (192.168/16)";
	// 192.0.0.0/24 — IANA reserved
	if (a === 192 && b === 0) return "IANA reserved (192.0.0/24)";
	// 224.0.0.0/4 — multicast
	if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
	// 240.0.0.0/4 — reserved
	if (a >= 240) return "reserved (240.0.0.0/4)";
	return null;
}

/**
 * Classify an IPv6 address. Returns a reason string when the IP is in a
 * forbidden range, or `null` when it's safe. Conservative — when in doubt
 * we refuse.
 */
function classifyIPv6(ip: string): string | null {
	// Strip zone identifier (`fe80::1%eth0`) before classifying — the
	// address itself is what we judge; zone routes locally only.
	const noZone = ip.split("%", 1)[0] ?? ip;
	const lower = noZone.toLowerCase();
	// ::1 — loopback
	if (lower === "::1" || lower === "::ffff:127.0.0.1") return "IPv6 loopback";
	// :: — unspecified
	if (lower === "::") return "IPv6 unspecified";
	// fc00::/7 — Unique-Local (ULA)
	if (lower.startsWith("fc") || lower.startsWith("fd")) return "IPv6 ULA (fc00::/7)";
	// fe80::/10 — link-local
	if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
		return "IPv6 link-local (fe80::/10)";
	}
	// fec0::/10 — deprecated site-local. Some networks still use it
	// internally; treat as private and refuse.
	if (lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee") || lower.startsWith("fef")) {
		return "IPv6 site-local (fec0::/10, deprecated)";
	}
	// ::ffff:0:0/96 — IPv4-mapped — re-classify the embedded v4
	const mapped = lower.match(/^::ffff:([0-9.]+)$/);
	if (mapped) {
		const inner = classifyIPv4(mapped[1] ?? "");
		if (inner) return `IPv4-mapped IPv6 → ${inner}`;
	}
	return null;
}

/**
 * Refuse-fast hostname check — runs BEFORE DNS resolution. Catches the
 * obvious cases (literal `localhost`, IP-in-hostname, forbidden suffix)
 * so we don't even spend a DNS round-trip.
 */
export function classifyHostnameSync(hostname: string): string | null {
	const host = hostname.toLowerCase();
	if (!host) return "empty hostname";
	if (FORBIDDEN_HOSTNAMES.has(host)) return `forbidden hostname (${host})`;
	for (const suffix of FORBIDDEN_HOSTNAME_SUFFIXES) {
		if (host.endsWith(suffix)) return `forbidden hostname suffix (${suffix})`;
	}
	// Strip brackets from IPv6 literals before classifying.
	const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	// Refuse non-canonical IPv4 (octal/hex/decimal-int/short forms) outright —
	// these resolve to the same IP via legacy inet_aton parsers but bypass a
	// dotted-quad sanity check.
	if (isLegacyIpv4Literal(stripped)) return "legacy IPv4 literal (non-canonical form)";
	if (isIPv4(stripped)) return classifyIPv4(stripped);
	// Drop zone identifier before IPv6 classification.
	const noZone = stripped.split("%", 1)[0] ?? stripped;
	if (isIPv6(noZone)) return classifyIPv6(noZone);
	if (isIP(stripped) === 0 && /^[\d.]+$/.test(stripped)) return "invalid IPv4 literal";
	return null;
}

/**
 * Full SSRF check — sync hostname classify + DNS resolution + re-classify
 * every resolved A/AAAA record. A hostname like `attacker.com` passing
 * the sync check can still resolve to a private IP (`10.0.0.1`) and the
 * DNS-rebinding variant needs to be caught after resolution.
 *
 * Both happy-paths and rejections are explicit: returns `null` when the
 * URL is safe, returns an `SsrfBlockedError`-shaped reason string when
 * not. Caller throws.
 */
export async function classifyUrlForSsrf(rawUrl: string): Promise<string | null> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return "invalid URL";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return `forbidden protocol (${parsed.protocol})`;
	}
	const hostReason = classifyHostnameSync(parsed.hostname);
	if (hostReason) return hostReason;
	// If hostname is already an IP, the sync check has already classified
	// it — skip DNS.
	if (isIP(parsed.hostname) !== 0) return null;
	// Resolve A + AAAA in parallel. `lookup` returns the active resolver's
	// answer (system DNS or whatever); we treat any record in a forbidden
	// range as a refusal. Network failure → DNS error: surface as a
	// non-SSRF error so the caller's HTTP retry kicks in normally.
	try {
		const addresses = await dnsPromises.lookup(parsed.hostname, { all: true });
		for (const a of addresses) {
			const reason = a.family === 6 ? classifyIPv6(a.address) : classifyIPv4(a.address);
			if (reason) return `${parsed.hostname} resolves to ${a.address}: ${reason}`;
		}
	} catch {
		// DNS failure isn't an SSRF block — let the fetch attempt fail
		// naturally so the model sees "could not resolve" instead of "SSRF".
		return null;
	}
	return null;
}

export interface GuardedFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: RequestInit["body"];
	maxRedirects?: number;
	timeoutMs?: number;
	/** Signal from the caller (e.g. agent turn cancel). Combined with the timeout signal. */
	signal?: AbortSignal;
}

/** Headers stripped on cross-origin redirects to prevent credential leakage. */
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Run an HTTP request with the SSRF guard active and a manual redirect
 * loop. Every hop is SSRF-checked; `Authorization`/`Cookie` headers are
 * stripped when the redirect crosses origins; the timeout signal is
 * combined with the caller's signal so either side can cancel.
 *
 * Returns the final `Response` (status 2xx/3xx/4xx/5xx — caller handles
 * status). Throws `SsrfBlockedError` on guard rejection, `RedirectError`
 * on cycle/cap-exceed, or whatever `fetch` throws on network error.
 */
export async function guardedFetch(
	rawUrl: string,
	opts: GuardedFetchOptions = {},
): Promise<{ response: Response; finalUrl: string; redirectChain: string[] }> {
	const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000;
	const timeoutController = new AbortController();
	const timeoutTimer = setTimeout(() => timeoutController.abort(new Error("timeout")), timeoutMs);
	timeoutTimer.unref?.();
	const signal = mergeSignals([opts.signal, timeoutController.signal]);

	const visited = new Set<string>();
	const chain: string[] = [];
	let currentUrl = rawUrl;
	let currentMethod = (opts.method ?? "GET").toUpperCase();
	let currentBody: RequestInit["body"] | undefined = opts.body;
	let currentHeaders = { ...(opts.headers ?? {}) };

	try {
		for (let hop = 0; hop <= maxRedirects; hop += 1) {
			if (visited.has(currentUrl)) {
				throw new RedirectError(currentUrl, "cycle detected");
			}
			visited.add(currentUrl);
			chain.push(currentUrl);

			const ssrfReason = await classifyUrlForSsrf(currentUrl);
			if (ssrfReason) throw new SsrfBlockedError(currentUrl, ssrfReason);

			const response = await fetch(currentUrl, {
				method: currentMethod,
				headers: currentHeaders,
				body: currentBody ?? undefined,
				redirect: "manual",
				signal,
			});

			// Non-redirect: we're done. Caller handles the status.
			if (response.status < 300 || response.status >= 400 || response.status === 304) {
				return { response, finalUrl: currentUrl, redirectChain: chain };
			}
			const location = response.headers.get("location");
			if (!location) {
				// Per RFC, a 3xx without Location is malformed. Treating it as
				// success would silently send the model an empty body, hiding
				// the upstream's broken redirect. Fail loudly.
				throw new RedirectError(currentUrl, `3xx ${response.status} without Location header`);
			}

			// Resolve the redirect target relative to the current URL.
			const nextUrl = (() => {
				try {
					return new URL(location, currentUrl).toString();
				} catch {
					return null;
				}
			})();
			if (!nextUrl) throw new RedirectError(currentUrl, `malformed Location: ${location}`);

			if (hop === maxRedirects) {
				throw new RedirectError(nextUrl, `exceeded ${maxRedirects} redirects`);
			}

			const prevOrigin = new URL(currentUrl).origin;
			const nextOrigin = new URL(nextUrl).origin;
			const crossOrigin = prevOrigin !== nextOrigin;

			// 303 forces GET; 301/302 historically convert POST→GET; 307/308
			// preserve the method. Bodies are dropped on any method change.
			// Additionally, on a cross-origin 307/308 we drop the body even
			// though method is preserved — the source body may carry secrets
			// (auth tokens, session blobs) that shouldn't be sent to the new
			// origin.
			let nextMethod = currentMethod;
			let nextBody = currentBody;
			if (response.status === 303) {
				nextMethod = "GET";
				nextBody = null;
			} else if ((response.status === 301 || response.status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD") {
				nextMethod = "GET";
				nextBody = null;
			} else if ((response.status === 307 || response.status === 308) && crossOrigin) {
				nextBody = null;
			}

			// Cross-origin redirects strip sensitive headers so a redirect
			// to attacker.com can't see the original Authorization header.
			let nextHeaders = currentHeaders;
			if (crossOrigin) {
				nextHeaders = {};
				for (const [k, v] of Object.entries(currentHeaders)) {
					if (!SENSITIVE_HEADERS.includes(k.toLowerCase())) nextHeaders[k] = v;
				}
			}

			currentUrl = nextUrl;
			currentMethod = nextMethod;
			currentBody = nextBody;
			currentHeaders = nextHeaders;
		}
		// Loop body always returns or throws; unreachable.
		throw new RedirectError(currentUrl, "redirect loop did not terminate");
	} finally {
		clearTimeout(timeoutTimer);
	}
}

/**
 * Merge multiple `AbortSignal`s into one that aborts when ANY input aborts.
 * Returns `undefined` when all inputs are undefined (no signal).
 */
function mergeSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
	const real = signals.filter((s): s is AbortSignal => s !== undefined);
	if (real.length === 0) return undefined;
	if (real.length === 1) return real[0];
	// Node 22 has AbortSignal.any; older falls back to manual wiring.
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn.call(AbortSignal, real);
	const ctl = new AbortController();
	const handler = (e?: unknown) => ctl.abort(e);
	for (const s of real) {
		if (s.aborted) {
			ctl.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => handler(s.reason), { once: true });
	}
	return ctl.signal;
}
