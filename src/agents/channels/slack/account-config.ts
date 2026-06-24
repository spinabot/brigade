/**
 * Slack config-shape helpers (multi-WORKSPACE aware; mirrors Telegram's
 * `account-config.ts`).
 *
 * Slack needs MORE than one secret per workspace, unlike Telegram's single bot
 * token:
 *   - `botToken`    (`xoxb-…`) — the bot user token; every Web API call uses it.
 *   - `appToken`    (`xapp-…`) — the app-level token; REQUIRED for Socket Mode
 *                                 (opens the events websocket via
 *                                 `apps.connections.open`).
 *   - `signingSecret`          — HMAC secret; REQUIRED for Events-API (HTTP)
 *                                 mode to verify Slack's request signature.
 *   - `userToken`   (`xoxp-…`) — OPTIONAL; user-scoped token for reads that the
 *                                 bot token can't do (e.g. some file fetches).
 *
 * Two config shapes are recognised so the surface lines up with WhatsApp /
 * Telegram:
 *
 *   Legacy (single-workspace):
 *     channels.slack = { enabled: true, botToken: "xoxb-…", appToken: "xapp-…" }
 *
 *   Multi-workspace:
 *     channels.slack = {
 *       enabled: true,
 *       accounts: [
 *         { id: "acme", botToken: "xoxb-AAA", appToken: "xapp-AAA" },
 *         { id: "labs", botToken: "xoxb-BBB", appToken: "xapp-BBB" },
 *       ],
 *     }
 *
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 *
 * Token resolution mirrors Telegram: a `${VAR}` ref expands against
 * `process.env`; otherwise the literal passes through; then a DURABLE sealed
 * token (written by `connect_channel`) is consulted so the channel survives a
 * reboot; finally a per-secret env var is the last-resort fallback. Each Slack
 * secret seals under its own sub-key (`channel:slack` for the bot token,
 * `channel:slack:app` / `channel:slack:signing` for the others) so all three
 * ride the same encrypted credential store.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { readSealedChannelToken } from "../channel-secrets.js";

const CHANNEL_ID = "slack";
const DEFAULT_ACCOUNT_ID = "default";

/** Per-secret env vars consulted as a last-resort fallback. */
const BOT_TOKEN_ENV_VAR = "SLACK_BOT_TOKEN";
const APP_TOKEN_ENV_VAR = "SLACK_APP_TOKEN";
const SIGNING_SECRET_ENV_VAR = "SLACK_SIGNING_SECRET";
const USER_TOKEN_ENV_VAR = "SLACK_USER_TOKEN";

/** Sealed-token sub-keys (so the three Slack secrets each get a durable home). */
const SEAL_KEY_BOT = CHANNEL_ID; // `channel:slack`
const SEAL_KEY_APP = `${CHANNEL_ID}:app`; // `channel:slack:app`
const SEAL_KEY_SIGNING = `${CHANNEL_ID}:signing`; // `channel:slack:signing`

/** `${VAR}` secret-ref form — identical to `config/io.ts`'s SECRET_REF_PATTERN. */
const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** Default gateway path the Events-API transport registers + Slack POSTs to. */
const DEFAULT_EVENTS_PATH = "/slack/events";

/** Raw shape of one entry under `channels.slack.accounts`. */
interface SlackAccountEntry {
	id?: string;
	enabled?: boolean;
	botToken?: string;
	appToken?: string;
	signingSecret?: string;
	userToken?: string;
	[key: string]: unknown;
}

interface SlackChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	botToken?: string;
	appToken?: string;
	signingSecret?: string;
	userToken?: string;
	accounts?: SlackAccountEntry[];
	/** Transport mode — `"socket"` (default, local-first) or `"events"` (HTTP). */
	mode?: string;
	/** Events-API config (only consulted when `mode === "events"`). */
	events?: SlackEventsConfigSlot;
	/** Idle TTL (ms / duration string) after which idle thread sessions are reaped. */
	threadIdleTtlMs?: number | string;
	/**
	 * Live-stream the agent reply by progressively editing one message as tokens
	 * arrive (default OFF → one final chunked message). When true the adapter
	 * posts a placeholder and edits it ~1×/sec until the turn settles.
	 */
	liveStream?: boolean;
	/** Override the streaming edit throttle in ms (clamped ≥ 250). Default 1000. */
	streamThrottleMs?: number;
	/**
	 * ALSO deliver the model's `<think>` reasoning as a separate prefixed message
	 * (default OFF). The answer message is unchanged either way.
	 */
	surfaceReasoning?: boolean;
	[key: string]: unknown;
}

