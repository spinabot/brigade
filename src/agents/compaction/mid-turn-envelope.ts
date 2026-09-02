/**
 * The bus envelope for a synthetic mid-turn compaction frame.
 *
 * Extracted from `agent-loop.ts` for one reason: while it was an inline object
 * literal it could not be tested, and it shipped with the wrong session
 * identifier — which silently deleted the feature's entire user-visible half.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS SHAPE ENCODES
 * ─────────────────────────────────────────────────────────────────────────
 * The frame was tagged `sessionId: resolved.sessionId`, a `randomUUID()`. The
 * ROUTING key is `agent:<id>:<thread>` — what `attachTurnSession` puts in this
 * field for every ordinary Pi frame, what the TUI binds its subscription to,
 * and what the gateway's filter matches on.
 *
 * Pi's own frames reach the bus carrying the UUID and survive only because a
 * sub-agent frame is rescued by `parentSessionKey`. A depth-0 synthetic frame
 * has no parent to rescue it, so the gateway dropped it, the client dropped it
 * again, and the "compacting…" notice never rendered — leaving exactly the
 * unexplained two-minute stall the feature exists to remove. The same UUID also
 * billed the summarization to an unparseable key, landing a real cost on a
 * ledger row nobody reads.
 */

export interface MidTurnEnvelopeArgs {
	runId: string;
	agentId: string;
	/** The ROUTING key (`agent:<id>:<thread>`) — never the transcript UUID. */
	sessionKey: string;
	/** Set only for a sub-agent turn, so its frames route to the parent thread. */
	parentSessionKey?: string;
	/** > 0 inside a sub-agent, so the TUI can indent it. */
	subagentDepth?: number;
	piEvent: unknown;
}

export interface MidTurnEnvelope {
	type: "pi";
	runId: string;
	agentId: string;
	sessionId: string;
	parentSessionKey?: string;
	subagentDepth?: number;
	piEvent: unknown;
	synthetic: true;
}

export function buildMidTurnEnvelope(args: MidTurnEnvelopeArgs): MidTurnEnvelope {
	return {
		type: "pi",
		runId: args.runId,
		agentId: args.agentId,
		sessionId: args.sessionKey,
		...(args.parentSessionKey ? { parentSessionKey: args.parentSessionKey } : {}),
		...(args.subagentDepth && args.subagentDepth > 0
			? { subagentDepth: args.subagentDepth }
			: {}),
		piEvent: args.piEvent,
		// SYNTHETIC — Brigade minted this, Pi never emitted it. Two consequences,
		// both wanted:
		//
		//   1. The gateway's depth-0 fast path is `attachTurnSession`'s direct
		//      subscribe to the PI session, which by definition never sees an
		//      event Pi did not emit. The sub-agent bus forwarder skips depth-0
		//      frames to avoid duplicating that path — EXCEPT synthetic ones.
		//      Without this flag a top-level mid-turn compaction would fall
		//      between the two paths and vanish.
		//   2. Synthetic frames are excluded from the seq'd replay stream. A
		//      `resume` cannot re-deliver them, and correctly so: "compacting…"
		//      is live status, not transcript, and replaying it would create a
		//      seq gap for a message that no longer means anything.
		synthetic: true,
	};
}
