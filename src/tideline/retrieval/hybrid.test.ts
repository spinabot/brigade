import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Embedder } from "../embeddings/embedder.js";
import { cosine, HashingEmbedder, HrrEmbedder } from "../embeddings/embedder.js";
import { recallWithGraph, recallWithGraphAsync } from "./graph-recall.js";
import { recallHybrid, recallHybridAsync } from "./hybrid.js";
import type { MemoryRecord } from "../store/records.js";
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

describe("hybrid recall — model-free abstention without losing recovery", () => {
	// Independent of the gold fixtures: unrelated office/workflow facts share the
	// question scaffolding, but none answers the personal-attribute queries below.
	const contents = [
		"My backup schedule is nightly.",
		"My printer is connected by cable.",
		"I keep my bicycle in the shed.",
		"My appointment is on Tuesday.",
		"My package is at the reception desk.",
		"The operator deploys on Fridays.",
		"The courtyard is shaded by leafy trees.",
	];
	const unknownQueries = [
		"what is my passport number",
		"what is my graduation year",
		"what is my favorite dessert",
		"what is my wallet address",
		"what is my vaccination date",
		"what is my license plate",
		"where is my violin",
		"who is my optometrist",
		"what instrument do I play",
		"what is my altitude",
		"who is my dentist",
		"what is my birthstone",
		"what is my bracelet size",
		"what are my allergies",
		"what is my marathon time",
		"what is my pension balance",
		"how tall is my nephew",
	];

	it("rejects unseen HRR false positives through sync, async, and graph recall", async () => {
		const emb = new HrrEmbedder();
		const asyncEmb: Embedder = {
			id: emb.id,
			dims: emb.dims,
			queryPreprocessing: emb.queryPreprocessing,
			embed: async (texts) => emb.embed(texts),
		};
		const facts = contents.map((content, i) => rec(`office-${i}`, content, emb));
		// This is a sensitivity guard, not just an easy negative corpus: unfiltered
		// vectors really would clear the unchanged 0.3 recovery floor on these queries.
		for (const query of ["what is my graduation year", "what is my pension balance", "how tall is my nephew"]) {
			const qv = emb.embed([query])[0]!;
			assert.ok(facts.some((fact) => cosine(qv, fact.embedding!) >= 0.3), query);
		}
		for (const query of unknownQueries) {
			assert.equal(bm25Score(facts, query, NOW).length, 0, `no lexical evidence: ${query}`);
			assert.deepEqual(recallHybrid(facts, query, emb, NOW), [], `sync: ${query}`);
			assert.deepEqual(await recallHybridAsync(facts, query, asyncEmb, NOW), [], `async: ${query}`);
			assert.deepEqual(recallWithGraph(facts, query, { forceWalk: true }, NOW, emb), [], `graph: ${query}`);
			assert.deepEqual(await recallWithGraphAsync(facts, query, { forceWalk: true }, NOW, asyncEmb), [], `async graph: ${query}`);
		}
	});

	for (const [label, emb] of [["HRR", new HrrEmbedder()], ["hashing", new HashingEmbedder()]] as const) {
		it(`${label} removes question-only evidence, including the empty-query sentinel`, async () => {
			const facts = contents.map((content, i) => rec(`office-${i}`, content, emb));
			facts.push(rec("empty-sentinel", "", emb));
			for (const query of ["what is my graduation year", "what is my pension balance", "what is my", "", " \t\n"]) {
				assert.deepEqual(recallHybrid(facts, query, emb, NOW), [], `sync: ${query}`);
				assert.deepEqual(await recallHybridAsync(facts, query, emb, NOW), [], `async: ${query}`);
			}
		});

		it(`${label} still recovers inflections and preserves lexical ranking`, async () => {
			for (const [term, content] of [
				["deploy", "The operator deploys on Fridays."],
				["archive", "The worker archives completed reports."],
			] as const) {
				const fact = rec("inflection", content, emb);
				for (const query of [term, `where do I ${term}`]) {
					assert.equal(bm25Score([fact], query, NOW).length, 0, "the positive must use recovery, not BM25");
					const sync = recallHybrid([fact], query, emb, NOW);
					assert.equal(sync[0]?.record.memoryId, fact.memoryId, query);
					assert.equal(sync[0]?.lexRank, undefined);
					assert.equal(sync[0]?.vecRank, 1);
					assert.deepEqual(await recallHybridAsync([fact], query, emb, NOW), sync);
					assert.deepEqual(
						await recallWithGraphAsync([fact], query, {}, NOW, emb),
						recallWithGraph([fact], query, {}, NOW, emb),
					);
				}
			}
			const facts = contents.map((content, i) => rec(`office-${i}`, content, emb));
			const query = "what is my backup schedule";
			const lexical = bm25Score(facts, query, NOW);
			const primary = recallHybrid(facts, query, emb, NOW).filter((hit) => hit.lexRank !== undefined);
			assert.deepEqual(primary.map((hit) => [hit.record.memoryId, hit.score]), lexical.map((hit) => [hit.record.memoryId, hit.score]));
		});
	}

	it("learned embedders keep full questions and recover synonyms without lexical overlap", async () => {
		const examples = [
			{ query: "how do I commute", content: "The owner travels by bicycle.", vector: [1, 0, 0] },
			{ query: "what refreshment do I prefer", content: "The favorite beverage is tea.", vector: [0, 1, 0] },
		];
		const inputs: string[] = [];
		const emb: Embedder = {
			id: "semantic-recovery-control",
			dims: 3,
			embed(texts) {
				inputs.push(...texts);
				return texts.map((text) => examples.find((example) => text === example.query || text === example.content)?.vector ?? [0, 0, 1]);
			},
		};
		const facts = examples.map((example, i) => rec(`semantic-${i}`, example.content, emb));
		for (const [i, example] of examples.entries()) {
			assert.equal(bm25Score(facts, example.query, NOW).length, 0);
			assert.equal(recallHybrid(facts, example.query, emb, NOW)[0]?.record.memoryId, `semantic-${i}`);
			assert.equal((await recallHybridAsync(facts, example.query, emb, NOW))[0]?.record.memoryId, `semantic-${i}`);
			assert.equal((await recallWithGraphAsync(facts, example.query, {}, NOW, emb))[0]?.record.memoryId, `semantic-${i}`);
		}
		assert.deepEqual(recallHybrid(facts, "what is my passport number", emb, NOW), []);
		assert.ok(inputs.includes(examples[0]!.query), "the learned embedder received the intact question");
		assert.ok(!inputs.includes("commute"), "model-free preprocessing must not affect learned embedders");
	});
});
