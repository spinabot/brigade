// convex/execApprovals.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const Kind = v.union(v.literal("exact"), v.literal("pattern"));

export const list = query({
	args: { ownerId: v.string(), agentId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("execApprovals")
			.withIndex("by_owner_agent_kind", (q) =>
				q.eq("ownerId", args.ownerId).eq("agentId", args.agentId),
			)
			.collect();
	},
});

export const insert = mutation({
	args: { ownerId: v.string(), agentId: v.string(), kind: Kind, value: v.string(), valueNormalised: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("execApprovals")
			.withIndex("by_owner_agent_value", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("agentId", args.agentId)
					.eq("valueNormalised", args.valueNormalised),
			)
			.first();
		if (existing) return { inserted: false };
		await ctx.db.insert("execApprovals", { ...args, createdAt: Date.now() });
		return { inserted: true };
	},
});

export const remove = mutation({
	args: { ownerId: v.string(), agentId: v.string(), valueNormalised: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("execApprovals")
			.withIndex("by_owner_agent_value", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("agentId", args.agentId)
					.eq("valueNormalised", args.valueNormalised),
			)
			.collect();
		let removedCommands = 0;
		let removedPatterns = 0;
		for (const r of rows) {
			if (r.kind === "exact") removedCommands += 1;
			else removedPatterns += 1;
			await ctx.db.delete(r._id);
		}
		return { removedCommands, removedPatterns };
	},
});
