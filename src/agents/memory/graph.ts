// src/agents/memory/graph.ts
//
// Tideline Step 19 — the queryable memory graph + entity resolution.
//
// Turns a flat record set (links.ts substrate) into an adjacency structure you
// can traverse (forward edges + backlinks), plus the two derivation passes the
// graph-walk (step 20) and the dream (step 22) consume:
//   • ENTITY RESOLUTION — recurring proper-noun spans → entity descriptors
//     (model-free heuristic; a learned NER drops into the same shape later).
//   • SYNONYMY edges — cosine ≥ threshold over the existing HRR embeddings.
//
// ORIGIN SAFETY: the graph is origin-AGNOSTIC because it never crosses origins —
// the CALLER passes an already origin-filtered record set, and the graph only
// ever references ids inside that set (dangling edges to facts outside the set
// are dropped). So a per-origin recall builds a per-origin graph; nothing leaks.
//
// All sync, zero-dep, air-gapped (same discipline as the rest of Tideline).

import { cosine, getDefaultEmbedder, type Embedder } from "./embedder.js";
import { linksFrom, type MemoryLink, type MemoryLinkKind } from "./links.js";
import type { MemoryRecord } from "./records.js";

/** Temporal-evolution edge kinds — a supersede/correction chain. The walk and
 *  the dream follow these to trace how a belief changed over time. */
export const TRANSITION_KINDS: readonly MemoryLinkKind[] = ["supersedes", "transition", "corrects"];

export interface MemoryGraph {
	readonly byId: Map<string, MemoryRecord>;
	/** memoryId → outbound edges (explicit links[] ∪ mirrored supersedes[]). */
	readonly out: Map<string, MemoryLink[]>;
	/** memoryId → inbound edges (the backlinks). */
	readonly in: Map<string, Array<{ from: string; kind: MemoryLinkKind }>>;
}

/** Build the adjacency once over an (origin-filtered) record set. Edges that
 *  point outside the set are dropped — the graph is closed over `records`. */
export function buildGraph(records: readonly MemoryRecord[]): MemoryGraph {
	const byId = new Map<string, MemoryRecord>();
	for (const r of records) byId.set(r.memoryId, r);
	const out = new Map<string, MemoryLink[]>();
	const inMap = new Map<string, Array<{ from: string; kind: MemoryLinkKind }>>();
	for (const r of records) {
		const edges = linksFrom(r).filter((l) => byId.has(l.target) && l.target !== r.memoryId);
		out.set(r.memoryId, edges);
		for (const e of edges) {
			const arr = inMap.get(e.target) ?? [];
			arr.push({ from: r.memoryId, kind: e.kind });
			inMap.set(e.target, arr);
		}
	}
	return { byId, out, in: inMap };
}

export interface NeighborOpts {
	/** Restrict to these edge kinds (default: all). */
	kinds?: readonly MemoryLinkKind[];
	/** "out" = this fact's links, "in" = backlinks, "both" (default). */
	direction?: "out" | "in" | "both";
}

/** 1-hop neighbour ids (deduped), optionally filtered by edge kind / direction. */
export function neighbors(g: MemoryGraph, id: string, opts: NeighborOpts = {}): string[] {
	const dir = opts.direction ?? "both";
	const kindOk = (k: MemoryLinkKind): boolean => !opts.kinds || opts.kinds.includes(k);
	const ids = new Set<string>();
	if (dir === "out" || dir === "both") {
		for (const e of g.out.get(id) ?? []) if (kindOk(e.kind)) ids.add(e.target);
	}
	if (dir === "in" || dir === "both") {
		for (const e of g.in.get(id) ?? []) if (kindOk(e.kind)) ids.add(e.from);
	}
	ids.delete(id);
	return [...ids];
}

export interface SpreadOpts {
	/** Max hops from the seeds (default 2 — the step-20 cap). */
	maxHops?: number;
	/** Max neighbours expanded per node (degree cap, default 10). */
	fanOut?: number;
	/** Restrict traversal to these edge kinds. */
	kinds?: readonly MemoryLinkKind[];
}

/** Bounded breadth-first spread from `seedIds` → Map<id, minHops> (seeds = hop 0).
 *  The substrate the step-20 recall walk activates over; capped by maxHops AND a
 *  per-node fan-out so a hub node can't explode the frontier. */
