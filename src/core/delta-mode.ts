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

/**
 * Build the content-stripped variant of a `message_update` frame.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES INSIDE `broadcast()`
 * ─────────────────────────────────────────────────────────────────────────
 * It lived inline in `server.ts`, which meant nothing could call it — so the
 * test that claimed to cover it re-implemented the strip locally and asserted
 * against its own copy. That copy stripped a bare Pi event; production strips
 * the nested `{ type, event, payload: { event } }` frame. The test passed
 * against a shape the gateway never emits, so the PRODUCER side of delta mode
 * was effectively untested while reporting green.
 *
 * Strips only `content` — the cumulative blocks, which are the entire O(n²)
 * payload. `role`, `timestamp` and `usage` stay: the timestamp is the client's
 * RENDER KEY (without it a delta cannot be attached to a block) and `usage`
 * drives the live token counter. Both are a handful of bytes.
 *
 * Returns `undefined` when the frame is not a strippable `message_update`, so
 * the caller can skip the extra stringify entirely rather than serialising a
 * frame identical to the one it already has.
 */
export function stripCumulativeContent(frame: unknown): string | undefined {
	if (!frame || typeof frame !== "object") return undefined;
	const f = frame as Record<string, unknown>;
	if (f.event !== "pi") return undefined;
	const payload = f.payload as Record<string, unknown> | undefined;
	const pi = payload?.event as
		| { type?: string; assistantMessageEvent?: unknown; message?: unknown }
		| undefined;
	if (!pi || pi.type !== "message_update") return undefined;
	if (pi.assistantMessageEvent === undefined || pi.message === undefined) return undefined;

	const msg = pi.message as Record<string, unknown>;
	const { content: _omitted, ...msgWithoutContent } = msg;
	return JSON.stringify({
		...f,
		payload: {
			...(payload as Record<string, unknown>),
			event: { ...(pi as Record<string, unknown>), message: msgWithoutContent },
		},
	});
}
