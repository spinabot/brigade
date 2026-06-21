/**
 * Telegram config-shape helpers (single-account v1; multi-account aware shape).
 *
 * Brigade's Telegram config is TOKEN-based (no QR/OAuth pairing — the operator
 * pastes a Bot API token from @BotFather). Two shapes are recognised so the
 * surface lines up with WhatsApp's `account-config.ts`:
 *
 *   Legacy (single-account):
 *     channels.telegram = { enabled: true, botToken: "123:ABC", verbose?: boolean }
 *
 *   Multi-account (later follow-up — the shape is honoured now, v1 ships one):
 *     channels.telegram = {
 *       enabled: true,
 *       accounts: [
 *         { id: "main", botToken: "111:AAA" },
 *         { id: "ops",  botToken: "222:BBB" },
 *       ],
 *     }
 *
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 *
 * Token resolution: a value of the form `${VAR}` is resolved against
 * `process.env[VAR]` (mirrors Brigade's config secret-ref convention, so a
 * token never has to be committed as a literal). When no token is configured
 * at all, the `TELEGRAM_BOT_TOKEN` environment variable is the last-resort
 * fallback. NOTE: Brigade's config loader already resolves `${VAR}` leaves on
 * read (`resolveSecretsInPlace`), so by the time the adapter reads config the
 * ref is usually already expanded — the explicit resolution here is defensive
 * for callers (CLI/tests) that read raw config and for the env fallback.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { readSealedChannelToken } from "../channel-secrets.js";

const CHANNEL_ID = "telegram";
const DEFAULT_ACCOUNT_ID = "default";

/** The env var consulted as a last-resort token fallback. */
const TOKEN_ENV_VAR = "TELEGRAM_BOT_TOKEN";

/** `${VAR}` secret-ref form — identical to `config/io.ts`'s SECRET_REF_PATTERN. */
const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** Raw shape of one entry under `channels.telegram.accounts`. */
interface TelegramAccountEntry {
	id?: string;
	enabled?: boolean;
	botToken?: string;
	[key: string]: unknown;
}

interface TelegramChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	botToken?: string;
	accounts?: TelegramAccountEntry[];
	/** Transport mode — `"polling"` (default, local-first) or `"webhook"`. */
	mode?: string;
	/** Webhook config (only consulted when `mode === "webhook"`). */
	webhook?: TelegramWebhookConfigSlot;
	/** Rename a forum topic from its first message when true. */
	autoLabelTopics?: boolean;
	/** Idle TTL (ms / duration string) after which idle thread sessions are reaped. */
	threadIdleTtlMs?: number | string;
	[key: string]: unknown;
}

/** Raw `channels.telegram.webhook` shape. */
interface TelegramWebhookConfigSlot {
	/** Public base URL Telegram will POST updates to (e.g. `https://bot.example.com`). */
	url?: string;
	/** Route path on the gateway (default `/telegram/webhook`). */
	path?: string;
	/** Secret token verified against the `X-Telegram-Bot-Api-Secret-Token` header. */
	secretToken?: string;
	[key: string]: unknown;
}

/** Resolved per-account info — what the adapter runtime reads. */
export interface ResolvedTelegramAccount {
	accountId: string;
	enabled: boolean;
	/** Bot API token, fully resolved (`${VAR}` + env fallback applied), or `""` when unset. */
	botToken: string;
	verbose: boolean;
}

/** Read `channels.telegram` loosely (schema keeps it open). */
function telegramChannelConfig(cfg: BrigadeConfig): TelegramChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, TelegramChannelConfigSlot> }).channels?.[CHANNEL_ID];
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

