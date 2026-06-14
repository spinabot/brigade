// src/storage/local/channel-store.ts
//
// LocalChannelStore — filesystem-mode wrapper around
// `agents/channels/access-control/store.ts` + `agents/channels/whatsapp/*`.
// Implements `ChannelStore`.
//
// WhatsApp Baileys auth: FILESYSTEM mode uses the multi-file auth dir
// (real directory with creds.json + signal keys). CONVEX mode does NOT —
// auth rides the whatsappAuthCreds/whatsappAuthKeys tables via
// useConvexAuthState (the old both-modes carve-out is retired). `openWhatsApp-
// AuthDir` returns a handle carrying the resolved path so callers
// (the Baileys adapter) can keep using its FS-native multi-file auth API.
//
// PR13 scope:
//   ✓ allow-from / group-allow-from CRUD     — wraps access-control/store.ts
//   ✓ pairing CRUD                            — wraps access-control/store.ts
//   ✓ openWhatsAppAuthDir                     — wraps account-config.ts
//   ✓ readLidReverseMapping                   — DEFERRED (no upstream API)
//   ✓ putInboundMedia                         — content-addressed via BlobStore
//   ✓ eraseAccount                            — wraps eraseAccessState

import {
	addAllowFrom,
	addGroupAllowFrom,
	approvePairingCode,
	eraseAccessState,
	readAllowFrom,
	readGroupAllowFrom,
	readPendingPairings,
	removeAllowFrom,
	removeGroupAllowFrom,
	revokePairingCode,
	upsertPairingRequest,
} from "../../agents/channels/access-control/store.js";
import { resolveWhatsAppAccountAuthDir } from "../../agents/channels/whatsapp/account-config.js";

import { LocalBlobStore } from "./blob-store.js";

import { NotImplementedYet } from "../store.js";
import type {
	ChannelStore,
	PairingRequest,
	WhatsAppAuthHandle,
} from "../store.js";

export class LocalChannelStore implements ChannelStore {
	private readonly blobs: LocalBlobStore;

	constructor(private readonly _stateDir: string) {
		// Channel media is content-addressed via the same blob store
		// other subsystems (org chart cache, etc.) use. Keeps `<stateDir>/blobs/`
		// the single home for arbitrary bytes regardless of producer.
		this.blobs = new LocalBlobStore(_stateDir);
	}

	// ---------------------------------------------------------------------
	// allow-from / group-allow-from
	// ---------------------------------------------------------------------

	async listAllowedSenders(args: {
		channelId: string;
		accountId?: string | null;
		group?: boolean;
	}): Promise<string[]> {
		const acct = args.accountId ?? null;
		return args.group
			? readGroupAllowFrom(args.channelId, acct)
			: readAllowFrom(args.channelId, acct);
	}

	async addAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean> {
		const acct = args.accountId ?? null;
		return args.group
			? addGroupAllowFrom(args.channelId, args.senderId, acct)
			: addAllowFrom(args.channelId, args.senderId, acct);
	}

