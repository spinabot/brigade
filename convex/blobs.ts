// convex/blobs.ts — content-addressed bytes via Convex File Storage.
//
// Public surface:
//   generateUploadUrl(sha256)  — operator-facing one-time URL (client PUTs bytes)
//   recordUpload(sha256, storageId, contentType?, size?)
//   getUrl(sha256)             — short-lived signed URL for download
//   delete(sha256)             — remove blob + storage row
//
// `brigadeBlobs` is the metadata side; the actual byte storage lives in
// Convex's `_storage` table managed by `storage.generateUploadUrl` and
// `storage.getUrl`.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

export const generateUploadUrl = mutation({
	args: { ownerId: v.string(), sha256: v.string() },
	handler: async (ctx, args) => {
		// Brief OCC: if this sha already has a row, hand back the existing
		// upload URL so re-uploaders don't get a fresh storageId.
		const existing = await ctx.db
			.query("brigadeBlobs")
			.withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
			.first();
		if (existing) {
			return {
				uploadUrl: await ctx.storage.generateUploadUrl(),
				storageId: existing.storageId,
				existed: true,
				ownerId: args.ownerId,
			};
		}
		return {
			uploadUrl: await ctx.storage.generateUploadUrl(),
			storageId: null as string | null,
			existed: false,
			ownerId: args.ownerId,
		};
	},
});

export const recordUpload = mutation({
	args: {
		ownerId: v.string(),
		sha256: v.string(),
		storageId: v.id("_storage"),
		contentType: v.optional(v.string()),
		size: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("brigadeBlobs")
			.withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, {
				refcount: (existing.refcount as number ?? 0) + 1,
				lastTouchedAt: Date.now(),
			});
			return { existed: true };
		}
		await ctx.db.insert("brigadeBlobs", {
			ownerId: args.ownerId,
			sha256: args.sha256,
			storageId: args.storageId,
			mime: args.contentType ?? "application/octet-stream",
			size: args.size,
			refcount: 1,
			lastTouchedAt: Date.now(),
		});
		return { existed: false };
	},
});

export const getMeta = query({
	args: { sha256: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("brigadeBlobs")
			.withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
			.first();
	},
});

export const getDownloadUrl = query({
	args: { sha256: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("brigadeBlobs")
			.withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
			.first();
		if (!row) return null;
		return ctx.storage.getUrl(row.storageId);
	},
});

export const remove = mutation({
	args: { sha256: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("brigadeBlobs")
			.withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
			.first();
		if (!row) return false;
		// Decrement refcount; only delete when zero.
		const next = (row.refcount as number ?? 1) - 1;
		if (next > 0) {
			await ctx.db.patch(row._id, { refcount: next, lastTouchedAt: Date.now() });
			return false;
		}
		await ctx.storage.delete(row.storageId);
		await ctx.db.delete(row._id);
		return true;
	},
});
