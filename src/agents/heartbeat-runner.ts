/**
 * Heartbeat runner.
 *
 * Brand-scrubbed lift of upstream's `src/infra/heartbeat-runner.ts`, scoped
 * to what Brigade can DO at this milestone (the LLM-call path lands in
 * Step 18/25 — until then the runner only does the gating + inbox-drain
 * portion of the upstream flow).
 *
 * Pipeline per wake intent:
 *
 *   1. Honour the global enable flag (`areHeartbeatsEnabled()`).
 *   2. Resolve agent id + session key from the intent (or default).
 *   3. Gate on the GLOBAL `CommandLane.Main` lane — if the operator's
 *      primary turn is already pending, skip with `requests-in-flight`.
 *      The wake layer (Step 13) auto-retries this case.
 *   4. Gate on the PER-SESSION lane (`session:<sessionKey>`) — same
 *      contract; an active streaming turn for this session pre-empts
 *      the heartbeat.
 *   5. Peek the session inbox. If the wake reason is NOT `interval` AND
 *      there is nothing surface-able, skip with `no-pending-events`.
 *      Interval wakes proceed even with an empty inbox so the LLM can
 *      do periodic heartbeat work.
 *   6. Consume the inspected events from the inbox + emit a
 *      `heartbeat-fired` lifecycle hook. The actual LLM turn dispatch
 *      lands in Step 25; the runner publishes intent + drains, leaving
 *      the dispatcher to pick up the next step.
 *
 * Result contract (matches upstream `HeartbeatRunResult`):
 *   - `{ status: "ran", durationMs }`    → events consumed + handler fired
 *   - `{ status: "skipped", reason }`    → no-op (gate triggered)
 *   - `{ status: "failed", reason }`     → unexpected throw inside the runner
 *
 * What this module DOES NOT do (deferred to later steps):
 *
 *   - Does NOT call any LLM (Step 18/25 — Pi-kernel dispatch).
 *   - Does NOT format the events into a prompt block — Step 12's
 *     `drainFormattedSystemEvents` does that on the LLM side.
 *   - Does NOT resolve delivery target — Step 25's dispatcher does that
 *     from the inbox-derived `deliveryContext`.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CommandLane, getLaneQueueSize, sessionLane } from "../process/lanes.js";
import {
	areHeartbeatsEnabled,
	setHeartbeatWakeHandler,
	type HeartbeatRunResult,
	type HeartbeatWakeHandler,
	type HeartbeatWakeOptions,
} from "./heartbeat-wake.js";
import {
	consumeSystemEventEntries,
	peekSystemEventEntries,
	type SystemEvent,
} from "./session-inbox.js";
import { inspectPendingSessionEvents } from "./session-event-prompt.js";
import { hasLiveSession } from "./session-registry.js";
import { resolveAgentIdFromSessionKey } from "./routing/session-key.js";

const log = createSubsystemLogger("agents/heartbeat-runner");

export type HeartbeatFiredHook = (params: {
	reason: string;
	agentId: string;
	sessionKey: string;
	consumedEvents: SystemEvent[];
}) => Promise<void> | void;

type HeartbeatRunnerState = {
	stopped: boolean;
	disposeWakeHandler: (() => void) | null;
	firedHook: HeartbeatFiredHook | null;
};

const HEARTBEAT_RUNNER_STATE_KEY = Symbol.for("brigade.heartbeatRunner.state");

function createState(): HeartbeatRunnerState {
	return { stopped: false, disposeWakeHandler: null, firedHook: null };
}

function getState(): HeartbeatRunnerState {
	return resolveGlobalSingleton<HeartbeatRunnerState>(HEARTBEAT_RUNNER_STATE_KEY, createState);
}

function skipped(reason: string): HeartbeatRunResult {
	return { status: "skipped", reason };
}

/**
 * Install a `heartbeat-fired` hook. Called once per successful run with
 * the consumed events. Use this to drive Step 25's dispatcher
 * (enqueue an LLM turn payload) without coupling the runner to the
 * dispatcher implementation directly.
 *
 * Pass `null` to clear. Only one hook at a time; setting a new hook
 * replaces the previous one (no fan-out at this layer).
 */
export function setHeartbeatFiredHook(hook: HeartbeatFiredHook | null): void {
	getState().firedHook = hook;
}

