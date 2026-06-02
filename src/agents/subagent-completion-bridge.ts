/**
 * Sub-agent completion bridge.
 *
 * Closes the loop that the audit caught: Step 10's `markSubagentRunCompleted`
 * was exported but never called. Without this listener, every sub-agent
 * spawn left a permanent in-memory registry entry until process restart —
 * registry leak under normal usage.
 *
 * Wiring:
 *
 *   1. Subscribes to the unified agent-events bus (Step 18).
 *   2. Watches `lifecycle` stream events with `phase: "end"`.
 *   3. Looks up the sub-agent run by `runId` via Step 10's registry.
 *   4. Calls `markSubagentRunCompleted({runId, outcome, reason, …})` so the
 *      registry stamps `endedAt` + fires the (idempotent) `subagent_ended`
 *      hook — Step 18's bridge then emits a `subagent_lifecycle` event
 *      for downstream listeners.
 *   5. Enqueues a completion announce into the PARENT session's inbox
 *      (`session-inbox.ts:enqueueSystemEvent`) so the parent's next turn
 *      sees "your sub-agent <label> completed: …" — fills the producer
 *      gap Audit 11 flagged.
 *
 * Cleanly idempotent: `markSubagentRunCompleted` short-circuits when
 * the entry already has `endedAt`, and `emitSubagentEndedHookOnce` (used
 * inside) double-gates with `endedHookEmittedAt`. Two `phase: "end"`
 * events for the same runId — possible during a retry storm — both
 * resolve to a single completion stamp.
 *
 * Boot wiring: `installSubagentCompletionBridge()` returns a disposer.
 * `agents/agent-events.ts:wireAgentEventsBridge()` installs this bridge
 * alongside the sub-agent ended hook + heartbeat hook + session-state
 * listener so all four flow from one call at gateway boot.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { onAgentEvent } from "./agent-events.js";
import { enqueueSystemEvent } from "./session-inbox.js";
import {
	getSubagentRun,
	markSubagentRunCompleted,
} from "./subagent-registry.js";
import {
	SUBAGENT_ENDED_OUTCOME_ERROR,
	SUBAGENT_ENDED_OUTCOME_OK,
	SUBAGENT_ENDED_OUTCOME_TIMEOUT,
	type SubagentLifecycleEndedOutcome,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunOutcome } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-completion-bridge");

type BridgeState = {
	disposeListener: (() => void) | null;
};

const BRIDGE_STATE_KEY = Symbol.for("brigade.subagentCompletionBridge.state");

function getState(): BridgeState {
	return resolveGlobalSingleton<BridgeState>(BRIDGE_STATE_KEY, () => ({
		disposeListener: null,
	}));
}

function deriveOutcomes(data: Record<string, unknown>): {
	runOutcome: SubagentRunOutcome;
	lifecycleOutcome: SubagentLifecycleEndedOutcome;
	error?: string;
	reason: string;
} {
	const ok = data.ok;
	const error = typeof data.error === "string" ? data.error : undefined;
	const timedOut = data.timedOut === true || data.reason === "timeout";
	if (timedOut) {
		return {
			runOutcome: { status: "timeout" },
			lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_TIMEOUT,
			reason: "timeout",
			...(error ? { error } : {}),
		};
	}
	if (ok === false || error) {
		return {
			runOutcome: { status: "error", error: error ?? "unknown error" },
			lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_ERROR,
			reason: "error",
			error: error ?? "unknown error",
		};
	}
	return {
		runOutcome: { status: "ok" },
		lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_OK,
		reason: "complete",
	};
}

function formatAnnounceText(params: {
	label?: string;
	outcome: SubagentLifecycleEndedOutcome;
	error?: string;
}): string {
	const tag = params.label?.trim() ? ` "${params.label.trim()}"` : "";
	if (params.outcome === SUBAGENT_ENDED_OUTCOME_OK) {
		return `Sub-agent${tag} completed successfully.`;
	}
	if (params.outcome === SUBAGENT_ENDED_OUTCOME_TIMEOUT) {
		return `Sub-agent${tag} timed out.`;
	}
	const detail = params.error?.trim() ? `: ${params.error.trim()}` : "";
	return `Sub-agent${tag} failed${detail}`;
}

/**
 * Install the bridge. Returns a disposer that unsubscribes from the
 * agent-events bus. Idempotent — re-installing replaces the previous
 * listener.
 */
export function installSubagentCompletionBridge(): () => void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}

	const dispose = onAgentEvent((event) => {
		if (event.stream !== "lifecycle") return;
		const data = event.data ?? {};
		if ((data as { phase?: unknown }).phase !== "end") return;
		const runId = event.runId?.trim();
		if (!runId) return;
		const entry = getSubagentRun(runId);
		if (!entry) return;
		// Already stamped — Step 10's `markSubagentRunCompleted` is
		// idempotent, but skipping the call avoids needless work + log noise.
		if (entry.endedAt) return;

		const { runOutcome, lifecycleOutcome, error, reason } = deriveOutcomes(
			data as Record<string, unknown>,
		);

		void (async () => {
			try {
				await markSubagentRunCompleted({
					runId,
					outcome: runOutcome,
					reason,
					lifecycleOutcome,
					...(error ? { error } : {}),
				});
			} catch (err) {
				log.warn("markSubagentRunCompleted threw", {
					runId,
					error: (err as Error)?.message,
				});
			}

			// Audit 11 producer gap: when a sub-agent completes, the parent
			// session needs a wake signal so its next turn (TUI prompt, channel
			// inbound, or interval heartbeat) drains the completion announce
			// and the model sees "child X finished — here's the result". Without
			// this, the parent has no in-band visibility into child lifecycle.
			const parentSessionKey =
				entry.requesterSessionKey?.trim() || entry.controllerSessionKey?.trim();
			if (!parentSessionKey || parentSessionKey === "main") {
				// Parent is the operator's main session or unknown — nothing to
				// enqueue (the TUI sees lifecycle events directly via Step 18's
				// agent-events stream, no inbox needed).
				return;
			}
			try {
				const text = formatAnnounceText({
					label: entry.label,
					outcome: lifecycleOutcome,
					error,
				});
				enqueueSystemEvent(text, {
					sessionKey: parentSessionKey,
					contextKey: `subagent:ended:${runId}`,
					trusted: true,
				});
			} catch (err) {
				log.warn("subagent completion announce enqueue failed", {
					runId,
					parentSessionKey,
					error: (err as Error)?.message,
				});
			}
		})();
	});

	state.disposeListener = dispose;
	return () => {
		const current = getState();
		if (current.disposeListener === dispose) {
			dispose();
			current.disposeListener = null;
		} else {
			dispose();
		}
	};
}

/** Test-only — clear bridge state. */
export function resetSubagentCompletionBridgeForTests(): void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}
}
