/**
 * Telegram Bot API connection (grammY long-polling).
 *
 * The Brigade analogue of `whatsapp/connection.ts`, distilled from the
 * reference Telegram polling session. grammY + its runner + the throttler transformer are
 * HEAVY and only needed when a Telegram channel actually starts, so they are
 * lazy-imported here (`await import("grammy")` inside `connectTelegram`) — a
 * non-Telegram boot never pays for them. Types are `type`-only so the static
 * import never pulls the runtime in.
 *
 * Lifecycle:
 *   - `deleteWebhook({ drop_pending_updates: false })` is called BEFORE polling.
 *     If a webhook was ever set on this bot, `getUpdates` returns 409 forever
 *     and the bot silently "receives nothing" — clearing it first is the #1 fix.
 *   - `getMe` caches the bot's numeric id + @username (the group ACL needs the
 *     username to detect @-mentions; without it group messages never reach the
 *     agent).
 *   - `bot.on("message")` normalizes each update into a `TgInboundMessage` and
 *     hands it to `onMessage` with a DEFERRED `resolveMedia` thunk — bytes are
 *     downloaded only after the central access gate admits the sender (mirrors
 *     WhatsApp).
 *   - The grammY runner drives `getUpdates`; `apiThrottler()` rate-limits the
 *     outbound API.
 *   - Reconnect backoff COPIES WhatsApp's constants (2s → 30s, ×1.8, ±25%).
 *   - 401 Unauthorized → sticky `tokenInvalid` (terminal; the only fix is a new
 *     token — stop polling).
 *   - 409 Conflict (getUpdates) → another poller/webhook is live: clear the
 *     webhook and restart ONCE, then fall back to normal backoff.
 *   - Updates are de-duplicated by `update_id` (a redelivered update after a
 *     restart must not double-run the agent).
 *
 * Scope cut (v1): `callback_query` (inline-button taps) is intentionally NOT
 * subscribed — Brigade's approvals are central TEXT replies handled in
 * `inbound-pipeline.ts`, so `allowed_updates` only needs message updates.
 */

import {
	chunkText,
	createDedupeCache,
	nextBackoffDelay,
	type InboundForwardContext,
	type InboundMediaAttachment,
	type InboundReplyContext,
	type OutboundMedia,
} from "../sdk.js";
import { maskProxyUrl } from "./account-config.js";
import { splitTelegramCaption, TELEGRAM_CAPTION_LIMIT } from "./format.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { buildSocksDispatcher, isSocksProxyScheme } from "./socks-dispatcher.js";
import {
	buildTelegramSenderName,
	extractTelegramForwardContext,
	extractTelegramMentions,
	extractTelegramReplyContext,
	extractTelegramText,
	hasInboundMedia,
	resolveInboundMediaFileId,
	resolveInboundMediaKind,
	telegramChatType,
	telegramThreadId,
} from "./inbound-extras.js";
import { downloadTelegramMedia } from "./media.js";

import type { Message, Update } from "@grammyjs/types";

// All contract types — `OutboundMedia`, `InboundMediaAttachment`,
// `InboundReplyContext` — now come from the channel SDK barrel (imported above),
// so this channel is built entirely on `../sdk.js`.

/* ───────────────────────── reconnect backoff ───────────────────────── */
// Shares the neutral `nextBackoffDelay` curve with every other channel (see
// `channels/backoff.ts`), tuned to the same schedule WhatsApp uses (2s → 30s,
// ×1.8, ±25%). The constants live here so Telegram owns its own knobs; the
// arithmetic is the shared helper's.

const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

/**
 * Jittered exponential backoff for reconnect attempt `attempt` (0-based).
 * Thin wrapper over the neutral `nextBackoffDelay` helper — kept as a named
 * export so `index.ts` and the connection tests have a stable entry point.
 */
export function telegramBackoffDelay(attempt: number): number {
	return nextBackoffDelay({
		attempt,
		initialMs: RECONNECT_INITIAL_MS,
		maxMs: RECONNECT_MAX_MS,
		factor: RECONNECT_FACTOR,
		jitter: RECONNECT_JITTER,
	});
}

/** Telegram's hard limit on a single text message body (UTF-16 code units). */
const TELEGRAM_MESSAGE_LIMIT = 4096;

/* ───────────────────────── normalized inbound shape ───────────────────────── */

/** A normalized inbound Telegram message (text and/or media). */
export interface TgInboundMessage {
	/** Chat id as a string — the conversation id. */
	conversationId: string;
	/** Telegram `message_id` as a string — surfaces for reply targeting. */
	messageId?: string;
	/** When Telegram stamped the message (epoch ms). */
	messageTimestampMs?: number;
	/** Sender id within the channel — the user's numeric id as a string. */
	from: string;
	/** Sender display name (`First Last` or `@username`), when present. */
	fromName?: string;
	/** Plain message text (caption-aware, text_link-expanded). May be empty for media. */
	text: string;
	/** `direct` (private) or `group` (group/supergroup). */
	chatType: "direct" | "group";
	/** Forum-topic / thread id (`message_thread_id`) as a string, when present. */
	threadId?: string;
	/** Numeric ids of @-mentioned accounts (incl. the bot's own id when addressed). */
	mentions?: string[];
	/** Quoted-reply context, when this message replies to another. */
	replyTo?: InboundReplyContext;
	/**
	 * DEFERRED media download. The connection layer does NOT download eagerly —
	 * the pipeline invokes this ONLY after the access gate admits the sender, so
	 * a blocked stranger's group video is never fetched. Resolves to an empty
	 * array for text-only messages.
	 */
	resolveMedia?: () => Promise<InboundMediaAttachment[]>;
	/**
	 * Inline-button callback context — present ONLY when this inbound is a
	 * `callback_query` (a button press) rather than a typed message. `data` is
	 * the opaque payload the pressed button declared at send time (an
	 * approval-callback codec string); `callbackId` is the Telegram
	 * `callback_query.id` used to `answerCallbackQuery`. Undefined for ordinary
	 * messages. The central pipeline routes a present `callbackQuery` to the
	 * approval-callback path.
	 */
	callbackQuery?: { data: string; callbackId: string };
	/** True when this inbound is an `edited_message` (text carries the NEW text). */
	edited?: boolean;
	/** Forwarded-message provenance, when this message was forwarded from elsewhere. */
	forwarded?: InboundForwardContext;
	/**
	 * Inbound reaction context — present ONLY when this inbound is a
	 * `message_reaction` update (not a typed message). `emojis` are the newly-
	 * ADDED reaction emoji(s); `targetMessageId` is the message they landed on.
	 */
	reaction?: { emojis: string[]; targetMessageId: string };
	/** Raw grammY message (for adapters that need more). */
	raw: Message;
}

/* ───────────────────────── injectable grammY surface ───────────────────────── */

/**
 * The minimal slice of grammY's `Bot` the connection drives. Declared as an
 * interface (rather than importing grammY's concrete `Bot`) so tests can inject
 * a fake bot with zero network — the runtime path builds a real grammY `Bot`
 * and it structurally satisfies this shape.
 */
