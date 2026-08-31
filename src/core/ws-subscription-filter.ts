// Pure per-client subscription filter for the gateway WS broadcaster.
//
// Wave I closure: `connWantsFrame` inside `startServer` decides whether a
// connected client should receive a broadcast frame. It was inlined when
// Wave H landed but is now extracted so both the gateway and a focused
// unit test exercise the same predicate.
//
//   - Untagged frames (no agentId, no sessionId) broadcast to everyone —
//     state snapshots / generic errors keep working without a subscribe.
//   - Clients with no subscriptions get every frame — legacy single-agent
//     TUI clients are not penalised for omitting the subscribe handshake.
//   - Otherwise the subscribe narrows the view. Naming a SESSION on an agent
//     scopes that agent to that thread (plus its sub-agents); naming only an
//     agent still delivers everything for it. See `shouldDeliverFrame`.
//
// The agent/session precedence changed once, deliberately: it used to be a
// plain OR that tested agentId first, which meant a client bound to one thread
// received every session of that agent. See the rule list below.

export interface FrameTags {
	agentId?: string | undefined;
	sessionId?: string | undefined;
	/**
	 * For a sub-agent frame, the session that SPAWNED it.
	 *
	 * A child's session key is `agent:<childAgentId>:subagent:<uuid>` — built
	 * from the child's own agent, carrying no trace of its parent — so the
	 * descendant prefix rule below can never match it from the parent's session.
	 * Sub-agent output therefore used to reach the operator only via the much
	 * broader agentId rule, which is what dragged every OTHER session of that
	 * agent into their view too.
	 */
	parentSessionKey?: string | undefined;
}

/**
 * Pure predicate: does a client with these subs want this frame?
 *
 * Rules, in order:
 *
 *   1. A frame with no routing tags goes to everyone (state snapshots, generic
 *      errors) — a client need not subscribe to see those.
 *   2. A client with no subscriptions at all gets everything (back-compat for a
 *      legacy TUI that never sends the subscribe handshake).
 *   3. A sub-agent frame goes to whoever is watching the session that SPAWNED
 *      it. Checked before anything else, because a child's key shares no prefix
 *      with its parent's and no other rule can match it.
 *   4. If the client named a session ON THIS FRAME'S AGENT, that session
 *      subscription is authoritative: it sees that thread and its descendants,
 *      and nothing else from that agent.
 *   5. Otherwise the agent subscription applies — a client that asked for a
 *      whole agent, and never narrowed it, still gets the firehose.
 *
 * Rule 4 is the fix for cross-thread bleed. The predicate used to test the
 * agent rule FIRST, and the TUI subscribes to both its agentId and its
 * sessionId — so being bound to one thread delivered every frame from every
 * session of that agent, dragging other threads' web searches, sub-agents,
 * cron runs and channel traffic into the operator's view. Scoping the override
 * per-agent means a deliberately broad subscription on a DIFFERENT agent is
 * still honoured.
 */
/**
 * How broadly a connection wants frames for an agent it has named a session on.
 *
 *   • `"session"` — DEFAULT. Naming a session narrows delivery to that session
 *     (and its children). This is the cross-session-bleed fix: without it, one
 *     agent's other threads — cron runs, channel traffic, a second chat —
 *     poured into the operator's view.
 *
 *   • `"agent"` — the pre-narrowing breadth, for a client that names a session
 *     for some OTHER reason and still wants the agent's whole stream. Brigade's
 *     own desktop client is exactly that case: it sends
 *     `subscribe { agentId, sessionId }` because the snapshot push is gated on
 *     the session, not because it wants a narrower stream.
 *
 * An escape hatch rather than a version bump, matching how `deltas` is handled
 * and how the field solves this generally (LSP/DAP capabilities, Discord's
 * gateway intents). The FIX is the default, because the clients that never
 * update are precisely the ones that need the bleed fixed.
 */
export type SubscriptionScope = "session" | "agent";

export function shouldDeliverFrame(
	agentSubs: ReadonlySet<string> | undefined,
	sessionSubs: ReadonlySet<string> | undefined,
	tags: FrameTags,
	scope: SubscriptionScope = "session",
): boolean {
	const { agentId, sessionId, parentSessionKey } = tags;
	if (!agentId && !sessionId) return true;
	if (!agentSubs && !sessionSubs) return true;

	const inSessionSubs = (key: string | undefined): boolean => {
		if (!key || !sessionSubs) return false;
		for (const sub of sessionSubs) {
			// Exact match, or a descendant session under the same key.
			if (key === sub || key.startsWith(`${sub}:`)) return true;
		}
		return false;
	};

	// (3) A child of a thread I am watching is mine to see.
	if (inSessionSubs(parentSessionKey)) return true;

	// (4) Did I name a session on THIS frame's agent? If so, that is my scope.
	const narrowedForThisAgent =
		!!sessionSubs &&
		sessionSubs.size > 0 &&
		!!agentId &&
		[...sessionSubs].some((sub) => sub === agentId || sub.startsWith(`agent:${agentId}:`));

	// `scope: "agent"` opts out of the narrowing and falls through to rule 5.
	if (scope === "session" && narrowedForThisAgent && sessionId) return inSessionSubs(sessionId);

	// (5) Fall back to the broader subscriptions.
	if (agentId && agentSubs?.has(agentId)) return true;
	if (inSessionSubs(sessionId)) return true;
	return false;
}

/** Cheap discriminator: pulls optional agentId/sessionId off a payload. */
export function extractFrameTags(payload: unknown): FrameTags {
	const obj = payload as { agentId?: unknown; sessionId?: unknown; parentSessionKey?: unknown } | null;
	if (!obj || typeof obj !== "object") return {};
	const tags: FrameTags = {};
	if (typeof obj.agentId === "string") tags.agentId = obj.agentId;
	if (typeof obj.sessionId === "string") tags.sessionId = obj.sessionId;
	if (typeof obj.parentSessionKey === "string") tags.parentSessionKey = obj.parentSessionKey;
	return tags;
}