/** Raw `channels.slack.events` shape (Events-API / HTTP mode). */
interface SlackEventsConfigSlot {
	/** Public base URL Slack POSTs events to (e.g. `https://bot.example.com`). */
	url?: string;
	/** Route path on the gateway (default `/slack/events`). */
	path?: string;
	[key: string]: unknown;
}

/** Resolved per-account info — what the adapter runtime reads. */
export interface ResolvedSlackAccount {
	accountId: string;
	enabled: boolean;
	/** Bot user token (`xoxb-…`), fully resolved, or `""` when unset. */
	botToken: string;
	/** App-level token (`xapp-…`) for Socket Mode, fully resolved, or `""`. */
	appToken: string;
	/** HMAC signing secret for Events-API mode, fully resolved, or `""`. */
	signingSecret: string;
	/** Optional user token (`xoxp-…`) for user-scoped reads, or `""`. */
	userToken: string;
	verbose: boolean;
}

/** Read `channels.slack` loosely (schema keeps it open). */
function slackChannelConfig(cfg: BrigadeConfig): SlackChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, SlackChannelConfigSlot> }).channels?.[CHANNEL_ID];
}

/**
 * Resolve a single token-ish string: a `${VAR}` ref expands against
 * `process.env`; any other non-empty string passes through verbatim; empty /
 * missing returns "".
 */
function resolveTokenRef(raw: string | undefined, env: NodeJS.ProcessEnv): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const m = SECRET_REF_PATTERN.exec(trimmed);
	if (m && m[1]) return (env[m[1]] ?? "").trim();
	return trimmed;
}

/** Is the Slack channel switched on at all (any shape)? */
export function slackChannelEnabled(cfg: BrigadeConfig): boolean {
	return slackChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listSlackAccountIds(cfg: BrigadeConfig): string[] {
	const slot = slackChannelConfig(cfg);
	if (!slot || slot.enabled !== true) return [];
	const accounts = Array.isArray(slot.accounts) ? slot.accounts : undefined;
	if (!accounts || accounts.length === 0) return [DEFAULT_ACCOUNT_ID];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of accounts) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	// A half-typed `accounts:[]` still degrades to the default account so the
	// channel isn't silently disabled.
	return ids.length === 0 ? [DEFAULT_ACCOUNT_ID] : ids;
}

/** Look up the raw account entry from config (or null when missing). */
function findAccountEntry(cfg: BrigadeConfig, accountId: string): SlackAccountEntry | null {
	const slot = slackChannelConfig(cfg);
	if (!slot) return null;
	const accounts = Array.isArray(slot.accounts) ? slot.accounts : undefined;
	if (!accounts) return null;
	for (const entry of accounts) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (id === accountId) return entry;
	}
	return null;
}

/**
 * Resolve one Slack secret for an account. Precedence (mirrors Telegram's token
 * resolution): per-account config `${VAR}`/literal → top-level config → durable
 * sealed token → per-secret env var. Returns `""` when nothing resolves.
 */
function resolveSecret(
	cfg: BrigadeConfig,
	accountId: string | null | undefined,
	field: "botToken" | "appToken" | "signingSecret" | "userToken",
	sealKey: string | null,
	envVar: string | null,
	env: NodeJS.ProcessEnv,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = slackChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveTokenRef(entry?.[field] as string | undefined, env);
	if (perAccount) return perAccount;
	const topLevel = resolveTokenRef(slot?.[field] as string | undefined, env);
	if (topLevel) return topLevel;
	if (sealKey) {
		const sealed = readSealedChannelToken(sealKey);
		if (sealed) return sealed;
	}
	if (envVar) {
		const fromEnv = (env[envVar] ?? "").trim();
		if (fromEnv) return fromEnv;
	}
	return "";
}

/** Resolve the bot user token (`xoxb-…`) for an account. */
export function resolveSlackBotToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "botToken", SEAL_KEY_BOT, BOT_TOKEN_ENV_VAR, env);
}

/** Resolve the app-level token (`xapp-…`, Socket Mode) for an account. */
export function resolveSlackAppToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "appToken", SEAL_KEY_APP, APP_TOKEN_ENV_VAR, env);
}

/** Resolve the HMAC signing secret (Events-API mode) for an account. */
export function resolveSlackSigningSecret(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "signingSecret", SEAL_KEY_SIGNING, SIGNING_SECRET_ENV_VAR, env);
}

