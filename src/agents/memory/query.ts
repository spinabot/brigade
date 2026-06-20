import type { FactStore, MemoryRecord } from "./records.js";
import { tokenize } from "./scoring.js";

/**
 * Read-only memory inspection for the operator surface (the `/memory` TUI command + its
 * gateway RPC). Deliberately PASSIVE: it never reinforces decay (no markAccessed), never
 * mutates, and never runs the agent's hybrid recall — it's an inspection window, not the
 * model's recall path. Search is a simple token-overlap match over active facts so the
 * operator can find a memory without side effects. All origins are shown (the operator owns
 * the gateway) with an origin label, so a human can audit what each principal has stored.
 */

export interface MemoryFactView {
	memoryId: string;
	content: string;
	segment: string;
	tier: string;
	/** Storage lifecycle: "active" | "archived" | "pruned". */
	lifecycle: string;
	status?: string;
	importance: number;
	createdAt: number;
	lastAccessedAt: number;
	/** "owner" or "channel:<channelId>" — which principal authored it. */
	origin: string;
	/** Token-overlap rank for `search`; absent for list/inspect. */
	score?: number;
}

export interface MemoryStatsView {
	total: number;
	active: number;
	archived: number;
	bySegment: Record<string, number>;
	owner: number;
	channel: number;
	addedLast7d: number;
}

export type MemoryQueryAction = "list" | "search" | "inspect" | "stats";

export interface MemoryQueryResult {
	action: MemoryQueryAction;
	facts: MemoryFactView[];
	stats?: MemoryStatsView;
}

export interface MemoryQueryOpts {
	action: MemoryQueryAction;
	query?: string;
	memoryId?: string;
	limit?: number;
	/** Injectable clock (epoch ms) for deterministic tests. */
	now?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function originLabel(r: MemoryRecord): string {
	return r.createdBy?.kind === "channel" ? `channel:${r.createdBy.channelId}` : "owner";
}

function toView(r: MemoryRecord, score?: number): MemoryFactView {
	return {
		memoryId: r.memoryId,
		content: r.content,
		segment: r.segment,
		tier: r.tier,
		lifecycle: r.lifecycle,
		status: r.status,
		importance: r.importance,
		createdAt: r.createdAt,
		lastAccessedAt: r.lastAccessedAt,
		origin: originLabel(r),
		...(score !== undefined ? { score } : {}),
	};
}

export function queryMemory(store: FactStore, opts: MemoryQueryOpts): MemoryQueryResult {
	const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, MAX_LIMIT) : DEFAULT_LIMIT;

	switch (opts.action) {
		case "stats": {
			const all = store.readAll();
			const bySegment: Record<string, number> = {};
			let active = 0;
			let archived = 0;
			let owner = 0;
			let channel = 0;
			let addedLast7d = 0;
			const now = opts.now ?? Date.now();
			for (const r of all) {
				if (r.lifecycle === "active") {
					active += 1;
					bySegment[r.segment] = (bySegment[r.segment] ?? 0) + 1;
					if (r.createdBy?.kind === "channel") channel += 1;
					else owner += 1;
					if (now - r.createdAt <= 7 * DAY_MS) addedLast7d += 1;
				} else if (r.lifecycle === "archived") {
					archived += 1;
				}
			}
			return {
				action: "stats",
				facts: [],
				stats: { total: all.length, active, archived, bySegment, owner, channel, addedLast7d },
			};
		}
		case "inspect": {
			const id = opts.memoryId;
			// Exact id first, else a unique PREFIX (git-style short ids) — operators paste what
			// the list shows, which may be a prefix of the full memoryId.
			const all = store.readAll();
			const r = id ? (all.find((x) => x.memoryId === id) ?? all.find((x) => x.memoryId.startsWith(id))) : undefined;
			return { action: "inspect", facts: r ? [toView(r)] : [] };
		}
		case "search": {
			const qTokens = [...new Set(tokenize(opts.query ?? ""))];
			if (qTokens.length === 0) return { action: "search", facts: [] };
			// Forgiving match: a query token hits a content token on exact OR prefix (either
			// direction, len>=3) — so "live" finds "lives", "vegetar" finds "vegetarian". An
			// operator searches stems, not exact word-forms.
			const hit = (c: string, q: string): boolean =>
				c === q || (q.length >= 3 && c.length >= 3 && (c.startsWith(q) || q.startsWith(c)));
			const scored = store
				.list()
				.map((r) => {
					const cTokens = tokenize(r.content);
					return { r, overlap: qTokens.filter((q) => cTokens.some((c) => hit(c, q))).length };
				})
				.filter((x) => x.overlap > 0)
				.sort((a, b) => b.overlap - a.overlap || b.r.createdAt - a.r.createdAt)
				.slice(0, limit);
			return { action: "search", facts: scored.map((x) => toView(x.r, x.overlap)) };
		}
		default: {
			// "list" — newest active facts first.
			const recent = store
				.list()
				.slice()
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, limit);
			return { action: "list", facts: recent.map((r) => toView(r)) };
		}
	}
}