/** Is the Telegram channel switched on at all (any shape)? */
export function telegramChannelEnabled(cfg: BrigadeConfig): boolean {
	return telegramChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listTelegramAccountIds(cfg: BrigadeConfig): string[] {
	const slot = telegramChannelConfig(cfg);
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
function findAccountEntry(cfg: BrigadeConfig, accountId: string): TelegramAccountEntry | null {
	const slot = telegramChannelConfig(cfg);
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
 * Resolve the Bot API token for an account. Precedence:
 *   1. The per-account `botToken` (multi-account shape), `${VAR}`-resolved.
 *   2. The top-level `channels.telegram.botToken` (legacy shape), `${VAR}`-resolved.
 *   3. The DURABLE sealed channel token (written by `connect_channel`) — this is
 *      the source that survives a gateway reboot, when the live env + `${VAR}`
 *      ref have evaporated.
 *   4. The `TELEGRAM_BOT_TOKEN` env var (last-resort fallback).
 * Returns `""` when no token can be resolved.
 *
 * Note the sealed token is consulted AFTER the config refs: an explicit config
 * `${VAR}` / literal that resolves in THIS process wins (so a live env set by
 * `connect_channel` is used immediately), and the durable seal is the fallback
 * that keeps the channel authenticated across restarts.
 */
export function resolveTelegramBotToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = telegramChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveTokenRef(entry?.botToken, env);
	if (perAccount) return perAccount;
	const topLevel = resolveTokenRef(slot?.botToken, env);
	if (topLevel) return topLevel;
	const sealed = readSealedChannelToken(CHANNEL_ID);
	if (sealed) return sealed;
	return (env[TOKEN_ENV_VAR] ?? "").trim();
}

/** Resolve a per-account view of the config (defaults + token resolution filled in). */
export function resolveTelegramAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedTelegramAccount {
	const slot = telegramChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	return {
		accountId: id,
		enabled,
		botToken: resolveTelegramBotToken(cfg, id, env),
		verbose: slot?.verbose === true,
	};
}

/* ───────────────────────── transport / lifecycle config ───────────────────────── */

/** Default gateway path the webhook transport registers + points `setWebhook` at. */
const DEFAULT_WEBHOOK_PATH = "/telegram/webhook";

/** Resolved Telegram transport config (mode + webhook details). */
export interface TelegramWebhookConfig {
	/** `"polling"` (default) or `"webhook"`. */
	mode: "polling" | "webhook";
	/** Public base URL Telegram POSTs to (webhook mode). `""` when unset. */
	url: string;
	/** Gateway route path (default `/telegram/webhook`). */
	path: string;
	/** Secret token verified on the inbound webhook header. `""` when unset. */
	secretToken: string;
}

/**
 * Resolve the Telegram transport config. Defaults to `polling` (Brigade is
 * local-first); `webhook` is opt-in via `channels.telegram.mode: "webhook"`.
 * `${VAR}` refs in the secret token are env-resolved (it's a secret).
 */
export function telegramWebhookConfig(
	cfg: BrigadeConfig,
	env: NodeJS.ProcessEnv = process.env,
): TelegramWebhookConfig {
	const slot = telegramChannelConfig(cfg);
	const rawMode = typeof slot?.mode === "string" ? slot.mode.trim().toLowerCase() : "";
	const mode: "polling" | "webhook" = rawMode === "webhook" ? "webhook" : "polling";
	const wh = slot?.webhook ?? {};
	const path = typeof wh.path === "string" && wh.path.trim() ? wh.path.trim() : DEFAULT_WEBHOOK_PATH;
	return {
		mode,
		url: typeof wh.url === "string" ? wh.url.trim() : "",
		path: path.startsWith("/") ? path : `/${path}`,
		secretToken: resolveTokenRef(wh.secretToken, env),
	};
}

/** True when forum-topic auto-labeling is enabled (`channels.telegram.autoLabelTopics`). */
export function telegramAutoLabelTopics(cfg: BrigadeConfig): boolean {
	return telegramChannelConfig(cfg)?.autoLabelTopics === true;
}

/**
 * Resolve the idle-thread-session TTL in ms, or `null` when unset / disabled.
 * Accepts a number (ms) or a duration string (`"6h"`, `"30m"`, …). The cron
 * session-reaper uses this to age out idle Telegram thread sessions.
 */
export function telegramThreadIdleTtlMs(cfg: BrigadeConfig): number | null {
	const raw = telegramChannelConfig(cfg)?.threadIdleTtlMs;
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
	CHANNEL_ID as TELEGRAM_CHANNEL_ID,
	DEFAULT_ACCOUNT_ID as TELEGRAM_DEFAULT_ACCOUNT_ID,
	TOKEN_ENV_VAR as TELEGRAM_BOT_TOKEN_ENV_VAR,
};
