import crypto from "node:crypto";

import type {
  BrigadeAgentDefaults,
  BrigadeAgentsConfig,
  BrigadeAuthProfileMeta,
  BrigadeConfig,
  BrigadeGatewayConfig,
  BrigadeModelEntry,
} from "../../config/io.js";
import { VERSION } from "../../version.js";

// Wizard-time helpers that mutate a BrigadeConfig in pure-function fashion
// (no I/O — callers feed the result to writeConfigSafe). Each helper
// corresponds to one section of the post-onboard brigade.json and is
// idempotent: re-running with the same inputs produces the same output.
//
// Section layout mirrors the reference superconfig — agents.defaults,
// gateway, session, tools, auth.profiles, plugins.entries, wizard, meta —
// so a brigade.json after `brigade onboard` is byte-comparable to its
// reference equivalent (modulo the `wizard.lastRun*` timestamp + the random
// gateway token).

// 24 bytes → 48 hex chars. Same crypto strength used for the gateway-auth
// token in the reference impl. Keeping the byte count identical means the
// "looks like a gateway token" length check (48 chars) ports cleanly.
export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

// "High-risk" host commands that the local gateway refuses to run for a
// remote node by default. Lifted verbatim from the reference's
// node-command-policy module — these strings are platform/device verbs
// (camera/screen/contacts/calendar/reminders/sms), not project-specific
// identifiers, so they are safe to share across implementations.
//
// Order is preserved so the rendered JSON array is byte-identical between
// implementations on first onboard.
export const BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS: readonly string[] = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "contacts.add",
  "calendar.add",
  "reminders.add",
  "sms.send",
  "sms.search",
];

export type BrigadeOnboardMode = "local" | "remote";

// Mirrors the reference's applyWizardMetadata. The wizard run trail lets
// `brigade doctor` flag stale setup and lets the next wizard run preserve
// or reset prior choices. GIT_COMMIT / GIT_SHA come from CI builds; locally
// they are usually undefined, in which case `lastRunCommit` is omitted.
export function applyWizardMetadata(
  cfg: BrigadeConfig,
  params: { command: string; mode: BrigadeOnboardMode; now?: Date; commit?: string },
): BrigadeConfig {
  const commit =
    params.commit ??
    normalizeOptionalString(process.env.GIT_COMMIT) ??
    normalizeOptionalString(process.env.GIT_SHA);
  const wizard: BrigadeConfig["wizard"] = {
    ...cfg.wizard,
    lastRunAt: (params.now ?? new Date()).toISOString(),
    lastRunVersion: VERSION,
    lastRunCommand: params.command,
    lastRunMode: params.mode,
  };
  if (commit) wizard.lastRunCommit = commit;
  return { ...cfg, wizard };
}

// Stamp `meta.{lastTouchedVersion, lastTouchedAt}`. The writeConfigSafe path
// does not stamp this on every write because the meta block is part of the
// wizard story (not a low-level write artifact); only commands that
// semantically "touch" the config (onboard, configure, set) call this.
export function applyConfigMeta(
  cfg: BrigadeConfig,
  params: { now?: Date } = {},
): BrigadeConfig {
  return {
    ...cfg,
    meta: {
      ...cfg.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: (params.now ?? new Date()).toISOString(),
    },
  };
}

// Apply the silent onboard defaults for sections the user does not get
// prompted for in QuickStart: workspace, gateway block, session.dmScope,
// tools.profile. Existing values are preserved — only missing fields are
// filled in.
export function applyOnboardDefaults(
  cfg: BrigadeConfig,
  params: { workspace: string; mode?: BrigadeOnboardMode; hasExistingConfig?: boolean },
): BrigadeConfig {
  const mode = params.mode ?? "local";
  const hasExisting = params.hasExistingConfig === true;
  const next: BrigadeConfig = { ...cfg };

  // agents.defaults.workspace — first-write only, never clobber user override.
  const agents: BrigadeAgentsConfig = { ...(cfg.agents ?? {}) };
  const defaults: BrigadeAgentDefaults = { ...(agents.defaults ?? {}) };
  if (!defaults.workspace) defaults.workspace = params.workspace;
  agents.defaults = defaults;
  next.agents = agents;

  // gateway block — apply the QuickStart preset shape. Token + port are
  // intentionally NOT generated here; that happens in applyGatewayCredentials
  // so unit tests can pass deterministic values. `hasExisting` gates the
  // first-onboard-only seeds (controlUi.allowInsecureAuth + denyCommands)
  // so a re-onboard against a customised config preserves user choices.
  next.gateway = mergeGatewayDefaults(cfg.gateway, mode, hasExisting);

  // session.dmScope = "per-channel-peer" — same default the reference uses;
  // gives every (channel, peer) pair its own session by default.
  next.session = { ...cfg.session, dmScope: cfg.session?.dmScope ?? "per-channel-peer" };

  // tools.profile = "coding" — engineering-leaning default. Channels-mode
  // installs flip this to "messaging"; full-tool installs flip to "full".
  next.tools = { ...cfg.tools, profile: cfg.tools?.profile ?? "coding" };

  return next;
}

