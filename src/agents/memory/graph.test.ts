import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildGraph, neighbors, resolveEntities, spread, synonymyEdges, TRANSITION_KINDS } from "./graph.js";
import type { MemoryLink } from "./links.js";
import { FactStore, type MemoryRecord } from "./records.js";

/**
 * Tideline Step 19 — the queryable memory graph + entity resolution.
 * Pins: adjacency build (forward + backlinks, dangling-edge drop), bounded
 * multi-hop spread (the step-20 substrate), model-free entity resolution
 * (recurring proper nouns, stopword + frequency filtered), synonymy edges over
 * the embedding space, and the transition edge emitted on every supersede.
 */

function rec(id: string, content: string, links: MemoryLink[] = [], extra: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment: "knowledge",
		tier: "long",
		importance: 0.6,
		decayRate: 0.03,
		accessCount: 0,
		createdAt: 1,
		lastAccessedAt: 1,
		lifecycle: "active",
		links,
		...extra,
	} as MemoryRecord;
}

describe("graph — adjacency + neighbours", () => {
	it("builds forward + backlink adjacency and drops edges pointing outside the set", () => {
		const records = [
			rec("a", "alpha", [{ kind: "relates", target: "b" }, { kind: "derived_from", target: "ghost" }]),
			rec("b", "beta", [{ kind: "supports", target: "c" }]),
			rec("c", "gamma"),
		];
		const g = buildGraph(records);
		// dangling edge a→ghost dropped (ghost not in set)
		assert.deepEqual(neighbors(g, "a", { direction: "out" }).sort(), ["b"]);
		// backlinks: c is pointed at by b
		assert.deepEqual(neighbors(g, "c", { direction: "in" }), ["b"]);
		// both directions, deduped
		assert.deepEqual(neighbors(g, "b").sort(), ["a", "c"]);
		// kind filter
		assert.deepEqual(neighbors(g, "b", { direction: "in", kinds: ["relates"] }), ["a"]);
		assert.deepEqual(neighbors(g, "b", { direction: "in", kinds: ["contradicts"] }), []);
	});

	it("spread is a bounded BFS: maxHops cap on a chain", () => {
		const chain: MemoryRecord[] = [
			rec("a", "a", [{ kind: "relates", target: "b" }]),
			rec("b", "b", [{ kind: "relates", target: "c" }]),
			rec("c", "c", [{ kind: "relates", target: "d" }]),
			rec("d", "d"),
		];
		const g = buildGraph(chain);
		const hops = spread(g, ["a"], { maxHops: 2 });
		assert.equal(hops.get("a"), 0);
		assert.equal(hops.get("b"), 1);
		assert.equal(hops.get("c"), 2);
		assert.equal(hops.has("d"), false, "d is 3 hops away — beyond maxHops 2");
	});

	it("spread honours the per-node fan-out cap, maxHops:0, and seed-not-in-graph", () => {
		const hub = rec("hub", "hub", Array.from({ length: 20 }, (_, i) => ({ kind: "relates" as const, target: `h${i}` })));
		const leaves = Array.from({ length: 20 }, (_, i) => rec(`h${i}`, `leaf ${i}`));
		const g = buildGraph([hub, ...leaves]);
		assert.equal(spread(g, ["hub"], { maxHops: 1, fanOut: 5 }).size, 1 + 5, "fan-out 5 caps hop-1 to 5 of 20");
		assert.equal(spread(g, ["hub"], { maxHops: 1, fanOut: 100 }).size, 1 + 20, "a wide fan-out reaches all 20");
		assert.equal(spread(g, ["hub"], { maxHops: 0 }).size, 1, "maxHops 0 = seed only");
		assert.equal(spread(g, ["nope"], { maxHops: 2 }).size, 0, "a seed not in the graph yields nothing");
	});
});

