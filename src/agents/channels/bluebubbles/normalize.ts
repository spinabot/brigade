/**
 * BlueBubbles webhook normalisation — DEFENSIVE.
 *
 * BlueBubbles fires `new-message` / `updated-message` webhook POSTs whose payload
 * shape varies by server version: the chat GUID may sit at the TOP LEVEL
 * (`chatGuid` / `chat_guid`), nested under `chat` / `conversation`, OR in the
 * `chats[0]` array. The sender may be a `handle` object, a `handle` string, or a
 * `sender`/`from` field. This module reads ALL those shapes into one stable
 * `NormalizedBlueBubblesMessage`, and surfaces the load-bearing decisions:
 *
 *   - `skip` reasons: `isFromMe` (we sent it) and tapback messages
 *     (`associatedMessageType` 2000-3999 — these are DROPPED so the agent never
 *     replies to a reaction as if it were text).
 *   - DM vs group: derived from the chat-guid separator (`;-;` = DM, `;+;` =
 *     group), then explicit flags, then participant count.
 *   - a decoded tapback note (for optional surfacing) when the message is a tapback.
 */

import { decodeTapbackType, isTapbackAssociatedType, type DecodedTapback } from "./reactions.js";
import type { RawBlueBubblesAttachment } from "./media.js";

/** A normalised inbound BlueBubbles message (transport-neutral). */
export interface NormalizedBlueBubblesMessage {
	/** The stable conversation id (a `chat_guid:` target the reply path understands). */
	conversationId: string;
	/** Raw chat GUID. */
	chatGuid: string;
	/** This message's GUID. */
	messageGuid: string;
	/** Sender handle (phone / email / `handle` string). */
	from: string;
	/** Optional display name of the sender. */
	fromName?: string;
	/** Message text (may be empty for a media-only message). */
	text: string;
	/** True when this is a group chat. */
	isGroup: boolean;
	/** When the platform stamped it (epoch ms), when known. */
	timestampMs?: number;
	/** A reply-to message GUID, when this message replies to another. */
	replyToGuid?: string;
	/** Raw attachment descriptors (downloaded later, post-access-gate). */
	attachments: RawBlueBubblesAttachment[];
	/** The raw webhook payload (for the pipeline's `raw` field). */
	raw: unknown;
}

