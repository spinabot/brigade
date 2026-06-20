/**
 * Multi-signal recall fusion (Tideline v2) — the best MODEL-FREE recall we can
 * do. Learned embeddings are NOT mandatory here: the (zero-dep, air-gap) HRR
 * vector is just ONE signal, not the star. Robust recall comes from COMBINING a
 * lexical workhorse with a fuzzy recovery lane:
 *
 *   WORKHORSE: BM25 × trust × decay (the v1 scorer) — exact lexical relevance,
 *   down-weighted by provenance/confidence, faded by Ebbinghaus decay. Its hits
 *   keep BM25's order, so fusion does NO HARM where lexical is already right.
 *   RECOVERY: ONE vector-cosine lane over the {@link Embedder} seam, used ONLY to
 *   surface facts BM25 MISSED entirely (appended BELOW every lexical hit, never
 *   reordering them). With the bundled zero-dep HRR embedder (a bag-of-words
 *   model) this lane is deliberately conservative — the `minSim` floor rejects
 *   function-word noise, so model-free it rarely adds over BM25. Drop a LEARNED
 *   embedder into the seam and the SAME lane does true synonymy recovery; that's
 *   where it earns its keep. (A token-set Jaccard lane was removed: any shared
 *   token already forces a BM25 hit, so it could never surface a miss — dead code.)
 *   MODULATION (relevance × trust × decay): × trust(provenance × confidence) ×
 *     effectiveScore(decay + importance) — applied to BOTH lanes.
 *   DIVERSITY: MMR rerank — opt-in (λ<1) for context-block assembly;
 *     OFF by default (λ=1) so single-fact recall isn't diversified.
 *
 * Origin isolation is the caller's job (pass active + origin-filtered candidates),
 * same contract as `bm25Score`.
 */

import { effectiveScore } from "./decay.js";
import { cosine, type Embedder } from "./embedder.js";
import type { MemoryRecord, MemorySourceType } from "./records.js";
import { bm25Score } from "./scoring.js";

// Vector-lane floor. The bundled HRR embedder scores unrelated text ≈ 0 and
// function-word-only overlap ≈ 0.2; 0.3 keeps that noise OUT (so model-free the
// lane fires only on real multi-token overlap). A learned embedder, whose cosine
// tracks meaning not tokens, clears this comfortably on true paraphrases.
const DEFAULT_MIN_SIM = 0.3;
// MMR OFF by default (λ=1 ⇒ pure relevance). Diversity is a CONTEXT-BLOCK concern
// (assembling a varied prompt) not a fact-FINDING one — on single-relevant-fact
// recall, diversifying only hurts ranking. No v1 caller opts in: recall() and
// context() both run at the λ=1 default; λ<1 is exercised only by tests.
// (Reconciles the plan's "λ=0.7": that 0.7 IS this opt-in — a deliberate DEFAULT of
// 1.0 for fact recall, with 0.7 available per-call for multi-fact block assembly,
// rather than diversifying single-fact lookups by default. A tuned default, not a gap.)
const DEFAULT_MMR_LAMBDA = 1.0;

/**
 * TRUST multiplier from provenance. The operator (or legacy/
 * undefined) is fully trusted; distilled/derived facts slightly less; external
 * ingested content (tool/retrieved/compaction — the write-gate's "untrusted"
 * set) is materially down-weighted so it can't dominate recall.
 */
const TRUST_BY_SOURCE: Record<MemorySourceType, number> = {
	user_instruction: 1.0,
	owner_message: 1.0,
	extraction: 0.9,
	dream: 0.85,
	compaction: 0.85,
	channel_message: 0.8,
	tool_output: 0.65,
	retrieved_document: 0.6,
};

function trustFactor(r: MemoryRecord): number {
	const base = r.sourceType ? (TRUST_BY_SOURCE[r.sourceType] ?? 0.9) : 1.0; // undefined/legacy ⇒ trusted
	const conf = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 1;
	return base * conf;
}

export interface HybridScored {
	record: MemoryRecord;
	/** Final fused + modulated score (higher = better). */
	score: number;
	lexRank?: number;
	vecRank?: number;
}

