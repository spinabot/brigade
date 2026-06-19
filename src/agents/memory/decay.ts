/**
 * Memory decay GC — file-store version of recall-frequency-driven promotion.
 * Pure arithmetic over importance / accessCount / lastAccessedAt — no model
 * call — so it runs cheaply inside the gateway's background sweep alongside
 * extraction.
 *
 * A fact's live score decays exponentially with time-since-last-access, on a
 * half-life that's LONGER for important facts (so identity sticks, context
 * fades), and is reinforced by how often it's been recalled. Neglected facts
 * archive then prune; `permanent`-tier facts (identity) never decay. This is
 * the self-pruning that keeps the structured store from growing without
 * bound.
 */

import { FactStore, type MemoryRecord } from "./records.js";

const DAY_MS = 86_400_000;
/** Base half-life in days; scaled up by importance. */
const BASE_HALF_LIFE_DAYS = 11.25;
const DECAY_BETA = 0.8;
/** Below this live score → prune (dead). */
const PRUNE_THRESHOLD = 0.05;
/** Below this (and not a long-tier fact) → archive (kept, out of active recall). */
const ARCHIVE_THRESHOLD = 0.15;

/**
 * Current live score in [0,1]. `permanent` tier is pinned at 1 (never decays).
 * Effective-score formula: importance-scaled half-life, per-segment decay
 * trim, and log-reinforcement from recall count.
 */
export function effectiveScore(rec: MemoryRecord, now: number = Date.now()): number {
	if (rec.tier === "permanent") return 1;
	const daysSinceAccess = Math.max(0, (now - rec.lastAccessedAt) / DAY_MS);
	const adaptiveHalfLife = BASE_HALF_LIFE_DAYS * (1 + rec.importance);
	const lambda = (Math.LN2 / Math.max(adaptiveHalfLife, 0.001)) * DECAY_BETA;
	const effectiveLambda = lambda * (1 + rec.decayRate);
	const decayed = rec.importance * Math.exp(-effectiveLambda * daysSinceAccess);
	const reinforcement = 1 + Math.log1p(rec.accessCount) * 0.1;
	return Math.max(0, Math.min(1, decayed * reinforcement));
}

export interface DecayResult {
	archived: number;
	pruned: number;
	kept: number;
}

/**
 * Sweep active facts: prune the dead, archive the faded (non-`long`), keep the
 * rest. `permanent` facts are always kept. Idempotent + cheap; safe to run on
 * every background sweep (decay is gradual — most runs change nothing).
 */
export function runDecayGc(workspaceDir: string, now: number = Date.now()): DecayResult {
	const store = new FactStore(workspaceDir);
	const active = store.list(); // active-only
	const toPrune: string[] = [];
	const toArchive: string[] = [];
	for (const r of active) {
		if (r.tier === "permanent") continue;
		const score = effectiveScore(r, now);
		// Long-tier (identity/preference/correction/relationship/project) is the DURABLE
		// tier: decay may at most ARCHIVE it (kept, recoverable via reactivate), NEVER
		// hard-prune it — so it stays active down to the prune floor, then ARCHIVES rather
		// than pruning. (Previously the `!== "long"` guard sat ONLY on the archive branch,
		// so a long fact skipped the archived grace state and jumped active → pruned — the
		// MORE durable tier ended up LESS recoverable, since reactivate() restores only
		// archived.) Short/context facts age out fully: active → archived → pruned.
		if (r.tier === "long") {
			if (score < PRUNE_THRESHOLD) toArchive.push(r.memoryId);
		} else if (score < PRUNE_THRESHOLD) {
			toPrune.push(r.memoryId);
		} else if (score < ARCHIVE_THRESHOLD) {
			toArchive.push(r.memoryId);
		}
	}
	if (toPrune.length > 0) store.setLifecycle(toPrune, "pruned");
	if (toArchive.length > 0) store.setLifecycle(toArchive, "archived");
	return {
		archived: toArchive.length,
		pruned: toPrune.length,
		kept: active.length - toPrune.length - toArchive.length,
	};
}
