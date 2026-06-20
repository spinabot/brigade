/**
 * Memory Graph EXPORT — the data layer behind the "Memory Graph" dashboard view
 * (nodes + typed edges + topic clusters + headline stats). A PURE function over a
 * fact snapshot (host-import-free, so it travels with the brigade-tideline package);
 * a gateway endpoint serves its output to the web UI. The force-directed LAYOUT is
 * the frontend's job — this provides the graph, the clustering, and the counts.
 */

import { linksFrom, type MemoryLinkKind } from "./links.js";
import type { MemoryRecord } from "./records.js";

export type EdgeStrength = "strong" | "medium" | "weak";

export interface GraphNode {
	id: string;
	/** a short content snippet for the node label */
	label: string;
	segment: string;
	importance: number;
	createdAt: number;
	/** the community this node belongs to (links to a {@link GraphCluster}.id) */
	clusterId: string;
	sourceType?: string;
}

export interface GraphEdge {
	from: string;
	to: string;
	kind: MemoryLinkKind;
	strength: EdgeStrength;
}

export interface GraphCluster {
	id: string;
	/** the cluster's representative subject/snippet (an LLM topic-label is the enhancement) */
	label: string;
	size: number;
}

export interface MemoryGraphStats {
	totalMemories: number;
	connections: number;
	clusters: number;
	/** segment → count (the donut breakdown) */
	byType: Record<string, number>;
	/** memories created within the last 7 days (the "vs last 7 days" delta numerator) */
	addedLast7d: number;
}

export interface MemoryGraphExport {
	nodes: GraphNode[];
	edges: GraphEdge[];
	clusters: GraphCluster[];
	stats: MemoryGraphStats;
}

const DAY_MS = 86_400_000;

/** Edge strength by kind → the UI's strong/medium/weak line styles. Definitive
 *  lifecycle edges = strong; derivation/support = medium; generic association = weak. */
function strengthOf(kind: MemoryLinkKind): EdgeStrength {
	switch (kind) {
		case "supersedes":
		case "transition":
		case "corrects":
		case "contradicts":
			return "strong";
		case "derived_from":
		case "supports":
			return "medium";
		default:
			return "weak"; // relates
	}
}
const STRENGTH_WEIGHT: Record<EdgeStrength, number> = { strong: 1, medium: 0.6, weak: 0.3 };

/** Deterministic weighted label-propagation community detection over the typed-link
 *  graph (undirected, edge weight = strength). Lightweight + dependency-free; returns
 *  node id → community-representative id. A heavier Louvain/Leiden pass or an LLM
 *  topic-label is the enhancement; this gives stable communities for the dashboard. */
