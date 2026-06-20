import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetFactsCacheForTests, awaitFactsFlush } from "../../../storage/facts-cache.js";
import {
	__resetRuntimeContextForTests,
	createRuntimeContext,
	setRuntimeContext,
} from "../../../storage/runtime-context.js";
import type { BrigadeStore } from "../../../storage/store.js";
import { FactStore } from "../records.js";
import { defaultRecallCapability } from "./capabilities.js";
import { SYNTHETIC_GOLD } from "./gold-synthetic.js";
import { seedGold } from "./gold.js";
import { type RecallEvalResult, runRecallEval } from "./harness.js";

/**
 * CROSS-MODE PARITY GATE (Tideline build Step 4, gate iii).
 *
 * The 0.2 lock makes recall ranking "parity by construction": ONE shared BM25
 * scorer (scoring.ts) runs over the SAME records in BOTH modes — the fs JSONL OR
 * the convex boot-hydrated cache. This gate PROVES it on the gold cases: seed the
 * SAME gold set + run the SAME eval through the filesystem path AND the convex
 * (in-memory cache + write-through) path, and assert the recall NUMBERS are
 * bit-identical. No live convex backend — a fake store records the write-through;
 * the live cache is the recall seam (the backend round-trip MARSHALLING parity is
 * covered separately by storage/convex/memory-parity.test.ts).
 *
 * Asserted on the DEFAULT BM25 lane: the vector/HRR recovery lane is a convex/v2
 * feature (fs pays no embed-on-write), so it is intentionally NOT a parity subject
 * in v1 — the shared LEXICAL scorer is.
 */

/** Minimal convex-mode store: the two write-through sinks the facts-cache calls. */
function makeConvexStore(): BrigadeStore {
	return {
		mode: "convex",
		init: async () => {},
		memory: {
			upsertFactRecordRaw: async () => {},
			deleteFactRecordRaw: async () => {},
		},
	} as unknown as BrigadeStore;
}

/** Seed the gold + score the default BM25 lane. Gold-relative metrics (recall@k /
 *  MRR / nDCG / per-case) are comparable across stores even though memoryIds differ. */
async function evalInCurrentMode(dir: string, k: number): Promise<RecallEvalResult> {
	// Pinned clock → decay-deterministic in BOTH modes, so the parity comparison
	// isn't confounded by wall-clock drift between the fs and convex eval runs.
	const store = new FactStore(dir, { now: () => 0 });
	const cases = seedGold(store, SYNTHETIC_GOLD);
	return runRecallEval(defaultRecallCapability(store), cases, { k, clock: () => 0 });
}

let dir: string;
beforeEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-parity-"));
});
afterEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("cross-mode parity — fs recall ≡ convex recall on the gold", () => {
	it("the BM25 recall NUMBERS are bit-identical in filesystem and convex mode", async () => {
		const K = 5;
		// filesystem baseline FIRST (no runtime context → fs mode).
		const fsRes = await evalInCurrentMode(path.join(dir, "fsws"), K);

		// flip to convex mode (in-memory cache + fake write-through) and re-run.
		setRuntimeContext(await createRuntimeContext({ store: makeConvexStore(), stateDir: dir }));
		const cxRes = await evalInCurrentMode(path.join(dir, "cxws"), K);
		await awaitFactsFlush();

		// Aggregate accuracy + latency-independent shape must match exactly.
		assert.equal(cxRes.recallAtK, fsRes.recallAtK, "recall@k must be identical across modes");
		assert.equal(cxRes.mrr, fsRes.mrr, "MRR must be identical across modes");
		assert.equal(cxRes.ndcgAtK, fsRes.ndcgAtK, "nDCG@k must be identical across modes");
		assert.equal(cxRes.hitRate, fsRes.hitRate, "hitRate must be identical across modes");
		assert.equal(cxRes.abstentionViolations, fsRes.abstentionViolations, "abstention behavior must match");

		// Per-case parity: every case scores the same in both modes (catches a
		// ranking divergence the aggregate could average away).
		assert.equal(cxRes.perCase.length, fsRes.perCase.length);
		const byCaseFs = new Map(fsRes.perCase.map((p) => [p.caseId, p]));
		for (const cx of cxRes.perCase) {
			const f = byCaseFs.get(cx.caseId);
			assert.ok(f, `case ${cx.caseId} present in both modes`);
			assert.equal(cx.recallAtK, f.recallAtK, `case ${cx.caseId}: recall@k identical across modes`);
			assert.equal(cx.reciprocalRank, f.reciprocalRank, `case ${cx.caseId}: rank identical across modes`);
			assert.equal(cx.abstentionViolation, f.abstentionViolation, `case ${cx.caseId}: abstention identical`);
		}

		// Corpus shape: the synthetic gold has 13 cases (10 scored + 3 abstention).
		// These counts are pinned by SYNTHETIC_GOLD and must not silently shrink.
		assert.equal(fsRes.n, 13, "total cases must be 13 (10 scored + 3 abstention)");
		assert.equal(fsRes.nScored, 10, "scored (non-abstention) cases must be exactly 10");
		assert.equal(fsRes.nAbstention, 3, "abstention cases must be exactly 3");

		// All 10 scored cases hit their unique relevant fact at rank-1, so the
		// aggregate accuracy figures are all 1.0 — a regression to any fraction
		// would break these.
		assert.equal(fsRes.recallAtK, 1, "recall@k baseline must be 1.0 (every scored case hits at rank ≤ k)");
		assert.equal(fsRes.mrr, 1, "MRR baseline must be 1.0 (every relevant fact ranks first)");
		assert.equal(fsRes.ndcgAtK, 1, "nDCG@k baseline must be 1.0 (ideal ranking on all scored cases)");
		assert.equal(fsRes.hitRate, 1, "hitRate baseline must be 1.0 (every scored case has a top-k hit)");
	});
});
