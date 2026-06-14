// convex/skills.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const Source = v.union(
	v.literal("bundled"),
	v.literal("config"),
	v.literal("managed"),
	v.literal("personal"),
	v.literal("project"),
	v.literal("workspace"),
);

export const list = query({
	args: {
		ownerId: v.string(),
		// Optional scoping: workspace skills are per-agent, so the mirror sync
		// must fetch only THIS agent's workspace skills — without it every
		// agent's skills bleed into every workspace on boot.
		source: v.optional(Source),
		agentId: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		if (args.source !== undefined && args.agentId !== undefined) {
			const agentId = args.agentId;
			const source = args.source;
			return ctx.db
				.query("skills")
				.withIndex("by_owner_scope_name", (q) =>
					q.eq("ownerId", args.ownerId).eq("source", source).eq("agentId", agentId),
				)
				.collect();
		}
		if (args.source !== undefined) {
			const source = args.source;
			return ctx.db
				.query("skills")
				.withIndex("by_owner_source", (q) => q.eq("ownerId", args.ownerId).eq("source", source))
				.collect();
		}
		return ctx.db
			.query("skills")
			.withIndex("by_owner_source", (q) => q.eq("ownerId", args.ownerId))
			.collect();
	},
});

export const get = query({
	args: { ownerId: v.string(), name: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("skills")
			.withIndex("by_owner_name", (q) => q.eq("ownerId", args.ownerId).eq("name", args.name))
			.first();
	},
});

export const upsert = mutation({
	args: {
		ownerId: v.string(),
		source: Source,
		agentId: v.union(v.string(), v.null()),
		name: v.string(),
		description: v.string(),
		frontmatter: v.string(),
		body: v.string(),
		eligibility: v.object({
			os: v.array(v.string()),
			requiresBins: v.array(v.string()),
			requiresAnyBins: v.array(v.string()),
			requiresEnv: v.array(v.string()),
			requiresConfig: v.array(v.string()),
		}),
		disableModelInvocation: v.boolean(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("skills")
			.withIndex("by_owner_name", (q) => q.eq("ownerId", args.ownerId).eq("name", args.name))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.replace(existing._id, { ...args, createdAt: existing.createdAt, updatedAt: now });
			return { created: false };
		}
		await ctx.db.insert("skills", { ...args, createdAt: now, updatedAt: now });
		return { created: true };
	},
});

export const remove = mutation({
	args: { ownerId: v.string(), name: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("skills")
			.withIndex("by_owner_name", (q) => q.eq("ownerId", args.ownerId).eq("name", args.name))
			.first();
		if (!existing) return false;
		await ctx.db.delete(existing._id);
		return true;
	},
});
