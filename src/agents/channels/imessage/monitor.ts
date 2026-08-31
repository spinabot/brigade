/**
 * iMessage inbound monitor — parse notifications, normalize, and guard against
 * self-echo / reflection / runaway loops.
 *
 * The `imsg rpc` process emits a `message` notification for every new row in the
 * chat database (including the agent's OWN outbound sends, which come back as
 * `is_from_me` rows, AND self-chat reflections). This module condenses the
 * upstream `monitor/` subsystem into the load-bearing pieces:
 *
 *   1. `parseIMessageNotification` — validate + shape the notification params,
 *      stripping the protobuf length-prefix some text rows carry.
 *   2. `normalizeIMessageMessage`  — turn the payload into a normalized inbound.
 *   3. `SentMessageCache`          — remember every outbound send; drop the
 *      inbound echo when it matches (text TTL 4s / id TTL 60s).
 *   4. `SelfChatCache`             — drop a self-chat message reflected back as a
 *      second `is_from_me=false` row (TTL 10s, keyed on text + timestamp).
 *   5. `detectReflectedContent`    — drop inbound carrying assistant-internal
 *      markers that leaked out and bounced back.
 *   6. `LoopRateLimiter`           — after 5 loop-drops in 60s, mute a
 *      conversation entirely (the runaway-loop safety net).
 *   7. `decideInbound`             — the gating brain that ties them together.
 *
 * Constants are kept byte-faithful to the upstream so the dedupe windows behave
 * identically.
 */

import { createHash } from "node:crypto";

/* ───────────────────────── notification parse ───────────────────────── */

/** One raw inbound attachment as reported by the bridge. */
export interface IMessageRawAttachment {
	original_path?: string | null;
	mime_type?: string | null;
	missing?: boolean | null;
}

/** The `message` field carried by an inbound notification (all fields optional). */
export interface IMessagePayload {
	id?: number | null;
	guid?: string | null;
	chat_id?: number | null;
	sender?: string | null;
	destination_caller_id?: string | null;
	is_from_me?: boolean | null;
	text?: string | null;
	reply_to_id?: number | string | null;
	reply_to_text?: string | null;
	reply_to_sender?: string | null;
	created_at?: string | null;
	attachments?: IMessageRawAttachment[] | null;
	chat_identifier?: string | null;
	chat_guid?: string | null;
	chat_name?: string | null;
	participants?: string[] | null;
	is_group?: boolean | null;
}

/** Read a protobuf varint at `offset`; returns the value + the next offset. */
function readVarint(buf: Buffer, offset: number): { value: number; nextOffset: number } | null {
	let value = 0;
	let shift = 0;
	let pos = offset;
	while (pos < buf.length && shift <= 28) {
		const byte = buf[pos] ?? 0;
		value |= (byte & 0x7f) << shift;
		pos += 1;
		if ((byte & 0x80) === 0) return { value: value >>> 0, nextOffset: pos };
		shift += 7;
	}
	return null;
}

/**
 * Strip a protobuf field-1 length-prefixed UTF-8 wrapper (tag `0x0a` + varint
 * length + bytes) when the declared length consumes EXACTLY to the buffer end.
 * Returns the inner string, or the original text unchanged.
 */
export function stripLengthPrefixedText(text: string): string {
	const src = text ?? "";
	if (!src) return src;
	const buf = Buffer.from(src, "utf8");
	if (buf.length < 2 || buf[0] !== 0x0a) return src;
	const len = readVarint(buf, 1);
	if (!len || len.value === 0) return src;
	if (len.nextOffset + len.value !== buf.length) return src;
	const inner = buf.subarray(len.nextOffset).toString("utf8");
	return inner.length > 0 ? inner : src;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return Boolean(v) && typeof v === "object";
}

/**
 * Parse an inbound notification's `params` (`{ message: {...} }`) into a typed
 * payload. Returns null when the shape is malformed (the caller drops it).
 */
