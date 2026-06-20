// src/agents/memory/governance.ts
//
// Tideline Step 24 — governance: purge (crypto-shred + cascade), retention TTL,
// inspect, export.
//
//   • PURGE — hard-removes a fact (crypto-shred: the sealed content is gone, not
//     archived) AND CASCADES along `sourcePointers`: any fact DERIVED from a
//     purged one (a dream/extraction citation) is purged too, recursively. This
//     is the "no zombie memories" guarantee — a purged fact can't resurrect
//     through a derived citation in the next dream.
//   • RETENTION — hard-purge facts older than a TTL (confirmed beliefs retained
//     by default), cascading the same way.
//   • INSPECT — a fact + its outbound links, backlinks, and provenance.
//   • EXPORT — dump records (optionally one origin) for portability / GDPR.

import { backlinksTo, linksFrom, type MemoryLink, type MemoryLinkKind } from "./links.js";
import { FactStore, recordMatchesOriginFilter, type MemoryRecord, type RecordOriginFilter } from "./records.js";

export interface PurgeResult {
	/** Every id hard-removed — the seed(s) plus the sourcePointers cascade. */
	purged: string[];
}

/** Reverse index: sourceId → ids of facts that cite it in `sourcePointers`. */
function buildDerivedIndex(records: readonly MemoryRecord[]): Map<string, string[]> {
	const derivedOf = new Map<string, string[]>();
	for (const r of records) {
		for (const src of r.sourcePointers ?? []) {
			const arr = derivedOf.get(src) ?? [];
			arr.push(r.memoryId);
			derivedOf.set(src, arr);
		}
	}
	return derivedOf;
}

/**
 * BFS the derivation tree from `seeds` along `sourcePointers` so a citation chain
 * (A → B-derived-from-A → C-derived-from-B) is fully collapsed. Returns every id
 * to remove. Shared by `purge` (global) and `applyRetention` (origin-bounded).
 */
function cascadeFrom(records: readonly MemoryRecord[], seeds: readonly string[]): Set<string> {
	const derivedOf = buildDerivedIndex(records);
	const toPurge = new Set<string>();
	const queue = [...seeds];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (toPurge.has(id)) continue;
		toPurge.add(id);
		for (const d of derivedOf.get(id) ?? []) if (!toPurge.has(d)) queue.push(d);
	}
	return toPurge;
}

/**
 * Purge `seedIds` and everything transitively DERIVED from them (via
 * `sourcePointers`). Crypto-shred: the records are hard-removed. Idempotent.
 * The cascade is intentionally GLOBAL (cross-origin) — the direct purge action
 * is "no zombie memories" at any cost. (Retention scopes its own cascade.)
 */
export function purge(store: FactStore, seedIds: string | readonly string[]): PurgeResult {
	const seeds = typeof seedIds === "string" ? [seedIds] : seedIds;
	return { purged: store.purge([...cascadeFrom(store.readAll(), seeds)]) };
}

/**
 * Retention TTL — hard-purge facts whose transaction-time age exceeds `ttlMs`,
 * cascading along sourcePointers. Confirmed beliefs are retained by default
 * (a confirmed preference shouldn't expire just because it's old).
 */
export function applyRetention(
	store: FactStore,
	opts: { ttlMs: number; now?: number; keepConfirmed?: boolean; origin?: RecordOriginFilter },
): PurgeResult {
	const now = opts.now ?? Date.now();
	const keepConfirmed = opts.keepConfirmed ?? true;
	const all = store.readAll();
	const inOrigin = (r: MemoryRecord): boolean => opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin);
	// A fact is PURGE-ELIGIBLE only when it is in-origin AND older than the TTL AND not
	// a kept-confirmed belief. ORIGIN SCOPE: without it an owner-invoked retention would
	// purge channel peers' facts wholesale (a cross-principal breach). Omitted ⇒ whole
	// store (the internal/admin default).
	const eligible = (r: MemoryRecord): boolean =>
		inOrigin(r) && now - r.createdAt > opts.ttlMs && !(keepConfirmed && r.status === "confirmed");
	const expired = all.filter(eligible).map((r) => r.memoryId);
	if (expired.length === 0) return { purged: [] };
	// Cascade along sourcePointers — but re-apply the SAME eligibility to every cascade
	// member, NOT just origin. Otherwise a same-origin fact that merely CITES an expired
	// seed is hard-purged even when it is itself CONFIRMED or WITHIN the TTL, silently
	// breaking the keepConfirmed guarantee and the age contract (a brand-new fact that
	// cited an old source would be destroyed). We keep the "no orphaned derivations"
	// intent only among facts that are THEMSELVES expirable; a confirmed/young deriver is
	// preserved (a kept orphan beats irreversibly shredding a still-valid belief).
	const byId = new Map(all.map((r) => [r.memoryId, r]));
	const bounded = [...cascadeFrom(all, expired)].filter((id) => {
		const r = byId.get(id);
		return r !== undefined && eligible(r);
	});
	if (bounded.length === 0) return { purged: [] };
	return { purged: store.purge(bounded) };
}

export interface InspectResult {
	record: MemoryRecord;
	/** This fact's outbound edges (explicit links ∪ mirrored supersedes). */
	outbound: MemoryLink[];
	/** Inbound edges across the corpus. */
	backlinks: Array<{ from: string; kind: MemoryLinkKind }>;
	/** Source ids this fact was derived from (its citations). */
	derivedFrom: string[];
	/** Ids of facts derived FROM this one (its citers — the cascade set). */
	derives: string[];
}

/** Full provenance view of one fact: links, backlinks, and the citation graph. */
export function inspect(store: FactStore, memoryId: string): InspectResult | undefined {
	const all = store.readAll();
	const record = all.find((r) => r.memoryId === memoryId);
	if (!record) return undefined;
	const derivedOf = buildDerivedIndex(all);
	return {
		record,
		outbound: linksFrom(record),
		backlinks: backlinksTo(all, memoryId),
		derivedFrom: [...(record.sourcePointers ?? [])],
		derives: derivedOf.get(memoryId) ?? [],
	};
}

/** Export records — all, or scoped to one origin (portability / data-subject export). */
export function exportMemory(store: FactStore, opts: { origin?: RecordOriginFilter } = {}): MemoryRecord[] {
	const all = store.readAll();
	return opts.origin ? all.filter((r) => recordMatchesOriginFilter(r, opts.origin!)) : all;
}
