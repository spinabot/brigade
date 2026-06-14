// convex/org.ts — orgDeriveAudit + orgChartCache
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const Mode = v.union(v.literal("derived"), v.literal("explicit"), v.literal("open"));

export const appendDeriveAudit = mutation({
	args: {
		ownerId: v.string(),
		ts: v.string(),
		topOrder: v.string(),
		mode: Mode,
		edgeCount: v.number(),
		memberCount: v.number(),
		extraAllowCount: v.number(),
		extraDenyCount: v.number(),
		warnings: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert("orgDeriveAudit", args);
	},
});

export const listDeriveAudit = query({
	args: { ownerId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit && args.limit > 0 ? args.limit : 50;
		return ctx.db
			.query("orgDeriveAudit")
			.withIndex("by_owner_ts", (q) => q.eq("ownerId", args.ownerId))
			.order("desc")
			.take(limit);
	},
});

export const getChart = query({
	args: { ownerId: v.string(), hash: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("orgChartCache")
			.withIndex("by_owner_hash", (q) => q.eq("ownerId", args.ownerId).eq("hash", args.hash))
			.first();
	},
});

export const putChart = mutation({
	args: {
		ownerId: v.string(),
		hash: v.string(),
		pngBytes: v.bytes(),
		width: v.number(),
		height: v.number(),
		themeId: v.string(),
		themeName: v.string(),
		transient: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("orgChartCache")
			.withIndex("by_owner_hash", (q) => q.eq("ownerId", args.ownerId).eq("hash", args.hash))
			.first();
		const payload = {
			ownerId: args.ownerId,
			hash: args.hash,
			pngBytes: args.pngBytes,
			width: args.width,
			height: args.height,
			themeId: args.themeId,
			themeName: args.themeName,
			mimeType: "image/png" as const,
			mtimeMs: Date.now(),
			transient: args.transient ?? false,
		};
		if (existing) await ctx.db.replace(existing._id, payload);
		else await ctx.db.insert("orgChartCache", payload);
	},
});

export const deleteChart = mutation({
	args: { ownerId: v.string(), hash: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("orgChartCache")
			.withIndex("by_owner_hash", (q) => q.eq("ownerId", args.ownerId).eq("hash", args.hash))
			.first();
		if (existing) await ctx.db.delete(existing._id);
	},
});

export const listCharts = query({
	args: { ownerId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("orgChartCache")
			.withIndex("by_owner_mtime", (q) => q.eq("ownerId", args.ownerId))
			.order("desc")
			.collect();
	},
});