export function parseIMessageNotification(raw: unknown): IMessagePayload | null {
	if (!isRecord(raw)) return null;
	const message = raw.message;
	if (!isRecord(message)) return null;
	const out: IMessagePayload = {};
	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
	out.id = num(message.id);
	out.guid = str(message.guid);
	out.chat_id = num(message.chat_id);
	out.sender = str(message.sender);
	out.destination_caller_id = str(message.destination_caller_id);
	out.is_from_me = bool(message.is_from_me);
	const text = str(message.text);
	out.text = text !== undefined ? stripLengthPrefixedText(text) : undefined;
	if (typeof message.reply_to_id === "number" || typeof message.reply_to_id === "string") {
		out.reply_to_id = message.reply_to_id;
	}
	const replyText = str(message.reply_to_text);
	out.reply_to_text = replyText !== undefined ? stripLengthPrefixedText(replyText) : undefined;
	out.reply_to_sender = str(message.reply_to_sender);
	out.created_at = str(message.created_at);
	out.chat_identifier = str(message.chat_identifier);
	out.chat_guid = str(message.chat_guid);
	out.chat_name = str(message.chat_name);
	out.is_group = bool(message.is_group);
	if (Array.isArray(message.attachments)) out.attachments = message.attachments as IMessageRawAttachment[];
	if (Array.isArray(message.participants)) out.participants = message.participants.filter((p): p is string => typeof p === "string");
	return out;
}

/* ───────────────────────── normalized inbound ───────────────────────── */

/** A normalized inbound iMessage (pre-adapter shape). */
export interface NormalizedIMessage {
	conversationId: string;
	messageId?: string;
	from: string;
	fromName?: string;
	text: string;
	isGroup: boolean;
	chatId?: number;
	chatGuid?: string;
	chatIdentifier?: string;
	createdAtMs?: number;
	replyTo?: { messageId?: string; body?: string; from?: string };
	attachments?: IMessageRawAttachment[];
	/**
	 * Handles mentioned in this message. iMessage has no @-mention metadata, so
	 * this is populated only for a GROUP message when the bot's own `selfHandle`
	 * appears in the text — which is what lets the central pipeline's group
	 * requireMention gate fire. Unset when there's no match (or in DMs).
	 */
	mentions?: string[];
	raw: IMessagePayload;
}

/**
 * Detect whether the bot's own `selfHandle` is named in `text`. iMessage carries
 * no @-mention metadata, so "mention" = the handle appearing in the message body.
 * A phone handle matches on its digit-run inside the text's digits; an email
 * matches case-insensitively. `selfHandle` is expected pre-normalised (digits for
 * a phone, lower-case for an email — see `normalizeIMessageSelfHandle`). Returns
 * the matched self handle in an array, or undefined when there's no match (so the
 * field stays unset). Mirrors BlueBubbles' `detectBlueBubblesMentions`.
 */
export function detectIMessageMentions(text: string, selfHandle: string | undefined): string[] | undefined {
	const handle = (selfHandle ?? "").trim();
	if (!handle || !text) return undefined;
	if (handle.includes("@")) {
		return text.toLowerCase().includes(handle.toLowerCase()) ? [handle] : undefined;
	}
	// Phone: compare digit-runs so "+1 (555) 123-4567" in text matches "15551234567".
	const handleDigits = handle.replace(/[^0-9]/g, "");
	if (handleDigits.length >= 5 && text.replace(/[^0-9]/g, "").includes(handleDigits)) return [handle];
	return undefined;
}

/** Build the stable conversation id for a payload (group → chat scope, DM → sender). */
export function conversationIdFor(payload: IMessagePayload): string {
	if (typeof payload.chat_id === "number") return `chat:${payload.chat_id}`;
	if (payload.chat_guid) return `chat_guid:${payload.chat_guid}`;
	if (payload.chat_identifier) return `chat_identifier:${payload.chat_identifier}`;
	return (payload.sender ?? "").trim();
}

/**
 * Normalize a parsed payload into the inbound shape. When `selfHandle` is given
 * and this is a GROUP message naming the bot, `mentions[]` is populated so the
 * central group requireMention gate can fire.
 */
export function normalizeIMessageMessage(payload: IMessagePayload, selfHandle?: string): NormalizedIMessage {
	const isGroup = Boolean(payload.is_group) || typeof payload.chat_id === "number";
	const createdAtMs = payload.created_at ? Date.parse(payload.created_at) : NaN;
	const messageId = payload.guid?.trim() || (typeof payload.id === "number" ? String(payload.id) : undefined);
	const out: NormalizedIMessage = {
		conversationId: conversationIdFor(payload),
		from: (payload.sender ?? "").trim(),
		text: payload.text ?? "",
		isGroup,
		raw: payload,
	};
	if (messageId) out.messageId = messageId;
	if (typeof payload.chat_id === "number") out.chatId = payload.chat_id;
	if (payload.chat_guid) out.chatGuid = payload.chat_guid;
	if (payload.chat_identifier) out.chatIdentifier = payload.chat_identifier;
	if (payload.chat_name) out.fromName = payload.chat_name;
	if (Number.isFinite(createdAtMs)) out.createdAtMs = createdAtMs;
	if (Array.isArray(payload.attachments)) out.attachments = payload.attachments;
	if (payload.reply_to_id !== undefined && payload.reply_to_id !== null) {
		out.replyTo = {
			messageId: String(payload.reply_to_id),
			...(payload.reply_to_text ? { body: payload.reply_to_text } : {}),
			...(payload.reply_to_sender ? { from: payload.reply_to_sender } : {}),
		};
	}
	// Self-mention detection (group gating) — only meaningful in groups.
	if (isGroup) {
		const mentions = detectIMessageMentions(out.text, selfHandle);
		if (mentions) out.mentions = mentions;
	}
	return out;
}

