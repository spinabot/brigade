// src/agents/memory/graph-recall.ts
//
// Tideline Step 20 — graph-augmented recall (the gated spreading-activation walk).
//
// Pipeline: ROUTE-gate → SEED (hybrid) → SPREAD ≤2 hops → degree-normalize →
// 3-way RRF (lexical ⊕ vector ⊕ graph) → drop superseded → top-k.
//
//   • ROUTE-gate — the walk engages ONLY for multi-hop / temporal intent (query
//     markers, OR ≥2 seeds that are graph-connected). A plain single-fact query
//     skips the walk entirely → IDENTICAL to recallHybrid (the "single-fact flat,
//     no regression" guarantee is the gate, not luck).
//   • SPREAD — bounded BFS from the seeds over the graph (δ per hop, fan-out cap).
//   • degree-normalize — hub nodes (high degree) are down-weighted so a popular
//     fact can't dominate the graph lane.
//   • 3-way RRF — reciprocal-rank fusion of the lexical rank, the vector rank,
//     and the graph-activation rank; a fact absent from a lane simply doesn't
//     score in it (standard RRF).
//
// ORIGIN SAFETY: the caller passes an already origin-filtered candidate set, so
// the graph is per-origin and every hop stays in-origin (Step 19 invariant).

import { buildGraph, neighbors, spread } from "./graph.js";
import { getDefaultEmbedder, type Embedder } from "./embedder.js";
import { recallHybrid, type HybridScored } from "./hybrid.js";
import type { MemoryRecord } from "./records.js";

export interface GraphRecallOpts {
	limit?: number;
	/** How many top hybrid hits seed the walk (default 4). */
	seedCount?: number;
	/** Hop decay δ (default 0.5). */
	hopDecay?: number;
	/** Max hops (default 2). */
	maxHops?: number;
	/** Per-node fan-out cap (default 10). */
	fanOut?: number;
	/** RRF constant (default 60). */
	rrfK?: number;
	minSim?: number;
	/** Force the walk on/off (skips the route-gate) — for eval/tests. */
	forceWalk?: boolean;
}

export interface GraphRecallResult {
	record: MemoryRecord;
	score: number;
	/** True when this fact was pulled in by the graph walk (not a seed). */
	viaGraph: boolean;
	hop?: number;
}

const TEMPORAL = /\b(when|before|after|previously|used to|history|changed|evolved|became|earlier|originally|since|ago|no longer|anymore)\b/i;
const RELATIONAL = /\b(related|because|due to|led to|connected|linked|associated|caused|reason|affect|depend)\b/i;

/** ROUTE-gate: should the spreading walk engage for this query? Multi-hop /
 *  temporal intent only — a single-fact query returns false so recall is left
 *  exactly as the hybrid produced it. */
function shouldWalk(
	query: string,
	seedIds: readonly string[],
	g: ReturnType<typeof buildGraph>,
): boolean {
	if (TEMPORAL.test(query) || RELATIONAL.test(query)) return true;
	// Otherwise walk only if the SEEDS themselves are graph-connected (the query
	// pulled multiple facts that link to each other → multi-hop context exists).
	const seedSet = new Set(seedIds);
	for (const id of seedIds) {
		for (const n of neighbors(g, id)) {
			if (seedSet.has(n)) return true; // an edge BETWEEN two seeds
		}
	}
	return false;
}

/** RRF contribution: 1 / (k + rank). */
function rrf(rank: number, k: number): number {
	return 1 / (k + rank);
}

/**
 * Graph-augmented recall. `active` MUST be the origin-filtered, active
 * (non-superseded) candidate set. Returns top-k fused results; when the
 * route-gate declines, returns the pure hybrid ranking (single-fact flat).
 */
