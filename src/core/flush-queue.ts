/**
 * Promote everything queued for a running turn into immediate steering.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GESTURE
 * ─────────────────────────────────────────────────────────────────────────
 * A plain Enter mid-turn QUEUES: Pi holds the message until the turn has no
 * more tool calls, so a reflex keystroke cannot derail a plan the model is
 * halfway through. That is the right default, but it leaves a gap — having
 * queued three messages, the natural next thought is "actually, show it those
 * now", and there was no way to say it without retyping them.
 *
 * DeepSeek's harness answers with an empty-draft Ctrl+Enter. This is that,
 * exposed as an RPC so the desktop and watch clients get it too instead of it
 * living only in the TUI's key handling.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS NEEDS NO SHADOW QUEUE
 * ─────────────────────────────────────────────────────────────────────────
 * Pi's `clearQueue()` REMOVES what it returns. That single property is what
 * makes the promotion safe: the messages leave Pi's queue and are re-queued as
 * steering, so nothing is delivered twice, and Brigade never has to maintain a
 * parallel queue that could drift out of step with Pi's.
 *
 * The failure path is the part worth caring about. `clearQueue()` has already
 * emptied Pi by the time the first `steer()` runs, so if the turn ends
 * mid-promotion, everything not yet delivered exists ONLY in this function's
 * local array. Dropping it there would silently destroy the operator's
 * messages — so the remainder goes back as follow-ups before the error is
 * re-thrown.
 */

/** The slice of `AgentSession` this needs. Narrow on purpose, so it is testable. */
export interface QueueOwner {
	clearQueue(): { steering: string[]; followUp: string[] };
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
}

/**
 * Drain the session's queues and re-deliver them as steering.
 *
 * Returns how many messages were promoted. Throws only if the session itself
 * failed, and always after attempting to restore whatever it could not deliver.
 */
export async function promoteQueue(session: QueueOwner): Promise<number> {
	const drained = session.clearQueue();
	// Steering first: those were already asked to be immediate, so a promoted
	// follow-up must not jump ahead of a message the operator explicitly steered.
	const promoted = [...drained.steering, ...drained.followUp];
	if (promoted.length === 0) return 0;

	let delivered = 0;
	try {
		for (const text of promoted) {
			await session.steer(text);
			delivered += 1;
		}
	} catch (err) {
		// The turn may have ended between the drain and here. Put back what we
		// could not deliver so it lands on the next turn rather than vanishing.
		for (const text of promoted.slice(delivered)) {
			try {
				await session.followUp(text);
			} catch {
				/* the session is gone entirely; nothing further can be done */
			}
		}
		throw err;
	}
	return delivered;
}
