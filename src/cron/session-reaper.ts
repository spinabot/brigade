/**
 * 24h retention pruner for isolated cron run sessions.
 *
 * Isolated cron runs create a fresh session per fire — over weeks of
 * scheduled traffic, the JSONL transcripts pile up. The reaper sweeps
 * the session-store + transcript files for keys matching
 * `cron:<jobId>:run:<uuid>` whose last-used timestamp is older than the
 * retention window, then deletes both halves.
 *
 * Hard-rules:
 *   - Only touches ISOLATED cron run sessions. Base cron sessions
 *     (`cron:<jobId>`) and named-target sessions (`cron:<jobId>:<name>`,
 *     without a `:run:` segment) are kept indefinitely — operators may
 *     want their full history.
 *   - When the config says `sessionRetention: false`, the reaper is a
 *     no-op. Operators can opt-out by setting that to `false` in
 *     `brigade.json`.
 *   - Best-effort: a single bad entry doesn't abort the sweep. Errors
 *     are logged + the sweep continues.
 *
 * Called from the cron timer's tick path (`service/timer.ts:onTimer`)
 * with self-throttling (`MIN_SWEEP_INTERVAL_MS = 5 min`) so a per-second
 * tick storm doesn't hammer the filesystem.
 */

import { promises as fs } from "node:fs";

import {
	deleteSessionEntry,
	readSessionStore,
} from "../sessions/session-store.js";
import { resolveSessionTranscriptPath } from "../config/paths.js";
import type { SubsystemLogger } from "../logging/subsystem-logger.js";

/** Default retention if `sessionRetention` is left as the string default. */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between sweeps when called from the tick loop. */
export const MIN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** `false` disables pruning entirely; a string like "24h" gets parsed. */
export function parseSessionRetention(spec: string | false | undefined): number | null {
	if (spec === false) return null; // disabled
	if (spec === undefined || spec === null) return DEFAULT_RETENTION_MS;
	const trimmed = spec.trim();
	if (!trimmed) return DEFAULT_RETENTION_MS;
	const m = trimmed.match(/^(\d+)\s*(s|m|h|d|w)$/i);
	if (!m) return DEFAULT_RETENTION_MS;
	const n = Number(m[1]);
	const unit = (m[2] ?? "h").toLowerCase();
	const multiplier: Record<string, number> = {
		s: 1_000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 604_800_000,
	};
	const mul = multiplier[unit];
	if (mul === undefined) return DEFAULT_RETENTION_MS;
	return n * mul;
}

/**
 * Return true if the given session key belongs to an isolated cron RUN
 * session (per-fire, ephemeral). Stable cron sessions and named ones are
 * preserved across runs and skipped.
 */
export function isIsolatedCronRunSessionKey(sessionKey: string): boolean {
	return /(^|:)cron:[^:]+:run:[^:]+$/.test(sessionKey);
}

export interface ReapSweepArgs {
	agentId: string;
	retentionMs: number;
	nowMs: number;
	log: SubsystemLogger;
}

export interface ReapSweepResult {
	scanned: number;
	pruned: number;
	transcriptsRemoved: number;
}

/**
 * One pass. Reads sessions.json, walks every entry, deletes ones that match
 * the cron-run pattern AND are older than `retentionMs` ago. Doesn't throw
 * on per-entry failure — logs and moves on so a single corrupt transcript
 * file can't block the whole sweep.
 */
export async function reapIsolatedCronSessions(args: ReapSweepArgs): Promise<ReapSweepResult> {
	const { agentId, retentionMs, nowMs, log } = args;
	const cutoff = nowMs - retentionMs;
	const store = readSessionStore(agentId);
	let scanned = 0;
	let pruned = 0;
	let transcriptsRemoved = 0;
	for (const [sessionKey, entry] of Object.entries(store.sessions)) {
		if (!isIsolatedCronRunSessionKey(sessionKey)) continue;
		scanned++;
		const lastUsed = Date.parse(entry.lastUsedAt);
		if (!Number.isFinite(lastUsed) || lastUsed > cutoff) continue;
		// Remove the transcript first. If the file is gone or the path
		// resolution throws, we still proceed to drop the entry — the
		// goal is to converge sessions.json with disk reality, not to
		// half-leave records pointing at vanished files.
		try {
			const sessionIdStr = typeof entry.sessionId === "string" ? entry.sessionId : null;
			if (sessionIdStr) {
				const transcriptPath = resolveSessionTranscriptPath(agentId, sessionIdStr);
				await fs.rm(transcriptPath, { force: true });
				transcriptsRemoved++;
			}
		} catch (err) {
			log.warn("reaper failed to delete transcript", {
				sessionKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		try {
			deleteSessionEntry(agentId, sessionKey);
			pruned++;
		} catch (err) {
			log.warn("reaper failed to delete session entry", {
				sessionKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (pruned > 0) {
		log.info("reaper pruned isolated cron sessions", {
			agentId,
			scanned,
			pruned,
			transcriptsRemoved,
			retentionMs,
		});
	}
	return { scanned, pruned, transcriptsRemoved };
}

/**
 * Test-only helper to wire the reaper directly from a tick path without
 * pulling in the full cron service. Tests can mock `nowMs` to verify
 * cutoff calculation; production calls go through the scheduler.
 */
export function shouldRunSweep(lastSweepAtMs: number | undefined, nowMs: number): boolean {
	if (lastSweepAtMs === undefined) return true;
	return nowMs - lastSweepAtMs >= MIN_SWEEP_INTERVAL_MS;
}
