import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../records.js";
import { GOLD_CATEGORIES, type GoldSpec, seedGold } from "./gold.js";
import { SYNTHETIC_GOLD } from "./gold-synthetic.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-gold-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("seedGold", () => {
	it("writes facts and resolves case relevantKeys → real memoryIds", () => {
		const store = new FactStore(dir);
		const spec: GoldSpec = {
			facts: [
				{ key: "a", content: "fact about apples", segment: "knowledge" },
				{ key: "b", content: "fact about bananas", segment: "knowledge" },
			],
			cases: [{ id: "c1", query: "apples", relevantKeys: ["a"], category: "single-session" }],
		};
		const cases = seedGold(store, spec);
		assert.equal(cases.length, 1);
		assert.equal(cases[0]!.relevantIds.length, 1);
		// the resolved id must be a real, active record in the store
		const active = store.list();
		assert.equal(active.length, 2, "both seeded facts must be active (no supersede in this spec)");
		const matched = active.find((r) => r.memoryId === cases[0]!.relevantIds[0]);
		assert.ok(matched, "the resolved relevantId must map to an active record");
		assert.equal(matched!.content, "fact about apples", "the resolved record must be the one keyed 'a'");
	});

	it("applies supersedes — the stale fact is archived, only the new one is active", () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, {
			facts: [
				{ key: "old", content: "I work at Acme", segment: "project" },
				{ key: "new", content: "I now work at Beta", segment: "project", supersedesKeys: ["old"] },
			],
			cases: [{ id: "c", query: "where do I work", relevantKeys: ["new"], category: "knowledge-update" }],
		});
		const active = store.list(); // active-only
		assert.equal(active.length, 1, "old employer fact is archived by the supersede");
		assert.match(active[0]!.content, /Beta/);
		// the case points at the live record
		assert.equal(cases[0]!.relevantIds[0], active[0]!.memoryId);
	});

	it("throws loudly on a case referencing an unknown fact key", () => {
		const store = new FactStore(dir);
		assert.throws(
			() =>
				seedGold(store, {
					facts: [{ key: "a", content: "x", segment: "knowledge" }],
					cases: [{ id: "c", query: "q", relevantKeys: ["does-not-exist"], category: "single-session" }],
				}),
			/unknown fact key/,
		);
	});

	it("throws when write-time dedup merges two distinct gold keys into one record", () => {
		const store = new FactStore(dir);
		// identical content + identical default-owner origin (no createdBy) ⇒
		// FactStore.write merges the second fact into the first and returns the
		// same memoryId, so the seenIds collision guard must fire.
		assert.throws(
			() =>
				seedGold(store, {
					facts: [
						{ key: "a", content: "I prefer dark mode", segment: "preference" },
						{ key: "b", content: "I prefer dark mode", segment: "preference" },
					],
					cases: [],
				}),
			/dedup merged/,
		);
	});

	it("throws when a supersedesKey isn't written earlier", () => {
		const store = new FactStore(dir);
		assert.throws(
			() =>
				seedGold(store, {
					facts: [{ key: "new", content: "x", segment: "project", supersedesKeys: ["old"] }],
					cases: [],
				}),
			/must be listed earlier/,
		);
	});
});

describe("SYNTHETIC_GOLD", () => {
	it("seeds cleanly and every case resolves", () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		assert.equal(cases.length, 13, "SYNTHETIC_GOLD has exactly 13 cases");
		// non-abstention cases resolve to ≥1 id; abstention cases resolve to 0
		const active = store.list(); // active-only
		const activeById = new Map(active.map((r) => [r.memoryId, r]));
		for (const c of cases) {
			if (c.category === "abstention") {
				assert.equal(c.relevantIds.length, 0);
			} else {
				assert.ok(c.relevantIds.length >= 1, `case ${c.id} must have a relevant id`);
				// each relevant id must map to an ACTIVE record (not an archived/superseded
				// one) carrying real content — a stale label would silently score wrong.
				for (const id of c.relevantIds) {
					const rec = activeById.get(id);
					assert.ok(rec, `case ${c.id} relevant id ${id} must be an active record`);
					assert.ok(rec!.content.length > 0, `case ${c.id} relevant record must have content`);
				}
			}
		}
	});

	it("covers every taxonomy bucket the plan calls for", () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const present = new Set(cases.map((c) => c.category));
		for (const cat of GOLD_CATEGORIES) {
			assert.ok(present.has(cat), `synthetic gold is missing the "${cat}" category`);
		}
		// reverse direction: every case category must be a known taxonomy bucket —
		// catches a typo'd category in a real gold set (it would never be scored).
		const known = new Set<string>(GOLD_CATEGORIES);
		for (const c of cases) {
			assert.ok(c.category && known.has(c.category), `case ${c.id} has unknown category "${c.category}"`);
		}
	});

	it("the knowledge-update answer is the NEW employer, not the archived one", () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const jobNow = cases.find((c) => c.id === "g-job-now");
		assert.ok(jobNow);
		const active = store.list();
		const relevant = active.find((r) => r.memoryId === jobNow!.relevantIds[0]);
		assert.ok(relevant, "the knowledge-update relevant id is an ACTIVE record");
		assert.match(relevant!.content, /Beta Labs/);
	});
});
