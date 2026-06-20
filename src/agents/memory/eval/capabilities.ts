/**
 * RecallCapability adapters over a `FactStore` — the bridge that lets the
 * harness score real backends + the baselines (Tideline build Step 3 + 8).
 *
 * Every adapter returns the harness's minimal `{ id, score }[]` shape and
 * never reinforces decay — an EVAL run must not mutate the thing it measures.
 * The invariant holds two ways: the store-backed lanes pass `markAccessed: false`
 * to `search`/`searchHybrid`, and the `list()`-based lanes (linearScan/fts/oracle)
 * read through `store.list()`, which never touches `accessCount`.
 *
 * `limit` contract (uniform across all lanes): a `limit > 0` caps the result
 * set; any non-positive or absent `limit` falls back to the lane's default. The
 * store-backed lanes inherit the store's default of 8; the `list()`-based lanes
 * have no fixed cap, so their default is "return all matching candidates".
 */

import { effectiveScore } from "../decay.js";
import { cosine, type Embedder } from "../embedder.js";
import { recallWithGraph } from "../graph-recall.js";
import { FactStore, type RecordOriginFilter } from "../records.js";
import { bm25Score, linearScanScore } from "../scoring.js";
import type { RecallCapability } from "./harness.js";

/**
 * **Linear-scan floor** — the OLD crude term-overlap (`linearScanScore`),
 * applied directly over the store's active + origin-matching records. This is the
 * baseline the SERVED recall path (the trust-weighted hybrid) must beat — gold-hard
 * asserts exactly that. NOTE: the intermediate BM25×effectiveScore lane (no trust)
 * is NOT guaranteed to beat it — on an adversarial poison set the crude overlap can
 * edge out decay/importance modulation, which is precisely why TRUST (the hybrid) is
 * what `recall()` serves, not bare BM25×eff. Deliberately decoupled from
 * `FactStore.search` (now BM25) so it stays a fixed floor.
 */
export function linearScanCapability(store: FactStore, origin?: RecordOriginFilter): RecallCapability {
	return {
		async search(query, opts) {
			const now = Date.now();
			// active-only + bi-temporal valid-time gate (matches FactStore.search):
			// a fact whose `validTo` has passed is excluded from recall.
			const candidates = store
				.list(origin !== undefined ? { origin } : {})
				.filter((r) => r.validTo === undefined || r.validTo > now);
			const ranked = linearScanScore(candidates, query);
			// limit contract matches the store: a positive limit caps, otherwise
			// fall back to the lane default (here: all candidates).
			const limited = opts?.limit && opts.limit > 0 ? ranked.slice(0, opts.limit) : ranked;
			return limited.map((s) => ({ id: s.record.memoryId, score: s.score }));
		},
	};
}

/**
 * The DEFAULT v1 recall — `FactStore.search` (now Okapi BM25 × `effectiveScore`,
 * origin-filtered). This is Tideline's actual lexical retriever, and (because
 * `FactStore` reads the fs file or the convex hydrated cache through the same
 * code) it is the SAME ranking in both modes — the cross-mode parity subject.
 */
export function defaultRecallCapability(store: FactStore, origin?: RecordOriginFilter): RecallCapability {
	return {
		async search(query, opts) {
			const hits = store.search(query, {
				markAccessed: false,
				...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
				...(origin !== undefined ? { origin } : {}),
			});
			return hits.map((h) => ({ id: h.memoryId, score: h.score }));
		},
	};
}

/**
 * **Plain-lexical FTS baseline** (Step 3, baseline iii) — Okapi BM25 with NO
 * decay/importance modulation (`modulate: false`), reproducing how a vanilla
 * full-text-search engine ranks (the lexical approach the reference memory
 * systems use). The vector half of the classic "FTS ⊕ vec" hybrid is the v2
 * lane (no embedder in v1, per the 0.2 lock), so this baseline is the lexical
 * lane only. Isolates what Tideline's `effectiveScore` modulation buys over
 * plain FTS. Origin-filtered for a fair comparison.
 */
export function ftsBaselineCapability(store: FactStore, origin?: RecordOriginFilter): RecallCapability {
	return {
		async search(query, opts) {
			const now = Date.now();
			// active-only + bi-temporal valid-time gate (matches FactStore.search);
			// the same `now` drives both the gate and bm25Score so they agree.
			const candidates = store
				.list(origin !== undefined ? { origin } : {})
				.filter((r) => r.validTo === undefined || r.validTo > now);
			const ranked = bm25Score(candidates, query, now, { modulate: false });
			// limit contract matches the store: a positive limit caps, otherwise
			// fall back to the lane default (here: all candidates).
			const limited = opts?.limit && opts.limit > 0 ? ranked.slice(0, opts.limit) : ranked;
			return limited.map((s) => ({ id: s.record.memoryId, score: s.score }));
		},
	};
}

/**
 * **Multi-signal hybrid** (Tideline v2) — `FactStore.searchHybrid`: BM25-primary
 * with an HRR-cosine recovery lane, × trust × decay, MMR-diversified (model-free).
 * This is what `recall()` serves in production.
 * Measured here to confirm the mix doesn't REGRESS recall vs pure BM25 (its real
 * wins — trust down-weighting, diversity, robustness — show on messy real data,
 * not a clean synthetic gold).
 */
export function hybridRecallCapability(store: FactStore, origin?: RecordOriginFilter): RecallCapability {
	return {
		async search(query, opts) {
			const hits = store.searchHybrid(query, {
				markAccessed: false,
				...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
				...(origin !== undefined ? { origin } : {}),
			});
			return hits.map((h) => ({ id: h.memoryId, score: h.score }));
		},
	};
}

