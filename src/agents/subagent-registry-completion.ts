/**
 * Sub-agent completion helpers.
 *
 * Pure helpers (`runOutcomesEqual`, `resolveLifecycleOutcomeFromRunOutcome`)
 * + the idempotent hook-emission gate (`emitSubagentEndedHookOnce`).
 *
 * Brand-scrubbed lift of upstream's `src/agents/subagent-registry-completion.ts`.
 *
 * Brigade does not yet have a generic hook-runner module — Step 18 (agent
 * events + gateway-call factory) lands that. Until then, the emit gate
 * funnels through `getSubagentEndedHook()`, which is `null` by default
 * and is swappable by callers via `setSubagentEndedHook(handler)`. This
 * preserves the upstream idempotency contract (`endedHookEmittedAt` set
 * exactly once per run) without forcing the hook-bus lift early.
 */

import {
	SUBAGENT_ENDED_OUTCOME_ERROR,
	SUBAGENT_ENDED_OUTCOME_OK,
	SUBAGENT_ENDED_OUTCOME_TIMEOUT,
	SUBAGENT_TARGET_KIND_SUBAGENT,
	type SubagentLifecycleEndedOutcome,
	type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunOutcome, SubagentRunRecord } from "./subagent-registry.types.js";

export function runOutcomesEqual(
	a: SubagentRunOutcome | undefined,
	b: SubagentRunOutcome | undefined,
): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.status !== b.status) return false;
	if (a.status === "error" && b.status === "error") {
		return (a.error ?? "") === (b.error ?? "");
	}
	return true;
}

export function resolveLifecycleOutcomeFromRunOutcome(
	outcome: SubagentRunOutcome | undefined,
): SubagentLifecycleEndedOutcome {
	if (outcome?.status === "error") return SUBAGENT_ENDED_OUTCOME_ERROR;
	if (outcome?.status === "timeout") return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
	return SUBAGENT_ENDED_OUTCOME_OK;
}

/**
 * Hook handler signature — receives the lifecycle-ended payload + the
 * minimal source-context the registry threads from the SubagentRunRecord.
 */
export type SubagentEndedHookPayload = {
	targetSessionKey: string;
	targetKind: typeof SUBAGENT_TARGET_KIND_SUBAGENT;
	reason: SubagentLifecycleEndedReason;
	sendFarewell?: boolean;
	accountId?: string;
	runId: string;
	endedAt?: number;
	outcome?: SubagentLifecycleEndedOutcome;
	error?: string;
};

export type SubagentEndedHookSource = {
	runId: string;
	childSessionKey: string;
	requesterSessionKey: string;
};

export type SubagentEndedHookHandler = (
	payload: SubagentEndedHookPayload,
	source: SubagentEndedHookSource,
) => Promise<void> | void;

/**
 * P1#8 (Wave H) — multi-listener set so `setSubagentEndedHook` composes
 * with `addSubagentEndedHook` rather than overwriting. Older callers that
 * still use the single-slot setter clear the set on `null` (test reset)
 * and add otherwise.
 */
const subagentEndedHooks = new Set<SubagentEndedHookHandler>();

/**
 * Add a sub-agent ended hook. Returns a disposer that removes ONLY this
 * hook — idempotent (calling twice is a no-op). Multiple hooks compose
 * (run sequentially per fire; a thrown hook is swallowed so other hooks
 * still see the event).
 */
export function addSubagentEndedHook(handler: SubagentEndedHookHandler): () => void {
	subagentEndedHooks.add(handler);
	return () => {
		subagentEndedHooks.delete(handler);
	};
}

/**
 * Legacy single-slot setter. Pass a handler to ADD it; pass `null` to
 * clear EVERY registered hook (used by tests + `resetAgentEventsForTests`).
 *
 * Prefer `addSubagentEndedHook` from new wiring so composition is opt-in.
 */
export function setSubagentEndedHook(handler: SubagentEndedHookHandler | null): void {
	if (handler === null) {
		subagentEndedHooks.clear();
		return;
	}
	subagentEndedHooks.add(handler);
}

/** Read the registered handlers — primarily for tests. */
export function getSubagentEndedHooks(): SubagentEndedHookHandler[] {
	return [...subagentEndedHooks];
}

/** Back-compat shim — returns the first registered hook (or null). */
export function getSubagentEndedHook(): SubagentEndedHookHandler | null {
	return subagentEndedHooks.values().next().value ?? null;
}

export async function emitSubagentEndedHookOnce(params: {
	entry: SubagentRunRecord;
	reason: SubagentLifecycleEndedReason;
	sendFarewell?: boolean;
	accountId?: string;
	outcome?: SubagentLifecycleEndedOutcome;
	error?: string;
	inFlightRunIds: Set<string>;
	persist: () => void;
}): Promise<boolean> {
	const runId = params.entry.runId.trim();
	if (!runId) return false;
	if (params.entry.endedHookEmittedAt) return false;
	if (params.inFlightRunIds.has(runId)) return false;

	params.inFlightRunIds.add(runId);
	try {
		const handlers = [...subagentEndedHooks];
		if (handlers.length === 0) {
			// No hook installed yet (pre-Step 18): treat the registry-side
			// idempotency stamp as the contract surface, but skip the emit.
			params.entry.endedHookEmittedAt = Date.now();
			params.persist();
			return true;
		}
		const payload: SubagentEndedHookPayload = {
			targetSessionKey: params.entry.childSessionKey,
			targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
			reason: params.reason,
			sendFarewell: params.sendFarewell,
			accountId: params.accountId,
			runId: params.entry.runId,
			endedAt: params.entry.endedAt,
			outcome: params.outcome,
			error: params.error,
		};
		const source: SubagentEndedHookSource = {
			runId: params.entry.runId,
			childSessionKey: params.entry.childSessionKey,
			requesterSessionKey: params.entry.requesterSessionKey,
		};
		// Fire every registered hook sequentially. One throwing must not
		// block the others (and must not flip the idempotency stamp off).
		for (const handler of handlers) {
			try {
				await handler(payload, source);
			} catch {
				// best-effort — handlers log internally if they care
			}
		}
		params.entry.endedHookEmittedAt = Date.now();
		params.persist();
		return true;
	} finally {
		params.inFlightRunIds.delete(runId);
	}
}
