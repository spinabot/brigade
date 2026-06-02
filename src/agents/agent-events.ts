/**
 * Agent-events bus (Step 18).
 *
 * Brand-scrubbed analogue of upstream's `src/infra/agent-events.ts`. One
 * process-wide singleton (via `resolveGlobalSingleton`) carrying:
 *
 *   - `seqByRun`        — monotonic counter per `runId`
 *   - `listeners`       — set of subscriber callbacks
 *   - `runContextById`  — per-run metadata for sessionKey enrichment
 *
 * Synchronous dispatch: `emitAgentEvent` walks every listener inline; a
 * throwing listener is logged and skipped, others still fire. Async
 * consumers should `setImmediate` inside their listener body — the bus
 * does NOT defer.
 *
 * Brigade wires the existing per-subsystem injection points (Step 10's
 * `setSubagentEndedHook`, Step 14's `setHeartbeatFiredHook`, Step 11's
 * `onSessionStateChange`) into this bus via `wireAgentEventsBridge()`.
 * Each producer emits its specific event variant; consumers
 * (control-UI WebSocket, hook handlers, channel announcers) subscribe
 * once and filter by `stream`.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
	addSubagentEndedHook,
	type SubagentEndedHookPayload,
	type SubagentEndedHookSource,
} from "./subagent-registry-completion.js";
import { addHeartbeatFiredHook } from "./heartbeat-runner.js";
import { onSessionStateChange } from "./session-registry.js";
import { installSubagentCompletionBridge } from "./subagent-completion-bridge.js";
import type {
	AgentEventPayload,
	AgentEventStream,
	AgentRunContext,
} from "./agent-events.types.js";

const log = createSubsystemLogger("agents/agent-events");

type AgentEventState = {
	seqByRun: Map<string, number>;
	listeners: Set<(evt: AgentEventPayload) => void>;
	runContextById: Map<string, AgentRunContext>;
	bridgeInstalled: boolean;
	disposeBridge: (() => void) | null;
};

const AGENT_EVENTS_STATE_KEY = Symbol.for("brigade.agentEvents.state");

function createState(): AgentEventState {
	return {
		seqByRun: new Map(),
		listeners: new Set(),
		runContextById: new Map(),
		bridgeInstalled: false,
		disposeBridge: null,
	};
}

function getState(): AgentEventState {
	return resolveGlobalSingleton<AgentEventState>(AGENT_EVENTS_STATE_KEY, createState);
}

function notifyListeners(state: AgentEventState, payload: AgentEventPayload): void {
	for (const listener of state.listeners) {
		try {
			listener(payload);
		} catch (err) {
			log.warn("agent-event listener threw", {
				runId: payload.runId,
				stream: payload.stream,
				error: (err as Error)?.message,
			});
		}
	}
}

/**
 * Register or update per-run metadata. Subsequent calls merge fields
 * onto the existing entry — newer non-undefined values win. The metadata
 * is used by `emitAgentEvent` to enrich payloads with the run's session
 * key (when `isControlUiVisible !== false`).
 */
export function registerAgentRunContext(runId: string, context: AgentRunContext): void {
	if (!runId) return;
	const state = getState();
	const existing = state.runContextById.get(runId);
	if (!existing) {
		state.runContextById.set(runId, {
			...context,
			registeredAt: context.registeredAt ?? Date.now(),
		});
		return;
	}
	if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
		existing.sessionKey = context.sessionKey;
	}
	if (context.isControlUiVisible !== undefined) {
		existing.isControlUiVisible = context.isControlUiVisible;
	}
	if (context.isHeartbeat !== undefined) {
		existing.isHeartbeat = context.isHeartbeat;
	}
}

/** Read the per-run context (or `undefined` if the run isn't registered). */
export function getAgentRunContext(runId: string): AgentRunContext | undefined {
	return getState().runContextById.get(runId);
}

