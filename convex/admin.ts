// convex/admin.ts — instance-level inspect + factory reset.
//
// Single-operator deployments hold exactly one Brigade instance, so "reset
// the instance" means "delete every row in every Brigade table" (plus any
// File-Storage objects rows point at). Used by the onboarding wizard's
// "start fresh" choice and the `brigade store reset` CLI.
//
// Deletion runs SERVER-SIDE and SELF-SCHEDULES (`resetStart` → `resetWorker`):
// a long-lived instance can hold hundreds of thousands of rows (cron runs,
// session events) and a single Convex mutation has op/time/byte limits, so each
// worker deletes one small batch then reschedules itself until its table drains.
// All tables drain concurrently; the client just polls `resetStatus`. The older
// client-paced `resetPage` is kept for back-compat / tests.

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";

// Every table in convex/schema.ts. Kept as an explicit literal union so a
// future schema addition that forgets to extend this list fails loudly in
// review rather than silently surviving a "factory reset".
const RESETTABLE_TABLES = [
	"brigadeConfig",
	"brigadeConfigAudit",
	"brigadeConfigBackups",
	"configHealth",
	"personaFiles",
	"workspaceState",
	"memoryFacts",
	"memoryExtractCursors",
	"memoryConsolidateState",
	"memoryEvents",
	"sessions",
	"sessionTranscriptRecords",
	"sessionInboxEvents",
	"sessionEvents",
	"subsystemLog",
	"cronJobs",
	"cronRuns",
	"cronServiceState",
	"channelAccess",
	"whatsappAuthFile",
	"channelMediaBlob",
	"authProfiles",
	"profileState",
	"authFiles",
	"systemMeta",
	"whatsappAuthCreds",
	"whatsappAuthKeys",
	"execApprovals",
	"skills",
	"extensions",
	"orgDeriveAudit",
	"orgChartCache",
	"subagentRuns",
	"gatewayCoord",
	"brigadeBlobs",
] as const;

export type ResettableTable = (typeof RESETTABLE_TABLES)[number];

const TableName = v.union(
	...RESETTABLE_TABLES.map((t) => v.literal(t)),
);

// Tables whose rows can point at File-Storage objects — the object must be
// deleted BEFORE the row or it becomes an orphan (storage isn't ref-counted).
const STORAGE_SPILL_TABLES = new Set<string>([
	"channelMediaBlob",
	"whatsappAuthKeys",
	"brigadeBlobs",
]);

// High-volume session/log/run tables probed (presence only, never counted) by
// instanceSummary so the "found an existing Brigade" headline doesn't imply an
// empty backend when thousands of event/log rows are actually present.
const ACTIVITY_TABLES = [
	"sessionEvents",
	"cronRuns",
	"subsystemLog",
	"sessionInboxEvents",
	"sessionTranscriptRecords",
	"subagentRuns",
] as const;

/** The list the reset client iterates — exported via query so the CLI and
 *  the server can never drift on which tables exist. */
export const listResettableTables = query({
	args: {},
	handler: async () => [...RESETTABLE_TABLES],
});

