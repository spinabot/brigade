import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, type MemoryRecord } from "../agents/memory/records.js";
import { __resetBootForTests } from "./boot.js";
import {
	__resetFactsCacheForTests,
	awaitFactsFlush,
	primeFactsCache,
	workspaceIdFromDir,
} from "./facts-cache.js";
import { __resetRuntimeContextForTests, setRuntimeContext } from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

// Convex-mode dispatch for the FactStore (facts.jsonl equivalent): reads
// from the boot-hydrated per-workspace cache; whole-file writes realised as
// authoritative per-record mutations. Filesystem mode is covered by the
// existing memory tests.

interface RecordedOp {
	kind: "upsert" | "delete";
	workspaceId: string;
	memoryId: string;
}

class FakeMemoryApi {
	ops: RecordedOp[] = [];
	async upsertFactRecordRaw(workspaceId: string, record: MemoryRecord): Promise<void> {
		this.ops.push({ kind: "upsert", workspaceId, memoryId: record.memoryId });
	}
	async deleteFactRecordRaw(workspaceId: string, memoryId: string): Promise<void> {
		this.ops.push({ kind: "delete", workspaceId, memoryId });
	}
	async listAllFactRecordsRaw(): Promise<MemoryRecord[]> {
		return [];
	}
}

function installConvexContext(fake: FakeMemoryApi, stateDir: string): void {
	const store = { mode: "convex", memory: fake } as unknown as BrigadeStore;
	setRuntimeContext(
		Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
	);
}

describe("memory facts dispatcher (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeMemoryApi;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-mem-dispatch-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeMemoryApi();
	});

	afterEach(async () => {
		await awaitFactsFlush().catch(() => {});
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetFactsCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("workspaceIdFromDir maps the layout correctly", () => {
		assert.equal(workspaceIdFromDir(path.join(stateDir, "workspace")), "main");
		assert.equal(
			workspaceIdFromDir(path.join(stateDir, "agents", "inventory", "workspace")),
			"inventory",
		);
	});

	it("FactStore.write lands in the cache + store, never disk", async () => {
		installConvexContext(fake, stateDir);
		const wsDir = path.join(stateDir, "agents", "inventory", "workspace");
		primeFactsCache("inventory", []);

		const store = new FactStore(wsDir);
		const rec = store.write({ content: "operator prefers npm over pnpm", segment: "preference" });
		assert.equal(rec.lifecycle, "active");

		// Read-back from cache sees it.
		const all = store.readAll();
		assert.equal(all.length, 1);
		assert.equal(all[0]?.content, "operator prefers npm over pnpm");

		await awaitFactsFlush();
		assert.deepEqual(fake.ops, [
			{ kind: "upsert", workspaceId: "inventory", memoryId: rec.memoryId },
		]);

		// Strict-zero: nothing under the state dir.
		assert.deepEqual(readdirSync(stateDir), []);
	});

	it("supersedes archives the target — realised as a second upsert, not a delete", async () => {
		installConvexContext(fake, stateDir);
		const wsDir = path.join(stateDir, "workspace");
		primeFactsCache("main", []);
		const store = new FactStore(wsDir);
		const first = store.write({ content: "user lives in Hyderabad", segment: "identity" });
		await awaitFactsFlush();
		fake.ops = [];

		const second = store.write({
			content: "user lives in Bengaluru",
			segment: "identity",
			supersedes: [first.memoryId],
		});
		await awaitFactsFlush();

		const kinds = fake.ops.map((o) => `${o.kind}:${o.memoryId}`);
		assert.ok(kinds.includes(`upsert:${second.memoryId}`), "new fact upserted");
		assert.ok(kinds.includes(`upsert:${first.memoryId}`), "superseded fact re-upserted as archived");
		const archived = store.readAll().find((r) => r.memoryId === first.memoryId);
		assert.equal(archived?.lifecycle, "archived");
	});

	it("setLifecycle (decay GC) flows through the same choke point", async () => {
		installConvexContext(fake, stateDir);
		const wsDir = path.join(stateDir, "workspace");
		primeFactsCache("main", []);
		const store = new FactStore(wsDir);
		const rec = store.write({ content: "ephemeral note", segment: "context" });
		await awaitFactsFlush();
		fake.ops = [];

		store.setLifecycle([rec.memoryId], "archived");
		await awaitFactsFlush();
		assert.deepEqual(fake.ops, [{ kind: "upsert", workspaceId: "main", memoryId: rec.memoryId }]);
	});

	it("filesystem mode untouched — facts land on disk as today", () => {
		const wsDir = path.join(stateDir, "workspace");
		const store = new FactStore(wsDir);
		store.write({ content: "disk fact", segment: "context" });
		assert.equal(store.readAll().length, 1);
		assert.ok(readdirSync(stateDir).length > 0);
		assert.equal(fake.ops.length, 0);
	});
});