/* ───────────────────────── echo cache (outbound → inbound) ───────────────────────── */

const SENT_MESSAGE_TEXT_TTL_MS = 4_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;

function normalizeCacheText(text: string | undefined): string | null {
	if (typeof text !== "string") return null;
	const v = text.replace(/\r\n?/g, "\n").trim();
	return v ? v : null;
}

function normalizeCacheId(id: string | undefined): string | null {
	const v = (id ?? "").trim();
	if (!v || v === "ok" || v === "unknown") return null;
	return v;
}

/**
 * Remembers every outbound send so the inbound poll can drop the echo. Keyed by
 * a per-conversation `scope`; a text match (4s) or an id match (60s) suppresses
 * the echo. Designed to degrade to a duplicate (noisy) rather than a dropped
 * real message if an echo arrives after the TTL.
 */
export class SentMessageCache {
	private readonly textCache = new Map<string, number>();
	private readonly idCache = new Map<string, number>();
	private readonly textBackedById = new Map<string, number>();

	/** Record an outbound send under `scope`. */
	remember(scope: string, sent: { text?: string; messageId?: string }): void {
		const now = Date.now();
		const text = normalizeCacheText(sent.text);
		const id = normalizeCacheId(sent.messageId);
		if (text) this.textCache.set(`${scope}:${text}`, now);
		if (id) this.idCache.set(`${scope}:${id}`, now);
		if (text && id) this.textBackedById.set(`${scope}:${text}`, now);
		this.cleanup(now);
	}

	/** True when an inbound matches a remembered outbound (an echo). */
	has(scope: string, inbound: { text?: string; messageId?: string }, skipIdShortCircuit = false): boolean {
		const now = Date.now();
		const text = normalizeCacheText(inbound.text);
		const id = normalizeCacheId(inbound.messageId);
		const textKey = text ? `${scope}:${text}` : null;
		if (id) {
			const idTs = this.idCache.get(`${scope}:${id}`);
			if (idTs !== undefined && now - idTs <= SENT_MESSAGE_ID_TTL_MS) return true;
			// Is there a text-only match whose latest send was NOT id-backed?
			let hasTextOnly = false;
			if (textKey) {
				const textTs = this.textCache.get(textKey);
				if (textTs !== undefined && now - textTs <= SENT_MESSAGE_TEXT_TTL_MS) {
					const backedTs = this.textBackedById.get(textKey);
					hasTextOnly = backedTs === undefined || textTs > backedTs;
				}
			}
			if (!skipIdShortCircuit && !hasTextOnly) return false;
		}
		if (textKey) {
			const textTs = this.textCache.get(textKey);
			if (textTs !== undefined && now - textTs <= SENT_MESSAGE_TEXT_TTL_MS) return true;
		}
		return false;
	}

	private cleanup(now: number): void {
		for (const [k, ts] of this.textCache) if (now - ts > SENT_MESSAGE_TEXT_TTL_MS) this.textCache.delete(k);
		for (const [k, ts] of this.textBackedById) if (now - ts > SENT_MESSAGE_TEXT_TTL_MS) this.textBackedById.delete(k);
		for (const [k, ts] of this.idCache) if (now - ts > SENT_MESSAGE_ID_TTL_MS) this.idCache.delete(k);
	}
}

/* ───────────────────────── self-chat cache ───────────────────────── */

const SELF_CHAT_TTL_MS = 10_000;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

/**
 * Catches a self-chat message that arrives once as `is_from_me=true` and is then
 * reflected as a second `is_from_me=false` row. Keyed on `scope:createdAt:hash`
 * so it only fires when BOTH text and a timestamp anchor the same message.
 */
export class SelfChatCache {
	private readonly cache = new Map<string, number>();
	private lastCleanup = 0;