function detectCommunities(nodeIds: string[], adjacency: Map<string, Array<{ to: string; w: number }>>): Map<string, string> {
	const label = new Map<string, string>(nodeIds.map((id) => [id, id]));
	const order = [...nodeIds].sort(); // fixed order ⇒ deterministic result
	for (let iter = 0; iter < 20; iter++) {
		let changed = false;
		for (const id of order) {
			const nbrs = adjacency.get(id);
			if (!nbrs || nbrs.length === 0) continue;
			const tally = new Map<string, number>();
			for (const { to, w } of nbrs) {
				const l = label.get(to);
				if (l !== undefined) tally.set(l, (tally.get(l) ?? 0) + w);
			}
			let best = label.get(id) as string;
			let bestW = -1;
			for (const [l, w] of [...tally].sort((a, b) => a[0].localeCompare(b[0]))) {
				// tie-break by label string (the sort above) ⇒ deterministic winner
				if (w > bestW) {
					bestW = w;
					best = l;
				}
			}
			if (best !== label.get(id)) {
				label.set(id, best);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return label;
}

function snippet(content: string, max = 48): string {
	const s = content.trim().replace(/\s+/g, " ");
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Build the dashboard graph payload from a fact snapshot (e.g. `FactStore.readAll()`
 * / `list({ limit })`). `maxNodes` caps the node set returned for the VISUALIZATION
 * (top-importance first); the clusters + stats are always computed over the full
 * active set. Active facts only — archived/pruned are excluded.
 */
export function exportMemoryGraph(
	records: readonly MemoryRecord[],
	opts: { now?: number; maxNodes?: number } = {},
): MemoryGraphExport {
	const now = opts.now ?? Date.now();
	const active = records.filter((r) => r.lifecycle === "active");
	const activeIds = new Set(active.map((r) => r.memoryId));

	// Edges (target must also be active — no dangling) + an undirected weighted
	// adjacency for community detection. Dedupe the EXPORTED edges by unordered
	// pair+kind so a bidirectional `relates` shows as one line, not two.
	const adjacency = new Map<string, Array<{ to: string; w: number }>>();
	const addAdj = (a: string, b: string, w: number): void => {
		let arr = adjacency.get(a);
		if (!arr) {
			arr = [];
			adjacency.set(a, arr);
		}
		arr.push({ to: b, w });
	};
	const seenEdge = new Set<string>();
	const edges: GraphEdge[] = [];
	for (const r of active) {
		for (const link of linksFrom(r)) {
			if (!activeIds.has(link.target)) continue;
			const strength = strengthOf(link.kind);
			const w = STRENGTH_WEIGHT[strength];
			addAdj(r.memoryId, link.target, w);
			addAdj(link.target, r.memoryId, w);
			const [x, y] = r.memoryId < link.target ? [r.memoryId, link.target] : [link.target, r.memoryId];
			const key = `${x}|${y}|${link.kind}`;
			if (seenEdge.has(key)) continue;
			seenEdge.add(key);
			edges.push({ from: r.memoryId, to: link.target, kind: link.kind, strength });
		}
	}

	// Communities over the full active graph.
	const community = detectCommunities(
		active.map((r) => r.memoryId),
		adjacency,
	);

	// Cluster summary: group by community, label by the highest-importance member.
	const byCommunity = new Map<string, MemoryRecord[]>();
	for (const r of active) {
		const c = community.get(r.memoryId) ?? r.memoryId;
		let arr = byCommunity.get(c);
		if (!arr) {
			arr = [];
			byCommunity.set(c, arr);
		}
		arr.push(r);
	}
	const clusters: GraphCluster[] = [...byCommunity.entries()]
		.map(([id, members]) => {
			const rep = [...members].sort(
				(a, b) => b.importance - a.importance || a.memoryId.localeCompare(b.memoryId),
			)[0] as MemoryRecord;
			return { id, label: rep.subjectKey?.trim() || snippet(rep.content), size: members.length };
		})
		.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));

	// Nodes for the viz: cap to maxNodes by importance (clusters/stats use the full set).
	const maxNodes = opts.maxNodes && opts.maxNodes > 0 ? opts.maxNodes : active.length;
	const vizRecords =
		active.length <= maxNodes
			? active
			: [...active]
					.sort((a, b) => b.importance - a.importance || a.memoryId.localeCompare(b.memoryId))
					.slice(0, maxNodes);
	const vizIds = new Set(vizRecords.map((r) => r.memoryId));
	const nodes: GraphNode[] = vizRecords.map((r) => ({
		id: r.memoryId,
		label: snippet(r.content),
		segment: r.segment,
		importance: r.importance,
		createdAt: r.createdAt,
		clusterId: community.get(r.memoryId) ?? r.memoryId,
		...(r.sourceType !== undefined ? { sourceType: r.sourceType } : {}),
	}));
	// Trim edges to the viz subset (both endpoints must be in vizIds).
	// stats.connections uses the full `edges` count — only the rendered graph is trimmed.
	const vizEdges = edges.filter((e) => vizIds.has(e.from) && vizIds.has(e.to));

	// Stats over the FULL active set.
	const byType: Record<string, number> = {};
	for (const r of active) byType[r.segment] = (byType[r.segment] ?? 0) + 1;
	const addedLast7d = active.filter((r) => now - r.createdAt <= 7 * DAY_MS).length;

	return {
		nodes,
		edges: vizEdges,
		clusters,
		stats: {
			totalMemories: active.length,
			connections: edges.length,
			clusters: clusters.length,
			byType,
			addedLast7d,
		},
	};
}
