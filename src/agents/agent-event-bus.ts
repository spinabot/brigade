/**
 * Process-singleton agent event bus.
 *
 * Mirrors OpenClaw's `src/infra/agent-events.ts:286` — a global listener
 * registry that survives Pi `AgentSession` recreation across turns. The
 * bus lets multiple consumers (the in-process TUI, the gateway's
 * WebSocket broadcaster, debug logs, future plugins) subscribe ONCE
 * at process boot and receive events from every turn that runs in
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
			toolName: string;
			reason: string;
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
	  };

export type AgentEventListener = (event: AgentBusEvent) => void;

const listeners = new Set<AgentEventListener>();

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
