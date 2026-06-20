import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { getDefaultEmbedder } from "./embedder.js";
import { recallWithGraph } from "./graph-recall.js";
import { recallHybrid } from "./hybrid.js";
import type { MemoryLink } from "./links.js";
import type { MemoryRecord } from "./records.js";

/**
 * Tideline Step 20 — graph-augmented recall (the gated walk).
 * The two load-bearing properties: (1) a multi-hop / relational query SPREADS
 * over the graph and surfaces a connected fact the seed query didn't directly
 * hit; (2) a plain single-fact query is left EXACTLY as the hybrid produced it
 * (the route-gate declines) — no reorder, no graph pollution.
 */

function rec(id: string, content: string, links: MemoryLink[] = []): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment: "knowledge",
		tier: "long",
		importance: 0.6,
		decayRate: 0.03,
		accessCount: 0,
		createdAt: Number.parseInt(id.replace(/\D/g, ""), 10) || 1,
		lastAccessedAt: 1,
		lifecycle: "active",
		links,
	} as MemoryRecord;
}

const NOW = 1_000_000;

describe("graph-recall — the walk surfaces connected context", () => {
	it("a relational query spreads from the seed to a graph-linked fact", () => {
		const recs = [
			rec("1", "My manager is Sarah", [{ kind: "relates", target: "2" }]),
			rec("2", "Sarah leads the platform infrastructure team"),
			rec("3", "I drink black coffee in the morning"),
		];
		const out = recallWithGraph(recs, "who is connected to my manager", { limit: 5 }, NOW);
		const two = out.find((r) => r.record.memoryId === "2");
		assert.ok(two, "the 2-hop fact about Sarah's team surfaced");
		assert.equal(two!.viaGraph, true, "it came in via the graph walk, not a direct hybrid hit");
		// the unrelated coffee fact should not be pulled in by the walk
		const three = out.find((r) => r.record.memoryId === "3");
		assert.ok(!three || !three.viaGraph, "unrelated fact not graph-activated");
	});

	it("the inter-seed-edge gate branch engages the walk with NO temporal/relational query words", () => {
		// Exercises shouldWalk's SECOND branch (an edge BETWEEN two seeds), distinct
		// from the TEMPORAL/RELATIONAL regex branch. recs 1 & 2 both match the query
		// (seeds) and link to each other → the gate engages even though the query has
		// no marker word → the 2-hop fact (3), which shares NO query tokens, surfaces.
		const recs = [
			rec("1", "Sarah leads the platform group", [{ kind: "relates", target: "2" }]),
			rec("2", "Sarah leads the data group", [{ kind: "relates", target: "3" }]),
			rec("3", "Aurora is the internal migration codename"),
		];
		const query = "what does Sarah lead"; // no when/before/related/because/etc.
		const out = recallWithGraph(recs, query, { limit: 5 }, NOW);
		assert.equal(out.length, 3, "all three records surface: both seeds and the graph-reached non-matching fact");
		const three = out.find((r) => r.record.memoryId === "3");
		assert.ok(three?.viaGraph, "the inter-seed edge engaged the walk; the linked non-matching fact surfaced");
	});
});

