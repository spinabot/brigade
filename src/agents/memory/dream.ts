// src/agents/memory/dream.ts
//
// Tideline Step 22 — the nightly dream (Lane A reflection, per-origin).
//
// A periodic, deterministic reflection over an origin's facts that lets memory
// AUTO-EVOLVE — Lane A is reversible and changes NO agent behaviour:
//   • CONFIRM    — a belief asserted/reinforced ≥ N times (a "3× repeated
//                  correction") is promoted to a CONFIRMED preference
//                  (status="confirmed" + confidence ↑). The marquee outcome.
//   • CONSOLIDATE— near-identical active facts (embedding cosine ≥ a high bar)
//                  are merged: the stronger keeper bi-temporally supersedes the
//                  duplicate. Per-origin only (the candidate set is origin-
//                  filtered first), so it never crosses principals.
//   • EVICT      — active facts whose effectiveScore has decayed below a floor
//                  (old enough, NOT confirmed) are archived.
//
// REVERSIBLE: confirms log their `prior` (a future pass / the operator restores
// it); consolidations + evictions ARCHIVE, never delete. The "reflection with
// citations" + an NLI confirm are SEAMS — an LLM adapter can gate/justify each
// promotion; the v1 default is the deterministic rules above so it runs offline
// on a cron with zero model cost.

import { effectiveScore } from "./decay.js";
import { synonymyEdges } from "./graph.js";
import {
	FactStore,
	originBucketKey,
	recordMatchesOriginFilter,
	type MemoryRecord,
	type MemoryStatus,
	type RecordOriginFilter,
} from "./records.js";
import { isTrustedTarget } from "./write-gate.js";

const DAY_MS = 86_400_000;

export interface DreamOpts {
	/** Reflect over just this principal's facts (default: every origin). */
	origin?: RecordOriginFilter;
	/** Assertions (accessCount + 1) needed to confirm a belief. Default 3. */
	confirmCount?: number;
	/** Confidence to stamp on a confirmed belief. Default 0.9. */
	confirmConfidence?: number;
	/** Cosine bar for merging near-identical duplicates. Default 0.95. */
	consolidateThreshold?: number;
	/** effectiveScore floor below which a fact is eligible for eviction. Default 0.05. */
	evictBelowScore?: number;
	/** Only evict facts older than this (ms). Default 30 days. */
	evictMinAgeMs?: number;
	now?: number;
}

export interface DreamResult {
	/** How many active facts were examined. */
	reflected: number;
	/** Beliefs promoted to confirmed (with the prior values, for reversal). */
	confirmed: Array<{ memoryId: string; prior: { confidence?: number; status?: MemoryStatus; importance?: number } }>;
	/** Near-identical merges: keeper ← duplicate. */
	consolidated: Array<{ kept: string; merged: string }>;
	/** Archived (decayed) ids. */
	evicted: string[];
}

/**
 * Run one dream pass over `store`. Pass `origin` to scope it to a single
 * principal (the cron fans this out per-origin). Returns what it changed.
 */
