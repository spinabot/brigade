/**
 * BlueBubbles config-shape helpers (multi-ACCOUNT aware; mirrors Slack's
 * `account-config.ts`).
 *
 * BlueBubbles is a richer iMessage transport than the native `imessage` channel:
 * instead of driving a local `imsg` CLI subprocess, it talks to a BlueBubbles
 * macOS server over HTTP REST (outbound) and receives inbound updates via a
 * webhook POST the server fires at a Brigade gateway HTTP route. So unlike
 * `imessage` (which has no secret), BlueBubbles HAS a real secret — the server
 * `password` — which is sealed into the encrypted credential store and embedded
 * in the registered webhook URL query string (BlueBubbles webhooks can't carry
 * custom headers).
 *
 * The knobs this module resolves per account:
 *
 *   - `serverUrl`    base URL of the BlueBubbles server (`http://192.168.1.5:1234`).
 *   - `password`     the SECRET — REST auth (`?password=…`) + webhook auth. Sealed.
 *   - `webhookPath`  the gateway inbound route path (default `/bluebubbles/webhook`).
 *   - `actions`      per-rich-action toggles (`reactions`/`edit`/`unsend`/`effects`/`groupAdmin`).
 *   - `region`       default phone-number region for E.164 normalisation (US).
 *   - `mediaMaxMb`   cap on an outbound attachment's size (MB).
 *   - `probeTimeoutMs` HTTP round-trip timeout for the doctor/probe + REST calls.
 *
 * Two config shapes are recognised so the surface lines up with the other
 * channels:
 *
 *   Legacy (single-account):
 *     channels.bluebubbles = { enabled: true, serverUrl: "http://…", password: "${BB_PASSWORD}" }
 *
 *   Multi-account:
 *     channels.bluebubbles = {
 *       enabled: true,
 *       accounts: [
 *         { id: "home", serverUrl: "http://192.168.1.5:1234", password: "${BB_HOME}" },
 *         { id: "work", serverUrl: "http://10.0.0.9:1234",    password: "${BB_WORK}" },
 *       ],
 *     }
 *
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { readSealedChannelToken } from "../channel-secrets.js";
import type { BlueBubblesCatchupConfig } from "./catchup.js";

/** Canonical channel id + default account id. */
const CHANNEL_ID = "bluebubbles";
const DEFAULT_ACCOUNT_ID = "default";

/** Default inbound webhook route path (base; named accounts get a slug suffix). */
const DEFAULT_WEBHOOK_PATH = "/bluebubbles/webhook";
/** Default phone-number region used for E.164 normalisation. */
const DEFAULT_REGION = "US";
/** Default outbound media size cap (MB). */
const DEFAULT_MEDIA_MAX_MB = 100;
/** Default HTTP probe / request timeout (ms). */
export const DEFAULT_BLUEBUBBLES_PROBE_TIMEOUT_MS = 10_000;
/** Default rolling group-history context size (recent messages attached to an untagged group msg). */
export const DEFAULT_BLUEBUBBLES_HISTORY_LIMIT = 10;
/** Hard ceiling on the rolling-history fetch size. */
export const BLUEBUBBLES_MAX_HISTORY_LIMIT = 100;

/** Per-knob env var consulted as a last-resort fallback for the password. */
const PASSWORD_ENV_VAR = "BLUEBUBBLES_PASSWORD";
/** Per-knob env var consulted as a last-resort fallback for the server URL. */
const SERVER_URL_ENV_VAR = "BLUEBUBBLES_SERVER_URL";

/** `${VAR}` secret-ref form — identical to `config/io.ts`'s SECRET_REF_PATTERN. */
const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/**
 * Rich-action toggles. The five COARSE flags are the umbrella switches (each
 * defaults ON; the operator disables per account). The optional FINE-GRAINED
 * flags let the operator gate a single op independently — e.g. allow group
 * renames but forbid removing participants. A fine flag left undefined inherits
 * its umbrella (group-admin ops ← `groupAdmin`; `sendWithEffect` ← `effects`;
 * `reply`/`sendAttachment` ← always on) — finer per-op gating layered on top of
 * the coarse switches, which stay the simple default surface.
 */
