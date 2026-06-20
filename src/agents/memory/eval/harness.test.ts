import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	type EvalCase,
	type RecallCapability,
	type RecallHit,
	formatRecallEval,
	runRecallEval,
} from "./harness.js";
import { hitAtK, meanIgnoringNaN, ndcgAtK, percentile, recallAtK, reciprocalRank } from "./metrics.js";

/** A fixture backend: returns a canned ranked id list per query. */
function fakeCapability(responses: Record<string, string[]>): RecallCapability {
	return {
		async search(query: string, opts?: { limit?: number }): Promise<RecallHit[]> {
			const ids = responses[query] ?? [];
			const limited = opts?.limit ? ids.slice(0, opts.limit) : ids;
			return limited.map((id, i) => ({ id, score: 1 - i * 0.01 }));
		},
	};
}

/** A clock that always returns 0 (latency = 0 when it isn't being asserted). */
function zeroClock(): () => number {
	return () => 0;
}

/** A clock that returns a preset sequence of values, one per call. */
function stepClock(values: number[]): () => number {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)]!;
}

describe("metrics", () => {
	it("recall@k = fraction of the gold set in the top-k", () => {
		assert.equal(recallAtK(["a", "x", "c", "b"], ["a", "b", "c"], 3), 2 / 3); // top-3 = {a,x,c}; gold {a,c} present
		assert.equal(recallAtK(["a", "b", "c"], ["a", "b", "c"], 3), 1);
		assert.equal(recallAtK(["x", "y"], ["a"], 5), 0);
		assert.equal(recallAtK(["a", "a", "b"], ["a", "b"], 3), 1); // duplicate 'a' doesn't double-count
		assert.equal(recallAtK(["a", "a"], ["a", "b"], 2), 0.5); // only 'a' of gold {a,b} surfaces
	});

	it("reciprocal rank = 1 / first relevant rank; 0 if absent", () => {
		assert.equal(reciprocalRank(["x", "a", "y"], ["a"]), 1 / 2);
		assert.equal(reciprocalRank(["a"], ["a"]), 1);
		assert.equal(reciprocalRank(["x", "y"], ["a"]), 0);
	});

	it("hit@k is 1 iff any gold id is in the top-k", () => {
		assert.equal(hitAtK(["x", "a"], ["a"], 2), 1);
		assert.equal(hitAtK(["x", "a"], ["a"], 1), 0); // 'a' is rank 2, outside top-1
	});

	it("nDCG@k rewards higher-ranked relevant hits", () => {
		assert.equal(ndcgAtK(["a", "x", "y"], ["a"], 3), 1); // perfect: gold at rank 1
		const r2 = ndcgAtK(["x", "a", "y"], ["a"], 3); // gold at rank 2 → DCG=1/log2(3), IDCG=1
		assert.ok(Math.abs(r2 - 1 / Math.log2(3)) < 1e-9);
		assert.equal(ndcgAtK(["x", "y", "z", "a"], ["a"], 3), 0); // gold outside top-3
		assert.equal(ndcgAtK(["a", "b", "x"], ["a", "b"], 3), 1); // ideal ordering of 2 gold
	});

	it("percentile is nearest-rank; empty sample → 0", () => {
		assert.equal(percentile([], 95), 0);
		assert.equal(percentile([10], 95), 10);
		const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		assert.equal(percentile(xs, 50), 5); // ceil(.5*10)=5th
		assert.equal(percentile(xs, 95), 10); // ceil(.95*10)=10th
	});

	it("meanIgnoringNaN averages only finite values; empty → 0", () => {
		assert.equal(meanIgnoringNaN([1, Number.NaN, 3]), 2); // NaN skipped → (1+3)/2
		assert.equal(meanIgnoringNaN([]), 0); // no finite values → 0 denominator guard
	});
});

