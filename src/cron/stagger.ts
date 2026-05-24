/**
 * Deterministic per-job stagger offset.
 *
 * When N jobs share the same fire-time (a `0 * * * *` cluster all hitting
 * top-of-hour), kicking them off simultaneously stampedes the LLM provider.
 * The fix is a per-job offset that:
 *
 *   - Stays inside a bounded window (`staggerMs` — defaults to 5 minutes for
 *     top-of-hour `cron` jobs, else 0).
 *   - Is DETERMINISTIC for a given (jobId, staggerMs) pair so the scheduler
 *     computes the same offset every restart — no flapping between ticks.
 *   - Spreads roughly-uniformly across the window so a hundred jobs don't all
 *     land on the same millisecond.
 *
 * Algorithm: SHA-256 the jobId, take the first 4 bytes as a uint32 (big-
 * endian), mod the window. The cache caps at a few thousand entries so a
 * pathological set of unique jobIds can't OOM us.
 */

import { createHash } from "node:crypto";

const STAGGER_CACHE_MAX = 4096;
const staggerCache = new Map<string, number>();

/**
 * Compute the stagger offset (ms) to add to the canonical fire-time for a
 * job whose schedule has `staggerMs` band. Returns 0 when `staggerMs <= 0`
 * so the caller can skip the work.
 */
export function computeJobStaggerOffsetMs(jobId: string, staggerMs: number): number {
	if (!Number.isFinite(staggerMs) || staggerMs <= 0) return 0;
	const cacheKey = `${staggerMs}:${jobId}`;
	const cached = staggerCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const digest = createHash("sha256").update(jobId).digest();
	const bucket = digest.readUInt32BE(0);
	const offset = bucket % Math.floor(staggerMs);
	if (staggerCache.size >= STAGGER_CACHE_MAX) {
		// Drop the oldest entry — Map iteration is insertion-order so the
		// first key is the oldest. Cheaper than a full LRU since stagger
		// values rarely change for a stable cron set.
		const first = staggerCache.keys().next().value;
		if (first !== undefined) staggerCache.delete(first);
	}
	staggerCache.set(cacheKey, offset);
	return offset;
}

/**
 * Choose the default stagger window for a given cron expression at job-
 * creation time. Top-of-hour patterns (`0 * * * *`, `0 0 * * *`) get a 5-
 * minute window because that's where the stampede problem actually shows
 * up; other expressions default to 0 (exact firing).
 */
export function defaultStaggerMsForCronExpression(expr: string): number {
	const trimmed = expr.trim();
	if (!trimmed) return 0;
	// Match patterns where the minute field is exactly "0" (no comma, no
	// range, no step). That covers the common "on the hour" / "on the day"
	// schedules without spuriously staggering minute-by-minute crons.
	if (/^0\s+/.test(trimmed)) return 5 * 60 * 1000;
	return 0;
}

/** Test-only hook: clear the cache between cases. */
export function clearStaggerCacheForTests(): void {
	staggerCache.clear();
}
