/**
 * Who gets content-stripped `message_update` frames.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN MODULE
 * ─────────────────────────────────────────────────────────────────────────
 * Delta streaming shipped as opt-OUT: every connection got frames with
 * `message.content` removed unless it explicitly said `deltas: false`. A client
 * that had never heard of deltas — the desktop app, the watch app, anyone on
 * npm — therefore rendered EMPTY streaming text until `message_end`, while
 * `PROTOCOL_VERSION` stayed at 1 with nothing to warn them.
 *
 * A silent breaking change to a published wire protocol is not something people
 * can opt out of, because they do not know there is anything to opt out of. So
 * the default is the OLD behaviour, and a client that understands deltas asks
 * for them.
 *
 * The rule lives here, exported and tested, rather than inline in `broadcast()`
 * where it was unreachable by any test.
 */

export interface DeltaFrameDecision {
	/** Is a stripped frame even available for this event? */
	hasDeltaFrame: boolean;
	/** The connection's id, if one has been assigned yet. */
	connId: string | undefined;
	/** Has this connection explicitly asked for deltas? */
	optedIn: boolean;
}

/**
 * True only when a stripped frame exists AND this connection asked for it.
 *
 * A connection with no id yet — the race between socket open and
 * `onConnection` assigning one — gets the full frame: we cannot know what it
 * supports, and the full frame is correct for every client.
 */
export function shouldSendDeltaFrame(d: DeltaFrameDecision): boolean {
	if (!d.hasDeltaFrame) return false;
	if (!d.connId) return false;
	return d.optedIn;
}
