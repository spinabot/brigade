// convex/workspace.ts — personaFiles + workspaceState
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const PersonaName = v.union(
	v.literal("AGENTS.md"),
	v.literal("SOUL.md"),
	v.literal("IDENTITY.md"),
	v.literal("USER.md"),
	v.literal("TOOLS.md"),
	v.literal("BOOTSTRAP.md"),
	v.literal("MEMORY.md"),
	v.literal("HEARTBEAT.md"),
);

export const listPersona = query({
	args: { agentId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("personaFiles")
			.withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
			.collect();
	},
});

export const getPersona = query({
	args: { agentId: v.string(), name: PersonaName },
	handler: async (ctx, args) => {
		return ctx.db
			.query("personaFiles")
			.withIndex("by_agent_name", (q) => q.eq("agentId", args.agentId).eq("name", args.name))
			.first();
	},
});

export const writePersona = mutation({
	args: { agentId: v.string(), name: PersonaName, content: v.bytes() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("personaFiles")
			.withIndex("by_agent_name", (q) => q.eq("agentId", args.agentId).eq("name", args.name))
			.first();
		const payload = { agentId: args.agentId, name: args.name, content: args.content, updatedAt: Date.now() };
		if (existing) {
			await ctx.db.replace(existing._id, payload);
			return { created: false };
		}
		await ctx.db.insert("personaFiles", payload);
		return { created: true };
	},
});

export const deletePersona = mutation({
	args: { agentId: v.string(), name: PersonaName },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("personaFiles")
			.withIndex("by_agent_name", (q) => q.eq("agentId", args.agentId).eq("name", args.name))
			.first();
		if (!existing) return false;
		await ctx.db.delete(existing._id);
		return true;
	},
});

export const getState = query({
	args: { agentId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("workspaceState")
			.withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
			.first();
	},
});

export const setBootstrapSeeded = mutation({
	args: { agentId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("workspaceState")
			.withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
			.first();
		const now = new Date().toISOString();
		if (existing) {
			await ctx.db.patch(existing._id, { bootstrapSeededAt: now });
		} else {
			await ctx.db.insert("workspaceState", { agentId: args.agentId, version: 1, bootstrapSeededAt: now });
		}
	},
});

export const setSetupCompleted = mutation({
	args: { agentId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("workspaceState")
			.withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
			.first();
		const now = new Date().toISOString();
		if (existing) {
			await ctx.db.patch(existing._id, { setupCompletedAt: now });
		} else {
			await ctx.db.insert("workspaceState", { agentId: args.agentId, version: 1, setupCompletedAt: now });
		}
	},
});
