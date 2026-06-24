/**
 * Slack connection (Socket Mode inbound + Web API outbound).
 *
 * The Brigade analogue of `telegram/connection.ts`, distilled to Slack's two
 * SDKs. `@slack/web-api` (`WebClient`) drives every OUTBOUND call (post / update
 * / delete / react / upload / open-DM); `@slack/socket-mode`
 * (`SocketModeClient`) opens the INBOUND events websocket (no public URL needed
 * — the local-first default, analogous to Telegram long-polling). Both are
 * lazy-imported here (`await import(...)` inside `connectSlack`) so a non-Slack
 * boot never pays for them. Types are `type`-only so the static import never
 * pulls the runtime in.
 *
 * Lifecycle:
 *   - `auth.test()` BOOTSTRAPS the connection — it both proves the bot token
 *     (an `invalid_auth` surfaces here → terminal) and caches the bot's
 *     `user_id` + `team_id` (the group ACL needs the bot's own user id to detect
 *     `<@bot>` mentions + to filter the bot's own echoes; without it group
 *     messages never reach the agent and the bot could reply to itself).
 *   - The SocketModeClient subscribes message / app_mention / reaction /
 *     interactive (block_actions) / slash_commands events. Each handler ACKs the
 *     envelope FIRST (Slack redelivers an un-acked event), then normalizes the
 *     payload into a `SlackInboundMessage` and routes it via `onMessage` /
 *     `onCallbackQuery` / `onReaction`. File bytes are downloaded via a DEFERRED
 *     `resolveMedia` thunk — only after the central access gate admits the
 *     sender (mirrors WhatsApp/Telegram).
 *   - The SocketModeClient auto-reconnects internally; we SUPERVISE the initial
 *     `.start()` with the SAME backoff curve as Telegram (2s → 30s, ×1.8, ±25%)
 *     and go terminal on an auth error (the only fix is a new token).
 *   - Events are de-duplicated by `ts` / `client_msg_id` (a redelivered envelope
 *     after a reconnect must not double-run the agent).
 *
 * Two transport modes share ONE normalize + dedupe + dispatch surface: Socket
 * Mode (default) and Events API (HTTP webhook). The webhook route calls
 * {@link SlackConnection.feedEvent} with each POSTed event, which runs the same
 * handlers the socket uses.
 */

import {
	chunkText,
	createDedupeCache,
	nextBackoffDelay,
	type InboundMediaAttachment,
	type InboundReplyContext,
	type OutboundMedia,
} from "../sdk.js";
import {
	buildSlackSenderName,
	expandSlackTokens,
	extractSlackMentions,
	extractSlackReplyContext,
	extractSlackText,
	hasInboundMedia,
	resolveInboundFiles,
	slackChannelType,
	slackThreadId,
	unescapeSlackEntities,
	type SlackMessageEvent,
	type SlackReactionEvent,
} from "./inbound-extras.js";
import { maskProxyUrl } from "./account-config.js";
import { downloadSlackFile, uploadSlackFile, type SlackUploadApi } from "./media.js";
import { buildSlackProxyAgent } from "./proxy-agent.js";
import { createSlackUserDirectory, type SlackUserDirectory } from "./user-directory.js";

/* ───────────────────────── reconnect backoff ───────────────────────── */
// Shares the neutral `nextBackoffDelay` curve with every other channel (see
// `channels/backoff.ts`), tuned to the SAME schedule WhatsApp + Telegram use
// (2s → 30s, ×1.8, ±25%). The constants live here so Slack owns its own knobs;
// the arithmetic is the shared helper's.

const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

/**
 * Jittered exponential backoff for reconnect attempt `attempt` (0-based). Thin
 * wrapper over the neutral `nextBackoffDelay` helper — kept as a named export so
 * `index.ts` and the connection tests have a stable entry point.
 */
export function slackBackoffDelay(attempt: number): number {
	return nextBackoffDelay({
		attempt,
		initialMs: RECONNECT_INITIAL_MS,
		maxMs: RECONNECT_MAX_MS,
		factor: RECONNECT_FACTOR,
		jitter: RECONNECT_JITTER,
	});
}

/** Slack's hard limit on a single message body is 40k; we chunk well under it. */
const SLACK_MESSAGE_LIMIT = 8_000;

/**
 * Emoji reacted onto the user's last message as a "working…" affordance. Slack
 * has no bot typing-indicator API, so `setComposing` emulates it with this
 * reaction (added while the agent works, removed when idle) — same trick the
 * reference Slack channel uses.
 */
const TYPING_REACTION = "hourglass_flowing_sand";

/**
 * Thread-history backfill bounds. When the bot is @-mentioned into a
 * pre-existing thread it has the parent ts but none of the prior text, so the
 * first inbound on that thread fetches up to {@link THREAD_BACKFILL_LIMIT}
 * messages via `conversations.replies` and folds the ones PRECEDING the current
 * message into `replyTo.body` as a compact excerpt. The excerpt is hard-capped
 * at {@link THREAD_BACKFILL_MAX_CHARS} so a long thread can't blow up the prompt
 * (the central pipeline ALSO slices `replyTo.body` to 200, but we bound here too
 * so we never carry more than needed). Best-effort: any fetch error is swallowed
 * and delivery proceeds with `body` undefined.
 */
const THREAD_BACKFILL_LIMIT = 15;
const THREAD_BACKFILL_MAX_CHARS = 1_200;

/* ───────────────────────── normalized inbound shape ───────────────────────── */

/** A normalized inbound Slack message (text and/or files). Mirrors `TgInboundMessage`. */
export interface SlackInboundMessage {
	/** Channel id as a string — the conversation id. */
	conversationId: string;
	/** Slack message `ts` — surfaces for reply / edit / delete targeting. */
	messageId?: string;
	/** When Slack stamped the message (epoch ms, derived from `ts`). */
	messageTimestampMs?: number;
	/** Sender id within the workspace — the user id (`U…`). */
	from: string;
	/** Sender display name (the user id today; resolved names need a `users.info`). */
	fromName?: string;
	/** Plain message text (token-expanded, entity-unescaped). May be empty for files. */
	text: string;
	/** `direct` (im) or `group` (mpim/channel/group). */
	chatType: "direct" | "group";
	/** Workspace (team) id this message arrived in — feeds the route resolver's team tier. */
	teamId?: string;
	/** Thread parent `ts` as a string, when the message belongs to a thread. */
	threadId?: string;
	/** User ids `<@…>`-mentioned (incl. the bot's own id when addressed). */
	mentions?: string[];
	/** Quoted-reply context, when this message is a threaded reply. */
	replyTo?: InboundReplyContext;
	/**
	 * DEFERRED media download. The connection layer does NOT download eagerly —
	 * the pipeline invokes this ONLY after the access gate admits the sender, so a
	 * blocked stranger's file is never fetched. Resolves to an empty array for
	 * text-only messages.
	 */
	resolveMedia?: () => Promise<InboundMediaAttachment[]>;
	/**
	 * Inline-button callback context — present ONLY when this inbound is a
	 * `block_actions` press rather than a typed message. `data` is the opaque
	 * payload the pressed button declared at send time (an approval-callback codec
	 * string OR a general-prefixed token); `callbackId` is unused by Slack (the
	 * press is acked by the socket handler before routing) but carried for parity
	 * with the central pipeline's `callbackQuery` shape. Undefined for ordinary
	 * messages.
	 */
	callbackQuery?: { data: string; callbackId: string };
	/** True when this inbound is a `message_changed` edit (text carries the NEW text). */
	edited?: boolean;
	/**
	 * Inbound reaction context — present ONLY when this inbound is a
	 * `reaction_added` event. `emojis` are the newly-added reaction emoji(s);
	 * `targetMessageId` is the message they landed on. Undefined for typed messages.
	 */
	reaction?: { emojis: string[]; targetMessageId: string };
	/** Raw Slack event (for adapters that need more). */
	raw: unknown;
}

