// Pure per-connection state-snapshot fan-out planner for the gateway.
//
// A `state` snapshot used to be built once and broadcast to everyone, because
// everything in it was per-AGENT. Per-session model pins broke that assumption:
// a pinned thread runs a different model from its agent, so two TUIs bound to
// the same agent but different threads legitimately need different snapshots.
//
// This module decides WHICH snapshots one connection should receive, given the
// subscriptions it holds. It is extracted from `startServer` for the same
// reason `shouldDeliverFrame` is — so the behaviour is exercised by a focused
// unit test instead of a live WS server.
//
// Agent fan-out is preserved exactly as it was before pins existed: one
// snapshot per subscribed agent, and the boot-agent snapshot for a client that
// never subscribed. The session is layered on top only where it is unambiguous.

/** One snapshot to build and send: the agent it describes, and the thread. */
export interface StateFanoutTarget {
	/** undefined = the gateway's boot agent (legacy un-subscribed client). */
	agentId: string | undefined;
	/** undefined = that agent's default session (no unambiguous thread). */
	sessionKey: string | undefined;
}

export interface StateFanoutInput {
	/** Agents this connection subscribed to. */
	agentSubs: ReadonlySet<string> | undefined;
	/** Sessions this connection subscribed to. */
	sessionSubs: ReadonlySet<string> | undefined;
	/** The gateway's boot agent id — the owner for the un-subscribed case. */
	bootAgentId: string;
	/**
	 * Which agent a session key belongs to, or undefined when the key isn't
	 * canonical. Injected so this stays pure (the caller passes
	 * `parseAgentSessionKey`).
	 */
	ownerOf: (sessionKey: string) => string | undefined;
}

/**
 * Plan the state frames for one connection.
 *
 * The session binding is only applied to a snapshot whose agent OWNS that
 * session. Carrying agent A's thread into agent B's snapshot would read B's
 * store for A's key and report a pin that doesn't apply there.
 */
export function planStateFanout(input: StateFanoutInput): StateFanoutTarget[] {
	const { agentSubs, sessionSubs, bootAgentId, ownerOf } = input;
	// The TUI holds exactly ONE session binding at a time — it unsubscribes the
	// previous thread before subscribing the next — so a single entry identifies
	// the thread this connection is looking at. Any other count is ambiguous
	// (zero = never bound, more than one = a multiplexing client), and we fall
	// back to agent-level snapshots rather than guessing which thread is meant.
	const boundSession = sessionSubs && sessionSubs.size === 1 ? [...sessionSubs][0] : undefined;
	const sessionIfOwnedBy = (ownerAgentId: string): string | undefined => {
		if (!boundSession) return undefined;
		return ownerOf(boundSession) === ownerAgentId ? boundSession : undefined;
	};

	if (!agentSubs || agentSubs.size === 0) {
		// Legacy / un-subscribed client: the boot-agent snapshot, exactly as
		// before. It can still carry a thread if the client subscribed to one
		// without naming an agent.
		return [{ agentId: undefined, sessionKey: sessionIfOwnedBy(bootAgentId) }];
	}
	return [...agentSubs].map((id) => ({ agentId: id, sessionKey: sessionIfOwnedBy(id) }));
}
