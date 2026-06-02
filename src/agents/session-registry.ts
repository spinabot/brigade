/**
 * In-process live-session registry.
 *
 * Tracks the sessions Brigade's gateway is actively running a turn for —
 * the orthogonal counterpart to `session-store.ts` (which persists per-
 * session metadata to disk) and `subagent-registry.ts` (which tracks
 * sub-agent runs spawned BY sessions).
 *
 * Why have a separate live registry at all: the heartbeat runner (Step 14),
 * the channel manager (Step 16), the approval router (Step 17), and the
 * gateway dispatcher (Step 25) all need ONE place to ask "is X live?" —
 * and ONE place to abort it on graceful shutdown.
 *
 * Backing store: a `resolveGlobalSingleton`-pinned Map keyed by `runId`.
 * Lives for the process lifetime; never persisted. A fresh process boots
 * with an empty Map.
 *
 * P2#1 (Wave H) — keyed by runId, not sessionKey. A single sessionKey can
 * host MULTIPLE live entries when, for example, a heartbeat synthetic
 * turn fires while the operator's prompt is still streaming, or when a
 * crash-recovery race re-registers before unregister. Previously the
 * Map-by-sessionKey silently REPLACED the prior entry, dropping its
 * abort controller and losing the original turn's lifecycle stamp. Now:
 *
 *   - Each `registerLiveSession` mints a unique entry keyed by `runId`.
 *   - `hasLiveSession(sessionKey)` looks up by sessionKey via secondary
 *     index (sessionKey → Set<runId>).
 *   - `abortLiveSession(sessionKey)` aborts ALL non-terminated entries
 *     for that sessionKey (channels can no longer leak across turn
 *     boundaries).
 *
 * Hook surface:
 *   - `onStateChange(listener)` for observers (Step 18 agent-events fan-out).
 *   - Abort propagation: each entry carries the turn's `AbortController`,
 *     so a graceful shutdown can call `abortAllSessions("shutdown")`
 *     and every in-flight turn unwinds promptly.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const log = createSubsystemLogger("agents/session-registry");

export type SessionLifecycleState = "running" | "idle" | "draining" | "terminated";

export type LiveSessionRecord = {
	sessionKey: string;
	sessionId: string;
	agentId: string;
	runId: string;
	lane: string;
	state: SessionLifecycleState;
	createdAt: number;
	lastStateChangeAt: number;
	lastActivityAt: number;
	abortController?: AbortController;
	/** Free-form per-session metadata. Never persisted. */
	metadata?: Record<string, unknown>;
};

export type SessionStateChangeEvent = {
	sessionKey: string;
	previousState: SessionLifecycleState | "registered";
	newState: SessionLifecycleState;
	timestamp: number;
	runId?: string;
};

type SessionStateListener = (event: SessionStateChangeEvent) => void;

type SessionRegistryState = {
	/** Primary index — every live entry keyed by its (unique) `runId`. */
	byRunId: Map<string, LiveSessionRecord>;
	/** Secondary index — `sessionKey` → Set of live `runId`s for that key. */
	runIdsBySessionKey: Map<string, Set<string>>;
	listeners: Set<SessionStateListener>;
};

const SESSION_REGISTRY_STATE_KEY = Symbol.for("brigade.sessionRegistry.state");

function createState(): SessionRegistryState {
	return { byRunId: new Map(), runIdsBySessionKey: new Map(), listeners: new Set() };
}

function getState(): SessionRegistryState {
	return resolveGlobalSingleton<SessionRegistryState>(SESSION_REGISTRY_STATE_KEY, createState);
}

function emit(event: SessionStateChangeEvent): void {
	const { listeners } = getState();
	for (const listener of listeners) {
		try {
			listener(event);
		} catch (err) {
			log.warn("session-state listener threw", {
				sessionKey: event.sessionKey,
				error: (err as Error)?.message,
			});
		}
	}
}

function indexAdd(state: SessionRegistryState, sessionKey: string, runId: string): void {
	let set = state.runIdsBySessionKey.get(sessionKey);
	if (!set) {
		set = new Set();
		state.runIdsBySessionKey.set(sessionKey, set);
	}
	set.add(runId);
}

function indexRemove(state: SessionRegistryState, sessionKey: string, runId: string): void {
	const set = state.runIdsBySessionKey.get(sessionKey);
	if (!set) return;
	set.delete(runId);
	if (set.size === 0) state.runIdsBySessionKey.delete(sessionKey);
}

export interface RegisterSessionParams {
	sessionKey: string;
	sessionId: string;
	agentId: string;
	runId: string;
	lane: string;
	abortController?: AbortController;
	metadata?: Record<string, unknown>;
}

/**
 * Register a fresh live session. Each call mints a distinct entry keyed by
 * `runId`; multiple live entries for the same sessionKey are allowed (e.g.
 * a heartbeat turn racing the operator's prompt). The dispatcher should
 * still pass DISTINCT runIds per turn — colliding runIds replace the
 * existing entry (logged) the same way the old Map-by-sessionKey did.
 */