export function runDream(store: FactStore, opts: DreamOpts = {}): DreamResult {
	const now = opts.now ?? Date.now();
	const confirmCount = opts.confirmCount ?? 3;
	const confirmConfidence = opts.confirmConfidence ?? 0.9;
	const consolidateThreshold = opts.consolidateThreshold ?? 0.95;
	const evictBelow = opts.evictBelowScore ?? 0.05;
	const evictMinAge = opts.evictMinAgeMs ?? 30 * DAY_MS;

	const inOrigin = (r: MemoryRecord): boolean => !opts.origin || recordMatchesOriginFilter(r, opts.origin);
	const activeNow = (): MemoryRecord[] => store.list({ limit: 100_000 }).filter(inOrigin);

	let active = activeNow();
	const result: DreamResult = { reflected: active.length, confirmed: [], consolidated: [], evicted: [] };

	// ── CONFIRM: a subjectKey belief is confirmed when EITHER the same value was
	//    asserted/reinforced ≥ confirmCount (assertions = accessCount + 1), OR the
	//    subject was CORRECTED ≥ confirmCount times (archived same-subject,
	//    same-origin predecessors). So both "said X three times" and "revised the
	//    value over three corrections, now settled" promote the current belief.
	// GENUINE corrections only: a same-slot supersede stamps the NEW fact with
	// contradicts/transition edges pointing at the prior it replaced, so an archived
	// predecessor that is the TARGET of such an edge was genuinely corrected. Decay,
	// eviction, and consolidation ALSO archive (without those edges) — counting them
	// would falsely CONFIRM a once-asserted belief whose slot merely churned via decay.
	const supersededTargets = new Set<string>();
	for (const a of store.readAll()) {
		for (const l of a.links ?? []) {
			if (l.kind === "contradicts" || l.kind === "transition") supersededTargets.add(l.target);
		}
	}
	const correctionDepth = new Map<string, number>();
	for (const a of store.readAll()) {
		if (a.lifecycle === "active" || !a.subjectKey || !supersededTargets.has(a.memoryId)) continue;
		const k = JSON.stringify([originBucketKey(a), a.subjectKey]);
		correctionDepth.set(k, (correctionDepth.get(k) ?? 0) + 1);
	}
	for (const r of active) {
		if (!r.subjectKey || r.status === "confirmed") continue;
		const assertions = r.accessCount + 1;
		const corrections = correctionDepth.get(JSON.stringify([originBucketKey(r), r.subjectKey])) ?? 0;
		if (Math.max(assertions, corrections) < confirmCount) continue;
		const prior = store.promote(
			r.memoryId,
			{ status: "confirmed", confidence: confirmConfidence, importance: Math.max(r.importance, 0.8) },
			{ now },
		);
		if (prior) result.confirmed.push({ memoryId: r.memoryId, prior });
	}
	if (result.confirmed.length > 0) active = activeNow();

	// ── CONSOLIDATE: near-identical active pairs → keep stronger, supersede dup.
	// Bucket by origin FIRST so a merge NEVER crosses principals — even in a
	// whole-store pass (opts.origin undefined): synonymyEdges runs PER origin
	// bucket, so an owner fact can't dissolve into a channel peer's identical one
	// (which would leak a cross-principal contradicts/transition edge).
	const byId = new Map(active.map((r) => [r.memoryId, r]));
	const merged = new Set<string>();
	const buckets = new Map<string, MemoryRecord[]>();
	for (const r of active) {
		const k = originBucketKey(r);
		const arr = buckets.get(k);
		if (arr) arr.push(r);
		else buckets.set(k, [r]);
	}
	for (const bucket of buckets.values()) {
		for (const e of synonymyEdges(bucket, { threshold: consolidateThreshold })) {
			if (merged.has(e.from) || merged.has(e.to)) continue;
			const a = byId.get(e.from);
			const b = byId.get(e.to);
			if (!a || !b) continue;
			// Keeper precedence, each dominating the next: (1) TRUST — an untrusted fact
			// must NEVER supersede a trusted owner-authored one (write-gate Rule 2: the
			// write path enforces it, so the dream must too — else attacker-influenceable
			// content archives an owner belief); (2) CONFIRMED — a confirmed belief
			// outranks a non-confirmed near-duplicate; (3) effectiveScore.
			const trust = (r: MemoryRecord): number => (isTrustedTarget(r.sourceType) ? 1 : 0);
			const conf = (r: MemoryRecord): number => (r.status === "confirmed" ? 1 : 0);
			const aWins =
				trust(a) !== trust(b)
					? trust(a) > trust(b)
					: conf(a) !== conf(b)
						? conf(a) > conf(b)
						: effectiveScore(a, now) >= effectiveScore(b, now);
			const [keep, drop] = aWins ? [a, b] : [b, a];
			// Don't dissolve one confirmed belief into ANOTHER — both are load-bearing.
			if (keep.status === "confirmed" && drop.status === "confirmed") continue;
			store.invalidate(drop.memoryId, { supersededBy: keep.memoryId, now });
			merged.add(drop.memoryId);
			result.consolidated.push({ kept: keep.memoryId, merged: drop.memoryId });
		}
	}
	if (result.consolidated.length > 0) active = activeNow();

	// ── EVICT: decayed below the floor, old enough, never a confirmed belief.
	const toEvict = active
		.filter((r) => r.status !== "confirmed")
		.filter((r) => now - r.createdAt >= evictMinAge)
		.filter((r) => effectiveScore(r, now) < evictBelow)
		.map((r) => r.memoryId);
	result.evicted = store.evict(toEvict, { now });

	return result;
}
