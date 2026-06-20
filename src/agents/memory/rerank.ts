/**
 * Rerank seam + contextual-retrieval helper (Tideline v2, step 16).
 *
 * The cheap hybrid recall (BM25 primary ⊕ one HRR vector recovery lane × trust × decay) returns a good
 * top-k fast. RERANKING is an OPT-IN, OFF-THE-HOT-PATH refinement: a stronger
 * model (a BGE cross-encoder, or an LLM-judge) reorders that small top-k by deep
 * query↔fact relevance for precision-at-fixed-recall. Default = identity (no
 * model, no change) — so recall stays model-free unless a reranker is wired.
 *
 * Contextual retrieval: embed a fact WITH light context (its segment)
 * so the vector captures more than the bare text. Opt-in helper here; embed-on-
 * write can adopt it without changing the recall API.
 */

import type { MemoryRecord } from "./records.js";

export type RerankHit = MemoryRecord & { score: number };

/** Reorders recall hits by deeper relevance. Sync or async (a model may await). */
export type Reranker = (query: string, candidates: readonly RerankHit[]) => RerankHit[] | Promise<RerankHit[]>;

/** The default — NO reranking (model-free; recall order is unchanged). */
export const identityReranker: Reranker = (_query, candidates) => [...candidates];

let _reranker: Reranker = identityReranker;
/** Plug a model-backed reranker (cross-encoder / LLM-judge) into the seam. */
export function setReranker(r: Reranker): void {
	_reranker = r;
}

/**
 * Apply the active (or a given) reranker to recall results. OFF the hot path —
 * call only when precision-at-fixed-recall matters (the model cost is per-query
 * over a SMALL top-k, not per-fact). Best-effort: a reranker error falls back to
 * the original order.
 */
export async function rerank(
	query: string,
	candidates: readonly RerankHit[],
	reranker: Reranker = _reranker,
): Promise<RerankHit[]> {
	try {
		return await reranker(query, candidates);
	} catch {
		return [...candidates];
	}
}

/**
 * Contextual-retrieval embed text — prepend light context (the segment) to the
 * content so the embedding carries more signal than the bare fact. Opt-in:
 * `embed-on-write` can switch to this without touching the recall API.
 */
export function contextualEmbedText(record: Pick<MemoryRecord, "segment" | "content">): string {
	return `[${record.segment}] ${record.content}`;
}
