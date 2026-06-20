import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { queryMemory } from "./query.js";
import { FactStore } from "./records.js";

describe("queryMemory — passive operator memory inspection", () => {
	let dir: string;
	let store: FactStore;
	let clock: number;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mq-"));
		clock = 1000;
		store = new FactStore(dir, { now: () => clock });
		store.write({ content: "I keep a strict vegetarian diet.", segment: "preference" });
		clock = 2000;
		store.write({ content: "I live in Hyderabad, India.", segment: "identity" });
		clock = 3000;
		store.write({ content: "I prefer tabs over spaces.", segment: "preference" });
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("stats: active + by-segment + owner/channel + added-7d", () => {
		const r = queryMemory(store, { action: "stats", now: 3000 });
		assert.equal(r.action, "stats");
		assert.equal(r.stats?.active, 3);
		assert.equal(r.stats?.total, 3);
		assert.equal(r.stats?.bySegment.preference, 2);
		assert.equal(r.stats?.bySegment.identity, 1);
		assert.equal(r.stats?.owner, 3);
		assert.equal(r.stats?.channel, 0);
		assert.equal(r.stats?.addedLast7d, 3);
	});

	it("list: active facts newest-first", () => {
		const r = queryMemory(store, { action: "list" });
		assert.equal(r.facts.length, 3);
		assert.equal(r.facts[0]?.content, "I prefer tabs over spaces.");
		assert.equal(r.facts[2]?.content, "I keep a strict vegetarian diet.");
		assert.equal(r.facts[0]?.origin, "owner");
	});

	it("search: token-overlap match, scored, and PASSIVE (no decay reinforcement)", () => {
		const before = new FactStore(dir).readAll().map((x) => x.lastAccessedAt).sort();
		const r = queryMemory(store, { action: "search", query: "vegetarian diet" });
		assert.equal(r.facts.length, 1);
		assert.equal(r.facts[0]?.content, "I keep a strict vegetarian diet.");
		assert.ok((r.facts[0]?.score ?? 0) >= 1, "overlap score recorded");
		const after = new FactStore(dir).readAll().map((x) => x.lastAccessedAt).sort();
		assert.deepEqual(after, before, "search must NOT reinforce decay (it is an inspection view)");
		// Stem/prefix-forgiving: "vegetar" should still find "vegetarian" (operators search stems).
		assert.ok(
			queryMemory(store, { action: "search", query: "vegetar" }).facts.some((f) => f.content.includes("vegetarian")),
			"prefix search finds the stem",
		);
	});

	it("inspect: one fact by id; empty for an unknown id", () => {
		const id = store.readAll()[0]?.memoryId ?? "";
		assert.equal(queryMemory(store, { action: "inspect", memoryId: id }).facts.length, 1);
		assert.equal(queryMemory(store, { action: "inspect", memoryId: "does-not-exist" }).facts.length, 0);
	});

	it("lifecycle field: active facts expose 'active'; archived facts expose 'archived'", () => {
		// All three facts are active — lifecycle should be "active" on list output.
		const listResult = queryMemory(store, { action: "list" });
		assert.ok(listResult.facts.length > 0, "expected at least one fact");
		for (const f of listResult.facts) {
			assert.equal(f.lifecycle, "active", `expected lifecycle "active", got "${f.lifecycle}"`);
		}

		// Archive the first fact by superseding it, then inspect it directly.
		const allRecords = store.readAll();
		const first = allRecords[0];
		assert.ok(first, "expected a first record");
		store.write({
			content: "I keep a strict plant-based diet.",
			segment: "preference",
			supersedes: [first.memoryId],
		});
		// inspect uses readAll (all lifecycles), so the archived fact is accessible by id.
		const inspected = queryMemory(store, { action: "inspect", memoryId: first.memoryId });
		assert.equal(inspected.facts.length, 1, "inspect should find the archived fact");
		assert.equal(inspected.facts[0]?.lifecycle, "archived", "archived fact should expose lifecycle='archived'");
	});
});
