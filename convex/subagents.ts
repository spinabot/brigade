// convex/subagents.ts — subagentRuns
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const get = query({
	args: { ownerId: v.string(), runId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("subagentRuns")
			.withIndex("by_runId", (q) => q.eq("ownerId", args.ownerId).eq("runId", args.runId))
			.first();
	},
});

export const getByChildSessionKey = query({
	args: { ownerId: v.string(), childSessionKey: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("subagentRuns")
			.withIndex("by_childSessionKey_active", (q) =>
				q.eq("ownerId", args.ownerId).eq("childSessionKey", args.childSessionKey),
			)
			.order("desc")
			.first();
	},
});

export const listByRequester = query({
	args: { ownerId: v.string(), requesterSessionKey: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("subagentRuns")
			.withIndex("by_requester_createdAt", (q) =>
				q.eq("ownerId", args.ownerId).eq("requesterSessionKey", args.requesterSessionKey),
			)
			.collect();
	},
});

export const put = mutation({
	args: { ownerId: v.string(), record: v.any() },
	handler: async (ctx, args) => {
		const record = args.record as Record<string, unknown> & { runId?: string };
		const runId = record.runId;
		if (typeof runId !== "string" || runId.length === 0) {
			throw new Error("subagents.put: record requires `runId`");
		}
		const existing = await ctx.db
			.query("subagentRuns")
			.withIndex("by_runId", (q) => q.eq("ownerId", args.ownerId).eq("runId", runId))
			.first();
		const payload = { ...record, ownerId: args.ownerId };
		if (existing) {
			await ctx.db.replace(existing._id, payload as never);
		} else {
			await ctx.db.insert("subagentRuns", payload as never);
		}
	},
});

export const markCompleted = mutation({
	args: {
		ownerId: v.string(),
		runId: v.string(),
		endedAt: v.number(),
		outcome: v.any(),
		reason: v.string(),
		error: v.optional(v.string()),
		endedHookEmittedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("subagentRuns")
			.withIndex("by_runId", (q) => q.eq("ownerId", args.ownerId).eq("runId", args.runId))
			.first();
		if (!existing) return null;
		await ctx.db.patch(existing._id, {
			endedAt: args.endedAt,
			outcome: args.outcome as never,
			endedReason: args.reason,
			...(args.error !== undefined ? { outcome: { ...(args.outcome as object), error: args.error } as never } : {}),
			...(args.endedHookEmittedAt !== undefined ? { endedHookEmittedAt: args.endedHookEmittedAt } : {}),
		});
		return await ctx.db.get(existing._id);
	},
});

export const remove = mutation({
	args: { ownerId: v.string(), runId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("subagentRuns")
			.withIndex("by_runId", (q) => q.eq("ownerId", args.ownerId).eq("runId", args.runId))
			.first();
		if (!existing) return false;
		await ctx.db.delete(existing._id);
		return true;
	},
});
