/**
 * Pure sequence helpers for the reliable-streaming layer — shared by the
 * gateway (which STAMPS a per-session seq on every ordered `pi` frame) and the
 * client (which DETECTS a gap to trigger `resume`). Kept pure + dependency-free
 * so both sides agree by construction, and so the logic is unit-testable
 * without booting a socket (the suite convention).
 *
 * The contract in one line: only `pi` frames carry a per-session monotonic
 * `seq`; the client resumes whenever the next seq isn't the contiguous
 * successor of the last one it saw.
 */

/**
 * Next per-session sequence number for a session, or `undefined` when there is
 * no session id (an untagged frame, which is never sequenced). The CALLER
 * decides which event types are part of the ordered stream and only calls this
 * for those — today: top-level `pi`, `approval-request`, and `system-event`,
 * which share one per-session counter so a client detects a gap in ANY of them.
 * `state` / `error` / `log` and sub-agent `pi` frames are unordered and stay
 * seq-less. Mutates `counters` in place (one entry per session).
 */
export function nextSeq(
	counters: Map<string, number>,
	sessionId: string | undefined,
): number | undefined {
	if (!sessionId) return undefined;
	const next = (counters.get(sessionId) ?? 0) + 1;
	// DELETE BEFORE SET, so the Map's insertion order is least-recently-USED.
	// `Map.set` on an existing key does NOT reorder, so without this the map is
	// ordered by first-seen and an LRU sweep over it evicts the OLDEST LIVE
	// session first — in practice the operator's own long-running thread, whose
	// counter then restarts at 1 and makes every connected client see a
	// backwards seq, resync, and repaint its whole transcript.
	counters.delete(sessionId);
	counters.set(sessionId, next);
	return next;
}

/**
 * True when `got` is NOT the contiguous successor of `last` — i.e. a frame was
 * missed (gap up), reordered, or the server reset its counter (gateway restart
 * → `got` lower than `last`). Any of these means the live view may be
 * incomplete, so the client should `resume` to rebuild from the transcript.
 * The first frame seen for a session (`last === undefined`) is never a gap.
 */
export function isSeqGap(last: number | undefined, got: number): boolean {
	return last !== undefined && got !== last + 1;
}