export function registerLiveSession(params: RegisterSessionParams): LiveSessionRecord {
	const state = getState();
	const now = Date.now();
	if (!params.runId) {
		throw new Error("registerLiveSession: runId is required");
	}
	const existingByRunId = state.byRunId.get(params.runId);
	if (existingByRunId) {
		log.debug("replacing existing live-session entry (same runId)", {
			sessionKey: params.sessionKey,
			runId: params.runId,
		});
		// Detach the old sessionKey index entry if the new entry's sessionKey
		// differs (it shouldn't, but defend against the dispatcher mutating).
		if (existingByRunId.sessionKey !== params.sessionKey) {
			indexRemove(state, existingByRunId.sessionKey, params.runId);
		}
	}
	const record: LiveSessionRecord = {
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		runId: params.runId,
		lane: params.lane,
		state: "running",
		createdAt: now,
		lastStateChangeAt: now,
		lastActivityAt: now,
		abortController: params.abortController,
		metadata: params.metadata,
	};
	state.byRunId.set(params.runId, record);
	indexAdd(state, params.sessionKey, params.runId);
	emit({
		sessionKey: params.sessionKey,
		previousState: "registered",
		newState: "running",
		timestamp: now,
		runId: params.runId,
	});
	return record;
}

/** Lookup the newest live entry for a session key (or undefined). */
export function getLiveSession(sessionKey: string): LiveSessionRecord | undefined {
	if (!sessionKey) return undefined;
	const state = getState();
	const runIds = state.runIdsBySessionKey.get(sessionKey);
	if (!runIds || runIds.size === 0) return undefined;
	let newest: LiveSessionRecord | undefined;
	for (const runId of runIds) {
		const rec = state.byRunId.get(runId);
		if (!rec) continue;
		if (!newest || rec.createdAt > newest.createdAt) newest = rec;
	}
	return newest;
}

/** Lookup a specific live entry by runId. */
export function getLiveSessionByRunId(runId: string): LiveSessionRecord | undefined {
	if (!runId) return undefined;
	return getState().byRunId.get(runId);
}

/** Every live entry for a session key (every non-terminated runId). */
export function getLiveSessionsForKey(sessionKey: string): LiveSessionRecord[] {
	if (!sessionKey) return [];
	const state = getState();
	const runIds = state.runIdsBySessionKey.get(sessionKey);
	if (!runIds || runIds.size === 0) return [];
	const out: LiveSessionRecord[] = [];
	for (const runId of runIds) {
		const rec = state.byRunId.get(runId);
		if (rec) out.push(rec);
	}
	return out;
}

/** `true` while at least one entry for the sessionKey is in a non-terminated state. */
export function hasLiveSession(sessionKey: string): boolean {
	for (const entry of getLiveSessionsForKey(sessionKey)) {
		if (entry.state !== "terminated") return true;
	}
	return false;
}

/** Snapshot every currently registered session. */
export function listLiveSessions(): LiveSessionRecord[] {
	return [...getState().byRunId.values()];
}

/**
 * Filter to sessions matching a predicate. Common shapes:
 *   - by agent: `listLiveSessionsWhere((s) => s.agentId === "main")`
 *   - by lane:  `listLiveSessionsWhere((s) => s.lane.startsWith("session:"))`
 */
export function listLiveSessionsWhere(
	predicate: (entry: LiveSessionRecord) => boolean,
): LiveSessionRecord[] {
	return listLiveSessions().filter(predicate);
}

/** Count of currently-running (non-idle, non-draining, non-terminated) sessions. */
export function countActiveLiveSessions(): number {
	let n = 0;
	for (const entry of getState().byRunId.values()) {
		if (entry.state === "running") n += 1;
	}
	return n;
}

/** Per-agent variant — only counts entries whose `agentId` matches. Wave K. */
export function countActiveLiveSessionsForAgent(agentIdValue: string): number {
	if (!agentIdValue) return 0;
	let n = 0;
	for (const entry of getState().byRunId.values()) {
		if (entry.state === "running" && entry.agentId === agentIdValue) n += 1;
	}
	return n;
}

function transitionStateByRunId(runId: string, newState: SessionLifecycleState): boolean {
	const state = getState();
	const entry = state.byRunId.get(runId);
	if (!entry) return false;
	if (entry.state === newState) return false;
	const previousState = entry.state;
	const now = Date.now();
	entry.state = newState;
	entry.lastStateChangeAt = now;
	entry.lastActivityAt = now;
	emit({
		sessionKey: entry.sessionKey,
		previousState,
		newState,
		timestamp: now,
		runId,
	});
	return true;
}

function transitionAllForSessionKey(
	sessionKey: string,
	newState: SessionLifecycleState,
): boolean {
	let any = false;
	for (const entry of getLiveSessionsForKey(sessionKey)) {
		if (transitionStateByRunId(entry.runId, newState)) any = true;
	}
	return any;
}

/** Mark every live entry for `sessionKey` idle (waiting on inbound). */
export function markSessionIdle(sessionKey: string): boolean {
	return transitionAllForSessionKey(sessionKey, "idle");
}

