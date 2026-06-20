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
} from "./capabilities.js";
import { HARD_GOLD } from "./gold-hard.js";
import { seedGold } from "./gold.js";
import { type RecallEvalResult, runRecallEval } from "./harness.js";

/**
 * The HARD gold's done-when (Step 3, the "show the wins" tier): on a gold set
 * with COMPETITION, Tideline's modulation (decay×importance) + trust-weighted
 * hybrid measurably out-rank plain BM25/FTS. The clean synthetic gold ties every
 * lane at 100%; THIS set is where the design earns its keep, and the assertions
 * are a regression gate on those wins:
 *
 *   • recall@3 = 100% on EVERY lane (correct retrieval — the floor is non-negotiable).
 *   • POISON (trust): the hybrid ranks the trusted answer #1; plain-FTS gets fooled.
 *   • IMPORTANCE (modulation): the modulated lanes lift the important answer over a
 *     higher-BM25 distractor; plain-FTS, which ignores importance, ranks it #2.
 *   • Overall MRR: hybrid ≥ BM25×eff > plain-FTS.
 *   • The DEFAULT lane (BM25×eff) abstains cleanly (0 violations on no-answer queries).
 *
 * MEASURED model-free limitation (documented, not hidden): the HYBRID's HRR
 * recovery lane carries abstention false-positives (it surfaces a fact on a
 * no-lexical-match query). This is FUNDAMENTAL, not a tunable bug — the HRR's
 * unrelated-text cosine (low-0.3s on a small corpus) OVERLAPS its genuine
 * morphological recovery (query "deploy" → fact "deploys") in the operating regime,
 * so no fixed minSim separates them model-free: a higher floor that kills the noise
 * also cut real recall — VERIFIED, it broke the "deploy"→"deploys" recall in
 * src/agents/tools/memory-tools.test.ts. The real fix is a LEARNED embedder (v2:
 * clean separation, sets `Embedder.minSim` via the seam). We assert the default
 * lane's clean abstention (0) AND gate the PRODUCTION hybrid lane's count to its
 * measured model-free bound, so a regression on the served path fails CI.
 *
 * IMPORTANCE scope: the importance cases show the DIRECTION of the effectiveScore
 * modulation at the importance EXTREME (distractor 0.05) — a ≤2× damped swing by
 * design (it never overrides relevance), so it is NOT a default-magnitude guarantee
 * (at ~0.6/~0.4 default importances the same raw-BM25 gap would not flip).
 *
 * METRICS scope (single-relevant gold): every v1 gold case has exactly ONE relevant
 * fact, so recall@k ≡ hitRate and nDCG@k is a monotone transform of reciprocal rank
 * — the four reported metrics carry ONE bit of ranking signal per case, and MRR is
 * the discriminating one (the gates assert the wins on MRR; recall@k is a floor).
 * Multi-relevant gold (where nDCG/recall@k diverge from MRR) is a v2 upgrade with
 * real data. We report all four for shape, but don't over-read them as independent.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-hard-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("hard gold — competition discriminates the recall lanes (the wins)", () => {
	it("Tideline's modulation + trust-weighted hybrid out-rank plain BM25/FTS", async () => {
		// Pin the store clock to 0 so write-time createdAt AND score-time `now` share
		// ONE deterministic clock — otherwise decay over the (machine-load-dependent)
		// gap between seeding and recall makes the hybrid/decay lanes non-reproducible
		// (a trusted answer written microseconds before its distractor would decay
		// below it under load). This isolates RANKING quality from decay-timing noise.
		const store = new FactStore(dir, { now: () => 0 });
		const cases = seedGold(store, HARD_GOLD);
		const K = 3;
		const opts = { k: K, clock: () => 0 };
		const floor = await runRecallEval(linearScanCapability(store), cases, opts);
		const fts = await runRecallEval(ftsBaselineCapability(store), cases, opts);
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, opts);
		const hybrid = await runRecallEval(hybridRecallCapability(store), cases, opts);

		const cat = (r: RecallEvalResult, c: string) => r.byCategory[c]?.mrr ?? 0;
		const row = (n: string, r: RecallEvalResult) =>
			`  ${n.padEnd(10)} MRR=${r.mrr.toFixed(2)} recall@${K}=${(r.recallAtK * 100).toFixed(0)}%  |` +
			` poison=${cat(r, "poison").toFixed(2)} import=${cat(r, "importance").toFixed(2)} precis=${cat(r, "precision").toFixed(2)}  | absViol=${r.abstentionViolations}`;
		console.log(
			`\n[hard gold — competition: where the design wins]\n${[row("floor", floor), row("plain-FTS", fts), row("BM25xeff", bm25), row("hybrid", hybrid)].join("\n")}`,
		);

		// ── Retrieval floor: every lane FINDS the answers (the wins are about RANK).
		for (const [n, r] of [["floor", floor], ["plain-FTS", fts], ["BM25xeff", bm25], ["hybrid", hybrid]] as const) {
			assert.equal(r.recallAtK, 1, `${n} must retrieve every answer (recall@${K}=${(r.recallAtK * 100).toFixed(0)}%)`);
		}

		// ── POISON (trust): the hybrid recovers the trusted answer that plain lexical sinks.
		assert.ok(
			cat(hybrid, "poison") > cat(fts, "poison") + 1e-9,
			`hybrid poison MRR (${cat(hybrid, "poison").toFixed(2)}) must beat plain-FTS (${cat(fts, "poison").toFixed(2)})`,
		);
		assert.equal(cat(hybrid, "poison"), 1, `hybrid should rank the trusted answer #1 on ALL poison cases (got ${cat(hybrid, "poison").toFixed(2)})`);

		// ── IMPORTANCE (modulation): the modulated lanes lift the important answer over a
		// higher-BM25 distractor; plain-FTS (no importance) is fooled. The ISOLATION is
		// exact here — `bm25` is BM25 × effectiveScore and `fts` is the SAME BM25 with
		// `modulate:false`, so the delta IS the modulation (not a different scorer). (The
		// floor may also rank these #1 via its own term-overlap scorer — that's a separate
		// lane, not a modulation claim; the modulation claim is precisely bm25 > fts.)
		// Exact measured values (clock pinned to 0, deterministic): fts importance MRR=0.5 (2 of 4 cases
		// rank the important answer #2 because raw BM25 favours the distractor), bm25 and hybrid = 1.0
		// (effectiveScore modulation lifts the high-importance answer to #1 on all 4 cases).
		assert.equal(cat(fts, "importance"), 0.5, "plain-FTS importance MRR must be 0.5 (distractor wins on raw BM25 for half the cases)");
		assert.equal(cat(bm25, "importance"), 1, "BM25×eff importance MRR must be 1.0 (modulation lifts the important answer to #1 on all cases)");
		assert.equal(cat(hybrid, "importance"), 1, "hybrid importance MRR must be 1.0 (modulation + trust both score the important answer #1)");

		// ── Overall: the modulated lanes out-rank plain lexical.
		assert.equal(hybrid.mrr, 0.96875, `hybrid overall MRR (${hybrid.mrr.toFixed(3)}) must equal the measured value 0.96875`);
		assert.equal(bm25.mrr, 0.84375, `Tideline BM25×eff MRR (${bm25.mrr.toFixed(3)}) must equal the measured value 0.84375`);
		assert.equal(fts.mrr, 0.75, `plain-FTS MRR (${fts.mrr.toFixed(3)}) must equal the measured value 0.75`);

		// ── The SERVED path beats the crude floor. recall() delegates to the HYBRID
		// (records.ts), so THE gate that matters is hybrid > floor — both overall and on
		// the flagship poison axis. HONEST CAVEAT (measured, gated below by inequality):
		// the intermediate BM25×eff lane (decay/importance modulation, NO trust) does
		// NOT beat the floor here — BM25×eff MRR (0.84) < floor (0.94) and poison
		// (0.67) < floor (0.83) — because modulation alone can't down-rank a well-crafted
		// untrusted distractor. That gap is exactly WHY trust (the hybrid) is the served
		// path; we therefore gate the floor-beating claim on the hybrid, not BM25×eff.
		assert.equal(floor.mrr, 0.9375, `linear-scan floor MRR (${floor.mrr.toFixed(4)}) must equal the measured value 0.9375`);
		assert.equal(hybrid.mrr, 0.96875, `served hybrid MRR (${hybrid.mrr.toFixed(4)}) must equal the measured value 0.96875 (exceeds floor 0.9375)`);
		assert.equal(cat(floor, "poison"), 5 / 6, `floor poison MRR (${cat(floor, "poison").toFixed(4)}) must equal the measured value 5/6 ≈ 0.8333`);
		assert.equal(cat(hybrid, "poison"), 1, `served hybrid poison MRR (${cat(hybrid, "poison").toFixed(2)}) must equal 1.0 — trust is the complete poison defense`);
		// nDCG quality gate: the served hybrid's nDCG@k must also clear the floor, so a
		// ranking regression that happened to spare MRR/recall@3 still trips a gate.
		// (On single-relevant gold nDCG tracks MRR; this locks a non-regression floor
		// on the served lane's nDCG ahead of multi-relevant gold in v2.)
		assert.equal(floor.ndcgAtK, 0.9538662191964322, `floor nDCG@${K} (${floor.ndcgAtK.toFixed(6)}) must equal the measured value`);
		assert.equal(hybrid.ndcgAtK, 0.9769331095982161, `served hybrid nDCG@${K} (${hybrid.ndcgAtK.toFixed(6)}) must equal the measured value (exceeds floor)`);

		// ── The DEFAULT recall lane abstains cleanly on no-answer queries.
		assert.equal(bm25.abstentionViolations, 0, "the default BM25×eff lane must abstain on no-answer queries");
		assert.equal(fts.abstentionViolations, 0, "plain-FTS abstains too (no lexical hit to surface)");

		// ── PRODUCTION-lane abstention gate: the hybrid is what `recall()` actually
		// serves, so its abstention MUST be gated — not merely reported. It carries the
		// documented model-free HRR recovery false-positives (fundamental, not a bug —
		// see header; a learned embedder v2 drives it to 0), so we can't assert 0, but
		// we GATE the measured bound so a regression (MORE no-answer false-positives
		// shipping on the served path) fails CI rather than slipping through green.
		const HYBRID_ABSTENTION_CEILING = 2; // measured on this gold; the model-free HRR bound.
		assert.equal(hybrid.abstentionViolations, HYBRID_ABSTENTION_CEILING, `production hybrid abstention violations (${hybrid.abstentionViolations}) must equal the model-free bound (${HYBRID_ABSTENTION_CEILING}) — a learned embedder is the path to 0`);
	});
});