/** Resolve the optional user token (`xoxp-…`) for an account. */
export function resolveSlackUserToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "userToken", null, USER_TOKEN_ENV_VAR, env);
}

/** Resolve a per-account view of the config (defaults + token resolution filled in). */
export function resolveSlackAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedSlackAccount {
	const slot = slackChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	return {
		accountId: id,
		enabled,
		botToken: resolveSlackBotToken(cfg, id, env),
		appToken: resolveSlackAppToken(cfg, id, env),
		signingSecret: resolveSlackSigningSecret(cfg, id, env),
		userToken: resolveSlackUserToken(cfg, id, env),
		verbose: slot?.verbose === true,
	};
}

/* ───────────────────────── transport / lifecycle config ───────────────────────── */

/** Resolved Slack transport config (mode + events-API details). */
export interface SlackEventsConfig {
	/** `"socket"` (default) or `"events"`. */
	mode: "socket" | "events";
	/** Public base URL Slack POSTs to (events mode). `""` when unset. */
	url: string;
	/** Gateway route path (default `/slack/events`). */
	path: string;
}

/**
 * Resolve the Slack transport config. Defaults to `socket` (Brigade is
 * local-first and Socket Mode needs no public URL); `events` is opt-in via
 * `channels.slack.mode: "events"`.
 */
export function slackEventsConfig(cfg: BrigadeConfig): SlackEventsConfig {
	const slot = slackChannelConfig(cfg);
	const rawMode = typeof slot?.mode === "string" ? slot.mode.trim().toLowerCase() : "";
	const mode: "socket" | "events" = rawMode === "events" || rawMode === "http" ? "events" : "socket";
	const ev = slot?.events ?? {};
	const path = typeof ev.path === "string" && ev.path.trim() ? ev.path.trim() : DEFAULT_EVENTS_PATH;
	return {
		mode,
		url: typeof ev.url === "string" ? ev.url.trim() : "",
		path: path.startsWith("/") ? path : `/${path}`,
	};
}

/**
 * True when live reply-streaming is enabled (`channels.slack.liveStream`).
 * Default OFF — the adapter delivers one final chunked message.
 */
export function slackLiveStreamEnabled(cfg: BrigadeConfig): boolean {
	return slackChannelConfig(cfg)?.liveStream === true;
}

/**
 * Resolve the streaming edit throttle in ms. Reads
 * `channels.slack.streamThrottleMs`; falls back to 1000ms (floored at 250ms by
 * the draft-stream).
 */
export function slackStreamThrottleMs(cfg: BrigadeConfig): number {
	const raw = slackChannelConfig(cfg)?.streamThrottleMs;
	return typeof raw === "number" && raw > 0 ? raw : 1000;
}

/**
 * True when reasoning surfacing is enabled (`channels.slack.surfaceReasoning`).
 * Default OFF — `<think>` reasoning is stripped from channel replies as today.
 */
export function slackSurfaceReasoning(cfg: BrigadeConfig): boolean {
	return slackChannelConfig(cfg)?.surfaceReasoning === true;
}

/**
 * Resolve the idle-thread-session TTL in ms, or `null` when unset / disabled.
 * Accepts a number (ms) or a duration string (`"6h"`, `"30m"`, …). The cron
 * session-reaper uses this to age out idle Slack thread sessions.
 */
export function slackThreadIdleTtlMs(cfg: BrigadeConfig): number | null {
	const raw = slackChannelConfig(cfg)?.threadIdleTtlMs;
	if (typeof raw === "number") return raw > 0 ? raw : null;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const m = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(trimmed);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = (m[2] ?? "ms").toLowerCase();
	const mult: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, ms: 1 };
	const factor = mult[unit] ?? 1;
	return n * factor;
}

export {
	CHANNEL_ID as SLACK_CHANNEL_ID,
	DEFAULT_ACCOUNT_ID as SLACK_DEFAULT_ACCOUNT_ID,
	BOT_TOKEN_ENV_VAR as SLACK_BOT_TOKEN_ENV_VAR,
	APP_TOKEN_ENV_VAR as SLACK_APP_TOKEN_ENV_VAR,
	SIGNING_SECRET_ENV_VAR as SLACK_SIGNING_SECRET_ENV_VAR,
	USER_TOKEN_ENV_VAR as SLACK_USER_TOKEN_ENV_VAR,
};
