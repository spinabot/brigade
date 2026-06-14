// convex/whatsappAuth.ts — Baileys AuthenticationState backing tables.
//
// The convex-mode replacement for useMultiFileAuthState's ~900-file auth
// dir. creds = one sealed blob; keys = one row per (keyType, keyId) with a
// File Storage spill for oversized values (LTHashState). All payloads are
// sealed client-side — this module never sees plaintext key material.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/** Pre-hydrate the whole keystore in one query — Baileys reads keys inside
 *  the Signal decrypt path, so the adapter serves them from an in-process
 *  cache filled here at connect time. Oversized values come back as a
 *  download URL instead of inline bytes. */
export const loadAll = query({
	args: { ownerId: v.string(), accountId: v.string() },
	handler: async (ctx, args) => {
		const credsRow = await ctx.db
			.query("whatsappAuthCreds")
			.withIndex("by_owner_account", (q) =>
				q.eq("ownerId", args.ownerId).eq("accountId", args.accountId),
			)
			.first();
		const keyRows = await ctx.db
			.query("whatsappAuthKeys")
			.withIndex("by_owner_account", (q) =>
				q.eq("ownerId", args.ownerId).eq("accountId", args.accountId),
			)
			.collect();
		const keys = [];
		for (const row of keyRows) {
			if (row.storageId) {
				const url = await ctx.storage.getUrl(row.storageId);
				keys.push({ keyType: row.keyType, keyId: row.keyId, url });
			} else {
				keys.push({ keyType: row.keyType, keyId: row.keyId, payload: row.payload });
			}
		}
		return { creds: credsRow?.payload ?? null, keys };
	},
});

export const writeCreds = mutation({
	args: { ownerId: v.string(), accountId: v.string(), payload: v.bytes() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("whatsappAuthCreds")
			.withIndex("by_owner_account", (q) =>
				q.eq("ownerId", args.ownerId).eq("accountId", args.accountId),
			)
			.first();
		const row = { ...args, updatedAt: Date.now() };
		if (existing) {
			await ctx.db.replace(existing._id, row);
			return { updated: true };
		}
		await ctx.db.insert("whatsappAuthCreds", row);
		return { updated: false };
	},
});

/** Batched key upserts + deletes in one transaction — mirrors Baileys'
 *  transaction batching (addTransactionCapability flushes whole
 *  SignalDataSets). An entry with neither payload nor storageId is a
 *  DELETE (Baileys sets null to remove keys). */
export const writeKeys = mutation({
	args: {
		ownerId: v.string(),
		accountId: v.string(),
		entries: v.array(
			v.object({
				keyType: v.string(),
				keyId: v.string(),
				payload: v.optional(v.bytes()),
				storageId: v.optional(v.id("_storage")),
			}),
		),
	},
	handler: async (ctx, args) => {
		for (const entry of args.entries) {
			const existing = await ctx.db
				.query("whatsappAuthKeys")
				.withIndex("by_owner_account_type_id", (q) =>
					q
						.eq("ownerId", args.ownerId)
						.eq("accountId", args.accountId)
						.eq("keyType", entry.keyType)
						.eq("keyId", entry.keyId),
				)
				.first();
			const isDelete = entry.payload === undefined && entry.storageId === undefined;
			if (isDelete) {
				if (existing) {
					// Reap the spilled File Storage blob first — deleting only the
					// row would orphan the object (storage isn't ref-counted).
					if (existing.storageId) await ctx.storage.delete(existing.storageId);
					await ctx.db.delete(existing._id);
				}
				continue;
			}
			const row = {
				ownerId: args.ownerId,
				accountId: args.accountId,
				keyType: entry.keyType,
				keyId: entry.keyId,
				...(entry.payload !== undefined ? { payload: entry.payload } : {}),
				...(entry.storageId !== undefined ? { storageId: entry.storageId } : {}),
				updatedAt: Date.now(),
			};
			if (existing) {
				// If the prior value spilled to File Storage and the new value
				// doesn't reuse the same object, delete the old blob to avoid an
				// orphan (overwrite with inline payload, or a fresh spill).
				if (existing.storageId && existing.storageId !== entry.storageId) {
					await ctx.storage.delete(existing.storageId);
				}
				await ctx.db.replace(existing._id, row);
			} else {
				await ctx.db.insert("whatsappAuthKeys", row);
			}
		}
		return { count: args.entries.length };
	},
});

/** Wipe an account's auth state entirely (logout / unlink). */
export const clearAccount = mutation({
	args: { ownerId: v.string(), accountId: v.string() },
	handler: async (ctx, args) => {
		const credsRow = await ctx.db
			.query("whatsappAuthCreds")
			.withIndex("by_owner_account", (q) =>
				q.eq("ownerId", args.ownerId).eq("accountId", args.accountId),
			)
			.first();
		if (credsRow) await ctx.db.delete(credsRow._id);
		const keyRows = await ctx.db
			.query("whatsappAuthKeys")
			.withIndex("by_owner_account", (q) =>
				q.eq("ownerId", args.ownerId).eq("accountId", args.accountId),
			)
			.collect();
		for (const row of keyRows) {
			// Reap any spilled File Storage blob before dropping the row so an
			// unlink/logout leaves nothing behind in storage.
			if (row.storageId) await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
		return { removedKeys: keyRows.length };
	},
});
