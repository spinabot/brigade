/**
 * BlueBubbles channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the BlueBubbles
 * macOS server (REST-out, `connection.ts`) with inbound delivered via the gateway
 * webhook route (`feedWebhookEvent` → the connection's normalize+dedupe path).
 * BlueBubbles authenticates with a server password (sealed like Slack/Discord
 * tokens); enablement is `channels.bluebubbles.enabled: true` plus a resolvable
 * serverUrl + password.
 *
 * Unlike the native `imessage` channel, BlueBubbles supports REAL message actions
 * via the server's Private API — reactions / edit / unsend — so this adapter
 * advertises those capabilities (gated on `actions.*` config AND the live
 * Private-API status from the probe) and implements `handleAction`.
 *
 * TEST SEAM: `connectImpl` overrides how the connection is built — production
 * leaves it undefined and `connectBlueBubbles` is used with the real (injectable)
 * fetch; a unit test injects a fake connection so send / action / inbound run
 * with no live server.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { loadConfig } from "../../../core/config.js";
import {
	chunkText,
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelHealth,
	type ChannelMessageActionResult,
	type ChannelStartContext,
	type OutboundMedia,
	type OutboundSendOptions,
} from "../sdk.js";
import {
	bluebubblesChannelEnabled,
	isBlueBubblesOpAllowed,
	listBlueBubblesAccountIds,
	resolveBlueBubblesAccount,
	resolveBlueBubblesPassword,
	resolveBlueBubblesServerUrl,
	BLUEBUBBLES_CHANNEL_ID,
	BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
	type BlueBubblesActionFlags,
} from "./account-config.js";
import {
	connectBlueBubbles,
	type BlueBubblesConnection,
	type BlueBubblesInboundMessage,
	type ConnectBlueBubblesArgs,
} from "./connection.js";
import { isMacOSEditUnsupported, probeBlueBubbles } from "./probe.js";

/** Practical per-message text limit for chunked sends (before bubble-splitting). */
const BLUEBUBBLES_TEXT_LIMIT = 10_000;

/**
 * Synthesise the agent-facing note for an inbound tapback. A tapback carries no
 * text of its own, so the note ("<emoji> tapback on message <id>") is what the
 * central pipeline routes through dispatchTurn so the agent has context.
 */
export function buildBlueBubblesReactionNote(emoji: string, targetMessageId: string): string {
	const target = targetMessageId.trim();
	return target
		? `Reacted ${emoji} to message ${target}.`
		: `Reacted ${emoji} to a message.`;
}

/** Build the capability flags for the account's action toggles + Private-API status. */
function buildCapabilities(actions: BlueBubblesActionFlags, privateApi: boolean | null): ChannelCapabilities {
	const richAvailable = privateApi === true;
	return {
		chatTypes: ["direct", "group"],
		media: true,
		reply: true,
		reactions: actions.reactions && richAvailable,
		edit: actions.edit && richAvailable,
		unsend: actions.unsend && richAvailable,
	};
}

/** Adapter construction options — all optional for back-compat + testing. */
export interface CreateBlueBubblesAdapterOptions {
	/** Per-account scope. Defaults to `"default"` (single-account). */
	accountId?: string;
	/** TEST SEAM: override how the connection is built. */
	connectImpl?: (args: ConnectBlueBubblesArgs) => BlueBubblesConnection;
	/** TEST SEAM: override the start-time probe (skips the real network round-trip). */
	probeImpl?: typeof probeBlueBubbles;
}

/** The extended adapter surface the webhook route + plugin bridge drive. */
export interface BlueBubblesAdapter extends ChannelAdapter {
	/** Feed a parsed BlueBubbles webhook event into the inbound path. */
	feedWebhookEvent(eventType: string | undefined, payload: unknown): void;
}

async function loadStartConfig(): Promise<BrigadeConfig> {
	return loadConfig() as unknown as BrigadeConfig;
}