export interface TelegramBotLike {
	api: {
		getMe(): Promise<TelegramBotIdentity>;
		deleteWebhook(opts?: { drop_pending_updates?: boolean }): Promise<boolean>;
		/** Register a webhook (webhook transport mode). */
		setWebhook?(url: string, opts?: Record<string, unknown>): Promise<boolean>;
		sendMessage(chatId: string | number, text: string, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		sendChatAction(chatId: string | number, action: string, opts?: Record<string, unknown>): Promise<boolean>;
		setMessageReaction?(chatId: string | number, messageId: number, reaction: unknown, opts?: Record<string, unknown>): Promise<boolean>;
		getFile(fileId: string): Promise<{ file_path?: string; file_unique_id?: string; file_size?: number }>;
		sendPhoto?(chatId: string | number, photo: unknown, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		sendVideo?(chatId: string | number, video: unknown, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		sendAudio?(chatId: string | number, audio: unknown, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		sendVoice?(chatId: string | number, voice: unknown, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		sendDocument?(chatId: string | number, document: unknown, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		sendSticker?(chatId: string | number, sticker: unknown, opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		/** Send a native poll (outbound poll support). */
		sendPoll?(chatId: string | number, question: string, options: string[], opts?: Record<string, unknown>): Promise<{ message_id: number }>;
		/** Acknowledge an inline-button press (clears the loading spinner client-side). */
		answerCallbackQuery?(callbackQueryId: string, opts?: Record<string, unknown>): Promise<boolean>;
		/** Edit a previously-sent message's text (message_action `edit`). */
		editMessageText?(chatId: string | number, messageId: number, text: string, opts?: Record<string, unknown>): Promise<unknown>;
		/** Delete a message (message_action `delete`). */
		deleteMessage?(chatId: string | number, messageId: number, opts?: Record<string, unknown>): Promise<boolean>;
		/** Pin a chat message (message_action `pin`). */
		pinChatMessage?(chatId: string | number, messageId: number, opts?: Record<string, unknown>): Promise<boolean>;
		/** Unpin a chat message (message_action `unpin`). */
		unpinChatMessage?(chatId: string | number, opts?: Record<string, unknown>): Promise<boolean>;
		/** Rename a forum topic (thread auto-labeling). */
		editForumTopic?(chatId: string | number, messageThreadId: number, opts?: Record<string, unknown>): Promise<boolean>;
		/** Create a forum topic; returns the new topic's `message_thread_id`. */
		createForumTopic?(chatId: string | number, name: string, opts?: Record<string, unknown>): Promise<{ message_thread_id: number; name?: string }>;
		/** Register the bot's `/` command menu (native command surface). */
		setMyCommands?(commands: Array<{ command: string; description: string }>, opts?: Record<string, unknown>): Promise<boolean>;
		config?: { use(transformer: unknown): void };
	};
	/**
	 * Subscribe to an update kind. The connection subscribes `"message"` for the
	 * inbound text/media path and `"callback_query"` for inline-button presses
	 * (interactive approvals). grammY's real `on` is overloaded across every
	 * filter; this minimal contract declares only the two Brigade consumes.
	 */
	on(filter: "message", handler: (ctx: { update: Update; message?: Message }) => unknown): void;
	on(
		filter: "callback_query",
		handler: (ctx: { update: Update; callbackQuery?: TelegramCallbackQuery; answerCallbackQuery: (opts?: Record<string, unknown>) => Promise<unknown> }) => unknown,
	): void;
	/** An `edited_message` update (the edit carries the new text). */
	on(filter: "edited_message", handler: (ctx: { update: Update; editedMessage?: Message }) => unknown): void;
	/** A `channel_post` update (a post in a channel the bot is admin of). */
	on(filter: "channel_post", handler: (ctx: { update: Update; channelPost?: Message }) => unknown): void;
	/** A `message_reaction` update (someone added/removed an emoji reaction). */
	on(
		filter: "message_reaction",
		handler: (ctx: { update: Update; messageReaction?: TelegramMessageReaction }) => unknown,
	): void;
	/** Stop the bot (grammY). */
	stop(): Promise<void> | void;
}

/** What `getMe` returns — the bot's identity + group/inline capability flags. */
export interface TelegramBotIdentity {
	id: number;
	username?: string;
	first_name?: string;
	can_join_groups?: boolean;
	can_read_all_group_messages?: boolean;
	supports_inline_queries?: boolean;
}

/** A Telegram `callback_query` update payload (the subset Brigade reads). */
export interface TelegramCallbackQuery {
	id: string;
	data?: string;
	from?: { id?: number; username?: string; first_name?: string; last_name?: string };
	message?: Message;
}

/** A Telegram `message_reaction` update payload (the subset Brigade reads). */
export interface TelegramMessageReaction {
	chat: { id: number | string; type?: string; title?: string; is_forum?: boolean };
	message_id: number;
	user?: { id?: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
	actor_chat?: { id?: number; title?: string; username?: string };
	date?: number;
	/** Reactions present BEFORE this update — used to diff the newly-added ones. */
	old_reaction: Array<{ type: string; emoji?: string }>;
	/** Reactions present AFTER this update. */
	new_reaction: Array<{ type: string; emoji?: string }>;
}

/** A grammY-runner-like handle (what `run(bot)` returns). */
interface RunnerLike {
	isRunning(): boolean;
	stop(): Promise<void> | void;
	task(): Promise<void>;
}

export interface ConnectTelegramArgs {
	/** Bot API token. NEVER logged (redacted in any URL). */
	token: string;
	/** Account namespace stamped on inbounds (single-account v1 → "default"). */
	accountId?: string;
	/**
	 * Optional proxy URL all Telegram API calls (incl. `getMe` + `getUpdates`)
	 * route through. Use it on networks where `api.telegram.org` is blocked.
	 * Form: `http(s)://[user:pass@]host:port` for an HTTP CONNECT proxy, or
	 * `socks5://[user:pass@]host:port` (also `socks://` / `socks4://` /
	 * `socks5h://`) for a SOCKS proxy. When omitted/empty the connection is DIRECT
	 * (unchanged default). HTTP(S) proxies use an `undici` ProxyAgent; SOCKS
	 * proxies use a SOCKS-aware `undici` Agent (see `socks-dispatcher.ts`).
	 */
	proxyUrl?: string;
	/** Called once `getMe` succeeds and polling starts. */
	onConnected?: () => void;
	/** Called when the token is rejected (401) — terminal, re-token required. */
	onTokenInvalid?: () => void;
	/** Called for every inbound message. */
	onMessage: (msg: TgInboundMessage) => void;
	/**
	 * Called for every inbound `callback_query` (inline-button press). The
	 * connection has ALREADY acked the press via `answerCallbackQuery` before
	 * this fires, so the handler only has to route the normalized inbound
	 * (which carries `callbackQuery: { data, callbackId }`). Optional — when
	 * omitted, callback updates are still acked + de-duplicated but not routed.
	 */
	onCallbackQuery?: (msg: TgInboundMessage) => void;
	/**
	 * Called for every inbound `message_reaction` (someone added an emoji
	 * reaction). The normalized inbound carries `reaction: { emojis,
	 * targetMessageId }` and no text. Optional — when omitted, reaction updates
	 * are de-duplicated but not routed.
	 */
	onReaction?: (msg: TgInboundMessage) => void;
	/**
	 * The `allowed_updates` list to request from `getUpdates`. Defaults to the
	 * minimal `["message", "callback_query"]` set (see `allowed-updates.ts`).
	 * Threaded so the adapter/plugin can widen it (e.g. inbound reactions).
	 */
	allowedUpdates?: string[];
	/**
	 * Commands to register on connect via `setMyCommands` (the bot's `/` menu).
	 * Empty / omitted → no menu sync. Re-applied on each successful (re)connect.
	 */
	commandMenu?: Array<{ command: string; description: string }>;
	/**
	 * Transport mode. `"polling"` (default) drives `getUpdates` via the runner;
	 * `"webhook"` builds the bot + (optionally) registers a webhook via
	 * `setWebhook` but does NOT poll — the gateway HTTP route feeds updates in
	 * via {@link TelegramConnection.feedUpdate}. Defaults to polling (local-first).
	 */
	mode?: "polling" | "webhook";
	/**
	 * Webhook registration details (webhook mode only). When `url` is set the
	 * connection calls `setWebhook(url, { secret_token, allowed_updates })` on
	 * connect. Omit `url` to skip registration (the operator registered it out
	 * of band) and only wire the inbound `feedUpdate` path.
	 */
	webhook?: { url?: string; secretToken?: string };
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/**
	 * TEST SEAM: supply the bot + runner instead of building real grammY ones.
	 * Production leaves this undefined and grammY is lazy-imported. When present,
	 * `botFactory(token)` returns the bot and `runnerFactory(bot)` the runner.
	 */
	botFactory?: (token: string) => TelegramBotLike;
	runnerFactory?: (bot: TelegramBotLike) => RunnerLike;
	/** TEST SEAM: skip the real backoff sleep so reconnect tests run instantly. */
	sleepImpl?: (ms: number) => Promise<void>;
}

export interface TelegramConnection {
	/** The bot's numeric id once connected, else null. */
	selfId(): string | null;
	/** The bot's @username (without `@`) once connected, else null. */
	selfUsername(): string | null;
	/** Epoch ms of the most recent successful connect, else null. */
	connectedAt(): number | null;
	/** True once `getMe` has succeeded and polling is live. */
	isConnected(): boolean;
	/** True once a 401 marked the token terminally invalid. */
	isTokenInvalid(): boolean;
	/** Send a single text message. `opts.html` true → `parse_mode: HTML`. */
	sendText(chatId: string, text: string, opts?: TelegramSendTextOpts): Promise<{ messageId: number }>;
	/**
	 * Send a text message carrying an inline keyboard (`reply_markup`). Used by
	 * the native approval prompt; `replyMarkup` is an opaque grammY-shaped
	 * `InlineKeyboardMarkup`. Text is sent verbatim (no markdown→HTML pass) so the
	 * caller controls formatting.
	 */
	sendInteractive(chatId: string, text: string, replyMarkup: unknown, opts?: TelegramSendTextOpts): Promise<{ messageId: number }>;
	/** Send a media attachment. */
	sendMedia(chatId: string, media: OutboundMedia, opts?: TelegramSendMediaOpts): Promise<void>;
	/** Send a native poll. Returns the poll message's id. */
	sendPoll(chatId: string, poll: TelegramPollSpec, opts?: TelegramSendMediaOpts): Promise<{ messageId: number }>;
	/** React to a previous message with an emoji (`""` clears). */
	react(chatId: string, messageId: string, emoji: string): Promise<void>;
	/** Edit a previously-sent message's text. `opts.html` true → `parse_mode: HTML`. */
	editMessageText(chatId: string, messageId: string, text: string, opts?: TelegramSendTextOpts): Promise<void>;
	/** Delete a message. */
	deleteMessage(chatId: string, messageId: string): Promise<void>;
	/** Pin a message (silent by default). */
	pinMessage(chatId: string, messageId: string): Promise<void>;
	/** Unpin a message (or the most recent pin when no id is given). */
	unpinMessage(chatId: string, messageId?: string): Promise<void>;
	/** Rename a forum topic (thread auto-labeling). Best-effort. */
	editForumTopic(chatId: string, threadId: string, name: string): Promise<void>;
	/**
	 * Create a forum topic in a supergroup. Returns the new topic's thread id (as
	 * a string) so the caller can immediately send into it. Throws when the bot
	 * build / chat doesn't support forum topics or the name is invalid.
	 */
	createForumTopic(chatId: string, name: string, opts?: TelegramCreateForumTopicOpts): Promise<{ threadId: string; name: string }>;
	/** Ack an inline-button press (`answerCallbackQuery`). Best-effort. */
	answerCallback(callbackId: string, text?: string): Promise<void>;
	/**
	 * Feed a raw Telegram `Update` object into the inbound path (webhook mode).
	 * Dispatches to the SAME message / callback_query handlers polling uses, so
	 * webhook + polling share one normalize + dedupe surface. No-op in polling
	 * mode is fine — the gateway route only calls this when webhook is active.
	 */
	feedUpdate(update: Update): void;
	/** The transport mode this connection runs (`"polling"` | `"webhook"`). */
	mode(): "polling" | "webhook";
	/** The bot's identity (`getMe`) — cached after connect, re-fetched on demand. */
	getIdentity(force?: boolean): Promise<TelegramBotIdentity | null>;
	/** Register the bot's `/` command menu. Best-effort. */
	setCommandMenu(commands: Array<{ command: string; description: string }>): Promise<void>;
	/** Signal typing (`composing`) / clear (`paused`). Best-effort. */
	setComposing(chatId: string, state: "composing" | "paused", threadId?: string): Promise<void>;
	/** Read-receipt no-op (Telegram bots can't mark-read). */
	markRead(): Promise<void>;
	/** Stop polling + tear down. */
	close(): Promise<void>;
}

/** Outbound poll spec — normalized before reaching `sendPoll`. */
export interface TelegramPollSpec {
	/** The poll question. */
	question: string;
	/** 2–10 answer options. */
	options: string[];
	/** Anonymous poll (default true, matching Telegram). */
	isAnonymous?: boolean;
	/** Allow multiple answers (default false). */
	allowsMultipleAnswers?: boolean;
}

export interface TelegramSendTextOpts {
	/** When true the text is already Telegram HTML and sent with `parse_mode: HTML`. */
	html?: boolean;
	/** Suppress the recipient notification for this send (`disable_notification`). */
	silent?: boolean;
	/** Set false to disable link preview/unfurling (`link_preview_options.is_disabled`). */
	linkPreview?: boolean;
	/** Forum-topic thread id. */
	threadId?: string;
	/**
	 * Native reply target — the Telegram `message_id` this send should quote.
	 * Mapped to `reply_parameters: { message_id, allow_sending_without_reply }`
	 * so the message renders as a native reply. Best-effort: a vanished target
	 * still delivers (Telegram drops the quote rather than erroring) because
	 * `allow_sending_without_reply` is set. Omitted → an ordinary, unquoted send.
	 */
	replyToMessageId?: string;
}

export interface TelegramSendMediaOpts {
	/** Forum-topic thread id. */
	threadId?: string;
	/** Suppress the recipient notification for this send (`disable_notification`). */
	silent?: boolean;
}

/** Optional `createForumTopic` knobs (icon color / custom emoji). */
export interface TelegramCreateForumTopicOpts {
	/** RGB color of the topic icon (one of Telegram's allowed palette ints). */
	iconColor?: number;
	/** Custom-emoji id for the topic icon. */
	iconCustomEmojiId?: string;
}

/* ───────────────────────── error classification ───────────────────────── */

/** Pull a Telegram `error_code` off any thrown shape (grammY GrammyError or raw). */
function errorCode(err: unknown): number | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as { error_code?: number; errorCode?: number };
	return e.error_code ?? e.errorCode;
}

/** Description / message text off any thrown shape. */
function errorText(err: unknown): string {
	if (!err) return "";
	if (typeof err === "string") return err;
	const e = err as { description?: string; message?: string };
	return e.description ?? e.message ?? String(err);
}

/** 401 Unauthorized → the bot token is wrong / revoked (terminal). */
export function isTelegramUnauthorized(err: unknown): boolean {
	if (errorCode(err) === 401) return true;
	return /unauthorized/i.test(errorText(err));
}

/** 409 Conflict on getUpdates → another poller or a webhook is active. */
export function isTelegramGetUpdatesConflict(err: unknown): boolean {
	if (errorCode(err) !== 409) return false;
	return /conflict|getupdates|webhook|terminated by other/i.test(errorText(err));
}

/** Strip a bot token out of any string before it reaches a log. */
export function redactTelegramToken(text: string, token: string): string {
	if (!text) return text;
	let out = text;
	if (token) out = out.split(token).join("<redacted>");
	// Catch `bot<digits>:<base64ish>` URL fragments even if the exact token differs.
	out = out.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>");
	return out;
}

/* ───────────────────────── the connection ───────────────────────── */

export async function connectTelegram(args: ConnectTelegramArgs): Promise<TelegramConnection> {
	const accountId = args.accountId ?? "default";
	const mode: "polling" | "webhook" = args.mode === "webhook" ? "webhook" : "polling";
	const sleep = args.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
	const safeLog = (msg: string, meta?: Record<string, unknown>) => {
		// Defensively redact the token from any message + string meta values.
		const redactedMsg = redactTelegramToken(msg, args.token);
		if (!meta) return args.log(redactedMsg);
		const redactedMeta: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(meta)) {
			redactedMeta[k] = typeof v === "string" ? redactTelegramToken(v, args.token) : v;
		}
		args.log(redactedMsg, redactedMeta);
	};

	// ── resolve proxy (optional) ──
	// A configured proxy reroutes EVERY Telegram API call (getMe / getUpdates /
	// sends) through an http(s) proxy — the fix for networks where
	// `api.telegram.org` is blocked. We attach an `undici` ProxyAgent as grammY's
	// fetch dispatcher; grammY uses Node's global `fetch` (undici) under the hood,
	// so `client.baseFetchConfig.dispatcher` is the clean, dep-free seam. No proxy
	// → the dispatcher stays undefined and the Bot is built exactly as before.
	const proxyUrl = (args.proxyUrl ?? "").trim();
	let proxyDispatcher: unknown;
	if (proxyUrl) {
		const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(proxyUrl)?.[1]?.toLowerCase();
		if (isSocksProxyScheme(scheme)) {
			// undici's ProxyAgent only speaks HTTP CONNECT — it cannot tunnel SOCKS.
			// Build a plain undici `Agent` whose `connect` hook opens the socket
			// through the SOCKS proxy (via the `socks` package) and upgrades it to
			// TLS for the https `api.telegram.org` origin. grammY honours the
			// resulting dispatcher exactly like the HTTP(S) ProxyAgent.
			try {
				proxyDispatcher = await buildSocksDispatcher(proxyUrl);
				safeLog("telegram routing through SOCKS proxy", { account: accountId, proxy: maskProxyUrl(proxyUrl) });
			} catch (err) {
				// A malformed proxy URL / missing module must not wedge the channel.
				safeLog("telegram SOCKS proxy setup failed — connecting directly", {
					account: accountId,
					proxy: maskProxyUrl(proxyUrl),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		} else {
			try {
				const { ProxyAgent } = await import("undici");
				proxyDispatcher = new ProxyAgent(proxyUrl);
				safeLog("telegram routing through proxy", { account: accountId, proxy: maskProxyUrl(proxyUrl) });
			} catch (err) {
				// A malformed proxy URL must not wedge the channel — log + go direct.
				safeLog("telegram proxy setup failed — connecting directly", {
					account: accountId,
					proxy: maskProxyUrl(proxyUrl),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// ── lazy-load grammY + runner + throttler (production path only) ──
	let buildBot: (token: string) => TelegramBotLike;
	let buildRunner: (bot: TelegramBotLike) => RunnerLike;
	if (args.botFactory && args.runnerFactory) {
		buildBot = args.botFactory;
		buildRunner = args.runnerFactory;
	} else {
		const grammy = await import("grammy");
		const { run } = await import("@grammyjs/runner");
		const { apiThrottler } = await import("@grammyjs/transformer-throttler");
		buildBot = (token: string) => {
			// When a proxy dispatcher is present, hand it to grammY's fetch config so
			// every API call tunnels through the proxy; otherwise build the Bot with
			// no client options (byte-identical to the pre-proxy path). grammY uses
			// Node's global `fetch` (undici), which honours `dispatcher` at runtime —
			// the property just isn't in grammY's `baseFetchConfig` type, hence the cast.
			const clientOpts = proxyDispatcher
				? ({ client: { baseFetchConfig: { dispatcher: proxyDispatcher } } } as Record<string, unknown>)
				: undefined;
			const bot = (clientOpts
				? new grammy.Bot(token, clientOpts as never)
				: new grammy.Bot(token)) as unknown as TelegramBotLike;
			// Rate-limit the outbound API so a chatty agent never trips Telegram's
			// flood limits — installed on the api config as a transformer.
			bot.api.config?.use(apiThrottler());
			// Honor Telegram's 429 `retry_after`: a rate-limited call sleeps the
			// server-asked delay (capped at 30s) and retries instead of surfacing as
			// a send failure. apiThrottler prevents most 429s proactively; this
			// catches the residual ones. Bounded to 2 extra attempts so a persistent
			// limit still surfaces to the caller rather than blocking forever.
			bot.api.config?.use((async (
				prev: (m: string, p: unknown, s?: AbortSignal) => Promise<unknown>,
				method: string,
				payload: unknown,
				signal?: AbortSignal,
			) => {
				let res = (await prev(method, payload, signal)) as {
					ok?: boolean;
					error_code?: number;
					parameters?: { retry_after?: number };
				};
				for (let attempt = 0; attempt < 2 && res?.ok === false && res.error_code === 429; attempt++) {
					const retryAfter = res.parameters?.retry_after;
					if (typeof retryAfter !== "number") break;
					await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1_000));
					res = (await prev(method, payload, signal)) as typeof res;
				}
				return res;
			}) as never);
			return bot;
		};
		buildRunner = (bot: TelegramBotLike) =>
			run(bot as never, {
				// Subscribe `message` (text/media) + `callback_query` (inline-button
				// approval presses) — the minimal set Brigade's central pipeline
				// consumes. Widen via `args.allowedUpdates` (e.g. inbound reactions).
				// Cast: the resolver returns a strict subset of grammY's update union,
				// but `args.allowedUpdates` is a plain `string[]`.
				runner: { fetch: { allowed_updates: allowedUpdates as never } },
			}) as unknown as RunnerLike;
	}

	// The `allowed_updates` list to request — defaults to message + callback_query.
	const allowedUpdates =
		args.allowedUpdates && args.allowedUpdates.length > 0
			? args.allowedUpdates
			: resolveTelegramAllowedUpdates();

	// ── connection state ──
	let selfId: string | null = null;
	let selfUsername: string | null = null;
	let selfIdentity: TelegramBotIdentity | null = null;
	let connectedAtMs: number | null = null;
	let connected = false;
	let tokenInvalid = false;
	let closed = false;
	let webhookCleared = false;
	let conflictRestartUsed = false;
	let reconnectAttempts = 0;
	let bot: TelegramBotLike | null = null;
	let runner: RunnerLike | null = null;
	let loopPromise: Promise<void> | null = null;

	// Dedupe inbound updates by `update_id` — a redelivered update after a
	// restart must not double-run the agent. Per-connection lifetime.
	const updateDedupe = createDedupeCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1_000 });

	/** Normalize one grammY message into the deferred-media inbound shape. */
	const normalize = (message: Message, opts?: { edited?: boolean }): TgInboundMessage => {
		const chatId = String(message.chat.id);
		const text = extractTelegramText(message);
		const chatType = telegramChatType(message);
		const threadId = telegramThreadId(message);
		const mentions = extractTelegramMentions(message, selfUsername ?? undefined, selfId ?? undefined);
		const replyTo = extractTelegramReplyContext(message);
		const forwarded = extractTelegramForwardContext(message);
		const fromName = buildTelegramSenderName(message);
		const fromId = typeof message.from?.id === "number" ? String(message.from.id) : chatId;
		const tsSec = typeof message.date === "number" ? message.date : 0;

		// DEFERRED media — captured by reference, not downloaded. The thunk is only
		// invoked by the pipeline after the access gate admits the sender.
		const carriesMedia = hasInboundMedia(message);
		const resolveMedia = carriesMedia
			? async (): Promise<InboundMediaAttachment[]> => {
					const fileId = resolveInboundMediaFileId(message);
					const kind = resolveInboundMediaKind(message);
					if (!fileId || !kind || !bot) return [];
					const caption = typeof message.caption === "string" ? message.caption : undefined;
					const fileName = message.document?.file_name ?? message.audio?.file_name ?? message.video?.file_name;
					const att = await downloadTelegramMedia({
						bot: bot.api,
						fileId,
						kind,
						token: args.token,
						caption,
						fileName,
						log: safeLog,
					});
					return att ? [att] : [];
				}
			: undefined;

		return {
			conversationId: chatId,
			messageId: typeof message.message_id === "number" ? String(message.message_id) : undefined,
			messageTimestampMs: tsSec > 0 ? tsSec * 1000 : undefined,
			from: fromId,
			fromName,
			text,
			chatType,
			threadId,
			mentions: mentions.length > 0 ? mentions : undefined,
			replyTo,
			...(forwarded ? { forwarded } : {}),
			...(opts?.edited ? { edited: true } : {}),
			resolveMedia,
			raw: message,
		};
	};

	const onUpdate = (ctx: { update: Update; message?: Message }): void => {
		try {
			const updateId = ctx.update?.update_id;
			if (typeof updateId === "number" && !updateDedupe.claim(String(updateId))) return; // already seen
			const message = ctx.message ?? ctx.update?.message;
			if (!message) return;
			// Ignore the bot's own outbound echoes (a bot never sees its own sends
			// via getUpdates, but a linked-account self-message would carry our id).
			if (typeof message.from?.id === "number" && selfId && String(message.from.id) === selfId) return;
			args.onMessage(normalize(message));
		} catch (err) {
			safeLog("telegram inbound handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Handle an `edited_message` update. Telegram redelivers the WHOLE message
	 * with its new text under `edited_message`; we route it through the SAME
	 * `onMessage` path the original used, flagged `edited: true` (and carrying the
	 * edited message's own id) so the agent can see the correction. Deduped on the
	 * update_id like every other update.
	 */
	const onEdited = (ctx: { update: Update; editedMessage?: Message }): void => {
		try {
			const updateId = ctx.update?.update_id;
			if (typeof updateId === "number" && !updateDedupe.claim(String(updateId))) return;
			const message = ctx.editedMessage ?? (ctx.update as { edited_message?: Message }).edited_message;
			if (!message) return;
			if (typeof message.from?.id === "number" && selfId && String(message.from.id) === selfId) return;
			args.onMessage(normalize(message, { edited: true }));
		} catch (err) {
			safeLog("telegram edited handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Handle a `channel_post` update — a post in a Telegram channel the bot is an
	 * admin of. A channel post has no `from` user; we route it through `onMessage`
	 * treating the chat as a group (channels behave like broadcast groups) so the
	 * access gate + routing handle it uniformly. Bot-authored echoes are skipped.
	 */
	const onChannelPost = (ctx: { update: Update; channelPost?: Message }): void => {
		try {
			const updateId = ctx.update?.update_id;
			if (typeof updateId === "number" && !updateDedupe.claim(String(updateId))) return;
			const post = ctx.channelPost ?? (ctx.update as { channel_post?: Message }).channel_post;
			if (!post) return;
			// Channel posts carry `sender_chat` (the channel) rather than a `from`
			// user. Normalize the post directly; `telegramChatType` maps the channel
			// chat to "group" already via the supergroup branch only when the type is
			// group/supergroup, so force the group kind on the normalized inbound.
			const normalized = normalize(post);
			normalized.chatType = "group";
			args.onMessage(normalized);
		} catch (err) {
			safeLog("telegram channel_post handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Normalize a `message_reaction` update into the inbound shape. Surfaces only
	 * the NEWLY-ADDED emoji(s) (diffing `old_reaction` → `new_reaction`), the
	 * actor, and the target message id. Reactions carry no `text`; the adapter
	 * synthesises a short note so the pipeline can route it. Returns null when the
	 * update removed reactions (nothing added) or was authored by a bot.
	 */
	const normalizeReaction = (r: TelegramMessageReaction): TgInboundMessage | null => {
		if (r.user?.is_bot) return null;
		const chatId = String(r.chat.id);
		const oldEmojis = new Set(
			(r.old_reaction ?? []).filter((x) => x.type === "emoji" && x.emoji).map((x) => x.emoji as string),
		);
		const added = (r.new_reaction ?? [])
			.filter((x) => x.type === "emoji" && x.emoji)
			.map((x) => x.emoji as string)
			.filter((e) => !oldEmojis.has(e));
		if (added.length === 0) return null; // a reaction REMOVAL — nothing to route
		const fromId = typeof r.user?.id === "number" ? String(r.user.id) : chatId;
		const fromName = r.user
			? [r.user.first_name, r.user.last_name].filter(Boolean).join(" ").trim() ||
				(r.user.username ? `@${r.user.username}` : undefined)
			: undefined;
		const chatType: "direct" | "group" =
			r.chat.type === "group" || r.chat.type === "supergroup" ? "group" : "direct";
		return {
			conversationId: chatId,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: "",
			chatType,
			reaction: { emojis: added, targetMessageId: String(r.message_id) },
			raw: r as unknown as Message,
		};
	};

	/**
	 * Handle a `message_reaction` update. The connection normalizes it (newly-
	 * added emoji(s) + actor + target) and routes it through `onReaction` (the
	 * adapter feeds it into the SAME inbound pipeline as a synthesised note).
	 * No-op when the channel didn't wire `onReaction`.
	 */
	const onReaction = (ctx: { update: Update; messageReaction?: TelegramMessageReaction }): void => {
		try {
			const updateId = ctx.update?.update_id;
			if (typeof updateId === "number" && !updateDedupe.claim(String(updateId))) return;
			const r =
				ctx.messageReaction ?? (ctx.update as { message_reaction?: TelegramMessageReaction }).message_reaction;
			if (!r) return;
			const normalized = normalizeReaction(r);
			if (!normalized) return;
			args.onReaction?.(normalized);
		} catch (err) {
			safeLog("telegram reaction handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Normalize a `callback_query` (inline-button press) into the inbound shape
	 * the central pipeline routes to the approval-callback path. The button's
	 * `data` rides on `callbackQuery`; `conversationId` / `from` / `threadId`
	 * come from the message the button was attached to so the pending-approval
	 * lookup keys on the SAME peer the prompt was sent to.
	 */
	const normalizeCallback = (cb: TelegramCallbackQuery): TgInboundMessage | null => {
		const data = typeof cb.data === "string" ? cb.data : "";
		if (!data) return null; // a button with no payload is not an approval press
		const msg = cb.message;
		const chatId = msg?.chat?.id !== undefined ? String(msg.chat.id) : cb.from?.id !== undefined ? String(cb.from.id) : "";
		if (!chatId) return null;
		const fromId = typeof cb.from?.id === "number" ? String(cb.from.id) : chatId;
		const fromName = cb.from
			? [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ").trim() ||
				(cb.from.username ? `@${cb.from.username}` : undefined)
			: undefined;
		const threadId = msg ? telegramThreadId(msg) : undefined;
		const chatType = msg ? telegramChatType(msg) : "direct";
		return {
			conversationId: chatId,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: "",
			chatType,
			...(threadId ? { threadId } : {}),
			callbackQuery: { data, callbackId: cb.id },
			raw: (msg ?? cb) as Message,
		};
	};

	const onCallbackQuery = async (ctx: {
		update: Update;
		callbackQuery?: TelegramCallbackQuery;
		answerCallbackQuery: (opts?: Record<string, unknown>) => Promise<unknown>;
	}): Promise<void> => {
		try {
			const updateId = ctx.update?.update_id;
			if (typeof updateId === "number" && !updateDedupe.claim(String(updateId))) return; // already seen
			const cb = ctx.callbackQuery ?? (ctx.update as { callback_query?: TelegramCallbackQuery }).callback_query;
			if (!cb) return;
			// ACK first — clears the client-side loading spinner immediately (no text,
			// matching the reference). Best-effort: a failed ack must not block routing.
			try {
				await ctx.answerCallbackQuery();
			} catch {
				/* ack is cosmetic */
			}
			const normalized = normalizeCallback(cb);
			if (!normalized) return;
			args.onCallbackQuery?.(normalized);
		} catch (err) {
			safeLog("telegram callback handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/** Build a bot, wire handlers, getMe, clear webhook, sync commands, start runner. */
	const startOnce = async (): Promise<RunnerLike> => {
		const b = buildBot(args.token);
		b.on("message", onUpdate);
		// Subscribe inline-button presses (interactive approvals). grammY hands a
		// per-update `answerCallbackQuery` helper on the ctx; the handler acks via
		// it then routes the normalized callback inbound.
		b.on("callback_query", (ctx) => void onCallbackQuery(ctx));
		// Parity updates — edited messages, channel posts, and inbound reactions.
		// All route through the same inbound surfaces (edits + posts → onMessage,
		// reactions → onReaction). grammY only delivers these when they're in the
		// requested `allowed_updates` list (see allowed-updates.ts).
		b.on("edited_message", onEdited);
		b.on("channel_post", onChannelPost);
		b.on("message_reaction", onReaction);
		bot = b;

		// getMe first — both proves the token (401 surfaces here) and caches the
		// bot id + username the group ACL needs (+ the full identity for the probe).
		const me = await b.api.getMe();
		selfId = String(me.id);
		selfUsername = me.username ?? null;
		selfIdentity = me;

		// Clear any webhook BEFORE polling — the #1 "receives nothing" cause. Do
		// not drop pending updates (the operator may want queued messages). Once
		// cleared we don't re-clear on every reconnect.
		if (!webhookCleared) {
			await b.api.deleteWebhook({ drop_pending_updates: false });
			webhookCleared = true;
		}

		// Register the bot's `/` command menu (best-effort — a failed sync must not
		// block polling). Re-applied on each (re)connect so an edited command set
		// lands after a gateway restart.
		if (args.commandMenu && args.commandMenu.length > 0 && b.api.setMyCommands) {
			try {
				await b.api.setMyCommands(args.commandMenu);
			} catch (err) {
				safeLog("telegram setMyCommands failed (cosmetic)", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const r = buildRunner(b);
		runner = r;
		return r;
	};

	/**
	 * Feed a raw update into the inbound path. In webhook mode the gateway HTTP
	 * route calls this with each POSTed `Update`; it dispatches to the same
	 * message / callback_query handlers polling uses (so dedupe + normalize +
	 * ack are identical). grammY's polling ctx supplies a per-update
	 * `answerCallbackQuery`; in webhook mode we synthesise one off `bot.api`.
	 */
	const feedUpdate = (update: Update): void => {
		const message = (update as { message?: Message }).message;
		if (message) {
			onUpdate({ update, message });
			return;
		}
		const editedMessage = (update as { edited_message?: Message }).edited_message;
		if (editedMessage) {
			onEdited({ update, editedMessage });
			return;
		}
		const channelPost = (update as { channel_post?: Message }).channel_post;
		if (channelPost) {
			onChannelPost({ update, channelPost });
			return;
		}
		const messageReaction = (update as { message_reaction?: TelegramMessageReaction }).message_reaction;
		if (messageReaction) {
			onReaction({ update, messageReaction });
			return;
		}
		const callbackQuery = (update as { callback_query?: TelegramCallbackQuery }).callback_query;
		if (callbackQuery) {
			void onCallbackQuery({
				update,
				callbackQuery,
				answerCallbackQuery: async (opts?: Record<string, unknown>) => {
					const b = bot;
					if (!b?.api.answerCallbackQuery) return;
					await b.api.answerCallbackQuery(callbackQuery.id, opts);
				},
			});
		}
	};

	/**
	 * Webhook transport start: build the bot, getMe, sync commands, then register
	 * the webhook (when a url was supplied) so Telegram POSTs updates to the
	 * gateway route. Does NOT poll — inbound arrives via {@link feedUpdate}.
	 */
	const startWebhook = async (): Promise<void> => {
		const b = buildBot(args.token);
		// We don't subscribe via b.on(...) in webhook mode — feedUpdate dispatches
		// directly — but wiring the handlers is harmless and keeps parity if a
		// future grammy webhookCallback is adopted.
		bot = b;
		const me = await b.api.getMe();
		selfId = String(me.id);
		selfUsername = me.username ?? null;
		selfIdentity = me;
		if (args.commandMenu && args.commandMenu.length > 0 && b.api.setMyCommands) {
			try {
				await b.api.setMyCommands(args.commandMenu);
			} catch (err) {
				safeLog("telegram setMyCommands failed (cosmetic)", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		const url = args.webhook?.url?.trim();
		if (url && b.api.setWebhook) {
			const opts: Record<string, unknown> = { allowed_updates: allowedUpdates };
			if (args.webhook?.secretToken) opts.secret_token = args.webhook.secretToken;
			await b.api.setWebhook(url, opts);
			safeLog("telegram webhook registered", { account: accountId });
		} else {
			safeLog("telegram webhook mode — no url configured; inbound only via gateway route", {
				account: accountId,
			});
		}
		connected = true;
		connectedAtMs = Date.now();
		reconnectAttempts = 0;
		args.onConnected?.();
	};

	/** The supervise loop — start, run until the runner stops, reconnect with backoff. */
	const superviseLoop = async (): Promise<void> => {
		while (!closed && !tokenInvalid) {
			let r: RunnerLike;
			try {
				r = await startOnce();
			} catch (err) {
				if (isTelegramUnauthorized(err)) {
					tokenInvalid = true;
					connected = false;
					safeLog("telegram token rejected (401) — re-token required; polling stopped");
					args.onTokenInvalid?.();
					return;
				}
				if (closed) return;
				// Setup failed (transient network on getMe/deleteWebhook) — back off + retry.
				const delay = telegramBackoffDelay(reconnectAttempts);
				reconnectAttempts += 1;
				if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
					safeLog("telegram setup attempts exhausted — giving up until restart", { attempts: reconnectAttempts });
					return;
				}
				safeLog("telegram setup failed — retrying", {
					attempt: reconnectAttempts,
					delayMs: delay,
					error: err instanceof Error ? err.message : String(err),
				});
				await sleep(delay);
				continue;
			}

			// close() may have fired during the async startOnce() — bail before we
			// commit to driving a runner we'd otherwise have to wait out.
			if (closed) {
				await teardownRunner();
				return;
			}

			// Connected. Reset backoff, announce.
			connected = true;
			connectedAtMs = Date.now();
			reconnectAttempts = 0;
			conflictRestartUsed = false;
			safeLog("telegram connected", { account: accountId, self: selfUsername ? `@${selfUsername}` : selfId });
			args.onConnected?.();

			// Drive the runner until it stops (graceful or error).
			try {
				await r.task();
				// Runner stopped without throwing — graceful stop (close) or maxRetry.
				if (closed) return;
				connected = false;
				const delay = telegramBackoffDelay(reconnectAttempts);
				reconnectAttempts += 1;
				if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
					safeLog("telegram polling attempts exhausted — giving up until restart", { attempts: reconnectAttempts });
					return;
				}
				safeLog("telegram polling stopped — reconnecting", { attempt: reconnectAttempts, delayMs: delay });
				await sleep(delay);
			} catch (err) {
				connected = false;
				if (closed) return;
				if (isTelegramUnauthorized(err)) {
					tokenInvalid = true;
					safeLog("telegram token rejected (401) — re-token required; polling stopped");
					args.onTokenInvalid?.();
					return;
				}
				if (isTelegramGetUpdatesConflict(err)) {
					// Another poller / a leftover webhook is live. Clear the webhook
					// and restart ONCE immediately; if it recurs, fall through to backoff.
					if (!conflictRestartUsed) {
						conflictRestartUsed = true;
						webhookCleared = false; // force a re-clear on the next startOnce
						safeLog("telegram getUpdates conflict (409) — clearing webhook + restarting once");
						await teardownRunner();
						continue;
					}
					safeLog("telegram getUpdates conflict (409) persists — backing off");
				}
				const delay = telegramBackoffDelay(reconnectAttempts);
				reconnectAttempts += 1;
				if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
					safeLog("telegram polling attempts exhausted — giving up until restart", { attempts: reconnectAttempts });
					return;
				}
				safeLog("telegram polling error — reconnecting", {
					attempt: reconnectAttempts,
					delayMs: delay,
					error: err instanceof Error ? err.message : String(err),
				});
				await sleep(delay);
			} finally {
				await teardownRunner();
			}
		}
	};

	const teardownRunner = async (): Promise<void> => {
		const r = runner;
		runner = null;
		if (r) {
			try {
				if (r.isRunning()) await r.stop();
			} catch {
				/* already stopped */
			}
		}
		const b = bot;
		if (b) {
			try {
				await b.stop();
			} catch {
				/* already stopped */
			}
		}
	};

	// Kick the supervise loop. It resolves the initial connect via onConnected;
	// connectTelegram itself resolves as soon as the FIRST connect (or terminal
	// failure) settles so the adapter's start() doesn't hang forever.
	let resolveInitial: () => void;
	const initial = new Promise<void>((resolve) => {
		resolveInitial = resolve;
	});
	const origOnConnected = args.onConnected;
	const origOnTokenInvalid = args.onTokenInvalid;
	args.onConnected = () => {
		origOnConnected?.();
		resolveInitial();
	};
	args.onTokenInvalid = () => {
		origOnTokenInvalid?.();
		resolveInitial();
	};
	if (mode === "webhook") {
		// Webhook transport: one-shot setup (no poll loop). A 401 surfaces as a
		// terminal token-invalid; any other setup error is logged and the channel
		// stays "starting" until the operator fixes config + restarts.
		loopPromise = startWebhook().catch((err) => {
			if (isTelegramUnauthorized(err)) {
				tokenInvalid = true;
				connected = false;
				safeLog("telegram token rejected (401) — re-token required; webhook not registered");
				args.onTokenInvalid?.();
				return;
			}
			safeLog("telegram webhook setup failed", { error: err instanceof Error ? err.message : String(err) });
		});
	} else {
		loopPromise = superviseLoop().catch((err) => {
			safeLog("telegram supervise loop crashed", { error: err instanceof Error ? err.message : String(err) });
		});
	}
	// Don't block start() indefinitely — resolve once connected OR after the loop
	// settles (terminal failure), whichever comes first.
	await Promise.race([initial, loopPromise.then(() => undefined)]);

	/* ── outbound + control surface ── */

	const requireLive = (): TelegramBotLike => {
		if (tokenInvalid) throw new Error("Telegram token is invalid — set a new bot token and restart.");
		if (!bot) throw new Error("Telegram channel is not started");
		return bot;
	};

	const sendText: TelegramConnection["sendText"] = async (chatId, text, opts) => {
		const b = requireLive();
		const params: Record<string, unknown> = {};
		if (opts?.html) params.parse_mode = "HTML";
		if (opts?.threadId) params.message_thread_id = Number(opts.threadId);
		if (opts?.silent) params.disable_notification = true;
		if (opts?.linkPreview === false) params.link_preview_options = { is_disabled: true };
		// Native reply: quote the target message. `allow_sending_without_reply`
		// keeps the send succeeding even if the quoted message was deleted.
		if (opts?.replyToMessageId) {
			const replyId = Number(opts.replyToMessageId);
			if (Number.isFinite(replyId)) {
				params.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
			}
		}
		try {
			const res = await b.api.sendMessage(chatId, text, params);
			return { messageId: res.message_id };
		} catch (err) {
			// Thread vanished — retry without the thread param (topic deleted/closed).
			if (opts?.threadId && /message thread not found/i.test(errorText(err))) {
				const { message_thread_id: _omit, ...rest } = params;
				const res = await b.api.sendMessage(chatId, text, rest);
				return { messageId: res.message_id };
			}
			throw err;
		}
	};

	const sendInteractive: TelegramConnection["sendInteractive"] = async (chatId, text, replyMarkup, opts) => {
		const b = requireLive();
		const params: Record<string, unknown> = { reply_markup: replyMarkup };
		if (opts?.html) params.parse_mode = "HTML";
		if (opts?.threadId) params.message_thread_id = Number(opts.threadId);
		try {
			const res = await b.api.sendMessage(chatId, text, params);
			return { messageId: res.message_id };
		} catch (err) {
			if (opts?.threadId && /message thread not found/i.test(errorText(err))) {
				const { message_thread_id: _omit, ...rest } = params;
				const res = await b.api.sendMessage(chatId, text, rest);
				return { messageId: res.message_id };
			}
			throw err;
		}
	};

	const sendMedia: TelegramConnection["sendMedia"] = async (chatId, media, opts) => {
		const b = requireLive();
		const { buildTelegramInputFile } = await import("./media.js");
		const input = await buildTelegramInputFile(media);
		const params: Record<string, unknown> = {};
		if (opts?.threadId) params.message_thread_id = Number(opts.threadId);
		if (opts?.silent) params.disable_notification = true;
		// Telegram caps a media caption at 1024 chars; a longer one 400s the whole
		// send. Split it — the head rides as the caption, the remainder is delivered
		// as a follow-up text message (chunked at 4096) once the media lands, so a
		// long caption is preserved instead of failing or being silently dropped.
		let captionOverflow = "";
		if (media.caption) {
			if (media.caption.length > TELEGRAM_CAPTION_LIMIT) {
				const split = splitTelegramCaption(media.caption);
				params.caption = split.head;
				captionOverflow = split.rest;
			} else {
				params.caption = media.caption;
			}
		}
		const api = b.api;
		const send = async (p: Record<string, unknown>): Promise<void> => {
			switch (media.kind) {
				case "image":
					await api.sendPhoto?.(chatId, input, p);
					return;
				case "video":
					await api.sendVideo?.(chatId, input, p);
					return;
				case "audio":
					await api.sendAudio?.(chatId, input, p);
					return;
				case "voice":
					await api.sendVoice?.(chatId, input, p);
					return;
				case "sticker":
					await api.sendSticker?.(chatId, input, p);
					return;
				default:
					await api.sendDocument?.(chatId, input, p);
			}
		};
		try {
			await send(params);
		} catch (err) {
			if (opts?.threadId && /message thread not found/i.test(errorText(err))) {
				const { message_thread_id: _omit, ...rest } = params;
				await send(rest);
			} else {
				throw err;
			}
		}
		// Flush any caption overflow as plain follow-up text once the media is sent.
		if (captionOverflow) {
			const followParams: Record<string, unknown> = {};
			if (opts?.threadId) followParams.message_thread_id = Number(opts.threadId);
			if (opts?.silent) followParams.disable_notification = true;
			for (const chunk of chunkText(captionOverflow, { limit: TELEGRAM_MESSAGE_LIMIT })) {
				try {
					await b.api.sendMessage(chatId, chunk, followParams);
				} catch (err) {
					if (followParams.message_thread_id && /message thread not found/i.test(errorText(err))) {
						const { message_thread_id: _omit, ...rest } = followParams;
						await b.api.sendMessage(chatId, chunk, rest);
					} else {
						throw err;
					}
				}
			}
		}
	};

	const react: TelegramConnection["react"] = async (chatId, messageId, emoji) => {
		const b = requireLive();
		if (!b.api.setMessageReaction) return; // older API surface — reaction is cosmetic
		const id = Number(messageId);
		if (!Number.isFinite(id)) return;
		const reaction = emoji ? [{ type: "emoji", emoji }] : [];
		try {
			await b.api.setMessageReaction(chatId, id, reaction);
		} catch (err) {
			safeLog("telegram react failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	const sendPoll: TelegramConnection["sendPoll"] = async (chatId, poll, opts) => {
		const b = requireLive();
		if (!b.api.sendPoll) throw new Error("Telegram: this bot build cannot send polls.");
		const params: Record<string, unknown> = {
			// Telegram defaults `is_anonymous` to true; honour an explicit override.
			is_anonymous: poll.isAnonymous !== false,
			allows_multiple_answers: poll.allowsMultipleAnswers === true,
		};
		if (opts?.threadId) params.message_thread_id = Number(opts.threadId);
		try {
			const res = await b.api.sendPoll(chatId, poll.question, poll.options, params);
			return { messageId: res.message_id };
		} catch (err) {
			if (opts?.threadId && /message thread not found/i.test(errorText(err))) {
				const { message_thread_id: _omit, ...rest } = params;
				const res = await b.api.sendPoll(chatId, poll.question, poll.options, rest);
				return { messageId: res.message_id };
			}
			throw err;
		}
	};

	const editMessageText: TelegramConnection["editMessageText"] = async (chatId, messageId, text, opts) => {
		const b = requireLive();
		if (!b.api.editMessageText) throw new Error("Telegram: this bot build cannot edit messages.");
		const id = Number(messageId);
		if (!Number.isFinite(id)) throw new Error(`Telegram: invalid message id "${messageId}".`);
		const params: Record<string, unknown> = {};
		if (opts?.html) params.parse_mode = "HTML";
		await b.api.editMessageText(chatId, id, text, params);
	};

	const deleteMessage: TelegramConnection["deleteMessage"] = async (chatId, messageId) => {
		const b = requireLive();
		if (!b.api.deleteMessage) throw new Error("Telegram: this bot build cannot delete messages.");
		const id = Number(messageId);
		if (!Number.isFinite(id)) throw new Error(`Telegram: invalid message id "${messageId}".`);
		await b.api.deleteMessage(chatId, id);
	};

	const pinMessage: TelegramConnection["pinMessage"] = async (chatId, messageId) => {
		const b = requireLive();
		if (!b.api.pinChatMessage) throw new Error("Telegram: this bot build cannot pin messages.");
		const id = Number(messageId);
		if (!Number.isFinite(id)) throw new Error(`Telegram: invalid message id "${messageId}".`);
		// Silent pin (no member notification) — matches the reference behavior.
		await b.api.pinChatMessage(chatId, id, { disable_notification: true });
	};

	const unpinMessage: TelegramConnection["unpinMessage"] = async (chatId, messageId) => {
		const b = requireLive();
		if (!b.api.unpinChatMessage) throw new Error("Telegram: this bot build cannot unpin messages.");
		const params: Record<string, unknown> = {};
		if (messageId !== undefined) {
			const id = Number(messageId);
			if (Number.isFinite(id)) params.message_id = id;
		}
		await b.api.unpinChatMessage(chatId, params);
	};

	const editForumTopic: TelegramConnection["editForumTopic"] = async (chatId, threadId, name) => {
		const b = bot;
		if (!b || tokenInvalid || !b.api.editForumTopic) return; // best-effort — labeling is cosmetic
		const id = Number(threadId);
		if (!Number.isFinite(id)) return;
		// Telegram caps a forum topic name at 128 chars — clamp defensively.
		const clamped = name.length > 128 ? name.slice(0, 128) : name;
		if (!clamped.trim()) return;
		try {
			await b.api.editForumTopic(chatId, id, { name: clamped });
		} catch (err) {
			safeLog("telegram editForumTopic failed (cosmetic)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const createForumTopic: TelegramConnection["createForumTopic"] = async (chatId, name, opts) => {
		const b = requireLive();
		if (!b.api.createForumTopic) throw new Error("Telegram: this bot build cannot create forum topics.");
		const trimmed = (name ?? "").trim();
		if (!trimmed) throw new Error("Telegram: a forum topic name is required.");
		// Telegram caps a forum topic name at 128 chars.
		if (trimmed.length > 128) throw new Error("Telegram: forum topic name must be 128 characters or fewer.");
		const extra: Record<string, unknown> = {};
		if (typeof opts?.iconColor === "number") extra.icon_color = opts.iconColor;
		if (opts?.iconCustomEmojiId?.trim()) extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
		const res = await b.api.createForumTopic(chatId, trimmed, Object.keys(extra).length > 0 ? extra : undefined);
		return { threadId: String(res.message_thread_id), name: res.name ?? trimmed };
	};

	const answerCallback: TelegramConnection["answerCallback"] = async (callbackId, text) => {
		const b = bot;
		if (!b || tokenInvalid || !b.api.answerCallbackQuery) return; // best-effort
		try {
			await b.api.answerCallbackQuery(callbackId, text ? { text } : undefined);
		} catch {
			/* ack is cosmetic */
		}
	};

	const getIdentity: TelegramConnection["getIdentity"] = async (force) => {
		if (selfIdentity && !force) return selfIdentity;
		const b = bot;
		if (!b || tokenInvalid) return selfIdentity;
		try {
			const me = await b.api.getMe();
			selfIdentity = me;
			selfId = String(me.id);
			selfUsername = me.username ?? selfUsername;
			return me;
		} catch (err) {
			safeLog("telegram getMe (probe) failed", { error: err instanceof Error ? err.message : String(err) });
			return selfIdentity;
		}
	};

	const setCommandMenu: TelegramConnection["setCommandMenu"] = async (commands) => {
		const b = bot;
		if (!b || tokenInvalid || !b.api.setMyCommands) return; // best-effort
		if (commands.length === 0) return;
		try {
			await b.api.setMyCommands(commands);
		} catch (err) {
			safeLog("telegram setMyCommands failed (cosmetic)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const setComposing: TelegramConnection["setComposing"] = async (chatId, state, threadId) => {
		if (state !== "composing") return; // Telegram auto-clears typing after ~5s; nothing to send on "paused"
		const b = bot;
		if (!b || tokenInvalid) return;
		const params: Record<string, unknown> = {};
		if (threadId) params.message_thread_id = Number(threadId);
		try {
			await b.api.sendChatAction(chatId, "typing", params);
		} catch {
			/* presence is best-effort */
		}
	};

	const close: TelegramConnection["close"] = async () => {
		closed = true;
		connected = false;
		await teardownRunner();
		// Wait for the supervise loop to unwind, but never hang on it — teardown
		// resolves the active runner's task() so the loop sees `closed` and
		// returns promptly; the timeout is pure defense-in-depth.
		try {
			await Promise.race([
				loopPromise ?? Promise.resolve(),
				new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
			]);
		} catch {
			/* loop already settled */
		}
	};

	return {
		selfId: () => selfId,
		selfUsername: () => selfUsername,
		connectedAt: () => connectedAtMs,
		isConnected: () => connected,
		isTokenInvalid: () => tokenInvalid,
		sendText,
		sendInteractive,
		sendMedia,
		sendPoll,
		react,
		editMessageText,
		deleteMessage,
		pinMessage,
		unpinMessage,
		editForumTopic,
		createForumTopic,
		answerCallback,
		getIdentity,
		setCommandMenu,
		feedUpdate,
		mode: () => mode,
		setComposing,
		markRead: async () => {},
		close,
	};
}
