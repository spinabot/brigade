/**
 * Pure extractors that turn a Slack Events-API event payload into the
 * normalized fields Brigade's `InboundMessage` carries. No network, no side
 * effects — every function here is deterministic over its event argument so
 * they're trivial to unit-test without a live workspace.
 *
 * Slack's wire shape differs from Telegram's in load-bearing ways, so the logic
 * is a Brigade-native re-implementation that models the SHAPE of
 * `telegram/inbound-extras.ts` (raw event → normalized signals) while speaking
 * Slack semantics:
 *
 *   - Text arrives as `event.text` peppered with Slack mention/link TOKENS:
 *     `<@U123>` (user), `<#C123|name>` (channel), `<https://x|label>` (link),
 *     `<!here>` / `<!subteam^S1|@team>` (special). {@link extractSlackText}
 *     expands those into readable plain text the agent can parse.
 *   - The bot is "addressed" when its own `user_id` appears as a `<@Uxxx>`
 *     mention (or the event is an `app_mention`). {@link extractSlackMentions}
 *     surfaces the bot's id when addressed so the central group ACL admits the
 *     message — exactly as Telegram surfaces the bot's numeric id.
 *   - Channel kind is read from `event.channel_type` (`im` → direct;
 *     `mpim`/`channel`/`group` → group), see {@link slackChannelType}.
 *   - Threads ride on `thread_ts`; a reply quotes its parent.
 *   - Files arrive as `event.files[]` (each a `url_private` + metadata); the
 *     connection layer DEFERS the byte download until the access gate admits
 *     the sender (mirrors Telegram's deferred-media discipline).
 *
 * Brigade's CENTRAL inbound pipeline owns the actual ACL / mention / routing
 * decision — these helpers only surface the raw signals it reads (`mentions`,
 * `threadId`, `replyTo`, chat type).
 */

import type { InboundReplyContext } from "../sdk.js";

/* ───────────────────────── event shapes (the subset Brigade reads) ───────────────────────── */

/** One file object Slack attaches to a message event (the subset we read). */
export interface SlackFileObject {
	id?: string;
	name?: string;
	title?: string;
	mimetype?: string;
	filetype?: string;
	/** Authenticated download URL — requires `Authorization: Bearer <botToken>`. */
	url_private?: string;
	url_private_download?: string;
	size?: number;
	/** Slack marks a file `mode: "tombstone"` when it was deleted / is unavailable. */
	mode?: string;
}

/**
 * A Slack message event (the `message` / `app_mention` family). Only the fields
 * Brigade consumes are typed; the raw event carries far more. `subtype`
 * discriminates edits (`message_changed`), deletes (`message_deleted`), and the
 * many bot/system message variants we filter out.
 */
export interface SlackMessageEvent {
	type?: string;
	subtype?: string;
	/** Sender user id (`U…` / `W…`). Absent on some system subtypes. */
	user?: string;
	/** Bot id when the message was posted by a bot integration (not a user). */
	bot_id?: string;
	text?: string;
	/** Channel id (`C…` public, `G…` private, `D…` DM). */
	channel?: string;
	/** `im` (DM) | `mpim` (group DM) | `channel` (public) | `group` (private). */
	channel_type?: string;
	/** Message timestamp — Slack's per-message id within a channel. */
	ts?: string;
	/** Parent thread ts when this message belongs to a thread. */
	thread_ts?: string;
	/** Client-generated id — a stable dedupe key across redeliveries. */
	client_msg_id?: string;
	/**
	 * Edit stamp Slack sets on an edited message (`{ user, ts }` where `ts` is
	 * WHEN the edit happened, distinct from the message's own `ts`). Folded into
	 * the dedupe key so a SECOND edit of the same message isn't dropped.
	 */
	edited?: { ts?: string; user?: string };
	/** Files attached to the message. */
	files?: SlackFileObject[];
	/** The edited / changed message envelope (subtype `message_changed`). */
	message?: SlackMessageEvent;
	/** The prior message before an edit (subtype `message_changed`). */
	previous_message?: SlackMessageEvent;
	/** The deleted message's ts (subtype `message_deleted`). */
	deleted_ts?: string;
	[key: string]: unknown;
}

/** A Slack `reaction_added` / `reaction_removed` event (the subset we read). */
export interface SlackReactionEvent {
	type?: string;
	/** The user who added / removed the reaction. */
	user?: string;
	/** The emoji name (no colons), e.g. `thumbsup`. */
	reaction?: string;
	/** The message the reaction landed on. */
	item?: { type?: string; channel?: string; ts?: string };
	[key: string]: unknown;
}

