/**
 * BlueBubbles catch-up backfill.
 *
 * BlueBubbles delivers inbound via webhook POST. When Brigade is down (restart,
 * crash, upgrade) the server's webhook fire fails and is NOT retried, so any
 * message that arrived during the outage is lost. On (re)connect, catch-up
 * queries the server for messages delivered in a bounded recent window
 * (`POST /api/v1/message/query`, `after: <sinceMs>`, capped by `limit`) and
 * re-feeds each one through the SAME path a live webhook event takes —
 * normalize → dedupe → dispatch.
 *
 * The dedupe is what makes this safe: a message already delivered live (or in a
 * previous catch-up pass) is claimed in the connection's dedupe cache, so the
 * replay is dropped there and the agent NEVER replies twice. Catch-up therefore
 * recovers ONLY the genuinely-missed messages.
 *
 * `fetch` is INJECTABLE (the test seam) so the whole query → replay path runs
 * with no live server. Never throws — a query failure logs and leaves the live
 * webhook path untouched.
 */

import {
	capFailureRetriesMap,
	filesystemCursorStore,
	BLUEBUBBLES_MAX_FAILURE_RETRY_MAP_SIZE,
	type BlueBubblesCatchupCursor,
	type BlueBubblesCursorStore,
} from "./catchup-cursor.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl, type FetchLike } from "./types.js";

/** Default lookback window when running catch-up (30 min). */
export const BLUEBUBBLES_CATCHUP_DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;
/** Default per-run message cap. */
export const BLUEBUBBLES_CATCHUP_DEFAULT_LIMIT = 50;
/** Hard ceiling on the per-run cap (defends against an unbounded backlog). */
export const BLUEBUBBLES_CATCHUP_MAX_LIMIT = 500;
/** Default per-message consecutive-failure ceiling before catch-up gives up + force-advances past it. */
export const BLUEBUBBLES_CATCHUP_DEFAULT_MAX_FAILURE_RETRIES = 10;
/** Hard ceiling on `maxFailureRetries`. */
export const BLUEBUBBLES_CATCHUP_MAX_FAILURE_RETRIES = 1_000;

/** Tunables for one catch-up run. */
export interface BlueBubblesCatchupConfig {
	/** Disable catch-up entirely. */
	enabled?: boolean;
	/** How far back to look on the FIRST run (no cursor yet) (ms). Also the legacy fixed-lookback when no accountId is given. */
	lookbackMs?: number;
	/** Max messages to fetch in one run. */
	limit?: number;
	/**
	 * Per-message retry ceiling. After this many consecutive failed replays of the
	 * same GUID, catch-up logs + force-advances the cursor past it (instead of
	 * holding indefinitely). Defaults to 10; clamped to [1, 1000]. Only meaningful
	 * when a persisted cursor is in use (an `accountId` was provided).
	 */
	maxFailureRetries?: number;
}

/** Args for one catch-up run. */
export interface RunBlueBubblesCatchupArgs {
	serverUrl: string;
	password: string;
	config?: BlueBubblesCatchupConfig;
	timeoutMs?: number;
	/**
	 * Account id — enables the PERSISTED cursor (`lastSeenMs` + give-up retries).
	 * When omitted, catch-up falls back to the legacy fixed-lookback window with no
	 * persistence (unchanged behaviour).
	 */
	accountId?: string;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
	/**
	 * Re-feed one raw message record through the connection's live webhook path
	 * (normalize → dedupe → dispatch). The connection wires this to the SAME
	 * `feedWebhookEvent` a real webhook uses, so dedupe drops any already-seen
	 * message. THROWING from this marks the record as a failed replay (the cursor
	 * holds before it, and after `maxFailureRetries` it's given up + skipped).
	 */
	feedRecord: (record: Record<string, unknown>) => void;
	/** Optional logger. */
	log?: (msg: string) => void;
	/** Clock seam (tests). */
	now?: () => number;
	/** TEST SEAM — inject the cursor store (default: filesystem under the channel state dir). */
	cursorStore?: BlueBubblesCursorStore;
}

/** Outcome of a catch-up run (for logging + tests). */
export interface BlueBubblesCatchupSummary {
	/** True when the server query returned a recognised response. */
	querySucceeded: boolean;
	/** How many records the query returned. */
	fetched: number;
	/** How many were re-fed into the inbound path (pre-dedupe). */
	replayed: number;
	/** How many failed records crossed `maxFailureRetries` on THIS run (fresh give-ups). */
	givenUp: number;
	/** How many records were skipped because they were ALREADY given up in a prior run. */
	skippedGivenUp: number;
	/** How many records' replay threw on this run. */
	failed: number;
	/** The cursor before this run (epoch ms), or null on first run / no persistence. */
	cursorBefore: number | null;
	/** The cursor after this run (epoch ms). */
	cursorAfter: number;
	/** The `after` timestamp the query used (epoch ms). */
	windowStartMs: number;
}

