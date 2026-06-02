/**
 * Process-singleton agent event bus.
 *
 * A global listener registry that survives Pi `AgentSession` recreation
 * across turns. The bus lets multiple consumers (the in-process TUI, the
 * gateway's WebSocket broadcaster, debug logs, future plugins) subscribe
 * ONCE at process boot and receive events from every turn that runs in
 * this process.
 *
 * Architecture choice: a global module-level Set is fine for Brigade's
 * locked single-process v1. Phase 2 (multi-user / DB-backed) will
 * either keep this and key events by `agentId` + `sessionId`, or move
 * to a per-tenant emitter — that's a Phase 2 design decision, not
 * something to over-build today.
 *
 * Event taxonomy:
 *   - `pi` events forward Pi `AgentSessionEvent` 1:1 (typed as `unknown`
 *     here to avoid a hard type dep — consumers cast as needed). This
 *     is what the gateway broadcasts to WebSocket clients today.
 *   - Brigade-native lifecycle events (`turn-start`, `turn-settled`,
 *     `turn-aborted`, `tool-blocked`, `slash-handled`, `model-switched`)
 *     mark moments Pi doesn't surface directly. Consumers use them to
 *     render spinners, log refusals, etc.
 *
 * Listener isolation: a throwing listener is logged but does NOT block
 * other listeners. Pi events fire frequently; one buggy subscriber
 * shouldn't take down the rest.
 */

export type AgentBusEvent =
	| {
			type: "pi";
			runId: string;
			agentId: string;
			sessionId: string;
			/** Raw Pi `AgentSessionEvent`. Consumers narrow as they need. */
			piEvent: unknown;
			/** Sub-agent depth this event originated at (Primitive #6). 0 (or
			 *  undefined) for the top-level turn; ≥ 1 for child sub-agent runs.
			 *  Surfaced to the WS so connect-mode TUIs can indent nested rendering. */
			subagentDepth?: number;
	  }
	| {
			type: "turn-start";
			runId: string;
			agentId: string;
			sessionId: string;
			isNewSession: boolean;
			provider: string;
			modelId: string;
			bootstrapPhase: string;
	  }
	| {
			type: "turn-settled";
			runId: string;
			agentId: string;
			sessionId: string;
			provider: string;
			modelId: string;
	  }
	| {
			type: "turn-aborted";
			runId: string;
			agentId: string;
			sessionId: string;
			reason: string;
	  }
	| {
			type: "tool-blocked";
			runId: string;
			agentId: string;
			/** Session key the blocked tool call ran under. Optional for back-
			 *  compat: pre-Wave-I callsites don't thread it. */
			sessionKey?: string;
			toolName: string;
			reason: string;
	  }
	| {
			/**
			 * Streaming interim status from a long-running tool. Emitted by
			 * `withToolUpdates` (in `tools/common.ts`) every time Pi invokes
			 * the tool's `onUpdate` callback. `payload` is the raw partial
			 * result the tool pushed — typed `unknown` so consumers narrow
			 * as they need without coupling the bus to Pi's tool-result shape.
			 *
			 * Correlation ids (`runId`, `agentId`, `sessionKey`) are
			 * best-effort: a tool wrapped before its execution context is
			 * known will emit events without them. Consumers that need
			 * correlation should filter; consumers that just render
			 * "still working" can ignore the missing ids.
			 */
			type: "tool-update";
			runId?: string;
			agentId?: string;
			sessionKey?: string;
			toolName: string;
			toolCallId: string;
			payload: unknown;
	  }
	| {
			type: "slash-handled";
			runId: string;
			agentId: string;
			command: string;
			detail?: string;
	  }
	| {
			type: "model-switched";
			runId: string;
			agentId: string;
			fromProvider: string;
			fromModelId: string;
			toProvider: string;
			toModelId: string;
	  }
	// ── Phase 5: per-turn loop lifecycle events ────────────────────────
	// Emitted by `runBrigadeTurnLoop` (the wrapper composition that lives
	// inside EmbeddedChatClient.prompt). Consumers (TUI, gateway WS
	// broadcaster) subscribe to these for inline status rendering instead
	// of receiving callbacks at every wrapper layer.
	| {
			/** Model fallback attempt: primary failed with `reason`, switching to `to`. */
			type: "turn-fallback-attempt";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. Optional for
			 *  back-compat: older callsites omit it. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			reason: string;
			toProvider: string | undefined;
			toModelId: string | undefined;
	  }
	| {
			/** All fallback candidates exhausted with their final error. */
			type: "turn-fallback-exhausted";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			reason: string;
	  }
	| {
			/** No streaming activity for `intervalMs`; surface "still working" UX. */
			type: "turn-heartbeat";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			elapsedMs: number;
	  }
	| {
			/** Per-attempt idle-stream watchdog tripped after `idleMs`. */
			type: "turn-stream-timeout";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			idleMs: number;
	  }
	| {
			/** Length-continuation kicked in: response was truncated mid-stream
			 *  and the loop re-prompted the model to continue. */
			type: "turn-length-continue";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
	  }
	| {
			/** Content-quality retry fired with reason: empty / reasoning-only /
			 *  planning-only. The loop sent a steer-prompt asking the model to
			 *  produce an actual visible answer / actually do the work. */
			type: "turn-content-retry";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			reason: "empty" | "reasoning-only" | "planning-only";
	  }
	| {
			/** Thinking level downgraded (model rejected the configured level)
			 *  from `from` to "off"; the loop retries the same user message. */
			type: "turn-thinking-downgrade";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			from: string;
	  }
	| {
			/** Same-model retry triggered by transient error (rate_limit /
			 *  overloaded / timeout / context_overflow). `class` is the
			 *  classification; `reason` is the human-readable detail the
			 *  gateway can log to subscribers. */
			type: "turn-retry-attempt";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
			errorClass: string;
			reason: string;
	  }
	| {
			/** Context overflow detected; compacting transcript before next
			 *  retry on the same model. */
			type: "turn-compact-before-retry";
			runId: string;
			/** Wave I — agent that produced this lifecycle event. */
			agentId?: string;
			/** Wave I — session that produced this lifecycle event. */
			sessionKey?: string;
	  };

