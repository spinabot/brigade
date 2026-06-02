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
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

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
	/**
	 * P1#8 (Wave H) — multi-listener set so `setHeartbeatFiredHook` /
	 * `addHeartbeatFiredHook` composes rather than overwrites. Older callers
	 * still get single-slot semantics (clearing on `null`); new wiring uses
	 * the disposer returned by `addHeartbeatFiredHook` to chain
	 * registrations (e.g. the agent-events bridge + the gateway's
	 * synthetic-turn dispatcher).
	 */
	firedHooks: Set<HeartbeatFiredHook>;
	/** Boot operator agentId — only this agent's `:main` session shares the global `CommandLane.Main` FIFO. */
	bootAgentId: string | null;
};

const HEARTBEAT_RUNNER_STATE_KEY = Symbol.for("brigade.heartbeatRunner.state");

function createState(): HeartbeatRunnerState {
	return {
		stopped: false,
		disposeWakeHandler: null,
		firedHooks: new Set(),
		bootAgentId: null,
	};
}

/**
 * Tell the runner which agentId owns the gateway's primary `Main` lane.
 * Pass `null` to clear (tests / shutdown). When unset the runner skips
 * the Main-lane gate entirely (per-session gate still applies).
 *
 * Wave L P2#12 — Brigade runs one gateway per process (the Main lane is a
 * process-wide singleton). Calling this twice with different IDs without
 * an intervening `null` clear would be a multi-gateway-in-one-process
 * shape this runner does not support; warn rather than silently overwrite
 * so the operator sees the misuse. To support that shape, convert
 * `bootAgentId` to a `Set<string>` and update the targetsBootMain check
 * to test membership.
 */
export function setHeartbeatBootAgentId(id: string | null): void {
	const trimmed = id?.trim() || null;
	const state = getState();
	if (
		trimmed !== null &&
		state.bootAgentId !== null &&
		state.bootAgentId !== trimmed
	) {
		log.warn("setHeartbeatBootAgentId double-set without clear", {
			previous: state.bootAgentId,
			next: trimmed,
		});
	}
	state.bootAgentId = trimmed;
}

function getState(): HeartbeatRunnerState {
	return resolveGlobalSingleton<HeartbeatRunnerState>(HEARTBEAT_RUNNER_STATE_KEY, createState);
}

function skipped(reason: string): HeartbeatRunResult {
	return { status: "skipped", reason };
}

/**
 * Add a `heartbeat-fired` hook. Called once per successful run with the
 * consumed events. Returns a disposer that removes ONLY this hook —
 * idempotent (calling twice is a no-op). Multiple hooks compose
 * (run sequentially per fire; one throwing does not block the others).
 *
 * Use this from anywhere that needs to react to a heartbeat: the
 * agent-events bridge, the gateway's synthetic-turn dispatcher, tests.
 */
export function addHeartbeatFiredHook(hook: HeartbeatFiredHook): () => void {
	const state = getState();
	state.firedHooks.add(hook);
	return () => {
		state.firedHooks.delete(hook);
	};
}

/**
 * Legacy single-slot setter. Pass a hook to ADD it (returns void, not a
 * disposer — call `addHeartbeatFiredHook` for that). Pass `null` to clear
 * every registered hook (used by tests + `resetAgentEventsForTests`).
 *
 * Prefer `addHeartbeatFiredHook` from new wiring so composition is opt-in.
 */
export function setHeartbeatFiredHook(hook: HeartbeatFiredHook | null): void {
	const state = getState();
	if (hook === null) {
		state.firedHooks.clear();
		return;
	}
	state.firedHooks.add(hook);
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

	// Per-session lane gate — an active turn for THIS session pre-empts the
	// heartbeat; the wake layer retries us in 1s. We no longer gate on the
	// global `Main` lane unconditionally because non-main sessions now run on
	// their own per-session lanes; a busy `Main` (operator typing) should
	// NOT block a heartbeat for a channel session that has its own queue.
	const sessionLaneKey = sessionLane(sessionKey);
	if (getLaneQueueSize(sessionLaneKey) > 0) {
		return skipped("requests-in-flight");
	}
	// Main-session heartbeats still need the global gate — those land on
	// `CommandLane.Main`, so an in-flight operator turn would race a
	// synthetic heartbeat turn on the same FIFO. Only the BOOT agent's
	// `:main` session shares the Main lane; other agents' `:main` sessions
	// route to per-session lanes and are NOT gated against Main here.
	//
	// Wave L P2#6 — unify on `parseAgentSessionKey` so the agentId-arm /
	// rest-arm match (the agentId-arm above already calls
	// `resolveAgentIdFromSessionKey` which round-trips through the parser).
	// Raw `split(":")` would return `cron` for `agent:<id>:cron:<job>:run:<runId>`
	// and miss the parser's lowercasing / segment normalisation.
	const restPart = parseAgentSessionKey(sessionKey)?.rest ?? "";
	const bootAgentId = state.bootAgentId;
	const targetsBootMain =
		restPart === "main" && bootAgentId !== null && agentId === bootAgentId;
	if (targetsBootMain && getLaneQueueSize(CommandLane.Main) > 0) {
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
		const params = {
			reason,
			agentId,
			sessionKey,
			consumedEvents: consumed,
		};
		// Fire every registered hook. Snapshot the set so a hook that adds /
		// removes hooks mid-fire doesn't perturb this run. Each hook is
		// awaited sequentially; a throwing hook is logged + skipped so one
		// bad listener doesn't drop events for the others.
		for (const hook of [...state.firedHooks]) {
			try {
				await hook(params);
			} catch (err) {
				log.warn("heartbeat-fired hook threw", {
					reason,
					sessionKey,
					error: (err as Error)?.message,
				});
			}
		}
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
	state.firedHooks.clear();
	state.bootAgentId = null;
}
