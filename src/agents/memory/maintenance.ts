import { join } from "node:path";

import { type ContradictionCandidate, findContradictions } from "./contradiction.js";
import { runCurator } from "./curator.js";
import { runDecayGc } from "./decay.js";
import { FactStore, type MemoryRecord, originBucketKey } from "./records.js";

/**
 * The CHEAP, no-LLM memory-hygiene sweep for ONE workspace: decay-GC (age/archive/prune)
 * + curator (per-origin confirm of repeated beliefs + near-duplicate merge + change-gated
 * Obsidian-vault re-render). This mirrors the post-turn quiet-window block in the gateway
 * (server.ts), extracted so a boot-seeded wall-clock driver can run it on an IDLE gateway —
 * where no turn ever fires the post-turn path, so facts would otherwise never age or
 * consolidate. Zero model cost; idempotent; safe to call on a cadence.
 *
 * The throttled LLM consolidation (`runConsolidation`, 1 model call) is intentionally NOT
 * here — it needs auth + rides the per-turn path; this driver covers the deterministic
 * hygiene that an idle gateway must not skip.
 *
 * Each stage is independently guarded so one workspace's failure can't abort the others
 * (the caller loops over every agent workspace).
 */
export function runMemoryMaintenance(
	workspaceDir: string,
	onError?: (stage: "decay-gc" | "curator" | "contradictions", err: unknown) => void,
	onContradictions?: (pairs: ContradictionCandidate[]) => void,
): void {
	try {
		runDecayGc(workspaceDir);
	} catch (err) {
		onError?.("decay-gc", err);
	}
	try {
		// `evictMinAgeMs: Infinity` matches the post-turn block: eviction is left to
		// runDecayGc above (no double-GC); the curator only confirms + merges + re-renders.
		runCurator(new FactStore(workspaceDir), {
			dream: { evictMinAgeMs: Number.POSITIVE_INFINITY },
			vaultDir: join(workspaceDir, "memory-vault"),
		});
	} catch (err) {
		onError?.("curator", err);
	}
	// Surface (do NOT auto-invalidate) possible contradictions — same-subject, divergent-claim
	// pairs a human should review. Scoped PER ORIGIN: a pair across two principals isn't a real
	// contradiction. Log-only; resolution stays a deliberate operator/dream action. Only computed
	// when a consumer wants them (the daily driver passes a logger).
	if (onContradictions) {
		try {
			const active = new FactStore(workspaceDir).list();
			const buckets = new Map<string, MemoryRecord[]>();
			for (const r of active) {
				const k = originBucketKey(r);
				const arr = buckets.get(k);
				if (arr) arr.push(r);
				else buckets.set(k, [r]);
			}
			const found: ContradictionCandidate[] = [];
			for (const bucket of buckets.values()) found.push(...findContradictions(bucket));
			if (found.length > 0) onContradictions(found);
		} catch (err) {
			onError?.("contradictions", err);
		}
	}
}
