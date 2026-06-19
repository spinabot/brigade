import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../records.js";
import {
	defaultRecallCapability,
	ftsBaselineCapability,
	hybridRecallCapability,
	linearScanCapability,
	oracleCapability,
} from "./capabilities.js";
import { SYNTHETIC_GOLD } from "./gold-synthetic.js";
import { seedGold } from "./gold.js";
import { formatRecallEval, runRecallEval } from "./harness.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-compare-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("Step 8 — BM25 (FactStore.search) vs the linear floor", () => {
	it("recall@k and MRR: BM25 ≥ the floor on the synthetic gold", async () => {
		const store = new FactStore(dir, { now: () => 0 }); // pinned clock → decay-deterministic (see gold-hard.test.ts)
		const cases = seedGold(store, SYNTHETIC_GOLD);
		// Small cutoff so ranking (not just retrieval) is in play — though on this
		// clean synthetic gold every lane ranks the relevant facts perfectly, so the
		// assertions below are a non-regression floor, not a discriminating ranking test.
		const K = 3;

		const floor = await runRecallEval(linearScanCapability(store), cases, { k: K, clock: () => 0 });
		const fts = await runRecallEval(ftsBaselineCapability(store), cases, { k: K, clock: () => 0 });
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k: K, clock: () => 0 });

		// Surface ALL THREE baselines + the production scorer — these print on
		// `--test` and are the numbers we read together (Step 3 done-when).
		console.log(`\n[baseline i  · linear-scan floor]\n${formatRecallEval(floor)}`);
		console.log(`\n[baseline iii · plain-lexical FTS (no modulation)]\n${formatRecallEval(fts)}`);
		console.log(`\n[Tideline v1 · BM25 × effectiveScore]\n${formatRecallEval(bm25)}`);
		console.log(`\n[baseline ii · full-context oracle]\n${formatRecallEval(oracle)}`);

		assert.ok(bm25.recallAtK > 0 && bm25.mrr > 0, "BM25 finds + ranks relevant facts");
		assert.ok(
			bm25.recallAtK >= floor.recallAtK - 1e-9,
			`BM25 recall@${K} (${bm25.recallAtK.toFixed(3)}) should be ≥ floor (${floor.recallAtK.toFixed(3)})`,
		);
		assert.ok(
			bm25.mrr >= floor.mrr - 1e-9,
			`BM25 MRR (${bm25.mrr.toFixed(3)}) should be ≥ floor (${floor.mrr.toFixed(3)})`,
		);
		// The plain-FTS baseline (pure BM25) must also clear the crude floor, and
		// the production scorer (modulated) must not fall below plain FTS.
		assert.ok(
			fts.recallAtK >= floor.recallAtK - 1e-9,
			`plain-FTS recall@${K} (${fts.recallAtK.toFixed(3)}) should be ≥ floor (${floor.recallAtK.toFixed(3)})`,
		);
		assert.ok(
			bm25.recallAtK >= fts.recallAtK - 1e-9,
			`modulation must not cost recall: BM25×eff (${bm25.recallAtK.toFixed(3)}) ≥ plain-FTS (${fts.recallAtK.toFixed(3)})`,
		);
	});

	it("budget-bounded recall: ranking fills a small context budget; the un-ranked full-context dump truncates", async () => {
		const store = new FactStore(dir, { now: () => 0 }); // pinned clock → decay-deterministic (see gold-hard.test.ts)
		const cases = seedGold(store, SYNTHETIC_GOLD);
		// Under a context BUDGET (k < corpus) you must CHOOSE which k facts to include.
		// Ranked retrieval fills the budget with RELEVANT facts; the un-ranked dump
		// takes the first-k-written and wastes the budget. This is a STRUCTURAL property
		// (a relevance-ranked retriever necessarily recalls@k ≥ an insertion-order dump
		// under a budget), so it is a NON-REGRESSION check, NOT a surprising empirical
		// win — the dump never LOSES a fact (next test), it just can't prioritise under
		// a budget. We therefore report the numbers but do not headline a "win".
		const budgets = [1, 3, 5];
		const rows: string[] = [];
		for (const k of budgets) {
			const idx = await runRecallEval(defaultRecallCapability(store), cases, { k, clock: () => 0 });
			const orc = await runRecallEval(oracleCapability(store), cases, { k, clock: () => 0 });
			rows.push(`k=${k}: index recall@k=${(idx.recallAtK * 100).toFixed(0)}% vs un-ranked dump=${(orc.recallAtK * 100).toFixed(0)}%`);
			assert.ok(
				idx.recallAtK >= orc.recallAtK - 1e-9,
				`at k=${k} ranked retrieval (${idx.recallAtK.toFixed(3)}) should fill the budget ≥ the un-ranked dump (${orc.recallAtK.toFixed(3)})`,
			);
		}
		console.log(`\n[budget-bounded recall — ranking vs un-ranked full-context dump]\n  ${rows.join("\n  ")}`);
		console.log(
			"  → At a context budget (k<corpus) ranking fills it with relevant facts; un-ranked dumping truncates.\n" +
				"    This is WHY retrieval matters at scale — a structural property, not a recall rivalry: at k≥corpus\n" +
				"    both include everything (next test), and the dump's real deficiency is abstention (test below).",
		);
	});

	it("at k ≥ corpus the full-context dump reaches the recall ceiling (1.0) — it never LOSES a fact; index ≤ it", async () => {
		const store = new FactStore(dir, { now: () => 0 }); // pinned clock → decay-deterministic (see gold-hard.test.ts)
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const K = 20; // ≥ active corpus size
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k: K, clock: () => 0 });
		// The HONEST full-context number: with the whole corpus in budget, the dump
		// recalls everything (1.0). This is the number that matters — the index does
		// NOT beat full-context ON RECALL; it matches the ceiling while adding ranking
		// (above) and abstention (below).
		assert.ok(Math.abs(oracle.recallAtK - 1) < 1e-9, "full-context dump returns everything → perfect recall at large k");
		assert.ok(oracle.recallAtK >= bm25.recallAtK - 1e-9, "the dump is the recall ceiling; the index does not exceed it");
	});

	it("the full-context dump CANNOT abstain — the index's real (non-tautological) qualitative win", async () => {
		const store = new FactStore(dir, { now: () => 0 }); // pinned clock → decay-deterministic (see gold-hard.test.ts)
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const K = 3;
		const idx = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const orc = await runRecallEval(oracleCapability(store), cases, { k: K, clock: () => 0 });
		// The dump returns facts for EVERY query, including the no-answer ones → an
		// abstention violation on each (a hallucination feed). The index returns nothing
		// when nothing lexically matches. THIS — not recall — is the qualitative gap.
		assert.ok(orc.abstentionViolations > 0, "the full-context dump answers no-answer queries (it cannot abstain)");
		assert.equal(idx.abstentionViolations, 0, "the index abstains on no-answer queries");
		console.log(
			`\n[abstention — the dump can't say "I don't know"]\n  index violations=${idx.abstentionViolations} vs un-ranked dump=${orc.abstentionViolations} (of ${cases.filter((c) => c.relevantIds.length === 0).length} no-answer cases)`,
		);
	});

	it("multi-signal hybrid (what recall() serves) does not REGRESS recall@k vs pure BM25", async () => {
		const store = new FactStore(dir, { now: () => 0 }); // pinned clock → decay-deterministic (see gold-hard.test.ts)
		const cases = seedGold(store, SYNTHETIC_GOLD); // embed-on-write populates HRR vectors
		const K = 3;
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const hybrid = await runRecallEval(hybridRecallCapability(store), cases, { k: K, clock: () => 0 });
		console.log(`\n[multi-signal hybrid · recall() = BM25⊕HRR × trust × decay]\n${formatRecallEval(hybrid)}`);
		assert.ok(
			hybrid.recallAtK >= bm25.recallAtK - 1e-9,
			`hybrid recall@${K} (${hybrid.recallAtK.toFixed(3)}) must not regress vs BM25 (${bm25.recallAtK.toFixed(3)})`,
		);
		console.log(
			`  → hybrid recall@${K}=${(hybrid.recallAtK * 100).toFixed(0)}% vs BM25 ${(bm25.recallAtK * 100).toFixed(0)}% on the clean synthetic gold.\n` +
				"    The mix's real wins (trust down-weighting, multi-signal robustness, optional MMR diversity) show on\n" +
				"    messy REAL data — recall@k on a clean gold mainly proves it doesn't regress.",
		);
	});
});
