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
	/** Round-trip time in ms. */
	elapsedMs: number;
}

export interface ProbeBlueBubblesArgs {
	serverUrl: string;
	password: string;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
}

/** Probe a BlueBubbles server's `server/info`. Never throws. */
export async function probeBlueBubbles(args: ProbeBlueBubblesArgs): Promise<BlueBubblesProbeResult> {
	const start = Date.now();
	if (!args.serverUrl.trim()) {
		return { ok: false, error: "BlueBubbles serverUrl is not configured", fatal: true, privateApi: null, elapsedMs: 0 };
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
			elapsedMs: Date.now() - start,
		};
	}
	try {
		const res = await blueBubblesFetchWithTimeout(
			url,
			{ method: "GET" },
			{ ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) },
		);
		const elapsedMs = Date.now() - start;
		if (res.status === 401 || res.status === 403) {
			return { ok: false, error: "BlueBubbles rejected the password (401/403)", fatal: true, privateApi: null, elapsedMs };
		}
		if (!res.ok) {
			return { ok: false, error: `BlueBubbles server/info returned HTTP ${res.status}`, fatal: false, privateApi: null, elapsedMs };
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
		return { ok: true, ...(serverInfo ? { serverInfo } : {}), privateApi, elapsedMs };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			fatal: false,
			privateApi: null,
			elapsedMs: Date.now() - start,
		};
	}
}

/** Parse the macOS major version from a server/info `os_version` (e.g. `"26.1"` → 26). */
export function parseMacOSMajorVersion(osVersion: string | undefined): number | null {
	const m = /^(\d+)/.exec((osVersion ?? "").trim());
	if (!m || !m[1]) return null;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) ? n : null;
}
