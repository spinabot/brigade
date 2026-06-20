/**
 * Tideline eval harness — Step 1 of the build (the measuring stick).
 *
 * `runRecallEval(cap, cases)` drives a backend-agnostic search capability over
 * a set of gold cases and reports recall@k / MRR / nDCG@k / hitRate + latency
 * percentiles. It is what turns "best" from a claim into a NUMBER: every
 * backend (the bundled file store, the convex store, a future hybrid index, a
 * reproduced competitor baseline) is scored through the SAME function on the
 * SAME cases, so the comparison is honest.
 *
 * Backend-agnostic by construction: the harness depends ONLY on the minimal
 * `RecallCapability` seam below — a structural subset of the production
 * `MemoryCapability` (src/agents/extensions/types.ts:677) — so a real backend,
 * a baseline, or a fixture fake all plug in identically. This seam is what the
 * SPI freeze (build step 5) lifts into the standalone Tideline package.
 *
 * Abstention cases (queries whose correct answer is "nothing relevant",
 * `relevantIds: []`) are EXCLUDED from the accuracy means — a recall
 * denominator of zero is meaningless. They're tallied separately so a backend
 * that surfaces a hit on a no-answer query is still caught (abstentionViolations).
 */

import { performance } from "node:perf_hooks";

import { hitAtK, meanIgnoringNaN, ndcgAtK, percentile, recallAtK, reciprocalRank } from "./metrics.js";

/** One ranked hit. The only field the harness needs is a stable `id`. */
export interface RecallHit {
	id: string;
	score?: number;
}

/**
 * The minimal search seam the harness scores. The production
 * `MemoryCapability.search` (returns `{id, content, score, source}[]`)
 * satisfies this structurally; so does a baseline or a fixture fake.
 */
export interface RecallCapability {
	search(query: string, opts?: { limit?: number }): Promise<ReadonlyArray<RecallHit>>;
}

/** A gold case: a query + the ids that SHOULD surface. */
export interface EvalCase {
	/** Stable case id — for per-case reporting + debugging a regression. */
	id: string;
	query: string;
	/** Gold ids that should appear. EMPTY ⇒ abstention (correct answer = nothing). */
	relevantIds: readonly string[];
	/**
	 * Taxonomy bucket — single-session | multi-session | temporal |
	 * knowledge-update | preference | abstention | model-switch | transition.
	 * Free-form so the gold set can add buckets without a code change; the
	 * harness just groups by it.
	 */
	category?: string;
}

export interface PerCaseResult {
	caseId: string;
	category?: string;
	abstention: boolean;
	retrievedIds: string[];
	/** undefined on abstention cases (excluded from accuracy). */
	recallAtK?: number;
	reciprocalRank?: number;
	ndcgAtK?: number;
	hitAtK?: number;
	/** abstention only: true if the backend surfaced ANY hit (should have stayed quiet). */
	abstentionViolation?: boolean;
	latencyMs: number;
}

export interface CategoryRollup {
	n: number;
	recallAtK: number;
	mrr: number;
	ndcgAtK: number;
	hitRate: number;
}

export interface RecallEvalResult {
	k: number;
	/** total cases run. */
	n: number;
	/** non-abstention cases — the accuracy denominator. */
	nScored: number;
	nAbstention: number;
	/** abstention cases where the backend wrongly surfaced a hit. */
	abstentionViolations: number;
	recallAtK: number;
	mrr: number;
	ndcgAtK: number;
	hitRate: number;
	p50LatencyMs: number;
	p95LatencyMs: number;
	byCategory: Record<string, CategoryRollup>;
	perCase: PerCaseResult[];
}

export interface RunRecallEvalOptions {
	/** Top-k cutoff for the rank metrics. Default 10. */
	k?: number;
	/**
	 * `limit` passed to `search`. Default = max(k, 20) so the backend returns
	 * enough to fill the top-k window even when it over-fetches for reranking.
	 */
	limit?: number;
	/** Injectable monotonic clock (ms) for deterministic latency tests. */
	clock?: () => number;
}

const DEFAULT_K = 10;

/**
 * Score `cap` over `cases`. Drives `cap.search` once per case (timed),
 * computes per-case metrics, and aggregates the accuracy means over the
 * non-abstention cases only. Per-category rollups group by `case.category`.
 */
