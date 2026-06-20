import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Embedder } from "./embedder.js";
import { HashingEmbedder } from "./embedder.js";
import { recallHybrid, recallHybridAsync } from "./hybrid.js";
import type { MemoryRecord } from "./records.js";
import { bm25Score } from "./scoring.js";

/**
 * Hybrid recall (Tideline v2). Proves the RECOVERY MECHANIC honestly: when the
 * embedder reports a fact as semantically close to a query that shares NO
 * scorable terms with it (the exact failure mode of BM25-only recall), the
 * vector lane recovers it — appended BELOW the lexical hits, never reordering
 * them.
 *
 * The recovery tests use a controllable STUB embedder that stands in for a
 * LEARNED model (the seam's intended production use). The bundled zero-dep HRR
 * embedder is a bag-of-words model and deliberately does NOT do synonymy — its
 * cosine on a true paraphrase sits below `minSim`, by design — so testing
 * recovery through it would either lie (a hash-collision artifact) or be dead.
 * Testing the seam with a stub is the honest contract: "given a real embedder,
 * recovery works."
 */

const NOW = 1_750_000_000_000;
const HOME_QUERY = "which city do I live in"; // shares no scorable term with "reside in Hyderabad"

/** A stub LEARNED embedder: maps the paraphrase query and the home fact to one
 *  unit vector, everything else to an orthogonal one. cosine(query, home) = 1,
 *  cosine(query, other) = 0 — what a real semantic model would yield, made
 *  deterministic. */
function learnedFor(...matches: string[]): Embedder {
	return {
		id: "stub-learned",
		dims: 2,
		embed: (texts) => texts.map((t) => (matches.includes(t) || t.includes("Hyderabad") ? [1, 0] : [0, 1])),
	};
}

function rec(id: string, content: string, embedder: Embedder): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment: "knowledge",
		tier: "long",
		importance: 0.5,
		decayRate: 0.03,
		accessCount: 0,
		lastAccessedAt: NOW,
		createdAt: NOW,
		lifecycle: "active",
		embedding: (embedder.embed([content]) as number[][])[0],
	} as MemoryRecord;
}