/** Move every live entry for `sessionKey` into draining state. */
export function markSessionDraining(sessionKey: string): boolean {
	return transitionAllForSessionKey(sessionKey, "draining");
}

/** Mark every live entry for `sessionKey` running again after an idle/draining pause. */
export function markSessionRunning(sessionKey: string): boolean {
	return transitionAllForSessionKey(sessionKey, "running");
}

/** Touch `lastActivityAt` on every entry for `sessionKey` without changing state. */
export function touchSessionActivity(sessionKey: string): boolean {
	const entries = getLiveSessionsForKey(sessionKey);
	if (entries.length === 0) return false;
	const now = Date.now();
	for (const entry of entries) entry.lastActivityAt = now;
	return true;
}

/**
 * Abort EVERY live entry for the sessionKey (a single sessionKey may host
 * multiple in-flight turns — heartbeat racing operator, retry races, etc.).
 * Each matching entry's abort controller fires; each is transitioned to
 * `terminated`. Returns `true` if at least one entry was found.
 */
export function abortLiveSession(sessionKey: string, reason?: string): boolean {
	const entries = getLiveSessionsForKey(sessionKey);
	if (entries.length === 0) return false;
	for (const entry of entries) {
		try {
			entry.abortController?.abort(reason ?? "session-aborted");
		} catch (err) {
			log.warn("abortController threw on abort()", {
				sessionKey,
				runId: entry.runId,
				error: (err as Error)?.message,
			});
		}
		transitionStateByRunId(entry.runId, "terminated");
	}
	return true;
}

/**
 * Abort a single live entry by runId. Used when the caller knows the
 * specific turn (not just the sessionKey) to cancel — heartbeat dispatcher
 * cancelling its own synthetic turn, sub-agent runner cancelling a child.
 */
export function abortLiveSessionByRunId(runId: string, reason?: string): boolean {
	const state = getState();
	const entry = state.byRunId.get(runId);
	if (!entry) return false;
	try {
		entry.abortController?.abort(reason ?? "session-aborted");
	} catch (err) {
		log.warn("abortController threw on abort()", {
			runId,
			error: (err as Error)?.message,
		});
	}
	transitionStateByRunId(runId, "terminated");
	return true;
}

/**
 * Remove a live entry from the registry. Resolves by runId when there's a
 * unique entry, otherwise by sessionKey (when only one live entry exists).
 * Does NOT call `abort()` — the caller is expected to have completed the
 * turn (or to call `abortLiveSession` first). Returns `true` if the entry
 * was present.
 *
 * Callers that hold a specific `runId` should prefer
 * `unregisterLiveSessionByRunId` to avoid the ambiguity branch.
 */
export function unregisterLiveSession(sessionKey: string): boolean {
	const entries = getLiveSessionsForKey(sessionKey);
	if (entries.length === 0) return false;
	const state = getState();
	let any = false;
	for (const entry of entries) {
		const previousState = entry.state;
		state.byRunId.delete(entry.runId);
		indexRemove(state, entry.sessionKey, entry.runId);
		emit({
			sessionKey: entry.sessionKey,
			previousState,
			newState: "terminated",
			timestamp: Date.now(),
			runId: entry.runId,
		});
		any = true;
	}
	return any;
}

/** Remove a single live entry by runId. Returns `true` if the entry was present. */
export function unregisterLiveSessionByRunId(runId: string): boolean {
	const state = getState();
	const entry = state.byRunId.get(runId);
	if (!entry) return false;
	const previousState = entry.state;
	state.byRunId.delete(runId);
	indexRemove(state, entry.sessionKey, runId);
	emit({
		sessionKey: entry.sessionKey,
		previousState,
		newState: "terminated",
		timestamp: Date.now(),
		runId,
	});
	return true;
}

/**
 * Graceful shutdown: abort every session's turn + transition them all to
 * `terminated`. Returns the count of sessions that received an abort.
 * Doesn't unregister — entries linger until explicit `unregisterLiveSession`
 * or `resetSessionRegistryForTests`.
 */
export function abortAllSessions(reason?: string): number {
	const state = getState();
	let n = 0;
	for (const entry of state.byRunId.values()) {
		if (entry.state === "terminated") continue;
		try {
			entry.abortController?.abort(reason ?? "shutdown");
		} catch {
			// best-effort
		}
		const previous = entry.state;
		entry.state = "terminated";
		entry.lastStateChangeAt = Date.now();
		emit({
			sessionKey: entry.sessionKey,
			previousState: previous,
			newState: "terminated",
			timestamp: Date.now(),
			runId: entry.runId,
		});
		n += 1;
	}
	return n;
}

/**
 * Subscribe to lifecycle transitions. Returns a disposer that removes the
 * listener. Listener exceptions are logged + swallowed (a misbehaving
 * subscriber must not crash the dispatcher).
 */
export function onSessionStateChange(listener: SessionStateListener): () => void {
	const state = getState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}

/** Test-only — drop every entry + every listener. */
export function resetSessionRegistryForTests(): void {
	const state = getState();
	state.byRunId.clear();
	state.runIdsBySessionKey.clear();
	state.listeners.clear();
}