/**
 * **Weighted-sum fusion baseline** (Step 1, the "competitor reproduced" baseline) —
 * reproduces the recall FORMULA used by a mature FTS+vector memory engine: a
 * WEIGHTED-SUM fuse of normalised vector-cosine (0.7) + normalised BM25 (0.3),
 * × temporal decay. The EMBEDDER IS HELD CONSTANT (Brigade's HRR) so this
 * isolates the FUSION ALGORITHM — the classic weighted-sum vs BM25-primary-with-
 * recovery (Tideline's `searchHybrid`). It is deliberately NOT a full
 * reproduction: that engine's LEARNED embedder is the separate "learned-embedder"
 * upgrade. With a weak model-free vector the 0.7 vec weight is a handicap —
 * which is exactly the trap Tideline avoids by keeping BM25 PRIMARY and using
 * the vector only as an append-below recovery lane. So this baseline answers
 * "is our fusion better than the standard weighted-sum, at equal embedder?"
 * honestly; the embedder gap is measured separately when a learned model lands.
 */
export function weightedSumFusionBaseline(
	store: FactStore,
	embedder: Embedder,
	origin?: RecordOriginFilter,
): RecallCapability {
	return {
		async search(query, opts) {
			const now = Date.now();
			const candidates = store
				.list(origin !== undefined ? { origin } : {})
				.filter((r) => r.validTo === undefined || r.validTo > now);
			if (candidates.length === 0) return [];
			// Plain BM25 (no Tideline modulation) → normalise to [0,1].
			const lex = bm25Score(candidates, query, now, { modulate: false });
			const lexById = new Map(lex.map((s) => [s.record.memoryId, s.score]));
			const lexMax = Math.max(1e-9, ...lex.map((s) => s.score));
			const qv = (embedder.embed([query]) as number[][])[0] ?? [];
			const fused = candidates
				.map((r) => {
					const lexN = (lexById.get(r.memoryId) ?? 0) / lexMax;
					const sim =
						r.embedding && r.embedding.length === qv.length ? Math.max(0, cosine(qv, r.embedding)) : 0;
					// Classic weighted-sum (0.7 vec / 0.3 text), faded by temporal decay.
					return { record: r, score: (0.7 * sim + 0.3 * lexN) * effectiveScore(r, now) };
				})
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt);
			const limited = opts?.limit && opts.limit > 0 ? fused.slice(0, opts.limit) : fused;
			return limited.map((x) => ({ id: x.record.memoryId, score: x.score }));
		},
	};
}

/**
 * **Graph-augmented recall** (Step 20) — the gated spreading-activation walk
 * over the store's active + origin-filtered records. `forceWalk` is ON for the
 * eval lane so the multi-hop benefit is measurable on a multi-hop gold set (the
 * route-gate's "single-fact flat" behaviour is asserted separately in
 * graph-recall.test.ts). Lets the harness show "multi-hop category ↑ vs hybrid".
 */
export function graphRecallCapability(store: FactStore, origin?: RecordOriginFilter): RecallCapability {
	return {
		async search(query, opts) {
			// `store.list` is gated by lifecycle/segment/origin only; the bi-temporal
			// valid-time gate (validTo > now) is applied INSIDE recallWithGraph, so
			// this lane and oracleCapability score the SAME candidate set (expired
			// future-dated facts excluded from both) — the multi-hop comparison stays
			// apples-to-apples.
			const active = store.list(origin !== undefined ? { origin } : {});
			const hits = recallWithGraph(active, query, {
				forceWalk: true,
				...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
			});
			return hits.map((h) => ({ id: h.record.memoryId, score: h.score }));
		},
	};
}

/**
 * **Full-context dump** (the "no-retrieval" baseline) — returns ALL active
 * (origin-filtered) facts, IGNORING the query, in most-recent-first order
 * (`store.list()` sorts by `createdAt` descending — no relevance ranking, that's
 * the point). Models "just stuff everything into the prompt".
 *
 * Reading its recall@k HONESTLY: at k ≥ corpus it includes everything → recall =
 * 1.0 (it never LOSES a fact — see the k≥corpus test). Below that, a context
 * BUDGET forces a choice of which k facts to include; un-ranked, it takes the
 * most-recently-written k facts, so a low recall@k is a TRUNCATION artifact, NOT a recall
 * deficiency — the gap to the index is exactly "ranking fills a bounded budget
 * with RELEVANT facts; dumping can't". Its genuine, non-tautological cost vs the
 * index is ABSTENTION: it returns facts even on a no-answer query (a
 * hallucination feed), where the index stays silent. So it is compared on
 * abstention + budget-bounded recall — never headlined as a recall rival the
 * index "beats".
 */
export function oracleCapability(store: FactStore, origin?: RecordOriginFilter): RecallCapability {
	return {
		async search(_query, opts) {
			const now = Date.now();
			// active-only + bi-temporal valid-time gate (matches FactStore.search):
			// a fact whose `validTo` has passed is excluded from recall.
			const all = store
				.list(origin !== undefined ? { origin } : {})
				.filter((r) => r.validTo === undefined || r.validTo > now);
			// limit contract matches the store: a positive limit caps, otherwise
			// fall back to the lane default (here: all candidates).
			const limited = opts?.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;
			return limited.map((r, i) => ({ id: r.memoryId, score: 1 - i * 1e-6 }));
		},
	};
}