describe("hybrid recall — vector lane closes the lexical gap", () => {
	it("a paraphrase BM25 misses is recovered by the vector lane (learned-embedder seam)", () => {
		const emb = learnedFor(HOME_QUERY);
		const facts = [
			rec("home", "I reside in Hyderabad, India", emb),
			rec("editor", "I prefer tabs over spaces when coding", emb),
			rec("coffee", "I drink black coffee with no sugar", emb),
		];
		// Precondition: BM25 alone never surfaces the home fact for this paraphrase.
		assert.notEqual(bm25Score(facts, HOME_QUERY, NOW)[0]?.record.memoryId, "home");

		const hyb = recallHybrid(facts, HOME_QUERY, emb, NOW);
		assert.equal(hyb.length, 1, "only the home fact clears the minSim floor (editor and coffee embed to [0,1])");
		assert.equal(hyb[0]?.record.memoryId, "home", "hybrid recovers the home fact");
		assert.equal(hyb[0]?.vecRank, 1, "the win came through the vector lane at rank 1");
	});

	it("a recovered fact is appended BELOW every lexical hit (no reorder of BM25)", () => {
		// The home fact embeds to [1,0] via the Hyderabad branch, matching the query
		// vector [1,0] ("coffee" → [1,0] too), so it's eligible for vector recovery.
		// The coffee fact is the BM25 hit (shares the literal "coffee" term). Recovery
		// must append the home fact strictly BELOW the lexical coffee hit.
		const emb = learnedFor("coffee");
		const facts = [
			rec("coffee", "I drink black coffee with no sugar", emb),
			rec("home", "I reside in Hyderabad, India", emb),
		];
		const hyb = recallHybrid(facts, "coffee", emb, NOW);
		assert.equal(hyb.length, 2, "exactly one lexical hit (coffee) and one vector recovery (home)");
		assert.equal(hyb[0]?.record.memoryId, "coffee", "the lexical hit ranks first");
		assert.equal(hyb[0]?.lexRank, 1, "coffee is the primary (lexical) hit at lexRank 1");
		assert.equal(hyb[1]?.record.memoryId, "home", "home is appended as the vector recovery in position 1");
		assert.equal(hyb[1]?.vecRank, 1, "home is the first (and only) vector-lane recovery");
		assert.ok((hyb[1]?.score ?? 0) < (hyb[0]?.score ?? 0), "recovered fact scores strictly below the lexical hit");
	});

	it("a lexical-only hit (no embedding on the record) still ranks via BM25", () => {
		const noVec = { ...rec("x", "the deploy token rotates monthly", learnedFor()), embedding: undefined } as MemoryRecord;
		const hyb = recallHybrid([noVec], "deploy token", new HashingEmbedder(256), NOW);
		assert.equal(hyb[0]?.record.memoryId, "x");
		assert.equal(hyb[0]?.vecRank, undefined);
		assert.equal(hyb[0]?.lexRank, 1);
	});

	it("among two vector-recovered facts the more-trusted ranks above (trust beats cosine rank)", () => {
		// Both facts are BM25 misses recovered by the vector lane. The retrieved_document
		// embeds slightly CLOSER to the query (higher cosine ⇒ better vecRank, less
		// 0.9^i damping), but its trust multiplier (0.6) is low enough that the
		// owner_message (trust 1.0) at the next rank still scores strictly higher.
		const emb: Embedder = {
			id: "stub-near",
			dims: 2,
			embed: (texts) =>
				texts.map((t) => {
					if (t === "find my place") return [1, 0]; // query
					if (t === "trusted home note") return [0.5, Math.sqrt(1 - 0.25)]; // cosine 0.5
					if (t === "untrusted home note") return [0.6, Math.sqrt(1 - 0.36)]; // cosine 0.6 (closer)
					return [0, 1];
				}),
		};
		const trusted = { ...rec("trusted", "trusted home note", emb), sourceType: "owner_message" } as MemoryRecord;
		const untrusted = { ...rec("untrusted", "untrusted home note", emb), sourceType: "retrieved_document" } as MemoryRecord;
		// Precondition: neither shares a scorable term with the query ⇒ both are BM25 misses.
		assert.equal(bm25Score([trusted, untrusted], "find my place", NOW).length, 0);

		const hyb = recallHybrid([trusted, untrusted], "find my place", emb, NOW);
		assert.equal(hyb.length, 2, "both facts are recovered by the vector lane");
		assert.equal(hyb[0]?.record.memoryId, "trusted", "the higher-trust fact ranks first despite lower cosine");
		assert.equal(hyb[1]?.record.memoryId, "untrusted", "the lower-trust fact ranks second despite higher cosine");
		// untrusted is cosine-closer (0.6) so it gets vecRank 1; trusted is further (0.5) so vecRank 2.
		assert.equal(hyb[0]?.vecRank, 2, "trusted: cosine 0.5 → vecRank 2 (second in raw cosine order)");
		assert.equal(hyb[1]?.vecRank, 1, "untrusted: cosine 0.6 → vecRank 1 (first in raw cosine order)");
		assert.ok((hyb[0]?.score ?? 0) > (hyb[1]?.score ?? 0), "the more-trusted recovered fact scores strictly higher");
	});

	it("a fact whose cosine is just below the minSim floor is NOT recovered", () => {
		// Two BM25-miss facts: one embeds just ABOVE the 0.3 floor (cosine 0.31 ⇒
		// recovered) and one just BELOW it (cosine 0.29 ⇒ rejected). The sub-floor
		// fact must be absent from the result.
		const above = Math.sqrt(1 - 0.31 ** 2);
		const below = Math.sqrt(1 - 0.29 ** 2);
		const emb: Embedder = {
			id: "stub-floor",
			dims: 2,
			embed: (texts) =>
				texts.map((t) => {
					if (t === "locate me") return [1, 0]; // query
					if (t === "just above the floor") return [0.31, above]; // cosine 0.31
					if (t === "just below the floor") return [0.29, below]; // cosine 0.29
					return [0, 1];
				}),
		};
		const aboveRec = rec("above", "just above the floor", emb);
		const belowRec = rec("below", "just below the floor", emb);

		const hyb = recallHybrid([aboveRec, belowRec], "locate me", emb, NOW);
		assert.equal(hyb.length, 1, "exactly one fact clears the minSim floor (0.31 ≥ 0.3; 0.29 < 0.3)");
		assert.equal(hyb[0]?.record.memoryId, "above", "the above-floor fact is recovered and is the only result");
	});

	it("empty candidates → empty", () => {
		assert.deepEqual(recallHybrid([], "x", learnedFor(), NOW), []);
	});
});