export interface BlueBubblesActionFlags {
	// ── coarse umbrellas (always present) ──
	reactions: boolean;
	edit: boolean;
	unsend: boolean;
	effects: boolean;
	groupAdmin: boolean;
	// ── fine-grained per-op overrides (optional; inherit the umbrella when unset) ──
	/** Native inline reply (a threaded reply to a specific message). Default: on. */
	reply?: boolean;
	/** Send with a bubble/screen effect. Default: inherits `effects`. */
	sendWithEffect?: boolean;
	/** Rename a group chat. Default: inherits `groupAdmin`. */
	renameGroup?: boolean;
	/** Set a group chat icon. Default: inherits `groupAdmin`. */
	setGroupIcon?: boolean;
	/** Add a participant to a group. Default: inherits `groupAdmin`. */
	addParticipant?: boolean;
	/** Remove a participant from a group. Default: inherits `groupAdmin`. */
	removeParticipant?: boolean;
	/** Leave a group. Default: inherits `groupAdmin`. */
	leaveGroup?: boolean;
	/** Send a media attachment. Default: on. */
	sendAttachment?: boolean;
}

/** Default rich-action toggles — everything on (Private API gates the rest at runtime). */
export const DEFAULT_BLUEBUBBLES_ACTIONS: BlueBubblesActionFlags = {
	reactions: true,
	edit: true,
	unsend: true,
	effects: true,
	groupAdmin: true,
};

/** The fine-grained per-op action flag names. */
export type BlueBubblesFineActionName =
	| "reply"
	| "sendWithEffect"
	| "renameGroup"
	| "setGroupIcon"
	| "addParticipant"
	| "removeParticipant"
	| "leaveGroup"
	| "sendAttachment";

/**
 * Resolve whether a FINE-GRAINED op is allowed, honouring an explicit per-op
 * flag when set and otherwise inheriting the umbrella:
 *   - group-admin ops (rename/icon/add/remove/leave) ← `groupAdmin`;
 *   - `sendWithEffect` ← `effects`;
 *   - `reply` / `sendAttachment` ← always on (no coarse umbrella gates them).
 */
export function isBlueBubblesOpAllowed(actions: BlueBubblesActionFlags, op: BlueBubblesFineActionName): boolean {
	const explicit = actions[op];
	if (typeof explicit === "boolean") return explicit;
	switch (op) {
		case "sendWithEffect":
			return actions.effects;
		case "renameGroup":
		case "setGroupIcon":
		case "addParticipant":
		case "removeParticipant":
		case "leaveGroup":
			return actions.groupAdmin;
		case "reply":
		case "sendAttachment":
			return true;
		default:
			return true;
	}
}

/** Raw shape of one entry under `channels.bluebubbles.accounts`. */
interface BlueBubblesAccountEntry {
	id?: string;
	enabled?: boolean;
	serverUrl?: string;
	password?: string;
	webhookPath?: string;
	region?: string;
	mediaMaxMb?: number;
	probeTimeoutMs?: number;
	actions?: Partial<BlueBubblesActionFlags>;
	catchup?: BlueBubblesCatchupConfig;
	network?: BlueBubblesNetworkConfig;
	selfHandle?: string;
	inboundDebounceMs?: number;
	historyLimit?: number;
	dmHistoryLimit?: number;
	mediaLocalRoots?: string[];
	[key: string]: unknown;
}

/** Network policy overrides — relax the SSRF guard for a trusted LAN server. */
export interface BlueBubblesNetworkConfig {
	/**
	 * Allow private/LAN/loopback BlueBubbles hosts (default TRUE — a BlueBubbles
	 * server is almost always on the operator's LAN). Cloud-metadata stays blocked
	 * regardless. Set false to force the strict public-only SSRF policy.
	 */
	allowPrivate?: boolean;
}