/* ───────────────────────── injectable Slack surfaces ───────────────────────── */

/** A Slack API response envelope (`ok` + optional `error` code + data). */
type SlackApiResponse = { ok?: boolean; error?: string; [key: string]: unknown };

/**
 * The minimal slice of `@slack/web-api`'s `WebClient` the connection drives.
 * Declared as an interface (rather than importing the concrete class) so tests
 * can inject a fake with zero network — the runtime path builds a real
 * `WebClient` and it structurally satisfies this shape.
 */
export interface SlackWebClientLike extends SlackUploadApi {
	auth: {
		test(): Promise<SlackApiResponse & { user_id?: string; user?: string; team_id?: string; team?: string; bot_id?: string }>;
	};
	// Optional so the many test fakes that don't drive name-resolution still
	// satisfy this shape; the real `WebClient` always provides it.
	users?: {
		info(args: {
			user: string;
		}): Promise<SlackApiResponse & { user?: { id?: string; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>;
	};
	chat: {
		postMessage(args: Record<string, unknown>): Promise<SlackApiResponse & { ts?: string; channel?: string }>;
		update(args: Record<string, unknown>): Promise<SlackApiResponse & { ts?: string }>;
		delete(args: Record<string, unknown>): Promise<SlackApiResponse>;
	};
	reactions: {
		add(args: Record<string, unknown>): Promise<SlackApiResponse>;
		remove(args: Record<string, unknown>): Promise<SlackApiResponse>;
		/**
		 * Read the reactions on a message (each carries the emoji `name` + the
		 * `users` who added it). Used by `removeOwnReactions` to find which
		 * reactions the bot itself placed so a "clear" can remove them — Slack
		 * `reactions.remove` needs a specific name, so there's no blanket clear.
		 * Optional so test fakes that don't drive reaction-clear still satisfy this
		 * shape; the real `WebClient` always provides it.
		 */
		get?(args: {
			channel: string;
			timestamp: string;
		}): Promise<SlackApiResponse & { message?: { reactions?: Array<{ name?: string; users?: string[] }> } }>;
	};
	conversations: {
		open(args: Record<string, unknown>): Promise<SlackApiResponse & { channel?: { id?: string } }>;
		/**
		 * Fetch the messages of a thread (the parent + its replies). Used by the
		 * thread-history backfill: when the bot is @-mentioned INTO a pre-existing
		 * thread it sees only the parent ts, so this pulls the prior messages to
		 * give the agent the conversation it just walked into. Optional so the many
		 * test fakes that don't drive backfill still satisfy this shape; the real
		 * `WebClient` always provides it.
		 */
		replies?(args: {
			channel: string;
			ts: string;
			limit?: number;
		}): Promise<SlackApiResponse & { messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }> }>;
	};
}

/** A handler payload the SocketModeClient delivers for an events_api event. */
export interface SocketEventArgs {
	ack: (response?: unknown) => Promise<void>;
	body?: { team_id?: string; event?: SlackMessageEvent | SlackReactionEvent; [key: string]: unknown };
	event?: SlackMessageEvent | SlackReactionEvent;
	retry_num?: number;
}

/** A handler payload the SocketModeClient delivers for an `interactive` event. */
export interface SocketInteractiveArgs {
	ack: (response?: unknown) => Promise<void>;
	body?: SlackInteractivePayload;
}

/** A handler payload the SocketModeClient delivers for a `slash_commands` event. */
export interface SocketSlashArgs {
	ack: (response?: unknown) => Promise<void>;
	body?: SlackSlashCommandPayload;
}

/** A `block_actions` interactive payload (the subset Brigade reads). */
export interface SlackInteractivePayload {
	type?: string;
	team?: { id?: string };
	user?: { id?: string; name?: string; username?: string };
	channel?: { id?: string };
	message?: { ts?: string; thread_ts?: string };
	actions?: Array<{ action_id?: string; value?: string; block_id?: string }>;
	[key: string]: unknown;
}

/** A `slash_commands` payload (the subset Brigade reads). */
export interface SlackSlashCommandPayload {
	command?: string;
	text?: string;
	user_id?: string;
	user_name?: string;
	channel_id?: string;
	team_id?: string;
	[key: string]: unknown;
}

/**
 * The minimal slice of `@slack/socket-mode`'s `SocketModeClient` the connection
 * drives — an EventEmitter with `.on(eventName, handler)`, `.start()`, and
 * `.disconnect()`. Declared as an interface so tests inject a fake emitter.
 */
export interface SlackSocketClientLike {
	on(event: string, handler: (args: never) => unknown): void;
	start(): Promise<unknown>;
	disconnect(): Promise<unknown> | unknown;
}

export interface ConnectSlackArgs {
	/** Bot user token (`xoxb-…`). NEVER logged. Every Web API call uses it. */
	botToken: string;
	/** App-level token (`xapp-…`) for Socket Mode. Required in socket mode. NEVER logged. */
	appToken?: string;
	/** Account namespace stamped on inbounds (single-account → "default"). */
	accountId?: string;
	/**
	 * Transport mode. `"socket"` (default, local-first — Socket Mode needs no
	 * public URL) drives the events websocket; `"events"` builds the WebClient
	 * but does NOT open a socket — the gateway HTTP route feeds events in via
	 * {@link SlackConnection.feedEvent}. Defaults to socket.
	 */
	mode?: "socket" | "events";
	/**
	 * Optional proxy URL all Slack API calls (+ the Socket Mode websocket) route
	 * through. Use it on networks where `slack.com` is blocked. Form:
	 * `http(s)://[user:pass@]host:port` for an HTTP CONNECT proxy, or
	 * `socks5://[user:pass@]host:port` (also `socks://` / `socks4://` /
	 * `socks5h://`) for a SOCKS proxy. When omitted/empty the connection is DIRECT
	 * (unchanged default). HTTP(S) proxies use `https-proxy-agent`; SOCKS proxies
	 * use `socks-proxy-agent` (see `proxy-agent.ts`).
	 */
	proxyUrl?: string;
	/** Called once `auth.test` succeeds and the socket connects. */
	onConnected?: () => void;
	/** Called when the token is rejected (invalid_auth) — terminal, re-token required. */
	onTokenInvalid?: () => void;
	/** Called for every inbound message. */
	onMessage: (msg: SlackInboundMessage) => void;
	/**
	 * Called for every inbound `block_actions` press. The socket handler has
	 * ALREADY acked the press before this fires, so the handler only routes the
	 * normalized inbound (which carries `callbackQuery: { data, callbackId }`).
	 * Optional — when omitted, presses are still acked + deduped but not routed.
	 */
	onCallbackQuery?: (msg: SlackInboundMessage) => void;
	/**
	 * Called for every inbound `reaction_added`. The normalized inbound carries
	 * `reaction: { emojis, targetMessageId }` and no text. Optional — when
	 * omitted, reaction events are deduped but not routed.
	 */
	onReaction?: (msg: SlackInboundMessage) => void;
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/**
	 * TEST SEAM: supply the WebClient + SocketModeClient instead of building real
	 * ones. Production leaves these undefined and the SDKs are lazy-imported. The
	 * second `agent` arg is the resolved proxy agent (undefined for a direct
	 * connection) — production threads it into the real `WebClient` /
	 * `SocketModeClient`; a test fake can assert it was handed the agent.
	 */
	webClientFactory?: (botToken: string, agent?: unknown) => SlackWebClientLike;
	socketModeFactory?: (appToken: string, agent?: unknown) => SlackSocketClientLike;
	/**
	 * TEST SEAM: override how the proxy agent is built from `proxyUrl`. Production
	 * leaves this undefined and `buildSlackProxyAgent` lazy-imports the proxy-agent
	 * packages. Lets a test assert the resolver ran without a real proxy.
	 */
	proxyAgentFactory?: (proxyUrl: string) => Promise<unknown>;
	/** TEST SEAM: skip the real backoff sleep so reconnect tests run instantly. */
	sleepImpl?: (ms: number) => Promise<void>;
}

export interface SlackConnection {
	/** The bot's user id once connected, else null (the self id for mention/echo detection). */
	selfId(): string | null;
	/** The bot's @handle once connected, else null. */
	selfName(): string | null;
	/** The workspace (team) id once connected, else null. */
	teamId(): string | null;
	/** Epoch ms of the most recent successful connect, else null. */
	connectedAt(): number | null;
	/**
	 * Epoch ms of the most recent INBOUND event of any kind (message / reaction /
	 * interactive / slash, via socket OR webhook), else null. Liveness signal: a
	 * socket can read "connected" while silently dead, so a stale `lastEventAt`
	 * surfaces a half-dead connection. Observability only — a quiet channel is
	 * legitimately idle, so this NEVER flips health to "down".
	 */
	lastEventAt(): number | null;
	/** True once `auth.test` has succeeded and the socket is live. */
	isConnected(): boolean;
	/** True once an auth error marked the token terminally invalid. */
	isTokenInvalid(): boolean;
	/** Send a single text message. Returns the posted message's `ts`. */
	sendText(channel: string, text: string, opts?: SlackSendTextOpts): Promise<{ messageId: string }>;
	/**
	 * Send a message carrying Block Kit `blocks` (the native approval prompt /
	 * general buttons). `text` is the fallback; `blocks` is an opaque Block Kit
	 * array. Text is sent verbatim (no markdown→mrkdwn pass) so the caller
	 * controls formatting.
	 */
	sendInteractive(channel: string, text: string, blocks: unknown, opts?: SlackSendTextOpts): Promise<{ messageId: string }>;
	/** Upload a media attachment via files.uploadV2. */
	sendMedia(channel: string, media: OutboundMedia, opts?: SlackSendMediaOpts): Promise<void>;
	/** React to a previous message with an emoji name (no colons). */
	react(channel: string, messageId: string, emoji: string): Promise<void>;
	/** Remove a reaction from a message. Best-effort. */
	removeReaction(channel: string, messageId: string, emoji: string): Promise<void>;
	/**
	 * Remove EVERY reaction the bot itself placed on a message. Slack has no
	 * blanket "clear reactions" call (and a non-bot user's reactions aren't ours
	 * to touch), so this reads `reactions.get`, finds the reactions whose `users`
	 * include the bot's own id, and `reactions.remove`s each. Best-effort: a
	 * missing slice / fetch error / `no_reaction` is swallowed. This is what the
	 * central `message_action` "react" with an EMPTY emoji maps to (parity with
	 * WhatsApp/Telegram, where empty = clear).
	 */
	removeOwnReactions(channel: string, messageId: string): Promise<void>;
	/** Edit a previously-sent message's text. */
	editMessageText(channel: string, messageId: string, text: string, opts?: SlackSendTextOpts): Promise<void>;
	/** Delete a message. */
	deleteMessage(channel: string, messageId: string): Promise<void>;
	/** Open (or resolve) a DM channel with a user; returns the DM channel id. */
	openDirectMessage(userId: string): Promise<string>;
	/**
	 * Feed a raw Slack event envelope into the inbound path (events-API mode).
	 * Dispatches to the SAME handlers the socket uses, so webhook + socket share
	 * one normalize + dedupe surface. The `kind` selects the handler family.
	 */
	feedEvent(kind: "event" | "interactive" | "slash", payload: unknown): void;
	/** The transport mode this connection runs (`"socket"` | `"events"`). */
	mode(): "socket" | "events";
	/** Signal typing — emulated with a ⏳ reaction on the user's last message (Slack has no bot typing API). */
	setComposing(channel: string, state: "composing" | "paused", threadId?: string): Promise<void>;
	/** Read-receipt no-op (Slack bots can't mark-read). */
	markRead(): Promise<void>;
	/** Disconnect the socket + tear down. */
	close(): Promise<void>;
}

export interface SlackSendTextOpts {
	/** Thread parent ts — reply within this thread. */
	threadId?: string;
	/** Native reply target — the message ts to reply under (mapped to thread_ts). */
	replyToMessageId?: string;
	/** Set false to disable link unfurling for this send. */
	linkPreview?: boolean;
}

export interface SlackSendMediaOpts {
	/** Thread parent ts to upload into. */
	threadId?: string;
}

/* ───────────────────────── error classification ───────────────────────── */

/** Pull a Slack `error` code off any thrown shape (WebClient error or raw). */
function errorCode(err: unknown): string {
	if (!err || typeof err !== "object") return "";
	const e = err as { data?: { error?: string }; error?: string; message?: string };
	return e.data?.error ?? e.error ?? "";
}

/** Description / message text off any thrown shape. */
function errorText(err: unknown): string {
	if (!err) return "";
	if (typeof err === "string") return err;
	const e = err as { data?: { error?: string }; message?: string };
	return e.data?.error ?? e.message ?? String(err);
}

/**
 * The non-recoverable Slack auth error codes — the token is wrong / revoked /
 * expired / the app was uninstalled or lost a required scope. Re-tokening is the
 * only fix; reconnecting with the same token loops forever. Mirrors the
 * reference Slack channel's terminal set.
 */
const SLACK_UNAUTHORIZED_CODES = [
	"invalid_auth",
	"not_authed",
	"account_inactive",
	"token_revoked",
	"token_expired",
	"invalid_token",
	"org_login_required",
	"missing_scope",
];

/** An auth failure → the token is wrong / revoked / expired / scope-stripped (terminal). */
export function isSlackUnauthorized(err: unknown): boolean {
	const code = errorCode(err);
	if (code && SLACK_UNAUTHORIZED_CODES.includes(code)) return true;
	// SocketModeClient throws an UnrecoverableSocketModeStartError on a bad app token.
	const name = (err as { name?: string })?.name ?? "";
	if (/UnrecoverableSocketModeStartError/i.test(name)) return true;
	const pattern = new RegExp(SLACK_UNAUTHORIZED_CODES.join("|"), "i");
	return pattern.test(errorText(err));
}

/** Strip a Slack token (`xoxb-…`/`xapp-…`/`xoxp-…`) out of a string before it logs. */
export function redactSlackToken(text: string, ...tokens: string[]): string {
	if (!text) return text;
	let out = text;
	for (const token of tokens) {
		if (token) out = out.split(token).join("<redacted>");
	}
	// Catch any `xox?-…` / `xapp-…` fragment even if the exact token differs.
	out = out.replace(/x(?:ox[bpoa]|app)-[A-Za-z0-9-]{6,}/g, "<redacted>");
	return out;
}

/** Convert a Slack message `ts` ("1700000000.000200") to epoch ms. */
function tsToEpochMs(ts: string | undefined): number | undefined {
	if (typeof ts !== "string") return undefined;
	const secs = Number.parseFloat(ts);
	return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : undefined;
}

/* ───────────────────────── the connection ───────────────────────── */

export async function connectSlack(args: ConnectSlackArgs): Promise<SlackConnection> {
	const accountId = args.accountId ?? "default";
	const mode: "socket" | "events" = args.mode === "events" ? "events" : "socket";
	const sleep = args.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
	const safeLog = (msg: string, meta?: Record<string, unknown>) => {
		// Defensively redact both tokens from any message + string meta values.
		const redactedMsg = redactSlackToken(msg, args.botToken, args.appToken ?? "");
		if (!meta) return args.log(redactedMsg);
		const redactedMeta: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(meta)) {
			redactedMeta[k] = typeof v === "string" ? redactSlackToken(v, args.botToken, args.appToken ?? "") : v;
		}
		args.log(redactedMsg, redactedMeta);
	};

