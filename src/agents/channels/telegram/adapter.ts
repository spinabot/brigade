/**
 * Telegram channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the grammY
 * long-polling connection. Unlike WhatsApp (QR pairing), Telegram is
 * TOKEN-based: the operator pastes a Bot API token from @BotFather, so this
 * adapter declares a `setup` wizard (single `botToken` credential) and has NO
 * `link`/QR flow. Enablement is explicit — `channels.telegram.enabled: true`
 * plus a resolvable token.
 *
 * Modeled directly on `whatsapp/adapter.ts`: same health-flag mirroring, same
 * deferred-media passthrough on inbound, same chunk-then-send outbound shape
 * (chunk markdown ≤4096, convert each chunk to Telegram HTML, send with
 * `parse_mode: HTML`, and on a parse / empty-text error RETRY as plain text).
 *
 * Scope cut (v1): single account, and `callback_query` inline buttons are not
 * handled (Brigade approvals are central text replies).
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { loadConfig } from "../../../core/config.js";
// Channel SDK barrel — the single import surface for the channel-authoring
// contract + shared helpers. Telegram is the proving ground: contract types
// (ChannelAdapter / ChannelHealth / ChannelStartContext / OutboundMedia /
// OutboundSendOptions) and `chunkText` now come from one place instead of
// scattered `../../extensions/types.js` + `../whatsapp/chunk.js` paths.
import {
	type ChannelAdapter,
	type ChannelApprovalPromptParams,
	type ChannelCapabilities,
	type ChannelHealth,
	type ChannelMessageAction,
	type ChannelMessageActionResult,
	type ChannelReplyStream,
	type ChannelStartContext,
	type OutboundMedia,
	type OutboundSendOptions,
	chunkText,
} from "../sdk.js";
import {
	listTelegramAccountIds,
	resolveTelegramBotToken,
	resolveTelegramProxyUrl,
	telegramChannelEnabled,
	telegramLiveStreamEnabled,
	telegramStreamThrottleMs,
	telegramSurfaceReasoning,
	telegramWebhookConfig,
	TELEGRAM_CHANNEL_ID,
	TELEGRAM_DEFAULT_ACCOUNT_ID,
} from "./account-config.js";
import { createDraftStream } from "./draft-stream.js";
import { buildTelegramInlineKeyboard } from "./inline-keyboard.js";
import { splitTelegramReasoning } from "./reasoning-lane.js";
import { buildTelegramApprovalKeyboard, buildTelegramApprovalText } from "./approval-native.js";
import { connectTelegram, type ConnectTelegramArgs, type TelegramBotIdentity, type TelegramConnection, type TelegramPollSpec } from "./connection.js";
import { markdownToTelegramHtml, telegramHtmlIsEmpty } from "./format.js";
import { resolveTelegramApprover } from "./approval-authorize.js";

/** Telegram's per-message text limit. */
const TELEGRAM_TEXT_LIMIT = 4096;

/** Errors Telegram returns when HTML failed to parse / produced an empty body. */
const PARSE_ERROR_RE = /can't parse entities|parse entities|find end of the entity|message text is empty/i;

/** Adapter construction options — all optional for back-compat. */
export interface CreateTelegramAdapterOptions {
	/** Per-account scope. Defaults to `"default"` (single-account v1). */
	accountId?: string;
	/**
	 * TEST SEAM: override how the connection is built. Production leaves this
	 * undefined and `connectTelegram` lazy-loads grammY. Tests inject a fake.
	 */
	connectImpl?: (args: ConnectTelegramArgs) => Promise<TelegramConnection>;
	/**
	 * The bot's `/` command menu to register on connect (Brigade's central
	 * commands, already mapped to `{ command, description }` via
	 * `buildTelegramCommandMenu`). Empty/omitted → no menu sync. The manager
	 * supplies this from `buildBundledCommands(adapter)`.
	 */
	commandMenu?: Array<{ command: string; description: string }>;
	/**
	 * Widen the `allowed_updates` poller subscription beyond the default
	 * `message` + `callback_query`. Omitted → the minimal set.
	 */
	allowedUpdates?: string[];
	/**
	 * Enable forum-topic auto-labeling: when set, the FIRST message seen on a
	 * forum thread renames that topic from the message text. Off by default —
	 * the plugin path enables it from `channels.telegram.autoLabelTopics`.
	 */
	autoLabelTopics?: boolean;
}