export function recallHybrid(
	candidates: readonly MemoryRecord[],
	query: string,
	embedder: Embedder,
	now: number = Date.now(),
	opts: { limit?: number; minSim?: number; mmrLambda?: number } = {},
): HybridScored[] {
	const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
	// Per-embedder recovery floor: an explicit opt wins; else the embedder's own
	// recommended floor (a noisy model-free HRR sets a HIGH one); else the default.
	const minSim = opts.minSim ?? embedder.minSim ?? DEFAULT_MIN_SIM;
	const lambda = opts.mmrLambda ?? DEFAULT_MMR_LAMBDA;
	if (candidates.length === 0) return [];

	// ── PRIMARY: BM25 (the v1 scorer — damped decay baked in, the MRR-preserving
	// order), × trust. Its hits keep their order; the recovery lanes below NEVER
	// demote a BM25 hit, so the mix does NO HARM where lexical is already good. ──
	const lex = bm25Score(candidates, query, now);
	const lexIds = new Set(lex.map((s) => s.record.memoryId));

	// ── RECOVERY lane: vector cosine over the embedder seam, used ONLY to surface
	// facts BM25 MISSED (a recall boost, never a reorder of BM25's hits). ──
	const qv = (embedder.embed([query]) as number[][])[0] ?? [];
	const vecRank = new Map<string, number>();
	candidates
		.map((r) => ({ id: r.memoryId, sim: r.embedding && r.embedding.length === qv.length ? cosine(qv, r.embedding) : -1 }))
		.filter((x) => x.sim >= minSim)
		.sort((a, b) => b.sim - a.sim)
		.forEach((x, i) => vecRank.set(x.id, i + 1));

	// PRIMARY results: BM25 hits in BM25 order × trust. On clean/trusted data
	// trust=1 ⇒ exactly BM25's order (no MRR regression); on real data trust
	// intentionally demotes untrusted facts (the security/quality lever).
	const primary: HybridScored[] = lex.map((s, i) => {
		const id = s.record.memoryId;
		return {
			record: s.record,
			score: s.score * trustFactor(s.record),
			lexRank: i + 1,
			...(vecRank.has(id) ? { vecRank: vecRank.get(id) } : {}),
		};
	});
	primary.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt);

	// RECOVERY results: facts BM25 MISSED, found by the vector lane — appended
	// BELOW every primary hit (score strictly under the lowest primary), ordered
	// by cosine rank and damped by trust × decay (so a stale recovered fact can't
	// outrank a fresh one; `0.5 + 0.5·effectiveScore` keeps the damp in (0,1]).
	const byId = new Map(candidates.map((r) => [r.memoryId, r]));
	const minPrimary = primary.length ? (primary[primary.length - 1]?.score ?? 0) : 1;
	const recovered: HybridScored[] = [...vecRank.keys()]
		.filter((id) => !lexIds.has(id))
		.map((id) => ({ id, rank: vecRank.get(id) ?? Number.POSITIVE_INFINITY }))
		.sort((a, b) => a.rank - b.rank)
		.map((x, i): HybridScored | null => {
			const record = byId.get(x.id);
			if (!record) return null;
			const decayDamp = 0.5 + 0.5 * effectiveScore(record, now);
			return {
				record,
				score: minPrimary * 0.5 * 0.9 ** i * trustFactor(record) * decayDamp,
				vecRank: x.rank,
			};
		})
		.filter((x): x is HybridScored => x !== null);

	// MMR diversity is OPT-IN (λ<1, for context-block assembly); default λ=1 = noop.
	return mmrRerank([...primary, ...recovered], lambda, limit);
}

/**
 * Maximal Marginal Relevance: greedily pick the highest-scored, then each next
 * pick maximises `λ·relevance − (1−λ)·maxSimToSelected`, so near-duplicate facts
 * don't crowd the top-k. Relevance is normalised to [0,1] so it's comparable to
 * the cosine diversity term; similarity uses the HRR embeddings (0 when absent).
 */
function mmrRerank(scored: HybridScored[], lambda: number, limit: number): HybridScored[] {
	if (scored.length <= 1) return scored.slice(0, limit);
	// Normalise by the GREATEST score (not scored[0]) so rel∈[0,1] regardless of
	// input ordering; guard to 1 when all scores are ≤0 (pool is non-empty here).
	const peak = Math.max(...scored.map((s) => s.score));
	const maxScore = peak > 0 ? peak : 1;
	const pool = scored.map((s) => ({ ...s, rel: s.score / maxScore }));
	const selected: typeof pool = [];
	while (selected.length < limit && pool.length > 0) {
		let bestIdx = 0;
		let bestVal = -Infinity;
		for (let i = 0; i < pool.length; i++) {
			const cand = pool[i];
			if (!cand) continue;
			// The diversity term is weighted by (1−λ), so when λ≥1 (the default) it
			// drops out entirely — skip the O(k²·d) pairwise cosine and use 0.
			let maxSim = 0;
			if (lambda < 1) {
				for (const s of selected) {
					const sim =
						cand.record.embedding && s.record.embedding && cand.record.embedding.length === s.record.embedding.length
							? cosine(cand.record.embedding, s.record.embedding)
							: 0;
					if (sim > maxSim) maxSim = sim;
				}
			}
			const mmr = lambda * cand.rel - (1 - lambda) * maxSim;
			if (mmr > bestVal) {
				bestVal = mmr;
				bestIdx = i;
			}
		}
		const [picked] = pool.splice(bestIdx, 1);
		if (picked) selected.push(picked);
	}
	return selected.map(({ rel: _rel, ...s }) => s);
}

/** Async variant for a model-backed embedder: pre-embed the query once. */
export async function recallHybridAsync(
	candidates: readonly MemoryRecord[],
	query: string,
	embedder: Embedder,
	now: number = Date.now(),
	opts: { limit?: number; minSim?: number; mmrLambda?: number } = {},
): Promise<HybridScored[]> {
	const qv = (await embedder.embed([query]))[0] ?? [];
	// Preserve the embedder's recommended recovery-lane floor when rebuilding the
	// pre-embedded stand-in: recallHybrid reads `embedder.minSim` off this wrapper,
	// so omitting it would silently drop the per-embedder `minSim` contract (a
	// no-op for every current embedder, which omit it; matters for a learned one).
	const preEmbedded: Embedder = {
		id: embedder.id,
		dims: embedder.dims,
		...(embedder.minSim !== undefined ? { minSim: embedder.minSim } : {}),
		embed: () => [qv],
	};
	return recallHybrid(candidates, query, preEmbedded, now, opts);
}