/** Headline summary for "found an existing Brigade in this backend". */
export const instanceSummary = query({
	args: {},
	handler: async (ctx) => {
		const configRow = await ctx.db.query("brigadeConfig").first();
		const memories = await ctx.db.query("memoryFacts").take(1001);
		const sessions = await ctx.db.query("sessions").take(1001);
		const cronJobs = await ctx.db.query("cronJobs").take(1001);
		const personas = await ctx.db.query("personaFiles").take(1001);
		const waCreds = await ctx.db.query("whatsappAuthCreds").take(1);
		const fp = await ctx.db
			.query("systemMeta")
			.withIndex("by_key", (q) => q.eq("key", "encryptionFingerprint"))
			.first();
		// High-volume session/log/run tables hold the bulk of a long-lived
		// instance, but their rows can be large (event payloads, transcript chunks)
		// — counting them with .take(1001) could exceed the 16 MiB query read cap.
		// So we only PROBE for presence (take(1)) to report that history exists,
		// rather than imply "0" when thousands of rows are actually there.
		let hasActivity = false;
		for (const t of ACTIVITY_TABLES) {
			if ((await ctx.db.query(t).take(1)).length > 0) {
				hasActivity = true;
				break;
			}
		}
		const cap = (n: number): number => Math.min(n, 1000);
		return {
			hasData:
				configRow !== null ||
				memories.length > 0 ||
				sessions.length > 0 ||
				cronJobs.length > 0 ||
				personas.length > 0,
			createdAtMs: configRow?._creationTime ?? null,
			counts: {
				memories: cap(memories.length),
				sessions: cap(sessions.length),
				cronJobs: cap(cronJobs.length),
				personas: cap(personas.length),
			},
			hasActivity,
			whatsappLinked: waCreds.length > 0,
			storedKeyFingerprint: (fp?.value as string | undefined) ?? null,
		};
	},
});

/** Rough byte size of a row, for read-budgeting only. The sealed ArrayBuffer
 *  columns (transcript chunks, media, auth, blobs) dominate; everything else
 *  is tiny. This drives WHEN we stop reading more pages — the actual read cost
 *  is charged by Convex on each `.take()`. */
function estimateRowBytes(row: Record<string, unknown>): number {
	let n = 64; // per-row overhead
	for (const value of Object.values(row)) {
		if (value instanceof ArrayBuffer) n += value.byteLength;
		else if (typeof value === "string") n += value.length;
		else if (typeof value === "number" || typeof value === "boolean") n += 8;
		else if (value && typeof value === "object") n += JSON.stringify(value).length;
	}
	return n;
}

/** Delete ONE bounded batch from a table (reaping File-Storage spills first).
 *  Shared by the legacy client-paced `resetPage` and the server-scheduled
 *  `resetWorker`. Returns `{ deleted, done }`; `done` is true ONLY when the
 *  table is fully drained — the caller loops/reschedules while `!done`.
 *
 *  Two caps keep every batch comfortably under Convex's per-execution ceiling:
 *  a row cap (`maxRows`) and a byte cap (`READ_CEILING`). Convex KILLS a function
 *  that exceeds its op/time/byte budget, and that kill is not catchable inside
 *  the function — so the only robust defense is to keep each batch small and let
 *  the caller chain more. Large-row tables (transcript chunks, media, auth,
 *  blobs near the 1 MiB doc limit) trip the byte cap after a handful of rows;
 *  small-row tables clear up to `maxRows`. Deleted rows drop out of the next
 *  `.take()`, so we always read from the front with no cursor. */
async function drainOneBatch(
	ctx: MutationCtx,
	table: ResettableTable,
	maxRows: number,
	readCeiling = 4 * 1024 * 1024, // conservative default; legacy resetPage passes 6 MiB
): Promise<{ deleted: number; done: boolean }> {
	const INNER = 8; // small read window; deleted rows drop out of the next take()
	let removed = 0;
	let bytesRead = 0;
	let drained = false;
	let capped = false;
	while (removed < maxRows && !capped) {
		// Never read more than the batch still wants, so `removed` can't overshoot
		// `maxRows` by up to INNER-1.
		const want = Math.min(INNER, maxRows - removed);
		const rows = await ctx.db.query(table).take(want);
		for (const row of rows) {
			bytesRead += estimateRowBytes(row as unknown as Record<string, unknown>);
			if (STORAGE_SPILL_TABLES.has(table)) {
				const storageId = (row as { storageId?: string }).storageId;
				if (storageId) {
					try {
						await ctx.storage.delete(storageId as never);
					} catch {
						// Already gone — the row delete below still proceeds.
					}
				}
			}
			await ctx.db.delete(row._id);
			removed += 1;
			// Stop the MOMENT we cross the read budget — mid-pass, so a handful of
			// ~1 MiB rows can't blow ~INNER MiB past the cap before the next check.
			if (bytesRead >= readCeiling) {
				capped = true;
				break;
			}
		}
		// A short read means the table is now empty — but only trust that when we
		// did NOT stop early on the byte cap (a capped pass read a full `want`).
		if (!capped && rows.length < want) {
			drained = true;
			break;
		}
	}
	return { deleted: removed, done: drained };
}

