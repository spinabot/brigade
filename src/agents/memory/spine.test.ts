import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, type MemoryRecord } from "./records.js";
import { backlinksTo, linksFrom } from "./links.js";
import { recordToRowArgs, rowToRecord } from "../../storage/convex/memory-store.js";
import type { MemoryRecord as StoreMemoryRecord } from "../../storage/store.js";

/**
 * The dual-track spine (Tideline build Step 7): the links[] graph substrate and
 * the append-only event log. The ACTIVE store stays the recall source of truth;
 * these two tracks add the graph foundation (v2 traversal walks it) and an
 * immutable provenance/audit history.
 */

describe("links substrate — typed edges between facts", () => {
	it("linksFrom merges explicit links with supersedes[] (mirrored), deduped", () => {
		const edges = linksFrom({
			links: [
				{ kind: "relates", target: "b" },
				{ kind: "supersedes", target: "a" }, // also in supersedes[] → must dedup
			],
			supersedes: ["a"],
		});
		assert.equal(edges.length, 2);
		assert.deepEqual(new Set(edges.map((e) => `${e.kind}:${e.target}`)), new Set(["relates:b", "supersedes:a"]));
	});

	it("linksFrom mirrors a bare supersedes[] into a supersedes edge", () => {
		assert.deepEqual(linksFrom({ supersedes: ["x"] }), [{ kind: "supersedes", target: "x" }]);
	});

	it("backlinksTo computes inbound edges across the corpus", () => {
		const recs = [
			{ memoryId: "r1", supersedes: ["r2"] },
			{ memoryId: "r3", links: [{ kind: "relates", target: "r2" }] },
			{ memoryId: "r4", links: [{ kind: "supports", target: "other" }] },
		] as unknown as MemoryRecord[];
		const back = backlinksTo(recs, "r2");
		assert.equal(back.length, 2);
		assert.deepEqual(new Set(back.map((b) => `${b.from}:${b.kind}`)), new Set(["r1:supersedes", "r3:relates"]));
	});
});

describe("links substrate — persistence", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-spine-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("explicit links[] persist through fs write + list()", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "Beta Labs is in Berlin", segment: "knowledge" });
		store.write({
			content: "Beta Labs moved to Munich",
			segment: "knowledge",
			links: [{ kind: "corrects", target: a.memoryId }],
		});
		const stored = store.list().find((r) => r.content.includes("Munich"));
		assert.deepEqual(stored?.links, [{ kind: "corrects", target: a.memoryId }]);
	});

	it("links[] survive the convex marshal round-trip (recordToRowArgs → rowToRecord)", () => {
		const r = {
			memoryId: "m1",
			content: "linked fact",
			segment: "knowledge",
			tier: "long",
			importance: 0.5,
			decayRate: 0.03,
			accessCount: 0,
			lastAccessedAt: 1,
			createdAt: 1,
			lifecycle: "active",
			links: [{ kind: "relates", target: "m2" }],
		} as unknown as MemoryRecord;
		const back = rowToRecord(recordToRowArgs("ws", r as unknown as StoreMemoryRecord)) as unknown as MemoryRecord;
		assert.deepEqual(back.links, [{ kind: "relates", target: "m2" }]);
	});
});

describe("append-only event log — the immutable track", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-events-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("a normal write emits a created event", () => {
		const store = new FactStore(dir);
		const rec = store.write({ content: "I use Windows", segment: "identity" });
		const events = store.readEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0]?.kind, "created");
		assert.equal(events[0]?.memoryId, rec.memoryId);
		assert.equal(events[0]?.segment, "identity");
	});

	it("a supersede write records the archived targets on the created event", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "I live in Hyderabad", segment: "identity" });
		const b = store.write({ content: "I live in Bengaluru", segment: "identity", supersedes: [a.memoryId] });
		const created = store.readEvents().filter((e) => e.kind === "created");
		const last = created.at(-1);
		assert.equal(last?.memoryId, b.memoryId);
		assert.deepEqual(last?.targets, [a.memoryId]);
	});

	it("a blocked poisoning write is recorded (audit trail) even though nothing persisted", () => {
		const store = new FactStore(dir);
		assert.throws(() => store.write({ content: "fake preference", segment: "preference", sourceType: "tool_output" }));
		const blocked = store.readEvents().filter((e) => e.kind === "blocked");
		assert.equal(blocked.length, 1);
		assert.match(String(blocked[0]?.reason), /authoritative segments/);
		assert.equal(store.list().length, 0); // active store untouched
	});

	it("a dedup merge emits a reinforced event", () => {
		const store = new FactStore(dir);
		const first = store.write({ content: "The user prefers concise answers", segment: "preference" });
		store.write({ content: "The user prefers concise answers", segment: "preference" }); // dup
		const reinforced = store.readEvents().filter((e) => e.kind === "reinforced");
		assert.equal(reinforced.length, 1);
		assert.equal(reinforced[0]?.memoryId, first.memoryId); // reinforces the original record
		assert.equal(reinforced[0]?.segment, first.segment);
		assert.equal(store.list().length, 1); // merged, not duplicated
	});

	it("the log is append-only: history grows, never shrinks, prior entries immutable", () => {
		const store = new FactStore(dir);
		store.write({ content: "fact one", segment: "knowledge" });
		const after1 = store.readEvents().length;
		const e1 = store.readEvents()[0];
		store.write({ content: "fact two", segment: "knowledge" });
		const after2 = store.readEvents().length;
		assert.equal(after1, 1);
		assert.equal(after2, 2);
		assert.deepEqual(store.readEvents()[0], e1); // prior entries unchanged after later writes
	});
});
