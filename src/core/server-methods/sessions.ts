/**
 * Sessions-related gateway method handlers (Step 25).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/server-methods/sessions.ts`,
 * scoped to the four methods Brigade's sessions tool surface (Steps
 * 19-23) actually calls:
 *
 *   - `sessions.list`     → enumerate live sessions
 *   - `sessions.history`  → read JSONL transcript
 *   - `sessions.send`     → enqueue a message into a session's lane
 *   - `sessions.spawn`    → invoke Step 20's spawn engine
 *
 * Brigade scope notes:
 *
 *   - The handlers here are PURE — they take their params and return a
 *     result. The transport (WebSocket / in-process) is the
 *     `gateway-caller-impl.ts` layer's responsibility.
 *   - Param validation is light at this milestone (the protocol layer
 *     does the heavy AJV check before dispatch lands). Defensive coercion
 *     prevents wild input from crashing the handler.
 *   - `sessions.history` delegates to a `historyReader` dependency so
 *     tests can inject a stub and the live runtime can wire to the JSONL
 *     reader (Pi `SessionManager.readMessages` adapter).
 *   - `sessions.send` here is a THIN passthrough — it dispatches the
 *     inbound message into the target's lane and emits the lifecycle
 *     event. The actual LLM turn execution is owned by Step 25's
 *     `agent-dispatcher.ts`.
 */

import { dispatchAgentRun, type DispatchAgentRunDeps } from "../agent-dispatcher.js";
import {
	hasLiveSession,
	listLiveSessions,
	type LiveSessionRecord,
} from "../../agents/session-registry.js";
import { resolveAgentIdFromSessionKey } from "../../agents/routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import {
	listSessionEntries,
	readSessionModelPin,
	readSessionStore,
	deleteSessionEntry,
	renameSessionEntry,
	sanitizeSessionName,
	upsertSessionEntry,
} from "../../sessions/session-store.js";
import fs from "node:fs";

import { DEFAULT_AGENT_ID, resolveSessionTranscriptPath } from "../../config/paths.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";

/**
 * Wave O0.5: server-side access guard.
 *
 * Each handler accepts an optional `accessCheck` dep. The gateway boot path
 * wires a closure that resolves the requester's session key from the
 * per-connection auth context + the current visibility/A2A policy, then
 * defers to `checkSessionToolAccess` (the same helper the tool surface uses).
 *
 * Handlers that receive `accessCheck === undefined` execute as before —
 * meaningful for legacy in-process callers (boot wiring, test fixtures)
 * that have already proven trust. WebSocket RPC always wires a guard.
 */
export type SessionsHandlerAccessAction =
	| "list"
	| "history"
	| "send"
	| "spawn"
	| "abort"
	| "steer"
	| "agent"
	| "patch";

export interface SessionsHandlerAccessCheck {
	(params: {
		action: SessionsHandlerAccessAction;
		targetSessionKey: string;
	}): { allowed: boolean; reason?: string };
}

/**
 * Typed error thrown when the access guard refuses a gateway-side call.
 * The WebSocket dispatcher reads `code` and maps it to a typed RPC error
 * envelope (instead of the generic `internal` bucket), and in-process
 * callers can catch on `name === "SessionsAccessForbiddenError"`.
 */
export class SessionsAccessForbiddenError extends Error {
	readonly code = "forbidden";
	constructor(reason: string) {
		super(reason);
		this.name = "SessionsAccessForbiddenError";
	}
}

function enforceAccess(
	check: SessionsHandlerAccessCheck | undefined,
	action: SessionsHandlerAccessAction,
	targetSessionKey: string,
): void {
	if (!check) return;
	const verdict = check({ action, targetSessionKey });
	if (verdict.allowed) return;
	throw new SessionsAccessForbiddenError(
		verdict.reason ?? `sessions.${action} forbidden`,
	);
}
import type {
	SessionsHistoryParams,
	SessionsHistoryResult,
	SessionsListParams,
	SessionsListResult,
	SessionsPatchParams,
	SessionsPatchResult,
	SessionsSendParams,
	SessionsSendResult,
	SessionsSpawnParams,
	SessionsSpawnResult,
	SessionListRow,
} from "../../protocol/methods.js";