export function createTelegramAdapter(opts: CreateTelegramAdapterOptions = {}): ChannelAdapter {
	const accountId = opts.accountId?.trim() || TELEGRAM_DEFAULT_ACCOUNT_ID;
	const connectImpl = opts.connectImpl ?? connectTelegram;
	let connection: TelegramConnection | null = null;
	// Forum threads we've already auto-labeled this process, so the rename fires
	// only on the FIRST message of a topic (keyed `${chatId}:${threadId}`).
	const autoLabeledThreads = new Set<string>();
	// The ChannelStartContext doesn't carry the config, but the manager ALWAYS
	// calls `isConfigured(cfg, env)` immediately before `start(ctx)` — so we
	// capture the config + env it passed there and read the token from them in
	// start(). This avoids a second config load and keeps the adapter pure.
	let lastConfig: BrigadeConfig | null = null;
	let lastEnv: NodeJS.ProcessEnv = process.env;
	// Health flags mirrored from the connection lifecycle so health() never has
	// to round-trip Telegram on the hot path (cron timer / send pre-flight).
	//   - `connected` flips true on a successful getMe + poll start.
	//   - `tokenInvalid` is STICKY: a 401 means the token is dead and the only
	//     recovery is `brigade channels add --channel telegram` with a new token.
	let connected = false;
	let tokenInvalid = false;

	const adapter: TelegramAdapter = {
		id: TELEGRAM_CHANNEL_ID,
		label: "Telegram",

		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean {
			// Capture for start() — the manager calls this right before start(ctx).
			lastConfig = cfg;
			lastEnv = env ?? process.env;
			if (!telegramChannelEnabled(cfg)) return false;
			// Need a resolvable bot token (config `${VAR}` ref or TELEGRAM_BOT_TOKEN env).
			if (!resolveTelegramBotToken(cfg, accountId, env ?? process.env)) return false;
			// Multi-account follow-up: when the operator declares >1 account, the
			// (future) plugin path owns lifecycle and the legacy single adapter
			// steps aside. v1 only ever runs the default account.
			const isLegacyAdapter = accountId === TELEGRAM_DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listTelegramAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			// Resolve the token from the config the manager handed isConfigured().
			// Fall back to a fresh load defensively (e.g. a direct start() in a test
			// that skipped isConfigured).
			const cfg = lastConfig ?? (await loadStartConfig());
			const token = resolveTelegramBotToken(cfg, accountId, lastEnv);
			if (!token) {
				// Defensive — isConfigured already gates this, but never start a bot
				// with an empty token (grammY would throw an opaque error).
				ctx.log("Telegram not started — no bot token resolved (set channels.telegram.botToken or TELEGRAM_BOT_TOKEN).");
				return;
			}
			// Resolve transport mode (polling default; webhook opt-in). Webhook mode
			// registers the webhook on connect; the gateway HTTP route feeds updates
			// via `feedWebhookUpdate` (wired by the module when webhook is active).
			const transport = telegramWebhookConfig(cfg, lastEnv);
			// Optional proxy: per-account → top-level `channels.telegram.proxy` →
			// `HTTPS_PROXY`/`ALL_PROXY` env. Empty → direct connection (the default).
			// On a network where `api.telegram.org` is blocked, this routes every
			// Telegram API call through a reachable http(s) proxy.
			const proxyUrl = resolveTelegramProxyUrl(cfg, accountId, lastEnv);
			connection = await connectImpl({
				token,
				accountId,
				...(proxyUrl ? { proxyUrl } : {}),
				...(opts.commandMenu && opts.commandMenu.length > 0 ? { commandMenu: opts.commandMenu } : {}),
				...(opts.allowedUpdates && opts.allowedUpdates.length > 0 ? { allowedUpdates: opts.allowedUpdates } : {}),
				...(transport.mode === "webhook"
					? {
							mode: "webhook" as const,
							webhook: {
								...(transport.url ? { url: transport.url } : {}),
								...(transport.secretToken ? { secretToken: transport.secretToken } : {}),
							},
						}
					: {}),
				log: ctx.log,
				onConnected: () => {
					connected = true;
					tokenInvalid = false;
					ctx.log("Telegram ready");
					ctx.onConnected?.();
				},
				onTokenInvalid: () => {
					connected = false;
					tokenInvalid = true;
					ctx.log(
						"Telegram bot token was rejected. Run `brigade channels add --channel telegram` with a fresh @BotFather token.",
					);
					ctx.onLoggedOut?.();
				},
				onMessage: (msg) => {
					// Forum-topic auto-labeling: rename a topic from its first message.
					// Fire-and-forget + best-effort — never blocks inbound delivery.
					if (opts.autoLabelTopics && msg.threadId && msg.chatType === "group" && msg.text.trim()) {
						maybeAutoLabelThread(msg.conversationId, msg.threadId, msg.text);
					}
					void ctx.onInbound({
						channel: TELEGRAM_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						messageId: msg.messageId,
						messageTimestampMs: msg.messageTimestampMs,
						from: msg.from,
						fromName: msg.fromName,
						text: msg.text,
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						threadId: msg.threadId,
						mentions: msg.mentions,
						replyTo: msg.replyTo,
						// Edit + forward provenance ride through so the central pipeline /
						// agent see "this was an edit" / "this was forwarded from X".
						...(msg.edited ? { edited: true } : {}),
						...(msg.forwarded ? { forwarded: msg.forwarded } : {}),
						// Deferred media thunk rides through untouched — the pipeline
						// resolves it only after the access gate admits the sender.
						resolveMedia: msg.resolveMedia,
						raw: msg.raw,
					});
				},
				// Inbound reaction (`message_reaction`) → synthesise a short note and
				// route it through the SAME inbound pipeline as a normal message so
				// the access gate + routing apply uniformly. The note carries the
				// added emoji(s) + the target message id so the agent has context.
				onReaction: (msg) => {
					if (!msg.reaction) return;
					const note = buildReactionNote(msg.reaction.emojis, msg.reaction.targetMessageId, msg.fromName);
					void ctx.onInbound({
						channel: TELEGRAM_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						from: msg.from,
						...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
						text: note,
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
						reaction: msg.reaction,
						raw: msg.raw,
					});
				},
				// Inline-button press → emit an InboundMessage carrying `callbackQuery`
				// so the central pipeline's approval-callback path resolves it. The
				// connection has already acked the press via `answerCallbackQuery`.
				onCallbackQuery: (msg) => {
					if (!msg.callbackQuery) return;
					void ctx.onInbound({
						channel: TELEGRAM_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						from: msg.from,
						...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
						text: "",
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
						callbackQuery: msg.callbackQuery,
						raw: msg.raw,
					});
				},
			});
		},

		async stop(): Promise<void> {
			await connection?.close();
			connection = null;
			connected = false;
		},

		/**
		 * Synchronous read of the cached connection state:
		 *   - `{ ok: true }` once polling is live.
		 *   - `{ ok: false, kind: "logged-out" }` after a 401 (sticky; re-token).
		 *   - `{ ok: false, kind: "starting" }` between start() and first connect.
		 *   - `{ ok: false, kind: "disconnected" }` for a transient drop mid-reconnect.
		 */
		health(): ChannelHealth {
			if (tokenInvalid || connection?.isTokenInvalid()) {
				return {
					ok: false,
					kind: "logged-out",
					reason: "Telegram bot token was rejected — Brigade can't send until a new token is set.",
					remediation: "Run `brigade channels add --channel telegram` and paste a fresh @BotFather token.",
				};
			}
			if (!connection) {
				return { ok: false, kind: "starting", reason: "Telegram adapter is not started yet." };
			}
			if (!connected || !connection.isConnected()) {
				return {
					ok: false,
					kind: "disconnected",
					reason: "Telegram is reconnecting — sends will fail until polling resumes.",
				};
			}
			return { ok: true };
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<void> {
			if (!connection) throw new Error("Telegram channel is not started");
			if (tokenInvalid || connection.isTokenInvalid()) {
				throw new Error("Telegram token is invalid — run `brigade channels add --channel telegram` with a new token, then retry.");
			}
			const threadId = opts?.threadId;
			// Native reply target (Telegram `reply_parameters.message_id`). Applied
			// to the FIRST chunk only — quoting every chunk of a long reply would
			// render a chain of quoted messages. Omitted → unquoted send (unchanged).
			const replyToMessageId = opts?.replyToId;
			// Send options honored on every chunk: silent notification + link-preview
			// toggle. Purely additive — undefined keeps the prior behavior byte-for-byte.
			const sendExtras: { threadId?: string; silent?: boolean; linkPreview?: boolean } = { threadId };
			if (opts?.silent) sendExtras.silent = true;
			if (opts?.linkPreview !== undefined) sendExtras.linkPreview = opts.linkPreview;
			// Chunk on the RAW markdown so fences/paragraphs aren't shredded, then
			// convert each chunk to Telegram HTML and send. A chunk whose HTML is
			// empty (syntax-only) or that Telegram rejects with a parse error is
			// re-sent as plain text.
			const chunks = chunkText(text, { limit: TELEGRAM_TEXT_LIMIT });
			let first = true;
			for (const chunk of chunks) {
				// Only the first chunk carries the reply quote.
				const replyOpt = first && replyToMessageId ? { replyToMessageId } : {};
				const html = markdownToTelegramHtml(chunk);
				if (telegramHtmlIsEmpty(html)) {
					// Nothing renderable — send the raw chunk as plain text (if it has any).
					if (chunk.trim().length > 0) {
						await connection.sendText(conversationId, chunk, { ...sendExtras, ...replyOpt });
						first = false;
					}
					continue;
				}
				try {
					await connection.sendText(conversationId, html, { ...sendExtras, html: true, ...replyOpt });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (PARSE_ERROR_RE.test(msg) && chunk.trim().length > 0) {
						// HTML failed to parse — fall back to the plain chunk.
						await connection.sendText(conversationId, chunk, { ...sendExtras, ...replyOpt });
					} else {
						throw err;
					}
				}
				first = false;
			}
		},

		/**
		 * Open a LIVE reply stream — the gateway feeds the accumulating answer text
		 * via `update()`, this edits one Telegram message in place (throttled
		 * ~1×/sec), and `finalize()` settles it on turn end. Returns `null` when
		 * streaming is disabled in config (`channels.telegram.liveStream` is not
		 * true) OR the connection isn't live, so the pipeline falls back to the
		 * single final `sendText` — byte-unchanged from before streaming existed.
		 *
		 * Each draft chunk is rendered through the SAME markdown→HTML converter the
		 * final path uses; a chunk whose HTML is empty/unparseable streams as plain
		 * text. When the running answer exceeds 4096 chars the stream finalizes the
		 * current message at a boundary and rolls overflow into a new message.
		 */
		beginReplyStream(conversationId: string, sendOpts?: OutboundSendOptions): ChannelReplyStream | null {
			if (!connection) return null;
			if (tokenInvalid || connection.isTokenInvalid()) return null;
			const cfg = lastConfig;
			if (!cfg || !telegramLiveStreamEnabled(cfg)) return null;
			const conn = connection;
			const threadId = sendOpts?.threadId;
			const stream = createDraftStream({
				transport: {
					async sendMessage(text, o): Promise<{ messageId: number }> {
						const sent = await conn.sendText(conversationId, text, {
							...(o.parseMode === "HTML" ? { html: true } : {}),
							...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
						});
						return { messageId: sent.messageId };
					},
					async editMessageText(messageId, text, o): Promise<void> {
						await conn.editMessageText(conversationId, String(messageId), text, {
							...(o.parseMode === "HTML" ? { html: true } : {}),
						});
					},
				},
				throttleMs: telegramStreamThrottleMs(cfg),
				maxChars: TELEGRAM_TEXT_LIMIT,
				// Render each draft chunk to Telegram HTML; fall back to plain text
				// when the HTML is empty (syntax-only) so a half-streamed fence
				// never wedges the edit.
				renderText: (chunk) => {
					const html = markdownToTelegramHtml(chunk);
					if (telegramHtmlIsEmpty(html)) return { text: chunk };
					return { text: html, parseMode: "HTML" as const };
				},
			});
			return {
				update: (text: string) => stream.update(text),
				async finalize(finalText: string): Promise<{ messageId?: string } | void> {
					await stream.finalize(finalText);
					const ids = stream.messageIds();
					const last = ids[ids.length - 1];
					return last !== undefined ? { messageId: String(last) } : undefined;
				},
				stop: () => stream.stop(),
			};
		},

		/**
		 * OPTIONAL reasoning lane (default OFF). When `channels.telegram.
		 * surfaceReasoning` is true, split the raw reply's `<think>` trace out and
		 * send it as a separate `🧠 Reasoning:` message BEFORE the answer. When the
		 * config gate is off (the default) OR the reply carried no reasoning, this
		 * sends NOTHING — the answer message the pipeline sends afterward is
		 * byte-identical either way.
		 */
		async deliverReasoning(conversationId: string, rawReply: string, sendOpts?: OutboundSendOptions): Promise<void> {
			if (!connection) return;
			if (tokenInvalid || connection.isTokenInvalid()) return;
			const cfg = lastConfig;
			if (!cfg || !telegramSurfaceReasoning(cfg)) return;
			const { reasoningText } = splitTelegramReasoning(rawReply ?? "");
			if (!reasoningText) return;
			// Reuse the adapter's own chunk+HTML send path so a long reasoning trace
			// is chunked at 4096 and formatted consistently with replies.
			await adapter.sendText(conversationId, reasoningText, sendOpts);
		},

		// Telegram ids are numeric user/chat ids and @usernames, so the pairing
		// challenge card uses the "Your username" line. The bot is a SEPARATE
		// account from the operator (unlike WhatsApp), so ownership is bootstrapped
		// from the first CLI `pairing approve` — see `botIsSeparateFromOperator`.
		pairing: { idLabel: "username" as const, botIsSeparateFromOperator: true },

		// Token-based setup wizard — `brigade channels add --channel telegram`
		// prompts for the bot token and writes `channels.telegram.botToken`.
		// Proxy is intentionally NOT a wizard prompt (it's a rare, optional knob,
		// and the wizard treats every credential as required): set it directly as
		// `channels.telegram.proxy: "http://host:port"` (or `"${TG_PROXY}"`) or via
		// the `HTTPS_PROXY` / `ALL_PROXY` env var when api.telegram.org is blocked.
		setup: {
			credentialKeys: [
				{
					key: "botToken",
					prompt: "Telegram bot token (from @BotFather)",
					secret: true,
					envVar: "TELEGRAM_BOT_TOKEN",
					docsUrl: "https://core.telegram.org/bots#botfather",
				},
			],
			validateInput(key: string, value: string): string | null {
				if (key !== "botToken") return null;
				const v = value.trim();
				// @BotFather tokens look like `<digits>:<35-ish base64url chars>`.
				if (/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(v)) return null;
				// Allow a `${VAR}` ref through (resolved at runtime).
				if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(v)) return null;
				return "That doesn't look like a bot token — expected `123456:ABC-DEF…` from @BotFather.";
			},
		},

		async sendMedia(conversationId: string, media: OutboundMedia): Promise<void> {
			if (!connection) throw new Error("Telegram channel is not started");
			await connection.sendMedia(conversationId, media);
		},

		// Outbound poll. Not part of the base `ChannelAdapter` contract — exposed as
		// an extra method the plugin outbound + a typed accessor reach. Returns the
		// poll message's id (string) so the agent can later act on it.
		async sendPoll(
			conversationId: string,
			poll: TelegramPollSpec,
			opts?: OutboundSendOptions,
		): Promise<{ messageId?: string }> {
			if (!connection) throw new Error("Telegram channel is not started");
			const normalized = normalizePollSpec(poll);
			const sent = await connection.sendPoll(conversationId, normalized, {
				...(opts?.threadId !== undefined ? { threadId: opts.threadId } : {}),
			});
			return { messageId: String(sent.messageId) };
		},

		async react(conversationId: string, messageId: string, emoji: string): Promise<void> {
			if (!connection) return; // cosmetic — refuse silently when not started
			await connection.react(conversationId, messageId, emoji);
		},

		async setComposing(conversationId: string, state: "composing" | "paused"): Promise<void> {
			if (!connection) return;
			await connection.setComposing(conversationId, state);
		},

		// Static capability flags. The central `message_action` tool PRE-CHECKS the
		// relevant flag here before calling `handleAction`, so an unsupported action
		// fails cleanly without touching the adapter. Telegram supports edit
		// (editMessageText), unsend (deleteMessage), reactions (setMessageReaction),
		// reply (sendText with a thread), threads (forum topics), media, polls, and
		// the native command menu.
		capabilities: TELEGRAM_CAPABILITIES,

		// Native inline-button approvals. When a channel-routed turn raises an
		// approval, the central router calls `sendApprovalPrompt` to render the
		// question as buttons (payloads from the central codec); the press comes
		// back as `InboundMessage.callbackQuery` and is resolved centrally. A
		// pathological approval id that can't fit the 64-byte button budget falls
		// back to the text prompt (the router sends text when this throws/returns
		// without a keyboard — here we throw so the router's catch path runs).
		approvalCapability: {
			async sendApprovalPrompt(params: ChannelApprovalPromptParams): Promise<void> {
				if (!connection) throw new Error("Telegram channel is not started");
				const keyboard = buildTelegramApprovalKeyboard({ approvalId: params.approvalId });
				if (!keyboard) {
					// Too few byte-safe buttons — let the router fall back to text.
					throw new Error("telegram approval prompt: approval id too long for inline buttons");
				}
				const text = buildTelegramApprovalText({
					command: params.command,
					approvalKind: params.approvalKind,
					...(params.toolName !== undefined ? { toolName: params.toolName } : {}),
				});
				// Send with the inline keyboard via the dedicated interactive path.
				await connection.sendInteractive(params.conversationId, text, keyboard, {
					...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
				});
			},
			authorizeApprover(p): { authorized: boolean; reason?: string } {
				return resolveTelegramApprover({
					cfg: p.cfg,
					...(p.senderId !== undefined ? { senderId: p.senderId } : {}),
					...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
				});
			},
		},

		// Edit / delete / react / pin / unpin a message. The manager pre-checks the
		// capability flag (above) before calling, so an action only reaches here
		// when Telegram advertised support for it. Edit text is already sanitized +
		// HTML-formatted centrally? No — `message_action` sanitizes <think> leaks
		// but the HTML formatting is ours, so run `edit` text through the same
		// markdown→HTML converter the reply path uses.
		async handleAction(p: {
			conversationId: string;
			action: ChannelMessageAction;
			accountId?: string;
			signal?: AbortSignal;
		}): Promise<ChannelMessageActionResult> {
			if (!connection) return { ok: false, error: "Telegram channel is not started" };
			if (tokenInvalid || connection.isTokenInvalid()) {
				return { ok: false, error: "Telegram token is invalid — re-token before acting on messages." };
			}
			const a = p.action;
			try {
				switch (a.kind) {
					case "edit": {
						// Run the new text through the Telegram HTML formatter (same as
						// the reply path); fall back to plain text on a parse error.
						const html = markdownToTelegramHtml(a.text);
						if (telegramHtmlIsEmpty(html)) {
							await connection.editMessageText(p.conversationId, a.messageId, a.text);
						} else {
							try {
								await connection.editMessageText(p.conversationId, a.messageId, html, { html: true });
							} catch (err) {
								const m = err instanceof Error ? err.message : String(err);
								if (PARSE_ERROR_RE.test(m)) {
									await connection.editMessageText(p.conversationId, a.messageId, a.text);
								} else {
									throw err;
								}
							}
						}
						return { ok: true, messageId: a.messageId };
					}
					case "delete":
						await connection.deleteMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "react":
						await connection.react(p.conversationId, a.messageId, a.emoji);
						return { ok: true, messageId: a.messageId };
					case "pin":
						await connection.pinMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "unpin":
						await connection.unpinMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "reply": {
						// A reply is just a threaded send; surface the new id.
						const sent = await connection.sendText(p.conversationId, a.text, {
							...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
						});
						return { ok: true, messageId: String(sent.messageId) };
					}
					case "topic-create": {
						// Create a forum topic in this supergroup; return the new thread
						// id as messageId so the agent can immediately send into it.
						const created = await connection.createForumTopic(p.conversationId, a.name, {
							...(a.iconColor !== undefined ? { iconColor: a.iconColor } : {}),
							...(a.iconCustomEmojiId !== undefined ? { iconCustomEmojiId: a.iconCustomEmojiId } : {}),
						});
						return { ok: true, messageId: created.threadId };
					}
					case "buttons": {
						// Send a NEW message with a general inline keyboard. The button
						// data is prefixed/sanitized by the keyboard builder; a press
						// arrives as `callbackQuery` and routes through the pipeline as a
						// turn (the central approval path declines a general payload).
						const keyboard = buildTelegramInlineKeyboard(
							a.buttons.map((row) => row.map((b) => ({ text: b.text, data: b.data }))),
						);
						if (!keyboard) {
							return { ok: false, error: "no usable buttons (each needs a label + a data token ≤ ~60 bytes)" };
						}
						// Render the body to Telegram HTML like the reply path; the
						// interactive send is verbatim, so format here then mark html.
						const html = markdownToTelegramHtml(a.text);
						const useHtml = !telegramHtmlIsEmpty(html);
						const sent = await connection.sendInteractive(
							p.conversationId,
							useHtml ? html : a.text,
							keyboard,
							{
								...(useHtml ? { html: true } : {}),
								...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
							},
						);
						return { ok: true, messageId: String(sent.messageId) };
					}
					default:
						return { ok: false, error: `unsupported action kind` };
				}
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},

		selfId(): string | undefined {
			return connection?.selfId() ?? undefined;
		},

		connectedAt(): number | null {
			return connection?.connectedAt() ?? null;
		},

		feedWebhookUpdate(update: unknown): void {
			// Defensive: only dispatch a plausibly-shaped update object.
			if (!connection || !update || typeof update !== "object") return;
			connection.feedUpdate(update as never);
		},

		transportMode(): "polling" | "webhook" | "unstarted" {
			return connection ? connection.mode() : "unstarted";
		},
	};

	/**
	 * Best-effort forum-topic auto-label: on the FIRST message seen on a thread
	 * (this process), rename the topic from the message text. Fire-and-forget so
	 * it never delays inbound delivery; the connection swallows API errors.
	 */
	function maybeAutoLabelThread(conversationId: string, threadId: string, text: string): void {
		const key = `${conversationId}:${threadId}`;
		if (autoLabeledThreads.has(key)) return;
		autoLabeledThreads.add(key);
		const name = deriveTopicName(text);
		if (!name) return;
		void connection?.editForumTopic(conversationId, threadId, name);
	}

	return adapter;
}

/**
 * Synthesise the agent-facing note for an inbound reaction. The reaction itself
 * carries no text, so the note ("<who> reacted <emoji> to message <id>") is what
 * the central pipeline routes through dispatchTurn so the agent has context.
 */
export function buildReactionNote(emojis: string[], targetMessageId: string, fromName?: string): string {
	const who = fromName?.trim() || "Someone";
	const emoji = emojis.join(" ");
	return `${who} reacted ${emoji} to message ${targetMessageId}.`;
}

/** Static Telegram capability flags (shared by the legacy adapter + plugin meta). */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
	chatTypes: ["direct", "group", "thread"],
	reactions: true,
	edit: true,
	unsend: true,
	reply: true,
	threads: true,
	media: true,
	polls: true,
	nativeCommands: true,
};

