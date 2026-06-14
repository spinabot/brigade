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

/**
 * Wrapper envelopes that contain a NESTED `message` to be unwrapped before
 * looking for `contextInfo`. Disappearing-message rooms wrap content in
 * `ephemeralMessage`; "view once" media (a single-view photo/video) wraps in
 * `viewOnceMessage` / `viewOnceMessageV2` / `viewOnceMessageV2Extension`;
 * documents with captions sometimes wrap in `documentWithCaptionMessage`;
 * Baileys' "bot invoke" path uses `botInvokeMessage`; group-mention
 * detail-broadcasts use `groupMentionedMessage`. Each wrapper has a
 * `.message` field containing the real envelope. We walk the chain until
 * we hit something that ISN'T a wrapper.
 */
const MESSAGE_WRAPPER_KEYS = [
	"ephemeralMessage",
	"viewOnceMessage",
	"viewOnceMessageV2",
	"viewOnceMessageV2Extension",
	"documentWithCaptionMessage",
	"botInvokeMessage",
	"groupMentionedMessage",
];

/**
 * Unwrap a Baileys message envelope by following the wrapper chain. Returns
 * the innermost message (the one carrying real content) so callers can search
 * for `contextInfo`, text, captions, etc. on the right shape. Hard-capped at
 * 8 iterations defensively — production payloads have ≤2 levels.
 */
function unwrapMessage(message: WAMessage["message"]): WAMessage["message"] | undefined {
	let current = message;
	for (let depth = 0; depth < 8 && current; depth += 1) {
		const obj = current as Record<string, unknown>;
		let unwrapped: WAMessage["message"] | undefined;
		for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
			const wrapper = obj[wrapperKey] as { message?: WAMessage["message"] } | undefined;
			if (wrapper?.message) {
				unwrapped = wrapper.message;
				break;
			}
		}
		if (!unwrapped) return current;
		current = unwrapped;
	}
	return current;
}

function findContextInfo(message: WAMessage["message"]): Record<string, unknown> | undefined {
	const m = unwrapMessage(message);
	if (!m) return undefined;
	const obj = m as Record<string, unknown>;
	for (const key of CONTEXT_BEARING_KEYS) {
		const env = obj[key] as Record<string, unknown> | undefined;
		const ctx = env?.contextInfo as Record<string, unknown> | undefined;
		if (ctx) return ctx;
	}
	return undefined;
}

/**
 * Extract mentioned jids in canonical E.164 form. LID-aliased mentions go
 * through the resolver chain: on-disk reverse-mapping (under `authDir`,
 * survives socket cold-start) → live `signalRepository.lidMapping` →
 * dropped. The `authDir` argument is optional; tests can omit it.
 */
export async function extractMentions(
	message: WAMessage["message"],
	sock: WASocket | null,
	authDir?: string,
	accountId?: string,
): Promise<string[]> {
	const ctx = findContextInfo(message);
	if (!ctx) return [];
	const raw = (ctx.mentionedJid as string[] | undefined) ?? [];
	const out: string[] = [];
	for (const jid of raw) {
		const id = await resolveJidToE164(sock, jid, authDir, accountId);
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
 * `from` is async-resolved through the LID chain (on-disk reverse-mapping +
 * live `signalRepository.lidMapping`); unresolvable participants become
 * `undefined` (we keep the body + messageId so the LLM still sees the
 * quote, just without a phone-number attribution).
 */
export async function extractReplyContext(
	message: WAMessage["message"],
	sock: WASocket | null,
	authDir?: string,
	accountId?: string,
): Promise<InboundReplyContext | undefined> {
	const ctx = findContextInfo(message);
	if (!ctx) return undefined;
	const stanzaId = typeof ctx.stanzaId === "string" ? ctx.stanzaId : undefined;
	const participant = typeof ctx.participant === "string" ? ctx.participant : undefined;
	const body = quotedTextOf(ctx.quotedMessage as Record<string, unknown> | undefined);
	if (!stanzaId && !body && !participant) return undefined;
	const fromE164 = participant ? await resolveJidToE164(sock, participant, authDir, accountId) : undefined;
	return {
		messageId: stanzaId,
		body: body ? body.slice(0, 280) : undefined, // truncate so LLM context isn't gobbled
		from: fromE164 ?? undefined,
	};
}
