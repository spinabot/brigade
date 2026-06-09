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

import { open as openSealed, sealString } from "../encryption.js";

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

	async addAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean> {
		const result = (await this.deps.client.mutation(api.channels.upsertAccess, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			kind: args.group ? "group-allow-from" : "allow-from",
			senderId: stringToBytes(args.senderId),
		})) as { changed: boolean };
		return result.changed;
	}

	async removeAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean> {
		return (await this.deps.client.mutation(api.channels.removeAccess, {
			ownerId: this.deps.ownerId,
			channelId: args.channelId,
			accountId: (args.accountId ?? "default") || "default",
			kind: args.group ? "group-allow-from" : "allow-from",
			senderId: stringToBytes(args.senderId),
		})) as boolean;
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
		// Convex File Storage flow is a follow-up. Until then return a
		// stub locator carrying the message id so callers can move on.
		return {
			ref: `convex-pending:${args.messageId}:${args.index}`,
			size: args.bytes.byteLength,
		};
	}

	async eraseAccount(channelId: string, accountId: string): Promise<void> {
		await this.deps.client.mutation(api.channels.eraseAccount, {
			ownerId: this.deps.ownerId,
			channelId,
			accountId: accountId || "default",
		});
	}
}
