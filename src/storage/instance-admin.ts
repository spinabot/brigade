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
	/** True when high-volume session/log/run tables hold rows (presence-probed,
	 *  not counted). Optional for back-compat with older summary shapes. */
	hasActivity?: boolean;
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
 *
 * Kicks off a SERVER-SIDE self-scheduling reset (`resetStart`) — one worker per
 * table, each deleting small batches and rescheduling itself until its table is
 * drained — then polls `resetStatus` until every table reports done. Scales to
 * any size: deletion never crosses the wire per page and never runs as one
 * mega-mutation that could time out. Returns the total rows deleted;
 * `onProgress(table, deletedSoFar)` fires as each table advances. Throws if the
 * reset makes NO progress for `stallTimeoutMs` (a backend worker died) rather
 * than polling forever.
 */
export async function resetConvexInstance(
	url: string,
	opts: {
		onProgress?: (table: string, deletedSoFar: number) => void;
		clientOverride?: AdminClient;
		pollMs?: number;
		stallTimeoutMs?: number;
	} = {},
): Promise<{ deletedTotal: number }> {
	const client = opts.clientOverride ?? clientFor(url);
	const pollMs = opts.pollMs ?? 400;
	const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000;
	const runId = `reset-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;

	await client.mutation(api.admin.resetStart, { runId });

	const perTable = new Map<string, number>();
	let deletedTotal = 0;
	let lastProgressAt = Date.now();
	for (;;) {
		const status = (await client.query(api.admin.resetStatus, { runId })) as {
			done: boolean;
			deletedTotal: number;
			tables: Array<{ table: string; deleted: number; done: boolean }>;
		} | null;
		if (status) {
			for (const t of status.tables) {
				const prev = perTable.get(t.table) ?? 0;
				if (t.deleted > prev) {
					perTable.set(t.table, t.deleted);
					opts.onProgress?.(t.table, t.deleted);
				}
			}
			if (status.deletedTotal > deletedTotal) {
				deletedTotal = status.deletedTotal;
				lastProgressAt = Date.now();
			}
			if (status.done) return { deletedTotal };
		}
		// A worker that exceeded a transaction limit is killed by Convex and can't
		// reschedule itself, so its table would never reach `done`. Surface that as
		// a clear error after a no-progress window instead of polling forever.
		if (Date.now() - lastProgressAt > stallTimeoutMs) {
			throw new Error(
				`reset stalled: no progress for ${Math.round(stallTimeoutMs / 1000)}s ` +
					`(${deletedTotal} rows deleted) — a backend worker likely failed; check convex logs`,
			);
		}
		await delay(pollMs);
	}
}

/** Minimal sleep for the poll loop. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
