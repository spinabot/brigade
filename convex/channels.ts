// convex/channels.ts — channelAccess + whatsappAuthFile + channelMediaBlob
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const AccessKind = v.union(
	v.literal("allow-from"),
	v.literal("group-allow-from"),
	v.literal("pairing"),
);

export const listAccess = query({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		kind: AccessKind,
	},
	handler: async (ctx, args) => {
		return ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", args.kind),
			)
			.collect();
	},
});

/** Every access row for the owner — single-operator scale keeps this tiny.
 *  Boot hydration uses it to fill the in-process access cache in one query
 *  instead of guessing the channel/account layout from config. */
export const listAllAccess = query({
	args: { ownerId: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) => q.eq("ownerId", args.ownerId))
			.collect();
	},
});

/** Replace the row set for one (channel, account, kind) in a single
 *  transaction — the convex-mode realisation of the filesystem's
 *  whole-file atomic write. Caller-supplied codes/timestamps are
 *  authoritative so locally-generated pairing codes survive verbatim. */
export const reconcileAccess = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		kind: AccessKind,
		rows: v.array(
			v.object({
				senderId: v.bytes(),
				senderName: v.optional(v.string()),
				code: v.optional(v.bytes()),
				createdAt: v.number(),
				lastSeenAt: v.number(),
			}),
		),
	},
	handler: async (ctx, args) => {
		// Wholesale replace: delete the existing set, insert the wanted set —
		// one transaction either way. Sealed senderId bytes carry a random
		// nonce per seal, so byte-equality between an incoming row and a
		// stored row is meaningless; matching for in-place patches would be
		// wrong, and at single-operator scale (a handful of rows per list)
		// replacement churn is irrelevant.
		const existing = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", args.kind),
			)
			.collect();
		for (const row of existing) await ctx.db.delete(row._id);
		for (const wanted of args.rows) {
			await ctx.db.insert("channelAccess", {
				ownerId: args.ownerId,
				channelId: args.channelId,
				accountId: args.accountId,
				kind: args.kind,
				senderId: wanted.senderId,
				...(wanted.senderName !== undefined ? { senderName: wanted.senderName } : {}),
				...(wanted.code !== undefined ? { code: wanted.code } : {}),
				createdAt: wanted.createdAt,
				lastSeenAt: wanted.lastSeenAt,
			});
		}
		return { count: args.rows.length };
	},
});

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const av = new Uint8Array(a);
	const bv = new Uint8Array(b);
	for (let i = 0; i < av.length; i++) {
		if (av[i] !== bv[i]) return false;
	}
	return true;
}

export const upsertAccess = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		kind: AccessKind,
		senderId: v.bytes(),
		senderName: v.optional(v.string()),
		code: v.optional(v.bytes()),
	},
	handler: async (ctx, args) => {
		const all = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", args.kind),
			)
			.collect();
		const now = Date.now();
		for (const row of all) {
			if (bytesEqual(row.senderId as ArrayBuffer, args.senderId)) {
				await ctx.db.patch(row._id, { lastSeenAt: now });
				return { changed: false };
			}
		}
		await ctx.db.insert("channelAccess", {
			ownerId: args.ownerId,
			channelId: args.channelId,
			accountId: args.accountId,
			kind: args.kind,
			senderId: args.senderId,
			...(args.senderName !== undefined ? { senderName: args.senderName } : {}),
			...(args.code !== undefined ? { code: args.code } : {}),
			createdAt: now,
			lastSeenAt: now,
		});
		return { changed: true };
	},
});

export const removeAccess = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		kind: AccessKind,
		senderId: v.bytes(),
	},
	handler: async (ctx, args) => {
		const all = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", args.kind),
			)
			.collect();
		let removed = 0;
		for (const row of all) {
			if (bytesEqual(row.senderId as ArrayBuffer, args.senderId)) {
				await ctx.db.delete(row._id);
				removed += 1;
			}
		}
		return removed > 0;
	},
});

export const eraseAccount = mutation({
	args: { ownerId: v.string(), channelId: v.string(), accountId: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId),
			)
			.collect();
		for (const r of rows) await ctx.db.delete(r._id);
	},
});

const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 60 * 60 * 1000; // 1h
const PAIRING_MAX_PENDING = 3;

function generatePairingCode(): string {
	let out = "";
	for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
		out += PAIRING_CODE_ALPHABET[Math.floor(Math.random() * PAIRING_CODE_ALPHABET.length)];
	}
	return out;
}

function bytesEqualPairing(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const av = new Uint8Array(a);
	const bv = new Uint8Array(b);
	for (let i = 0; i < av.length; i++) {
		if (av[i] !== bv[i]) return false;
	}
	return true;
}

