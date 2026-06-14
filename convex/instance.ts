// convex/instance.ts — gatewayCoord (heartbeat/pid; the lock stays LOCAL — fs.open("wx") has no Convex equivalent)
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const getCoord = query({
	args: { instanceId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("gatewayCoord")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
	},
});

export const writePid = mutation({
	args: { instanceId: v.string(), pid: v.number() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("gatewayCoord")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		const now = Date.now();
		const payload = {
			instanceId: args.instanceId,
			pid: args.pid,
			pidAliveAt: now,
			updatedAt: now,
		};
		if (existing) await ctx.db.patch(existing._id, payload);
		else await ctx.db.insert("gatewayCoord", payload);
	},
});

export const clearPid = mutation({
	args: { instanceId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("gatewayCoord")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { pid: undefined, pidAliveAt: undefined, updatedAt: Date.now() });
		}
	},
});

export const writeHeartbeat = mutation({
	args: { instanceId: v.string(), ts: v.number(), pid: v.number(), uptimeMs: v.number() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("gatewayCoord")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		const payload = {
			instanceId: args.instanceId,
			heartbeatTs: args.ts,
			heartbeatPid: args.pid,
			heartbeatUptimeMs: args.uptimeMs,
			updatedAt: Date.now(),
		};
		if (existing) await ctx.db.patch(existing._id, payload);
		else await ctx.db.insert("gatewayCoord", payload);
	},
});

export const clearHeartbeat = mutation({
	args: { instanceId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("gatewayCoord")
			.withIndex("by_instance", (q) => q.eq("instanceId", args.instanceId))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, {
				heartbeatTs: undefined,
				heartbeatPid: undefined,
				heartbeatUptimeMs: undefined,
				updatedAt: Date.now(),
			});
		}
	},
});
