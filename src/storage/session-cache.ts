// src/storage/session-cache.ts
//
// Convex-mode in-process cache for the per-agent sessions.json equivalent.
// The sync helpers in src/sessions/session-store.ts (readSessionStore /
// writeSessionStore and everything built on them) dispatch here in convex
// mode: reads are served from the cache, writes prime it synchronously and
// enqueue the per-key Convex mutations on a serial flush chain.
//
// Boot hydration (storage/boot.ts) fills the cache for every agent in the
// config before any subsystem runs; agents created at runtime start from an
// empty file, which is correct (a brand-new agent has no session rows).
//
// Filesystem mode never touches this module.

import type { SessionEntry, SessionStoreFile } from "../sessions/session-store.js";
import type { BrigadeStore } from "./store.js";

const _files = new Map<string, SessionStoreFile>();
let _flushChain: Promise<void> = Promise.resolve();

export function primeSessionCache(agentId: string, file: SessionStoreFile): void {
	_files.set(agentId, structuredClone(file));
}

export function getCachedSessionFile(agentId: string): SessionStoreFile | undefined {
	return _files.get(agentId);
}

export function isSessionCachePrimed(agentId: string): boolean {
	return _files.has(agentId);
}

/** Diff `next` against the cached file for `agentId`, prime the cache, and
 *  enqueue the Convex mutations that realise the diff. Called by
 *  `writeSessionStore`'s convex branch (inside the per-agent sync lock, so
 *  cache updates are serialised in-process; Convex linearises the rest). */
export function writeThroughSessionCache(
	store: BrigadeStore,
	agentId: string,
	next: SessionStoreFile,
): void {
	const prev = _files.get(agentId) ?? { version: 1, sessions: {} };
	primeSessionCache(agentId, next);

	const ops: Array<() => Promise<unknown>> = [];
	for (const [key, entry] of Object.entries(next.sessions)) {
		const old = prev.sessions[key];
		if (old && JSON.stringify(old) === JSON.stringify(entry)) continue;
		// The upsert mutation MERGES — it adds/changes fields the caller
		// supplies but never CLEARS one (omitted args keep their stored value;
		// subagent is write-once). So any transition that DROPS a field the old
		// entry had (a freshness roll that resets provider/model/auth/thinking/
		// extra/subagent) can't be realised by a merge — it needs delete +
		// reinsert. Widened from the subagent-only check, which silently
		// retained stale model/auth state across a roll.
		const oldRec = old as Record<string, unknown> | undefined;
		const newRec = entry as unknown as Record<string, unknown>;
		const clearsAField =
			oldRec !== undefined &&
			Object.keys(oldRec).some(
				(k) => oldRec[k] !== undefined && newRec[k] === undefined,
			);
		if (clearsAField) {
			ops.push(() => store.sessions.deleteEntry(agentId, key));
		}
		const frozen = structuredClone(entry) as Partial<SessionEntry>;
		ops.push(() => store.sessions.upsertEntry(agentId, key, frozen));
	}
	for (const key of Object.keys(prev.sessions)) {
		if (next.sessions[key] === undefined) {
			ops.push(() => store.sessions.deleteEntry(agentId, key));
		}
	}
	if (ops.length === 0) return;

	_flushChain = _flushChain
		.then(async () => {
			for (const op of ops) await op();
		})
		.catch((err) => {
			// Cache already serves the new state in-process; surface the
			// persistence failure loudly. Subsequent writes retry the chain.
			console.error(
				`brigade: session write to convex failed (agent ${agentId}) — ${(err as Error).message}`,
			);
		});
}

/** Resolves when every session write enqueued so far reached the backend. */
export function awaitSessionFlush(): Promise<void> {
	return _flushChain;
}

/** Test-only. */
export function __resetSessionCacheForTests(): void {
	_files.clear();
	_flushChain = Promise.resolve();
}