/** The result of normalising a webhook payload: a message, a skip, or a tapback note. */
export type NormalizeResult =
	| { kind: "message"; message: NormalizedBlueBubblesMessage }
	| { kind: "skip"; reason: string }
	| { kind: "tapback"; tapback: DecodedTapback; chatGuid: string; targetGuid?: string; from: string; isGroup: boolean };

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readString(rec: Record<string, unknown> | null, ...keys: string[]): string | undefined {
	if (!rec) return undefined;
	for (const key of keys) {
		const v = rec[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

function readBoolean(rec: Record<string, unknown> | null, ...keys: string[]): boolean | undefined {
	if (!rec) return undefined;
	for (const key of keys) {
		const v = rec[key];
		if (typeof v === "boolean") return v;
	}
	return undefined;
}

function readNumber(rec: Record<string, unknown> | null, ...keys: string[]): number | undefined {
	if (!rec) return undefined;
	for (const key of keys) {
		const v = rec[key];
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return undefined;
}

/** The first `chats[]` record on a message, or null. */
function readFirstChatRecord(message: Record<string, unknown>): Record<string, unknown> | null {
	const chats = message.chats;
	if (Array.isArray(chats) && chats.length > 0) return asRecord(chats[0]);
	return null;
}

/**
 * Unwrap the webhook envelope to the inner message record. BlueBubbles nests the
 * message under `data` (and sometimes `payload` / `event`); the inner message may
 * itself be under `message` or be the record directly.
 */
function extractMessageRecord(payload: unknown): Record<string, unknown> | null {
	const root = asRecord(payload);
	if (!root) return null;
	const data = asRecord(root.data) ?? asRecord(root.payload) ?? asRecord(root.event) ?? root;
	return asRecord(data.message) ?? data;
}

/** Resolve the chat GUID across the top-level / nested / `chats[0]` shapes. */
function resolveChatGuid(message: Record<string, unknown>): string | undefined {
	const chat = asRecord(message.chat) ?? asRecord(message.conversation);
	const first = readFirstChatRecord(message);
	return (
		readString(message, "chatGuid", "chat_guid") ??
		readString(chat, "chatGuid", "chat_guid", "guid") ??
		readString(first, "chatGuid", "chat_guid", "guid")
	);
}

/** Derive group-ness from the chat-guid separator (`;+;` group, `;-;` DM). */
function isGroupFromGuid(chatGuid: string | undefined): boolean | undefined {
	if (!chatGuid) return undefined;
	if (chatGuid.includes(";+;")) return true;
	if (chatGuid.includes(";-;")) return false;
	return undefined;
}

/** Extract the sender handle (object handle / string handle / sender / from). */
function resolveSender(message: Record<string, unknown>): { from: string; fromName?: string } {
	const handle = asRecord(message.handle);
	const fromHandle =
		readString(handle, "address", "handle", "id") ??
		(typeof message.handle === "string" ? (message.handle as string).trim() : undefined);
	const from = fromHandle ?? readString(message, "sender", "from", "senderId") ?? "";
	const fromName = readString(message, "displayName", "senderName") ?? readString(handle, "displayName");
	return fromName ? { from, fromName } : { from };
}

/** Normalise a timestamp (s or ms) to epoch ms. */
function resolveTimestampMs(message: Record<string, unknown>): number | undefined {
	const raw = readNumber(message, "dateCreated", "date", "timestamp");
	if (raw === undefined) return undefined;
	return raw > 1e12 ? raw : raw * 1000;
}

/** Read the raw attachment descriptors (camel + snake case). */
function resolveAttachments(message: Record<string, unknown>): RawBlueBubblesAttachment[] {
	const raw = message.attachments;
	if (!Array.isArray(raw)) return [];
	const out: RawBlueBubblesAttachment[] = [];
	for (const a of raw) {
		const rec = asRecord(a);
		if (!rec) continue;
		const guid = readString(rec, "guid");
		if (!guid) continue;
		const transferName = readString(rec, "transferName", "transfer_name");
		const mimeType = readString(rec, "mimeType", "mime_type", "uti");
		const totalBytes = readNumber(rec, "totalBytes", "total_bytes");
		out.push({
			guid,
			...(transferName ? { transferName } : {}),
			...(mimeType ? { mimeType } : {}),
			...(totalBytes !== undefined ? { totalBytes } : {}),
		});
	}
	return out;
}

/**
 * Normalise a BlueBubbles webhook payload. `eventType` is the webhook's declared
 * type (`new-message` / `updated-message`). Returns a `message`, a `skip` (with a
 * reason), or a `tapback` (decoded reaction) result.
 */
export function normalizeBlueBubblesWebhook(payload: unknown, eventType?: string): NormalizeResult {
	const message = extractMessageRecord(payload);
	if (!message) return { kind: "skip", reason: "unparseable payload" };

	// We sent it — never reply to our own message.
	const fromMe = readBoolean(message, "isFromMe", "is_from_me");
	if (fromMe) return { kind: "skip", reason: "isFromMe" };

	const chatGuid = resolveChatGuid(message);
	const { from, fromName } = resolveSender(message);
	const isGroup = isGroupFromGuid(chatGuid) ?? readBoolean(message, "isGroup", "is_group") ?? false;

	// Tapback: an `associatedMessageType` in the 2000-3999 range. DROP it as a
	// normal message; surface a decoded note when it's one of the six tapbacks.
	const associatedType = readNumber(message, "associatedMessageType", "associated_message_type");
	if (isTapbackAssociatedType(associatedType)) {
		const decoded = decodeTapbackType(associatedType);
		const targetGuid = readString(message, "associatedMessageGuid", "associated_message_guid");
		if (decoded && chatGuid) {
			return {
				kind: "tapback",
				tapback: decoded,
				chatGuid,
				...(targetGuid ? { targetGuid } : {}),
				from,
				isGroup,
			};
		}
		return { kind: "skip", reason: "tapback" };
	}

	if (!chatGuid) return { kind: "skip", reason: "no chat guid" };

	const messageGuid = readString(message, "guid", "messageGuid") ?? "";
	const text = readString(message, "text", "message") ?? "";
	const attachments = resolveAttachments(message);

	// Skip a truly empty message (no text, no media) — nothing to act on.
	if (!text && attachments.length === 0) return { kind: "skip", reason: "empty message" };

	// A reply target — but NOT a reaction association (that's handled above).
	const replyToGuid = readString(message, "threadOriginatorGuid", "thread_originator_guid", "replyToGuid");
	const timestampMs = resolveTimestampMs(message);

	return {
		kind: "message",
		message: {
			conversationId: `chat_guid:${chatGuid}`,
			chatGuid,
			messageGuid,
			from,
			...(fromName ? { fromName } : {}),
			text,
			isGroup,
			...(timestampMs !== undefined ? { timestampMs } : {}),
			...(replyToGuid ? { replyToGuid } : {}),
			attachments,
			raw: payload,
		},
	};
}
