/**
 * Slack channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the Socket Mode +
 * Web API connection. Like Telegram, Slack is TOKEN-based: the operator pastes a
 * bot token (`xoxb-…`) + an app-level token (`xapp-…`, for Socket Mode) from the
 * Slack app config, so this adapter declares a `setup` wizard (two credentials)
 * and has NO QR/link flow. Enablement is explicit — `channels.slack.enabled:
 * true` plus a resolvable bot token.
 *
 * Modeled directly on `telegram/adapter.ts`: same health-flag mirroring, same
 * deferred-media passthrough on inbound, same chunk-then-send outbound shape
 * (chunk markdown ≤8000, convert each chunk to Slack mrkdwn, send with
 * `mrkdwn: true`). Slack mrkdwn never "fails to parse" the way Telegram HTML can,
 * so the outbound path is simpler — an empty rendered chunk falls back to the
 * raw chunk, but there's no parse-error retry.
 *
 * Capabilities: edit (chat.update), unsend (chat.delete), reactions
 * (reactions.add/remove), reply (thread_ts), threads, media (files.uploadV2),
 * and Block Kit buttons. NO polls / forum-topic-create / programmatic command
 * menu (Slack slash commands are registered in the app config UI).
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { loadConfig } from "../../../core/config.js";
// Channel SDK barrel — the single import surface for the channel-authoring
// contract + shared helpers. Contract types (ChannelAdapter / ChannelHealth /
// ChannelStartContext / OutboundMedia / OutboundSendOptions) + `chunkText` come
// from one place instead of scattered paths.
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
	listSlackAccountIds,
	resolveSlackAppToken,
	resolveSlackBotToken,
	resolveSlackProxyUrl,
	slackChannelEnabled,
	slackEventsConfig,
	slackLiveStreamEnabled,
	slackStreamThrottleMs,
	slackSurfaceReasoning,
	SLACK_CHANNEL_ID,
	SLACK_DEFAULT_ACCOUNT_ID,
} from "./account-config.js";
import { buildSlackApprovalMessage } from "./approval-native.js";
import { resolveSlackApprover } from "./approval-authorize.js";
import { buildSlackInlineKeyboard } from "./blocks.js";
import { connectSlack, type ConnectSlackArgs, type SlackConnection } from "./connection.js";
import { createDraftStream } from "./draft-stream.js";
import { markdownToSlackMrkdwn, slackMrkdwnIsEmpty } from "./format.js";
import { splitSlackReasoning } from "./reasoning-lane.js";

/** Slack's practical per-message text limit (chars) for chunked sends. */
const SLACK_TEXT_LIMIT = 8_000;

/** Adapter construction options — all optional for back-compat. */
export interface CreateSlackAdapterOptions {
	/** Per-account (workspace) scope. Defaults to `"default"` (single-account). */
	accountId?: string;
	/**
	 * TEST SEAM: override how the connection is built. Production leaves this
	 * undefined and `connectSlack` lazy-loads the Slack SDKs. Tests inject a fake.
	 */
	connectImpl?: (args: ConnectSlackArgs) => Promise<SlackConnection>;
}

