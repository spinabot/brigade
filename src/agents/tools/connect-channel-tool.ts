/**
 * `connect_channel` — let the crew connect / disconnect a messaging channel
 * from chat, LIVE, without a gateway restart.
 *
 * This is the marquee of the channel-foundation work: the operator can say
 * "connect Telegram, here's the token from @BotFather" and the agent runs ONE
 * grounded tool call that (1) seals the token as a `${VAR}` secret-ref in config
 * (never the raw value on disk), (2) flips `channels.<channel>.enabled = true`
 * via `mutateConfigAtomic`, and (3) starts the channel adapter live through the
 * channel manager (`getActiveChannelManager().startChannel(id)`). No
 * hand-editing brigade.json, no `brigade gateway restart`.
 *
 * GATING — per-call `senderIsOwner` (the cron-tool doctrine, NOT blanket
 * ownerOnly):
 *   - `list` / `status` are READ-ONLY and safe for anyone (peers can see what's
 *     connected + each channel's health).
 *   - `connect` / `disconnect` MOVE A SECURITY BOUNDARY (they wire up / tear
 *     down a live messaging surface and persist credentials). A channel peer
 *     must NEVER do this, so those actions are refused unless the turn is
 *     owner-routed. `senderIsOwner` defaults to TRUE so the TUI / direct-RPC /
 *     test paths keep full access; the gateway threads `false` for
 *     approved-non-owner channel peers.
 *
 * SECRET HANDLING — durable seal + live env ref (two layers):
 *   - DURABLE: the token is written to Brigade's encrypted credential store via
 *     `sealChannelToken` (atomic 0600 JSON on disk; AES-256-GCM sealed in convex
 *     mode). This is the source of truth ACROSS a gateway reboot — the channel
 *     reads it back at start even after the process (and its env) is gone. This
 *     closes the gap where an env-only token evaporated on restart and the
 *     channel silently failed to authenticate.
 *   - LIVE: the raw token is also set into `process.env[BRIGADE_<CHANNEL>_TOKEN]`
 *     and the config stores ONLY the literal ref `"${BRIGADE_<CHANNEL>_TOKEN}"`
 *     so the just-started adapter resolves it immediately this process.
 *   - The resolved token NEVER touches brigade.json (only the `${VAR}` ref), and
 *     the tool result masks it.
 */

import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic, type BrigadeConfig } from "../../config/io.js";
import { getActiveChannelManager } from "../channels/active-manager.js";
import { sealChannelToken } from "../channels/channel-secrets.js";
import { getActiveRegistry } from "../extensions/active-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const log = createSubsystemLogger("tools/connect-channel");

const ConnectChannelParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("connect"),
			Type.Literal("disconnect"),
		],
		{
			description:
				"list/status: report available + connected channels and their health (read-only, safe). connect: enable a channel + (when needed) store its token + start it LIVE. disconnect: stop + disable a channel at runtime.",
		},
	),
	channel: Type.Optional(
		Type.String({
			description:
				'Channel id under config.channels (e.g. "telegram", "whatsapp"). Required for connect / disconnect; for status, narrows to one channel.',
			minLength: 1,
			maxLength: 64,
		}),
	),
	token: Type.Optional(
		Type.String({
			description:
				"Secret/credential to connect a TOKEN-based channel (e.g. the Telegram bot token from @BotFather). Stored as a `${VAR}` secret-ref — NEVER persisted raw. Omit for channels that pair another way (WhatsApp uses a QR link, not a token — point the operator at `brigade channels link --channel whatsapp`).",
			maxLength: 8192,
		}),
	),
});

/** One channel's view in a list/status response. */
interface ChannelView {
	channel: string;
	label: string;
	/** channels.<id>.enabled in brigade.json. */
	enabled: boolean;
	/** adapter.isConfigured(cfg) — has credentials/settings to run. */
	configured: boolean;
	/** Currently started + running in this gateway process. */
	connected: boolean;
	/** Health verdict for a connected channel (ok | degraded reason). */
	health?: { ok: boolean; reason?: string; remediation?: string };
}

interface ConnectChannelResult {
	action: "list" | "status" | "connect" | "disconnect";
	ok: boolean;
	message: string;
	/** For connect: whether the adapter actually started live this call. */
	started?: boolean;
	/** For disconnect: whether a running adapter was actually stopped. */
	stopped?: boolean;
	/** list/status payload. */
	channels?: ChannelView[];
	/** Single-channel view for connect / disconnect / narrowed status. */
	channelState?: ChannelView;
}