export function recallWithGraph(
	active: readonly MemoryRecord[],
	query: string,
	opts: GraphRecallOpts = {},
	now: number = Date.now(),
	embedder: Embedder = getDefaultEmbedder(),
): GraphRecallResult[] {
	const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
	const seedCount = opts.seedCount ?? 4;
	const hopDecay = opts.hopDecay ?? 0.5;
	const maxHops = opts.maxHops ?? 2;
	const fanOut = opts.fanOut ?? 10;
	const rrfK = opts.rrfK ?? 60;

	// Bi-temporal valid-time gate (matches FactStore.recall/search and the eval
	// oracle): a fact whose future-dated `validTo` has now passed is excluded even
	// though its lifecycle is still "active". Applied at ENTRY so the seeds, the
	// graph, and the fused set are all gated identically — no expired fact can leak
	// into the model's pre-turn context via any lane (lexical / vector / graph).
	const fresh = active.filter((r) => r.validTo === undefined || r.validTo > now);

	// SEED — hybrid recall over the full candidate set (it owns lexical + vector).
	const seedHybridOpts: { limit: number; minSim?: number } = { limit: Math.max(limit, seedCount * 2) };
	if (opts.minSim !== undefined) seedHybridOpts.minSim = opts.minSim;
	const seed: HybridScored[] = recallHybrid(fresh, query, embedder, now, seedHybridOpts);
	if (seed.length === 0) return [];

	const seedIds = seed.slice(0, seedCount).map((s) => s.record.memoryId);
	const g = buildGraph(fresh);

	// ROUTE-gate — single-fact / non-relational → return the pure hybrid order.
	if (!opts.forceWalk && !shouldWalk(query, seedIds, g)) {
		return seed.slice(0, limit).map((s) => ({ record: s.record, score: s.score, viaGraph: false }));
	}

	// SPREAD from the seeds (bounded).
	const hops = spread(g, seedIds, { maxHops, fanOut });

	// Lane ranks. Lexical + vector come from the hybrid seed (its order encodes
	// the BM25-primary ⊕ vector-recovery rank); the graph lane is the spread,
	// degree-normalized and hop-decayed.
	const lexRank = new Map<string, number>();
	const vecRank = new Map<string, number>();
	seed.forEach((s) => {
		// LEXICAL lane: ONLY actual BM25 primaries (recallHybrid sets `lexRank` for
		// primaries alone). A vector-RECOVERY fact — one BM25 MISSED — has lexRank
		// undefined; it must NOT be injected into the lexical lane via a positional
		// fallback (the old `?? i + 1`), or it gets double-counted (lexical ⊕ vector) and
		// can out-rank a genuine lexical hit. It scores only in the vector lane below.
		if (s.lexRank !== undefined) lexRank.set(s.record.memoryId, s.lexRank);
		if (s.vecRank !== undefined) vecRank.set(s.record.memoryId, s.vecRank);
	});

	const graphWeight = new Map<string, number>();
	for (const [id, hop] of hops) {
		// EXCLUDE the hop-0 seeds: they already rank via lex⊕vec, so they must NOT
		// also enter the graph lane (degree-normalisation there could demote a
		// genuine top lexical hit). The graph lane only ranks DISCOVERED facts
		// (hop ≥ 1), which then fuse in alongside — never reordering the seeds
		// among themselves. "No harm where lexical is already right."
		if (hop === 0) continue;
		const degree = neighbors(g, id).length;
		// δ^hop, down-weighted by degree so a hub doesn't dominate the graph lane.
		graphWeight.set(id, hopDecay ** hop / Math.sqrt(1 + degree));
	}
	const graphRank = new Map<string, number>();
	[...graphWeight.entries()]
		.sort((a, b) => b[1] - a[1])
		.forEach(([id], i) => graphRank.set(id, i + 1));

	// 3-way RRF over the union of all lanes' ids.
	const ids = new Set<string>([...lexRank.keys(), ...vecRank.keys(), ...graphRank.keys()]);
	const byId = new Map(fresh.map((r) => [r.memoryId, r]));
	const fused: GraphRecallResult[] = [];
	for (const id of ids) {
		const record = byId.get(id);
		if (!record || record.lifecycle !== "active") continue; // drop superseded
		let score = 0;
		if (lexRank.has(id)) score += rrf(lexRank.get(id)!, rrfK);
		if (vecRank.has(id)) score += rrf(vecRank.get(id)!, rrfK);
		if (graphRank.has(id)) score += rrf(graphRank.get(id)!, rrfK);
		const isSeed = lexRank.has(id) || vecRank.has(id);
		fused.push({
			record,
			score,
			viaGraph: !isSeed,
			...(hops.has(id) ? { hop: hops.get(id) } : {}),
		});
	}
	// Tie-break by recency (deterministic — no clock/random in the sort).
	fused.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt);
	return fused.slice(0, limit);
}
