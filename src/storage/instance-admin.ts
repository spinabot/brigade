// src/storage/instance-admin.ts
//
// Pre-boot instance inspection + factory reset against a Convex backend.
//
// Used by the onboarding wizard ("found an existing Brigade here — restore
// it or start fresh?") and `brigade store reset`. Both run BEFORE/OUTSIDE
// the normal RuntimeContext boot, so this module talks to the backend with
// its own ConvexHttpClient built from an explicit URL rather than the
// booted singleton.

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";

/** Minimal client surface — injectable for tests. */
export interface AdminClient {
	query(ref: unknown, args: Record<string, unknown>): Promise<unknown>;
	mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexInstanceSummary {
	hasData: boolean;
	createdAtMs: number | null;
	counts: { memories: number; sessions: number; cronJobs: number; personas: number };
	whatsappLinked: boolean;
	storedKeyFingerprint: string | null;
}

function clientFor(url: string): AdminClient {
	return new ConvexHttpClient(url) as unknown as AdminClient;
}

/** What does this backend already hold? */
export async function inspectConvexInstance(
	url: string,
	clientOverride?: AdminClient,
): Promise<ConvexInstanceSummary> {
	const client = clientOverride ?? clientFor(url);
	return (await client.query(api.admin.instanceSummary, {})) as ConvexInstanceSummary;
}

/**
 * Erase EVERY Brigade row (and spilled File-Storage object) in the backend.
 * Pages per table so big instances (thousands of cron runs / session events)
 * stay under Convex's per-mutation limits. Returns the total rows deleted.
 */
export async function resetConvexInstance(
	url: string,
	opts: {
		onProgress?: (table: string, deletedSoFar: number) => void;
		clientOverride?: AdminClient;
	} = {},
): Promise<{ deletedTotal: number }> {
	const client = opts.clientOverride ?? clientFor(url);
	const tables = (await client.query(api.admin.listResettableTables, {})) as string[];
	const PAGE = 200;
	let deletedTotal = 0;
	for (const table of tables) {
		let deletedForTable = 0;
		// Loop until the table reports `done`. A page can come back SHORT without
		// being drained (the server caps each batch by bytes read, not just row
		// count, so large-row tables clear a handful at a time) — so we trust the
		// explicit `done` flag, never the batch size, and stop if a batch deletes
		// nothing (defensive against an unexpected stall).
		for (;;) {
			const { deleted, done } = (await client.mutation(api.admin.resetPage, {
				table,
				limit: PAGE,
			})) as { deleted: number; done?: boolean };
			deletedForTable += deleted;
			deletedTotal += deleted;
			if (done || deleted === 0) break;
			opts.onProgress?.(table, deletedForTable);
		}
		if (deletedForTable > 0) opts.onProgress?.(table, deletedForTable);
	}
	return { deletedTotal };
}

/**
 * Classify what onboarding found in the backend relative to the active key.
 *   fresh             — empty backend, proceed silently
 *   restorable        — data exists and the active key matches (or data was
 *                       never sealed) → offer Restore / Start fresh
 *   key-mismatch      — data exists but was sealed with a DIFFERENT key →
 *                       must provide that key or erase
 */
export function classifyInstanceState(
	summary: ConvexInstanceSummary,
	activeKeyFingerprint: string | undefined,
): "fresh" | "restorable" | "key-mismatch" {
	if (!summary.hasData) return "fresh";
	const stored = summary.storedKeyFingerprint;
	if (!stored) return "restorable"; // data exists but no key was ever pinned
	if (activeKeyFingerprint && stored === activeKeyFingerprint) return "restorable";
	return "key-mismatch";
}
