import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { MemoryRecord } from "../tideline/store/records.js";
import type { BrigadeStore } from "./store.js";
import {
	__resetFactsCacheForTests, awaitFactsFlush, ensureFactsHydrated, factsFlushErrorCount,
	FactsHydrationError, FactsHydrationPendingError, getCachedFacts, getFactsHydrationState,
	primeFactsCache, readThroughFactsCache, writeThroughFactsCache,
} from "./facts-cache.js";

function record(memoryId: string, content = memoryId): MemoryRecord {
	return { memoryId, content, segment: "knowledge", tier: "long", importance: 0.5,
		decayRate: 0.03, accessCount: 0, lastAccessedAt: 100, createdAt: 100, lifecycle: "active" };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function backend(overrides: {
	list?: (workspaceId: string) => Promise<MemoryRecord[]>;
	upsert?: (workspaceId: string, row: MemoryRecord) => Promise<void>;
	remove?: (workspaceId: string, id: string) => Promise<void>;
} = {}): BrigadeStore {
	return { memory: {
		listAllFactRecordsRaw: overrides.list ?? (async () => []),
		upsertFactRecordRaw: overrides.upsert ?? (async () => {}),
		deleteFactRecordRaw: overrides.remove ?? (async () => {}),
	} } as unknown as BrigadeStore;
}

beforeEach(__resetFactsCacheForTests);
afterEach(async () => {
	await awaitFactsFlush().catch(() => {});
	__resetFactsCacheForTests();
});

test("cold reads expose pending, share hydration, and only a successful read confirms empty", async () => {
	const response = deferred<MemoryRecord[]>();
	let reads = 0;
	const store = backend({ list: async () => { reads++; return response.promise; } });
	assert.throws(() => readThroughFactsCache(store, "a"), FactsHydrationPendingError);
	assert.equal(getCachedFacts("a"), undefined);
	assert.deepEqual(getFactsHydrationState("a"), { status: "pending" });
	const first = ensureFactsHydrated(store, "a");
	assert.equal(ensureFactsHydrated(store, "a"), first);
	response.resolve([]);
	await first;
	assert.equal(reads, 1);
	assert.deepEqual(readThroughFactsCache(store, "a"), []);
	assert.deepEqual(getFactsHydrationState("a"), { status: "ready" });
});

test("failed hydration is bounded, explicit, and retryable without false-empty priming", async () => {
	let reads = 0;
	let offline = true;
	const store = backend({ list: async () => {
		reads++;
		if (offline) throw new Error("offline");
		return [record("remote")];
	} });
	await assert.rejects(ensureFactsHydrated(store, "a"), FactsHydrationError);
	assert.equal(reads, 3);
	assert.equal(getFactsHydrationState("a").status, "error");
	assert.equal(getCachedFacts("a"), undefined);
	assert.throws(() => readThroughFactsCache(store, "a"), FactsHydrationError);
	assert.equal(reads, 3, "synchronous error reads must not create an unbounded retry storm");
	offline = false;
	await ensureFactsHydrated(store, "a");
	assert.equal(reads, 4);
	const detached = readThroughFactsCache(store, "a");
	detached[0]!.content = "mutated outside cache";
	assert.equal(readThroughFactsCache(store, "a")[0]?.content, "remote");
});

test("hydration merge preserves concurrent local updates and deletions, even after they flush", async () => {
	const response = deferred<MemoryRecord[]>();
	const store = backend({ list: () => response.promise });
	const hydration = ensureFactsHydrated(store, "a");
	writeThroughFactsCache(store, "a", [record("deleted"), record("changed", "old")]);
	writeThroughFactsCache(store, "a", [record("changed", "new")]);
	await awaitFactsFlush("a");
	response.resolve([record("deleted", "stale"), record("changed", "stale"), record("remote")]);
	await hydration;
	assert.deepEqual(readThroughFactsCache(store, "a").map(({ memoryId, content }) => [memoryId, content]),
		[["changed", "new"], ["remote", "remote"]]);
});

test("a superseding prime and a reset cannot be overwritten by a late hydration", async () => {
	const response = deferred<MemoryRecord[]>();
	const store = backend({ list: () => response.promise });
	const pending = ensureFactsHydrated(store, "a");
	primeFactsCache("a", [record("new")]);
	response.resolve([record("stale")]);
	await pending;
	assert.deepEqual(readThroughFactsCache(store, "a").map((row) => row.memoryId), ["new"]);
	const later = deferred<MemoryRecord[]>();
	const stale = ensureFactsHydrated(backend({ list: () => later.promise }), "b");
	__resetFactsCacheForTests();
	later.resolve([record("stale")]);
	await stale;
	assert.equal(getCachedFacts("b"), undefined);
});

test("failed optimistic writes reject flush, remain retryable, and do not poison the queue", async () => {
	let offline = true;
	let attempts = 0;
	const persisted = new Map<string, MemoryRecord>();
	const store = backend({ upsert: async (_workspace, row) => {
		attempts++;
		if (offline) throw new Error("offline");
		persisted.set(row.memoryId, structuredClone(row));
	} });
	primeFactsCache("a", []);
	writeThroughFactsCache(store, "a", [record("one")]);
	await assert.rejects(awaitFactsFlush("a"), AggregateError);
	assert.equal(attempts, 3);
	assert.equal(factsFlushErrorCount("a"), 1);
	assert.equal(getCachedFacts("a")?.length, 1, "optimistic state is retained but not called durable");
	assert.equal(persisted.size, 0);
	offline = false;
	await awaitFactsFlush("a");
	assert.equal(persisted.get("one")?.content, "one");
	assert.equal(attempts, 4);
	writeThroughFactsCache(store, "a", [record("one"), record("two")]);
	await awaitFactsFlush("a");
	assert.equal(persisted.size, 2);
});

test("a failed workspace and row cannot prevent other workspaces or rows from persisting", async () => {
	const persisted: string[] = [];
	const store = backend({ upsert: async (workspace, row) => {
		if (workspace === "bad" && row.memoryId === "failure") throw new Error("offline");
		persisted.push(`${workspace}/${row.memoryId}`);
	} });
	primeFactsCache("bad", []); primeFactsCache("good", []);
	writeThroughFactsCache(store, "bad", [record("failure"), record("healthy")]);
	writeThroughFactsCache(store, "good", [record("healthy")]);
	await awaitFactsFlush("good");
	await assert.rejects(awaitFactsFlush("bad"));
	assert.ok(persisted.includes("bad/healthy"));
	assert.ok(persisted.includes("good/healthy"));
	assert.equal(factsFlushErrorCount("good"), 0);
});

test("a newer update supersedes an in-flight failed write without stale retries", async () => {
	const started = deferred<void>(); const release = deferred<void>();
	const payloads: string[] = [];
	const store = backend({ upsert: async (_workspace, row) => {
		payloads.push(row.content);
		if (row.content === "old") { started.resolve(); await release.promise; throw new Error("old failure"); }
	} });
	primeFactsCache("a", []);
	writeThroughFactsCache(store, "a", [record("one", "old")]);
	await started.promise;
	writeThroughFactsCache(store, "a", [record("one", "new")]);
	const flushed = awaitFactsFlush("a");
	release.resolve();
	await flushed;
	assert.deepEqual(payloads, ["old", "new"]);
	assert.equal(readThroughFactsCache(store, "a")[0]?.content, "new");
});

test("a delete supersedes a failed upsert and a failed delete itself can recover", async () => {
	let canDelete = false;
	let upserts = 0; let deletes = 0;
	const store = backend({
		upsert: async () => { upserts++; throw new Error("upsert failed"); },
		remove: async () => { deletes++; if (!canDelete) throw new Error("delete failed"); },
	});
	primeFactsCache("a", []);
	writeThroughFactsCache(store, "a", [record("one")]);
	await assert.rejects(awaitFactsFlush("a"));
	writeThroughFactsCache(store, "a", []);
	await assert.rejects(awaitFactsFlush("a"));
	assert.equal(upserts, 3, "obsolete failed upsert must not be retried after delete");
	assert.equal(deletes, 3);
	canDelete = true;
	await awaitFactsFlush("a");
	assert.equal(deletes, 4);
	assert.deepEqual(getCachedFacts("a"), []);
});

test("an in-flight successful upsert cannot resurrect a concurrently deleted row", async () => {
	const started = deferred<void>(); const release = deferred<void>();
	const rows = new Map<string, MemoryRecord>();
	const store = backend({
		upsert: async (_workspace, row) => { started.resolve(); await release.promise; rows.set(row.memoryId, row); },
		remove: async (_workspace, id) => { rows.delete(id); },
	});
	primeFactsCache("a", []);
	writeThroughFactsCache(store, "a", [record("one")]);
	await started.promise;
	writeThroughFactsCache(store, "a", []);
	const flushed = awaitFactsFlush("a");
	release.resolve();
	await flushed;
	assert.equal(rows.size, 0);
	assert.deepEqual(getCachedFacts("a"), []);
});