export function spread(
	g: MemoryGraph,
	seedIds: readonly string[],
	opts: SpreadOpts = {},
): Map<string, number> {
	const maxHops = opts.maxHops ?? 2;
	const fanOut = opts.fanOut ?? 10;
	const hops = new Map<string, number>();
	let frontier: string[] = [];
	for (const s of seedIds) {
		if (g.byId.has(s) && !hops.has(s)) {
			hops.set(s, 0);
			frontier.push(s);
		}
	}
	for (let h = 1; h <= maxHops && frontier.length > 0; h++) {
		const next: string[] = [];
		for (const id of frontier) {
			const nbrs = neighbors(g, id, opts.kinds ? { kinds: opts.kinds } : {}).slice(0, fanOut);
			for (const n of nbrs) {
				if (!hops.has(n)) {
					hops.set(n, h);
					next.push(n);
				}
			}
		}
		frontier = next;
	}
	return hops;
}

/* ─────────────────────────── entity resolution ─────────────────────────── */

export interface ResolvedEntity {
	/** Canonical surface form (e.g. "Bangalore", "Project Atlas"). */
	name: string;
	/** memoryIds of the facts that mention it (distinct). */
	mentions: string[];
}

// Capitalised tokens that are almost never the entity we care about in a memory
// fact ("User likes X", "I moved to Y"). Frequency alone wouldn't filter these —
// they recur constantly — so they're excluded explicitly. Lower-cased compare.
const ENTITY_STOPWORDS = new Set([
	"the", "a", "an", "i", "i'm", "im", "my", "me", "you", "your", "we", "our",
	"he", "she", "they", "it", "this", "that", "these", "those", "user", "owner",
	"and", "or", "but", "so", "then", "when", "where", "why", "how", "what",
	"his", "her", "their", "its", "is", "are", "was", "were", "to", "of", "in",
	"on", "at", "for", "with", "by", "as", "if",
]);

/** A proper-noun span = a run of Capitalised words (each starts upper, rest not
 *  all-caps acronym-only handled too). Strips trailing punctuation. */