export function createSlackAdapter(opts: CreateSlackAdapterOptions = {}): ChannelAdapter {
	const accountId = opts.accountId?.trim() || SLACK_DEFAULT_ACCOUNT_ID;
	const connectImpl = opts.connectImpl ?? connectSlack;
	let connection: SlackConnection | null = null;
	// The ChannelStartContext doesn't carry the config, but the manager ALWAYS
	// calls `isConfigured(cfg, env)` immediately before `start(ctx)` — so we
	// capture the config + env it passed there and read the tokens from them in
	// start(). This avoids a second config load and keeps the adapter pure.
	let lastConfig: BrigadeConfig | null = null;
	let lastEnv: NodeJS.ProcessEnv = process.env;
	// Health flags mirrored from the connection lifecycle so health() never has to
	// round-trip Slack on the hot path (cron timer / send pre-flight).
	//   - `connected` flips true on a successful auth.test + socket start.
	//   - `tokenInvalid` is STICKY: an auth error means the token is dead and the
	//     only recovery is `brigade channels add --channel slack` with new tokens.
	let connected = false;
	let tokenInvalid = false;

	const adapter: SlackAdapter = {
		id: SLACK_CHANNEL_ID,
		label: "Slack",

		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean {
			// Capture for start() — the manager calls this right before start(ctx).
			lastConfig = cfg;
			lastEnv = env ?? process.env;
			if (!slackChannelEnabled(cfg)) return false;
			// Need a resolvable bot token (config `${VAR}` ref or SLACK_BOT_TOKEN env).
			if (!resolveSlackBotToken(cfg, accountId, env ?? process.env)) return false;
			// Socket mode additionally needs an app-level token; events mode does not
			// (it verifies the signing secret on the HTTP route instead).
			if (slackEventsConfig(cfg).mode === "socket" && !resolveSlackAppToken(cfg, accountId, env ?? process.env)) {
				return false;
			}
			// Multi-workspace follow-up: when the operator declares >1 account, the
			// plugin path owns lifecycle and the legacy single adapter steps aside.
			const isLegacyAdapter = accountId === SLACK_DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listSlackAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			// Resolve the tokens from the config the manager handed isConfigured().
			// Fall back to a fresh load defensively (e.g. a direct start() in a test
			// that skipped isConfigured).
			const cfg = lastConfig ?? (await loadStartConfig());
			const botToken = resolveSlackBotToken(cfg, accountId, lastEnv);
			if (!botToken) {
				ctx.log("Slack not started — no bot token resolved (set channels.slack.botToken or SLACK_BOT_TOKEN).");
				return;
			}
			const transport = slackEventsConfig(cfg);
			const appToken = resolveSlackAppToken(cfg, accountId, lastEnv);
			if (transport.mode === "socket" && !appToken) {
				ctx.log("Slack not started — socket mode needs an app-level token (set channels.slack.appToken or SLACK_APP_TOKEN).");
				return;
			}
			// Optional proxy — routes the Web API + Socket Mode websocket through it
			// on networks where slack.com is blocked. Empty → direct (unchanged).
			const proxyUrl = resolveSlackProxyUrl(cfg, accountId, lastEnv);
			connection = await connectImpl({
				botToken,
				...(appToken ? { appToken } : {}),
				...(proxyUrl ? { proxyUrl } : {}),
				accountId,
				mode: transport.mode,
				log: ctx.log,
				onConnected: () => {
					connected = true;
					tokenInvalid = false;
					ctx.log("Slack ready");
					ctx.onConnected?.();
				},
				onTokenInvalid: () => {
					connected = false;
					tokenInvalid = true;
					ctx.log(
						"Slack token was rejected. Run `brigade channels add --channel slack` with a fresh bot + app token.",
					);
					ctx.onLoggedOut?.();
				},
				onMessage: (msg) => {
					void ctx.onInbound({
						channel: SLACK_CHANNEL_ID,
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
						teamId: msg.teamId,
						mentions: msg.mentions,
						replyTo: msg.replyTo,
						// Edit provenance rides through so the central pipeline / agent see
						// "this was an edit".
						...(msg.edited ? { edited: true } : {}),
						// Deferred media thunk rides through untouched — the pipeline
						// resolves it only after the access gate admits the sender.
						resolveMedia: msg.resolveMedia,
						raw: msg.raw,
					});
				},
				// Inbound reaction → synthesise a short note and route it through the
				// SAME inbound pipeline as a normal message so the access gate + routing
				// apply uniformly. The note carries the added emoji(s) + the target id.
				onReaction: (msg) => {
					if (!msg.reaction) return;
					const note = buildReactionNote(msg.reaction.emojis, msg.reaction.targetMessageId, msg.fromName);
					void ctx.onInbound({
						channel: SLACK_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						from: msg.from,
						...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
						text: note,
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
						...(msg.teamId !== undefined ? { teamId: msg.teamId } : {}),
						reaction: msg.reaction,
						raw: msg.raw,
					});
				},
				// Block-action press → emit an InboundMessage carrying `callbackQuery` so
				// the central pipeline's approval-callback path resolves it. The
				// connection has already acked the press.
				onCallbackQuery: (msg) => {
					if (!msg.callbackQuery) return;
					void ctx.onInbound({
						channel: SLACK_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						from: msg.from,
						...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
						text: "",
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
						...(msg.teamId !== undefined ? { teamId: msg.teamId } : {}),
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
		 *   - `{ ok: true }` once the socket is live.
		 *   - `{ ok: false, kind: "logged-out" }` after an auth error (sticky; re-token).
		 *   - `{ ok: false, kind: "starting" }` between start() and first connect.
		 *   - `{ ok: false, kind: "disconnected" }` for a transient drop mid-reconnect.
		 */
		health(): ChannelHealth {
			if (tokenInvalid || connection?.isTokenInvalid()) {
				return {
					ok: false,
					kind: "logged-out",
					reason: "Slack token was rejected — Brigade can't send until a new token is set.",
					remediation: "Run `brigade channels add --channel slack` and paste a fresh bot + app token.",
				};
			}
			if (!connection) {
				return { ok: false, kind: "starting", reason: "Slack adapter is not started yet." };
			}
			if (!connected || !connection.isConnected()) {
				return {
					ok: false,
					kind: "disconnected",
					reason: "Slack is reconnecting — sends will fail until the socket resumes.",
				};
			}
			return { ok: true };
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<void> {
			if (!connection) throw new Error("Slack channel is not started");
			if (tokenInvalid || connection.isTokenInvalid()) {
				throw new Error("Slack token is invalid — run `brigade channels add --channel slack` with a new token, then retry.");
			}
			const threadId = opts?.threadId;
			// Native reply target (Slack thread_ts). Applied to the FIRST chunk only —
			// threading every chunk of a long reply is redundant once the first lands
			// in the thread. Omitted → unthreaded send (unchanged).
			const replyToMessageId = opts?.replyToId;
			const sendExtras: { threadId?: string; linkPreview?: boolean } = {};
			if (threadId) sendExtras.threadId = threadId;
			if (opts?.linkPreview !== undefined) sendExtras.linkPreview = opts.linkPreview;
			// Chunk on the RAW markdown so fences/paragraphs aren't shredded, then
			// convert each chunk to Slack mrkdwn and send with `mrkdwn: true`. A chunk
			// whose rendered mrkdwn is empty (syntax-only) is re-sent as the raw chunk.
			const chunks = chunkText(text, { limit: SLACK_TEXT_LIMIT });
			let first = true;
			for (const chunk of chunks) {
				// Only the first chunk carries the reply thread target.
				const replyOpt = first && replyToMessageId ? { replyToMessageId } : {};
				const mrkdwn = markdownToSlackMrkdwn(chunk);
				const body = slackMrkdwnIsEmpty(mrkdwn) ? chunk : mrkdwn;
				if (body.trim().length === 0) continue;
				await connection.sendText(conversationId, body, { ...sendExtras, ...replyOpt });
				first = false;
			}
		},

		/**
		 * Open a LIVE reply stream — the gateway feeds the accumulating answer text
		 * via `update()`, this edits one Slack message in place (throttled ~1×/sec),
		 * and `finalize()` settles it on turn end. Returns `null` when streaming is
		 * disabled in config (`channels.slack.liveStream` is not true) OR the
		 * connection isn't live, so the pipeline falls back to the single final
		 * `sendText` — byte-unchanged from before streaming existed.
		 *
		 * Each draft chunk is rendered through the SAME markdown→mrkdwn converter the
		 * final path uses. When the running answer exceeds the limit the stream
		 * finalizes the current message at a boundary and rolls overflow into a new
		 * message.
		 */
		beginReplyStream(conversationId: string, sendOpts?: OutboundSendOptions): ChannelReplyStream | null {
			if (!connection) return null;
			if (tokenInvalid || connection.isTokenInvalid()) return null;
			const cfg = lastConfig;
			if (!cfg || !slackLiveStreamEnabled(cfg)) return null;
			const conn = connection;
			const threadId = sendOpts?.threadId;
			const stream = createDraftStream({
				transport: {
					async postMessage(text, o): Promise<{ ts: string }> {
						const sent = await conn.sendText(conversationId, text, {
							...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
						});
						return { ts: sent.messageId };
					},
					async updateMessage(ts, text): Promise<void> {
						await conn.editMessageText(conversationId, ts, text);
					},
				},
				...(threadId !== undefined ? { threadId } : {}),
				throttleMs: slackStreamThrottleMs(cfg),
				maxChars: SLACK_TEXT_LIMIT,
				// Render each draft chunk to Slack mrkdwn; fall back to the plain chunk
				// when the mrkdwn is empty (syntax-only).
				renderText: (chunk) => {
					const mrkdwn = markdownToSlackMrkdwn(chunk);
					return { text: slackMrkdwnIsEmpty(mrkdwn) ? chunk : mrkdwn };
				},
			});
			return {
				update: (text: string) => stream.update(text),
				async finalize(finalText: string): Promise<{ messageId?: string } | void> {
					await stream.finalize(finalText);
					const ids = stream.messageIds();
					const last = ids[ids.length - 1];
					return last !== undefined ? { messageId: last } : undefined;
				},
				stop: () => stream.stop(),
			};
		},

		/**
		 * OPTIONAL reasoning lane (default OFF). When `channels.slack.
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
			if (!cfg || !slackSurfaceReasoning(cfg)) return;
			const { reasoningText } = splitSlackReasoning(rawReply ?? "");
			if (!reasoningText) return;
			// Reuse the adapter's own chunk+mrkdwn send path so a long reasoning trace
			// is chunked at 8000 and formatted consistently with replies.
			await adapter.sendText(conversationId, reasoningText, sendOpts);
		},

		// Slack ids are workspace user ids (`U…`); the pairing challenge card uses
		// the "Your username" line. The bot is a SEPARATE account from the operator
		// (its own app), so ownership is bootstrapped from the first CLI `pairing
		// approve` — see `botIsSeparateFromOperator`.
		pairing: { idLabel: "username" as const, botIsSeparateFromOperator: true },

		// Token-based setup wizard — `brigade channels add --channel slack` prompts
		// for the bot token + app token and writes `channels.slack.botToken` /
		// `channels.slack.appToken`. The signing secret (events mode only) is set
		// directly as `channels.slack.signingSecret` when the operator switches to
		// the HTTP transport.
		setup: {
			credentialKeys: [
				{
					key: "botToken",
					prompt: "Slack bot token (xoxb-…, from the app's OAuth & Permissions page)",
					secret: true,
					envVar: "SLACK_BOT_TOKEN",
					docsUrl: "https://api.slack.com/authentication/token-types#bot",
				},
				{
					key: "appToken",
					prompt: "Slack app-level token (xapp-…, for Socket Mode — Basic Information → App-Level Tokens)",
					secret: true,
					envVar: "SLACK_APP_TOKEN",
					docsUrl: "https://api.slack.com/apis/connections/socket#token",
				},
			],
			validateInput(key: string, value: string): string | null {
				const v = value.trim();
				// Allow a `${VAR}` ref through (resolved at runtime).
				if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(v)) return null;
				if (key === "botToken") {
					if (/^xoxb-[A-Za-z0-9-]{10,}$/.test(v)) return null;
					return "That doesn't look like a bot token — expected `xoxb-…` from the app's OAuth page.";
				}
				if (key === "appToken") {
					if (/^xapp-[A-Za-z0-9-]{10,}$/.test(v)) return null;
					return "That doesn't look like an app-level token — expected `xapp-…` for Socket Mode.";
				}
				return null;
			},
		},

		async sendMedia(conversationId: string, media: OutboundMedia): Promise<void> {
			if (!connection) throw new Error("Slack channel is not started");
			await connection.sendMedia(conversationId, media);
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
		// fails cleanly without touching the adapter. Slack supports edit
		// (chat.update), unsend (chat.delete), reactions (reactions.add/remove),
		// reply (thread_ts), threads, and media (files.uploadV2).
		capabilities: SLACK_CAPABILITIES,

		// Native Block Kit button approvals. When a channel-routed turn raises an
		// approval, the central router calls `sendApprovalPrompt` to render the
		// question as buttons (payloads from the central codec); the press comes
		// back as `InboundMessage.callbackQuery` and is resolved centrally. A
		// pathological approval id that can't be encoded falls back to the text
		// prompt (the router sends text when this throws).
		approvalCapability: {
			async sendApprovalPrompt(params: ChannelApprovalPromptParams): Promise<void> {
				if (!connection) throw new Error("Slack channel is not started");
				const message = buildSlackApprovalMessage({
					approvalId: params.approvalId,
					command: params.command,
					approvalKind: params.approvalKind,
					...(params.toolName !== undefined ? { toolName: params.toolName } : {}),
				});
				if (!message) {
					// Couldn't build byte-safe buttons — let the router fall back to text.
					throw new Error("slack approval prompt: approval id too long for buttons");
				}
				// Send the fallback text + Block Kit blocks via the interactive path.
				await connection.sendInteractive(params.conversationId, message.text, message.blocks, {
					...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
				});
			},
			authorizeApprover(p): { authorized: boolean; reason?: string } {
				return resolveSlackApprover({
					cfg: p.cfg,
					...(p.senderId !== undefined ? { senderId: p.senderId } : {}),
					...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
				});
			},
		},

		// Edit / delete / react / reply a message + attach buttons. The manager
		// pre-checks the capability flag (above) before calling, so an action only
		// reaches here when Slack advertised support for it.
		async handleAction(p: {
			conversationId: string;
			action: ChannelMessageAction;
			accountId?: string;
			signal?: AbortSignal;
		}): Promise<ChannelMessageActionResult> {
			if (!connection) return { ok: false, error: "Slack channel is not started" };
			if (tokenInvalid || connection.isTokenInvalid()) {
				return { ok: false, error: "Slack token is invalid — re-token before acting on messages." };
			}
			const a = p.action;
			try {
				switch (a.kind) {
					case "edit": {
						// Run the new text through the Slack mrkdwn formatter (same as the
						// reply path); fall back to the raw text when it renders empty.
						const mrkdwn = markdownToSlackMrkdwn(a.text);
						const body = slackMrkdwnIsEmpty(mrkdwn) ? a.text : mrkdwn;
						await connection.editMessageText(p.conversationId, a.messageId, body);
						return { ok: true, messageId: a.messageId };
					}
					case "delete":
						await connection.deleteMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "react":
						// An EMPTY emoji means "clear" (parity with WhatsApp/Telegram). Slack
						// has no blanket clear + multiple reactions per message, so clear =
						// remove the bot's OWN reactions on this message; a non-empty emoji
						// adds as before.
						if (a.emoji.trim() === "") {
							await connection.removeOwnReactions(p.conversationId, a.messageId);
						} else {
							await connection.react(p.conversationId, a.messageId, a.emoji);
						}
						return { ok: true, messageId: a.messageId };
					case "reply": {
						// A reply is just a threaded send; surface the new id.
						const sent = await connection.sendText(p.conversationId, a.text, {
							...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
						});
						return { ok: true, messageId: sent.messageId };
					}
					case "buttons": {
						// Send a NEW message with a general Block Kit keyboard. The button
						// values are prefixed/sanitized by the builder; a press arrives as
						// `callbackQuery` and routes through the pipeline as a turn (the
						// central approval path declines a general payload).
						const blocks = buildSlackInlineKeyboard(
							a.buttons.map((row) => row.map((b) => ({ text: b.text, data: b.data }))),
						);
						if (!blocks) {
							return { ok: false, error: "no usable buttons (each needs a label + a data token ≤ 255 chars)" };
						}
						// Render the body to mrkdwn like the reply path; the interactive send
						// is verbatim, so format here.
						const mrkdwn = markdownToSlackMrkdwn(a.text);
						const body = slackMrkdwnIsEmpty(mrkdwn) ? a.text : mrkdwn;
						const sent = await connection.sendInteractive(p.conversationId, body, blocks, {
							...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
						});
						return { ok: true, messageId: sent.messageId };
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

		lastEventAt(): number | null {
			return connection?.lastEventAt() ?? null;
		},

		feedWebhookEvent(kind: "event" | "interactive" | "slash", payload: unknown): void {
			// Defensive: only dispatch a plausibly-shaped payload object.
			if (!connection || !payload || typeof payload !== "object") return;
			connection.feedEvent(kind, payload);
		},

		transportMode(): "socket" | "events" | "unstarted" {
			return connection ? connection.mode() : "unstarted";
		},
	};

	return adapter;
}

/**
 * Synthesise the agent-facing note for an inbound reaction. The reaction itself
 * carries no text, so the note ("<who> reacted :emoji: to message <id>") is what
 * the central pipeline routes through dispatchTurn so the agent has context.
 */
export function buildReactionNote(emojis: string[], targetMessageId: string, fromName?: string): string {
	const who = fromName?.trim() || "Someone";
	const emoji = emojis.map((e) => `:${e}:`).join(" ");
	return `${who} reacted ${emoji} to message ${targetMessageId}.`;
}

/** Static Slack capability flags (shared by the legacy adapter + plugin meta). */
export const SLACK_CAPABILITIES: ChannelCapabilities = {
	chatTypes: ["direct", "group", "thread"],
	reactions: true,
	edit: true,
	unsend: true,
	reply: true,
	threads: true,
	media: true,
};

/**
 * The Slack adapter shape with its webhook + transport extensions. `createSlack
 * Adapter` returns a `ChannelAdapter`, but the concrete object ALSO carries
 * `feedWebhookEvent` + `transportMode` (not in the base contract). Callers that
 * need them cast through this type.
 */
export interface SlackAdapter extends ChannelAdapter {
	/**
	 * Feed a raw Slack payload (events-API mode). The gateway HTTP route calls
	 * this after verifying the signing-secret signature. No-op when not started or
	 * in socket mode. `kind` selects the event family.
	 */
	feedWebhookEvent(kind: "event" | "interactive" | "slash", payload: unknown): void;
	/** The transport mode this adapter's connection runs (`"socket"` | `"events"`). */
	transportMode(): "socket" | "events" | "unstarted";
	/**
	 * Epoch ms of the most recent inbound event (liveness diagnostic), or null
	 * before the first event / when not started. Observability only — never flips
	 * health to "down" (a quiet channel is legitimately idle).
	 */
	lastEventAt(): number | null;
}

/**
 * Defensive config fallback for a direct `start()` that skipped `isConfigured`
 * (the manager always calls isConfigured first, so this is the rare path).
 */
async function loadStartConfig(): Promise<BrigadeConfig> {
	return loadConfig();
}
