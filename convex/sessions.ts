// convex/sessions.ts — sessions index
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const Subagent = v.object({
	spawnDepth: v.number(),
	spawnedBy: v.string(),
	parentRunId: v.optional(v.string()),
	label: v.optional(v.string()),
	cleanup: v.optional(v.union(v.literal("delete"), v.literal("keep"))),
	spawnedAt: v.string(),
	spawnedWorkspaceDir: v.optional(v.string()),
});

export const getEntry = query({
	args: { agentId: v.string(), sessionKey: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("sessions")
			.withIndex("by_agent_key", (q) =>
				q.eq("agentId", args.agentId).eq("sessionKey", args.sessionKey),
			)
			.first();
	},
});

export const listEntries = query({
	args: { agentId: v.string(), subagentOnly: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		const all = await ctx.db
			.query("sessions")
			.withIndex("by_agent_lastUsed", (q) => q.eq("agentId", args.agentId))
			.order("desc")
			.collect();
		if (args.subagentOnly) return all.filter((s) => s.subagent !== undefined);
		return all;
	},
});

export const upsertEntry = mutation({
	args: {
		agentId: v.string(),
		sessionKey: v.string(),
		sessionId: v.string(),
		createdAt: v.optional(v.number()),
		lastUsedAt: v.optional(v.number()),
		provider: v.optional(v.string()),
		modelId: v.optional(v.string()),
		authProfile: v.optional(v.string()),
		thinkingLevel: v.optional(v.string()),
		subagent: v.optional(Subagent),
		extra: v.optional(v.bytes()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("sessions")
			.withIndex("by_agent_key", (q) =>
				q.eq("agentId", args.agentId).eq("sessionKey", args.sessionKey),
			)
			.first();
		const now = Date.now();
		if (existing) {
			// MERGE, never replace — mirrors the filesystem store's
			// read-modify-write (src/sessions/session-store.ts): fields the
			// caller omits keep their stored value, `createdAt` is set once at
			// creation, and `subagent` is write-once (only applied when the
			// row doesn't carry one yet — session-store.ts:351-367).
			const patch: Record<string, unknown> = {
				sessionId: args.sessionId,
				lastUsedAt: args.lastUsedAt ?? now,
			};
			if (args.provider !== undefined) patch.provider = args.provider;
			if (args.modelId !== undefined) patch.modelId = args.modelId;
			if (args.authProfile !== undefined) patch.authProfile = args.authProfile;
			if (args.thinkingLevel !== undefined) patch.thinkingLevel = args.thinkingLevel;
			if (args.extra !== undefined) patch.extra = args.extra;
			if (args.subagent !== undefined && existing.subagent === undefined) {
				patch.subagent = args.subagent;
			}
			await ctx.db.patch(existing._id, patch);
			return await ctx.db.get(existing._id);
		}
		const id = await ctx.db.insert("sessions", {
			...args,
			createdAt: args.createdAt ?? now,
			lastUsedAt: args.lastUsedAt ?? now,
		});
		return await ctx.db.get(id);
	},
});

export const deleteEntry = mutation({
	args: { agentId: v.string(), sessionKey: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("sessions")
			.withIndex("by_agent_key", (q) =>
				q.eq("agentId", args.agentId).eq("sessionKey", args.sessionKey),
			)
			.first();
		if (!existing) return false;
		await ctx.db.delete(existing._id);
		return true;
	},
});