	async removeAllowedSender(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		group?: boolean;
	}): Promise<boolean> {
		const acct = args.accountId ?? null;
		return args.group
			? removeGroupAllowFrom(args.channelId, args.senderId, acct)
			: removeAllowFrom(args.channelId, args.senderId, acct);
	}

	/** Local mode never hydrates an access cache — the filesystem functions
	 *  read their JSON files directly. Empty keeps boot uniform. */
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
		return [];
	}

	/** No-op locally — the access-control module already wrote the JSON file
	 *  before the dispatcher would ever consider reconciling. */
	async reconcileAccessRows(_args: {
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
		// Filesystem mode persists via the access-control module itself.
	}

	// ---------------------------------------------------------------------
	// Baileys auth — filesystem mode uses useMultiFileAuthState against the
	// auth dir; these store methods only exist for the convex adapter.
	// ---------------------------------------------------------------------

	async loadWhatsAppAuth(_accountId: string): Promise<{
		creds: string | null;
		keys: Array<{ keyType: string; keyId: string; valueJson: string }>;
	}> {
		throw new NotImplementedYet(
			"channels.loadWhatsAppAuth (filesystem mode uses useMultiFileAuthState)",
		);
	}

	async writeWhatsAppCreds(_accountId: string, _credsJson: string): Promise<void> {
		throw new NotImplementedYet(
			"channels.writeWhatsAppCreds (filesystem mode uses useMultiFileAuthState)",
		);
	}

	async writeWhatsAppKeys(
		_accountId: string,
		_entries: Array<{ keyType: string; keyId: string; valueJson: string | null }>,
	): Promise<void> {
		throw new NotImplementedYet(
			"channels.writeWhatsAppKeys (filesystem mode uses useMultiFileAuthState)",
		);
	}

	async clearWhatsAppAuth(_accountId: string): Promise<void> {
		throw new NotImplementedYet(
			"channels.clearWhatsAppAuth (filesystem mode uses useMultiFileAuthState)",
		);
	}

	// ---------------------------------------------------------------------
	// Pairing
	// ---------------------------------------------------------------------

	async listPendingPairings(args: {
		channelId: string;
		accountId?: string | null;
	}): Promise<PairingRequest[]> {
		const result = readPendingPairings(args.channelId, args.accountId ?? null);
		return result as unknown as PairingRequest[];
	}

	async upsertPairingRequest(args: {
		channelId: string;
		accountId?: string | null;
		senderId: string;
		senderName?: string;
	}): Promise<{ code: string; isNew: boolean }> {
		return upsertPairingRequest({
			channelId: args.channelId,
			...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
			senderId: args.senderId,
			...(args.senderName !== undefined ? { senderName: args.senderName } : {}),
		});
	}

	async approvePairing(args: {
		channelId: string;
		accountId?: string | null;
		code: string;
	}): Promise<PairingRequest | null> {
		const result = approvePairingCode(args.channelId, args.code, args.accountId ?? null);
		return result as unknown as PairingRequest | null;
	}

	async revokePairing(args: {
		channelId: string;
		accountId?: string | null;
		code: string;
	}): Promise<boolean> {
		return revokePairingCode(args.channelId, args.code, args.accountId ?? null);
	}

	// ---------------------------------------------------------------------
	// WhatsApp Baileys auth dir (STAYS LOCAL in both modes)
	// ---------------------------------------------------------------------

	async openWhatsAppAuthDir(args: { accountId: string }): Promise<WhatsAppAuthHandle> {
		// Baileys uses `useMultiFileAuthState(dir)` — needs a real directory.
		// We surface the resolved path so the adapter can hand it to Baileys
		// directly. Convex mode reuses the same shape; the auth dir is one of
		// the five Phase 2 carve-outs that stay on disk regardless of mode.
		const path = resolveWhatsAppAccountAuthDir(args.accountId);
		return { path, accountId: args.accountId } as unknown as WhatsAppAuthHandle;
	}

	async readLidReverseMapping(_args: {
		accountId: string;
		lidDigits: string;
	}): Promise<string | null> {
		// No public LID-reverse lookup helper today — the Baileys adapter
		// owns it internally. PR13 stops short of exposing it; PR14 (sessions)
		// or a follow-up audit will surface the reader when channels need
		// cross-account translation.
		throw new NotImplementedYet("channels.readLidReverseMapping (needs Baileys-side reader)");
	}

	// ---------------------------------------------------------------------
	// Inbound media — content-addressed via the shared BlobStore
	// ---------------------------------------------------------------------

	async putInboundMedia(args: {
		channelId: string;
		accountId?: string;
		messageId: string;
		index: number;
		mimeType: string;
		bytes: Buffer;
	}): Promise<{ ref: string; size: number }> {
		// Store the bytes content-addressed so duplicates (forwarded media,
		// re-sent messages) dedupe automatically. The ref is the BlobStore
		// locator (`sha256:<hex>`); channel-side metadata (sender, conv,
		// timestamp) is the caller's responsibility — filesystem mode keeps
		// metadata in the existing channel state files, convex mode (PR16)
		// rows it into `channelMediaBlob`.
		const { sha256, url } = await this.blobs.put(
			new Uint8Array(args.bytes.buffer, args.bytes.byteOffset, args.bytes.byteLength),
			{ contentType: args.mimeType },
		);
		// Suppress the unused-warning on sha256 in callsites that don't need
		// both fields; the destructure is for symmetry with the blob store.
		void sha256;
		return { ref: url, size: args.bytes.byteLength };
	}

	async eraseAccount(channelId: string, _accountId: string): Promise<void> {
		// `eraseAccessState` clears the channel's allow-from + pairing files.
		// The Baileys auth dir + media blobs are intentionally LEFT IN PLACE —
		// the operator can delete those manually if they want a clean wipe,
		// but `eraseAccount` is a graceful "logout, keep history" operation.
		// (A full-wipe variant would be a separate `purgeAccount` method.)
		eraseAccessState(channelId);
	}
}
