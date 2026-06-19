/**
 * Tideline eval metrics — pure, backend-agnostic ranking-quality functions.
 *
 * The measuring stick for recall quality (Tideline build Step 1). Everything
 * here is a pure function over (retrievedIds, relevantIds): no I/O, no clock,
 * no hidden state — so the harness AND the CI recall-quality gate can trust
 * the numbers. Relevance is BINARY (a retrieved id is gold or it isn't);
 * graded relevance is a later upgrade if the gold set ever needs it.
 *
 * Conventions:
 *   - `retrievedIds` is the ranked result list (best first), the ids a
 *     `RecallCapability.search` returned in order.
 *   - `relevantIds` is the gold set for a query — the ids that SHOULD surface.
 *   - `k` is the top-k cutoff; callers pass the same k they report at.
 *   - EMPTY `relevantIds` is an ABSTENTION case: recall has a zero denominator
 *     and is meaningless, so these return `NaN` and the harness excludes them
 *     from the accuracy means. Guard at the call site.
 */

/** Distinct ids in the first `k` of `retrievedIds`, as a Set (dedupes). */
function topKSet(retrievedIds: readonly string[], k: number): Set<string> {
	return new Set(retrievedIds.slice(0, Math.max(0, k)));
}

/**
 * recall@k — fraction of the (deduped) gold set that appears in the top-k.
 * |relevant ∩ top-k| / |relevant|. Range [0,1]. `NaN` when |relevant| === 0.
 */
export function recallAtK(retrievedIds: readonly string[], relevantIds: readonly string[], k: number): number {
	const gold = new Set(relevantIds);
	if (gold.size === 0) return Number.NaN; // abstention — caller must exclude
	const top = topKSet(retrievedIds, k);
	let hit = 0;
	for (const id of gold) if (top.has(id)) hit += 1;
	return hit / gold.size;
}

/**
 * Reciprocal rank — 1 / (1-based rank of the FIRST relevant hit). 0 when no
 * relevant id appears anywhere in `retrievedIds`. Mean over cases = MRR.
 */
export function reciprocalRank(retrievedIds: readonly string[], relevantIds: readonly string[]): number {
	const gold = new Set(relevantIds);
	if (gold.size === 0) return Number.NaN;
	for (let i = 0; i < retrievedIds.length; i++) {
		if (gold.has(retrievedIds[i]!)) return 1 / (i + 1);
	}
	return 0;
}

/** hit@k — 1 if ANY relevant id is in the top-k, else 0. `NaN` on abstention. */
export function hitAtK(retrievedIds: readonly string[], relevantIds: readonly string[], k: number): number {
	const gold = new Set(relevantIds);
	if (gold.size === 0) return Number.NaN;
	const top = topKSet(retrievedIds, k);
	for (const id of gold) if (top.has(id)) return 1;
	return 0;
}

/**
 * nDCG@k with binary relevance. DCG = Σ rel_i / log2(rank+1) over the top-k
 * (rank is 1-based, so the discount for position i (0-based) is log2(i+2)).
 * IDCG = the DCG of the ideal ranking (every relevant id packed at the top).
 * nDCG = DCG / IDCG, range [0,1]; `NaN` on abstention, 0 when IDCG is 0.
 */
export function ndcgAtK(retrievedIds: readonly string[], relevantIds: readonly string[], k: number): number {
	const gold = new Set(relevantIds);
	if (gold.size === 0) return Number.NaN;
	const cut = Math.max(0, k);
	// Dedup FIRST (keep first occurrence), THEN take the top-k DISTINCT results, so
	// "k" consistently means k distinct retrieved ids and the discount is each id's
	// position in the deduped ranking. This is textbook position-based DCG with no
	// ambiguity: a repeat neither wastes a raw top-k slot (depressing the score) nor
	// compresses later ranks (inflating it) — the two failure modes of cutting raw
	// positions while ranking only distinct ids.
	const seen = new Set<string>();
	const distinct: string[] = [];
	for (const id of retrievedIds) {
		if (seen.has(id)) continue;
		seen.add(id);
		distinct.push(id);
		if (distinct.length >= cut) break;
	}
	let dcg = 0;
	for (let i = 0; i < distinct.length; i++) {
		if (gold.has(distinct[i]!)) dcg += 1 / Math.log2(i + 2); // 0-based i ⇒ 1-based rank i+1
	}
	const idealHits = Math.min(cut, gold.size);
	let idcg = 0;
	for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
	return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Percentile (nearest-rank, p in [0,100]) over a numeric sample. Returns 0 for
 * an empty sample. Used for latency (p50/p95). Sorts a copy — input untouched.
 */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const clampedP = Math.max(0, Math.min(100, p));
	const rank = Math.max(1, Math.ceil((clampedP / 100) * sorted.length)); // 1-based nearest-rank
	return sorted[rank - 1]!;
}

/** Arithmetic mean, ignoring non-finite (NaN) entries. Returns 0 when NOTHING is
 *  finite (an all-abstention run) — a SENTINEL, not a measured 0%. Callers/gates
 *  that branch on the value MUST also check the count of scored cases (the harness
 *  reports `nScored`) to tell "no scorable cases" from a genuine zero. */
export function meanIgnoringNaN(values: readonly number[]): number {
	let sum = 0;
	let n = 0;
	for (const v of values) {
		if (Number.isFinite(v)) {
			sum += v;
			n += 1;
		}
	}
	return n === 0 ? 0 : sum / n;
}
