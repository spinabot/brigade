// src/storage/facts-cache.ts
//
// Convex-mode in-process cache for memory facts (facts.jsonl equivalent),
// keyed per workspace. FactStore's two IO choke points (readAll + the
// private whole-file writeAll) dispatch here in convex mode: reads serve
// an explicitly hydrated cache; writes optimistically update it and enqueue the mutations realising
// the diff (authoritative upserts + deletes by memoryId).
//
// Workspace identity: "main" for the shared top-level workspace, the agent
// id for per-agent workspaces — derived from the workspaceDir path shape
// (`~/.brigade/agents/<id>/workspace` vs anything else).
//
// Filesystem mode never touches this module.

import path from "node:path";

import type { MemoryRecord } from "../tideline/store/records.js";
import type { BrigadeStore } from "./store.js";

const _byWorkspace = new Map<string, MemoryRecord[]>();
export type FactsHydrationState =
	| { status: "uninitialized" | "pending" | "ready" }
	| { status: "error"; error: FactsHydrationError };

export class FactsHydrationError extends Error {
	constructor(readonly workspaceId: string, cause: unknown) {
		super(`Memory hydration failed for workspace ${workspaceId}`, { cause });
		this.name = "FactsHydrationError";
	}
}

export class FactsHydrationPendingError extends Error {
	constructor(readonly workspaceId: string, readonly ready: Promise<void>) {
		super(`Memory hydration is pending for workspace ${workspaceId}; await store.ready() before reading`);
		this.name = "FactsHydrationPendingError";
	}
}

interface Hydration {
	state: FactsHydrationState;
	promise?: Promise<void>;
	/** Local changes made while the remote snapshot was unavailable. Null is a delete. */
	overlay: Map<string, MemoryRecord | null>;
	generation: number;
}
const _hydration = new Map<string, Hydration>();
type FactOperation = { run: () => Promise<unknown> };
interface Writes {
	pending: Map<string, FactOperation>;
	tail: Promise<void>;
	scheduled: number;
	error?: unknown;
}
const _writes = new Map<string, Writes>();
const MAX_ATTEMPTS = 3;
/** Historical failure count for diagnostics/backwards compatibility. Durability
 * callers await the workspace's rejecting flush instead of comparing counters. */
const _flushErrorCount = new Map<string, number>();
export function factsFlushErrorCount(workspaceId: string): number {
	return _flushErrorCount.get(workspaceId) ?? 0;
}

/** Canonical, case-STABLE workspace key. The convex cache is shared between the BOOT
 *  hydration (keyed off the config agent id) and the runtime FactStore (keyed off the
 *  on-disk path, which `resolveAgentWorkspaceDir` LOWERCASES). If the two disagree on
 *  case, every convex read misses the boot-primed cache → silent memory amnesia. So
 *  BOTH sides funnel the key through this one lowercasing rule. */
export function canonicalWorkspaceId(id: string): string {
	return id.trim().toLowerCase();
}

/** "main" for the top-level workspace; the canonicalised agent id for
 *  `agents/<id>/workspace`-shaped dirs. NOTE: a `cfg.agents.<id>.workspace` OVERRIDE
 *  pointing outside that shape can't be id-resolved from the path alone and collapses
 *  to "main" — passing the canonical agent id explicitly is the full fix (future). */
export function workspaceIdFromDir(workspaceDir: string): string {
	const parts = path.resolve(workspaceDir).split(path.sep);
	const i = parts.lastIndexOf("agents");
	if (i >= 0 && i + 2 < parts.length && parts[i + 2] === "workspace") {
		const id = parts[i + 1];
		if (id && id.trim().length > 0) return canonicalWorkspaceId(id);
	}
	return "main";
}

export function primeFactsCache(workspaceId: string, records: MemoryRecord[]): void {
	const hydration = hydrationFor(workspaceId);
	const byId = new Map(structuredClone(records).map((record) => [record.memoryId, record]));
	for (const [id, record] of hydration.overlay) {
		if (record === null) byId.delete(id);
		else byId.set(id, structuredClone(record));
	}
	_byWorkspace.set(workspaceId, [...byId.values()]);
	hydration.overlay.clear();
	hydration.generation++;
	hydration.state = { status: "ready" };
}

export function getCachedFacts(workspaceId: string): MemoryRecord[] | undefined {
	return _byWorkspace.get(workspaceId);
}

function hydrationFor(workspaceId: string): Hydration {
	let hydration = _hydration.get(workspaceId);
	if (!hydration) {
		hydration = { state: { status: "uninitialized" }, overlay: new Map(), generation: 0 };
		_hydration.set(workspaceId, hydration);
	}
	return hydration;
}

export function getFactsHydrationState(workspaceId: string): FactsHydrationState {
	return { ...hydrationFor(workspaceId).state };
}

/** One shared, bounded hydration cycle. A later explicit call retries an error.
 * No empty cache is marked authoritative before the backend confirms it. */