export const upsertPairingRequest = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		senderId: v.bytes(),
		senderName: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Prune expired pairings first.
		const all = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", "pairing"),
			)
			.collect();
		const now = Date.now();
		const fresh = [];
		for (const r of all) {
			if (r.createdAt && now - r.createdAt < PAIRING_TTL_MS) {
				fresh.push(r);
			} else {
				await ctx.db.delete(r._id);
			}
		}
		// Existing pairing for this sender? Refresh lastSeenAt and return code.
		for (const r of fresh) {
			if (bytesEqualPairing(r.senderId as ArrayBuffer, args.senderId)) {
				await ctx.db.patch(r._id, { lastSeenAt: now });
				const code = new TextDecoder().decode((r.code as ArrayBuffer) ?? new ArrayBuffer(0));
				return { code, isNew: false };
			}
		}
		// Cap pending — drop oldest if over the limit.
		if (fresh.length >= PAIRING_MAX_PENDING) {
			const sorted = [...fresh].sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0));
			const drop = sorted.slice(0, fresh.length - PAIRING_MAX_PENDING + 1);
			for (const r of drop) await ctx.db.delete(r._id);
		}
		const code = generatePairingCode();
		const codeBytes = new TextEncoder().encode(code).buffer;
		await ctx.db.insert("channelAccess", {
			ownerId: args.ownerId,
			channelId: args.channelId,
			accountId: args.accountId,
			kind: "pairing",
			senderId: args.senderId,
			...(args.senderName !== undefined ? { senderName: args.senderName } : {}),
			code: codeBytes as ArrayBuffer,
			createdAt: now,
			lastSeenAt: now,
		});
		return { code, isNew: true };
	},
});

export const approvePairing = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		code: v.string(),
	},
	handler: async (ctx, args) => {
		const all = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", "pairing"),
			)
			.collect();
		const wanted = args.code.toUpperCase().replace(/\s|-/g, "");
		for (const r of all) {
			const code = new TextDecoder().decode((r.code as ArrayBuffer) ?? new ArrayBuffer(0));
			if (code === wanted) {
				// Move sender into the allow-from list, then drop the pairing.
				await ctx.db.insert("channelAccess", {
					ownerId: args.ownerId,
					channelId: args.channelId,
					accountId: args.accountId,
					kind: "allow-from",
					senderId: r.senderId,
					...(r.senderName !== undefined ? { senderName: r.senderName } : {}),
					createdAt: Date.now(),
					lastSeenAt: Date.now(),
				});
				await ctx.db.delete(r._id);
				return {
					code,
					senderId: new TextDecoder().decode(r.senderId as ArrayBuffer),
					senderName: r.senderName ?? null,
				};
			}
		}
		return null;
	},
});

export const revokePairing = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		code: v.string(),
	},
	handler: async (ctx, args) => {
		const all = await ctx.db
			.query("channelAccess")
			.withIndex("by_owner_channel_account_kind", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("kind", "pairing"),
			)
			.collect();
		const wanted = args.code.toUpperCase().replace(/\s|-/g, "");
		for (const r of all) {
			const code = new TextDecoder().decode((r.code as ArrayBuffer) ?? new ArrayBuffer(0));
			if (code === wanted) {
				await ctx.db.delete(r._id);
				return true;
			}
		}
		return false;
	},
});

// ============================================================================
// Media blobs (channelMediaBlob + Convex File Storage)
// ============================================================================

export const generateMediaUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		return await ctx.storage.generateUploadUrl();
	},
});

export const recordMediaBlob = mutation({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		messageId: v.string(),
		index: v.number(),
		mimeType: v.string(),
		fileName: v.optional(v.string()),
		storageId: v.id("_storage"),
		bytes: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert("channelMediaBlob", { ...args, createdAt: Date.now() });
		return { ok: true };
	},
});

export const getMediaBlobUrl = query({
	args: {
		ownerId: v.string(),
		channelId: v.string(),
		accountId: v.string(),
		messageId: v.string(),
		index: v.number(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("channelMediaBlob")
			.withIndex("by_owner_channel_account_msg", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("channelId", args.channelId)
					.eq("accountId", args.accountId)
					.eq("messageId", args.messageId),
			)
			.collect();
		const match = row.find((r) => r.index === args.index);
		if (!match) return null;
		const url = await ctx.storage.getUrl(match.storageId);
		return url ? { url, mimeType: match.mimeType, bytes: match.bytes } : null;
	},
});

export const writeAuthFile = mutation({
	args: {
		ownerId: v.string(),
		accountId: v.string(),
		fileKey: v.string(),
		contentB64: v.bytes(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("whatsappAuthFile")
			.withIndex("by_owner_account_file", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("accountId", args.accountId)
					.eq("fileKey", args.fileKey),
			)
			.first();
		const payload = {
			ownerId: args.ownerId,
			accountId: args.accountId,
			fileKey: args.fileKey,
			contentB64: args.contentB64,
			contentVersion: (existing?.contentVersion ?? 0) + 1,
			updatedAt: Date.now(),
		};
		if (existing) await ctx.db.replace(existing._id, payload);
		else await ctx.db.insert("whatsappAuthFile", payload);
	},
});

export const readAuthFile = query({
	args: { ownerId: v.string(), accountId: v.string(), fileKey: v.string() },
	handler: async (ctx, args) => {
		return ctx.db
			.query("whatsappAuthFile")
			.withIndex("by_owner_account_file", (q) =>
				q
					.eq("ownerId", args.ownerId)
					.eq("accountId", args.accountId)
					.eq("fileKey", args.fileKey),
			)
			.first();
	},
});