describe("graph-recall — single-fact flat (the route-gate guarantee)", () => {
	it("a plain query with no temporal/relational markers and no inter-seed edges == pure hybrid", () => {
		const recs = [
			rec("1", "I prefer dark mode in my editor"),
			rec("2", "My favourite colour is teal"),
			rec("3", "I use a mechanical keyboard"),
		];
		const query = "what editor theme do I prefer";
		const hybrid = recallHybrid(recs, query, getDefaultEmbedder(), NOW, { limit: 5 });
		const graph = recallWithGraph(recs, query, { limit: 5 }, NOW);

		assert.equal(graph[0]?.record.memoryId, hybrid[0]?.record.memoryId, "top hit identical");
		assert.equal(graph.length, hybrid.length, "same result set size");
		assert.ok(graph.every((r) => !r.viaGraph), "nothing pulled in via graph — the gate declined");
		// full order preserved
		assert.deepEqual(
			graph.map((r) => r.record.memoryId),
			hybrid.map((s) => s.record.memoryId),
			"order is exactly the hybrid order",
		);
	});

	it("forceWalk overrides the gate (for eval), but an isolated corpus still can't fabricate edges", () => {
		const recs = [rec("1", "I like tea"), rec("2", "The sky is blue")];
		const out = recallWithGraph(recs, "tea", { limit: 5, forceWalk: true }, NOW);
		assert.equal(out.length, 1, "only rec 1 matches — no edges mean the graph lane adds nothing");
		assert.equal(out[0]?.record.memoryId, "1", "the single result is the BM25 hit");
		assert.ok(out.every((r) => !r.viaGraph), "no edges in this corpus → nothing via graph even when forced");
	});

	it("the gate MEASURABLY suppresses the walk — gated vs forceWalk DIVERGE on a linked corpus", () => {
		// A discriminating fixture (the prior tests can't catch an always-on gate:
		// with no surfaceable neighbour, gated == forced trivially). Here rec 1 (the
		// only BM25 hit) has a relates-edge to rec 2, which shares NO query tokens and
		// has no embedding — BM25 AND the vector lane both miss it, so only the graph
		// walk can surface it. On a non-relational / non-temporal query the gate must
		// DECLINE → rec 2 stays hidden (len 1). forceWalk surfaces it via the edge
		// (len 2). A regressed always-walk gate would make gated == forced and FAIL.
		const recs = [
			rec("1", "I prefer dark mode in my editor", [{ kind: "relates", target: "2" }]),
			rec("2", "Solarized was configured one season"),
		];
		const query = "what editor theme do I prefer"; // no temporal / relational marker
		const gated = recallWithGraph(recs, query, { limit: 5 }, NOW);
		const forced = recallWithGraph(recs, query, { limit: 5, forceWalk: true }, NOW);

		assert.equal(gated.length, 1, "gate declined → only the direct hit");
		assert.equal(gated[0]?.record.memoryId, "1");
		assert.ok(gated.every((r) => !r.viaGraph), "no graph activation while the gate is active");

		assert.equal(forced.length, 2, "force-walked corpus surfaces both: the BM25 seed and the graph-reached rec 2");
		const forcedTwo = forced.find((r) => r.record.memoryId === "2");
		assert.ok(forcedTwo?.viaGraph, "forced walk surfaced rec 2 via the graph edge");
	});
});

describe("graph-recall — bi-temporal valid-time gate", () => {
	it("a still-active fact whose future-dated validTo has now passed is NOT surfaced (matches FactStore.recall)", () => {
		// Regression guard. recallWithGraph used to filter only `lifecycle`, so an
		// expired-but-still-active fact leaked into the model's pre-turn context via
		// the graph path while FactStore.recall() correctly excluded it. The valid-
		// time gate now lives INSIDE recallWithGraph, protecting BOTH production
		// callers (auto-recall + the graph eval capability).
		const expired = rec("1", "I prefer dark mode in my editor");
		(expired as { validTo?: number }).validTo = NOW - 1; // expired a tick ago; lifecycle still "active"
		const live = rec("2", "I prefer a light editor theme");
		const out = recallWithGraph([expired, live], "what editor theme do I prefer", { limit: 5 }, NOW);

		assert.ok(!out.some((r) => r.record.memoryId === "1"), "expired (passed validTo) fact excluded from recall");
		assert.equal(out.length, 1, "only the still-valid fact survives the bi-temporal gate");
		assert.equal(out[0]?.record.memoryId, "2", "the still-valid fact is the sole result");
	});

	it("a future validTo that has NOT yet passed still surfaces (the fact is currently valid)", () => {
		const future = rec("1", "I prefer dark mode in my editor");
		(future as { validTo?: number }).validTo = NOW + 1_000; // valid well past `now`
		const out = recallWithGraph([future], "what editor theme do I prefer", { limit: 5 }, NOW);
		assert.equal(out.length, 1, "a not-yet-expired fact is recalled normally");
	});
});