export function ensureFactsHydrated(store: BrigadeStore, workspaceId: string): Promise<void> {
	const hydration = hydrationFor(workspaceId);
	if (hydration.state.status === "ready") return Promise.resolve();
	if (hydration.state.status === "pending") return hydration.promise!;
	const generation = ++hydration.generation;
	hydration.state = { status: "pending" };
	const promise = Promise.resolve().then(async () => {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			try {
				const rows = await store.memory.listAllFactRecordsRaw(workspaceId);
				if (_hydration.get(workspaceId) === hydration && hydration.generation === generation) {
					primeFactsCache(workspaceId, rows as unknown as MemoryRecord[]);
				}
				return;
			} catch (error) {
				lastError = error;
				if (_hydration.get(workspaceId) !== hydration || hydration.generation !== generation) return;
			}
		}
		const error = new FactsHydrationError(workspaceId, lastError);
		hydration.state = { status: "error", error };
		throw error;
	});
	hydration.promise = promise;
	// A synchronous read can start hydration and throw pending without awaiting.
	// Keep the rejection observable to awaiters, but never unhandled globally.
	void promise.catch(() => {});
	return promise;
}

/** Synchronous adapter: distinguish unavailable memory from a confirmed empty store. */
export function readThroughFactsCache(store: BrigadeStore, workspaceId: string): MemoryRecord[] {
	const hydration = hydrationFor(workspaceId);
	if (hydration.state.status === "ready") return structuredClone(_byWorkspace.get(workspaceId) ?? []);
	if (hydration.state.status === "error") throw hydration.state.error;
	throw new FactsHydrationPendingError(workspaceId, ensureFactsHydrated(store, workspaceId));
}

/** Diff `next` against the cached records by memoryId, prime, and enqueue
 *  the authoritative row mutations. */
export function writeThroughFactsCache(
	store: BrigadeStore,
	workspaceId: string,
	next: MemoryRecord[],
): void {
	const prev = _byWorkspace.get(workspaceId) ?? [];
	_byWorkspace.set(workspaceId, structuredClone(next));
	const hydration = hydrationFor(workspaceId);

	const prevById = new Map(prev.map((r) => [r.memoryId, r] as const));
	const nextById = new Map(next.map((r) => [r.memoryId, r] as const));
	type StoreMemoryRecord = Parameters<BrigadeStore["memory"]["upsertFactRecordRaw"]>[1];
	let writes = _writes.get(workspaceId);
	if (!writes) {
		writes = { pending: new Map(), tail: Promise.resolve(), scheduled: 0 };
		_writes.set(workspaceId, writes);
	}
	let changed = false;
	for (const [id, rec] of nextById) {
		const old = prevById.get(id);
		if (old && JSON.stringify(old) === JSON.stringify(rec)) continue;
		const frozen = structuredClone(rec) as unknown as StoreMemoryRecord;
		writes.pending.set(id, { run: () => store.memory.upsertFactRecordRaw(workspaceId, frozen) });
		if (hydration.state.status !== "ready") hydration.overlay.set(id, structuredClone(rec));
		changed = true;
	}
	for (const id of prevById.keys()) {
		if (!nextById.has(id)) {
			writes.pending.set(id, { run: () => store.memory.deleteFactRecordRaw(workspaceId, id) });
			if (hydration.state.status !== "ready") hydration.overlay.set(id, null);
			changed = true;
		}
	}
	if (changed) scheduleFlush(workspaceId, writes);
}

function scheduleFlush(workspaceId: string, writes: Writes): void {
	if (writes.scheduled > 0) return;
	writes.scheduled++;
	const attempted = new Set<FactOperation>();
	writes.tail = writes.tail.then(async () => {
		let failed = false;
		for (;;) {
			const operations = [...writes.pending].filter(([, operation]) => !attempted.has(operation));
			if (operations.length === 0) break;
			for (const [id, operation] of operations) {
				attempted.add(operation);
				for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
					// A newer update/delete supersedes a failed stale operation, never vice versa.
					if (writes.pending.get(id) !== operation) break;
					try {
						await operation.run();
						if (writes.pending.get(id) === operation) writes.pending.delete(id);
						break;
					} catch (error) {
						if (attempt === MAX_ATTEMPTS - 1 && writes.pending.get(id) === operation) {
							writes.error = error;
							failed = true;
						}
					}
				}
			}
		}
		if (failed) {
			_flushErrorCount.set(workspaceId, factsFlushErrorCount(workspaceId) + 1);
			console.error(`brigade: memory facts write to convex failed (workspace ${workspaceId}); pending operations retained for retry`);
		}
		if (writes.pending.size === 0) writes.error = undefined;
	}).finally(() => {
		writes.scheduled--;
		if ([...writes.pending.values()].some((operation) => !attempted.has(operation))) scheduleFlush(workspaceId, writes);
	});
}

/** Await this workspace (or all workspaces), rejecting while durable writes remain
 * failed. A later call retries retained operations, at most three attempts per row.
 * Background queues never reject, and a failing workspace cannot poison another. */
export async function awaitFactsFlush(workspaceId?: string): Promise<void> {
	const selected = workspaceId === undefined ? [..._writes] : [[workspaceId, _writes.get(workspaceId)] as const];
	const results = await Promise.allSettled(selected.map(async ([id, writes]) => {
		if (!writes) return;
		if (writes.scheduled === 0 && writes.pending.size > 0) scheduleFlush(id, writes);
		let tail: Promise<void>;
		do {
			tail = writes.tail;
			await tail;
		} while (tail !== writes.tail);
		if (writes.pending.size > 0) throw new Error(`Memory facts flush failed for workspace ${id}; pending operations retained`, { cause: writes.error });
	}));
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "Memory facts flush failed");
}

/** Test-only. */
export function __resetFactsCacheForTests(): void {
	_byWorkspace.clear();
	_hydration.clear();
	_writes.clear();
	_flushErrorCount.clear();
}
