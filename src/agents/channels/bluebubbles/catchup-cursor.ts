/**
 * BlueBubbles catch-up cursor persistence.
 *
 * Catch-up recovers messages delivered while Brigade was down. A FIXED lookback
 * window re-scans the same span every startup (re-deduping the overlap each
 * time) and, worse, permanently loses anything older than the window when an
 * outage runs long. A persisted per-account CURSOR (`lastSeenMs`) fixes both:
 * each run queries strictly AFTER the last run's high-water mark, advances the
 * cursor to "now" on success, holds it just before a still-retrying failure, and
 * force-advances past a message that has failed `maxFailureRetries` times (so one
 * malformed record can't wedge catch-up forever).
 *
 * The cursor is small per-account JSON under the channel's OWN state dir
 * (`~/.brigade/channels/bluebubbles/accounts/<id>/catchup-cursor.json`) — no
 * central store. Reads/writes are best-effort + total: a missing/garbage file
 * loads as `null` (→ first-run lookback), a write failure is swallowed (the next
 * run simply re-scans). `fs` is INJECTABLE for tests.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensureDir, resolveChannelStateDir } from "../sdk.js";
import { BLUEBUBBLES_CHANNEL_ID } from "./account-config.js";

/** The persisted cursor shape. */
export interface BlueBubblesCatchupCursor {
	/** High-water mark — the newest message timestamp this account has processed (epoch ms). */
	lastSeenMs: number;
	/** When the cursor was last written (epoch ms). */
	updatedAt: number;
	/**
	 * Per-message-GUID consecutive-failure counter, preserved across runs. An
	 * entry with `count >= maxFailureRetries` means catch-up has GIVEN UP on that
	 * GUID: it is skipped on sight and no longer holds the cursor back. A
	 * successful replay drops the entry. Optional so older cursor files load.
	 */
	failureRetries?: Record<string, number>;
}

/** Defense-in-depth cap on the retry map size (a storm of unique failing GUIDs). */
export const BLUEBUBBLES_MAX_FAILURE_RETRY_MAP_SIZE = 5_000;

/** A read/write seam so tests can run the cursor logic with no disk. */
export interface BlueBubblesCursorStore {
	load(accountId: string): BlueBubblesCatchupCursor | null;
	save(accountId: string, cursor: BlueBubblesCatchupCursor): void;
}

/** Resolve the per-account cursor file path under the channel's state dir. */
export function resolveCatchupCursorPath(accountId: string): string {
	const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
	return path.join(resolveChannelStateDir(BLUEBUBBLES_CHANNEL_ID), "accounts", safe, "catchup-cursor.json");
}

/** Drop non-positive / non-finite / non-string entries from a loaded retry map. */
export function sanitizeFailureRetries(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object") return {};
	const out: Record<string, number> = {};
	for (const [guid, count] of Object.entries(raw as Record<string, unknown>)) {
		if (!guid || typeof guid !== "string") continue;
		if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
		out[guid] = Math.floor(count);
	}
	return out;
}

/**
 * Cap the retry map to the `maxSize` highest-count entries (closest to give-up),
 * deterministic tiebreak on GUID. A defense-in-depth bound, not the primary prune
 * (entries not seen in a run are dropped by the caller building a fresh map).
 */
export function capFailureRetriesMap(map: Record<string, number>, maxSize: number): Record<string, number> {
	const entries = Object.entries(map);
	if (entries.length <= maxSize) return map;
	entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const capped: Record<string, number> = {};
	for (let i = 0; i < maxSize; i++) {
		const [guid, count] = entries[i]!;
		capped[guid] = count;
	}
	return capped;
}

/** The default filesystem-backed cursor store (under the channel state dir). */
export const filesystemCursorStore: BlueBubblesCursorStore = {
	load(accountId: string): BlueBubblesCatchupCursor | null {
		const file = resolveCatchupCursorPath(accountId);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return null; // missing → first run
		}
		try {
			const value = JSON.parse(text) as Partial<BlueBubblesCatchupCursor> | null;
			if (!value || typeof value !== "object") return null;
			if (typeof value.lastSeenMs !== "number" || !Number.isFinite(value.lastSeenMs)) return null;
			const failureRetries = sanitizeFailureRetries(value.failureRetries);
			const hasRetries = Object.keys(failureRetries).length > 0;
			return {
				lastSeenMs: value.lastSeenMs,
				updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
				...(hasRetries ? { failureRetries } : {}),
			};
		} catch {
			return null; // garbage → first run
		}
	},
	save(accountId: string, cursor: BlueBubblesCatchupCursor): void {
		const file = resolveCatchupCursorPath(accountId);
		try {
			ensureDir(path.dirname(file));
		} catch {
			try {
				mkdirSync(path.dirname(file), { recursive: true });
			} catch {
				return; // can't make the dir → best-effort skip
			}
		}
		const sanitized = sanitizeFailureRetries(cursor.failureRetries);
		const hasRetries = Object.keys(sanitized).length > 0;
		const payload: BlueBubblesCatchupCursor = {
			lastSeenMs: cursor.lastSeenMs,
			updatedAt: cursor.updatedAt,
			...(hasRetries ? { failureRetries: sanitized } : {}),
		};
		try {
			writeFileSync(file, JSON.stringify(payload), "utf8");
		} catch {
			/* best-effort — next run re-scans */
		}
	},
};