export async function runRecallEval(
	cap: RecallCapability,
	cases: ReadonlyArray<EvalCase>,
	opts: RunRecallEvalOptions = {},
): Promise<RecallEvalResult> {
	const k = opts.k ?? DEFAULT_K;
	const limit = opts.limit ?? Math.max(k, 20);
	const clock = opts.clock ?? (() => performance.now());

	const perCase: PerCaseResult[] = [];
	const latencies: number[] = [];

	for (const c of cases) {
		const abstention = new Set(c.relevantIds).size === 0;
		const t0 = clock();
		const hits = await cap.search(c.query, { limit });
		const latencyMs = Math.max(0, clock() - t0);
		latencies.push(latencyMs);
		const retrievedIds = hits.map((h) => h.id);

		if (abstention) {
			perCase.push({
				caseId: c.id,
				category: c.category,
				abstention: true,
				retrievedIds,
				abstentionViolation: retrievedIds.length > 0,
				latencyMs,
			});
			continue;
		}

		perCase.push({
			caseId: c.id,
			category: c.category,
			abstention: false,
			retrievedIds,
			recallAtK: recallAtK(retrievedIds, c.relevantIds, k),
			// reciprocalRank takes no k param — slice to k first so MRR@k is
			// consistent with the recall@k / nDCG@k / hitRate siblings (all capped
			// at k). Without the slice, a relevant id at rank k+1 would count toward
			// MRR but not the other metrics, making cross-metric comparisons misleading.
			reciprocalRank: reciprocalRank(retrievedIds.slice(0, k), c.relevantIds),
			ndcgAtK: ndcgAtK(retrievedIds, c.relevantIds, k),
			hitAtK: hitAtK(retrievedIds, c.relevantIds, k),
			latencyMs,
		});
	}

	const scored = perCase.filter((p) => !p.abstention);
	const abstentionCases = perCase.filter((p) => p.abstention);

	const byCategory: Record<string, CategoryRollup> = {};
	for (const key of new Set(scored.map((p) => p.category ?? "uncategorized"))) {
		const rows = scored.filter((p) => (p.category ?? "uncategorized") === key);
		byCategory[key] = {
			n: rows.length,
			recallAtK: meanIgnoringNaN(rows.map((r) => r.recallAtK ?? Number.NaN)),
			mrr: meanIgnoringNaN(rows.map((r) => r.reciprocalRank ?? Number.NaN)),
			ndcgAtK: meanIgnoringNaN(rows.map((r) => r.ndcgAtK ?? Number.NaN)),
			hitRate: meanIgnoringNaN(rows.map((r) => r.hitAtK ?? Number.NaN)),
		};
	}

	return {
		k,
		n: perCase.length,
		nScored: scored.length,
		nAbstention: abstentionCases.length,
		abstentionViolations: abstentionCases.filter((p) => p.abstentionViolation).length,
		recallAtK: meanIgnoringNaN(scored.map((p) => p.recallAtK ?? Number.NaN)),
		mrr: meanIgnoringNaN(scored.map((p) => p.reciprocalRank ?? Number.NaN)),
		ndcgAtK: meanIgnoringNaN(scored.map((p) => p.ndcgAtK ?? Number.NaN)),
		hitRate: meanIgnoringNaN(scored.map((p) => p.hitAtK ?? Number.NaN)),
		p50LatencyMs: percentile(latencies, 50),
		p95LatencyMs: percentile(latencies, 95),
		byCategory,
		perCase,
	};
}

/** Compact human-readable summary — the "show me the numbers" line. */
export function formatRecallEval(res: RecallEvalResult): string {
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	// With no scored cases (e.g. an all-abstention input) the accuracy means
	// have a zero denominator — meanIgnoringNaN returns 0, but 0 here means
	// "undefined", not "the backend scored 0%". Print n/a so an empty run is
	// never mistaken for a real, terrible result.
	const scoredHeadline =
		res.nScored === 0
			? `recall@${res.k}=n/a  MRR=n/a  nDCG@${res.k}=n/a  hitRate=n/a`
			: `recall@${res.k}=${pct(res.recallAtK)}  MRR=${res.mrr.toFixed(3)}  nDCG@${res.k}=${res.ndcgAtK.toFixed(3)}  hitRate=${pct(res.hitRate)}`;
	const lines = [
		scoredHeadline,
		`cases: ${res.nScored} scored, ${res.nAbstention} abstention (${res.abstentionViolations} violation${
			res.abstentionViolations === 1 ? "" : "s"
		})  ·  latency p50=${res.p50LatencyMs.toFixed(1)}ms p95=${res.p95LatencyMs.toFixed(1)}ms`,
	];
	const cats = Object.keys(res.byCategory).sort();
	if (cats.length > 0) {
		lines.push("by category:");
		for (const c of cats) {
			const r = res.byCategory[c]!;
			lines.push(`  ${c} (n=${r.n}): recall@${res.k}=${pct(r.recallAtK)} MRR=${r.mrr.toFixed(3)} hit=${pct(r.hitRate)}`);
		}
	}
	return lines.join("\n");
}