interface BlueBubblesChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	serverUrl?: string;
	password?: string;
	webhookPath?: string;
	region?: string;
	mediaMaxMb?: number;
	probeTimeoutMs?: number;
	actions?: Partial<BlueBubblesActionFlags>;
	catchup?: BlueBubblesCatchupConfig;
	network?: BlueBubblesNetworkConfig;
	selfHandle?: string;
	inboundDebounceMs?: number;
	historyLimit?: number;
	dmHistoryLimit?: number;
	mediaLocalRoots?: string[];
	dmPolicy?: string;
	allowFrom?: string[];
	accounts?: BlueBubblesAccountEntry[];
	/** Idle TTL (ms / duration string) after which idle thread sessions are reaped. */
	threadIdleTtlMs?: number | string;
	[key: string]: unknown;
}

/** Resolved per-account info — what the adapter runtime reads. */
export interface ResolvedBlueBubblesAccount {
	accountId: string;
	enabled: boolean;
	/** Base server URL (scheme-normalised, trailing slash stripped). */
	serverUrl: string;
	/** The server password (REST + webhook auth). May be "" when unset. */
	password: string;
	/** The gateway inbound route path for this account. */
	webhookPath: string;
	/** Default phone-number region (E.164 normalisation). */
	region: string;
	/** Outbound media size cap (bytes). */
	mediaMaxBytes: number;
	/** HTTP probe / request timeout (ms). */
	probeTimeoutMs: number;
	/** Per-rich-action toggles. */
	actions: BlueBubblesActionFlags;
	/** On-(re)connect catch-up backfill config (undefined → defaults; `enabled:false` disables). */
	catchup?: BlueBubblesCatchupConfig;
	/**
	 * Inbound coalescing window (ms). When > 0, a text + its link-preview balloon
	 * (or a text + a split-out attachment) arriving as two `new-message` webhooks
	 * are merged into ONE agent turn. 0 (default) disables coalescing.
	 */
	inboundDebounceMs: number;
	/**
	 * Rolling group-history context: how many recent messages to fetch + attach
	 * as context on an untagged GROUP message (so the agent sees what it's
	 * replying into). 0 disables. Default 10.
	 */
	historyLimit: number;
	/** Same as `historyLimit` but for DMs. 0 disables. Default 0 (DMs already carry their own thread). */
	dmHistoryLimit: number;
	/**
	 * Allow-list of local directory roots an OUTBOUND attachment may be read from.
	 * Layered ON TOP OF the central media-path denylist. Empty (default) = no
	 * extra root restriction (the central guard still applies).
	 */
	mediaLocalRoots: string[];
	/** Allow private/LAN/loopback targets through the SSRF guard (default TRUE). */
	allowPrivateNetwork: boolean;
	/**
	 * The bot's OWN iMessage handle (phone/email) — used as `selfId` for group
	 * mention-gating. Empty when the operator hasn't set it (mention-gating in
	 * groups then can't fire and the channel falls back to its other group
	 * addressed-signals). Normalised to digits for a phone, lower-case for email.
	 */
	selfHandle: string;
	verbose: boolean;
}

/** Read `channels.bluebubbles` loosely (schema keeps it open). */
function bluebubblesChannelConfig(cfg: BrigadeConfig): BlueBubblesChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, BlueBubblesChannelConfigSlot> }).channels?.[CHANNEL_ID];
}

/**
 * Resolve a single string-ish config value: a `${VAR}` ref expands against
 * `process.env`; any other non-empty string passes through verbatim; empty /
 * missing returns "".
 */
function resolveStringRef(raw: string | undefined, env: NodeJS.ProcessEnv): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const m = SECRET_REF_PATTERN.exec(trimmed);
	if (m && m[1]) return (env[m[1]] ?? "").trim();
	return trimmed;
}

/** The fine-grained op flag names — picked up only when the operator set them. */
const FINE_ACTION_NAMES: readonly BlueBubblesFineActionName[] = [
	"reply",
	"sendWithEffect",
	"renameGroup",
	"setGroupIcon",
	"addParticipant",
	"removeParticipant",
	"leaveGroup",
	"sendAttachment",
];

