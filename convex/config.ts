// convex/config.ts
//
// Convex functions for the brigadeConfig table — one row per operator
// (keyed by instanceId). Mirrors LocalConfigStore's surface so the
// adapter can call these and look identical to filesystem callers.
//
// `read` returns the single config row (or null on first boot).
// `write` is an upsert with optimistic-concurrency support via the
// `expectedSha256` arg — when supplied, the mutation refuses to write
// if the on-disk content hash has drifted.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const read = query({
	args: { instanceId: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("brigadeConfig")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		return row;
	},
});

export const write = mutation({
	args: {
		instanceId: v.string(),
		agents:   v.optional(v.any()),
		gateway:  v.optional(v.any()),
		session:  v.optional(v.any()),
		tools:    v.optional(v.any()),
		auth:     v.optional(v.any()),
		plugins:  v.optional(v.any()),
		skills:   v.optional(v.any()),
		channels: v.optional(v.any()),
		bindings: v.optional(v.any()),
		org:      v.optional(v.any()),
		wizard:   v.optional(v.any()),
		meta:     v.optional(v.any()),
		defaults: v.optional(v.any()),
		extra:    v.optional(v.any()),
		contentSha256: v.string(),
		bytes: v.number(),
		expectedSha256: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("brigadeConfig")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		if (
			args.expectedSha256 !== undefined &&
			existing &&
			existing.contentSha256 !== args.expectedSha256
		) {
			throw new Error(
				`OCC conflict: expected sha256=${args.expectedSha256} but on-disk is ${existing.contentSha256}`,
			);
		}
		const payload = {
			instanceId: args.instanceId,
			schemaVersion: 2 as const,
			agents:   args.agents,
			gateway:  args.gateway,
			session:  args.session,
			tools:    args.tools,
			auth:     args.auth,
			plugins:  args.plugins,
			skills:   args.skills,
			channels: args.channels,
			bindings: args.bindings,
			org:      args.org,
			wizard:   args.wizard,
			meta:     args.meta,
			defaults: args.defaults,
			extra:    args.extra,
			contentSha256: args.contentSha256,
			bytes: args.bytes,
			updatedAtMs: Date.now(),
		};
		if (existing) {
			// Snapshot the PRIOR config into the backup ring before overwriting —
			// the convex equivalent of io.ts rotateBackups' .bak chain. Only on a
			// real content change (skip no-op rewrites so the ring isn't flooded
			// with identical snapshots). Ring of BACKUP_COUNT, slot 0 = newest.
			if (existing.contentSha256 !== args.contentSha256) {
				await captureBackup(ctx, args.instanceId, existing);
			}
			await ctx.db.replace(existing._id, payload);
			return { rev: args.contentSha256, updated: true };
		}
		await ctx.db.insert("brigadeConfig", payload);
		return { rev: args.contentSha256, updated: false };
	},
});

// Keep the same depth as the filesystem .bak rotation (io.ts BACKUP_COUNT).
const BACKUP_COUNT = 5;

/** Rebuild the brigade.json shape from a stored brigadeConfig row (inverse of
 *  the `write` payload): named domain columns that are set + the `extra`
 *  catch-all (which also carries the legacy top-level `version`). */
function reconstructConfig(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of [
		"agents", "gateway", "session", "tools", "auth", "plugins", "skills",
		"channels", "bindings", "org", "wizard", "meta", "defaults",
	]) {
		if (row[k] !== undefined) out[k] = row[k];
	}
	const extra = row.extra as Record<string, unknown> | undefined;
	if (extra && typeof extra === "object") {
		for (const [k, v2] of Object.entries(extra)) if (out[k] === undefined) out[k] = v2;
	}
	return out;
}

/** Insert a backup at slot 0, shifting existing slots up and dropping anything
 *  beyond BACKUP_COUNT-1 — a ring identical in depth to the disk .bak chain. */
async function captureBackup(
	ctx: { db: any },
	instanceId: string,
	priorRow: Record<string, unknown>,
): Promise<void> {
	const existing = await ctx.db
		.query("brigadeConfigBackups")
		.withIndex("by_instance_slot", (q: any) => q.eq("instanceId", instanceId))
		.collect();
	for (const b of existing) {
		if (b.slot >= BACKUP_COUNT - 1) await ctx.db.delete(b._id);
		else await ctx.db.patch(b._id, { slot: b.slot + 1 });
	}
	await ctx.db.insert("brigadeConfigBackups", {
		instanceId,
		slot: 0,
		contentSha256: (priorRow.contentSha256 as string) ?? "",
		payload: JSON.stringify(reconstructConfig(priorRow)),
		bytes: (priorRow.bytes as number) ?? 0,
		capturedAtMs: Date.now(),
	});
}

export const listBackups = query({
	args: { instanceId: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("brigadeConfigBackups")
			.withIndex("by_instance_slot", (q) => q.eq("instanceId", args.instanceId))
			.collect();
		return rows
			.sort((a, b) => a.slot - b.slot)
			.map((r) => ({ slot: r.slot, sha256: r.contentSha256, mtimeMs: r.capturedAtMs, bytes: r.bytes }));
	},
});

export const getBackup = query({
	args: { instanceId: v.string(), slot: v.number() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("brigadeConfigBackups")
			.withIndex("by_instance_slot", (q) =>
				q.eq("instanceId", args.instanceId).eq("slot", args.slot),
			)
			.first();
		return row ? { payload: row.payload, sha256: row.contentSha256 } : null;
	},
});