/**
 * Process a single wake intent through the gate pipeline. Caller-side
 * code paths: invoked by the wake handler installed in
 * `startHeartbeatRunner`, plus directly by tests that want to inject a
 * synthetic intent.
 */
export async function processHeartbeatWakeIntent(
	intent: HeartbeatWakeOptions,
): Promise<HeartbeatRunResult> {
	const startedAt = Date.now();
	const state = getState();
	if (state.stopped) return skipped("disabled");
	if (!areHeartbeatsEnabled()) return skipped("disabled");

	const reason = (intent.reason ?? "wake").trim() || "wake";
	const sessionKey = (intent.sessionKey ?? "").trim();
	if (!sessionKey) return skipped("no-session");

	const agentId =
		(intent.agentId ?? "").trim() || resolveAgentIdFromSessionKey(sessionKey);

	// Global main-lane gate — operator's primary turn pre-empts any
	// heartbeat run. The wake layer retries us in 1s.
	if (getLaneQueueSize(CommandLane.Main) > 0) {
		return skipped("requests-in-flight");
	}

	// Per-session lane gate — an active streaming turn for THIS session
	// also pre-empts. Same retry behaviour.
	const sessionLaneKey = sessionLane(sessionKey);
	if (getLaneQueueSize(sessionLaneKey) > 0) {
		return skipped("requests-in-flight");
	}

	// Live-session gate — if the session is registered and currently in
	// the running state (real turn dispatched but lane is between
	// queue-pop and stream-start), skip too.
	if (hasLiveSession(sessionKey)) {
		const inspect = peekSystemEventEntries(sessionKey);
		if (inspect.length === 0) {
			return skipped("session-busy");
		}
		// If events are queued the live turn will drain them anyway; still
		// skip to avoid duplicate consumption.
		return skipped("session-busy");
	}

	// Audit 11 — lazy inbox consumption. We INSPECT (non-destructive peek
	// via `peekSystemEventEntries` under the hood) until every gate has
	// passed. Skip branches above return without ever calling
	// `consumeSystemEventEntries`, so a gated wake leaves the inbox intact
	// for the next attempt — no events lost when the runner can't yet
	// surface them.
	const inspection = inspectPendingSessionEvents(sessionKey);
	const isIntervalReason = reason === "interval";
	if (!isIntervalReason && !inspection.hasSurfaceable) {
		return skipped("no-pending-events");
	}

	try {
		// Only NOW do we drain. Atomically remove the inspected prefix from
		// the inbox. Anything that arrived AFTER `inspectPendingSystemEvents`
		// stays queued for the next drain. Returns the actual list consumed
		// so the hook can surface them downstream.
		const consumed = consumeSystemEventEntries(sessionKey, inspection.events);
		await state.firedHook?.({
			reason,
			agentId,
			sessionKey,
			consumedEvents: consumed,
		});
		return { status: "ran", durationMs: Date.now() - startedAt };
	} catch (err) {
		const message = (err as Error)?.message ?? String(err);
		log.error("heartbeat runner failed", { reason, sessionKey, error: message });
		return { status: "failed", reason: message };
	}
}

export interface HeartbeatRunnerHandle {
	stop: () => void;
}

/**
 * Start the heartbeat runner: registers `processHeartbeatWakeIntent` as
 * the wake handler with Step 13. Returns a handle whose `stop()` clears
 * the registration + marks the runner stopped (subsequent intents
 * short-circuit to `skipped("disabled")` until a new runner starts).
 */
export function startHeartbeatRunner(): HeartbeatRunnerHandle {
	const state = getState();
	// Two starts in a row → tear the first registration down first.
	if (state.disposeWakeHandler) {
		state.disposeWakeHandler();
		state.disposeWakeHandler = null;
	}
	state.stopped = false;
	const handler: HeartbeatWakeHandler = async (params) =>
		processHeartbeatWakeIntent(params);
	const dispose = setHeartbeatWakeHandler(handler);
	state.disposeWakeHandler = dispose;
	return {
		stop: () => {
			if (state.stopped) return;
			state.stopped = true;
			state.disposeWakeHandler?.();
			state.disposeWakeHandler = null;
		},
	};
}

/** Test-only — clear the runner state without unregistering anything. */
export function resetHeartbeatRunnerStateForTests(): void {
	const state = getState();
	state.stopped = false;
	state.disposeWakeHandler = null;
	state.firedHook = null;
}
