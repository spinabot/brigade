/**
 * Pure extractors that turn a grammY `Message` into the normalized fields
 * Brigade's `InboundMessage` carries. No network, no side effects — every
 * function here is deterministic over its `Message` argument so they're trivial
 * to unit-test without a live bot.
 *
 * The text / mention / media-detection logic is ported nearly verbatim from
 * the reference Telegram extension (`bot/body-helpers.ts` +
 * `bot-handlers.media.ts`); only brand tokens and the IR-engine dependency were
 * scrubbed. Brigade's CENTRAL inbound pipeline owns the actual ACL / mention /
 * routing decision — these helpers only surface the raw signals it reads
 * (`mentions`, `threadId`, `replyTo`, chat type).
 */

import type { Message } from "@grammyjs/types";

import type { InboundReplyContext } from "../sdk.js";

/** Telegram message entity (mention / link / etc.). */
type TelegramTextEntity = NonNullable<Message["entities"]>[number];

/**
 * Reject control-byte payloads (a binary blob masquerading as text). Tab / LF /
 * CR are allowed; any other C0 control char marks the run as non-text and it's
 * dropped so the agent never ingests raw binary. Ported from the reference
 * `isBinaryContent`.
 */
function isBinaryContent(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return true;
		}
	}
	return false;
}

/** Pick the message's text body (prefers `text`, falls back to media `caption`). */
function resolveTextContent(text: unknown, caption?: unknown): string {
	const raw = typeof text === "string" ? text : typeof caption === "string" ? caption : "";
	return isBinaryContent(raw) ? "" : raw;
}

/**
 * The text + entities a message carries. Caption-bearing media surfaces its
 * caption (and `caption_entities`) as the text. Empty text means no entities.
 */
export function getTelegramTextParts(
	msg: Pick<Message, "text" | "caption" | "entities" | "caption_entities">,
): { text: string; entities: TelegramTextEntity[] } {
	const text = resolveTextContent(msg.text, msg.caption);
	const entities = text ? (msg.entities ?? msg.caption_entities ?? []) : [];
	return { text, entities };
}

/**
 * Rewrite Telegram `text_link` entities (hyperlinked display text) back into
 * markdown `[label](url)` so the agent sees the destination URL. Applied
 * right-to-left so earlier offsets stay valid as we splice. Ported from the
 * reference `expandTextLinks`.
 */
function expandTextLinks(text: string, entities?: TelegramTextEntity[] | null): string {
	if (!text || !entities?.length) return text;
	const textLinks = entities
		.filter((e): e is TelegramTextEntity & { url: string } => e.type === "text_link" && Boolean((e as { url?: string }).url))
		.slice()
		.sort((a, b) => b.offset - a.offset);
	if (textLinks.length === 0) return text;
	let result = text;
	for (const entity of textLinks) {
		const linkText = text.slice(entity.offset, entity.offset + entity.length);
		const markdown = `[${linkText}](${entity.url})`;
		result = result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
	}
	return result;
}

/** Extract the agent-facing plain text (caption-aware + text_link-expanded). */
export function extractTelegramText(msg: Message): string {
	const { text, entities } = getTelegramTextParts(msg);
	return expandTextLinks(text, entities).trim();
}

/** Telegram chat kind → Brigade chat type. private → direct; group/supergroup → group. */
export function telegramChatType(msg: Message): "direct" | "group" {
	const type = msg.chat?.type;
	return type === "group" || type === "supergroup" ? "group" : "direct";
}

/** Forum-topic / thread id as a string, when the message belongs to one. */
export function telegramThreadId(msg: Message): string | undefined {
	const id = msg.message_thread_id;
	return typeof id === "number" ? String(id) : undefined;
}

/** Lowercase a value, treating non-strings as "". */
function lower(value: string | undefined | null): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

/** Word-char test for standalone @mention boundary detection. */
function isMentionWordChar(char: string | undefined): boolean {
	return char != null && /[a-z0-9_]/i.test(char);
}

/** True when `mention` appears in `text` not glued to another word char. */
function hasStandaloneMention(text: string, mention: string): boolean {
	let startIndex = 0;
	while (startIndex < text.length) {
		const idx = text.indexOf(mention, startIndex);
		if (idx === -1) return false;
		const prev = idx > 0 ? text[idx - 1] : undefined;
		const next = text[idx + mention.length];
		if (!isMentionWordChar(prev) && !isMentionWordChar(next)) return true;
		startIndex = idx + 1;
	}
	return false;
}