/**
 * The Telegram adapter shape with its poll extension. `createTelegramAdapter`
 * returns a `ChannelAdapter`, but the concrete object ALSO carries `sendPoll`
 * (not in the base contract). Callers that want polls cast through this type.
 */
export interface TelegramAdapter extends ChannelAdapter {
	sendPoll(conversationId: string, poll: TelegramPollSpec, opts?: OutboundSendOptions): Promise<{ messageId?: string }>;
	/**
	 * Feed a raw Telegram `Update` (webhook mode). The gateway HTTP route calls
	 * this after verifying the secret-token header. No-op when not started or in
	 * polling mode. The argument is the parsed JSON body Telegram POSTed.
	 */
	feedWebhookUpdate(update: unknown): void;
	/** The transport mode this adapter's connection runs (`"polling"` | `"webhook"`). */
	transportMode(): "polling" | "webhook" | "unstarted";
}

/** Telegram allows 2–10 poll options; clamp + require a non-empty question. */
function normalizePollSpec(poll: TelegramPollSpec): TelegramPollSpec {
	const question = (poll.question ?? "").trim();
	if (!question) throw new Error("Telegram poll: a non-empty question is required.");
	const options = (poll.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 10);
	if (options.length < 2) throw new Error("Telegram poll: at least 2 options are required.");
	return {
		question: question.length > 300 ? question.slice(0, 300) : question,
		options,
		...(poll.isAnonymous !== undefined ? { isAnonymous: poll.isAnonymous } : {}),
		...(poll.allowsMultipleAnswers !== undefined ? { allowsMultipleAnswers: poll.allowsMultipleAnswers } : {}),
	};
}

/**
 * Derive a forum-topic name from a message's first line. Telegram caps topic
 * names at 128 chars; we use the first line, collapsed + trimmed, clamped to a
 * readable length. Returns "" when nothing usable remains.
 */
export function deriveTopicName(text: string): string {
	const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
	if (!firstLine) return "";
	return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

/**
 * Defensive config fallback for a direct `start()` that skipped `isConfigured`
 * (the manager always calls isConfigured first, so this is the rare path). Sync
 * + cached — `loadConfig` carries no heavy deps.
 */
async function loadStartConfig(): Promise<BrigadeConfig> {
	return loadConfig();
}
