/**
 * Contradiction detection + bi-temporal invalidation (Tideline v2, step 15).
 *
 * When a new belief conflicts with a stored one, surface it — and on confirm,
 * close the stale fact's VALID interval (`validTo`) + archive it, rather than
 * deleting it. That's a BI-TEMPORAL supersede: the old fact stays in history
 * (transaction time `createdAt` is untouched), it just stops being true in valid
 * time. Recall already serves only `active`, so an invalidated fact disappears
 * from results but the audit trail survives.
 *
 * The candidate-find is DETERMINISTIC + model-free (same subject, divergent
 * claim). Picking the WINNER (which fact is right) is the seam
 * — an NLI/LLM check, or the caller/`write_memory(supersedes)`. We never
 * auto-invalidate on the heuristic alone; we surface candidates.
 */

import { cosine } from "./embedder.js";
import type { MemoryRecord } from "./records.js";
import { tokenize } from "./scoring.js";

export interface ContradictionCandidate {
	/** The (typically newer) fact. */
	a: MemoryRecord;
	/** The (typically older) fact it may contradict. */
	b: MemoryRecord;
	/** Token-set overlap (same topic/subject). */
	overlap: number;
	/** 1 − content similarity (divergent claim). */
	divergence: number;
	/** overlap × divergence — higher = more likely a contradiction. */
	score: number;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter += 1;
	return inter / (a.size + b.size - inter);
}

/**
 * Find candidate contradictions among ACTIVE records (caller pre-filters to
 * active + same origin — contradictions are within ONE belief-holder). Two facts
 * in the SAME segment that share topic tokens (overlap ≥ `minOverlap`) but
 * diverge in claim (low embedding similarity → high divergence) score above
 * `threshold`. Returns pairs newest-first as `a`. O(n²) over the candidate set —
 * fine at single-operator scale; gate to a segment/recent window for big stores.
 *
 * NOTE: surface-only — callers choose the winner and call `FactStore.invalidate`
 * after (e.g. `dream.ts` consolidation, `manage-memory-tool` write path).
 */
export function findContradictions(
	records: readonly MemoryRecord[],
	opts: { threshold?: number; minOverlap?: number } = {},
): ContradictionCandidate[] {
	const threshold = opts.threshold ?? 0.12;
	const minOverlap = opts.minOverlap ?? 0.2;
	const toks = records.map((r) => new Set(tokenize(r.content)));
	const out: ContradictionCandidate[] = [];
	for (let i = 0; i < records.length; i++) {
		for (let j = i + 1; j < records.length; j++) {
			const ri = records[i];
			const rj = records[j];
			if (!ri || !rj || ri.segment !== rj.segment) continue;
			const ti = toks[i] ?? new Set<string>();
			const tj = toks[j] ?? new Set<string>();
			const overlap = jaccard(ti, tj);
			if (overlap < minOverlap) continue;
			// Divergence from embeddings when both carry one (convex/both-modes),
			// else from token SYMMETRIC-DIFFERENCE: the fraction of value-bearing
			// tokens unique to EITHER side (|A xor B| / |A ∪ B|, i.e. 1 − overlap).
			// High shared-subject + high unique-claim = likely contradiction.
			// (Inverse-overlap was perverse — it scored the MOST-similar pairs
			// lowest and dropped legacy contradictions.)
			let divergence: number;
			if (ri.embedding && rj.embedding && ri.embedding.length === rj.embedding.length) {
				divergence = 1 - Math.max(0, cosine(ri.embedding, rj.embedding));
			} else {
				let inter = 0;
				for (const x of ti) if (tj.has(x)) inter += 1;
				const symDiff = ti.size + tj.size - 2 * inter;
				const union = inter + symDiff;
				divergence = union > 0 ? symDiff / union : 0;
			}
			const score = overlap * divergence;
			if (score < threshold) continue;
			// Newest fact is `a` (the one likely superseding the other). On a
			// createdAt tie, fall back to a deterministic memoryId compare so the
			// pick does NOT depend on input array order.
			const inI = ri.createdAt > rj.createdAt || (ri.createdAt === rj.createdAt && ri.memoryId >= rj.memoryId);
			const [a, b] = inI ? [ri, rj] : [rj, ri];
			out.push({ a, b, overlap, divergence, score });
		}
	}
	return out.sort((x, y) => y.score - x.score);
}