/** Clamp the per-run limit into `[1, MAX]`. */
function clampLimit(raw: number | undefined): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : BLUEBUBBLES_CATCHUP_DEFAULT_LIMIT;
	return Math.min(Math.max(n, 1), BLUEBUBBLES_CATCHUP_MAX_LIMIT);
}

/** Clamp `maxFailureRetries` into `[1, MAX]`. */
function clampMaxFailureRetries(raw: number | undefined): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : BLUEBUBBLES_CATCHUP_DEFAULT_MAX_FAILURE_RETRIES;
	return Math.min(Math.max(n, 1), BLUEBUBBLES_CATCHUP_MAX_FAILURE_RETRIES);
}

/**
 * Read a record's timestamp (epoch ms) across camel/snake shapes; 0 when absent.
 * BlueBubbles `dateCreated` is already epoch ms, so the value is taken raw (the
 * cursor compares it against other `dateCreated` values + `now`).
 */
function recordTimestampMs(rec: Record<string, unknown>): number {
	for (const k of ["dateCreated", "date_created", "date", "timestamp"]) {
		const v = rec[k];
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return 0;
}

/** Read a record's GUID (the retry-map key), or "" when absent. */
function recordGuid(rec: Record<string, unknown>): string {
	const g = rec.guid ?? rec.messageGuid;
	return typeof g === "string" ? g.trim() : "";
}

/**
 * Run one bounded catch-up pass.
 *
 * With an `accountId`, queries strictly AFTER the persisted cursor (`lastSeenMs`),
 * re-feeds each record through `feedRecord` (the connection's normalize+dedupe
 * path), then advances the cursor: to "now" on a clean pass, held just before the
 * earliest still-retrying failure, force-advanced past any GUID that has failed
 * `maxFailureRetries` times, or to the page boundary when the fetch hit the
 * per-run limit (so a long backlog drains across runs instead of stranding the
 * tail). Without an `accountId`, falls back to the legacy fixed-lookback window
 * with no persistence. Returns a summary; never throws.
 */
export async function runBlueBubblesCatchup(args: RunBlueBubblesCatchupArgs): Promise<BlueBubblesCatchupSummary> {
	const cfg = args.config ?? {};
	const nowMs = (args.now ?? Date.now)();
	const lookbackMs =
		typeof cfg.lookbackMs === "number" && cfg.lookbackMs > 0 ? cfg.lookbackMs : BLUEBUBBLES_CATCHUP_DEFAULT_LOOKBACK_MS;
	const limit = clampLimit(cfg.limit);
	const maxFailureRetries = clampMaxFailureRetries(cfg.maxFailureRetries);
	const accountId = (args.accountId ?? "").trim();
	const usePersistedCursor = accountId.length > 0;
	const store = args.cursorStore ?? filesystemCursorStore;

	// Load the persisted cursor (only when an accountId is in play).
	const existing: BlueBubblesCatchupCursor | null = usePersistedCursor
		? (() => {
				try {
					return store.load(accountId);
				} catch {
					return null;
				}
			})()
		: null;
	const prevRetries = existing?.failureRetries ?? {};
	const cursorBefore = usePersistedCursor ? (existing?.lastSeenMs ?? null) : null;

	// Window start: after a USABLE cursor (not future-dated), else the first-run lookback.
	const cursorUsable = existing !== null && existing.lastSeenMs <= nowMs;
	const windowStartMs = cursorUsable ? existing!.lastSeenMs : nowMs - lookbackMs;

	const summary: BlueBubblesCatchupSummary = {
		querySucceeded: false,
		fetched: 0,
		replayed: 0,
		givenUp: 0,
		skippedGivenUp: 0,
		failed: 0,
		cursorBefore,
		cursorAfter: usePersistedCursor ? (cursorBefore ?? windowStartMs) : windowStartMs,
		windowStartMs,
	};

	if (cfg.enabled === false) return summary;

	let records: Array<Record<string, unknown>> = [];
	try {
		const url = buildBlueBubblesApiUrl({ serverUrl: args.serverUrl, path: "message/query", password: args.password });
		const res = await blueBubblesFetchWithTimeout(
			url,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					limit,
					sort: "ASC",
					after: windowStartMs,
					// Match the fields the live webhook carries so normalize sees the same shape.
					with: ["chat", "chat.participants", "attachment", "handle"],
				}),
			},
			{ ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}), ...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}) },
		);
		if (!res.ok) {
			args.log?.(`catchup: message/query returned HTTP ${res.status}`);
			return summary; // leave cursor unchanged → next run retries the same window
		}
		const text = await res.text();
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		const data = body.data;
		if (!Array.isArray(data)) {
			args.log?.("catchup: message/query returned no data array");
			return summary;
		}
		records = data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
		summary.querySucceeded = true;
		summary.fetched = records.length;
	} catch (err) {
		args.log?.(`catchup: message/query failed: ${err instanceof Error ? err.message : String(err)}`);
		return summary;
	}

	// Build a fresh retry map each run (GUIDs not seen this run are dropped — the
	// cursor advanced past them). Hold the cursor before the earliest STILL-RETRYING
	// failure; track the latest fetched ts for page-boundary advance.
	const nextRetries: Record<string, number> = {};
	let earliestFailureTs: number | null = null;
	let latestFetchedTs = windowStartMs;

	for (const record of records) {
		const ts = recordTimestampMs(record);
		if (ts > latestFetchedTs) latestFetchedTs = ts;
		const guid = recordGuid(record);

		// A GUID already given up in a prior run is skipped on sight (no replay,
		// doesn't hold the cursor) — preserve its count so give-up stays sticky.
		const prevCount = guid ? (prevRetries[guid] ?? 0) : 0;
		if (guid && prevCount >= maxFailureRetries) {
			summary.skippedGivenUp++;
			nextRetries[guid] = prevCount;
			continue;
		}

		// Re-feed through the SAME normalize+dedupe path a live webhook uses. The
		// connection's dedupe cache drops anything already delivered, so a replay
		// can never double-deliver. A THROW marks this record as a failed replay.
		try {
			args.feedRecord(record);
			summary.replayed++;
			// Success clears any accrued retries for this GUID (we just don't copy it).
		} catch (err) {
			summary.failed++;
			const nextCount = prevCount + 1;
			if (guid && nextCount >= maxFailureRetries) {
				// Crossed the ceiling: give up + force-advance past it (don't hold).
				summary.givenUp++;
				nextRetries[guid] = nextCount;
				args.log?.(
					`catchup: giving up on guid=${guid} after ${nextCount} failures; future runs will skip it. ${err instanceof Error ? err.message : String(err)}`,
				);
			} else {
				// Still retrying: hold the cursor just before the earliest such failure.
				if (guid) nextRetries[guid] = nextCount;
				if (ts > 0 && (earliestFailureTs === null || ts < earliestFailureTs)) earliestFailureTs = ts;
			}
		}
	}

	// Compute + persist the new cursor (only when persistence is in play).
	if (usePersistedCursor) {
		const isTruncated = summary.fetched >= limit;
		let nextCursorMs = nowMs;
		if (earliestFailureTs !== null) {
			// Hold just before the earliest still-retrying failure.
			nextCursorMs = Math.min(Math.max(earliestFailureTs - 1, cursorBefore ?? windowStartMs), nowMs);
		} else if (isTruncated) {
			// Advance only to the page boundary so the unfetched tail is reachable next run.
			nextCursorMs = Math.min(Math.max(latestFetchedTs, cursorBefore ?? windowStartMs), nowMs);
		}
		summary.cursorAfter = nextCursorMs;
		const retriesToPersist = capFailureRetriesMap(nextRetries, BLUEBUBBLES_MAX_FAILURE_RETRY_MAP_SIZE);
		try {
			store.save(accountId, {
				lastSeenMs: nextCursorMs,
				updatedAt: nowMs,
				...(Object.keys(retriesToPersist).length > 0 ? { failureRetries: retriesToPersist } : {}),
			});
		} catch (err) {
			args.log?.(`catchup: cursor save failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (isTruncated) {
			args.log?.(
				`catchup: WARNING fetched=${summary.fetched} hit limit=${limit}; cursor advanced only to page boundary, remaining picked up next run. Raise catchup.limit to drain larger backlogs.`,
			);
		}
	}

	args.log?.(
		`catchup: fetched=${summary.fetched} replayed=${summary.replayed} failed=${summary.failed} given_up=${summary.givenUp} skipped_givenUp=${summary.skippedGivenUp} window_ms=${nowMs - windowStartMs}`,
	);
	return summary;
}
