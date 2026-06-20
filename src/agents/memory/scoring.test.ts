import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { MemoryRecord } from "./records.js";
import { bm25Score, linearScanScore, tokenize } from "./scoring.js";

const NOW = 1_750_000_000_000; // fixed clock for deterministic effectiveScore

function rec(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
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
		...over,
	};
}

describe("tokenize", () => {
	it("lowercases + splits on non-alphanumerics + drops empties", () => {
		assert.deepEqual(tokenize("Tabs over Spaces!"), ["tabs", "over", "spaces"]);
		assert.deepEqual(tokenize("  C++ / Rust-lang  "), ["c", "rust", "lang"]);
		assert.deepEqual(tokenize(""), []);
	});

	it("drops STOPWORDS — the load-bearing abstention filter (membership, not length)", () => {
		// Without this every fact containing I/the/of matches every query (over-
		// retrieval) and abstention becomes impossible. Single content chars stay.
		assert.deepEqual(tokenize("I prefer the tabs"), ["prefer", "tabs"]);
		assert.deepEqual(tokenize("x of o"), ["x", "o"]);
	});

	it("is Unicode-aware — non-Latin scripts tokenize instead of vanishing", () => {
		// The ASCII-only delimiter class used to drop whole scripts, making non-Latin
		// facts unrecallable. Space-separated scripts split into words; a space-less
		// script (CJK) yields one whole-run token (exact-phrase match).
		assert.deepEqual(tokenize("пользователь любит кофе"), ["пользователь", "любит", "кофе"]);
		assert.deepEqual(tokenize("Привет, мир"), ["привет", "мир"]);
		assert.deepEqual(tokenize("用户喜欢咖啡"), ["用户喜欢咖啡"]);
		// Mixed Latin + non-Latin keeps both.
		assert.deepEqual(tokenize("deploy 部署 v2"), ["deploy", "部署", "v2"]);
	});
});

describe("linearScanScore (the floor)", () => {
	it("scores matched-terms / query-terms; drops non-matching docs", () => {
		const docs = [rec("a", "I prefer tabs over spaces"), rec("b", "I drink black coffee")];
		const out = linearScanScore(docs, "tabs spaces");
		assert.equal(out.length, 1);
		assert.equal(out[0]!.record.memoryId, "a");
		assert.equal(out[0]!.score, 1); // both query terms matched
	});
});