/**
 * Channel-native ids of accounts addressed in this message. Brigade's central
 * group ACL treats a group message as "addressed to the bot" when the bot's
 * own id appears in `mentions`; without this a group message never reaches the
 * agent. So when the bot's own `@username` is mentioned (as a `mention` entity
 * OR a standalone `@username` in the text), we surface the bot's NUMERIC id
 * (passed in from getMe) — that's the stable handle the pipeline matches
 * against the linked self id.
 *
 * Other users' `text_mention` entities (which carry a real `user.id`) are also
 * surfaced so the pipeline can see who else was tagged. Plain `@username`
 * mentions of OTHER users are NOT resolvable to a numeric id from the message
 * alone (Telegram doesn't include their id), so they're dropped rather than
 * minting a fake id.
 *
 * @param botUserId  the bot's own numeric id (from getMe) as a string, used as
 *                   the surfaced id when the bot is @-mentioned.
 * @param botUsername the bot's own @username (without `@`), lower-cased match.
 */
export function extractTelegramMentions(
	msg: Message,
	botUsername?: string,
	botUserId?: string,
): string[] {
	const { text, entities } = getTelegramTextParts(msg);
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (id: string | undefined) => {
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push(id);
	};

	const botHandle = botUsername ? lower(`@${botUsername}`) : "";
	let botMentioned = false;

	// text_mention entities carry a concrete user → surface that user's id.
	for (const ent of entities) {
		if (ent.type === "text_mention") {
			const uid = (ent as { user?: { id?: number } }).user?.id;
			if (typeof uid === "number") {
				const idStr = String(uid);
				if (botUserId && idStr === botUserId) botMentioned = true;
				else push(idStr);
			}
			continue;
		}
		if (ent.type === "mention" && botHandle) {
			const slice = lower(text.slice(ent.offset, ent.offset + ent.length));
			if (slice === botHandle) botMentioned = true;
		}
	}

	// Standalone "@botusername" anywhere in the text also counts as addressing.
	if (botHandle && hasStandaloneMention(lower(text), botHandle)) botMentioned = true;

	// A reply to one of the bot's own messages is an implicit address.
	if (botUserId && typeof msg.reply_to_message?.from?.id === "number" && String(msg.reply_to_message.from.id) === botUserId) {
		botMentioned = true;
	}

	if (botMentioned && botUserId) push(botUserId);
	return out;
}

/** Reply-context (what message this inbound quotes), when it's a reply. */
export function extractTelegramReplyContext(msg: Message): InboundReplyContext | undefined {
	const reply = msg.reply_to_message;
	if (!reply) return undefined;
	const messageId = typeof reply.message_id === "number" ? String(reply.message_id) : undefined;
	const from = typeof reply.from?.id === "number" ? String(reply.from.id) : undefined;
	const quotedText = extractTelegramText(reply);
	const body = quotedText ? quotedText.slice(0, 280) : undefined; // bound LLM context
	if (!messageId && !from && !body) return undefined;
	return { messageId, from, body };
}

/* ───────────────────────── media detection (ported) ───────────────────────── */

/**
 * Cheap presence probe — does this message carry a downloadable media envelope?
 * Walks the same fields as the downloader but never touches the network, so the
 * connection layer can DEFER the actual download until AFTER the central access
 * gate admits the sender (mirrors WhatsApp's deferred-media discipline). Ported
 * from the reference `bot-handlers.media.ts` `hasInboundMedia`.
 */
export function hasInboundMedia(msg: Message): boolean {
	return (
		Boolean(msg.media_group_id) ||
		(Array.isArray(msg.photo) && msg.photo.length > 0) ||
		Boolean(msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker)
	);
}

/**
 * The `file_id` of the primary downloadable attachment (largest photo size /
 * the single video / document / etc.). Ported from the reference
 * `resolveInboundMediaFileId`. Returns undefined for a text-only message.
 */
export function resolveInboundMediaFileId(msg: Message): string | undefined {
	return (
		msg.sticker?.file_id ??
		msg.photo?.[msg.photo.length - 1]?.file_id ??
		msg.video?.file_id ??
		msg.video_note?.file_id ??
		msg.document?.file_id ??
		msg.audio?.file_id ??
		msg.voice?.file_id
	);
}

/** The Brigade media-kind of the primary attachment, for the `InboundMediaAttachment.kind`. */
export function resolveInboundMediaKind(
	msg: Message,
): "image" | "video" | "audio" | "voice" | "document" | "sticker" | undefined {
	if (msg.sticker) return "sticker";
	if (Array.isArray(msg.photo) && msg.photo.length > 0) return "image";
	if (msg.video || msg.video_note) return "video";
	if (msg.voice) return "voice";
	if (msg.audio) return "audio";
	if (msg.document) return "document";
	return undefined;
}

/** A short display name for the sender (`First Last` or `@username`). */
export function buildTelegramSenderName(msg: Message): string | undefined {
	const from = msg.from;
	if (!from) return undefined;
	const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
	if (full) return full;
	return from.username ? `@${from.username}` : undefined;
}