function mergeGatewayDefaults(
  current: BrigadeGatewayConfig | undefined,
  mode: BrigadeOnboardMode,
  hasExistingConfig: boolean,
): BrigadeGatewayConfig {
  const src: BrigadeGatewayConfig = { ...current };

  const finalMode = src.mode ?? mode;
  const auth = src.auth ? { ...src.auth } : undefined;
  const port = src.port;
  const bind = src.bind ?? "loopback";
  const tailscale = src.tailscale ?? { mode: "off" as const, resetOnExit: false };

  // controlUi.allowInsecureAuth: only seeded on first onboard + loopback,
  // matching setup.gateway-config.ts:299-314 behaviour. On a re-onboard
  // against an existing config, the user's prior choice survives.
  let controlUi = src.controlUi ? { ...src.controlUi } : undefined;
  if (!controlUi) {
    if (!hasExistingConfig && bind === "loopback") {
      controlUi = { allowInsecureAuth: true };
    } else {
      controlUi = {};
    }
  }

  // nodes.denyCommands: only seeded on first onboard when none of the
  // three fields the reference checks (denyCommands, allowCommands,
  // browser) are set. Mirrors setup.gateway-config.ts:328-343 — using
  // a per-field guard catches the edge case where a user has typed
  // `nodes: {}` into their config before first onboard, which the
  // earlier "whole-block" check would have treated as customised.
  const srcNodes = src.nodes ? { ...src.nodes } : undefined;
  let nodes: BrigadeGatewayConfig["nodes"];
  const noUserNodeFields =
    srcNodes === undefined ||
    (srcNodes.denyCommands === undefined &&
      srcNodes.allowCommands === undefined &&
      (srcNodes as Record<string, unknown>).browser === undefined);
  if (noUserNodeFields && !hasExistingConfig) {
    nodes = { ...(srcNodes ?? {}), denyCommands: [...BRIGADE_DEFAULT_DANGEROUS_NODE_COMMANDS] };
  } else if (srcNodes) {
    nodes = srcNodes;
  } else {
    nodes = {};
  }

  // Compose in canonical order so the rendered JSON renders the gateway
  // block as the reference does: mode/auth/port/bind/tailscale/controlUi/nodes.
  // V8 preserves insertion order for string-keyed properties.
  const composed: BrigadeGatewayConfig = { mode: finalMode };
  if (auth) composed.auth = auth;
  if (port !== undefined) composed.port = port;
  composed.bind = bind;
  composed.tailscale = tailscale;
  composed.controlUi = controlUi;
  composed.nodes = nodes;
  for (const [k, v] of Object.entries(src)) {
    if (!(k in composed)) (composed as Record<string, unknown>)[k] = v;
  }
  return composed;
}