function extractSpans(content: string): string[] {
	const spans: string[] = [];
	// Split on whitespace; build runs of capitalised tokens.
	const tokens = content.split(/\s+/);
	let run: string[] = [];
	const flush = (): void => {
		if (run.length > 0) {
			const span = run.join(" ").replace(/[.,;:!?'")\]]+$/, "").replace(/^[("[]+/, "");
			if (span.length > 1) spans.push(span);
			run = [];
		}
	};
	for (const raw of tokens) {
		// Strip surrounding punctuation AND a trailing possessive ('s / ’s) so
		// "Sarah's" clusters with "Sarah" instead of forming a second entity.
		const t = raw
			.replace(/^[("[]+/, "")
			.replace(/[.,;:!?'")\]]+$/, "")
			.replace(/['’]s$/i, "")
			.replace(/['’]$/, "");
		const isCapitalised = /^[A-Z][A-Za-z0-9'-]*$/.test(t);
		const isStop = ENTITY_STOPWORDS.has(t.toLowerCase());
		if (isCapitalised && !isStop) {
			run.push(t);
		} else {
			flush();
		}
	}
	flush();
	return spans;
}

/** Model-free entity resolution: recurring proper-noun spans mentioned in
 *  ≥ `minMentions` DISTINCT facts. Heuristic (no NER model); the frequency
 *  threshold + stopword list keep "User"/"I"/sentence-starts out. Case-folded
 *  for clustering, surfaced in its most common original casing.
 *
 *  STATUS (Step 19): the companion to the now-wired synonymy `relates` links (see
 *  {@link synonymyEdges} + `FactStore.linkRelated`, persisted by the dream pass).
 *  This RESOLVER primitive is complete + tested; the entity-NOTE PROMOTION pass
 *  that consumes it (mint a hub note per resolved entity + `relates`-link its
 *  mentions) is the remaining unwired half — kept ready + tested, not dead code. */
export function resolveEntities(
	records: readonly MemoryRecord[],
	opts: { minMentions?: number } = {},
): ResolvedEntity[] {
	const minMentions = opts.minMentions ?? 2;
	// key = lowercased span → { mentions:Set<memoryId>, forms:Map<surface,count> }
	const acc = new Map<string, { mentions: Set<string>; forms: Map<string, number> }>();
	for (const r of records) {
		const seen = new Set<string>(); // a fact mentioning an entity twice counts once
		for (const span of extractSpans(r.content)) {
			const key = span.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			const entry = acc.get(key) ?? { mentions: new Set<string>(), forms: new Map<string, number>() };
			entry.mentions.add(r.memoryId);
			entry.forms.set(span, (entry.forms.get(span) ?? 0) + 1);
			acc.set(key, entry);
		}
	}
	const out: ResolvedEntity[] = [];
	for (const entry of acc.values()) {
		if (entry.mentions.size < minMentions) continue;
		// canonical = most common original casing
		let name = "";
		let best = -1;
		for (const [form, n] of entry.forms) {
			if (n > best) {
				best = n;
				name = form;
			}
		}
		out.push({ name, mentions: [...entry.mentions] });
	}
	// Most-mentioned first (stable, deterministic — no Math.random/Date).
	out.sort((a, b) => b.mentions.length - a.mentions.length || a.name.localeCompare(b.name));
	return out;
}

/* ───────────────────────────── synonymy edges ──────────────────────────── */

export interface SynonymyEdge {
	from: string;
	to: string;
	sim: number;
}

/** Synonymy/relatedness pairs over the embedding space: every DISTINCT pair of
 *  facts with cosine ≥ `threshold` (default 0.8). Uses each record's stored
 *  `embedding` when present, else embeds its content via the default embedder.
 *  Returns undirected pairs (from < to by id). The dream uses these BOTH as a
 *  consolidation signal (merging near-duplicates above the merge bar) AND — for
 *  related-but-not-merged pairs at/above the relatedness threshold — PERSISTS them as
 *  `relates` links via `FactStore.linkRelated` (Step 19), so the graph-recall walk
 *  can traverse them. Persistence is per-origin (the dream buckets by origin first).
 *
 *  O(n²) GUARD: the comparison is strict all-pairs, so it explodes as a store
 *  grows. The nightly consolidation caller (dream.ts) buckets the WHOLE active
 *  store by origin and passes each whole bucket here — origin-filtering scopes
 *  the set but does NOT size-bound it (the owner bucket grows without limit). So
 *  when `records.length` exceeds `maxRecords` (default 500) we restrict the
 *  pairwise scan to the `maxRecords` most-recently-active facts (by
 *  `lastAccessedAt`, then `createdAt`, then id — deterministic, no clock/random),
 *  bounding both the embed work and the O(n²) loop. Pass `maxRecords` to widen/
 *  narrow it; the high consolidate threshold means it caps the comparison COUNT,
 *  not the (tiny) output. */
export function synonymyEdges(
	records: readonly MemoryRecord[],
	opts: { threshold?: number; embedder?: Embedder; maxRecords?: number } = {},
): SynonymyEdge[] {
	const threshold = opts.threshold ?? 0.8;
	const embedder = opts.embedder ?? getDefaultEmbedder();
	const maxRecords = opts.maxRecords ?? 500;
	// Above the cap, scan only the most-recently-active slice — newest beliefs are
	// the consolidation-relevant ones, and this bounds the all-pairs cost on a
	// store that grows unattended on the curator daemon. Copy before sorting so
	// the caller's array is never mutated; ties break deterministically by id.
	if (records.length > maxRecords) {
		records = [...records]
			.sort(
				(a, b) =>
					b.lastAccessedAt - a.lastAccessedAt ||
					b.createdAt - a.createdAt ||
					a.memoryId.localeCompare(b.memoryId),
			)
			.slice(0, maxRecords);
	}
	// Resolve a vector per record (stored embedding wins; else embed on the fly).
	const needEmbed = records.filter((r) => !r.embedding || r.embedding.length === 0);
	let fresh: number[][] = [];
	if (needEmbed.length > 0) {
		const v = embedder.embed(needEmbed.map((r) => r.content));
		// HRR/hash embedders are sync; the learned-model seam is async. Synonymy
		// is a derivation pass (dream/consolidation), never the hot recall path,
		// so a Promise here means "no precomputed vectors" → skip on-the-fly embed
		// for the async case rather than block (those records just don't synonymy-
		// link this pass; they will once their embedding is persisted on write).
		if (!(v instanceof Promise)) fresh = v;
	}
	let fi = 0;
	const vec = new Map<string, readonly number[]>();
	for (const r of records) {
		if (r.embedding && r.embedding.length > 0) {
			vec.set(r.memoryId, r.embedding);
		} else {
			const f = fresh[fi];
			if (f) {
				vec.set(r.memoryId, f);
				fi++;
			}
		}
	}
	const out: SynonymyEdge[] = [];
	for (let i = 0; i < records.length; i++) {
		const a = records[i]!;
		const va = vec.get(a.memoryId);
		if (!va) continue;
		for (let j = i + 1; j < records.length; j++) {
			const b = records[j]!;
			const vb = vec.get(b.memoryId);
			if (!vb) continue;
			const sim = cosine(va, vb);
			if (sim >= threshold) {
				const [from, to] = a.memoryId < b.memoryId ? [a.memoryId, b.memoryId] : [b.memoryId, a.memoryId];
				out.push({ from, to, sim });
			}
		}
	}
	out.sort((a, b) => b.sim - a.sim);
	return out;
}
