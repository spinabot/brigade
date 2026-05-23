/**
 * Extract optional metadata from a normalized WhatsApp message:
 *   - `mentionedJid` arrays (group @-mentions, scattered across many envelope
 *     keys: extendedTextMessage / imageMessage / videoMessage / etc.)
 *   - quoted-reply context (`contextInfo.quotedMessage` + sender)
 *
 * Resolution is async because LID-aliased jids (`@lid` / `@hosted.lid`) need a
 * runtime lookup through Baileys' `signalRepository.lidMapping` to get a real
 * phone number — the leading digits of a LID jid are NOT a phone number.
 * Unresolvable LIDs are dropped from the result rather than minted as fake
 * sender ids (which would let stranger-mentions falsely match allow-lists).
 */

import type { WAMessage, WASocket } from "@whiskeysockets/baileys";

import type { InboundReplyContext } from "../../extensions/types.js";
import { resolveJidToE164 } from "./connection.js";

/** Envelope keys that may carry a `contextInfo` block (mentions + quoted). */
const CONTEXT_BEARING_KEYS = [
	"extendedTextMessage",
	"imageMessage",
	"videoMessage",
	"audioMessage",
	"documentMessage",
	"stickerMessage",
	"buttonsMessage",
	"listMessage",
	"buttonsResponseMessage",
	"listResponseMessage",
];

function findContextInfo(message: WAMessage["message"]): Record<string, unknown> | undefined {
	if (!message) return undefined;
	const m = message as Record<string, unknown>;
	for (const key of CONTEXT_BEARING_KEYS) {
		const env = m[key] as Record<string, unknown> | undefined;
		const ctx = env?.contextInfo as Record<string, unknown> | undefined;
		if (ctx) return ctx;
	}
	return undefined;
}

/**
 * Extract mentioned jids in canonical E.164 form. LID-aliased mentions go
 * through the signalRepository LID table; unresolvable ones are dropped.
 */
export async function extractMentions(
	message: WAMessage["message"],
	sock: WASocket | null,
): Promise<string[]> {
	const ctx = findContextInfo(message);
	if (!ctx) return [];
	const raw = (ctx.mentionedJid as string[] | undefined) ?? [];
	const out: string[] = [];
	for (const jid of raw) {
		const id = await resolveJidToE164(sock, jid);
		if (id) out.push(id);
	}
	return [...new Set(out)];
}

/** Walk a `quotedMessage` payload and pluck a short text body. */
function quotedTextOf(quoted: Record<string, unknown> | undefined): string | undefined {
	if (!quoted) return undefined;
	if (typeof quoted.conversation === "string") return quoted.conversation;
	const ext = quoted.extendedTextMessage as { text?: string } | undefined;
	if (ext && typeof ext.text === "string") return ext.text;
	const img = quoted.imageMessage as { caption?: string } | undefined;
	if (img?.caption) return img.caption;
	const vid = quoted.videoMessage as { caption?: string } | undefined;
	if (vid?.caption) return vid.caption;
	const doc = quoted.documentMessage as { caption?: string } | undefined;
	if (doc?.caption) return doc.caption;
	return undefined;
}

/**
 * Pull a reply-context shape from the inbound, when this message quotes another.
 * `from` is async-resolved through the LID table; unresolvable participants
 * become `undefined` (we keep the body + messageId so the LLM still sees the
 * quote, just without a phone-number attribution).
 */
export async function extractReplyContext(
	message: WAMessage["message"],
	sock: WASocket | null,
): Promise<InboundReplyContext | undefined> {
	const ctx = findContextInfo(message);
	if (!ctx) return undefined;
	const stanzaId = typeof ctx.stanzaId === "string" ? ctx.stanzaId : undefined;
	const participant = typeof ctx.participant === "string" ? ctx.participant : undefined;
	const body = quotedTextOf(ctx.quotedMessage as Record<string, unknown> | undefined);
	if (!stanzaId && !body && !participant) return undefined;
	const fromE164 = participant ? await resolveJidToE164(sock, participant) : undefined;
	return {
		messageId: stanzaId,
		body: body ? body.slice(0, 280) : undefined, // truncate so LLM context isn't gobbled
		from: fromE164 ?? undefined,
	};
}
