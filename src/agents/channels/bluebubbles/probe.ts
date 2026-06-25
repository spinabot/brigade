/**
 * BlueBubbles probe / doctor.
 *
 * `probeBlueBubbles` does a `GET /api/v1/server/info` round-trip. It NEVER throws
 * — it returns `{ ok, error?, fatal?, serverInfo?, privateApi, elapsedMs }` so
 * `brigade channels status` / `doctor` can render a verdict and the adapter can
 * gate rich actions on the detected Private-API status (and advertise
 * capabilities honestly). `fetch` is injectable (the test seam).
 *
 *   - `ok: false` + `fatal: true`  → server unreachable / auth rejected (config error).
 *   - `ok: true`  + `privateApi`   → tri-state: true (rich actions live), false
 *                                    (text-only), or null (unknown — server info
 *                                    didn't report it).
 */

import {
	blueBubblesFetchWithTimeout,
	buildBlueBubblesApiUrl,
	type BlueBubblesServerInfo,
	type FetchLike,
} from "./types.js";

/** Result of a BlueBubbles probe — never throws; this is the verdict. */
export interface BlueBubblesProbeResult {
	ok: boolean;
	/** Operator-facing failure reason (when `ok: false`). */
	error?: string;
	/** True when the failure is a config error (bad URL / password), not transient. */
	fatal?: boolean;
	/** The parsed server/info payload (when reachable). */
	serverInfo?: BlueBubblesServerInfo;
	/** Private-API status — true / false / null (unknown). Gates rich actions. */
	privateApi: boolean | null;
	/**
	 * The macOS MAJOR version of the BlueBubbles host (e.g. 14, 15, 26), parsed
	 * from `serverInfo.os_version`. null when unknown. macOS 26+ removed iMessage
	 * EDIT, so the adapter refuses `edit` cleanly when this is ≥ 26.
	 */
	macOSMajor: number | null;
	/** Round-trip time in ms. */
	elapsedMs: number;
}

/** The macOS major version at/after which iMessage message EDIT is unsupported (Apple removed it). */
export const BLUEBUBBLES_EDIT_UNSUPPORTED_MACOS_MAJOR = 26;

/** True when the probed macOS major version no longer supports message edit (≥ 26). */
export function isMacOSEditUnsupported(macOSMajor: number | null | undefined): boolean {
	return typeof macOSMajor === "number" && macOSMajor >= BLUEBUBBLES_EDIT_UNSUPPORTED_MACOS_MAJOR;
}

export interface ProbeBlueBubblesArgs {
	serverUrl: string;
	password: string;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
}

/** Probe a BlueBubbles server's `server/info`. Never throws. */
export async function probeBlueBubbles(args: ProbeBlueBubblesArgs): Promise<BlueBubblesProbeResult> {
	const start = Date.now();
	if (!args.serverUrl.trim()) {
		return { ok: false, error: "BlueBubbles serverUrl is not configured", fatal: true, privateApi: null, macOSMajor: null, elapsedMs: 0 };
	}
	let url: string;
	try {
		url = buildBlueBubblesApiUrl({ serverUrl: args.serverUrl, path: "server/info", password: args.password });
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			fatal: true,
			privateApi: null,
			macOSMajor: null,
			elapsedMs: Date.now() - start,
		};
	}
	try {
		const res = await blueBubblesFetchWithTimeout(
			url,
			{ method: "GET" },
			{ ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}), ...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}) },
		);
		const elapsedMs = Date.now() - start;
		if (res.status === 401 || res.status === 403) {
			return { ok: false, error: "BlueBubbles rejected the password (401/403)", fatal: true, privateApi: null, macOSMajor: null, elapsedMs };
		}
		if (!res.ok) {
			return { ok: false, error: `BlueBubbles server/info returned HTTP ${res.status}`, fatal: false, privateApi: null, macOSMajor: null, elapsedMs };
		}
		let serverInfo: BlueBubblesServerInfo | undefined;
		try {
			const text = await res.text();
			const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
			const data = body.data;
			if (data && typeof data === "object") serverInfo = data as BlueBubblesServerInfo;
		} catch {
			serverInfo = undefined;
		}
		const privateApi =
			serverInfo && typeof serverInfo.private_api === "boolean" ? serverInfo.private_api : null;
		const macOSMajor = parseMacOSMajorVersion(serverInfo?.os_version);
		return { ok: true, ...(serverInfo ? { serverInfo } : {}), privateApi, macOSMajor, elapsedMs };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			fatal: false,
			privateApi: null,
			macOSMajor: null,
			elapsedMs: Date.now() - start,
		};
	}
}