/** Options threaded in at registry time — same shape family as cron-tool. */
export interface MakeConnectChannelToolOptions {
	/**
	 * Whether the current turn is owner-routed. Defaults to TRUE (legacy
	 * TUI / direct-RPC / test paths keep full access). The gateway threads
	 * `false` for approved-non-owner channel peers so `connect`/`disconnect`
	 * are refused for them while `list`/`status` stay open.
	 */
	senderIsOwner?: boolean;
}

export function makeConnectChannelTool(
	opts: MakeConnectChannelToolOptions = {},
): BrigadeTool<typeof ConnectChannelParams, ConnectChannelResult> {
	// Default to owner-access when omitted so legacy paths (TUI / tests) keep
	// the previous full-access behaviour (same convention as cron-tool).
	const senderIsOwner = opts.senderIsOwner !== false;

	return {
		name: "connect_channel",
		label: "Connect Channel",
		displaySummary: "connecting a messaging channel",
		// NOTE: deliberately NOT `ownerOnly: true`. list/status are safe for
		// peers; the per-call gate below refuses ONLY the mutating actions.
		description: [
			"Connect or disconnect a messaging channel (Telegram, WhatsApp, …) from chat, live, without a gateway restart.",
			"list / status: report available + connected channels and their health (read-only — anyone can call).",
			"connect {channel, token?}: OWNER-ONLY. Enables the channel, seals a provided token as a `${VAR}` secret-ref (never stored raw), and starts it LIVE via the channel manager. For token channels (Telegram) pass `token`; for QR channels (WhatsApp) omit it and tell the operator to run `brigade channels link --channel whatsapp`.",
			"disconnect {channel}: OWNER-ONLY. Stops + disables the channel at runtime.",
			"Call connect/disconnect ONLY on explicit operator request; report exactly what changed. Never hand-edit brigade.json — the config-write guard refuses it.",
		].join(" "),
		parameters: ConnectChannelParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<ConnectChannelResult>> => {
			const action = args.action;

			// READ-ONLY actions — safe for anyone.
			if (action === "list" || action === "status") {
				const wantChannel = (args.channel ?? "").trim().toLowerCase();
				const views = buildChannelViews(wantChannel || undefined);
				if (action === "status" && wantChannel) {
					const view = views.find((v) => v.channel === wantChannel);
					if (!view) {
						return jsonResult({
							action,
							ok: false,
							message: `No channel adapter registered with id "${wantChannel}". Available: ${listAvailableIds().join(", ") || "none"}.`,
						} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
					}
					return jsonResult({
						action,
						ok: true,
						channelState: view,
						message: describeView(view),
					} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
				}
				return jsonResult({
					action,
					ok: true,
					channels: views,
					message: summarizeViews(views),
				} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
			}

			// MUTATING actions — owner-gated (per-call).
			if (!senderIsOwner) {
				return jsonResult({
					action,
					ok: false,
					message:
						"connect_channel: connecting or disconnecting a channel is owner-only — a channel peer cannot alter the operator's channels. Ask the operator to do this from the TUI.",
				} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
			}

			const channel = (args.channel ?? "").trim().toLowerCase();
			if (!channel) {
				return jsonResult({
					action,
					ok: false,
					message: `connect_channel ${action}: a channel id is required (e.g. "telegram").`,
				} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
			}

			// The adapter must be a registered, bundled channel — refuse arbitrary ids.
			const known = listAvailableIds();
			if (!known.includes(channel)) {
				return jsonResult({
					action,
					ok: false,
					message: `connect_channel ${action}: no channel adapter registered with id "${channel}". Available: ${known.join(", ") || "none"}.`,
				} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
			}

			if (action === "connect") return connectChannel(channel, args.token);
			return disconnectChannel(channel);
		},
	};
}

/* ───────────────────────────── connect ───────────────────────────── */

async function connectChannel(
	channel: string,
	rawToken: string | undefined,
): Promise<AgentToolResult<ConnectChannelResult>> {
	const token = (rawToken ?? "").trim();

	// 1) Persist: enable the channel + (when a token was supplied) seal it.
	//    Two-layer seal so the token survives BOTH this process and a reboot:
	//      (a) DURABLE: write the token to the encrypted credential store
	//          (`sealChannelToken`) — atomic 0600 on disk, AES-256-GCM in convex
	//          mode. This is what the channel reads back at start AFTER a gateway
	//          restart (env is gone by then). Source of truth across reboots.
	//      (b) LIVE: set `process.env[VAR]` + a `${VAR}` ref in brigade.json so
	//          the just-started adapter resolves the token immediately this
	//          process without re-reading the sealed store.
	//    The raw token NEVER lands in brigade.json (only the `${VAR}` ref) and
	//    the tool result masks it.
	let envVarName: string | undefined;
	if (token) {
		// (a) durable encrypted seal — survives the reboot.
		try {
			sealChannelToken(channel, token);
		} catch (err) {
			log.warn("connect_channel: durable token seal failed (continuing with env ref)", {
				channel,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// (b) live env for immediate resolution this process.
		envVarName = secretEnvVarName(channel);
		process.env[envVarName] = token;
	}

	const next = await mutateConfigAtomic((current: BrigadeConfig) => {
		const merged: BrigadeConfig = { ...current };
		const channels = {
			...((merged as { channels?: Record<string, unknown> }).channels ?? {}),
		} as Record<string, Record<string, unknown>>;
		const entry = { ...(channels[channel] ?? {}) } as Record<string, unknown>;
		entry.enabled = true;
		if (envVarName) {
			// Store the literal ref string — a brand-new field is written verbatim
			// by restoreEnvVarRefsRecursive, so `${VAR}` lands on disk (NOT the
			// resolved token). For Telegram this is the canonical `botToken` slot.
			entry[tokenConfigKey(channel)] = `\${${envVarName}}`;
		}
		channels[channel] = entry;
		(merged as Record<string, unknown>).channels = channels;
		return merged;
	});

	// 2) Start it LIVE through the channel manager (no gateway restart). Pass the
	//    freshly-written config so isConfigured + start() see enabled + the token.
	const manager = getActiveChannelManager();
	if (!manager) {
		// Honest fallback — config is written, but no live manager to start it.
		log.info("connect_channel: config written but no live channel manager", { channel });
		return jsonResult({
			action: "connect",
			ok: true,
			started: false,
			channelState: viewFor(channel, next as BrigadeConfig),
			message: `Configured "${channel}" (enabled${token ? " + token sealed" : ""}). The gateway isn't running, so it will connect on next start. Run \`brigade gateway\` (or restart it) to connect now.`,
		} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
	}

	const result = await manager.startChannel(channel, next as BrigadeConfig);
	const view = viewFor(channel, next as BrigadeConfig);
	if (result.ok) {
		return jsonResult({
			action: "connect",
			ok: true,
			started: result.started,
			channelState: view,
			message: result.started
				? `Connected "${channel}" — it's live now${token ? " (token sealed as a secret ref)" : ""}. ${describeView(view)}`
				: `"${channel}" is already connected. ${describeView(view)}`,
		} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
	}

	// Config is written but the live start didn't take (e.g. still not
	// configured, or the adapter's start threw). Be HONEST: report it and give
	// the restart fallback.
	return jsonResult({
		action: "connect",
		ok: false,
		started: false,
		channelState: view,
		message: `Saved config for "${channel}" but couldn't start it live: ${result.message ?? result.reason ?? "unknown error"}. ${remediationFor(channel)}`,
	} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
}

/* ───────────────────────────── disconnect ───────────────────────────── */

async function disconnectChannel(channel: string): Promise<AgentToolResult<ConnectChannelResult>> {
	// 1) Stop it live (if a manager is running + it's started).
	const manager = getActiveChannelManager();
	let stopped = false;
	if (manager) {
		const res = await manager.stopChannel(channel);
		stopped = res.stopped;
	}

	// 2) Disable it in config so it doesn't come back on the next boot.
	const next = await mutateConfigAtomic((current: BrigadeConfig) => {
		const merged: BrigadeConfig = { ...current };
		const channels = {
			...((merged as { channels?: Record<string, unknown> }).channels ?? {}),
		} as Record<string, Record<string, unknown>>;
		const entry = { ...(channels[channel] ?? {}) } as Record<string, unknown>;
		entry.enabled = false;
		channels[channel] = entry;
		(merged as Record<string, unknown>).channels = channels;
		return merged;
	});

	const view = viewFor(channel, next as BrigadeConfig);
	return jsonResult({
		action: "disconnect",
		ok: true,
		stopped,
		channelState: view,
		message: stopped
			? `Disconnected "${channel}" — stopped it live and disabled it in config (won't reconnect on restart).`
			: `Disabled "${channel}" in config. It wasn't running, so nothing to stop.`,
	} satisfies ConnectChannelResult) as AgentToolResult<ConnectChannelResult>;
}

/* ───────────────────────────── helpers ───────────────────────────── */

/**
 * Env var that backs a channel's sealed token. `telegram` →
 * `BRIGADE_TELEGRAM_TOKEN`. Uppercased + non-alnum→`_` so any channel id
 * yields a legal env name (and matches the `${VAR}` SECRET_REF_PATTERN, which
 * requires `[A-Z_][A-Z0-9_]*`).
 */
function secretEnvVarName(channel: string): string {
	const slug = channel.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return `BRIGADE_${slug || "CHANNEL"}_TOKEN`;
}

/**
 * Which config key under `channels.<id>` holds the token. Telegram's adapter
 * reads `botToken`; default to that name for unknown token channels too (it's
 * the established convention).
 */
function tokenConfigKey(_channel: string): string {
	return "botToken";
}

/** All registered channel ids (bundled + user). Empty when no registry mounted. */
function listAvailableIds(): string[] {
	const registry = getActiveRegistry();
	if (!registry) return [];
	return registry.channels.map((a) => a.id);
}

/** Set of channel ids currently started in this gateway process. */
function connectedIdSet(): Set<string> {
	const manager = getActiveChannelManager();
	return new Set(manager ? manager.started : []);
}

/** Build a view for every registered channel (or just one when `only` is set). */
function buildChannelViews(only?: string): ChannelView[] {
	const registry = getActiveRegistry();
	if (!registry) return [];
	const cfg = loadConfig() as BrigadeConfig;
	const connected = connectedIdSet();
	const manager = getActiveChannelManager();
	const out: ChannelView[] = [];
	for (const adapter of registry.channels) {
		if (only && adapter.id !== only) continue;
		const enabled =
			(cfg as { channels?: Record<string, { enabled?: boolean }> }).channels?.[adapter.id]?.enabled === true;
		let configured = false;
		try {
			configured = adapter.isConfigured(cfg);
		} catch {
			/* adapters shouldn't throw here, but be safe */
		}
		const isConnected = connected.has(adapter.id);
		const view: ChannelView = {
			channel: adapter.id,
			label: adapter.label,
			enabled,
			configured,
			connected: isConnected,
		};
		// Health only meaningful for a started adapter exposing health().
		if (isConnected && manager) {
			const live = manager.adapter(adapter.id);
			if (live && typeof live.health === "function") {
				const h = live.health();
				view.health = {
					ok: h.ok,
					...(!h.ok && h.reason ? { reason: h.reason } : {}),
					...(!h.ok && h.remediation ? { remediation: h.remediation } : {}),
				};
			}
		}
		out.push(view);
	}
	return out;
}

/** Single-channel view from a specific config snapshot (post-write). */
function viewFor(channel: string, cfg: BrigadeConfig): ChannelView {
	const registry = getActiveRegistry();
	const adapter = registry?.channels.find((a) => a.id === channel);
	const enabled =
		(cfg as { channels?: Record<string, { enabled?: boolean }> }).channels?.[channel]?.enabled === true;
	const connected = connectedIdSet().has(channel);
	let configured = false;
	if (adapter) {
		try {
			configured = adapter.isConfigured(cfg);
		} catch {
			/* ignore */
		}
	}
	const view: ChannelView = {
		channel,
		label: adapter?.label ?? channel,
		enabled,
		configured,
		connected,
	};
	const manager = getActiveChannelManager();
	if (connected && manager) {
		const live = manager.adapter(channel);
		if (live && typeof live.health === "function") {
			const h = live.health();
			view.health = {
				ok: h.ok,
				...(!h.ok && h.reason ? { reason: h.reason } : {}),
				...(!h.ok && h.remediation ? { remediation: h.remediation } : {}),
			};
		}
	}
	return view;
}

function describeView(v: ChannelView): string {
	const state = v.connected
		? v.health && !v.health.ok
			? `connected but degraded (${v.health.reason ?? "unknown"})`
			: "connected"
		: v.enabled
			? "enabled but not connected"
			: "not connected";
	return `${v.label}: ${state}.`;
}

function summarizeViews(views: ChannelView[]): string {
	if (views.length === 0) return "No channels are registered.";
	const connected = views.filter((v) => v.connected).map((v) => v.label);
	const available = views.filter((v) => !v.connected).map((v) => v.label);
	const parts: string[] = [];
	parts.push(connected.length > 0 ? `Connected: ${connected.join(", ")}.` : "No channels connected.");
	if (available.length > 0) parts.push(`Available to connect: ${available.join(", ")}.`);
	return parts.join(" ");
}

function remediationFor(channel: string): string {
	if (channel === "whatsapp") {
		return "WhatsApp links via QR, not a token — run `brigade channels link --channel whatsapp` (gateway stopped), then it connects on next start.";
	}
	return `Check the token/settings, then retry — or restart the gateway with \`brigade gateway\` to pick up the saved config.`;
}