	// ── resolve proxy (optional) ──
	// A configured proxy reroutes EVERY Slack API call (auth.test / sends) + the
	// Socket Mode websocket through the proxy — the fix for networks where
	// `slack.com` is blocked. Both Slack SDKs accept a Node `http.Agent`; we build
	// the matching one (http(s) → https-proxy-agent, socks → socks-proxy-agent)
	// and hand it to the client constructors. No proxy → the agent stays undefined
	// and the clients are built exactly as before.
	const proxyUrl = (args.proxyUrl ?? "").trim();
	let proxyAgent: unknown;
	if (proxyUrl) {
		const buildAgent = args.proxyAgentFactory ?? buildSlackProxyAgent;
		try {
			proxyAgent = await buildAgent(proxyUrl);
			safeLog("slack routing through proxy", { account: accountId, proxy: maskProxyUrl(proxyUrl) });
		} catch (err) {
			// A malformed proxy URL / missing module must not wedge the channel.
			safeLog("slack proxy setup failed — connecting directly", {
				account: accountId,
				proxy: maskProxyUrl(proxyUrl),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ── lazy-load the Slack SDKs (production path only) ──
	let buildWebClient: (botToken: string) => SlackWebClientLike;
	let buildSocket: ((appToken: string) => SlackSocketClientLike) | null;
	if (args.webClientFactory) {
		const factory = args.webClientFactory;
		buildWebClient = (botToken: string) => factory(botToken, proxyAgent);
	} else {
		const { WebClient } = await import("@slack/web-api");
		buildWebClient = (botToken: string) =>
			(proxyAgent
				? new WebClient(botToken, { agent: proxyAgent as never })
				: new WebClient(botToken)) as unknown as SlackWebClientLike;
	}
	if (mode === "socket") {
		if (args.socketModeFactory) {
			const factory = args.socketModeFactory;
			buildSocket = (appToken: string) => factory(appToken, proxyAgent);
		} else {
			const { SocketModeClient } = await import("@slack/socket-mode");
			buildSocket = (appToken: string) =>
				(proxyAgent
					? new SocketModeClient({ appToken, clientOptions: { agent: proxyAgent as never } })
					: new SocketModeClient({ appToken })) as unknown as SlackSocketClientLike;
		}
	} else {
		buildSocket = null;
	}

	// ── connection state ──
	let selfId: string | null = null;
	let selfName: string | null = null;
	let teamIdValue: string | null = null;
	let connectedAtMs: number | null = null;
	// Epoch ms of the most recent inbound event of any kind (liveness signal —
	// see SlackConnection.lastEventAt). Stamped at the entry of every inbound
	// handler so it covers BOTH the socket and the webhook (feedEvent) paths.
	let lastEventAtMs: number | null = null;
	const stampInboundEvent = (): void => {
		lastEventAtMs = Date.now();
	};
	let connected = false;
	let tokenInvalid = false;
	let closed = false;
	let reconnectAttempts = 0;
	let web: SlackWebClientLike | null = null;
	let socket: SlackSocketClientLike | null = null;
	let loopPromise: Promise<void> | null = null;

	// Dedupe inbound events by `ts` / `client_msg_id` — a redelivered envelope
	// after a reconnect must not double-run the agent. Per-connection lifetime.
	const eventDedupe = createDedupeCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1_000 });

	// Last inbound message `ts` per channel — the target the typing affordance
	// reacts to. Updated when a user message routes; read by `setComposing`.
	const lastInboundTs = new Map<string, string>();

	// Threads whose history has already been backfilled into `replyTo.body`
	// (keyed `channel:thread_ts`). The FIRST reply the bot sees on a thread it
	// was mentioned into pulls the prior messages; subsequent replies on the
	// SAME thread skip the fetch (the agent already has — or will accumulate —
	// the context via the session transcript). Per-connection lifetime, same
	// posture as `lastInboundTs`.
	const backfilledThreads = new Set<string>();

	// Background id→display-name directory (built lazily once `web` is live, in
	// BOTH socket + events mode). Resolves Slack user ids to human names so the
	// agent sees "Alex" instead of "U07ABC" in the sender name, `<@…>` mentions,
	// and reaction notes. Non-blocking: prime() warms the cache off the hot path,
	// resolveNameSync() reads whatever is cached (see user-directory.ts).
	let userDirectory: SlackUserDirectory | null = null;
	const ensureDirectory = (): SlackUserDirectory | null => {
		if (!userDirectory && web) userDirectory = createSlackUserDirectory({ web, log: safeLog });
		return userDirectory;
	};

	/** Normalize one Slack message event into the deferred-media inbound shape. */
	const normalize = (event: SlackMessageEvent, teamId: string | undefined, opts?: { edited?: boolean }): SlackInboundMessage | null => {
		// An edit (message_changed) carries the new message under `message`; the
		// channel + timestamps live on the OUTER envelope.
		const inner = event.subtype === "message_changed" && event.message ? event.message : event;
		const channel = typeof event.channel === "string" ? event.channel : typeof inner.channel === "string" ? inner.channel : "";
		if (!channel) return null;
		// Background id→name directory: read whatever is cached for THIS message,
		// then prime the sender + everyone they @-mentioned so the names resolve
		// next time (first contact shows the id; later messages show the name).
		const dir = ensureDirectory();
		const resolveName = dir ? (id: string): string | undefined => dir.resolveNameSync(id) : undefined;
		const text = extractSlackText(event, resolveName);
		const chatType = slackChannelType({ channel_type: event.channel_type, channel });
		const threadId = slackThreadId(inner);
		const mentions = extractSlackMentions(event, selfId ?? undefined);
		const replyTo = extractSlackReplyContext(event);
		const fromName = buildSlackSenderName(event, resolveName);
		const fromId = typeof inner.user === "string" ? inner.user : typeof inner.bot_id === "string" ? inner.bot_id : channel;
		if (dir) {
			dir.prime(typeof inner.user === "string" ? inner.user : undefined);
			for (const id of mentions) dir.prime(id);
		}
		const ts = typeof inner.ts === "string" ? inner.ts : typeof event.ts === "string" ? event.ts : undefined;

		// DEFERRED media — captured by reference, not downloaded. The thunk is only
		// invoked by the pipeline after the access gate admits the sender.
		const carriesMedia = hasInboundMedia(event);
		const resolveMedia = carriesMedia
			? async (): Promise<InboundMediaAttachment[]> => {
					const files = resolveInboundFiles(event);
					if (files.length === 0) return [];
					const out: InboundMediaAttachment[] = [];
					for (const file of files) {
						const att = await downloadSlackFile({ file, token: args.botToken, log: safeLog });
						if (att) out.push(att);
					}
					return out;
				}
			: undefined;

		return {
			conversationId: channel,
			...(ts ? { messageId: ts } : {}),
			...(tsToEpochMs(ts) !== undefined ? { messageTimestampMs: tsToEpochMs(ts) } : {}),
			from: fromId,
			...(fromName ? { fromName } : {}),
			text,
			chatType,
			...(teamId ? { teamId } : {}),
			...(threadId ? { threadId } : {}),
			...(mentions.length > 0 ? { mentions } : {}),
			...(replyTo ? { replyTo } : {}),
			...(opts?.edited ? { edited: true } : {}),
			...(resolveMedia ? { resolveMedia } : {}),
			raw: event,
		};
	};

	/**
	 * A stable dedupe key for a message event, keyed on CHANNEL + ts (NOT
	 * client_msg_id). A channel @-mention is delivered TWICE — once as a `message`
	 * event (carries `client_msg_id`) and once as an `app_mention` event (no
	 * client_msg_id, only `ts`). Keying on client_msg_id gave the two events
	 * different keys, so the agent ran/replied/billed twice. Keying on
	 * `channel:ts` collapses them (both share the same channel + ts). For an edit
	 * the per-edit `edited.ts` is folded in so a SECOND edit of the same message
	 * (same `ts`, new `edited.ts`) still routes instead of being dropped.
	 */
	const messageDedupeKey = (event: SlackMessageEvent): string | undefined => {
		const inner = event.subtype === "message_changed" && event.message ? event.message : event;
		const channel = typeof event.channel === "string" ? event.channel : typeof inner.channel === "string" ? inner.channel : "";
		const ts = typeof inner.ts === "string" ? inner.ts : typeof event.ts === "string" ? event.ts : "";
		if (!ts) return undefined;
		if (event.subtype === "message_changed") {
			const editTs = typeof inner.edited?.ts === "string" ? inner.edited.ts : "";
			return `edit:${channel}:${ts}:${editTs}`;
		}
		return `${channel}:${ts}`;
	};

	/** Is this event one the bot itself authored (its own echo)? */
	const isSelfAuthored = (event: SlackMessageEvent): boolean => {
		const inner = event.subtype === "message_changed" && event.message ? event.message : event;
		if (selfId && inner.user === selfId) return true;
		// A bot-posted message (our own outbound) carries bot_id and no user.
		if (inner.bot_id && !inner.user) return true;
		return false;
	};

	/**
	 * Fetch the prior messages of `threadId` and format the ones PRECEDING
	 * `currentTs` into a compact excerpt for `replyTo.body`. Best-effort: returns
	 * undefined on any failure (no `conversations.replies` slice, fetch error,
	 * empty thread) so the caller always proceeds to deliver. Each line is
	 * `name: text` — the sender name resolved from the background user directory
	 * when cached (else the raw id), the text token-expanded the same way inbound
	 * text is. The bot's own messages are kept (they're part of the thread the
	 * agent walked into). Bounded to {@link THREAD_BACKFILL_MAX_CHARS}.
	 */
	const fetchThreadExcerpt = async (
		channel: string,
		threadId: string,
		currentTs: string | undefined,
	): Promise<string | undefined> => {
		const w = web;
		const repliesFn = w?.conversations.replies;
		if (!w || typeof repliesFn !== "function") return undefined;
		let res: Awaited<ReturnType<NonNullable<SlackWebClientLike["conversations"]["replies"]>>>;
		try {
			res = await repliesFn.call(w.conversations, { channel, ts: threadId, limit: THREAD_BACKFILL_LIMIT });
		} catch (err) {
			safeLog("slack thread backfill failed (best-effort)", {
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
		if (!res?.ok || !Array.isArray(res.messages) || res.messages.length === 0) return undefined;
		const dir = ensureDirectory();
		const lines: string[] = [];
		for (const m of res.messages) {
			// Only messages BEFORE the one we're routing — the current message is the
			// agent's input, not prior context. A reply event always carries a ts, so
			// when currentTs is set we stop at it; missing ts entries are skipped.
			const mts = typeof m.ts === "string" ? m.ts : "";
			if (currentTs && mts && mts >= currentTs) continue;
			const rawText = typeof m.text === "string" ? m.text : "";
			if (!rawText) continue;
			const resolveName = dir ? (id: string): string | undefined => dir.resolveNameSync(id) : undefined;
			const text = unescapeSlackEntities(expandSlackTokens(rawText, resolveName)).replace(/\s+/g, " ").trim();
			if (!text) continue;
			const userId = typeof m.user === "string" ? m.user : "";
			if (dir && userId) dir.prime(userId);
			const name =
				(userId && dir ? dir.resolveNameSync(userId) : undefined) ||
				userId ||
				(typeof m.bot_id === "string" ? m.bot_id : "") ||
				"unknown";
			lines.push(`${name}: ${text}`);
		}
		if (lines.length === 0) return undefined;
		let excerpt = lines.join("\n");
		if (excerpt.length > THREAD_BACKFILL_MAX_CHARS) {
			// Keep the TAIL (most recent context) — trim from the front.
			excerpt = `…${excerpt.slice(excerpt.length - THREAD_BACKFILL_MAX_CHARS)}`;
		}
		return excerpt;
	};

	/**
	 * Handle a `message` / `app_mention` event. ACK is done by the socket handler
	 * BEFORE this runs. Filters the bot's own echoes + system subtypes, dedupes,
	 * normalizes, and routes through `onMessage` (an edit flagged `edited`).
	 *
	 * ASYNC because of the thread-history backfill: `normalize` stays SYNC, but
	 * when the inbound is a threaded reply (a thread we haven't backfilled yet)
	 * this fetches the prior thread messages via `conversations.replies` and folds
	 * them into `normalized.replyTo.body` BEFORE handing off to `onMessage`, so the
	 * agent sees the conversation it was just @-mentioned into. Runs PRE-central-ACL
	 * (same posture as the reference channel); the fetch uses the bot token on a
	 * thread the bot is already in, and is fully best-effort + bounded so it can
	 * never block (or fail) delivery.
	 */
	const handleMessageEvent = async (event: SlackMessageEvent, teamId: string | undefined): Promise<void> => {
		try {
			// Liveness: any inbound message event proves the connection is alive,
			// even one we ultimately skip (echo / system subtype).
			stampInboundEvent();
			// message_deleted carries no routable content (the agent can't act on a
			// vanished message); log-free skip.
			if (event.subtype === "message_deleted") return;
			// Skip the bot's own messages (echoes) — a bot must never reply to itself.
			if (isSelfAuthored(event)) return;
			// Skip system / bot-integration subtypes that aren't user messages
			// (channel_join, bot_message, etc.) — but ALLOW message_changed (an edit).
			const subtype = event.subtype;
			if (subtype && subtype !== "message_changed" && subtype !== "file_share" && subtype !== "thread_broadcast") {
				return;
			}
			const dedupeKey = messageDedupeKey(event);
			if (dedupeKey && !eventDedupe.claim(dedupeKey)) return; // already seen
			const normalized = normalize(event, teamId, { edited: subtype === "message_changed" });
			if (!normalized) return;
			// Thread-history backfill — only when this is a threaded reply that quotes
			// a parent (replyTo present) AND we haven't already backfilled this thread.
			// `extractSlackReplyContext` leaves `body` undefined; we fill it with a
			// compact excerpt of the prior messages so the agent has the prior context.
			if (normalized.threadId && normalized.replyTo && !normalized.replyTo.body) {
				const threadKey = `${normalized.conversationId}:${normalized.threadId}`;
				if (!backfilledThreads.has(threadKey)) {
					backfilledThreads.add(threadKey);
					const excerpt = await fetchThreadExcerpt(normalized.conversationId, normalized.threadId, normalized.messageId);
					if (excerpt) normalized.replyTo = { ...normalized.replyTo, body: excerpt };
				}
			}
			args.onMessage(normalized);
			// Remember the user's last message ts so setComposing can react to it.
			if (normalized.messageId) lastInboundTs.set(normalized.conversationId, normalized.messageId);
		} catch (err) {
			safeLog("slack inbound handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Normalize a `reaction_added` event into the inbound shape. Surfaces the
	 * single added emoji, the actor, and the target message ts. Reactions carry no
	 * text. Returns null when the reaction wasn't on a message or was self-authored.
	 */
	const normalizeReaction = (event: SlackReactionEvent, teamId: string | undefined): SlackInboundMessage | null => {
		const item = event.item;
		if (!item || item.type !== "message") return null;
		const channel = typeof item.channel === "string" ? item.channel : "";
		const target = typeof item.ts === "string" ? item.ts : "";
		const emoji = typeof event.reaction === "string" ? event.reaction : "";
		if (!channel || !target || !emoji) return null;
		const fromId = typeof event.user === "string" ? event.user : channel;
		if (selfId && fromId === selfId) return null; // the bot's own reaction
		// Resolve the reactor's display name (background-primed) so the synthesized
		// note reads "Alex reacted :+1:" instead of the raw id.
		const dir = ensureDirectory();
		if (dir && typeof event.user === "string") dir.prime(event.user);
		const fromName = dir && typeof event.user === "string" ? dir.resolveNameSync(event.user) : undefined;
		return {
			conversationId: channel,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: "",
			// A reaction event doesn't carry channel_type; infer from the id prefix.
			chatType: channel.startsWith("D") ? "direct" : "group",
			...(teamId ? { teamId } : {}),
			reaction: { emojis: [emoji], targetMessageId: target },
			raw: event,
		};
	};

	/** Handle a `reaction_added` event → normalize + route through `onReaction`. */
	const handleReactionEvent = (event: SlackReactionEvent, teamId: string | undefined): void => {
		try {
			stampInboundEvent();
			// Dedupe on actor+emoji+target so a redelivery doesn't double-route.
			const key = `react:${event.user}:${event.reaction}:${event.item?.ts}`;
			if (!eventDedupe.claim(key)) return;
			const normalized = normalizeReaction(event, teamId);
			if (!normalized) return;
			args.onReaction?.(normalized);
		} catch (err) {
			safeLog("slack reaction handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Normalize a `block_actions` interactive press into the inbound shape the
	 * central pipeline routes to the approval-callback path. The pressed button's
	 * opaque `value` rides on `callbackQuery.data`; `conversationId` / `from` /
	 * `threadId` come from the interaction payload so the pending-approval lookup
	 * keys on the SAME peer the prompt was sent to.
	 */
	const normalizeInteractive = (payload: SlackInteractivePayload): SlackInboundMessage | null => {
		if (payload.type !== "block_actions") return null;
		const actions = Array.isArray(payload.actions) ? payload.actions : [];
		// Pull the first action carrying a value — the central pipeline decodes it.
		const value = actions.map((a) => (typeof a?.value === "string" ? a.value : "")).find((v) => v) ?? "";
		if (!value) return null;
		const channel = typeof payload.channel?.id === "string" ? payload.channel.id : "";
		const fromId = typeof payload.user?.id === "string" ? payload.user.id : channel;
		if (!channel && !fromId) return null;
		const threadId = typeof payload.message?.thread_ts === "string" ? payload.message.thread_ts : undefined;
		const fromName = payload.user?.username ?? payload.user?.name;
		return {
			conversationId: channel || fromId,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: "",
			chatType: channel.startsWith("D") ? "direct" : "group",
			...(typeof payload.team?.id === "string" ? { teamId: payload.team.id } : {}),
			...(threadId ? { threadId } : {}),
			callbackQuery: { data: value, callbackId: payload.message?.ts ?? "" },
			raw: payload,
		};
	};

	/** Handle a `block_actions` interaction → normalize + route through `onCallbackQuery`. */
	const handleInteractive = (payload: SlackInteractivePayload): void => {
		try {
			stampInboundEvent();
			const normalized = normalizeInteractive(payload);
			if (!normalized) return;
			args.onCallbackQuery?.(normalized);
		} catch (err) {
			safeLog("slack interactive handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Handle a `slash_commands` event → route as an ordinary inbound message so
	 * the central command map (`/help`, `/status`, …) handles it. The command +
	 * its args are joined into the text (`/status foo` → `/status foo`). Slack
	 * already acked the slash command in the socket handler.
	 */
	const handleSlashCommand = (payload: SlackSlashCommandPayload): void => {
		try {
			stampInboundEvent();
			const command = typeof payload.command === "string" ? payload.command : "";
			const text = typeof payload.text === "string" ? payload.text : "";
			const channel = typeof payload.channel_id === "string" ? payload.channel_id : "";
			const fromId = typeof payload.user_id === "string" ? payload.user_id : channel;
			if (!command || !channel) return;
			const body = text ? `${command} ${text}` : command;
			args.onMessage({
				conversationId: channel,
				from: fromId,
				...(payload.user_name ? { fromName: payload.user_name } : {}),
				text: body,
				chatType: channel.startsWith("D") ? "direct" : "group",
				...(typeof payload.team_id === "string" ? { teamId: payload.team_id } : {}),
				raw: payload,
			});
		} catch (err) {
			safeLog("slack slash handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/* ── socket event wiring ── */

	/** Subscribe the SocketModeClient to the events Brigade consumes. */
	const wireSocket = (s: SlackSocketClientLike): void => {
		// events_api events are emitted under their event TYPE name (see
		// SocketModeClient.onWebSocketMessage). ACK FIRST — Slack redelivers an
		// un-acked envelope — then route. The team id rides on the envelope `body`.
		const onEvent = async (a: SocketEventArgs): Promise<void> => {
			try {
				await a.ack();
			} catch {
				/* ack is best-effort; routing still proceeds */
			}
			const teamId = typeof a.body?.team_id === "string" ? a.body.team_id : undefined;
			const event = (a.event ?? a.body?.event) as SlackMessageEvent | SlackReactionEvent | undefined;
			if (!event) return;
			await handleMessageEvent(event as SlackMessageEvent, teamId);
		};
		const onReaction = async (a: SocketEventArgs): Promise<void> => {
			try {
				await a.ack();
			} catch {
				/* best-effort */
			}
			const teamId = typeof a.body?.team_id === "string" ? a.body.team_id : undefined;
			const event = (a.event ?? a.body?.event) as SlackReactionEvent | undefined;
			if (event) handleReactionEvent(event, teamId);
		};
		s.on("message", (a) => void onEvent(a as SocketEventArgs));
		s.on("app_mention", (a) => void onEvent(a as SocketEventArgs));
		s.on("reaction_added", (a) => void onReaction(a as SocketEventArgs));
		s.on("reaction_removed", (a) => {
			// A removal isn't routed (nothing to act on) but is acked so Slack stops
			// redelivering it. CRUCIALLY we also RELEASE the add-dedupe key so a later
			// re-add of the same emoji by the same user (add→remove→add) re-claims and
			// routes — without this the re-add is silently dropped as a "redelivery".
			stampInboundEvent(); // liveness: a removal is still inbound traffic
			const args2 = a as SocketEventArgs;
			void args2.ack?.().catch(() => {});
			const event = (args2.event ?? args2.body?.event) as SlackReactionEvent | undefined;
			if (event) {
				eventDedupe.release(`react:${event.user}:${event.reaction}:${event.item?.ts}`);
			}
		});
		s.on("interactive", (a) => {
			const args2 = a as SocketInteractiveArgs;
			void args2.ack?.().catch(() => {});
			if (args2.body) handleInteractive(args2.body);
		});
		s.on("slash_commands", (a) => {
			const args2 = a as SocketSlashArgs;
			// Slash commands ack with an empty body (or a response) to clear the
			// client spinner; we ack empty + route the command through the pipeline.
			void args2.ack?.().catch(() => {});
			if (args2.body) handleSlashCommand(args2.body);
		});
		// Terminal-auth awareness mid-session. A token revoked AFTER connect surfaces
		// on `error` / `unable_to_socket_mode_start` (NOT reliably on `disconnected`,
		// which @slack/socket-mode emits with NO argument — so the old
		// disconnected-only hook was dead and a revoked token left health stuck at
		// "disconnected" forever). We bind all three and mark the token invalid on
		// any auth-class error so health flips to "logged-out" and the operator is
		// prompted to re-token.
		const markTokenInvalidIfAuth = (err: unknown, where: string): void => {
			if (!isSlackUnauthorized(err)) return;
			if (tokenInvalid) return; // already terminal — don't re-fire
			tokenInvalid = true;
			connected = false;
			safeLog(`slack ${where} — token rejected; re-token required`);
			args.onTokenInvalid?.();
		};
		s.on("disconnected", (err) => markTokenInvalidIfAuth(err, "socket disconnected"));
		s.on("error", (e) => markTokenInvalidIfAuth(e, "socket error"));
		s.on("unable_to_socket_mode_start", (e) => markTokenInvalidIfAuth(e, "unable to start socket mode"));
	};

	/* ── bootstrap + supervise ── */

	/** Run `auth.test`, cache identity, build + start the socket. */
	const startOnce = async (): Promise<void> => {
		const w = buildWebClient(args.botToken);
		web = w;
		// auth.test first — both proves the bot token (invalid_auth surfaces here)
		// and caches the bot user id + team id the group ACL + echo filter need.
		const auth = await w.auth.test();
		if (!auth?.ok) {
			const code = auth?.error ?? "auth_failed";
			const err = new Error(code) as Error & { data?: { error?: string } };
			err.data = { error: code };
			throw err;
		}
		selfId = typeof auth.user_id === "string" ? auth.user_id : null;
		selfName = typeof auth.user === "string" ? auth.user : null;
		teamIdValue = typeof auth.team_id === "string" ? auth.team_id : null;

		if (mode === "socket") {
			if (!args.appToken) {
				throw new Error("Slack socket mode needs an app-level token (xapp-…) — set channels.slack.appToken.");
			}
			const s = (buildSocket as (appToken: string) => SlackSocketClientLike)(args.appToken);
			wireSocket(s);
			socket = s;
			await s.start();
		}
	};

	/**
	 * The supervise loop — start, and on a transient setup failure reconnect with
	 * backoff. The SocketModeClient auto-reconnects internally once started, so
	 * this loop mainly guards the initial connect (auth.test + socket start). A
	 * terminal auth error stops it (the only fix is a new token).
	 */
	const superviseLoop = async (): Promise<void> => {
		while (!closed && !tokenInvalid) {
			try {
				await startOnce();
			} catch (err) {
				if (isSlackUnauthorized(err)) {
					tokenInvalid = true;
					connected = false;
					safeLog("slack token rejected — re-token required; not connecting");
					args.onTokenInvalid?.();
					return;
				}
				if (closed) return;
				const delay = slackBackoffDelay(reconnectAttempts);
				reconnectAttempts += 1;
				if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
					safeLog("slack setup attempts exhausted — giving up until restart", { attempts: reconnectAttempts });
					return;
				}
				safeLog("slack setup failed — retrying", {
					attempt: reconnectAttempts,
					delayMs: delay,
					error: err instanceof Error ? err.message : String(err),
				});
				await sleep(delay);
				continue;
			}

			// close() may have fired during the async startOnce() — bail before we
			// commit to a live socket we'd otherwise have to tear down.
			if (closed) {
				await teardownSocket();
				return;
			}

			// Connected. Reset backoff, announce. The socket now self-supervises; we
			// resolve and let the internal reconnect handle transient drops.
			connected = true;
			connectedAtMs = Date.now();
			reconnectAttempts = 0;
			safeLog("slack connected", { account: accountId, self: selfName ? `@${selfName}` : selfId, team: teamIdValue });
			args.onConnected?.();
			return;
		}
	};

	const teardownSocket = async (): Promise<void> => {
		const s = socket;
		socket = null;
		if (s) {
			try {
				await s.disconnect();
			} catch {
				/* already disconnected */
			}
		}
	};

	// In events mode there is no socket loop — just bootstrap auth.test once so
	// the bot identity is cached and outbound works; inbound arrives via feedEvent.
	const startEventsMode = async (): Promise<void> => {
		try {
			await startOnce();
			if (closed) return;
			connected = true;
			connectedAtMs = Date.now();
			reconnectAttempts = 0;
			safeLog("slack events-mode ready — inbound via gateway route", { account: accountId });
			args.onConnected?.();
		} catch (err) {
			if (isSlackUnauthorized(err)) {
				tokenInvalid = true;
				connected = false;
				safeLog("slack token rejected — re-token required; events mode not started");
				args.onTokenInvalid?.();
				return;
			}
			safeLog("slack events-mode setup failed", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	// Kick the right startup path. `connectSlack` resolves as soon as the FIRST
	// connect (or terminal failure) settles so the adapter's start() doesn't hang.
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
	loopPromise = (mode === "events" ? startEventsMode() : superviseLoop()).catch((err) => {
		safeLog("slack supervise loop crashed", { error: err instanceof Error ? err.message : String(err) });
	});
	// Don't block start() indefinitely — resolve once connected OR after the loop
	// settles (terminal failure), whichever comes first.
	await Promise.race([initial, loopPromise.then(() => undefined)]);

	/* ── outbound + control surface ── */

	const requireLive = (): SlackWebClientLike => {
		if (tokenInvalid) throw new Error("Slack token is invalid — set a new bot token and restart.");
		if (!web) throw new Error("Slack channel is not started");
		return web;
	};

	/** Throw a clear error when a Web API call returns `{ ok: false }`. */
	const expectOk = <T extends SlackApiResponse>(res: T, op: string): T => {
		if (!res?.ok) {
			const code = res?.error ?? "unknown_error";
			throw new Error(`Slack ${op} failed: ${code}`);
		}
		return res;
	};

	const sendText: SlackConnection["sendText"] = async (channel, text, opts) => {
		const w = requireLive();
		const params: Record<string, unknown> = { channel, text, mrkdwn: true };
		// thread_ts: an explicit threadId wins; else a native reply target threads
		// the reply under the message being answered.
		const threadTs = opts?.threadId ?? opts?.replyToMessageId;
		if (threadTs) params.thread_ts = threadTs;
		if (opts?.linkPreview === false) {
			params.unfurl_links = false;
			params.unfurl_media = false;
		}
		const res = expectOk(await w.chat.postMessage(params), "postMessage");
		return { messageId: res.ts ?? "" };
	};

	const sendInteractive: SlackConnection["sendInteractive"] = async (channel, text, blocks, opts) => {
		const w = requireLive();
		const params: Record<string, unknown> = { channel, text, blocks, mrkdwn: true };
		const threadTs = opts?.threadId ?? opts?.replyToMessageId;
		if (threadTs) params.thread_ts = threadTs;
		const res = expectOk(await w.chat.postMessage(params), "postMessage");
		return { messageId: res.ts ?? "" };
	};

	const sendMedia: SlackConnection["sendMedia"] = async (channel, media, opts) => {
		const w = requireLive();
		await uploadSlackFile({
			client: w,
			channelId: channel,
			media,
			...(opts?.threadId ? { threadId: opts.threadId } : {}),
		});
	};

	const react: SlackConnection["react"] = async (channel, messageId, emoji) => {
		const w = requireLive();
		const name = emoji.replace(/:/g, "").trim();
		if (!name) return;
		try {
			await w.reactions.add({ channel, timestamp: messageId, name });
		} catch (err) {
			// `already_reacted` is benign; other errors are cosmetic for a reaction.
			if (errorCode(err) === "already_reacted") return;
			safeLog("slack react failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	const removeReaction: SlackConnection["removeReaction"] = async (channel, messageId, emoji) => {
		const w = requireLive();
		const name = emoji.replace(/:/g, "").trim();
		if (!name) return;
		try {
			await w.reactions.remove({ channel, timestamp: messageId, name });
		} catch (err) {
			if (errorCode(err) === "no_reaction") return;
			safeLog("slack remove reaction failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	const removeOwnReactions: SlackConnection["removeOwnReactions"] = async (channel, messageId) => {
		const w = requireLive();
		const getFn = w.reactions.get;
		if (typeof getFn !== "function") return; // no slice → nothing we can clear
		let reactions: Array<{ name?: string; users?: string[] }> = [];
		try {
			const res = await getFn.call(w.reactions, { channel, timestamp: messageId });
			reactions = Array.isArray(res?.message?.reactions) ? res.message!.reactions! : [];
		} catch (err) {
			// A read failure is cosmetic — nothing to clear if we can't see them.
			safeLog("slack reactions.get failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const self = selfId;
		for (const r of reactions) {
			const name = typeof r.name === "string" ? r.name : "";
			// Only the bot's OWN reactions are ours to clear — a user's reaction on
			// the same message is left untouched. When we don't know our own id
			// (never connected), skip rather than risk removing someone else's.
			if (!name || !self || !Array.isArray(r.users) || !r.users.includes(self)) continue;
			try {
				await w.reactions.remove({ channel, timestamp: messageId, name });
			} catch (err) {
				if (errorCode(err) === "no_reaction") continue;
				safeLog("slack remove own reaction failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
			}
		}
	};

	const editMessageText: SlackConnection["editMessageText"] = async (channel, messageId, text, _opts) => {
		const w = requireLive();
		expectOk(await w.chat.update({ channel, ts: messageId, text, mrkdwn: true }), "chat.update");
	};

	const deleteMessage: SlackConnection["deleteMessage"] = async (channel, messageId) => {
		const w = requireLive();
		expectOk(await w.chat.delete({ channel, ts: messageId }), "chat.delete");
	};

	const openDirectMessage: SlackConnection["openDirectMessage"] = async (userId) => {
		const w = requireLive();
		const res = expectOk(await w.conversations.open({ users: userId }), "conversations.open");
		const id = res.channel?.id;
		if (!id) throw new Error("Slack: conversations.open returned no channel id");
		return id;
	};

	const feedEvent: SlackConnection["feedEvent"] = (kind, payload) => {
		// Stamp liveness for EVERY webhook-fed event up front — even a
		// reaction_removed (handled below by releasing a dedupe key, not a handler)
		// is inbound traffic that proves the events route is alive.
		stampInboundEvent();
		if (kind === "interactive") {
			handleInteractive(payload as SlackInteractivePayload);
			return;
		}
		if (kind === "slash") {
			handleSlashCommand(payload as SlackSlashCommandPayload);
			return;
		}
		// An events-API outer envelope wraps the event under `event`; the team id is
		// the top-level `team_id`.
		const env = payload as { team_id?: string; event?: SlackMessageEvent | SlackReactionEvent };
		const event = env.event ?? (payload as SlackMessageEvent | SlackReactionEvent);
		const teamId = typeof env.team_id === "string" ? env.team_id : undefined;
		const type = (event as { type?: string })?.type;
		if (type === "reaction_added") {
			handleReactionEvent(event as SlackReactionEvent, teamId);
		} else if (type === "reaction_removed") {
			// Mirror the socket path: a removal isn't routed, but it RELEASES the
			// add-dedupe key so a later re-add (add→remove→add) re-claims + routes.
			const re = event as SlackReactionEvent;
			eventDedupe.release(`react:${re.user}:${re.reaction}:${re.item?.ts}`);
		} else {
			// Fire-and-forget: handleMessageEvent is async (thread backfill) but
			// feedEvent is the sync webhook entry point. The handler swallows its own
			// errors; guard the promise so an unexpected rejection can't go unhandled.
			void handleMessageEvent(event as SlackMessageEvent, teamId).catch(() => {});
		}
	};

	const close: SlackConnection["close"] = async () => {
		closed = true;
		connected = false;
		await teardownSocket();
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
		selfName: () => selfName,
		teamId: () => teamIdValue,
		connectedAt: () => connectedAtMs,
		lastEventAt: () => lastEventAtMs,
		isConnected: () => connected,
		isTokenInvalid: () => tokenInvalid,
		sendText,
		sendInteractive,
		sendMedia,
		react,
		removeReaction,
		removeOwnReactions,
		editMessageText,
		deleteMessage,
		openDirectMessage,
		feedEvent,
		mode: () => mode,
		setComposing: async (channel, state) => {
			// Slack has no bot typing API; emulate it — react ⏳ to the user's last
			// message while the agent works, remove it when idle. Best-effort +
			// cosmetic: a failure (no scope / already-reacted / not live) never blocks.
			const ts = lastInboundTs.get(channel);
			const w = web;
			if (!ts || !w) return;
			try {
				if (state === "composing") await w.reactions.add({ channel, timestamp: ts, name: TYPING_REACTION });
				else await w.reactions.remove({ channel, timestamp: ts, name: TYPING_REACTION });
			} catch {
				/* cosmetic — already_reacted / no_reaction / missing scope: ignore */
			}
		},
		markRead: async () => {},
		close,
	};
}

export { SLACK_MESSAGE_LIMIT };