/** Remove the per-run context + reset its seq counter. Called on turn-end. */
export function clearAgentRunContext(runId: string): void {
	const state = getState();
	state.runContextById.delete(runId);
	state.seqByRun.delete(runId);
}

/**
 * Sweep stale run contexts that exceeded `maxAgeMs`. Guards against orphaned
 * entries when a turn crashes between `registerAgentRunContext` and
 * `clearAgentRunContext` (the finally block in `agent-dispatcher.ts` is the
 * only authoritative clearer; long-running heartbeat / sub-agent runs can
 * outlive a gateway hot-reload and never get cleared).
 *
 * Uses `lastActiveAt` (refreshed on every `emitAgentEvent`) as the freshness
 * signal so an actively-emitting run stays in the map. Falls back to
 * `registeredAt`, then treats missing timestamps as infinitely old.
 *
 * Returns the number of contexts swept. Called on a 60s interval inside
 * `wireAgentEventsBridge` (see Wave H P2#2).
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
	const state = getState();
	const now = Date.now();
	let swept = 0;
	for (const [runId, ctx] of state.runContextById) {
		const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
		const age = lastSeen ? now - lastSeen : Number.POSITIVE_INFINITY;
		if (age > maxAgeMs) {
			state.runContextById.delete(runId);
			state.seqByRun.delete(runId);
			swept++;
		}
	}
	return swept;
}

/**
 * Emit an agent event. The bus stamps `seq` + `ts` and fans out to every
 * listener synchronously. Returns the enriched payload (handy for tests
 * + tracing).
 */
export function emitAgentEvent(
	event: Omit<AgentEventPayload, "seq" | "ts">,
): AgentEventPayload {
	const state = getState();
	const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
	state.seqByRun.set(event.runId, nextSeq);
	const context = state.runContextById.get(event.runId);
	if (context) context.lastActiveAt = Date.now();
	const isControlUiVisible = context?.isControlUiVisible ?? true;
	const eventSessionKey =
		typeof event.sessionKey === "string" && event.sessionKey.trim()
			? event.sessionKey
			: undefined;
	const sessionKey = isControlUiVisible ? eventSessionKey ?? context?.sessionKey : undefined;
	const enriched: AgentEventPayload = {
		...event,
		...(sessionKey ? { sessionKey } : {}),
		seq: nextSeq,
		ts: Date.now(),
	};
	notifyListeners(state, enriched);
	return enriched;
}

/**
 * Subscribe to every emitted event. Returns a disposer; calling it
 * removes the listener (idempotent — calling twice is a no-op).
 *
 * Listeners that throw are logged + skipped; one bad subscriber must not
 * crash the bus.
 */
export function onAgentEvent(listener: (event: AgentEventPayload) => void): () => void {
	const state = getState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}

/**
 * Filter helper: subscribe only to events matching one or more streams.
 * Convenience wrapper around `onAgentEvent`.
 */
export function onAgentEventByStream(
	streams: AgentEventStream | AgentEventStream[],
	listener: (event: AgentEventPayload) => void,
): () => void {
	const allowed = new Set(Array.isArray(streams) ? streams : [streams]);
	return onAgentEvent((event) => {
		if (allowed.has(event.stream)) listener(event);
	});
}

/**
 * Install bridges from the per-subsystem injection points to the unified
 * event bus. Calls into:
 *
 *   - `setSubagentEndedHook(handler)`   — emits `subagent_lifecycle` events
 *   - `setHeartbeatFiredHook(handler)`  — emits `heartbeat` events
 *   - `onSessionStateChange(listener)`  — emits `session_lifecycle` events
 *
 * Idempotent — calling twice on the same process is a no-op. Returns a
 * disposer that unwires all three bridges (for tests + graceful
 * shutdown).
 */
