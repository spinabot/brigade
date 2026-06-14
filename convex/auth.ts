// convex/auth.ts
//
// Convex functions for the authProfiles + profileState tables. Each
// operator gets one logical "agent" namespace per agentId; the agentId is
// part of every row's primary key.
//
// Profiles carry encrypted secrets (`keyEnc` / `tokenEnc` / etc.) — the
// adapter (ConvexAuthStore) handles encrypt-on-write / decrypt-on-read
// via the per-owner DEK so primitive code only ever sees plaintext.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const ProfileType = v.union(
	v.literal("api_key"),
	v.literal("oauth"),
	v.literal("token"),
);

const SecretRef = v.object({
	source: v.string(),
	provider: v.string(),
	id: v.string(),
});

// ============================================================================
// authProfiles
// ============================================================================

export const listProfiles = query({
	args: { ownerId: v.string(), agentId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("authProfiles")
			.withIndex("by_owner_agent", (q) =>
				q.eq("ownerId", args.ownerId).eq("agentId", args.agentId),
			)
			.collect();
	},
});

export const getProfile = query({
	args: {
		ownerId: v.string(),
		agentId: v.string(),
		profileId: v.string(),
	},
	handler: async (ctx, args) => {
		return ctx.db
			.query("authProfiles")
			.withIndex("by_owner_agent_profileId", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("agentId", args.agentId)
					.eq("profileId", args.profileId),
			)
			.first();
	},
});

export const upsertProfile = mutation({
	args: {
		ownerId: v.string(),
		agentId: v.string(),
		profileId: v.string(),
		provider: v.string(),
		alias: v.optional(v.string()),
		type: ProfileType,
		keyEnc: v.optional(v.bytes()),
		keyRef: v.optional(SecretRef),
		tokenEnc: v.optional(v.bytes()),
		tokenRef: v.optional(SecretRef),
		accessEnc: v.optional(v.bytes()),
		refreshEnc: v.optional(v.bytes()),
		expires: v.optional(v.number()),
		metadata: v.optional(v.any()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("authProfiles")
			.withIndex("by_owner_agent_profileId", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("agentId", args.agentId)
					.eq("profileId", args.profileId),
			)
			.first();
		const payload = { ...args, updatedAt: Date.now() };
		if (existing) {
			await ctx.db.replace(existing._id, payload);
			return { profileId: args.profileId, updated: true };
		}
		await ctx.db.insert("authProfiles", payload);
		return { profileId: args.profileId, updated: false };
	},
});

export const deleteProfile = mutation({
	args: {
		ownerId: v.string(),
		agentId: v.string(),
		profileId: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("authProfiles")
			.withIndex("by_owner_agent_profileId", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("agentId", args.agentId)
					.eq("profileId", args.profileId),
			)
			.first();
		if (!existing) return { deleted: false };
		await ctx.db.delete(existing._id);
		return { deleted: true };
	},
});

// ============================================================================
// profileState (per-profile cooldown / last-good / failure counters)
// ============================================================================

export const loadState = query({
	args: { ownerId: v.string(), agentId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("profileState")
			.withIndex("by_owner_agent_profileId", (q) =>
				q.eq("ownerId", args.ownerId).eq("agentId", args.agentId),
			)
			.collect();
	},
});

// ============================================================================
// authFiles (whole-file state blobs — auth-state.json / profile-state.json)
// ============================================================================

const AuthFileKind = v.union(
	v.literal("auth-state"),
	v.literal("profile-state"),
	v.literal("models"),
);

export const readAuthFile = query({
	args: { ownerId: v.string(), agentId: v.string(), kind: AuthFileKind },
	handler: async (ctx, args) => {
		return ctx.db
			.query("authFiles")
			.withIndex("by_owner_agent_kind", (q) =>
				q.eq("ownerId", args.ownerId).eq("agentId", args.agentId).eq("kind", args.kind),
			)
			.first();
	},
});

export const writeAuthFile = mutation({
	args: {
		ownerId: v.string(),
		agentId: v.string(),
		kind: AuthFileKind,
		payload: v.bytes(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("authFiles")
			.withIndex("by_owner_agent_kind", (q) =>
				q.eq("ownerId", args.ownerId).eq("agentId", args.agentId).eq("kind", args.kind),
			)
			.first();
		const row = { ...args, updatedAt: Date.now() };
		if (existing) {
			await ctx.db.replace(existing._id, row);
			return { updated: true };
		}
		await ctx.db.insert("authFiles", row);
		return { updated: false };
	},
});

export const upsertState = mutation({
	args: {
		ownerId: v.string(),
		agentId: v.string(),
		profileId: v.string(),
		provider: v.string(),
		lastUsed: v.optional(v.number()),
		cooldownUntil: v.optional(v.number()),
		cooldownReason: v.optional(v.string()),
		cooldownModel: v.optional(v.string()),
		disabledUntil: v.optional(v.number()),
		disabledReason: v.optional(v.string()),
		errorCount: v.optional(v.number()),
		failureCounts: v.optional(v.any()),
		lastFailureAt: v.optional(v.number()),
		isLastGood: v.boolean(),
		explicitOrder: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("profileState")
			.withIndex("by_owner_agent_profileId", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("agentId", args.agentId)
					.eq("profileId", args.profileId),
			)
			.first();
		if (existing) {
			await ctx.db.replace(existing._id, args);
			return { profileId: args.profileId, updated: true };
		}
		await ctx.db.insert("profileState", args);
		return { profileId: args.profileId, updated: false };
	},
});
