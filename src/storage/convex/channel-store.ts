// src/storage/convex/channel-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	ChannelStore,
	PairingRequest,
	WhatsAppAuthHandle,
} from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string; stateDir: string }

import { open as openSealed, seal as sealBytes, sealString } from "../encryption.js";

function stringToBytes(s: string): ArrayBuffer {
	return sealString(s);
}
function bytesToString(b: ArrayBuffer | null | undefined): string {
	if (!b) return "";
	return openSealed(b).toString("utf8");
}

export class ConvexChannelStore implements ChannelStore {
	constructor(private readonly deps: Deps) {}

	async listAllowedSenders(args: {
		channelId: string;
		accountId?: string | null;
		group?: boolean;
	}): Promise<string[]> {
		const rows = (await this.deps.client.query(api.channels.listAccess, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			kind: args.group ? "group-allow-from" : "allow-from",
		})) as Array<{ senderId: ArrayBuffer }>;
		return rows
			.map((r) => bytesToString(r.senderId))
			.filter((s) => s.length > 0);
	}

	// NOTE: the legacy upsertAccess/removeAccess mutations compare sealed
	// senderId BYTES server-side — sealing uses a random nonce per call, so
	// byte-equality silently never matches once BRIGADE_ENCRYPTION_KEY is
	// set (duplicates pile up; removals no-op). These methods therefore
	// read-decrypt-reconcile: equality happens CLIENT-side on plaintext and
	// the row set is replaced transactionally. The server stays blind.

	async addAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean> {
		const kind = args.group ? "group-allow-from" : "allow-from";
		const current = await this.listAllowedSenders(args);
		if (current.includes(args.senderId)) return false;
		const nowIso = new Date().toISOString();
		await this.reconcileAccessRows({
			channelId: args.channelId,
			accountId: args.accountId ?? null,
			kind,
			rows: [...current, args.senderId].map((senderId) => ({
				senderId,
				createdAt: nowIso,
				lastSeenAt: nowIso,
			})),
		});
		return true;
	}

	async removeAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean> {
		const kind = args.group ? "group-allow-from" : "allow-from";
		const current = await this.listAllowedSenders(args);
		if (!current.includes(args.senderId)) return false;
		const nowIso = new Date().toISOString();
		await this.reconcileAccessRows({
			channelId: args.channelId,
			accountId: args.accountId ?? null,
			kind,
			rows: current
				.filter((s) => s !== args.senderId)
				.map((senderId) => ({ senderId, createdAt: nowIso, lastSeenAt: nowIso })),
		});
		return true;
	}

	async listAllAccessRows(): Promise<
		Array<{
			channelId: string;
			accountId: string;
			kind: "allow-from" | "group-allow-from" | "pairing";
			senderId: string;
			senderName?: string;
			code?: string;
			createdAt: string;
			lastSeenAt: string;
		}>
	> {
		const rows = (await this.deps.client.query(api.channels.listAllAccess, {
			ownerId: this.deps.ownerId,
		})) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			channelId: r.channelId as string,
			accountId: r.accountId as string,
			kind: r.kind as "allow-from" | "group-allow-from" | "pairing",
			senderId: bytesToString(r.senderId as ArrayBuffer),
			...(r.senderName !== undefined ? { senderName: r.senderName as string } : {}),
			...(r.code !== undefined ? { code: bytesToString(r.code as ArrayBuffer) } : {}),
			createdAt: new Date((r.createdAt as number | undefined) ?? 0).toISOString(),
			lastSeenAt: new Date((r.lastSeenAt as number | undefined) ?? 0).toISOString(),
		}));
	}

	async reconcileAccessRows(args: {
		channelId: string;
		accountId?: string | null;
		kind: "allow-from" | "group-allow-from" | "pairing";
		rows: Array<{
			senderId: string;
			senderName?: string;
			code?: string;
			createdAt: string;
			lastSeenAt: string;
		}>;
	}): Promise<void> {
		await this.deps.client.mutation(api.channels.reconcileAccess, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			kind: args.kind,
			rows: args.rows.map((r) => ({
				senderId: stringToBytes(r.senderId),
				...(r.senderName !== undefined ? { senderName: r.senderName } : {}),
				...(r.code !== undefined ? { code: stringToBytes(r.code) } : {}),
				createdAt: Date.parse(r.createdAt) || 0,
				lastSeenAt: Date.parse(r.lastSeenAt) || 0,
			})),
		});
	}

	async listPendingPairings(_args: { channelId: string; accountId?: string | null }): Promise<PairingRequest[]> {
		// Pairing in convex mode follows a different shape — codes are
		// served from the channelAccess kind="pairing" rows. Read those.
		const rows = (await this.deps.client.query(api.channels.listAccess, {
			ownerId: this.deps.ownerId,
			channelId: _args.channelId,
			accountId: (_args.accountId ?? "default") || "default",
			kind: "pairing",
		})) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			code: bytesToString(r.senderId as ArrayBuffer),
			senderId: bytesToString(r.senderId as ArrayBuffer),
			senderName: r.senderName,
		})) as unknown as PairingRequest[];
	}

	async upsertPairingRequest(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		senderName?: string;
	}): Promise<{ code: string; isNew: boolean }> {
		return (await this.deps.client.mutation(api.channels.upsertPairingRequest, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			senderId: stringToBytes(args.senderId),
			...(args.senderName !== undefined ? { senderName: args.senderName } : {}),
		})) as { code: string; isNew: boolean };
	}

	async approvePairing(args: {
		channelId: string;
		accountId?: string | null;
		code: string;
	}): Promise<PairingRequest | null> {
		return (await this.deps.client.mutation(api.channels.approvePairing, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			code: args.code,
		})) as unknown as PairingRequest | null;
	}

	async revokePairing(args: {
		channelId: string;
		accountId?: string | null;
		code: string;
	}): Promise<boolean> {
		return (await this.deps.client.mutation(api.channels.revokePairing, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			code: args.code,
		})) as boolean;
	}

	async openWhatsAppAuthDir(args: { accountId: string }): Promise<WhatsAppAuthHandle> {
		// Per Phase 2 carve-outs, the Baileys multi-file auth dir STAYS LOCAL
		// in both modes — Baileys' API is FS-native. The Convex `whatsappAuthFile`
		// table is a mirror for cross-device backup, not the primary path.
		const path = await import("node:path");
		const { resolveWhatsAppAccountAuthDir } = await import(
			"../../agents/channels/whatsapp/account-config.js"
		);
		void path;
		const dir = resolveWhatsAppAccountAuthDir(args.accountId);
		return { path: dir, accountId: args.accountId } as unknown as WhatsAppAuthHandle;
	}

	async readLidReverseMapping(_args: { accountId: string; lidDigits: string }): Promise<string | null> {
		throw new NotImplementedYet("channels.readLidReverseMapping (needs Baileys-side reader)");
	}

	async putInboundMedia(args: {
		channelId: string;
		accountId?: string;
		messageId: string;
		index: number;
		mimeType: string;
		bytes: Buffer;
	}): Promise<{ ref: string; size: number }> {
		// Convex File Storage upload flow: short-lived upload URL → HTTP POST
		// the (sealed) bytes → record the channelMediaBlob row pointing at
		// the storage id. Bytes are sealed with the operator key before they
		// leave the process (passthrough when no key is set — same posture as
		// every other sealed column).
		const sealed = sealBytes(args.bytes);
		const uploadUrl = (await this.deps.client.mutation(
			api.channels.generateMediaUploadUrl,
			{},
		)) as string;
		const res = await fetch(uploadUrl, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: sealed,
		});
		if (!res.ok) {
			throw new Error(`media upload failed: HTTP ${res.status}`);
		}
		const { storageId } = (await res.json()) as { storageId: string };
		await this.deps.client.mutation(api.channels.recordMediaBlob, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			messageId: args.messageId,
			index: args.index,
			mimeType: args.mimeType,
			storageId: storageId as never,
			bytes: args.bytes.byteLength,
		});
		return {
			ref: `convex-file:${args.messageId}:${args.index}`,
			size: args.bytes.byteLength,
		};
	}

	// ---------------------------------------------------------------------
	// Baileys auth (whatsappAuthCreds + whatsappAuthKeys)
	// ---------------------------------------------------------------------

	/** ~900 KB is comfortably under the mutation arg cap with sealing
	 *  overhead; bigger values (LTHashState) spill to File Storage. */
	private static readonly AUTH_INLINE_CAP = 900 * 1024;

	async loadWhatsAppAuth(accountId: string): Promise<{
		creds: string | null;
		keys: Array<{ keyType: string; keyId: string; valueJson: string }>;
	}> {
		const result = (await this.deps.client.query(api.whatsappAuth.loadAll, {
			ownerId: this.deps.ownerId,
			accountId,
		})) as {
			creds: ArrayBuffer | null;
			keys: Array<{
				keyType: string;
				keyId: string;
				payload?: ArrayBuffer;
				url?: string | null;
			}>;
		};
		const keys: Array<{ keyType: string; keyId: string; valueJson: string }> = [];
		for (const k of result.keys) {
			if (k.payload !== undefined) {
				keys.push({ keyType: k.keyType, keyId: k.keyId, valueJson: bytesToString(k.payload) });
				continue;
			}
			if (k.url) {
				// File Storage spill — fetch + unseal.
				const res = await fetch(k.url);
				if (!res.ok) continue;
				const sealed = await res.arrayBuffer();
				keys.push({ keyType: k.keyType, keyId: k.keyId, valueJson: bytesToString(sealed) });
			}
		}
		return {
			creds: result.creds ? bytesToString(result.creds) : null,
			keys,
		};
	}

	async writeWhatsAppCreds(accountId: string, credsJson: string): Promise<void> {
		await this.deps.client.mutation(api.whatsappAuth.writeCreds, {
			ownerId: this.deps.ownerId,
			accountId,
			payload: stringToBytes(credsJson),
		});
	}

	async writeWhatsAppKeys(
		accountId: string,
		entries: Array<{ keyType: string; keyId: string; valueJson: string | null }>,
	): Promise<void> {
		if (entries.length === 0) return;
		const prepared: Array<{
			keyType: string;
			keyId: string;
			payload?: ArrayBuffer;
			storageId?: string;
		}> = [];
		for (const entry of entries) {
			if (entry.valueJson === null) {
				prepared.push({ keyType: entry.keyType, keyId: entry.keyId });
				continue;
			}
			const sealed = stringToBytes(entry.valueJson);
			if (sealed.byteLength <= ConvexChannelStore.AUTH_INLINE_CAP) {
				prepared.push({ keyType: entry.keyType, keyId: entry.keyId, payload: sealed });
				continue;
			}
			// Oversized (LTHashState) — File Storage spill via upload URL.
			const uploadUrl = (await this.deps.client.mutation(
				api.channels.generateMediaUploadUrl,
				{},
			)) as string;
			const res = await fetch(uploadUrl, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: sealed,
			});
			if (!res.ok) throw new Error(`auth key upload failed: HTTP ${res.status}`);
			const { storageId } = (await res.json()) as { storageId: string };
			prepared.push({ keyType: entry.keyType, keyId: entry.keyId, storageId });
		}
		await this.deps.client.mutation(api.whatsappAuth.writeKeys, {
			ownerId: this.deps.ownerId,
			accountId,
			entries: prepared as never,
		});
	}

	async clearWhatsAppAuth(accountId: string): Promise<void> {
		await this.deps.client.mutation(api.whatsappAuth.clearAccount, {
			ownerId: this.deps.ownerId,
			accountId,
		});
	}

	async eraseAccount(channelId: string, accountId: string): Promise<void> {
		await this.deps.client.mutation(api.channels.eraseAccount, {
			ownerId: this.deps.ownerId,
			channelId,
			accountId: accountId || "default",
		});
	}
}
