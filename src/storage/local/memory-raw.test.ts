import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { LocalMemoryStore } from "./memory-store.js";
import type { MemoryRecord } from "../store.js";

// Batch-7 fix: LocalMemoryStore.upsertFactRecordRaw / deleteFactRecordRaw used
// to throw NotImplementedYet, so a `brigade store migrate --to filesystem`
// (convex → disk) dropped EVERY fact. They now write the local facts.jsonl
// disk-direct (ignoring the global runtime context, which the FactStore helper
// branches on — wrong when this store is a migrate target in convex mode).

function fact(id: string, content: string): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment: "context",
		lifecycle: "active",
		createdAt: 1,
		updatedAt: 1,
		importance: 0.5,
		tier: "short",
	} as unknown as MemoryRecord;
}

describe("LocalMemoryStore raw fact surface (disk-direct)", () => {
	let stateDir: string;
	let saved: string | undefined;
	let store: LocalMemoryStore;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-mem-raw-"));
		saved = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		store = new LocalMemoryStore(stateDir);
	});

	afterEach(() => {
		if (saved === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = saved;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("upserts, lists, and round-trips a record by id", async () => {
		await store.upsertFactRecordRaw("main", fact("f1", "hello"));
		const all = await store.listAllFactRecordsRaw("main");
		assert.equal(all.length, 1);
		assert.equal((all[0] as unknown as { memoryId: string }).memoryId, "f1");
		assert.equal((all[0] as unknown as { content: string }).content, "hello");
	});

	it("upsert by the same id replaces in place (idempotent — no dupes)", async () => {
		await store.upsertFactRecordRaw("main", fact("f1", "v1"));
		await store.upsertFactRecordRaw("main", fact("f1", "v2"));
		const all = await store.listAllFactRecordsRaw("main");
		assert.equal(all.length, 1);
		assert.equal((all[0] as unknown as { content: string }).content, "v2");
	});

	it("preserves every lifecycle (active + archived)", async () => {
		await store.upsertFactRecordRaw("main", fact("f1", "active one"));
		await store.upsertFactRecordRaw("main", {
			...(fact("f2", "archived one") as object),
			lifecycle: "archived",
		} as unknown as MemoryRecord);
		const all = await store.listAllFactRecordsRaw("main");
		assert.equal(all.length, 2);
		const byId = new Map(all.map((r) => [(r as unknown as { memoryId: string }).memoryId, r]));
		assert.equal((byId.get("f2") as unknown as { lifecycle: string }).lifecycle, "archived");
	});

	it("deletes a record by id and leaves the rest", async () => {
		await store.upsertFactRecordRaw("main", fact("f1", "one"));
		await store.upsertFactRecordRaw("main", fact("f2", "two"));
		await store.deleteFactRecordRaw("main", "f1");
		const all = await store.listAllFactRecordsRaw("main");
		assert.equal(all.length, 1);
		assert.equal((all[0] as { memoryId: string }).memoryId, "f2");
	});

	it("an empty / never-written workspace lists nothing", async () => {
		const all = await store.listAllFactRecordsRaw("main");
		assert.deepEqual(all, []);
	});

	it("consolidate stamp round-trips disk-direct", async () => {
		assert.equal(await store.getConsolidateLastRunAt(), undefined);
		await store.markConsolidateRunAt(123456);
		assert.equal(await store.getConsolidateLastRunAt(), 123456);
	});
});