export function wireAgentEventsBridge(): () => void {
	const state = getState();
	if (state.bridgeInstalled && state.disposeBridge) {
		return state.disposeBridge;
	}

	// P1#8 (Wave H) — use `add*Hook` so this bridge composes with the
	// gateway's later registrations (`setHeartbeatFiredHook` in server.ts
	// previously REPLACED us; the multi-listener Set now lets both fire).
	const disposeSubagentEndedHook = addSubagentEndedHook(
		(payload: SubagentEndedHookPayload, source: SubagentEndedHookSource) => {
			emitAgentEvent({
				runId: source.runId,
				stream: "subagent_lifecycle",
				data: {
					kind: "subagent_ended",
					childSessionKey: source.childSessionKey,
					requesterSessionKey: source.requesterSessionKey,
					runId: source.runId,
					reason: payload.reason,
					outcome: payload.outcome,
					error: payload.error,
				},
				...(source.requesterSessionKey ? { sessionKey: source.requesterSessionKey } : {}),
			});
		},
	);

	const disposeHeartbeatHook = addHeartbeatFiredHook((params) => {
		emitAgentEvent({
			runId: `heartbeat:${params.agentId}:${params.sessionKey}`,
			stream: "heartbeat",
			sessionKey: params.sessionKey,
			data: {
				kind: "heartbeat_fired",
				reason: params.reason,
				agentId: params.agentId,
				sessionKey: params.sessionKey,
				consumedEventCount: params.consumedEvents.length,
			},
		});
	});

	const disposeSessionListener = onSessionStateChange((event) => {
		emitAgentEvent({
			runId: `session:${event.sessionKey}`,
			stream: "session_lifecycle",
			sessionKey: event.sessionKey,
			data: {
				kind:
					event.newState === "terminated"
						? "session_unregistered"
						: event.previousState === "registered"
							? "session_registered"
							: "session_state_changed",
				sessionKey: event.sessionKey,
				previousState: event.previousState,
				newState: event.newState,
			},
		});
	});

	// Sub-agent completion bridge — closes the loop where Step 10's
	// `markSubagentRunCompleted` was never called. Listens for
	// `lifecycle:phase:end` events from sub-agent runs, stamps the
	// registry entry as ended (firing the hook above as a side-effect),
	// and enqueues a completion announce into the parent's inbox.
	const disposeSubagentCompletion = installSubagentCompletionBridge();

	// P2#2 (Wave H) — 60s sweeper. Without this, the `runContextById` map
	// grows forever when a turn registers a context and crashes / hot-
	// reloads before `clearAgentRunContext` runs. A 30-minute TTL keeps
	// every active turn alive (`lastActiveAt` refreshes on every emit)
	// while orphans get GC'd. Unref the timer so it never blocks process
	// exit.
	const sweeperTimer = setInterval(() => {
		try {
			const swept = sweepStaleRunContexts();
			if (swept > 0) {
				log.debug("swept stale run contexts", { count: swept });
			}
		} catch (err) {
			log.warn("run-context sweeper threw", { error: (err as Error)?.message });
		}
	}, 60_000);
	if (typeof sweeperTimer.unref === "function") sweeperTimer.unref();

	const dispose = () => {
		// Only drop the hooks WE registered — leave any later-registered
		// composed hooks alone (e.g. the gateway's synthetic-turn dispatcher
		// in `server.ts`). Calling the original `set*Hook(null)` setters
		// would clear EVERY registered hook, which would defeat composition.
		disposeSubagentEndedHook();
		disposeHeartbeatHook();
		disposeSessionListener();
		disposeSubagentCompletion();
		clearInterval(sweeperTimer);
		state.bridgeInstalled = false;
		state.disposeBridge = null;
	};
	state.disposeBridge = dispose;
	state.bridgeInstalled = true;
	return dispose;
}

/** Test-only — full reset (listeners, contexts, seqs, bridge). */
export function resetAgentEventsForTests(): void {
	const state = getState();
	if (state.disposeBridge) {
		try {
			state.disposeBridge();
		} catch {
			// best-effort
		}
	}
	state.seqByRun.clear();
	state.listeners.clear();
	state.runContextById.clear();
	state.bridgeInstalled = false;
	state.disposeBridge = null;
}