export type AgentEventListener = (event: AgentBusEvent) => void;

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Pinned via global-singleton so hot-reload / dual-build setups share one Set. */
const AGENT_EVENT_BUS_LISTENERS_KEY = Symbol.for("brigade.agentEventBus.listeners");
const listeners = resolveGlobalSingleton<Set<AgentEventListener>>(
	AGENT_EVENT_BUS_LISTENERS_KEY,
	() => new Set<AgentEventListener>(),
);

/**
 * Subscribe to ALL agent events fired in this process. Returns a
 * disposer that removes the listener. Idempotent — calling the
 * disposer twice is a no-op.
 */
export function onAgentEvent(listener: AgentEventListener): () => void {
	listeners.add(listener);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		listeners.delete(listener);
	};
}

/**
 * Emit an event to every registered listener. A throwing listener is
 * caught and logged so one bad subscriber can't break the rest.
 */
export function emitAgentEvent(event: AgentBusEvent): void {
	if (listeners.size === 0) return;
	// Snapshot to avoid mutation-during-iteration if a listener
	// subscribes/unsubscribes while we're broadcasting.
	const snapshot = [...listeners];
	for (const listener of snapshot) {
		try {
			listener(event);
		} catch (err) {
			// Don't use `console.error` — that pollutes test output and the
			// gateway's stderr stream. Re-throwing would break other listeners.
			// `process.emitWarning` is the right channel: surfaces in dev,
			// silent in production unless the operator opts in.
			const msg = err instanceof Error ? err.message : String(err);
			process.emitWarning(`[agent-event-bus] listener threw: ${msg}`, {
				type: "BrigadeAgentEventListenerError",
			});
		}
	}
}

/**
 * Test-only: clear all listeners + reset state. Lets each test start
 * with a clean bus without leaking listeners between cases.
 */
export function __resetAgentBusForTests(): void {
	listeners.clear();
}

/**
 * Test/debug helper: how many listeners are subscribed right now.
 * Not for production use — exposes implementation detail.
 */
export function __agentBusListenerCount(): number {
	return listeners.size;
}