/* ─── sessions.list ─────────────────────────────────────────────── */

export interface SessionsListHandlerDeps {
	/**
	 * Brigade's session-store lookup (Step 9). When supplied, the handler
	 * enriches each live row with persisted metadata (label, model,
	 * tokens, etc.). When omitted, only the in-memory registry view is
	 * returned.
	 */
	enrichRow?: (record: LiveSessionRecord) => SessionListRow;
	/**
	 * Wave O0.5 access guard. When set, every candidate row is checked
	 * before inclusion; refused rows are dropped (NOT an error — list is
	 * filter-shaped). Omitted by trusted in-process callers.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsList(
	params: SessionsListParams = {},
	deps: SessionsListHandlerDeps = {},
): Promise<SessionsListResult> {
	const live = listLiveSessions();
	const filtered = applyFilters(live, params);
	const visible = deps.accessCheck
		? filtered.filter((entry) => {
				const verdict = deps.accessCheck!({
					action: "list",
					targetSessionKey: entry.sessionKey,
				});
				return verdict.allowed;
			})
		: filtered;
	const rows = visible.map((entry) => buildRow(entry, deps));

	// `listLiveSessions()` is the in-memory RUN registry: sessions with a turn in
	// flight or just finished. It empties on every gateway restart. So this answered
	// "which sessions are running", while every caller — `/sessions`, `--session`, an
	// operator asking "where is my thread?" — is asking "which threads do I HAVE".
	// After a restart it reported none while a 16 MB conversation sat on disk, and
	// `--session` refused to open the very thread it was pointed at.
	//
	// The persisted store is the source of truth for existence. Merge it in; live rows
	// win (they carry runtime state); the same access guard applies.
	const liveKeys = new Set(rows.map((r) => r.sessionKey));
	const agentIds = params.agentId
		? [params.agentId]
		: [...new Set([DEFAULT_AGENT_ID, ...live.map((e) => e.agentId).filter((a): a is string => !!a)])];

	const persisted: SessionListRow[] = [];
	for (const agentId of agentIds) {
		let entries: ReturnType<typeof listSessionEntries>;
		try {
			entries = listSessionEntries(agentId);
		} catch {
			continue; // an unreadable store must never fail the list
		}
		for (const { sessionKey, entry } of entries) {
			if (liveKeys.has(sessionKey)) {
				// The live row wins on runtime state, but the NAME only exists in the
				// persisted store — carry it across rather than skipping outright, so a
				// renamed thread reads the same whether or not a turn is in flight.
				// Sanitise on READ too: the store is a plain JSON file an operator can
				// hand-edit, and a name containing \n would inject a fake row into
				// `/sessions` while \r or ESC corrupts the rows around it.
				const liveName = sanitizeSessionName(entry.name);
				if (liveName) {
					// Match on agent too: with `--all` a non-canonical key could otherwise
					// label another agent's live thread with this agent's name.
					const liveRow = rows.find((r) => r.sessionKey === sessionKey && r.agentId === agentId);
					if (liveRow) liveRow.displayName = liveName;
				}
				continue;
			}
			// Sub-agent and isolated-cron threads are machinery, not conversations an
			// operator picks up — they never appeared in the live view either.
			if (entry.subagent) continue;
			if (sessionKey.startsWith("isolated:")) continue;
			if (deps.accessCheck && !deps.accessCheck({ action: "list", targetSessionKey: sessionKey }).allowed) {
				continue;
			}
			const startedAt = Date.parse(String(entry.createdAt ?? ""));
			const updatedAt = Date.parse(String(entry.lastUsedAt ?? ""));
			persisted.push({
				sessionKey,
				agentId,
				state: "idle",
				...(Number.isFinite(startedAt) ? { startedAt } : {}),
				...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
				...(typeof entry.modelId === "string" ? { model: entry.modelId } : {}),
				// The PIN, separate from `model` above (which is only what last
				// served the session). A thread pinned but not yet messaged has a
				// pin and a stale-or-absent `model`; surfacing only the latter
				// would show a UI the wrong model for exactly that thread.
				...(pinOf(agentId, sessionKey) ?? {}),
				...(sanitizeSessionName(entry.name) ? { displayName: sanitizeSessionName(entry.name) } : {}),
			});
		}
	}

	// Most recently used first — the thread you were just in is the one you want.
	persisted.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	let all = [...rows, ...persisted];
	if (typeof params.limit === "number" && params.limit > 0) all = all.slice(0, params.limit);
	return { sessions: all, count: all.length };
}

/** Pin fields for a list row, or undefined when the session follows its agent. */
function pinOf(
	agentId: string,
	sessionKey: string,
): { pinnedProvider: string; pinnedModel: string } | undefined {
	const pin = readSessionModelPin(agentId, sessionKey);
	return pin ? { pinnedProvider: pin.provider, pinnedModel: pin.modelId } : undefined;
}

function applyFilters(rows: LiveSessionRecord[], params: SessionsListParams): LiveSessionRecord[] {
	let filtered = rows;
	if (params.agentId) {
		filtered = filtered.filter((entry) => entry.agentId === params.agentId);
	}
	if (params.spawnedBy) {
		filtered = filtered.filter(
			(entry) =>
				typeof entry.metadata?.spawnedBy === "string" &&
				entry.metadata.spawnedBy === params.spawnedBy,
		);
	}
	if (typeof params.activeMinutes === "number" && params.activeMinutes > 0) {
		const cutoff = Date.now() - params.activeMinutes * 60 * 1_000;
		filtered = filtered.filter((entry) => entry.lastActivityAt >= cutoff);
	}
	if (typeof params.limit === "number" && params.limit > 0) {
		filtered = filtered.slice(0, params.limit);
	}
	return filtered;
}

function buildRow(entry: LiveSessionRecord, deps: SessionsListHandlerDeps): SessionListRow {
	const base: SessionListRow = deps.enrichRow
		? deps.enrichRow(entry)
		: {
				sessionKey: entry.sessionKey,
				agentId: entry.agentId,
				state: entry.state,
				startedAt: entry.createdAt,
				updatedAt: entry.lastActivityAt,
			};
	// Wave O0.7 - surface spawn lineage from the persisted session store
	// so a `sessions_list` caller can see parent/depth without a separate
	// metadata RPC. Read is best-effort; on any IO error we fall back to
	// the live-registry metadata (`spawnedBy` set on dispatch).
	if (!base.spawnedBy || base.spawnDepth === undefined) {
		try {
			const agentId = entry.agentId;
			if (agentId) {
				const store = readSessionStore(agentId);
				const persisted = store.sessions[entry.sessionKey];
				if (persisted?.subagent) {
					if (!base.spawnedBy && persisted.subagent.spawnedBy) {
						base.spawnedBy = persisted.subagent.spawnedBy;
					}
					if (base.spawnDepth === undefined && typeof persisted.subagent.spawnDepth === "number") {
						base.spawnDepth = persisted.subagent.spawnDepth;
					}
					if (!base.label && persisted.subagent.label) {
						base.label = persisted.subagent.label;
					}
				}
			}
		} catch {
			// best-effort enrichment; lineage absent is non-fatal
		}
	}
	// Also fall back to the live-registry metadata (set at dispatch time)
	// for the parent key when the store-side metadata is absent.
	if (!base.spawnedBy && typeof entry.metadata?.spawnedBy === "string") {
		base.spawnedBy = entry.metadata.spawnedBy;
	}
	return base;
}

/* ─── sessions.history ──────────────────────────────────────────── */

export interface SessionsHistoryHandlerDeps {
	/** Mandatory reader — Brigade's runtime wires this to the JSONL adapter. */
	readMessages: (params: {
		sessionKey: string;
		limit?: number;
	}) => Promise<ReadonlyArray<unknown>>;
	/**
	 * Wave O0.5 access guard. Refused calls throw
	 * `SessionsAccessForbiddenError` which the RPC layer maps to a typed
	 * `forbidden` response. Omitted by trusted in-process callers.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsHistory(
	params: SessionsHistoryParams,
	deps: SessionsHistoryHandlerDeps,
): Promise<SessionsHistoryResult> {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) {
		return { messages: [] };
	}
	enforceAccess(deps.accessCheck, "history", sessionKey);
	const messages = await deps.readMessages({
		sessionKey,
		...(typeof params.limit === "number" ? { limit: params.limit } : {}),
	});
	return { messages: messages ?? [] };
}

/* ─── sessions.send ─────────────────────────────────────────────── */

export interface SessionsSendHandlerDeps extends DispatchAgentRunDeps {
	/**
	 * Wave O0.5 access guard. Refused calls throw
	 * `SessionsAccessForbiddenError`. Omitted by trusted in-process callers.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsSend(
	params: SessionsSendParams,
	deps: SessionsSendHandlerDeps,
): Promise<SessionsSendResult> {
	enforceAccess(deps.accessCheck, "send", params.sessionKey);
	const run = dispatchAgentRun(
		{
			sessionKey: params.sessionKey,
			message: params.message,
			idempotencyKey: params.idempotencyKey,
			thinking: params.thinking,
			timeout: typeof params.timeoutMs === "number" ? params.timeoutMs / 1_000 : undefined,
			deliver: true,
		},
		deps,
	);
	// Caller pattern: respond immediately with runId; the lifecycle
	// event-bus emits the turn-end notification when `run.settled`
	// resolves. We DO NOT await `run.settled` here because that would
	// block the gateway response — the caller (or subscriber on the
	// lifecycle stream) picks up the final asynchronously.
	void run.settled.catch(() => undefined);
	return { ok: true, runId: run.runId };
}

/* ─── sessions.spawn ────────────────────────────────────────────── */

export interface SessionsSpawnHandlerDeps {
	/**
	 * Caller's current session depth, resolved from the session store.
	 * Brigade wires this from the persisted session entry; tests pass
	 * a constant.
	 */
	resolveCallerDepth?: (params: { sessionKey: string }) => number | Promise<number>;
	/**
	 * Wave O0.5 access guard. Spawn is checked against the
	 * `parentSessionKey` because the child key is minted by the engine.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

/* ─── sessions.patch ────────────────────────────────────────────── */

/**
 * Handle the `sessions.patch` RPC. Looks up the agentId from the
 * session key, then upserts the patch into the per-agent session store
 * via `upsertSessionEntry`. Returns `{ok, created, sessionId}`.
 *
 * Brigade's existing per-agent session-store is the source of truth
 * here — the cross-agent registry from Step 9 is a parallel surface
 * scoped to the new `brigade-store.json`. The two stores serve
 * different consumers and never share entries.
 */
export interface SessionsPatchHandlerDeps {
	/** Wave O0.5 access guard — refused calls throw. */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsPatch(
	params: SessionsPatchParams,
	deps: SessionsPatchHandlerDeps = {},
): Promise<SessionsPatchResult> {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) {
		return { ok: false, created: false };
	}
	enforceAccess(deps.accessCheck, "patch", sessionKey);
	const agentId = resolveAgentIdFromSessionKey(sessionKey);
	const patch = params.patch ?? {};
	// upsertSessionEntry reports `created=true` when the entry was minted.
	// To know whether the entry existed BEFORE, we'd need a pre-read;
	// today the handler approximates `created` by checking presence of
	// `lastUsedAt` in the result vs. `createdAt` (a fresh entry has them
	// equal). Brigade can refine if observers need stricter semantics.
	const beforeCreate = Date.now();
	const entry = upsertSessionEntry(agentId, sessionKey, patch);
	const created = new Date(entry.createdAt).getTime() >= beforeCreate - 1_000;
	return { ok: true, created, sessionId: entry.sessionId };
}

/**
 * Shared preamble for the mutating session methods.
 *
 * Requires a CANONICAL `agent:<id>:<rest>` key and derives the agent from it.
 * Two bugs made this non-negotiable rather than tidy-up:
 *
 *   - `resolveAgentIdFromSessionKey` is total — it collapses ANY unparseable
 *     key to the default agent. `/delete legacy-main` for a thread owned by
 *     `riley` therefore read main's store and, if main held a same-named entry,
 *     destroyed THAT one instead. Refusing is the only safe answer.
 *   - The store is a plain object, so a wire key like `constructor` or
 *     `toString` reached the prototype chain. Requiring the canonical shape
 *     rejects those at the door, above the own-property guards in the store.
 *
 * Returns null when the key is unusable; the caller reports a clean miss.
 */
function resolveMutationTarget(
	rawKey: unknown,
	accessCheck: SessionsHandlerAccessCheck | undefined,
): { sessionKey: string; agentId: string } | null {
	const sessionKey = typeof rawKey === "string" ? rawKey.trim() : "";
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return null;
	enforceAccess(accessCheck, "patch", sessionKey);
	return { sessionKey, agentId: resolveAgentIdFromSessionKey(sessionKey) };
}

export interface SessionsRenameHandlerDeps {
	/** Wave O0.5 access guard — refused calls throw. */
	accessCheck?: SessionsHandlerAccessCheck;
}

/**
 * Set or clear a session's display name.
 *
 * Deliberately NOT routed through `sessions.patch`: that calls
 * `upsertSessionEntry`, which both stamps `lastUsedAt` and MINTS the entry when
 * it is missing. Renaming must do neither — bumping recency would jump the row
 * to the top of the history under the operator's cursor, and naming a session
 * that does not exist should be a clean miss, not a way to conjure one.
 *
 * Reuses the `patch` access action: this is a mutation of session metadata, and
 * inventing a new verb here would silently bypass every policy already written
 * against `patch`.
 */
export async function handleSessionsRename(
	params: { sessionKey: string; name?: string },
	deps: SessionsRenameHandlerDeps = {},
): Promise<{ ok: boolean; sessionKey: string; agentId: string; name?: string }> {
	const target = resolveMutationTarget(params?.sessionKey, deps.accessCheck);
	if (!target) {
		return { ok: false, sessionKey: typeof params?.sessionKey === "string" ? params.sessionKey : "", agentId: DEFAULT_AGENT_ID };
	}
	const { sessionKey, agentId } = target;
	const entry = renameSessionEntry(agentId, sessionKey, params?.name);
	// Unknown session — a clean miss, not an error: the caller may be racing a
	// deletion, and a rename is never worth failing a turn over.
	if (!entry) return { ok: false, sessionKey, agentId };
	return { ok: true, sessionKey, agentId, ...(entry.name ? { name: entry.name } : {}) };
}

export interface SessionsDeleteHandlerDeps {
	/** Wave O0.5 access guard — refused calls throw. */
	accessCheck?: SessionsHandlerAccessCheck;
	/** Injectable for tests; defaults to the in-process run registry. */
	isLive?: (sessionKey: string) => boolean;
	/** Injectable for tests; defaults to the boot runtime context's store. */
	store?: { messages?: { deleteTranscript?: (agentId: string, sessionId: string) => Promise<unknown> } };
}

/**
 * Delete a session and its transcript. OPERATOR-ONLY by construction: there is
 * deliberately no agent tool for this.
 *
 * Rename is recoverable; deletion is not. The sessions tool bundle has no owner
 * gate, so exposing deletion there would let any channel peer's turn — or one
 * prompt injection — destroy conversation history. The gateway RPC and the TUI
 * `/delete` command are the only callers.
 *
 * Refuses while a turn is in flight: removing the entry and transcript under a
 * running turn would strand its writer on a file that no longer exists, and the
 * operator almost certainly meant a thread they are finished with.
 */
export async function handleSessionsDelete(
	params: { sessionKey: string },
	deps: SessionsDeleteHandlerDeps = {},
): Promise<{ ok: boolean; sessionKey: string; agentId: string; reason?: string; transcriptRemoved?: boolean }> {
	const target = resolveMutationTarget(params?.sessionKey, deps.accessCheck);
	if (!target) {
		return {
			ok: false,
			sessionKey: typeof params?.sessionKey === "string" ? params.sessionKey : "",
			agentId: DEFAULT_AGENT_ID,
			reason: "not a canonical agent:<id>:<rest> session key",
		};
	}
	const { sessionKey, agentId } = target;

	// `hasLiveSession` is the established predicate — it treats every state except
	// `terminated` as live. Matching only `state === "running"` let a `draining`
	// turn (mid-abort, shutdown flush) through, which is precisely the writer the
	// doc above promises not to strand.
	const isLive = deps.isLive ?? hasLiveSession;
	if (isLive(sessionKey)) {
		return { ok: false, sessionKey, agentId, reason: "a turn is still active in this session" };
	}

	// Read the sessionId BEFORE deleting — it is the only link to the transcript,
	// and once the entry is gone the transcript can no longer be located.
	const existing = readSessionStore(agentId).sessions[sessionKey];
	const sessionId = typeof existing?.sessionId === "string" ? existing.sessionId : undefined;

	// Entry first. `deleteSessionEntry` is backend-aware (writeSessionStore routes
	// through the write-through cache in convex mode). If the transcript removal
	// then fails we leak an orphaned transcript, which is reported; the reverse
	// order would leave an entry pointing at a transcript that no longer exists.
	const deleted = deleteSessionEntry(agentId, sessionKey);
	if (!deleted) return { ok: false, sessionKey, agentId, reason: "no such session" };

	// Delete the transcript through the STORE, never raw `fs`. In convex mode the
	// transcript lives in the Convex `messages` table — an `fs.rmSync` there
	// silently no-ops, and reporting `transcriptRemoved: true` would tell the
	// operator a conversation was permanently deleted while it is retained in
	// full. Absent a store (cold CLI / unit test) there is nothing to consult, so
	// report honestly rather than guessing.
	let transcriptRemoved = false;
	if (sessionId) {
		const store = deps.store ?? tryGetRuntimeContext()?.store;
		let storeDeleted = false;
		if (store?.messages?.deleteTranscript) {
			try {
				await store.messages.deleteTranscript(agentId, sessionId);
				storeDeleted = true;
			} catch {
				/* orphaned transcript — reported below, never thrown after the entry went */
			}
		}
		// Start from what the store confirmed; the filesystem check below can both
		// downgrade this (store resolved but the bytes are still there) and, when
		// there is no store at all, establish it (filesystem mode, where the JSONL
		// IS the transcript). Reporting "may still be on disk" about a file we just
		// removed is the same lie as the reverse.
		transcriptRemoved = storeDeleted;
		// `LocalMessageStore.deleteTranscript` wraps its `rm` in a bare try/catch,
		// so a resolved promise is NOT evidence the bytes are gone — on EPERM or a
		// Windows lock it resolves having deleted nothing. Since this flag is the
		// operator's only signal that "permanently deleted" was true, verify it.
		// Also clears the write-lock sidecar, which no store implementation owns.
		try {
			const local = resolveSessionTranscriptPath(agentId, sessionId);
			fs.rmSync(`${local}.lock`, { force: true });
			// In convex mode this path is the regenerable OS-cache mirror, which the
			// session reaper also drops; in filesystem mode it IS the transcript.
			const existedBefore = fs.existsSync(local);
			fs.rmSync(local, { force: true });
			const goneNow = !fs.existsSync(local);
			if (!goneNow) transcriptRemoved = false;
			else if (!storeDeleted && existedBefore) {
				// No store, but the transcript was here and now is not — in filesystem
				// mode that IS the whole transcript, so the claim is true.
				transcriptRemoved = tryGetRuntimeContext()?.mode !== "convex";
			}
		} catch {
			transcriptRemoved = false;
		}
	}
	return { ok: true, sessionKey, agentId, transcriptRemoved };
}

export async function handleSessionsSpawn(
	params: SessionsSpawnParams,
	deps: SessionsSpawnHandlerDeps = {},
): Promise<SessionsSpawnResult> {
	enforceAccess(deps.accessCheck, "spawn", params.parentSessionKey);
	const callerDepth = deps.resolveCallerDepth
		? await deps.resolveCallerDepth({ sessionKey: params.parentSessionKey })
		: 0;
	const result = await spawnSubagentDirect(
		{
			task: params.task,
			label: params.label,
			agentId: params.agentId,
			model: params.model,
			thinking: params.thinking,
			runTimeoutSeconds: params.runTimeoutSeconds,
			thread: params.thread,
			mode: params.mode,
			cleanup: params.cleanup,
			sandbox: params.sandbox,
		},
		{
			agentSessionKey: params.parentSessionKey,
			callerDepth,
		},
	);
	if (result.status !== "accepted" || !result.childSessionKey || !result.runId) {
		throw new Error(result.error ?? "spawn failed");
	}
	return {
		runId: result.runId,
		childSessionKey: result.childSessionKey,
		mode: result.mode ?? "run",
	};
}