/* ───────────────────────── server-info cache ───────────────────────── */

/** Default TTL for a cached probe result (10 min) — long enough to spare repeated sends a round-trip. */
export const BLUEBUBBLES_SERVER_INFO_CACHE_TTL_MS = 10 * 60 * 1000;
/** Cap on the number of distinct accounts held in the cache (LRU-ish; oldest evicted). */
export const BLUEBUBBLES_SERVER_INFO_CACHE_MAX = 64;

interface CachedProbe {
	result: BlueBubblesProbeResult;
	expiresAt: number;
}

/** Module-level per-account cache of the last successful probe. */
const serverInfoCache = new Map<string, CachedProbe>();

/** Evict the oldest entry when over the cap (Map preserves insertion order). */
function evictIfOver(): void {
	while (serverInfoCache.size > BLUEBUBBLES_SERVER_INFO_CACHE_MAX) {
		const oldest = serverInfoCache.keys().next().value;
		if (oldest === undefined) break;
		serverInfoCache.delete(oldest);
	}
}

/** Read a non-expired cached probe for an account, or null. */
export function getCachedBlueBubblesProbe(accountId: string, nowMs: number = Date.now()): BlueBubblesProbeResult | null {
	const hit = serverInfoCache.get(accountId);
	if (!hit) return null;
	if (hit.expiresAt <= nowMs) {
		serverInfoCache.delete(accountId);
		return null;
	}
	return hit.result;
}

/** Store a probe result for an account (refreshes its position for the LRU-ish cap). */
export function setCachedBlueBubblesProbe(
	accountId: string,
	result: BlueBubblesProbeResult,
	ttlMs: number = BLUEBUBBLES_SERVER_INFO_CACHE_TTL_MS,
	nowMs: number = Date.now(),
): void {
	serverInfoCache.delete(accountId); // refresh insertion order
	serverInfoCache.set(accountId, { result, expiresAt: nowMs + ttlMs });
	evictIfOver();
}

/** Clear the cache (tests + key rotation). */
export function clearBlueBubblesProbeCache(): void {
	serverInfoCache.clear();
}

/** Args for a cached probe — a probe plus the account-scope key + TTL/clock seams. */
export interface ProbeBlueBubblesCachedArgs extends ProbeBlueBubblesArgs {
	/** Cache key — the account id this probe is scoped to. */
	accountId: string;
	/** Override the cache TTL (ms). */
	cacheTtlMs?: number;
	/** Clock seam (tests). */
	now?: () => number;
}

/**
 * Probe a BlueBubbles server, served from a per-account TTL cache when fresh.
 * Repeated sends/actions within the TTL reuse the last probe (no extra
 * round-trip). Only a SUCCESSFUL probe (`ok: true`) is cached — a transient
 * failure isn't, so the next call retries the server. Never throws.
 */
export async function probeBlueBubblesCached(args: ProbeBlueBubblesCachedArgs): Promise<BlueBubblesProbeResult> {
	const nowMs = (args.now ?? Date.now)();
	const cached = getCachedBlueBubblesProbe(args.accountId, nowMs);
	if (cached) return cached;
	const result = await probeBlueBubbles(args);
	if (result.ok) setCachedBlueBubblesProbe(args.accountId, result, args.cacheTtlMs ?? BLUEBUBBLES_SERVER_INFO_CACHE_TTL_MS, nowMs);
	return result;
}

/** Parse the macOS major version from a server/info `os_version` (e.g. `"26.1"` → 26). */
export function parseMacOSMajorVersion(osVersion: string | undefined): number | null {
	const m = /^(\d+)/.exec((osVersion ?? "").trim());
	if (!m || !m[1]) return null;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) ? n : null;
}