/**
 * Reject control-byte payloads (a binary blob masquerading as text). Tab / LF /
 * CR are allowed; any other C0 control char marks the run as non-text and it's
 * dropped so the agent never ingests raw binary. Mirrors Telegram's
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

/**
 * Reverse Slack's text-node entity escaping (`&amp;` `&lt;` `&gt;`). Slack
 * escapes only those three in message text; everything else is literal. Applied
 * AFTER token expansion so the angle-bracket tokens (`<…>`) parse first.
 */
export function unescapeSlackEntities(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Expand the Slack message TOKENS in a run of text into readable plain text:
 *   - `<@U123>` / `<@U123|alex>`        → `@alex` (or `@U123` when no label)
 *   - `<#C123|general>` / `<#C123>`     → `#general` (or `#C123`)
 *   - `<!here>` / `<!channel>` / `<!everyone>` → `@here` / `@channel` / `@everyone`
 *   - `<!subteam^S1|@team>`             → `@team`
 *   - `<!date^…^fallback|link>`         → the fallback text
 *   - `<https://x|label>` / `<https://x>` → `label` (or the bare url)
 *
 * Unknown `<…>` tokens collapse to their inner display text (after `|`) or are
 * stripped of the angle brackets. Pure + deterministic.
 */
export function expandSlackTokens(text: string, resolveName?: (id: string) => string | undefined): string {
	return text.replace(/<([^>]*)>/g, (_whole, inner: string) => {
		if (!inner) return "";
		const bar = inner.indexOf("|");
		const head = bar === -1 ? inner : inner.slice(0, bar);
		const label = bar === -1 ? "" : inner.slice(bar + 1);
		const first = head[0];
		// User mention: <@U123> / <@U123|alex>
		if (first === "@") {
			const id = head.slice(1);
			// Inline label wins; else a resolved display name (from the user
			// directory, when one is supplied); else the bare id.
			if (label) return `@${label}`;
			const resolved = resolveName?.(id);
			return resolved ? `@${resolved}` : `@${id}`;
		}
		// Channel mention: <#C123|general> / <#C123>
		if (first === "#") {
			const id = head.slice(1);
			return label ? `#${label}` : `#${id}`;
		}
		// Special mention / subteam / date: <!here> / <!subteam^S1|@team> / <!date^…|link>
		if (first === "!") {
			const body = head.slice(1);
			if (label) return label.startsWith("@") ? label : `@${label}`;
			// <!here> / <!channel> / <!everyone> → @here etc.; <!subteam^S1> → @team-ish
			const name = body.split("^")[0] ?? body;
			return `@${name}`;
		}
		// Link: <https://x|label> / <mailto:a@b|a@b> / <https://x>
		return label || head;
	});
}

/**
 * The agent-facing plain text of a Slack message. Token-expanded (mentions /
 * channels / links → readable text) then entity-unescaped. A `message_changed`
 * envelope surfaces the EDITED text (`event.message.text`). Binary blobs are
 * dropped to "".
 */
export function extractSlackText(event: SlackMessageEvent, resolveName?: (id: string) => string | undefined): string {
	// An edit (message_changed) carries the new text on the nested `message`.
	const source = event.subtype === "message_changed" && event.message ? event.message : event;
	const raw = typeof source.text === "string" ? source.text : "";
	if (!raw || isBinaryContent(raw)) return "";
	return unescapeSlackEntities(expandSlackTokens(raw, resolveName)).trim();
}

/** Slack `channel_type` → Brigade chat type. `im` → direct; everything else → group. */
export function slackChannelType(event: Pick<SlackMessageEvent, "channel_type" | "channel">): "direct" | "group" {
	const t = typeof event.channel_type === "string" ? event.channel_type : "";
	if (t === "im") return "direct";
	if (t === "mpim" || t === "channel" || t === "group") return "group";
	// Fall back to the channel-id prefix when `channel_type` was omitted: a `D…`
	// id is a DM, anything else is a multi-party room.
	const ch = typeof event.channel === "string" ? event.channel : "";
	return ch.startsWith("D") ? "direct" : "group";
}

/** Thread parent ts as a string, when the message belongs to a thread. */
export function slackThreadId(event: Pick<SlackMessageEvent, "thread_ts">): string | undefined {
	const ts = event.thread_ts;
	return typeof ts === "string" && ts ? ts : undefined;
}

/**
 * Channel-native ids of accounts addressed in this message. Brigade's central
 * group ACL treats a group message as "addressed to the bot" when the bot's own
 * id appears in `mentions`; without this a group message never reaches the
 * agent. So when the bot's own `<@Uxxx>` mention appears in the text — OR the
 * event is an `app_mention` (Slack's dedicated "the bot was @-mentioned" event)
 * — we surface the bot's user id (passed in from `auth.test`). Every OTHER
 * `<@Uxxx>` user mention is surfaced too so the pipeline sees who else was
 * tagged.
 *
 * @param botUserId the bot's own user id (from `auth.test`), surfaced when the
 *                  bot is @-mentioned so the ACL admits the group message.
 */
export function extractSlackMentions(event: SlackMessageEvent, botUserId?: string): string[] {
	const source = event.subtype === "message_changed" && event.message ? event.message : event;
	const text = typeof source.text === "string" ? source.text : "";
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (id: string | undefined) => {
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push(id);
	};

	let botMentioned = event.type === "app_mention";
	// Scan every <@U…> / <@U…|label> user-mention token in the text.
	const re = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const id = m[1];
		if (!id) continue;
		if (botUserId && id === botUserId) {
			botMentioned = true;
			continue; // the bot's own id is pushed last (after the addressed check)
		}
		push(id);
	}

	if (botMentioned && botUserId) push(botUserId);
	return out;
}

