import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getDefaultEmbedder } from "../embedder.js";
import { FactStore } from "../records.js";
import {
	defaultRecallCapability,
	ftsBaselineCapability,
	hybridRecallCapability,
	linearScanCapability,
	weightedSumFusionBaseline,
	oracleCapability,
} from "./capabilities.js";
import { SYNTHETIC_GOLD } from "./gold-synthetic.js";
import { RICH_GOLD } from "./gold-rich.js";
import { seedGold } from "./gold.js";
import { formatRecallEval, type RecallEvalResult, runRecallEval } from "./harness.js";
import { bootstrapMeanCI } from "./metrics.js";

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

		// On the clean synthetic gold every lane ranks perfectly: BM25 and FTS
		// both achieve recall@3=1.0 and MRR=1.0; the linear floor also achieves
		// recall@3=1.0 but MRR=0.95 (the one transition case where the relevant
		// fact is not ranked first lowers the mean: 9×1.0 + 1×0.5 over 10 cases).
		assert.equal(bm25.recallAtK, 1, "BM25 recall@3 is perfect on the synthetic gold");
		assert.equal(bm25.mrr, 1, "BM25 MRR is perfect on the synthetic gold");
		assert.equal(floor.recallAtK, 1, "linear floor recall@3 is perfect on the synthetic gold");
		assert.equal(floor.mrr, 0.95, "linear floor MRR is 0.95 (transition case drops one RR to 0.5)");
		assert.equal(fts.recallAtK, 1, "plain-FTS recall@3 is perfect on the synthetic gold");
		assert.equal(fts.mrr, 1, "plain-FTS MRR is perfect on the synthetic gold");
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
			// The BM25 index ranks the relevant fact first for every scored query →
			// perfect recall at every budget. The oracle (insertion-order dump) returns
			// facts in write order; recall@k = k / 10 scored cases when the first k
			// facts are the relevant ones. Exact expected values are pinned from the
			// seeded corpus (10 active facts, k scored cases hit in positions 1–k):
			// k=1 → 0.1, k=3 → 0.3, k=5 → 0.5.
			const expectedIdxRecall = 1;
			const expectedOrcRecall = k / 10;
			assert.equal(idx.recallAtK, expectedIdxRecall, `at k=${k} index recall@k is perfect (1.0)`);
			assert.equal(orc.recallAtK, expectedOrcRecall, `at k=${k} oracle recall@k is ${expectedOrcRecall} (insertion-order truncation)`);
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
		// SYNTHETIC_GOLD has exactly 3 no-answer (abstention) cases: g-movie, g-shoe,
		// g-job-archived. The oracle (dump-all) returns facts for every query →
		// one violation per abstention case → exactly 3 violations.
		assert.equal(orc.abstentionViolations, 3, "the full-context dump violates all 3 abstention cases (g-movie, g-shoe, g-job-archived)");
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