/** Coerce a loose `actions` object to the typed flags (coarse default ON; fine flags only when set). */
function coerceActionFlags(
	entry: Partial<BlueBubblesActionFlags> | undefined,
	slot: Partial<BlueBubblesActionFlags> | undefined,
): BlueBubblesActionFlags {
	const pick = (key: keyof BlueBubblesActionFlags): boolean => {
		if (entry && typeof entry[key] === "boolean") return entry[key] as boolean;
		if (slot && typeof slot[key] === "boolean") return slot[key] as boolean;
		return DEFAULT_BLUEBUBBLES_ACTIONS[key] ?? true;
	};
	const out: BlueBubblesActionFlags = {
		reactions: pick("reactions"),
		edit: pick("edit"),
		unsend: pick("unsend"),
		effects: pick("effects"),
		groupAdmin: pick("groupAdmin"),
	};
	// Carry a fine-grained override ONLY when the operator explicitly set it
	// (entry wins over slot); otherwise leave it undefined so `isBlueBubblesOpAllowed`
	// inherits the umbrella.
	for (const name of FINE_ACTION_NAMES) {
		const v = entry && typeof entry[name] === "boolean" ? entry[name] : slot && typeof slot[name] === "boolean" ? slot[name] : undefined;
		if (typeof v === "boolean") out[name] = v;
	}
	return out;
}