describe("hybrid recall — MMR diversity (opt-in λ<1)", () => {
	/** Maps content to a fixed vector by a per-record tag (so two records can share
	 *  a near-duplicate vector while differing in text). The query maps to the same
	 *  axis as the duplicates so they're all relevant. */
	function vecBy(map: Record<string, number[]>, queryVec: number[]): Embedder {
		return {
			id: "stub-vec",
			dims: 2,
			embed: (texts) => texts.map((t) => map[t] ?? queryVec),
		};
	}

	it("λ=0.7 demotes a near-duplicate-embedding fact vs λ=1 (pure relevance)", () => {
		// Three facts, all BM25 hits. dupA and dupB are identical text ⇒ identical
		// ([1,0]) embeddings (cosine=1, a near-duplicate pair); distinct has a lower
		// BM25 score and an orthogonal ([0,1]) embedding. Under λ=1 MMR is a noop, so
		// the order is by relevance: dupA, dupB, distinct. Under λ=0.7 the second
		// near-duplicate is penalised for similarity to the first, flipping distinct
		// above dupB.
		const QUERY = "weekly report alpha";
		const emb = vecBy({ [QUERY]: [1, 0], "weekly report alpha plus extra trailing words here": [0, 1] }, [1, 0]);
		const facts = [
			rec("dupA", QUERY, emb),
			rec("dupB", QUERY, emb),
			rec("distinct", "weekly report alpha plus extra trailing words here", emb),
		];

		const plain = recallHybrid(facts, QUERY, emb, NOW, { mmrLambda: 1 });
		const diverse = recallHybrid(facts, QUERY, emb, NOW, { mmrLambda: 0.7 });

		const rankIn = (res: ReturnType<typeof recallHybrid>, id: string) => res.findIndex((h) => h.record.memoryId === id);
		// λ=1: pure relevance ⇒ dupA(0), dupB(1), distinct(2) — both duplicates above distinct.
		assert.equal(rankIn(plain, "dupA"), 0, "λ=1: dupA is first (highest BM25, inserted first)");
		assert.equal(rankIn(plain, "dupB"), 1, "λ=1: dupB is second (same BM25 as dupA, inserted second)");
		assert.equal(rankIn(plain, "distinct"), 2, "λ=1: distinct is last (lower BM25 score)");
		// λ=0.7: MMR penalises dupB (cosine=1 to already-selected dupA); distinct gets rank 1.
		assert.equal(rankIn(diverse, "dupA"), 0, "λ=0.7: dupA still first (highest MMR on first pick)");
		assert.equal(rankIn(diverse, "distinct"), 1, "λ=0.7: distinct promoted to second by diversity");
		assert.equal(rankIn(diverse, "dupB"), 2, "λ=0.7: dupB demoted to last (penalised for near-duplicate cosine with dupA)");
	});

	it("recallHybridAsync smoke: pre-embeds the query and recovers like the sync path", async () => {
		const emb = learnedFor(HOME_QUERY);
		const facts = [
			rec("home", "I reside in Hyderabad, India", emb),
			rec("coffee", "I drink black coffee with no sugar", emb),
		];
		const hyb = await recallHybridAsync(facts, HOME_QUERY, emb, NOW);
		assert.equal(hyb.length, 1, "async path: only the home fact clears the cosine floor");
		assert.equal(hyb[0]?.record.memoryId, "home", "async path recovers the home fact via the vector lane");
		assert.equal(hyb[0]?.vecRank, 1, "async path: home is vecRank 1 (the only vector recovery)");
	});
});

describe("hybrid recall — trust modulates equal-BM25 facts", () => {
	it("trusted sourceType ranks first among equal-BM25 facts (trustFactor)", () => {
		const emb = learnedFor();
		// Two facts with IDENTICAL content ⇒ identical BM25 score; they differ ONLY in
		// sourceType. trustFactor down-weights the externally-ingested document, so the
		// owner_message ranks first.
		const content = "the staging password rotates on the first of the month";
		const trusted = { ...rec("trusted", content, emb), sourceType: "owner_message" } as MemoryRecord;
		const untrusted = { ...rec("untrusted", content, emb), sourceType: "retrieved_document" } as MemoryRecord;

		// Order untrusted first to prove ranking is by trust, not input order / tiebreak.
		const hyb = recallHybrid([untrusted, trusted], "staging password rotates", emb, NOW);
		assert.equal(hyb[0]?.record.memoryId, "trusted", "the owner_message (higher trust) ranks first");
		assert.ok((hyb[0]?.score ?? 0) > (hyb[1]?.score ?? 0), "trusted fact scores strictly higher");
	});
});
