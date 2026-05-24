/**
 * Schedule resolver — turns a `CronSchedule` plus current time into a next-
 * fire timestamp.
 *
 * Three kinds, three algorithms:
 *
 *   - `cron` → delegate to the `croner` library (5/6/7-field with named
 *     months/days). Per-expression timezone supported; falls back to the
 *     host timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`
 *     when unset. `catch: false` means missed DST-gap times are skipped
 *     (NOT caught up) — the next valid fire is the next non-ambiguous slot.
 *   - `every` → arithmetic: nextRun = anchor + ceil((now - anchor) / step) * step.
 *   - `at` → return the timestamp if it's in the future, else undefined
 *     (one-shot is done).
 *
 * Parsing is expensive enough to be worth caching — the LRU keyed on
 * `<expr>::<tz>` holds the last 512 parsed Cron instances. Cache misses
 * happen on every-job-changes events; cache hits are the steady-state.
 */

import { Cron } from "croner";

import type { CronSchedule } from "./types.js";

const PARSE_CACHE_MAX = 512;
const parseCache = new Map<string, Cron>();

function resolveCronTimezone(tz: string | undefined): string {
	if (typeof tz === "string" && tz.length > 0) return tz;
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function getOrParseCron(expr: string, tz: string): Cron {
	const cacheKey = `${expr}::${tz}`;
	const cached = parseCache.get(cacheKey);
	if (cached !== undefined) return cached;
	// `catch: false` propagates parse errors to the caller instead of
	// silently producing a no-fire instance — we want the operator (or the
	// agent that called `cron add`) to see a clear validation error.
	const parsed = new Cron(expr, { timezone: tz, catch: false });
	if (parseCache.size >= PARSE_CACHE_MAX) {
		const oldest = parseCache.keys().next().value;
		if (oldest !== undefined) parseCache.delete(oldest);
	}
	parseCache.set(cacheKey, parsed);
	return parsed;
}

/**
 * Throws on an invalid cron expression. Operator-facing — message comes from
 * croner directly and is already reasonable ("Pattern A of the expression is
 * invalid").
 */
export function validateCronExpression(expr: string, tz?: string): void {
	getOrParseCron(expr, resolveCronTimezone(tz));
}

/**
 * Compute the next-fire timestamp for a schedule, given the current
 * wall-clock time. Returns `undefined` when the schedule has no future fires
 * (one-shot `at` already passed) — caller treats that as "job is done".
 */
export function computeNextRunAtMs(
	schedule: CronSchedule,
	nowMs: number,
): number | undefined {
	switch (schedule.kind) {
		case "at": {
			return schedule.at > nowMs ? schedule.at : undefined;
		}
		case "every": {
			const step = Math.max(1, Math.floor(schedule.everyMs));
			const anchor = schedule.anchorMs ?? nowMs;
			// Future anchor — first fire IS the anchor itself.
			if (nowMs < anchor) return anchor;
			// Strict "next slot AFTER nowMs": adding 1 to the floor ensures
			// `nowMs == anchor` (the common case for fresh jobs) advances by
			// one interval rather than firing immediately. Operators who say
			// `every 5m` expect the first fire 5 minutes out, not right now.
			const elapsed = nowMs - anchor;
			const steps = Math.floor(elapsed / step) + 1;
			return anchor + steps * step;
		}
		case "cron": {
			const tz = resolveCronTimezone(schedule.tz);
			const cron = getOrParseCron(schedule.expr, tz);
			const next = cron.nextRun(new Date(nowMs));
			if (!next) return undefined;
			const nextMs = next.getTime();
			// Defensive: croner has historically had edge-case bugs around
			// year boundaries in some timezones (e.g., it would suggest a
			// "next run" that's actually in the past). If we see that, nudge
			// the seed forward and retry once — covers the bug without
			// pinning to a specific croner patch level.
			if (nextMs <= nowMs) {
				const retry = cron.nextRun(new Date(nowMs + 1000));
				if (retry && retry.getTime() > nowMs) return retry.getTime();
				return undefined;
			}
			return nextMs;
		}
	}
}

/**
 * Compute the PREVIOUS fire-time at or before `nowMs`. Used for catchup
 * detection: when the process restarts after a gap, we ask "what was the
 * most recent scheduled slot?" and compare to `lastRunAtMs` to decide
 * whether to replay.
 *
 * Only meaningful for `cron` + `every` kinds. `at` jobs are one-shot — if
 * they fired, `lastRunAtMs` is set; if not, the catchup logic will simply
 * fire them on the next tick.
 */
export function computePreviousRunAtMs(
	schedule: CronSchedule,
	nowMs: number,
): number | undefined {
	switch (schedule.kind) {
		case "at": {
			return schedule.at <= nowMs ? schedule.at : undefined;
		}
		case "every": {
			const step = Math.max(1, Math.floor(schedule.everyMs));
			const anchor = schedule.anchorMs ?? nowMs;
			if (nowMs < anchor) return undefined;
			const elapsed = nowMs - anchor;
			const steps = Math.floor(elapsed / step);
			return anchor + steps * step;
		}
		case "cron": {
			const tz = resolveCronTimezone(schedule.tz);
			const cron = getOrParseCron(schedule.expr, tz);
			// croner's `previousRun()` takes no args (uses "now"); to anchor
			// at our virtual `nowMs` (test-clock friendly) we use the bulk
			// form `previousRuns(1, reference)` and grab the first result.
			const prev = cron.previousRuns(1, new Date(nowMs));
			const first = prev[0];
			return first ? first.getTime() : undefined;
		}
	}
}

/** Test-only hook: clear the LRU between cases. */
export function clearScheduleCacheForTests(): void {
	parseCache.clear();
}