/** Is the BlueBubbles channel switched on at all (any shape)? */
export function bluebubblesChannelEnabled(cfg: BrigadeConfig): boolean {
	return bluebubblesChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listBlueBubblesAccountIds(cfg: BrigadeConfig): string[] {
	const slot = bluebubblesChannelConfig(cfg);
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
function findAccountEntry(cfg: BrigadeConfig, accountId: string): BlueBubblesAccountEntry | null {
	const slot = bluebubblesChannelConfig(cfg);
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
 * Normalise a BlueBubbles server URL: trim, default the scheme to `http://`
 * when absent (BlueBubbles is commonly a LAN HTTP host), and strip trailing
 * slashes. Returns "" for an empty input (don't throw at config-read time).
 */
export function normalizeBlueBubblesServerUrl(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	return withScheme.replace(/\/+$/, "");
}

/**
 * Resolve the BlueBubbles server URL for an account. Precedence: per-account
 * config `${VAR}`/literal → top-level config → `BLUEBUBBLES_SERVER_URL` env → "".
 */
export function resolveBlueBubblesServerUrl(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveStringRef(entry?.serverUrl, env);
	if (perAccount) return normalizeBlueBubblesServerUrl(perAccount);
	const topLevel = resolveStringRef(slot?.serverUrl, env);
	if (topLevel) return normalizeBlueBubblesServerUrl(topLevel);
	const fromEnv = (env[SERVER_URL_ENV_VAR] ?? "").trim();
	if (fromEnv) return normalizeBlueBubblesServerUrl(fromEnv);
	return "";
}

/**
 * Resolve the server password (the SECRET) for an account. Precedence:
 * per-account config `${VAR}`/literal → top-level config `${VAR}`/literal →
 * durable sealed token (`channel:bluebubbles`) → `BLUEBUBBLES_PASSWORD` env → "".
 *
 * The sealed token is per-channel (NOT per-account today, like Slack's bot
 * token), so multi-account installs that need distinct passwords should use
 * `${VAR}` refs / env per account.
 */
export function resolveBlueBubblesPassword(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveStringRef(entry?.password, env);
	if (perAccount) return perAccount;
	const topLevel = resolveStringRef(slot?.password, env);
	if (topLevel) return topLevel;
	const sealed = readSealedChannelToken(CHANNEL_ID);
	if (sealed) return sealed;
	const fromEnv = (env[PASSWORD_ENV_VAR] ?? "").trim();
	if (fromEnv) return fromEnv;
	return "";
}

/** Normalise a webhook path to a leading-slash, trailing-slash-free form. */
function normalizeWebhookPath(raw: string | undefined): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return DEFAULT_WEBHOOK_PATH;
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	const stripped = withSlash.replace(/\/+$/, "");
	return stripped || DEFAULT_WEBHOOK_PATH;
}

/**
 * Resolve the inbound webhook route path for an account. The default account
 * keeps the base path; a named account (only present when >1 account is
 * configured) gets a distinct, collision-free path so two servers never share
 * one route. An explicit per-account `webhookPath` overrides the derived slug.
 */
export function resolveBlueBubblesWebhookPath(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const basePath = normalizeWebhookPath(slot?.webhookPath);
	if (id === DEFAULT_ACCOUNT_ID) return basePath;
	const entry = findAccountEntry(cfg, id);
	const explicit = resolveStringRef(entry?.webhookPath, env);
	if (explicit) return normalizeWebhookPath(explicit);
	const slug = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || id;
	return `${basePath}/${slug}`;
}

/** Resolve the HTTP probe / request timeout (ms) for an account. */
export function resolveBlueBubblesProbeTimeoutMs(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = typeof entry?.probeTimeoutMs === "number" ? entry.probeTimeoutMs : slot?.probeTimeoutMs;
	return typeof raw === "number" && raw > 0 ? raw : DEFAULT_BLUEBUBBLES_PROBE_TIMEOUT_MS;
}

/** Resolve the per-rich-action toggles for an account. */
export function resolveBlueBubblesActions(cfg: BrigadeConfig, accountId?: string | null): BlueBubblesActionFlags {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return coerceActionFlags(entry?.actions, slot?.actions);
}

/**
 * Normalise a handle for self/mention matching: an email lower-cases; a phone
 * keeps only its digits (so `+1 (555) 123-4567` and `15551234567` compare equal).
 * Returns "" for an empty input.
 */
export function normalizeBlueBubblesSelfHandle(raw: string | undefined): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	if (trimmed.includes("@")) return trimmed.toLowerCase();
	const digits = trimmed.replace(/[^0-9]/g, "");
	return digits || trimmed.toLowerCase();
}

/**
 * Resolve the bot's own handle for an account (per-account `selfHandle` wins over
 * the top-level slot), normalised. Empty when unset.
 */
export function resolveBlueBubblesSelfHandle(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = resolveStringRef(entry?.selfHandle, env) || resolveStringRef(slot?.selfHandle, env);
	return normalizeBlueBubblesSelfHandle(raw);
}

/**
 * Resolve whether the SSRF guard should allow private/LAN/loopback hosts for an
 * account. Per-account `network.allowPrivate` wins over the top-level slot;
 * DEFAULTS TO TRUE (a BlueBubbles server is normally on the operator's LAN).
 * Cloud-metadata stays blocked regardless of this flag.
 */
export function resolveBlueBubblesAllowPrivateNetwork(cfg: BrigadeConfig, accountId?: string | null): boolean {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	if (typeof entry?.network?.allowPrivate === "boolean") return entry.network.allowPrivate;
	if (typeof slot?.network?.allowPrivate === "boolean") return slot.network.allowPrivate;
	return true;
}

/**
 * Resolve the on-(re)connect catch-up backfill config for an account
 * (per-account overrides the top-level slot). Returns `undefined` when neither
 * level configured it — the connection then uses catch-up's built-in defaults.
 */
export function resolveBlueBubblesCatchup(
	cfg: BrigadeConfig,
	accountId?: string | null,
): BlueBubblesCatchupConfig | undefined {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = entry?.catchup ?? slot?.catchup;
	if (!raw || typeof raw !== "object") return undefined;
	const out: BlueBubblesCatchupConfig = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.lookbackMs === "number" && raw.lookbackMs > 0) out.lookbackMs = raw.lookbackMs;
	if (typeof raw.limit === "number" && raw.limit > 0) out.limit = raw.limit;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the inbound coalescing window (ms) for an account (per-account wins
 * over the top-level slot). 0 (default) disables coalescing.
 */
export function resolveBlueBubblesInboundDebounceMs(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = typeof entry?.inboundDebounceMs === "number" ? entry.inboundDebounceMs : slot?.inboundDebounceMs;
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Clamp a configured history limit into `[0, MAX]`. */
function clampHistoryLimit(raw: unknown, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	const n = Math.floor(raw);
	if (n <= 0) return 0;
	return Math.min(n, BLUEBUBBLES_MAX_HISTORY_LIMIT);
}

/**
 * Resolve the rolling group-history context size for an account (per-account
 * wins over the top-level slot). Defaults to {@link DEFAULT_BLUEBUBBLES_HISTORY_LIMIT};
 * 0 disables.
 */
export function resolveBlueBubblesHistoryLimit(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = entry?.historyLimit ?? slot?.historyLimit;
	return clampHistoryLimit(raw, DEFAULT_BLUEBUBBLES_HISTORY_LIMIT);
}

/**
 * Resolve the rolling DM-history context size for an account. Defaults to 0
 * (a DM already carries its own thread context); 0 disables.
 */
export function resolveBlueBubblesDmHistoryLimit(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = entry?.dmHistoryLimit ?? slot?.dmHistoryLimit;
	return clampHistoryLimit(raw, 0);
}

/**
 * Resolve the OUTBOUND-attachment local-root allow-list for an account
 * (per-account entries merged with the top-level slot, de-duped). Empty when
 * neither level configured it — the central media-path denylist still applies.
 */
export function resolveBlueBubblesMediaLocalRoots(cfg: BrigadeConfig, accountId?: string | null): string[] {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = bluebubblesChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const list of [entry?.mediaLocalRoots, slot?.mediaLocalRoots]) {
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			const v = typeof raw === "string" ? raw.trim() : "";
			if (!v || seen.has(v)) continue;
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

/** Resolve a per-account view of the config (defaults filled in). */
export function resolveBlueBubblesAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedBlueBubblesAccount {
	const slot = bluebubblesChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	const region = (resolveStringRef(entry?.region, env) || resolveStringRef(slot?.region, env) || DEFAULT_REGION).trim();
	const mediaMaxMb =
		typeof entry?.mediaMaxMb === "number" && entry.mediaMaxMb > 0
			? entry.mediaMaxMb
			: typeof slot?.mediaMaxMb === "number" && slot.mediaMaxMb > 0
				? slot.mediaMaxMb
				: DEFAULT_MEDIA_MAX_MB;
	return {
		accountId: id,
		enabled,
		serverUrl: resolveBlueBubblesServerUrl(cfg, id, env),
		password: resolveBlueBubblesPassword(cfg, id, env),
		webhookPath: resolveBlueBubblesWebhookPath(cfg, id, env),
		region,
		mediaMaxBytes: Math.round(mediaMaxMb * 1024 * 1024),
		probeTimeoutMs: resolveBlueBubblesProbeTimeoutMs(cfg, id),
		actions: resolveBlueBubblesActions(cfg, id),
		allowPrivateNetwork: resolveBlueBubblesAllowPrivateNetwork(cfg, id),
		selfHandle: resolveBlueBubblesSelfHandle(cfg, id, env),
		inboundDebounceMs: resolveBlueBubblesInboundDebounceMs(cfg, id),
		historyLimit: resolveBlueBubblesHistoryLimit(cfg, id),
		dmHistoryLimit: resolveBlueBubblesDmHistoryLimit(cfg, id),
		mediaLocalRoots: resolveBlueBubblesMediaLocalRoots(cfg, id),
		...(() => {
			const catchup = resolveBlueBubblesCatchup(cfg, id);
			return catchup ? { catchup } : {};
		})(),
		verbose: slot?.verbose === true,
	};
}

/**
 * Resolve the idle-thread-session TTL in ms, or `null` when unset / disabled.
 * Accepts a number (ms) or a duration string (`"6h"`, `"30m"`, …). The cron
 * session-reaper uses this to age out idle BlueBubbles group sessions.
 */
export function bluebubblesThreadIdleTtlMs(cfg: BrigadeConfig): number | null {
	const raw = bluebubblesChannelConfig(cfg)?.threadIdleTtlMs;
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
	CHANNEL_ID as BLUEBUBBLES_CHANNEL_ID,
	DEFAULT_ACCOUNT_ID as BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
	PASSWORD_ENV_VAR as BLUEBUBBLES_PASSWORD_ENV_VAR,
	SERVER_URL_ENV_VAR as BLUEBUBBLES_SERVER_URL_ENV_VAR,
	DEFAULT_WEBHOOK_PATH as BLUEBUBBLES_DEFAULT_WEBHOOK_PATH,
};
