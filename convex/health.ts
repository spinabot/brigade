// convex/health.ts
//
// Convex-side liveness probe. ConvexBrigadeStore.healthcheck() calls this
// from filesystem-mode boot to confirm the backend is reachable + the
// schema is deployed. Returns the schema version + the number of seeded
// brigadeConfig rows so a freshly-deployed-but-empty backend reports
// distinctly from a populated one.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const ping = query({
	args: {},
	handler: async (ctx) => {
		const configRows = await ctx.db.query("brigadeConfig").take(1);
		return {
			ok: true,
			schemaVersion: 2,
			hasConfig: configRows.length > 0,
			now: Date.now(),
		};
	},
});

// ============================================================================
// systemMeta — small singleton facts (encryption-key fingerprint, markers)
// ============================================================================

export const getMeta = query({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("systemMeta")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		return row?.value ?? null;
	},
});

export const setMeta = mutation({
	args: { key: v.string(), value: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("systemMeta")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.first();
		if (existing) {
			await ctx.db.replace(existing._id, { ...args, updatedAt: Date.now() });
			return { updated: true };
		}
		await ctx.db.insert("systemMeta", { ...args, updatedAt: Date.now() });
		return { updated: false };
	},
});
