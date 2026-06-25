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
import { probeBlueBubbles } from "./probe.js";

/** Practical per-message text limit for chunked sends (before bubble-splitting). */
const BLUEBUBBLES_TEXT_LIMIT = 10_000;

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
			// Probe once at start to detect Private-API status (gates rich actions +
			// honest capabilities). Never throws.
			try {
				const probe = await probeImpl({
					serverUrl: account.serverUrl,
					password: account.password,
					timeoutMs: account.probeTimeoutMs,
				});
				privateApi = probe.privateApi;
				if (!probe.ok) ctx.log(`BlueBubbles probe failed: ${probe.error ?? "unknown"}`);
			} catch {
				privateApi = null;
			}
			try {
				connection = connectImpl({
					account,
					log: ctx.log,
					privateApi,
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
							...(msg.resolveMedia ? { resolveMedia: msg.resolveMedia } : {}),
							raw: msg.raw,
						});
					},
				});
				started = true;
				ctx.log("BlueBubbles connected");
				ctx.onConnected?.();
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
			const sent = await connection.sendMedia(conversationId, media);
			return sent.messageId ? { messageId: sent.messageId } : undefined;
		},

		selfId(): string | undefined {
			return undefined;
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
					prompt: "BlueBubbles server URL (e.g. http://192.168.1.5:1234).",
					secret: false,
					envVar: "BLUEBUBBLES_SERVER_URL",
				},
				{
					key: "password",
					prompt: "BlueBubbles server password (configured in the BlueBubbles macOS app).",
					secret: true,
					envVar: "BLUEBUBBLES_PASSWORD",
				},
			],
			validateInput(key: string, value: string): string | null {
				if (key === "serverUrl" && value.trim() && !/^https?:\/\//i.test(value.trim()) && !/^[\w.-]+(:\d+)?$/.test(value.trim())) {
					return "Server URL must be a host or http(s):// URL.";
				}
				return null;
			},
			buildAccountConfig(values: Record<string, string>): Record<string, unknown> {
				const out: Record<string, unknown> = { enabled: true };
				const serverUrl = (values.serverUrl ?? "").trim();
				if (serverUrl) out.serverUrl = serverUrl;
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