	private buildKey(scope: string, text: string, createdAtMs?: number): string | null {
		const t = normalizeCacheText(text);
		if (!t || typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return null;
		const hash = createHash("sha256").update(t).digest("hex");
		return `${scope}:${createdAtMs}:${hash}`;
	}

	remember(scope: string, text: string, createdAtMs?: number): void {
		const key = this.buildKey(scope, text, createdAtMs);
		if (!key) return;
		this.cache.set(key, Date.now());
		this.maybeCleanup();
	}

	has(scope: string, text: string, createdAtMs?: number): boolean {
		const key = this.buildKey(scope, text, createdAtMs);
		if (!key) return false;
		const ts = this.cache.get(key);
		return ts !== undefined && Date.now() - ts <= SELF_CHAT_TTL_MS;
	}

	private maybeCleanup(): void {
		const now = Date.now();
		if (now - this.lastCleanup < CLEANUP_MIN_INTERVAL_MS) return;
		this.lastCleanup = now;
		for (const [k, ts] of this.cache) if (now - ts > SELF_CHAT_TTL_MS) this.cache.delete(k);
		while (this.cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}
}

/* ───────────────────────── reflection guard ───────────────────────── */

const REFLECTION_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
	{ label: "internal-separator", re: /(?:#\+){2,}#?/ },
	{ label: "assistant-role-marker", re: /\bassistant\s+to\s*=\s*\w+/i },
	{ label: "thinking-tag", re: /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/i },
	{ label: "relevant-memories-tag", re: /<\s*\/?\s*relevant[-_]memories\b[^<>]*>/i },
	{ label: "final-tag", re: /<\s*\/?\s*final\b[^<>]*>/i },
];

/** A `[start, end)` byte-index span of fenced or inline code inside a string. */
interface CodeRegion {
	start: number;
	end: number;
}

/**
 * Find the code regions (fenced ``` / ~~~ blocks + inline backtick spans) in
 * `text`. A reflection match that falls INSIDE one of these is a legit quoted
 * sample, not a leaked assistant marker, so the guard ignores it. Ported byte-
 * faithfully from the upstream `findCodeRegions`.
 */
export function findCodeRegions(text: string): CodeRegion[] {
	const regions: CodeRegion[] = [];

	const fencedRe = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2|$)/g;
	for (const match of text.matchAll(fencedRe)) {
		const start = (match.index ?? 0) + (match[1]?.length ?? 0);
		regions.push({ start, end: start + match[0].length - (match[1]?.length ?? 0) });
	}

	const inlineRe = /`+[^`]+`+/g;
	for (const match of text.matchAll(inlineRe)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		const insideFenced = regions.some((r) => start >= r.start && end <= r.end);
		if (!insideFenced) regions.push({ start, end });
	}

	regions.sort((a, b) => a.start - b.start);
	return regions;
}

/** True when byte-index `pos` falls inside one of the code regions. */
export function isInsideCode(pos: number, regions: CodeRegion[]): boolean {
	return regions.some((r) => pos >= r.start && pos < r.end);
}

/** True when `re` matches `text` at a position OUTSIDE every code region. */
function hasMatchOutsideCode(text: string, re: RegExp): boolean {
	const codeRegions = findCodeRegions(text);
	const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	for (const match of text.matchAll(globalRe)) {
		const start = match.index ?? -1;
		if (start >= 0 && !isInsideCode(start, codeRegions)) return true;
	}
	return false;
}

/**
 * Detect inbound text carrying assistant-internal markers (outbound metadata
 * that leaked into the channel and bounced back). Returns the matched labels.
 *
 * A marker that appears INSIDE a fenced/inline code span is a legitimately
 * quoted code sample (e.g. someone pasting `<final>` inside a ``` fence) and is
 * NOT treated as a reflection — only matches OUTSIDE code count.
 */
export function detectReflectedContent(text: string): { isReflection: boolean; matchedLabels: string[] } {
	const src = text ?? "";
	if (!src.trim()) return { isReflection: false, matchedLabels: [] };
	const matchedLabels: string[] = [];
	for (const { label, re } of REFLECTION_PATTERNS) {
		if (hasMatchOutsideCode(src, re)) matchedLabels.push(label);
	}
	return { isReflection: matchedLabels.length > 0, matchedLabels };
}

/* ───────────────────────── loop rate limiter ───────────────────────── */

const LOOP_WINDOW_MS = 60_000;
const LOOP_MAX_HITS = 5;
const LOOP_CLEANUP_INTERVAL_MS = 120_000;

/**
 * Per-conversation sliding-window counter. After {@link LOOP_MAX_HITS} loop
 * drops within {@link LOOP_WINDOW_MS}, the conversation is rate-limited (muted)
 * — the runaway-loop safety net.
 */
export class LoopRateLimiter {
	private readonly hits = new Map<string, number[]>();
	private lastCleanup = 0;

