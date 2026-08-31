/**
 * "Compact my thread" — held between the ask and the next turn.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A DEFERRAL EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────
 * Compaction needs a live `AgentSession`, and one only exists for the duration
 * of a turn. But the moment a person types `/compact` is precisely when they
 * are NOT in a turn — idle, looking at a context bar they want to bring down
 * before asking the next question.
 *
 * The gateway used to answer that with an error: "nothing to compact yet".
 * On a thread with 34 messages and 79k tokens in the window, that is both
 * wrong and discouraging, and it is how an advertised command quietly becomes
 * folklore ("/compact doesn't do anything").
 *
 * So the ask is recorded here and honoured by the next turn, which compacts
 * before it sends. The operator's window is reclaimed before their next
 * message is processed — the outcome they wanted, one turn later than they
 * expected, and said out loud rather than refused.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT IS A ONE-SHOT
 * ─────────────────────────────────────────────────────────────────────────
 * `consume` clears as it reads. A request that survived its turn would compact
 * every subsequent turn forever, which is both expensive and destructive —
 * each pass summarises a summary. One ask, one compaction.
 *
 * Bounded because an unconsumed request is possible: an operator can `/compact`
 * a thread and never speak to it again.
 */

/** Sessions whose next turn must compact regardless of context fill. */
const requested = new Set<string>();

/**
 * Cap on outstanding requests.
 *
 * Each entry is one short string, so this is small — but a gateway that runs
 * for days across many threads must not accumulate them without limit, and an
 * unconsumed request is the normal outcome for an abandoned thread.
 */
const MAX_PENDING = 256;

/** Record that this session's next turn should compact. Idempotent. */
export function requestForcedCompaction(sessionKey: string | undefined): void {
	if (!sessionKey) return;
	// Re-inserting moves the key to the end, so the eviction below drops the
	// least-recently-requested rather than an ask that was just made.
	requested.delete(sessionKey);
	requested.add(sessionKey);
	while (requested.size > MAX_PENDING) {
		const oldest = requested.values().next().value as string | undefined;
		if (oldest === undefined) break;
		requested.delete(oldest);
	}
}

/**
 * Take the pending request for this session, if any.
 *
 * Clears as it reads — see the header for why this must be one-shot.
 */
export function consumeForcedCompaction(sessionKey: string | undefined): boolean {
	if (!sessionKey) return false;
	return requested.delete(sessionKey);
}

/** Whether a request is outstanding, without consuming it. For diagnostics. */
export function hasForcedCompaction(sessionKey: string | undefined): boolean {
	return sessionKey ? requested.has(sessionKey) : false;
}

/** Test seam. */
export function resetForcedCompactionForTest(): void {
	requested.clear();
}