describe("runRecallEval", () => {
	it("scores a fixture and aggregates accuracy over non-abstention cases", async () => {
		const cap = fakeCapability({
			"where do I live?": ["mem_home", "mem_x"], // gold at rank 1
			"what's my job?": ["mem_x", "mem_job"], // gold at rank 2
			"my favorite color?": ["mem_y", "mem_z"], // miss
		});
		const cases: EvalCase[] = [
			{ id: "c1", query: "where do I live?", relevantIds: ["mem_home"], category: "single-session" },
			{ id: "c2", query: "what's my job?", relevantIds: ["mem_job"], category: "single-session" },
			{ id: "c3", query: "my favorite color?", relevantIds: ["mem_color"], category: "preference" },
		];
		const res = await runRecallEval(cap, cases, { k: 5, clock: zeroClock() });

		assert.equal(res.n, 3);
		assert.equal(res.nScored, 3);
		assert.equal(res.nAbstention, 0);
		assert.ok(Math.abs(res.recallAtK - 2 / 3) < 1e-9); // c1=1, c2=1, c3=0
		assert.ok(Math.abs(res.mrr - 0.5) < 1e-9); // c1=1, c2=1/2, c3=0
		assert.ok(Math.abs(res.hitRate - 2 / 3) < 1e-9);
		assert.equal(res.byCategory["single-session"]!.n, 2);
		assert.ok(Math.abs(res.byCategory["single-session"]!.mrr - 0.75) < 1e-9); // c1=1, c2=1/2 → mean 0.75
		assert.equal(res.byCategory["preference"]!.n, 1);
	});

	it("excludes abstention cases from the accuracy denominator + flags violations", async () => {
		const cap = fakeCapability({
			"real q": ["mem_a"],
			"nonsense no-answer query": ["mem_junk"], // backend WRONGLY returns a hit
			"another no-answer": [], // backend correctly returns nothing
		});
		const cases: EvalCase[] = [
			{ id: "s1", query: "real q", relevantIds: ["mem_a"], category: "single-session" },
			{ id: "a1", query: "nonsense no-answer query", relevantIds: [], category: "abstention" },
			{ id: "a2", query: "another no-answer", relevantIds: [], category: "abstention" },
		];
		const res = await runRecallEval(cap, cases, { k: 5, clock: zeroClock() });

		assert.equal(res.n, 3);
		assert.equal(res.nScored, 1, "only the non-abstention case counts toward accuracy");
		assert.equal(res.nAbstention, 2);
		assert.equal(res.recallAtK, 1, "the single scored case is a perfect hit");
		assert.equal(res.abstentionViolations, 1, "a1 surfaced a hit on a no-answer query; a2 stayed quiet");
		assert.equal(
			res.byCategory["abstention"],
			undefined,
			"abstention cases are excluded from accuracy rollups, so no abstention category bucket exists",
		);
		assert.deepEqual(Object.keys(res.byCategory), ["single-session"]);
	});

	it("caps retrievedIds at limit and misses a gold id past the limit", async () => {
		// Backend returns 5 ids ranked; the gold id sits at rank 4, but limit=3
		// truncates the window so it never surfaces → a recorded miss.
		const cap = fakeCapability({
			"deep gold": ["mem_1", "mem_2", "mem_3", "mem_gold", "mem_5"],
		});
		const res = await runRecallEval(
			cap,
			[{ id: "c1", query: "deep gold", relevantIds: ["mem_gold"], category: "single-session" }],
			{ k: 3, limit: 3, clock: zeroClock() },
		);
		assert.deepEqual(res.perCase[0]!.retrievedIds, ["mem_1", "mem_2", "mem_3"], "retrievedIds is the exact capped window — mem_gold at rank 4 is absent");
		assert.equal(res.perCase[0]!.recallAtK, 0, "the truncated-away gold id is a miss");
		assert.equal(res.recallAtK, 0);
	});

	it("computes latency percentiles from the injected clock", async () => {
		const cap = fakeCapability({ q1: ["m1"], q2: ["m2"], q3: ["m3"], q4: ["m4"] });
		// clock returns t0,t1 per case → latencies 10,20,30,40
		const res = await runRecallEval(
			cap,
			[
				{ id: "1", query: "q1", relevantIds: ["m1"] },
				{ id: "2", query: "q2", relevantIds: ["m2"] },
				{ id: "3", query: "q3", relevantIds: ["m3"] },
				{ id: "4", query: "q4", relevantIds: ["m4"] },
			],
			{ clock: stepClock([0, 10, 10, 30, 30, 60, 60, 100]) },
		);
		assert.equal(res.p50LatencyMs, 20); // ceil(.5*4)=2nd smallest
		assert.equal(res.p95LatencyMs, 40); // ceil(.95*4)=4th
	});

	it("formatRecallEval renders a readable summary", async () => {
		const cap = fakeCapability({ q: ["m1"] });
		const res = await runRecallEval(cap, [{ id: "1", query: "q", relevantIds: ["m1"], category: "single-session" }], {
			k: 5,
			clock: zeroClock(),
		});
		const out = formatRecallEval(res);
		assert.match(out, /recall@5=/);
		assert.match(out, /MRR=/);
		assert.match(out, /by category:/);
	});

	it("formatRecallEval prints n/a for an all-abstention run (not a fake 0%)", async () => {
		const cap = fakeCapability({ "no-answer": [] });
		const res = await runRecallEval(cap, [{ id: "a1", query: "no-answer", relevantIds: [], category: "abstention" }], {
			k: 5,
			clock: zeroClock(),
		});
		assert.equal(res.nScored, 0);
		const out = formatRecallEval(res);
		assert.match(out, /recall@5=n\/a/);
		assert.match(out, /MRR=n\/a/);
		assert.doesNotMatch(out, /recall@5=0\.0%/, "an empty run must not look like a real 0% backend");
	});
});
