// convex/admin.ts — instance-level inspect + factory reset.
//
// Single-operator deployments hold exactly one Brigade instance, so "reset
// the instance" means "delete every row in every Brigade table" (plus any
// File-Storage objects rows point at). Used by the onboarding wizard's
// "start fresh" choice and the `brigade store reset` CLI.
//
// Deletion is PAGINATED (`resetPage`) because a long-lived instance can hold
// tens of thousands of rows (cron runs, session events) and a single Convex
// mutation has document/size limits — the client loops each table until the
// page comes back short.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

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

/** Delete a bounded batch of rows from one table (reaping File-Storage spills
 *  first). Returns `{ deleted, done }` where `done` is true ONLY when the table
 *  is fully drained — the client loops while `!done`.
 *
 *  Convex caps a single function execution at 16 MiB of reads. A fixed row
 *  count blows that on large-row tables (transcript chunks ~768 KiB, media /
 *  auth / blobs near the 1 MiB doc limit) — 200 such rows is ~150 MiB and
 *  crashes with "Too many bytes read". So we read in small inner `.take()`
 *  batches (deleted rows drop out of the next `.take()`, so no cursor needed),
 *  sum the bytes, and stop once another batch could approach the cap. Small-row
 *  tables still clear ~MAX_ROWS per call; large-row tables clear a safe handful.
 *  A byte-capped batch is "short" but NOT drained, so `done` — not the batch
 *  size — is the loop signal. */
export const resetPage = mutation({
	args: { table: TableName, limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const MAX_ROWS = args.limit && args.limit > 0 ? Math.min(args.limit, 500) : 200;
		const INNER = 8; // ≤ 8 MiB worst case (8 × 1 MiB doc cap)
		const READ_CEILING = 6 * 1024 * 1024; // stop before the next batch; 6 + 8 < 16 MiB
		let removed = 0;
		let bytesRead = 0;
		let drained = false;
		while (removed < MAX_ROWS) {
			const rows = await ctx.db.query(args.table).take(INNER);
			for (const row of rows) {
				bytesRead += estimateRowBytes(row as unknown as Record<string, unknown>);
				if (STORAGE_SPILL_TABLES.has(args.table)) {
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
			}
			// Fewer rows than asked (incl. zero) ⇒ the table is now empty.
			if (rows.length < INNER) {
				drained = true;
				break;
			}
			// Next `.take(INNER)` could read up to ~8 MiB; stop while still well
			// under the 16 MiB execution cap. Not drained — the client loops.
			if (bytesRead >= READ_CEILING) break;
		}
		return { deleted: removed, done: drained };
	},
});