export function createBlueBubblesAdapter(opts: CreateBlueBubblesAdapterOptions = {}): BlueBubblesAdapter {
	const accountId = opts.accountId?.trim() || BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
	const connectImpl = opts.connectImpl ?? connectBlueBubbles;
	const probeImpl = opts.probeImpl ?? probeBlueBubbles;

	let connection: BlueBubblesConnection | null = null;
	let lastConfig: BrigadeConfig | null = null;
	let lastEnv: NodeJS.ProcessEnv = process.env;
	let started = false;
	let privateApi: boolean | null = null;
	let macOSMajor: number | null = null;
	let selfHandle = "";
	let actions: BlueBubblesActionFlags = {
		reactions: true,
		edit: true,
		unsend: true,
		effects: true,
		groupAdmin: true,
	};

	const adapter: BlueBubblesAdapter = {
		id: BLUEBUBBLES_CHANNEL_ID,
		label: "BlueBubbles",

		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean {
			lastConfig = cfg;
			lastEnv = env ?? process.env;
			if (!bluebubblesChannelEnabled(cfg)) return false;
			// Need a resolvable server URL + password.
			if (!resolveBlueBubblesServerUrl(cfg, accountId, env ?? process.env)) return false;
			if (!resolveBlueBubblesPassword(cfg, accountId, env ?? process.env)) return false;
			// Multi-account: the plugin path owns lifecycle when >1 account; the
			// legacy single adapter steps aside.
			const isLegacyAdapter = accountId === BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listBlueBubblesAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			const cfg = lastConfig ?? (await loadStartConfig());
			const account = resolveBlueBubblesAccount(cfg, accountId, lastEnv);
			actions = account.actions;
			selfHandle = account.selfHandle;
			// Probe once at start to detect Private-API status (gates rich actions +
			// honest capabilities). Never throws.
			try {
				const probe = await probeImpl({
					serverUrl: account.serverUrl,
					password: account.password,
					timeoutMs: account.probeTimeoutMs,
				});
				privateApi = probe.privateApi;
				macOSMajor = probe.macOSMajor ?? null;
				if (!probe.ok) ctx.log(`BlueBubbles probe failed: ${probe.error ?? "unknown"}`);
			} catch {
				privateApi = null;
				macOSMajor = null;
			}
			try {
				connection = connectImpl({
					account,
					log: ctx.log,
					privateApi,
					macOSMajor,
					onMessage: (msg: BlueBubblesInboundMessage) => {
						void ctx.onInbound({
							channel: BLUEBUBBLES_CHANNEL_ID,
							accountId,
							conversationId: msg.conversationId,
							...(msg.messageGuid ? { messageId: msg.messageGuid } : {}),
							...(msg.timestampMs !== undefined ? { messageTimestampMs: msg.timestampMs } : {}),
							from: msg.from,
							...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
							text: msg.text,
							chatType: msg.isGroup ? "group" : "direct",
							isGroup: msg.isGroup,
							...(msg.replyToGuid ? { replyTo: { messageId: msg.replyToGuid } } : {}),
							...(msg.mentions && msg.mentions.length > 0 ? { mentions: msg.mentions } : {}),
							...(msg.resolveMedia ? { resolveMedia: msg.resolveMedia } : {}),
							raw: msg.raw,
						});
					},
					// Inbound tapback → synthesise a short note + a `reaction` event and
					// route it through the SAME inbound pipeline as a normal message so
					// the access gate + routing apply uniformly. Only "added" tapbacks
					// wake the agent (a removal is noise); the connection already gates
					// this on `actions.reactions`.
					onTapback: (note) => {
						if (note.action !== "added") return;
						const targetId = note.targetGuid ?? "";
						void ctx.onInbound({
							channel: BLUEBUBBLES_CHANNEL_ID,
							accountId,
							conversationId: note.conversationId,
							from: note.from,
							text: buildBlueBubblesReactionNote(note.emoji, targetId),
							chatType: note.isGroup ? "group" : "direct",
							isGroup: note.isGroup,
							reaction: { emojis: [note.emoji], targetMessageId: targetId },
						});
					},
				});
				started = true;
				ctx.log("BlueBubbles connected");
				ctx.onConnected?.();
				// On (re)connect, backfill recently-missed messages so nothing is lost
				// across a Brigade restart. Each fetched message replays through the
				// SAME normalize+dedupe path as a live webhook, so a message already
				// delivered live is dropped at dedupe (no double-delivery). Fire-and-
				// forget + never throws — a backfill failure never blocks the channel.
				void connection
					?.runCatchup()
					.then((summary) => {
						if (summary.replayed > 0 || summary.fetched > 0) {
							ctx.log(`BlueBubbles catch-up: fetched ${summary.fetched}, replayed ${summary.replayed}`);
						}
					})
					.catch((err) => ctx.log(`BlueBubbles catch-up failed: ${err instanceof Error ? err.message : String(err)}`));
			} catch (err) {
				started = false;
				ctx.log(`BlueBubbles failed to start: ${err instanceof Error ? err.message : String(err)}`);
			}
		},

		async stop(): Promise<void> {
			connection?.close();
			connection = null;
			started = false;
		},

		health(): ChannelHealth {
			if (!connection || !started) {
				return { ok: false, kind: "starting", reason: "BlueBubbles adapter is not started yet." };
			}
			return { ok: true };
		},

		feedWebhookEvent(eventType: string | undefined, payload: unknown): void {
			if (!connection) return;
			connection.feedWebhookEvent(eventType, payload);
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string } | void> {
			if (!connection) throw new Error("BlueBubbles channel is not started");
			// Chunk very long replies first (bubble-split happens inside the connection).
			const chunks = chunkText(text, { limit: BLUEBUBBLES_TEXT_LIMIT });
			let first = true;
			let lastMessageId: string | undefined;
			for (const chunk of chunks) {
				if (!chunk.trim()) continue;
				const replyOpt = first && opts?.replyToId ? { replyToId: opts.replyToId } : {};
				const sent = await connection.sendText(conversationId, chunk, { ...replyOpt });
				if (sent.messageId) lastMessageId = sent.messageId;
				first = false;
			}
			return lastMessageId ? { messageId: lastMessageId } : undefined;
		},

		async sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string } | void> {
			if (!connection) throw new Error("BlueBubbles channel is not started");
			// Per-op gate: the operator can disable attachment sends independently.
			if (!isBlueBubblesOpAllowed(actions, "sendAttachment")) {
				throw new Error("BlueBubbles attachment sends are disabled (channels.bluebubbles.actions.sendAttachment = false)");
			}
			const sent = await connection.sendMedia(conversationId, media);
			return sent.messageId ? { messageId: sent.messageId } : undefined;
		},

		// Read-receipt hook the pipeline calls after the access gate admits a
		// sender (so a challenged stranger never sees a read receipt first).
		// Cosmetic + best-effort: no-ops when the Private API is off, swallows
		// transport errors (the pipeline already wraps this in a try/catch).
		async markRead(conversationId: string): Promise<void> {
			if (!connection) return;
			await connection.markRead(conversationId);
		},

		// Typing-indicator hook the pipeline calls around a turn so the user sees
		// "typing…" while the agent thinks. Cosmetic; no-ops when the Private API
		// is off. `composing` → start, `paused` → stop.
		async setComposing(conversationId: string, state: "composing" | "paused"): Promise<void> {
			if (!connection) return;
			await connection.setTyping(conversationId, state === "composing");
		},

		// The bot's own iMessage handle (when the operator configured
		// `channels.bluebubbles.selfHandle`) — lets the central pipeline's group
		// mention-gating match `msg.mentions` against the bot. Undefined when unset.
		selfId(): string | undefined {
			return selfHandle || undefined;
		},

		connectedAt(): number | null {
			return connection?.connectedAt() ?? null;
		},

		// The BlueBubbles bot runs AS the operator's signed-in Messages.app, so the
		// pairing card uses the "account" label.
		pairing: { idLabel: "account" as const },

		setup: {
			credentialKeys: [
				{
					key: "serverUrl",
					prompt: "BlueBubbles server URL (e.g. http://192.168.1.5:1234). Find it in the BlueBubbles Server app under Connection.",
					secret: false,
					envVar: "BLUEBUBBLES_SERVER_URL",
				},
				{
					key: "password",
					prompt: "BlueBubbles server password (BlueBubbles Server app → Settings).",
					secret: true,
					envVar: "BLUEBUBBLES_PASSWORD",
				},
				{
					key: "webhookPath",
					prompt:
						"Inbound webhook path (optional; default /bluebubbles/webhook). After setup, add your gateway URL + this path in BlueBubbles Server → Settings → Webhooks and enable it (e.g. https://your-gateway-host:3000/bluebubbles/webhook).",
					secret: false,
				},
				{
					key: "dmPolicy",
					prompt:
						"Who may DM this account? pairing (owner + approved; strangers challenged — default) / allowlist (only allowFrom) / open (anyone) / disabled (drop all DMs). Leave blank for pairing.",
					secret: false,
				},
				{
					key: "allowFrom",
					prompt:
						"Allowlist of senders for allowlist mode — handles or chat targets, comma-separated (e.g. +15555550123, user@example.com, chat_id:123). Leave blank for none.",
					secret: false,
				},
			],
			validateInput(key: string, value: string): string | null {
				const v = value.trim();
				if (key === "serverUrl" && v && !/^https?:\/\//i.test(v) && !/^[\w.-]+(:\d+)?$/.test(v)) {
					return "Server URL must be a host or http(s):// URL.";
				}
				if (key === "webhookPath" && v && !v.startsWith("/")) {
					return "Webhook path must start with /.";
				}
				if (key === "dmPolicy" && v && !["pairing", "allowlist", "open", "disabled"].includes(v.toLowerCase())) {
					return "dmPolicy must be one of: pairing, allowlist, open, disabled.";
				}
				return null;
			},
			buildAccountConfig(values: Record<string, string>): Record<string, unknown> {
				const out: Record<string, unknown> = { enabled: true };
				const serverUrl = (values.serverUrl ?? "").trim();
				if (serverUrl) out.serverUrl = serverUrl;
				const webhookPath = (values.webhookPath ?? "").trim();
				if (webhookPath) out.webhookPath = webhookPath;
				const dmPolicy = (values.dmPolicy ?? "").trim().toLowerCase();
				if (dmPolicy && dmPolicy !== "pairing") out.dmPolicy = dmPolicy;
				const allowFrom = (values.allowFrom ?? "")
					.split(/[\n,]+/g)
					.map((s) => s.trim())
					.filter(Boolean);
				if (allowFrom.length > 0) out.allowFrom = allowFrom;
				return out;
			},
		},

		get capabilities(): ChannelCapabilities {
			return buildCapabilities(actions, privateApi);
		},

		async handleAction(params): Promise<ChannelMessageActionResult> {
			if (!connection) return { ok: false, error: "BlueBubbles channel is not started" };
			const action = params.action;
			try {
				switch (action.kind) {
					case "react": {
						if (!actions.reactions || privateApi !== true) {
							return { ok: false, error: "BlueBubbles reactions require the Private API" };
						}
						await connection.react({
							conversationId: params.conversationId,
							messageId: action.messageId,
							reaction: action.emoji,
						});
						return { ok: true };
					}
					case "edit": {
						if (!actions.edit || privateApi !== true) {
							return { ok: false, error: "BlueBubbles message edit requires the Private API" };
						}
						// macOS 26+ removed iMessage message EDIT — refuse cleanly.
						if (isMacOSEditUnsupported(macOSMajor)) {
							return { ok: false, error: "message edit isn't supported on macOS 26+" };
						}
						await connection.edit({ messageId: action.messageId, text: action.text });
						return { ok: true };
					}
					case "delete": {
						if (!actions.unsend || privateApi !== true) {
							return { ok: false, error: "BlueBubbles unsend requires the Private API" };
						}
						await connection.unsend({ messageId: action.messageId });
						return { ok: true };
					}
					default:
						return { ok: false, error: `BlueBubbles does not support the "${action.kind}" action` };
				}
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
	};

	return adapter;
}