describe("Step 1 — competitor head-to-head (the 'are we best?' number) + bootstrap CIs", () => {
	/** Per-case reciprocal rank (the discriminating metric), abstention excluded. */
	const rrs = (r: RecallEvalResult): number[] => r.perCase.filter((p) => !p.abstention).map((p) => p.reciprocalRank ?? 0);

	it("Tideline's served hybrid does NOT lose to the weighted-sum fusion baseline at equal embedder", async () => {
		const store = new FactStore(dir, { now: () => 0 });
		const cases = seedGold(store, SYNTHETIC_GOLD); // embed-on-write populates HRR vectors for BOTH lanes
		const K = 3;
		const hybrid = await runRecallEval(hybridRecallCapability(store), cases, { k: K, clock: () => 0 });
		const fusion = await runRecallEval(
			weightedSumFusionBaseline(store, getDefaultEmbedder()),
			cases,
			{ k: K, clock: () => 0 },
		);
		const hCI = bootstrapMeanCI(rrs(hybrid));
		const oCI = bootstrapMeanCI(rrs(fusion));
		console.log("\n[fusion-algorithm head-to-head — embedder held constant (HRR)]");
		console.log(
			`  Tideline (BM25-primary ⊕ recovery)  : MRR=${hybrid.mrr.toFixed(3)}  95%CI[${hCI.lo.toFixed(3)}, ${hCI.hi.toFixed(3)}]  recall@${K}=${(hybrid.recallAtK * 100).toFixed(0)}%`,
		);
		console.log(
			`  Weighted-sum fusion (0.7v/0.3t)     : MRR=${fusion.mrr.toFixed(3)}  95%CI[${oCI.lo.toFixed(3)}, ${oCI.hi.toFixed(3)}]  recall@${K}=${(fusion.recallAtK * 100).toFixed(0)}%`,
		);
		console.log(
			"  → Equal embedder. The weighted-sum's 0.7 vec weight dilutes a strong lexical hit with a weak model-free\n" +
				"    vector — exactly why Tideline keeps BM25 PRIMARY (vector = append-below recovery only). On a LEARNED\n" +
				"    embedder the weighted-sum closes the gap on synonymy — that's the separate learned-embedder upgrade,\n" +
				"    measured when a model lands. This number is the fusion-algorithm comparison, embedder-controlled.",
		);
		assert.ok(
			hybrid.mrr >= fusion.mrr - 1e-9,
			`Tideline hybrid MRR (${hybrid.mrr.toFixed(3)}) should be ≥ weighted-sum fusion (${fusion.mrr.toFixed(3)}) at equal embedder`,
		);
		assert.ok(
			hybrid.recallAtK >= fusion.recallAtK - 1e-9,
			`Tideline recall@${K} (${hybrid.recallAtK.toFixed(3)}) should be ≥ weighted-sum fusion (${fusion.recallAtK.toFixed(3)})`,
		);
	});

	it("bootstrapMeanCI: deterministic, brackets the point mean, narrows with ci<1", () => {
		const sample = [1, 0.5, 1, 0.333, 1, 0, 0.5, 1, Number.NaN]; // NaN (abstention) is dropped
		const a = bootstrapMeanCI(sample, { seed: 42 });
		const b = bootstrapMeanCI(sample, { seed: 42 });
		assert.deepEqual(a, b, "same seed ⇒ identical CI (reproducible — an eval gate must be deterministic)");
		assert.equal(a.n, 8, "the NaN is excluded from the CI sample");
		// Pin the exact CI values produced by the seeded PRNG (mulberry32, seed=42,
		// 1000 bootstrap iterations). These are fully deterministic — any change to
		// the PRNG, the bootstrap loop, or the sample filtering would shift them.
		assert.equal(a.mean, 0.666625, "CI mean = (1+0.5+1+0.333+1+0+0.5+1)/8 exactly");
		assert.equal(a.lo, 0.41650000000000004, "CI lower bound is pinned by seed=42");
		assert.equal(a.hi, 0.916625, "CI upper bound is pinned by seed=42");
		const wide = bootstrapMeanCI(sample, { seed: 42, ci: 0.99 });
		const narrow = bootstrapMeanCI(sample, { seed: 42, ci: 0.5 });
		assert.ok(wide.hi - wide.lo >= narrow.hi - narrow.lo - 1e-9, "a 99% band is ≥ a 50% band");
	});
});

