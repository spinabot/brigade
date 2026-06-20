import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { effectiveScore, runDecayGc } from "./decay.js";
import { FactStore, type MemoryRecord } from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-decay-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const DAY = 86_400_000;

function rec(over: Partial<MemoryRecord>): MemoryRecord {
	return {
		memoryId: "m",
		content: "x",
		segment: "context",
		tier: "short",
		importance: 0.4,
		decayRate: 0.08,
		accessCount: 0,
		lastAccessedAt: Date.now(),
		createdAt: Date.now(),
		lifecycle: "active",
		...over,
	};
}

describe("effectiveScore", () => {
	it("permanent tier never decays (always 1)", () => {
		const r = rec({ tier: "permanent", lastAccessedAt: Date.now() - 1000 * DAY });
		assert.equal(effectiveScore(r), 1);
	});
	it("fresh fact ~ its importance; old fact decays below it", () => {
		const now = Date.now();
		const fresh = effectiveScore(rec({ importance: 0.7, lastAccessedAt: now }), now);
		const old = effectiveScore(rec({ importance: 0.7, lastAccessedAt: now - 60 * DAY }), now);
		// daysSinceAccess=0 → exp(0)=1, reinforcement=1 → score = importance exactly
		assert.equal(fresh, 0.7);
		// 60 days × fixed formula → deterministic IEEE-754 value regardless of wall time
		assert.equal(old, 0.10693741342748979);
	});
	it("recall reinforcement raises the score", () => {
		const now = Date.now();
		const cold = effectiveScore(rec({ accessCount: 0, lastAccessedAt: now - 10 * DAY }), now);
		const warm = effectiveScore(rec({ accessCount: 20, lastAccessedAt: now - 10 * DAY }), now);
		// 10 days × fixed formula → deterministic IEEE-754 values; warm > cold by known margin
		assert.equal(cold, 0.27347871875258195);
		assert.equal(warm, 0.3567399283007909);
	});
});

describe("runDecayGc", () => {
	it("prunes a long-neglected low-importance context fact, keeps a fresh one", () => {
		const store = new FactStore(dir);
		const fresh = store.write({ content: "fresh", segment: "context" });
		const stale = store.write({ content: "stale", segment: "context" });
		// Backdate the stale one far past the prune threshold.
		const all = store.readAll();
		const target = all.find((r) => r.memoryId === stale.memoryId)!;
		target.lastAccessedAt = Date.now() - 365 * DAY;
		fs.writeFileSync(store.filePath, all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

		const res = runDecayGc(dir);
		// stale context fact (365 days, score ≈ 3.75e-7) is below PRUNE_THRESHOLD → pruned, not archived
		assert.equal(res.pruned, 1);
		assert.equal(res.archived, 0);
		assert.equal(res.kept, 1);
		const active = store.list();
		// exactly one active record survives: the fresh fact
		assert.equal(active.length, 1);
		assert.equal(active[0]!.memoryId, fresh.memoryId);
		assert.notEqual(active[0]!.memoryId, stale.memoryId);
	});

	it("never prunes a confirmed short/context fact even when its score decays below the prune threshold", () => {
		const store = new FactStore(dir);
		const confirmed = store.write({ content: "User prefers dark mode.", segment: "preference" });
		// Force status=confirmed and backdate far past the prune floor.
		const all = store.readAll();
		const r = all.find((rec) => rec.memoryId === confirmed.memoryId)!;
		r.status = "confirmed";
		r.lastAccessedAt = Date.now() - 365 * DAY;
		fs.writeFileSync(store.filePath, all.map((rec) => JSON.stringify(rec)).join("\n") + "\n", "utf8");

		const res = runDecayGc(dir);
		// confirmed fact must be completely skipped — not pruned, not archived
		assert.equal(res.pruned, 0);
		assert.equal(res.archived, 0);
		assert.equal(res.kept, 1);
		const active = store.list();
		assert.equal(active.length, 1);
		assert.equal(active[0]!.memoryId, confirmed.memoryId);
	});

	it("never touches permanent (identity) facts", () => {
		const store = new FactStore(dir);
		const id = store.write({ content: "User is Bhasvanth.", segment: "identity" }); // permanent
		const all = store.readAll();
		all[0]!.lastAccessedAt = Date.now() - 1000 * DAY;
		fs.writeFileSync(store.filePath, all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
		runDecayGc(dir);
		const surviving = store.list();
		// GC must not touch the permanent fact; it is the only active record
		assert.equal(surviving.length, 1);
		assert.equal(surviving[0]!.memoryId, id.memoryId);
	});
});
