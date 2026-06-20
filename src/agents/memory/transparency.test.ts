import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";
import { bm25Score, tokenize } from "./scoring.js";

/**
 * Recall transparency (Tideline Step 11). The scorer can explain itself: a
 * breakdown that reconciles exactly (score = bm25 × modulator, modulator =
 * 0.5 + 0.5·effective), opt-in so the hot path is untouched, surfaced via a
 * PASSIVE `FactStore.explainRecall` (diagnostic — must not reinforce decay).
 */

const NOW = 1_750_000_000_000;

function rec(id: string, content: string, over = {}) {
	return {
		memoryId: id,
		content,
		segment: "knowledge" as const,
		tier: "long" as const,
		importance: 0.5,
		decayRate: 0.03,
		accessCount: 0,
		lastAccessedAt: NOW,
		createdAt: NOW,
		lifecycle: "active" as const,
		...over,
	};
}

describe("recall transparency — scoreBreakdown", () => {
	const records = [
		rec("home", "I live in Hyderabad India", { importance: 0.85, segment: "identity" as const }),
		rec("editor", "I prefer tabs over spaces when coding", { importance: 0.7, segment: "preference" as const }),
		rec("coffee", "I drink black coffee with no sugar", { importance: 0.7, segment: "preference" as const }),
	];

	it("opt-in: no breakdown by default (hot path stays lean)", () => {
		const ss = bm25Score(records, "coffee sugar", NOW);
		// Guard: only the "coffee" record matches "coffee"/"sugar"; exactly 1 hit expected.
		assert.equal(ss.length, 1, "exactly one record matches 'coffee sugar'");
		for (const s of ss) {
			assert.equal(s.breakdown, undefined);
		}
	});

	it("breakdown reconciles exactly: score = bm25 × modulator, modulator = 0.5 + 0.5·effective", () => {
		const scored = bm25Score(records, "tabs spaces coding", NOW, { breakdown: true });
		// Only the "editor" record matches all three query terms; exactly 1 hit.
		assert.equal(scored.length, 1);
		// Cross-check breakdown.bm25 against an unmodulated run (`modulate: false`
		// pins modulator = 1, so score === raw BM25). This isolates the MODULATOR,
		// not the BM25 accumulator — both runs share the same Okapi math — so it
		// confirms the modulator was the only thing folded into the final score,
		// over and above the self-consistent `score === bm25 × modulator` check.
		const rawById = new Map<string, number>();
		for (const s of bm25Score(records, "tabs spaces coding", NOW, { modulate: false })) {
			rawById.set(s.record.memoryId, s.score);
		}
		for (const s of scored) {
			const b = s.breakdown;
			assert.ok(b, "breakdown present");
			// Arithmetic reconciles to floating-point tolerance.
			assert.ok(Math.abs(b.score - s.score) < 1e-12, "breakdown.score === score");
			assert.ok(Math.abs(b.score - b.bm25 * b.modulator) < 1e-12, "score = bm25 × modulator");
			// breakdown.bm25 matches the independently-computed unmodulated score.
			const raw = rawById.get(s.record.memoryId);
			assert.ok(raw !== undefined, "record present in unmodulated run");
			assert.ok(Math.abs(b.bm25 - raw) < 1e-12, "breakdown.bm25 === unmodulated score");
			assert.ok(Math.abs(b.modulator - (0.5 + 0.5 * b.effective)) < 1e-12, "modulator = 0.5 + 0.5·effective");
			// Modulator for the "editor" record: effectiveScore = importance = 0.7 (accessed at NOW,
			// zero elapsed time, so no decay), giving 0.5 + 0.5 * 0.7 = 0.85 exactly.
			assert.equal(b.modulator, 0.85, "modulator = 0.5 + 0.5 × importance(0.7) = 0.85");
			assert.ok(b.bm25 > 0, "bm25 positive for a matched record");
			// matchedTerms are real query terms; "editor" content contains all 3 query tokens.
			const qterms = new Set(tokenize("tabs spaces coding"));
			assert.equal(b.matchedTerms.length, 3, "all 3 query terms matched in the editor record");
			for (const t of b.matchedTerms) assert.ok(qterms.has(t), `${t} is a query term`);
		}
	});
});

// NOTE: `explainRecall` explains the LEXICAL lane only — it runs `bm25Score`
// (BM25 × modulator), the same primitive as `search`, so its ranking matches
// `search` and the breakdown reconciles the lexical arithmetic. It does NOT
// explain the HYBRID recall path (`recall`/`searchHybrid`, BM25 ⊕ vector RRF)
// that live callers use; with embeddings present, hybrid ranking can diverge
// from this lexical explanation. These tests therefore assert explain↔search
// (both lexical), not explain↔searchHybrid.
describe("FactStore.explainRecall — passive diagnostic surface", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-explain-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("ranking matches search() exactly — explain just exposes the arithmetic", () => {
		const store = new FactStore(dir);
		store.write({ content: "I live in Hyderabad India", segment: "identity" });
		store.write({ content: "I prefer tabs over spaces when coding", segment: "preference" });
		store.write({ content: "I drink black coffee with no sugar", segment: "preference" });

		const ranked = store.search("coffee no sugar", { markAccessed: false }).map((r) => r.memoryId);
		const explained = store.explainRecall("coffee no sugar").map((r) => r.memoryId);
		assert.deepEqual(explained, ranked);
	});

	it("is PASSIVE — does not reinforce decay (accessCount untouched), unlike search()", () => {
		const store = new FactStore(dir);
		store.write({ content: "I drink black coffee with no sugar", segment: "preference" });

		store.explainRecall("coffee sugar");
		assert.equal(store.list()[0]?.accessCount, 0, "explainRecall must not bump accessCount");

		// Contrast: a default search() DOES reinforce.
		store.search("coffee sugar");
		assert.equal(store.list()[0]?.accessCount, 1, "search() reinforces");
	});

	it("each hit carries a breakdown", () => {
		const store = new FactStore(dir);
		store.write({ content: "Beta Labs is headquartered in Berlin", segment: "knowledge" });
		const hits = store.explainRecall("Beta Labs Berlin");
		// Exactly one record was written and it matches all query tokens.
		assert.equal(hits.length, 1);
		const top = hits[0];
		assert.ok(top);
		assert.ok(top.breakdown.bm25 > 0);
	});
});
