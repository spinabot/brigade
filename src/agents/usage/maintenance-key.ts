/**
 * Where an agent's BACKGROUND spend is booked.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade makes model calls that belong to no conversation: the memory
 * extraction sweep, memory consolidation, behaviour review, skill review and
 * skill consolidation, and the relationship relink. Each runs on its own
 * isolated session, so the main session's usage stream never sees it, and until
 * now none of it was recorded anywhere at all. An operator's total was
 * confidently short by every sweep the agent had ever run.
 *
 * The usage ledger is keyed `(agentId, sessionKey)`, which raises the question
 * these calls have no natural answer to: WHICH session? A consolidation sweep
 * distils across every session the agent has. Charging it to whichever thread
 * happened to be open would blame a conversation that did not cause it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ANSWER
 * ─────────────────────────────────────────────────────────────────────────
 * A reserved per-agent key. Agent-scoped background work is booked there, so:
 *
 *   • `usageLedger.agentTotals(agentId)` includes it — the agent's true cost.
 *   • A specific thread's header does NOT include it — that number stays an
 *     honest answer to "what did THIS conversation cost".
 *
 * The one exception is work a session demonstrably caused: the pre-compaction
 * extraction fires because a particular thread is compacting, so it bills that
 * thread. `sweepBillingKey` encodes exactly that rule.
 *
 * The `__` prefix keeps it out of collision with real thread names, which are
 * derived from user-supplied session names.
 */

/** Reserved session key for an agent's background/maintenance model calls. */
export function agentMaintenanceKey(agentId: string): string {
	return `agent:${agentId}:__maintenance`;
}

/** True for a key produced by `agentMaintenanceKey`. */
export function isMaintenanceKey(sessionKey: string): boolean {
	return sessionKey.endsWith(":__maintenance");
}

/**
 * Which ledger row a background call belongs to.
 *
 * `causedBySessionKey` is set only when a specific thread triggered the work —
 * today, the pre-compaction extraction sweep. Anything else is agent-scoped.
 *
 * A `sessionId` UUID is deliberately NOT accepted here: it is not a routing key,
 * and billing to one lands the spend on a row nothing displays. That mistake
 * has already lost compaction cost once.
 */
export function sweepBillingKey(agentId: string, causedBySessionKey?: string): string {
	if (causedBySessionKey && causedBySessionKey.startsWith(`agent:${agentId}:`)) {
		return causedBySessionKey;
	}
	return agentMaintenanceKey(agentId);
}
