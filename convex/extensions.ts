// convex/extensions.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const Origin = v.union(v.literal("bundled"), v.literal("user"));

export const list = query({
	args: {},
	handler: async (ctx) => {
		return ctx.db.query("extensions").collect();
	},
});

export const upsert = mutation({
	args: {
		moduleId: v.string(),
		origin: Origin,
		bundleBytes: v.optional(v.bytes()),
		sourceLabel: v.string(),
		manifest: v.optional(v.any()),
		enabled: v.boolean(),
		config: v.optional(v.bytes()),
		bundleSha: v.optional(v.string()),
		createdBy: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("extensions")
			.withIndex("by_moduleId", (q) => q.eq("moduleId", args.moduleId))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.replace(existing._id, { ...args, createdAt: existing.createdAt, updatedAt: now });
		} else {
			await ctx.db.insert("extensions", { ...args, createdAt: now, updatedAt: now });
		}
	},
});

export const remove = mutation({
	args: { moduleId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("extensions")
			.withIndex("by_moduleId", (q) => q.eq("moduleId", args.moduleId))
			.first();
		if (!existing) return false;
		await ctx.db.delete(existing._id);
		return true;
	},
});
