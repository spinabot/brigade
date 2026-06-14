// src/storage/facts-cache.ts
//
// Convex-mode in-process cache for memory facts (facts.jsonl equivalent),
// keyed per workspace. FactStore's two IO choke points (readAll + the
// private whole-file writeAll) dispatch here in convex mode: reads serve
// the cache, writes prime it and enqueue the per-record mutations realising
// the diff (authoritative upserts + deletes by memoryId).
//
// Workspace identity: "main" for the shared top-level workspace, the agent
// id for per-agent workspaces — derived from the workspaceDir path shape
// (`~/.brigade/agents/<id>/workspace` vs anything else).
//
// Filesystem mode never touches this module.

import path from "node:path";

import type { MemoryRecord } from "../agents/memory/records.js";
import type { BrigadeStore } from "./store.js";

const _byWorkspace = new Map<string, MemoryRecord[]>();
let _flushChain: Promise<void> = Promise.resolve();

/** "main" for the top-level workspace; the agent id for
 *  `agents/<id>/workspace`-shaped dirs. */
export function workspaceIdFromDir(workspaceDir: string): string {
	const parts = path.resolve(workspaceDir).split(path.sep);
	const i = parts.lastIndexOf("agents");
	if (i >= 0 && i + 2 < parts.length && parts[i + 2] === "workspace") {
		const id = parts[i + 1];
		if (id && id.trim().length > 0) return id;
	}
	return "main";
}

export function primeFactsCache(workspaceId: string, records: MemoryRecord[]): void {
	_byWorkspace.set(workspaceId, structuredClone(records));
}

export function getCachedFacts(workspaceId: string): MemoryRecord[] | undefined {
	return _byWorkspace.get(workspaceId);
}

/** Diff `next` against the cached records by memoryId, prime, and enqueue
 *  the authoritative row mutations. */
export function writeThroughFactsCache(
	store: BrigadeStore,
	workspaceId: string,
	next: MemoryRecord[],
): void {
	const prev = _byWorkspace.get(workspaceId) ?? [];
	primeFactsCache(workspaceId, next);

	const prevById = new Map(prev.map((r) => [r.memoryId, r] as const));
	const nextById = new Map(next.map((r) => [r.memoryId, r] as const));
	type StoreMemoryRecord = Parameters<BrigadeStore["memory"]["upsertFactRecordRaw"]>[1];
	const ops: Array<() => Promise<unknown>> = [];
	for (const [id, rec] of nextById) {
		const old = prevById.get(id);
		if (old && JSON.stringify(old) === JSON.stringify(rec)) continue;
		const frozen = structuredClone(rec) as unknown as StoreMemoryRecord;
		ops.push(() => store.memory.upsertFactRecordRaw(workspaceId, frozen));
	}
	for (const id of prevById.keys()) {
		if (!nextById.has(id)) ops.push(() => store.memory.deleteFactRecordRaw(workspaceId, id));
	}
	if (ops.length === 0) return;

	_flushChain = _flushChain
		.then(async () => {
			for (const op of ops) await op();
		})
		.catch((err) => {
			console.error(
				`brigade: memory facts write to convex failed (workspace ${workspaceId}) — ${(err as Error).message}`,
			);
		});
}

/** Resolves when every facts mutation enqueued so far reached the backend. */
export function awaitFactsFlush(): Promise<void> {
	return _flushChain;
}

/** Test-only. */
export function __resetFactsCacheForTests(): void {
	_byWorkspace.clear();
	_flushChain = Promise.resolve();
}