// Apply the gateway port + auth token. Split out so QuickStart and Manual
// can both call it after collecting the user's port choice (or the default).
// `existingTokenIsSecretRef` lets the caller signal "the existing token
// looks like ${VAR}, leave it alone" without us having to inspect the
// raw form ourselves.
export function applyGatewayCredentials(
  cfg: BrigadeConfig,
  params: { port: number; token?: string; existingTokenIsSecretRef?: boolean },
): BrigadeConfig {
  const src: BrigadeGatewayConfig = { ...(cfg.gateway ?? {}) };

  const auth = src.auth ? { ...src.auth } : {};
  if (!auth.mode) auth.mode = "token";
  if (params.existingTokenIsSecretRef && auth.token) {
    // Keep ${VAR} reference as-is; do not overwrite with a literal.
  } else if (params.token) {
    auth.token = params.token;
  } else if (!auth.token) {
    auth.token = randomToken();
  }

  // Recompose the gateway block in canonical reference order.
  const composed: BrigadeGatewayConfig = { mode: src.mode ?? "local" };
  composed.auth = auth;
  composed.port = params.port;
  if (src.bind !== undefined) composed.bind = src.bind;
  if (src.tailscale !== undefined) composed.tailscale = src.tailscale;
  if (src.controlUi !== undefined) composed.controlUi = src.controlUi;
  if (src.nodes !== undefined) composed.nodes = src.nodes;
  for (const [k, v] of Object.entries(src)) {
    if (!(k in composed)) (composed as Record<string, unknown>)[k] = v;
  }

  return { ...cfg, gateway: composed };
}

// Reject literal "undefined" / "null" / empty string CLI inputs that
// otherwise look like a real token. Common bug when JS undefined is
// coerced via template literals (`String(undefined) === "undefined"`).
// Returns the trimmed token or undefined if the value is unusable.
export function normalizeGatewayTokenInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "undefined" || trimmed === "null") return undefined;
  return trimmed;
}

// Apply the result of the model picker. `primary` becomes the active model;
// `fallbacks[]` is the failover chain in order. `models[id].alias` records
// the human-friendly label for each model so the TUI / doctor / debug UI
// can render it without re-querying the provider.
export function applyModelSelection(
  cfg: BrigadeConfig,
  params: {
    primary: string;
    fallbacks?: string[];
    aliases?: Record<string, string>;
  },
): BrigadeConfig {
  const agents: BrigadeAgentsConfig = { ...(cfg.agents ?? {}) };
  const defaults: BrigadeAgentDefaults = { ...(agents.defaults ?? {}) };

  // Merge aliases — never wipe a previously-recorded alias unless the caller
  // explicitly provides a new one for the same model id.
  const models: Record<string, BrigadeModelEntry> = { ...(defaults.models ?? {}) };
  if (params.aliases) {
    for (const [id, alias] of Object.entries(params.aliases)) {
      models[id] = { ...models[id], alias };
    }
  }
  defaults.models = models;

  defaults.model = {
    primary: params.primary,
    ...(params.fallbacks && params.fallbacks.length > 0 ? { fallbacks: params.fallbacks } : {}),
  };

  agents.defaults = defaults;
  return { ...cfg, agents };
}

// Add (or update) the `auth.profiles[<id>]` metadata entry in the main
// config. The actual secret lives in <agentDir>/agent/auth-profiles.json
// at mode 0o600 — this entry is just the discoverable record so doctor
// flows + the model picker can reason about which providers have keys
// without opening the secret store.
//
// `profileId` follows the `<provider>:<alias>` shape (alias defaults to
// "default") so multiple keys for the same provider can coexist.
export function applyAuthProfileMeta(
  cfg: BrigadeConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    displayName?: string;
  },
): BrigadeConfig {
  const profile: BrigadeAuthProfileMeta = {
    provider: params.provider,
    mode: params.mode,
  };
  if (params.email) profile.email = params.email;
  if (params.displayName) profile.displayName = params.displayName;

  const profiles = { ...(cfg.auth?.profiles ?? {}), [params.profileId]: profile };
  return { ...cfg, auth: { ...cfg.auth, profiles } };
}

// Mark a provider plugin as enabled in `plugins.entries`. The wizard calls
// this once per provider the user successfully authed against — same
// behaviour as the reference impl, where authing against a provider implies
// "I want this plugin loaded on next start".
export function applyPluginEnable(cfg: BrigadeConfig, providerId: string): BrigadeConfig {
  const entries = {
    ...(cfg.plugins?.entries ?? {}),
    [providerId]: { ...(cfg.plugins?.entries?.[providerId] ?? {}), enabled: true },
  };
  return { ...cfg, plugins: { ...cfg.plugins, entries } };
}

// Build the canonical profile id `<provider>:<alias>` (alias defaults to
// "default"). Re-exported here so callers don't have to import from
// auth/profiles just for this string concat — keeps the wizard module
// self-contained.
export function buildProfileId(provider: string, alias?: string): string {
  return `${provider}:${alias ?? "default"}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
