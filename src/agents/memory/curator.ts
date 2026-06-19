// src/agents/memory/curator.ts
//
// Tideline Step 34 — the curator: the background daemon that keeps the store
// from bloating as it learns. Runs the dream's maintenance (confirm /
// consolidate / evict) PER ORIGIN and reports an aggregate.
//
// ORIGIN SAFETY: the default (no `origins` passed) fans out over the store's
// DISTINCT origins — one runDream pass per principal — so maintenance never
// runs over a mixed-origin set (a whole-store pass would let consolidation merge
// an owner fact with a channel peer's). An explicit `origins: []` is a no-op
// (run nothing), distinct from "omitted" (fan out over all).

import { tryGetRuntimeContext } from "../../storage/runtime-context.js";

import { type DreamOpts, runDream } from "./dream.js";
import type { FactStore, RecordOriginFilter } from "./records.js";
import { writeVault } from "./vault.js";

export interface CuratorResult {
	/** Number of per-origin passes run. */
	origins: number;
	confirmed: number;
	consolidated: number;
	evicted: number;
	/** Active fact count after the pass (the bloat metric). */
	activeAfter: number;
	/** Notes re-rendered to the markdown vault this pass (0 unless `vaultDir` set + something changed). */
	vaultWritten?: number;
}

export function runCurator(
	store: FactStore,
	opts: {
		origins?: readonly RecordOriginFilter[];
		dream?: Omit<DreamOpts, "origin">;
		/** When set (filesystem mode only), re-render the owner's vault here AFTER a
		 *  pass that actually changed facts — the "re-render after a dream" promise,
		 *  change-gated so an idle sweep does no disk churn. */
		vaultDir?: string;
	} = {},
): CuratorResult {
	// One pinned instant for the whole pass — deterministic given a fixed clock.
	const now = opts.dream?.now ?? Date.now();
	const dream: Omit<DreamOpts, "origin"> = { ...opts.dream, now };

	// Explicit origins (incl. []) are honoured verbatim; OMITTED → fan out over
	// the store's distinct origins (NEVER a single whole-store pass).
	const passes: Array<RecordOriginFilter | undefined> = opts.origins ? [...opts.origins] : store.distinctOrigins();

	let confirmed = 0;
	let consolidated = 0;
	let evicted = 0;
	for (const origin of passes) {
		const r = runDream(store, { ...(origin ? { origin } : {}), ...dream });
		confirmed += r.confirmed.length;
		consolidated += r.consolidated.length;
		evicted += r.evicted.length;
	}

	// Re-render the owner's markdown vault AFTER the pass — but only when the dream
	// actually changed something (no idle-sweep churn) and only in filesystem mode
	// (in convex mode the store is authoritative; an on-disk vault would be an
	// un-synced transient). The 3-way merge preserves any human-pinned edits.
	let vaultWritten: number | undefined;
	const changed = confirmed + consolidated + evicted > 0;
	if (opts.vaultDir && changed && tryGetRuntimeContext()?.mode !== "convex") {
		// Active + restorable-archived + prune: a purged/superseded fact's note is removed
		// (no stale plaintext after a shred), while a reversibly-retracted fact's note and
		// its human-pinned edits are kept (listForVault), and survivors' edits are merged.
		vaultWritten = writeVault(opts.vaultDir, store.listForVault({ kind: "owner" }), { prune: true }).written;
	}

	return {
		origins: passes.length,
		confirmed,
		consolidated,
		evicted,
		activeAfter: store.list().length,
		...(vaultWritten !== undefined ? { vaultWritten } : {}),
	};
}
