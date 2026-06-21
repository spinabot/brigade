/**
 * Neutral reconnect-backoff helper — the one place every channel computes a
 * jittered exponential reconnect delay.
 *
 * Before this module each channel carried its own copy of the same five
 * constants + the same delay math: WhatsApp's `backoffDelay` (private to
 * `whatsapp/connection.ts`) and Telegram's `telegramBackoffDelay` (a verbatim
 * copy). Two identical implementations is one too many — a tweak to the curve
 * (say, raising the cap) would have to be made twice and could silently drift.
 * This helper is provider-AGNOSTIC: it takes the schedule as parameters so a
 * caller tuned to a Baileys socket and a caller tuned to a grammY long-poll can
 * share the exact same arithmetic while keeping their own constants.
 *
 * The math is lifted bit-for-bit from WhatsApp's proven schedule so existing
 * channels keep their exact reconnect behaviour:
 *
 *   base   = min(maxMs, initialMs * factor ** attempt)     // exponential, capped
 *   jitter = base * jitter * (Math.random() * 2 - 1)       // ±jitter, two-sided
 *   delay  = max(0, round(base + jitter))                  // never negative
 *
 * `attempt` is 0-based: attempt 0 yields ~initialMs (± jitter), and the curve
 * climbs by `factor` each attempt until it saturates at `maxMs` (± jitter). The
 * jitter is two-sided (it can pull the delay below the nominal base), which is
 * why the cap is applied to `base` BEFORE jitter — a late attempt lands within
 * ±jitter of `maxMs`, not strictly under it.
 *
 * Attempt-count caps (e.g. "give up after 12 tries") are a CALLER concern, not
 * encoded here — different providers abandon at different points, and a delay
 * helper shouldn't decide when to stop trying.
 */

/** The shape of a reconnect schedule — all four knobs a backoff curve needs. */
export interface BackoffSchedule {
	/** Attempt number, 0-based. Attempt 0 ≈ `initialMs` (± jitter). */
	attempt: number;
	/** Delay for attempt 0, in ms (the base of the exponential). */
	initialMs: number;
	/** Ceiling the exponential saturates at, in ms (applied before jitter). */
	maxMs: number;
	/** Per-attempt multiplier (e.g. 1.8 → each attempt is 1.8× the previous). */
	factor: number;
	/** Jitter fraction in [0, 1] — the delay varies by ±(jitter × base). */
	jitter: number;
}

/**
 * Compute the jittered exponential backoff delay (ms) for a reconnect attempt.
 *
 * Pure + deterministic except for the jitter term, which draws once from
 * `Math.random()`. Returns a non-negative integer number of milliseconds.
 *
 * @example
 * // WhatsApp / Telegram schedule: 2s → 30s, ×1.8, ±25%
 * const delay = nextBackoffDelay({ attempt, initialMs: 2_000, maxMs: 30_000, factor: 1.8, jitter: 0.25 });
 */
export function nextBackoffDelay(schedule: BackoffSchedule): number {
	const { attempt, initialMs, maxMs, factor, jitter } = schedule;
	const base = Math.min(maxMs, initialMs * factor ** attempt);
	const jittered = base * jitter * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(base + jittered));
}