/** Legacy client-paced single batch. Behaviour-identical to the original
 *  `resetPage` (200-row default, 6 MiB read ceiling). Kept for back-compat; the
 *  onboarding wizard and `brigade store reset` now use the server-scheduled path
 *  below. */
export const resetPage = mutation({
	args: { table: TableName, limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const maxRows = args.limit && args.limit > 0 ? Math.min(args.limit, 500) : 200;
		return await drainOneBatch(ctx, args.table, maxRows, 6 * 1024 * 1024);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-side, self-scheduling factory reset — scales to any table size.
//
// `resetStart` seeds one progress row per table and schedules a `resetWorker`
// for each. Every worker deletes one small batch then reschedules ITSELF until
// its table is drained, so deletion runs entirely on the backend: no per-page
// client round-trips, no single mega-transaction to time out, and all tables
// drain concurrently. The client calls `resetStart` once then polls
// `resetStatus` until `done`.
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_BATCH = 100; // rows per scheduled transaction (small = self-host safe)
const SPILL_BATCH = 25; // spill tables do a storage.delete per row — go smaller

export const resetStart = mutation({
	args: { runId: v.string() },
	handler: async (ctx, args) => {
		// Clear any prior progress rows so a re-run starts from a clean slate.
		for (const row of await ctx.db.query("resetProgress").collect()) {
			await ctx.db.delete(row._id);
		}
		const now = Date.now();
		for (const table of RESETTABLE_TABLES) {
			await ctx.db.insert("resetProgress", {
				runId: args.runId,
				table,
				deleted: 0,
				done: false,
				updatedAt: now,
			});
			await ctx.scheduler.runAfter(0, internal.admin.resetWorker, {
				runId: args.runId,
				table,
				batch: STORAGE_SPILL_TABLES.has(table) ? SPILL_BATCH : WORKER_BATCH,
			});
		}
		return { runId: args.runId, tablesTotal: RESETTABLE_TABLES.length };
	},
});

export const resetWorker = internalMutation({
	args: { runId: v.string(), table: TableName, batch: v.number() },
	handler: async (ctx, args) => {
		const { deleted, done } = await drainOneBatch(ctx, args.table, args.batch);
		const row = await ctx.db
			.query("resetProgress")
			.withIndex("by_run_table", (q) => q.eq("runId", args.runId).eq("table", args.table))
			.first();
		if (row) {
			await ctx.db.patch(row._id, {
				deleted: row.deleted + deleted,
				done: done || deleted === 0,
				updatedAt: Date.now(),
			});
		}
		// Reschedule the SAME table until it reports drained. A drained or empty
		// batch ends the chain — no infinite reschedule.
		if (!done && deleted > 0) {
			await ctx.scheduler.runAfter(0, internal.admin.resetWorker, {
				runId: args.runId,
				table: args.table,
				batch: args.batch,
			});
		}
	},
});

export const resetStatus = query({
	args: { runId: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("resetProgress")
			.withIndex("by_run", (q) => q.eq("runId", args.runId))
			.collect();
		if (rows.length === 0) return null;
		const deletedTotal = rows.reduce((sum, r) => sum + r.deleted, 0);
		const tablesDone = rows.filter((r) => r.done).length;
		return {
			done: tablesDone >= rows.length,
			deletedTotal,
			tablesTotal: rows.length,
			tablesDone,
			tables: rows.map((r) => ({ table: r.table, deleted: r.deleted, done: r.done })),
			updatedAt: Math.max(...rows.map((r) => r.updatedAt)),
		};
	},
});