describe("bm25Score", () => {
	it("ranks the clearly-relevant doc top and drops non-matching docs", () => {
		const docs = [
			rec("editor", "I prefer tabs over spaces when coding"),
			rec("coffee", "I drink black coffee with no sugar"),
			rec("car", "I drive a blue car"),
		];
		const out = bm25Score(docs, "tabs spaces", NOW);
		assert.equal(out.length, 1, "only the matching doc is returned");
		assert.equal(out[0]!.record.memoryId, "editor");
		assert.ok(!out.some((s) => s.record.memoryId === "coffee"), "non-matching docs are dropped");
		assert.ok(!out.some((s) => s.record.memoryId === "car"), "non-matching docs are dropped");
	});

	it("weights a RARE query term above a common one", () => {
		// 'alpha' appears in 1 doc (rare → high idf); 'common' in all 4 (low idf).
		const docs = [
			rec("rare", "alpha common"),
			rec("c1", "common common"),
			rec("c2", "common stuff"),
			rec("c3", "common thing"),
		];
		const out = bm25Score(docs, "alpha common", NOW);
		assert.equal(out.length, 4, "all four docs match at least one query term");
		assert.equal(out[0]!.record.memoryId, "rare", "the doc with the rare term ranks first");
	});

	it("the effectiveScore multiplier breaks ties toward the more important fact", () => {
		const docs = [
			rec("low", "alpha", { importance: 0.3 }),
			rec("high", "alpha", { importance: 0.9 }),
		];
		const out = bm25Score(docs, "alpha", NOW);
		assert.equal(out.length, 2, "both docs match and are returned");
		assert.equal(out[0]!.record.memoryId, "high", "same BM25 → higher importance wins via effectiveScore");
		assert.equal(out[1]!.record.memoryId, "low", "lower-importance doc ranks second");
	});

	it("modulate:false is pure BM25 — importance no longer breaks the tie", () => {
		const docs = [
			rec("low", "alpha", { importance: 0.3 }),
			rec("high", "alpha", { importance: 0.9 }),
		];
		const out = bm25Score(docs, "alpha", NOW, { modulate: false });
		assert.equal(out.length, 2);
		assert.equal(out[0]!.score, out[1]!.score, "same BM25, no modulator → equal scores");
		const bd = bm25Score(docs, "alpha", NOW, { breakdown: true, modulate: false });
		assert.equal(bd[0]!.breakdown!.modulator, 1, "modulate:false → modulator is 1");
		assert.equal(bd[0]!.breakdown!.score, bd[0]!.breakdown!.bm25, "score === bm25 when modulator is 1");
	});

	it("relevance BEATS importance when BM25 differs (damping is relevance-first, not a pure multiplier)", () => {
		// `lex` is MORE relevant (query term twice) but LESS important; `imp` is LESS
		// relevant (term once) but MORE important. The ±50% damped modulator keeps
		// relevance on top — a pure importance multiplier (the regression this fix
		// replaced) would bury `lex`. BM25 gap ≈1.375×, modulator gap ≈1.15× → lex wins.
		const docs = [
			rec("lex", "alpha alpha", { importance: 0.3 }),
			rec("imp", "alpha beta", { importance: 0.5 }),
		];
		const out = bm25Score(docs, "alpha", NOW);
		assert.equal(out.length, 2, "both docs match and are returned");
		assert.equal(out[0]!.record.memoryId, "lex", "the more-relevant fact ranks first despite lower importance");
		assert.equal(out[1]!.record.memoryId, "imp", "less-relevant doc ranks second");
	});

	it("a >2x BM25 gap is NOT overridden by the importance modulator (near the ±50% boundary)", () => {
		// The damped modulator can shift ranking by at most ~2x (mod ∈ [0.5, 1]).
		// `hi` repeats the term in a short doc (high BM25) but has importance ~0
		// (mod ~0.5); `lo` has the term once in a long doc (low BM25) and importance
		// ~0.99 (mod ~0.995). The BM25 gap is >2x, so it clears the worst-case
		// modulator gap (~1.99x) and `hi` still wins — relevance is not overridden.
		const docs = [
			rec("hi", "term term term term term term term term", { importance: 0.0001 }),
			rec("lo", "term plus a b c d e f g h j k l m n p q r s t u v w x y z", { importance: 0.99 }),
		];
		const out = bm25Score(docs, "term", NOW, { breakdown: true });
		const hi = out.find((s) => s.record.memoryId === "hi")!.breakdown!;
		const lo = out.find((s) => s.record.memoryId === "lo")!.breakdown!;
		assert.ok(hi.bm25 / lo.bm25 > 2, "BM25 relevance gap is wider than 2x");
		assert.ok(lo.modulator / hi.modulator < 2, "modulator gap stays within the ±50% (<2x) band");
		assert.equal(out[0]!.record.memoryId, "hi", "the high-BM25 low-importance doc still wins");
	});

	it("a DEFAULT (modulate:true) breakdown reconciles: modulator = 0.5 + 0.5*effective, score = bm25*modulator", () => {
		const docs = [rec("a", "alpha beta", { importance: 0.7, accessCount: 3 })];
		const bd = bm25Score(docs, "alpha", NOW, { breakdown: true })[0]!.breakdown!;
		assert.equal(bd.modulator, 0.5 + 0.5 * bd.effective, "default modulator is the damped 0.5 + 0.5*effective");
		assert.equal(bd.score, bd.bm25 * bd.modulator, "score reconciles to bm25 * modulator");
	});

	it("empty query or empty corpus → no hits", () => {
		assert.deepEqual(bm25Score([rec("a", "x")], "", NOW), []);
		assert.deepEqual(bm25Score([], "x", NOW), []);
	});

	it("an all-stopword query abstains (no content terms survive tokenization)", () => {
		assert.deepEqual(bm25Score([rec("a", "x")], "the of is", NOW), []);
	});
});
