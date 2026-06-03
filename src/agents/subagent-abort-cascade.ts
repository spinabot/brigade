/**
 * Wave O0.7 - parent abort cascade for sub-agents.
 *
 * When a parent session is aborted (operator Ctrl+C in TUI, programmatic
 * `abortLiveSession`, or graceful shutdown), every child it transitively
 * spawned should also abort. Without this cascade, an operator who hits
 * Ctrl+C on the TUI sees the prompt return immediately but leaves child
 * sessions burning tokens against whatever provider the children are on.
 *
 * Mechanism: subscribe to `session-registry.onSessionStateChange`. When a
 * session transitions to `terminated`, walk
 * `subagent-registry.listActiveSubagentRunsForController(parentKey)` and
 * call `abortLiveSession(childKey, "parent-aborted")` on every active
 * child. The transition itself fires for each child, so grandchildren
 * cascade automatically.
 *
 * The cascade is best-effort - any throw inside the listener is logged
 * but never rethrown (a misbehaving abort must not crash the registry).
 * It is also idempotent: a re-entrant cascade hitting the same child
 * (e.g. abort-shutdown racing operator Ctrl+C) is a no-op once the child
 * is already terminated.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
	abortLiveSession,
	hasLiveSession,
	onSessionStateChange,
} from "./session-registry.js";
import { markPendingDispatchAbort } from "./subagent-spawn-abort-marker.js";
import { listActiveSubagentRunsForController } from "./subagent-registry.js";

const log = createSubsystemLogger("agents/subagent-abort-cascade");

type CascadeState = {
	disposeListener: (() => void) | null;
};

const CASCADE_STATE_KEY = Symbol.for("brigade.subagentAbortCascade.state");

function getState(): CascadeState {
	return resolveGlobalSingleton<CascadeState>(CASCADE_STATE_KEY, () => ({
		disposeListener: null,
	}));
}

/**
 * Install the parent-abort cascade. Returns a disposer that unsubscribes
 * from the session-registry state-change listener. Idempotent -
 * re-installing replaces the previous listener.
 */
export function installSubagentAbortCascade(): () => void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}

	const dispose = onSessionStateChange((event) => {
		if (event.newState !== "terminated") return;
		const parentKey = event.sessionKey;
		if (!parentKey) return;
		// `listActiveSubagentRunsForController` filters out children that
		// have already been stamped with `endedAt`, so a parent that
		// terminates after every child completed is a no-op.
		let activeChildren: ReturnType<typeof listActiveSubagentRunsForController>;
		try {
			activeChildren = listActiveSubagentRunsForController(parentKey);
		} catch (err) {
			log.warn("listActiveSubagentRunsForController threw", {
				parentKey,
				error: (err as Error)?.message,
			});
			return;
		}
		if (activeChildren.length === 0) return;
		for (const childEntry of activeChildren) {
			const childKey = childEntry.childSessionKey;
			if (!childKey) continue;
			try {
				// Wave O0.8 GAP 9 — close the registration→dispatch race
				// window. If the child has no live entry yet (the spawn
				// engine has called `registerSubagentRun` but the gateway
				// `agent` handler has not yet hit `registerLiveSession`),
				// leave a pending-abort marker. `dispatchAgentRun` consults
				// the marker BEFORE registering and short-circuits to an
				// abort outcome instead of running the adapter.
				if (!hasLiveSession(childKey)) {
					markPendingDispatchAbort(childKey, "parent-aborted");
				}
				// Abort the child's live session, if any. Returns false when
				// the child has no live entry yet (gateway handoff race) or
				// has already terminated - both are fine. When the live
				// session lands after we leave the marker, dispatchAgentRun
				// consumes the marker and short-circuits — no double-abort.
				abortLiveSession(childKey, "parent-aborted");
			} catch (err) {
				log.warn("child abort threw", {
					parentKey,
					childKey,
					runId: childEntry.runId,
					error: (err as Error)?.message,
				});
			}
		}
		log.debug("parent-abort cascade fired", {
			parentKey,
			childCount: activeChildren.length,
		});
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

/** Test-only - clear cascade state. */
export function resetSubagentAbortCascadeForTests(): void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}
}