/**
 * A short display name for the sender. A legacy bot-posted `username` wins; else
 * a resolved display name (when a `resolveName` reader from the user directory is
 * supplied AND it has already cached the sender's name); else the raw user id
 * (`U…`) — display-name resolution needs a `users.info` call that the directory
 * primes in the background, so the first message from a never-seen user surfaces
 * the id and later messages surface the name.
 */
export function buildSlackSenderName(
	event: SlackMessageEvent,
	resolveName?: (id: string) => string | undefined,
): string | undefined {
	const source = event.subtype === "message_changed" && event.message ? event.message : event;
	const username = typeof source["username"] === "string" ? (source["username"] as string) : "";
	if (username) return username;
	const user = typeof source.user === "string" ? source.user : "";
	if (user) {
		const resolved = resolveName?.(user);
		if (resolved) return resolved;
	}
	return user || undefined;
}

/**
 * Reply-context (what message this inbound quotes), when it's a threaded reply.
 * Slack threads are flat — a reply carries `thread_ts` (the parent's ts) but the
 * event does NOT inline the parent's text — so the context surfaces the parent
 * message id (`thread_ts`) and leaves `body` undefined (the pipeline can fetch
 * the parent if it needs the excerpt). Returns undefined for a top-level
 * message (no `thread_ts`, or `thread_ts === ts` which is the thread ROOT, not a
 * reply).
 */
export function extractSlackReplyContext(event: SlackMessageEvent): InboundReplyContext | undefined {
	const source = event.subtype === "message_changed" && event.message ? event.message : event;
	const threadTs = source.thread_ts;
	const ts = source.ts;
	if (typeof threadTs !== "string" || !threadTs) return undefined;
	// The thread ROOT carries thread_ts === ts; only a genuine reply quotes a
	// DIFFERENT parent.
	if (typeof ts === "string" && ts === threadTs) return undefined;
	return { messageId: threadTs };
}

/* ───────────────────────── media detection ───────────────────────── */

/** A downloadable file is one with a private url that isn't a tombstone (deleted). */
function isDownloadableFile(f: SlackFileObject): boolean {
	if (!f || f.mode === "tombstone") return false;
	return Boolean(f.url_private || f.url_private_download);
}

/**
 * Cheap presence probe — does this message carry a downloadable file? Walks
 * `event.files[]` (an edit reads the nested message's files) but never touches
 * the network, so the connection layer can DEFER the actual download until AFTER
 * the central access gate admits the sender (mirrors Telegram's deferred-media
 * discipline). Mirrors `hasInboundMedia`.
 */
export function hasInboundMedia(event: SlackMessageEvent): boolean {
	const source = event.subtype === "message_changed" && event.message ? event.message : event;
	const files = Array.isArray(source.files) ? source.files : [];
	return files.some(isDownloadableFile);
}

/** The list of downloadable files on a message (an edit reads the nested message). */
export function resolveInboundFiles(event: SlackMessageEvent): SlackFileObject[] {
	const source = event.subtype === "message_changed" && event.message ? event.message : event;
	const files = Array.isArray(source.files) ? source.files : [];
	return files.filter(isDownloadableFile);
}

/** The Brigade media-kind of a Slack file, from its mimetype / filetype. */
export function resolveSlackFileKind(
	f: SlackFileObject,
): "image" | "video" | "audio" | "voice" | "document" {
	const mime = (f.mimetype ?? "").toLowerCase();
	const type = (f.filetype ?? "").toLowerCase();
	if (mime.startsWith("image/") || /^(png|jpg|jpeg|gif|webp|bmp|heic)$/.test(type)) return "image";
	if (mime.startsWith("video/") || /^(mp4|mov|webm|mkv|avi)$/.test(type)) return "video";
	// Slack voice memos arrive as audio with a dedicated subtype; treat m4a/ogg
	// voice-ish containers as "voice", other audio as "audio".
	if (mime.startsWith("audio/") || /^(mp3|m4a|ogg|wav|flac|aac)$/.test(type)) {
		return type === "m4a" || type === "ogg" ? "voice" : "audio";
	}
	return "document";
}
