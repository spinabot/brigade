/**
 * Wave O0.8 GAP 9 — pending-abort marker for the spawn registration → dispatch race window.
 *
 * Problem: when `subagent-spawn.ts:spawnSubagentDirect` calls
 * `registerSubagentRun` and then `await callGateway`, the live-session
 * registry has NOT yet seen the child. If the parent aborts during this
 * window, the cascade walks `listActiveSubagentRunsForController`, finds
 * the run, calls `abortLiveSession(childKey)` — which returns false (no
 * live entry) — and the child then proceeds to dispatch and run.
 *
 * Fix: when the cascade fires for a child that has no live entry yet, it
 * leaves a marker keyed by `childSessionKey`. `dispatchAgentRun` consults
 * the marker BEFORE registering the live session; if present, the child
 * is short-circuited to an abort outcome and never invokes the adapter.
 *
 * Single-writer/single-reader pattern: the cascade writes via
 * `markPendingDispatchAbort`, the dispatcher reads + clears via
 * `consumePendingDispatchAbort`. Markers are also cleared on successful
 * live-session registration (in dispatchAgentRun) so a later parent abort
 * routes through `abortLiveSession` as usual.
 *
 * Markers carry the abort reason (operator-ctrl-c, parent-aborted,
 * shutdown, …) so downstream classification preserves the cause.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type PendingDispatchAbortState = {
	markers: Map<string, string>;
};

const PENDING_DISPATCH_ABORT_STATE_KEY = Symbol.for("brigade.subagent.pendingDispatchAbort");

function getState(): PendingDispatchAbortState {
	return resolveGlobalSingleton<PendingDispatchAbortState>(
		PENDING_DISPATCH_ABORT_STATE_KEY,
		() => ({ markers: new Map() }),
	);
}

/**
 * Mark `sessionKey` as pre-aborted. Idempotent — repeat calls keep the
 * FIRST reason (the originating cascade) so a later "shutdown" sweep
 * doesn't overwrite a more meaningful "parent-aborted".
 */
export function markPendingDispatchAbort(sessionKey: string, reason?: string): void {
	const key = sessionKey?.trim();
	if (!key) return;
	const state = getState();
	if (state.markers.has(key)) return;
	state.markers.set(key, (reason ?? "aborted").toString());
}

/**
 * Atomically read + clear the marker for `sessionKey`. Returns the abort
 * reason when a marker was present, or `null` when no marker existed.
 */
export function consumePendingDispatchAbort(sessionKey: string): string | null {
	const key = sessionKey?.trim();
	if (!key) return null;
	const state = getState();
	const reason = state.markers.get(key);
	if (reason === undefined) return null;
	state.markers.delete(key);
	return reason;
}

/**
 * Clear any marker for `sessionKey` without returning it. Used by the
 * dispatcher after successful live-session registration so a late marker
 * doesn't poison a subsequent legitimate run for the same key.
 */
export function clearPendingDispatchAbort(sessionKey: string): void {
	const key = sessionKey?.trim();
	if (!key) return;
	getState().markers.delete(key);
}

/** True iff a marker is queued for the sessionKey. */
export function hasPendingDispatchAbort(sessionKey: string): boolean {
	const key = sessionKey?.trim();
	if (!key) return false;
	return getState().markers.has(key);
}

/** Test-only — wipe every marker. */
export function resetPendingDispatchAbortForTests(): void {
	getState().markers.clear();
}
