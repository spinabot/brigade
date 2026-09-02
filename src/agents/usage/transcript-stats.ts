/**
 * Session usage totals, derived from the transcript.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * `UsageLedger` is in-memory, so a gateway restart zeroes every session's
 * spend. The ledger already knows how to recover — `seedFromStats` rebuilds a
 * session's committed bucket from its history — but the only caller was the
 * turn-attach path, which needs a LIVE session object. So a client that
 * connected and resumed a thread after a restart saw `0` until it sent a
 * message: no `billed` figure, no context percentage, a header that filled
 * itself in only once the operator typed something.
 *
 * The transcript already carries everything needed. Every assistant message
 * records its own `usage` — `input`, `output`, `cacheRead`, `cacheWrite`, and
 * a `cost` breakdown — so the totals are a fold over messages the resume path
 * has already read, in either storage mode. Nothing new is persisted, and
 * there is no second source of truth to drift.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS TAKES THE WHOLE TRANSCRIPT
 * ─────────────────────────────────────────────────────────────────────────
 * `resume` returns a CAPPED slice (`RESUME_TRANSCRIPT_MAX`). Folding that
 * slice would undercount any thread longer than the cap — and because
 * `seedFromStats` is idempotent, the undercount would then be permanent for
 * the life of the process. A wrong number that cannot be corrected is worse
 * than a missing one, so callers must pass the complete history.
 */

/** The stats shape `UsageLedger.seedFromStats` consumes. */
export interface TranscriptUsageStats {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	assistantMessages: number;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Cost is recorded as a per-component breakdown with a `total`, but older
 * transcripts wrote a bare number. Both are accepted; anything else is zero.
 */
function costOf(usage: Record<string, unknown>): number {
	const c = usage.cost;
	if (typeof c === "number") return num(c);
	if (c && typeof c === "object") return num((c as { total?: unknown }).total);
	return 0;
}

/**
 * Fold a session's assistant messages into usage totals.
 *
 * Accepts the loosely-typed message objects the transcript readers return in
 * both storage modes. Anything that is not an assistant message carrying a
 * `usage` object contributes nothing, so a malformed or partially-written row
 * cannot corrupt the total.
 */
export function sessionStatsFromMessages(messages: readonly unknown[]): TranscriptUsageStats {
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	let assistantMessages = 0;

	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as { role?: unknown; usage?: unknown };
		if (msg.role !== "assistant") continue;
		const usage = msg.usage;
		if (!usage || typeof usage !== "object") continue;
		const u = usage as Record<string, unknown>;
		assistantMessages += 1;
		tokens.input += num(u.input);
		tokens.output += num(u.output);
		tokens.cacheRead += num(u.cacheRead);
		tokens.cacheWrite += num(u.cacheWrite);
		cost += costOf(u);
	}

	return { tokens, cost, assistantMessages };
}