describe("rich gold — multi-relevant + transition head-to-head (recall@k carries real signal)", () => {
	const rrs = (r: RecallEvalResult): number[] => r.perCase.filter((p) => !p.abstention).map((p) => p.reciprocalRank ?? 0);

	it("Tideline hybrid ≥ baselines on a multi-relevant + transition gold, at equal embedder", async () => {
		const store = new FactStore(dir, { now: () => 0 });
		const cases = seedGold(store, RICH_GOLD);
		// K=3 with 3-relevant sets + a same-term distractor ⇒ recall@k MEASURES whether
		// the distractor crowds out a real answer (single-relevant gold can't show this).
		const K = 3;

		const floor = await runRecallEval(linearScanCapability(store), cases, { k: K, clock: () => 0 });
		const fts = await runRecallEval(ftsBaselineCapability(store), cases, { k: K, clock: () => 0 });
		const fusion = await runRecallEval(weightedSumFusionBaseline(store, getDefaultEmbedder()), cases, { k: K, clock: () => 0 });
		const hybrid = await runRecallEval(hybridRecallCapability(store), cases, { k: K, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k: K, clock: () => 0 });

		console.log("\n[rich gold — multi-relevant + transition, embedder held constant (HRR)]");
		for (const [label, r] of [
			["linear floor", floor],
			["plain-FTS/BM25", fts],
			["weighted-sum fusion", fusion],
			["Tideline hybrid", hybrid],
			["oracle (dump-all)", oracle],
		] as const) {
			const ci = bootstrapMeanCI(rrs(r));
			console.log(
				`  ${label.padEnd(20)} recall@${K}=${(r.recallAtK * 100).toFixed(0)}%  MRR=${r.mrr.toFixed(3)} 95%CI[${ci.lo.toFixed(3)},${ci.hi.toFixed(3)}]  nDCG@${K}=${r.ndcgAtK.toFixed(3)}  abstain-violations=${r.abstentionViolations}`,
			);
		}
		console.log(
			"  → Multi-relevant cases give recall@k + nDCG signal independent of MRR (single-relevant collapses them).\n" +
				"    Tideline's BM25-primary + trust/importance modulation ranks the full relevant SET over same-term\n" +
				"    distractors; the weighted-sum's 0.7-vec weight dilutes that at the model-free embedder. The dump-all\n" +
				"    oracle trivially hits recall@k but VIOLATES every abstention case — the cost the index doesn't pay.",
		);

		// Gated wins at equal embedder (non-regression vs the competitor baseline + floor).
		assert.ok(hybrid.recallAtK >= fusion.recallAtK - 1e-9, `hybrid recall@${K} (${hybrid.recallAtK.toFixed(3)}) ≥ fusion (${fusion.recallAtK.toFixed(3)})`);
		assert.ok(hybrid.recallAtK >= floor.recallAtK - 1e-9, `hybrid recall@${K} (${hybrid.recallAtK.toFixed(3)}) ≥ floor (${floor.recallAtK.toFixed(3)})`);
		assert.ok(hybrid.mrr >= fusion.mrr - 1e-9, `hybrid MRR (${hybrid.mrr.toFixed(3)}) ≥ fusion (${fusion.mrr.toFixed(3)})`);
		assert.ok(hybrid.ndcgAtK >= fusion.ndcgAtK - 1e-9, `hybrid nDCG@${K} (${hybrid.ndcgAtK.toFixed(3)}) ≥ fusion (${fusion.ndcgAtK.toFixed(3)})`);
		// The qualitative edge: the index abstains on no-answer queries; dump-all cannot.
		assert.equal(hybrid.abstentionViolations, 0, "hybrid abstains on no-answer queries (0 violations)");
		// RICH_GOLD has exactly 2 no-answer cases (rc-movie, rc-shoe). The dump-all
		// oracle returns facts for every query → exactly 2 violations.
		assert.equal(oracle.abstentionViolations, 2, "the dump-all oracle violates both abstention cases (rc-movie, rc-shoe)");
		// Transition: the CURRENT value is recalled; the superseded values are archived (gone from the corpus).
		// RICH_GOLD defines exactly 2 transition cases: rc-city (Lisbon→Berlin→Tokyo,
		// only Tokyo is active) and rc-role (intern→eng→principal, only principal is active).
		const transition = hybrid.perCase.filter((p) => p.category === "transition");
		assert.equal(transition.length, 2, "exactly 2 transition cases (rc-city and rc-role)");
		assert.ok(transition.every((p) => (p.recallAtK ?? 0) === 1), "current transition value recalled (stale superseded values archived)");
	});
});