	record(key: string): void {
		const arr = this.hits.get(key) ?? [];
		arr.push(Date.now());
		this.hits.set(key, arr);
		this.cleanup();
	}

	isRateLimited(key: string): boolean {
		const now = Date.now();
		const recent = (this.hits.get(key) ?? []).filter((ts) => now - ts <= LOOP_WINDOW_MS);
		this.hits.set(key, recent);
		return recent.length >= LOOP_MAX_HITS;
	}

	private cleanup(): void {
		const now = Date.now();
		if (now - this.lastCleanup < LOOP_CLEANUP_INTERVAL_MS) return;
		this.lastCleanup = now;
		for (const [k, arr] of this.hits) {
			const recent = arr.filter((ts) => now - ts <= LOOP_WINDOW_MS);
			if (recent.length === 0) this.hits.delete(k);
			else this.hits.set(k, recent);
		}
	}
}

/* ───────────────────────── gating brain ───────────────────────── */

/** The dedupe/gating resources a monitor holds (one set per started account). */
export interface MonitorState {
	sentMessageCache: SentMessageCache;
	selfChatCache: SelfChatCache;
	loopRateLimiter: LoopRateLimiter;
}

/** Build a fresh monitor state. */
export function createMonitorState(): MonitorState {
	return {
		sentMessageCache: new SentMessageCache(),
		selfChatCache: new SelfChatCache(),
		loopRateLimiter: new LoopRateLimiter(),
	};
}

/** Build the echo/rate-limit scope for a payload. */
/**
 * Canonical form of an iMessage handle, for keys that must agree across the
 * inbound and outbound paths.
 *
 * The echo cache is keyed by scope, and the scope embeds the handle. Inbound
 * takes it from the Messages DB (`sender`), outbound from whatever the caller
 * addressed (`conversationId`) — and the two spell the same person differently
 * all the time: `Name@Example.com` vs `name@example.com`, `+1 (646) 420-1739`
 * vs `+16464201739`. An unnormalised key means the scopes disagree, the echo is
 * never found, and Brigade re-ingests its own message.
 *
 * Lower-cases, and for anything phone-shaped keeps only digits and a leading
 * `+`. Deliberately conservative: an address it does not recognise is passed
 * through trimmed and lower-cased rather than mangled.
 */
export function normalizeHandle(raw: string | undefined | null): string {
	const t = (raw ?? "").trim();
	if (!t) return "";
	// Phone-shaped: digits, spaces, and the usual punctuation. Emails always
	// contain `@`, so they can never match this.
	if (/^\+?[\d\s().-]+$/.test(t)) {
		const digits = t.replace(/[^\d]/g, "");
		return digits ? `${t.trimStart().startsWith("+") ? "+" : ""}${digits}` : t.toLowerCase();
	}
	return t.toLowerCase();
}

export function echoScope(accountId: string, payload: IMessagePayload): string {
	if (typeof payload.chat_id === "number") return `${accountId}:chat_id:${payload.chat_id}`;
	return `${accountId}:imessage:${normalizeHandle(payload.sender)}`;
}

/** The decision returned by {@link decideInbound}. */
export type InboundDecision =
	| { kind: "drop"; reason: string }
	| { kind: "dispatch"; message: NormalizedIMessage };

/**
 * The gating brain: parse → normalize → self-echo / self-chat / reflection
 * dedupe → loop rate-limit. Pure given the (mutable) {@link MonitorState}.
 * Loop-related drops feed the rate limiter; a rate-limited conversation drops a
 * dispatch before it fires.
 */
export function decideInbound(
	state: MonitorState,
	accountId: string,
	payload: IMessagePayload,
	selfHandle?: string,
): InboundDecision {
	const sender = (payload.sender ?? "").trim();
	if (!sender && typeof payload.chat_id !== "number") return { kind: "drop", reason: "missing sender" };

	const scope = echoScope(accountId, payload);
	const rateKey =
		typeof payload.chat_id === "number" ? `${accountId}:group:${payload.chat_id}` : `${accountId}:dm:${sender}`;
	const text = payload.text ?? "";
	const inboundIds = [
		...(typeof payload.id === "number" ? [String(payload.id)] : []),
		...(payload.guid ? [payload.guid] : []),
	];
	const hasGuid = Boolean(payload.guid);

	// Self-chat detection (DM only).
	const senderNorm = sender.toLowerCase();
	const chatIdentNorm = (payload.chat_identifier ?? "").trim().toLowerCase();
	const destNorm = (payload.destination_caller_id ?? "").trim().toLowerCase();
	// The bot's OWN handle, when the operator configured one. It is the only
	// signal that identifies a self-thread without depending on the Messages DB
	// populating `destination_caller_id` — which it frequently does not.
	const selfNorm = (selfHandle ?? "").trim().toLowerCase();
	const looksSelfAddressed = !payload.is_group && senderNorm !== "" && senderNorm === chatIdentNorm;
	const isSelfChat =
		looksSelfAddressed && (destNorm === senderNorm || (selfNorm !== "" && senderNorm === selfNorm));
	const isAmbiguousSelf = looksSelfAddressed && destNorm === "" && !isSelfChat;

	let skipSelfChatHasCheck = false;
	if (payload.is_from_me === true) {
		if (isAmbiguousSelf) {
			// AN AMBIGUOUS SELF-THREAD IS STILL A SELF-THREAD.
			//
			// This dropped unconditionally, and that silently disabled the whole
			// channel for the most obvious way to try it: message your own Apple
			// ID. In a self-thread EVERY message is `is_from_me=true` — the
			// operator's replies included — and `destination_caller_id` is often
			// empty in the Messages DB, so the definite-self branch below never
			// fired and every genuine reply was discarded as "from me". The
			// operator sees their message delivered and Brigade never answers.
			//
			// The echo cache is exactly the discriminator this needs, and the
			// definite-self branch already trusts it: a message Brigade sent is in
			// the sent cache, a message the operator typed is not. Treating the
			// ambiguous case the same way makes the channel work while keeping the
			// loop guard, with the rate limiter as the backstop it already was.
			state.selfChatCache.remember(scope, text, payload.created_at ? Date.parse(payload.created_at) : undefined);
			const echo = state.sentMessageCache.has(scope, { text, messageId: inboundIds[0] }, !hasGuid);
			if (echo) {
				state.loopRateLimiter.record(rateKey);
				return { kind: "drop", reason: "agent echo in self-chat" };
			}
			skipSelfChatHasCheck = true;
		} else if (isSelfChat) {
			state.selfChatCache.remember(scope, text, payload.created_at ? Date.parse(payload.created_at) : undefined);
			const echo = state.sentMessageCache.has(scope, { text, messageId: inboundIds[0] }, !hasGuid);
			if (echo) {
				state.loopRateLimiter.record(rateKey);
				return { kind: "drop", reason: "agent echo in self-chat" };
			}
			skipSelfChatHasCheck = true;
		} else {
			state.loopRateLimiter.record(rateKey);
			return { kind: "drop", reason: "from me" };
		}
	}

	if (payload.is_group && typeof payload.chat_id !== "number") {
		return { kind: "drop", reason: "group without chat_id" };
	}

	if (!text.trim() && !(Array.isArray(payload.attachments) && payload.attachments.length > 0)) {
		return { kind: "drop", reason: "empty body" };
	}

	// Self-chat reflection check.
	if (!skipSelfChatHasCheck) {
		const createdAtMs = payload.created_at ? Date.parse(payload.created_at) : undefined;
		if (state.selfChatCache.has(scope, text, createdAtMs)) {
			state.loopRateLimiter.record(rateKey);
			return { kind: "drop", reason: "self-chat echo" };
		}
	}

	// General echo check.
	const echoMatch =
		inboundIds.some((id) => state.sentMessageCache.has(scope, { messageId: id })) ||
		state.sentMessageCache.has(scope, { text, messageId: inboundIds[0] }, !hasGuid);
	if (echoMatch) {
		state.loopRateLimiter.record(rateKey);
		return { kind: "drop", reason: "echo" };
	}

	// Reflection guard.
	if (detectReflectedContent(text).isReflection) {
		state.loopRateLimiter.record(rateKey);
		return { kind: "drop", reason: "reflected assistant content" };
	}

	// Loop rate-limit safety net.
	if (state.loopRateLimiter.isRateLimited(rateKey)) {
		return { kind: "drop", reason: "loop rate-limited" };
	}

	return { kind: "dispatch", message: normalizeIMessageMessage(payload, selfHandle) };
}