describe("graph — entity resolution (model-free)", () => {
	it("surfaces recurring proper nouns, filters stopwords + one-offs", () => {
		const records = [
			rec("1", "User moved to Bangalore last year."),
			rec("2", "The weather in Bangalore is mild."),
			rec("3", "User adopted a dog named Biscuit."),
			rec("4", "Biscuit is a golden retriever."),
			rec("5", "User visited Paris once."), // Paris appears once → below threshold
		];
		const entities = resolveEntities(records, { minMentions: 2 });
		const names = entities.map((e) => e.name);
		// Exactly 2 entities survive (Bangalore + Biscuit); Paris/User/The/year/last are filtered.
		// Sort: same mention count (2 each) → alphabetical: "Bangalore" < "Biscuit".
		assert.equal(entities.length, 2, "exactly 2 entities survive the minMentions:2 threshold");
		assert.deepEqual(names, ["Bangalore", "Biscuit"], "exact entity set in mention-desc + alpha order");
		const bangalore = entities.find((e) => e.name === "Bangalore");
		assert.deepEqual(bangalore?.mentions.sort(), ["1", "2"]);
	});

	it("the per-fact dedup is real: in-fact repetition does NOT skew the casing winner", () => {
		// fact 1 repeats ALL-CAPS "ATLAS" 3× within one fact; facts 2-3 use "Atlas".
		// With the per-fact `seen` guard: forms = {ATLAS:1, Atlas:2} → winner "Atlas".
		// WITHOUT it: forms = {ATLAS:3, Atlas:2} → winner "ATLAS". So the casing
		// winner discriminates the guard (a plain count would not).
		const records = [
			rec("1", "ATLAS shipped. ATLAS wins. ATLAS again."),
			rec("2", "Atlas is fine."),
			rec("3", "Atlas again."),
		];
		const [atlas] = resolveEntities(records, { minMentions: 2 });
		assert.equal(atlas?.name, "Atlas", "in-fact ALL-CAPS repetition counted ONCE, so 'Atlas' (2 facts) wins");
		assert.equal(atlas?.mentions.length, 3, "three distinct facts mention it");
	});
});

describe("graph — synonymy edges", () => {
	it("links pairs whose embeddings exceed the cosine threshold", () => {
		// Identical content ⇒ identical HRR embedding ⇒ cosine 1.0 ≥ threshold.
		const records = [
			rec("a", "I live in Hyderabad and love it"),
			rec("b", "I live in Hyderabad and love it"),
			rec("c", "completely unrelated text about quantum mechanics"),
		];
		const edges = synonymyEdges(records, { threshold: 0.8 });
		const ab = edges.find((e) => e.from === "a" && e.to === "b");
		assert.ok(ab, "a and b (identical) are synonymy-linked");
		// Identical content → identical HRR vector → cosine ≈ 1.0 (≥ 1.0 within float rounding; far above the 0.8 bar).
		assert.ok(ab!.sim >= 1 - Number.EPSILON * 2, `identical content yields cosine sim ≈ 1.0, got ${ab!.sim}`);
		// Exactly one edge (a–b); c is not linked to anything at this threshold.
		assert.equal(edges.length, 1, "only the a–b pair survives; c produces no edge");
		assert.ok(!edges.some((e) => e.from === "c" || e.to === "c"), "unrelated text not linked");
	});
});

describe("graph — transition edges on supersede (Step 19)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-graph-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("a subjectKey supersede records BOTH a contradicts AND a transition edge", () => {
		const store = new FactStore(dir);
		const first = store.write({ content: "I live in Bangalore", segment: "identity", subjectKey: "home_city" });
		const second = store.write({ content: "I live in Hyderabad now", segment: "identity", subjectKey: "home_city" });
		const links = second.links ?? [];
		// The subjectKey path flatMaps exactly one slotSuperseded entry → 2 links total.
		assert.equal(links.length, 2, "exactly 2 links emitted: one contradicts + one transition");
		// Sorted by kind for deterministic deepEqual (alphabetical: contradicts < transition).
		assert.deepEqual(
			[...links].sort((a, b) => a.kind.localeCompare(b.kind)),
			[
				{ kind: "contradicts", target: first.memoryId },
				{ kind: "transition", target: first.memoryId },
			],
			"both contradicts and transition edges point at the superseded memoryId",
		);
		// And the graph sees it as a temporal edge from new → old, via the
		// transition-kind filter.
		const g = buildGraph(store.readAll());
		assert.deepEqual(
			neighbors(g, second.memoryId, { direction: "out", kinds: TRANSITION_KINDS }),
			[first.memoryId],
			"the transition is traversable via the transition-kind filter",
		);
		// Boundary: the SAME query with an unrelated kind returns nothing — proves
		// the kind filter actually GATES (not just that a constant holds a literal).
		assert.deepEqual(
			neighbors(g, second.memoryId, { direction: "out", kinds: ["supports"] }),
			[],
			"a non-transition kind filter excludes the edge",
		);
	});
});
