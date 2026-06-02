import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import JSON5 from "json5";

import {
  ensureDir,
  resolveConfigAuditLogPath,
  resolveConfigHealthPath,
  resolveConfigPath,
  resolveLogsDir,
} from "./paths.js";

// brigade.json shape — intentionally loose at this stage so individual
// subsystems can extend it without churning a central schema. Tightening
// happens once the runtime modules stabilise.
//
// Top-level layout mirrors the section split used by the reference superconfig
// (agents/gateway/session/tools/auth/plugins/wizard/meta) so onboarding output
// is byte-comparable across both worlds. Each section is optional — readers
// must apply defaults defensively.
//
// `version` is intentionally NOT a top-level field. The reference uses
// `meta.lastTouchedVersion` as the only version stamp; Brigade follows. The
// optional `version?: number` field below is kept for back-compat readers
// that have already written `version: 1` to disk — new writes never set it.
export interface BrigadeConfig {
  version?: number;
  agents?: BrigadeAgentsConfig;
  defaults?: {
    agentId?: string;
    // When set, replaces the assembled system prompt entirely for every
    // agent that doesn't define its own override. Useful for testing.
    systemPromptOverride?: string;
  };
  gateway?: BrigadeGatewayConfig;
  session?: BrigadeSessionConfig;
  tools?: BrigadeToolsConfig;
  auth?: BrigadeAuthConfig;
  plugins?: BrigadePluginsConfig;
  skills?: BrigadeSkillsConfig;
  wizard?: BrigadeWizardMetaConfig;
  meta?: BrigadeConfigMeta;
  // ── Multi-routing / multi-channel additions (Step 2 of the SessionContext
  // refactor). Optional; absent on legacy configs. The 8-tier route
  // resolver (`agents/routing/resolve-route.ts`, added in Step 6) reads
  // `bindings.entries[]` to pick the agent for an inbound peer / guild /
  // channel / account; the channel manager pre-evaluates user-authored
  // bindings into this shape at boot so the hot routing path stays O(n).
  bindings?: BrigadeBindings;
  [key: string]: unknown;
}

// `agents` carries both the canonical map of per-agent overrides
// (`agents[<id>]`) AND a `defaults` block of settings shared by every agent.
// The defaults block holds the workspace path, model picker output, and any
// model-id-keyed alias map. When `defaults.model` is a struct, `primary` is
// the active model id; `fallbacks` is the failover chain.
export interface BrigadeAgentsConfig {
  defaults?: BrigadeAgentDefaults;
  [agentId: string]: AgentConfig | BrigadeAgentDefaults | undefined;
}

export interface BrigadeAgentDefaults {
  workspace?: string;
  // The provider id that owns `model.primary` — Brigade-only extension to
  // the reference shape so the agent runner can resolve the provider in a
  // single read without sniffing plugins.entries or model id prefixes.
  // The reference defers provider resolution to a separate `models.providers`
  // catalog block; Brigade's catalog lives in code (providers.ts) for now,
  // so we stamp the active provider here at onboard time.
  provider?: string;
  models?: Record<string, BrigadeModelEntry>;
  model?: BrigadeModelSelection;
  /** Max in-flight turns on the global `Main` lane (default 4). */
  maxConcurrent?: number;
  /** Max in-flight sub-agent runs on the global `Subagent` lane (default 8). */
  maxSubagentConcurrent?: number;
  [key: string]: unknown;
}

export interface BrigadeModelEntry {
  alias?: string;
  [key: string]: unknown;
}

export interface BrigadeModelSelection {
  primary: string;
  fallbacks?: string[];
}

export interface AgentConfig {
  workspace?: string | null;
  defaultRoute?: string | null;
  [key: string]: unknown;
}

export interface BrigadeGatewayConfig {
  mode?: "local" | "remote";
  port?: number;
  bind?: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  auth?: { mode?: "none" | "token" | "password"; token?: string; password?: string };
  tailscale?: { mode?: "off" | "serve" | "funnel"; resetOnExit?: boolean };
  controlUi?: { allowInsecureAuth?: boolean };
  nodes?: { denyCommands?: string[]; allowCommands?: string[] };
  [key: string]: unknown;
}

// `dmScope` controls per-conversation session-key uniqueness. Extended to
// include `"per-peer"` (collapses the same peer across channels into one
// session — used together with `identityLinks` for cross-channel personas).
//
//   - `"main"`                      → every DM lands in the agent's main session
//   - `"per-peer"`                  → one session per peer-id regardless of channel
//   - `"per-channel-peer"`          → one session per (channel, peer-id)
//   - `"per-account-channel-peer"`  → one session per (channel, account, peer-id)
export type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";

/** Visibility level for cross-session tools (`sessions_list` / `sessions_history`).
 *  `off` hides the tool; `self` shows only the caller's own sessions; `agent`
 *  shows every session of the same agent; `all` shows every session globally. */
export type SessionToolsVisibility = "off" | "self" | "agent" | "all";

/** Agent-to-agent (A2A) ping-pong policy used by `sessions_send`. When
 *  `enabled === true`, a sender can wait for the target session's reply
 *  inline (capped by `maxPingPongTurns`). The `allow` matrix gates which
 *  (from, to) agent pairs may use A2A — empty means no restriction. */
export type AgentToAgentPolicy = {
  enabled?: boolean;
  allow?: Array<{ from: string; to: string }>;
  maxPingPongTurns?: number;
};

export interface BrigadeSessionConfig {
  dmScope?: DmScope;
  /** Cross-channel canonical peer aliases. The session-key builder uses this
   *  to collapse e.g. `{ kartheek: ["telegram:111", "whatsapp:+91…"] }` into
   *  one canonical peer id, so the same person on two surfaces shares the
   *  same session under `dmScope: "per-peer"`. */
  identityLinks?: Record<string, string[]>;
  /** Agent-to-agent messaging policy (used by `sessions_send` A2A flow). */
  agentToAgent?: AgentToAgentPolicy;
  /** Visibility gate for the `sessions_list` / `sessions_history` tools. */
  sessionTools?: { visibility?: SessionToolsVisibility };
  [key: string]: unknown;
}

/** One raw route binding the operator authored in `brigade.json`. The
 *  8-tier route resolver (`agents/routing/resolve-route.ts`) normalises +
 *  indexes these per (channel, accountId) and walks them in waterfall
 *  order — peer > peer.parent > peer.wildcard > guild+roles > guild >
 *  team > account > channel — returning the first match's `agentId` for
 *  the inbound message. The "evaluated" form lives internal to the
 *  resolver; this is the config-level shape operators read + write. */
export type BindingEntry = {
  agentId: string;
  match?: {
    /** Channel id (e.g. "whatsapp", "slack"). Required for the binding
     *  to participate in any tier. */
    channel?: string;
    /** Account-id constraint. Either an exact account id, or `"*"` for
     *  any-account, or omitted (falls back to `"*"`). */
    accountId?: string;
    /** Peer constraint. `kind` is `"direct" | "group" | "channel"`;
     *  `id === "*"` is a wildcard for the kind. */
    peer?: { kind?: string; id?: string };
    /** Discord guild constraint. */
    guildId?: string;
    /** Slack team constraint. */
    teamId?: string;
    /** Role-id allowlist (Discord). Matches if member has ANY of these. */
    roles?: string[];
  };
};

/** Brigade bindings block. Indexed once per config-load by the resolver
 *  so the hot routing path is a flat array walk, not a per-request scan. */
export type BrigadeBindings = { entries?: BindingEntry[] };

export interface BrigadeToolsConfig {
  profile?: "minimal" | "coding" | "messaging" | "full";
  [key: string]: unknown;
}

export interface BrigadeAuthConfig {
  profiles?: Record<string, BrigadeAuthProfileMeta>;
  order?: Record<string, string[]>;
  [key: string]: unknown;
}

// Main-config metadata describing an auth profile. The actual secret never
// lands here — it lives in <agentDir>/agent/auth-profiles.json. Mirrors
// the reference's `auth.profiles[<id>]` shape so callers can read either
// store with the same probe.
export interface BrigadeAuthProfileMeta {
  provider: string;
  mode: "api_key" | "oauth" | "token";
  email?: string;
  displayName?: string;
  [key: string]: unknown;
}

export interface BrigadePluginsConfig {
  entries?: Record<string, BrigadePluginEntry>;
  [key: string]: unknown;
}

export interface BrigadePluginEntry {
  enabled?: boolean;
  [key: string]: unknown;
}

// Skills (Primitive #5). `enabled` globally toggles the subsystem (default on);
// `paths` adds extra skill search roots beyond the bundled + workspace dirs;
// `entries[<name>].enabled = false` disables one skill by name. Mirrors the
// plugins shape so the two read the same way.
export interface BrigadeSkillsConfig {
  enabled?: boolean;
  paths?: string[];
  entries?: Record<string, BrigadeSkillEntry>;
  [key: string]: unknown;
}

export interface BrigadeSkillEntry {
  enabled?: boolean;
  [key: string]: unknown;
}

// Wizard run trail — stamped on every onboard / configure invocation so
// `brigade doctor` and the next wizard run can detect drift since last setup.
export interface BrigadeWizardMetaConfig {
  lastRunAt?: string;
  lastRunVersion?: string;
  lastRunCommit?: string;
  lastRunCommand?: string;
  lastRunMode?: "local" | "remote";
}

export interface BrigadeConfigMeta {
  lastTouchedVersion?: string;
  lastTouchedAt?: string;
}

// Keeps `.bak` + `.bak.1..4` — five forensic snapshots so a bad write can be
// recovered even after several subsequent saves.
const BACKUP_COUNT = 5;

const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

// Module-level reference to the most-recently-parsed config object, captured
// BEFORE ${VAR} references were resolved against process.env. Used by
// writeConfigSafe to restore those references structurally on the way out:
// any string field whose parsed-form was `${VAR}` and whose incoming-form
// matches process.env[VAR] is written back as `${VAR}`, never the literal.
//
// Why a module-level cache instead of a WeakMap keyed by the live config
// object: the wizard helpers ALL spread (`{ ...cfg, ... }`) on every step,
// which means the object passed into writeConfigSafe is never the object
// returned from readConfigOrInit. Keying on identity broke the restoration
// path. The reference impl walks both forms together at write time — this
// is the same approach.
let lastParsedConfig: unknown = undefined;

export function readConfigOrInit(): BrigadeConfig {
  const cfgPath = resolveConfigPath();
  if (!fs.existsSync(cfgPath)) {
    // Minimum viable shape — `agents` map is added so the onboard runner
    // can attach `agents.defaults` without a null check. The legacy
    // `defaults` top-level block is left out here so a fresh brigade.json
    // matches the reference layout (which has no such field). Subsystems
    // that need it create the key themselves on first write.
    lastParsedConfig = { agents: {} };
    return { agents: {} };
  }
  const raw = fs.readFileSync(cfgPath, "utf8");
  // JSON5 on the read path so users can hand-edit brigade.json with
  // comments and trailing commas. The write path uses plain JSON.stringify
  // so the on-disk shape is byte-comparable to the reference.
  const parsed = JSON5.parse(raw) as BrigadeConfig;

  // Snapshot the parsed-but-not-resolved form. structuredClone (Node ≥17)
  // produces a deep copy, including arrays/nested objects, so subsequent
  // in-place resolution of `parsed` doesn't corrupt the snapshot.
  lastParsedConfig = structuredClone(parsed);

  // Resolve ${VAR} references in place against process.env. The snapshot
  // above retains the literal `${VAR}` strings for write-time restoration.
  resolveSecretsInPlace(parsed);
  return parsed;
}

export function writeConfigSafe(config: BrigadeConfig): void {
  const cfgPath = resolveConfigPath();
  ensureDir(path.dirname(cfgPath));

  // Recursively walk the incoming config alongside the parsed-but-not-
  // resolved snapshot. Every string leaf whose parsed form is `${VAR}`
  // and whose incoming form equals process.env[VAR] is restored as
  // `${VAR}` so resolved secrets never land on disk through this path.
  // Fields that did not exist in the parsed snapshot (added by the
  // wizard, etc.) are written through verbatim.
  const restored = restoreEnvVarRefsRecursive(config, lastParsedConfig, process.env);

  // Recompose the top-level keys in the canonical reference order so the
  // rendered JSON is byte-comparable section-by-section. Wizards and other
  // mutators add keys in their own order; we normalise here so the on-disk
  // layout is stable regardless of the assembly path.
  const ordered = orderTopLevelKeys(restored);

  rotateBackups(cfgPath);

  const serialized = JSON.stringify(ordered, null, 2);
  if (serialized === undefined) {
    // JSON.stringify returns undefined for unserialisable values (BigInt,
    // Function, Symbol). Failing loud here prevents the alternative —
    // silently writing an empty file and bricking the next read.
    throw new Error(
      "brigade.json contains an unserialisable value (BigInt, Function, or Symbol).",
    );
  }
  const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, serialized, "utf8");
    try {
      fs.renameSync(tmp, cfgPath);
    } catch (err: unknown) {
      // Windows can fail rename with EPERM/EEXIST when the live file is
      // locked (editor open, sync agent scanning, etc.). Fall back to copy
      // + unlink so the write still completes. The rename is preferred on
      // POSIX because it is genuinely atomic; the copy fallback is a
      // best-effort approximation.
      const code = (err as { code?: string }).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EEXIST" || code === "EBUSY")) {
        fs.copyFileSync(tmp, cfgPath);
        fs.rmSync(tmp, { force: true });
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort orphan-tmp cleanup
    }
    throw err;
  }

  // Harden the live brigade.json to mode 0o600 on POSIX. Only the backups
  // were chmod'd before — this leaves the gateway token (and any other
  // sensitive fields the user has stashed in the main config) readable to
  // every user on the host until the first audit. No-op on Windows.
  hardenLiveConfigPermissions(cfgPath);

  appendConfigAudit(cfgPath, serialized);
  writeConfigHealth(cfgPath, serialized);

  // Refresh the parsed snapshot so subsequent writes (without an
  // intervening read) still have a comparison baseline. The just-written
  // form IS the current parsed state of the file.
  lastParsedConfig = structuredClone(restored);
}

// Single-file health snapshot — overwritten each time so callers (doctor,
// recovery flows, debug introspection) can read the most-recent write
// state in one stat+read without scanning the audit JSONL. Includes a
// stat-fingerprint of the live config file so a downstream check can
// detect tampering between writes.
function writeConfigHealth(cfgPath: string, contents: string): void {
  try {
    ensureDir(resolveLogsDir());
    const sha = createHash("sha256").update(contents).digest("hex");
    const stat = fs.statSync(cfgPath);
    const record = {
      ts: new Date().toISOString(),
      configPath: cfgPath,
      bytes: Buffer.byteLength(contents, "utf8"),
      sha256: sha,
      mtimeMs: stat.mtimeMs,
      pid: process.pid,
    };
    const tmp = `${resolveConfigHealthPath()}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, resolveConfigHealthPath());
  } catch {
    // Health snapshot is best-effort observability; never block a
    // successful config write because the snapshot couldn't be saved.
  }
}

// Rotation: drop the oldest snapshot, shift each .bak.N down one slot,
// rename the previous head to .bak.1, then copy the live file to .bak.
function rotateBackups(cfgPath: string): void {
  if (!fs.existsSync(cfgPath)) return;

  const oldest = `${cfgPath}.bak.${BACKUP_COUNT - 1}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });

  for (let i = BACKUP_COUNT - 2; i >= 1; i--) {
    const from = `${cfgPath}.bak.${i}`;
    const to = `${cfgPath}.bak.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }

  const head = `${cfgPath}.bak`;
  if (fs.existsSync(head)) fs.renameSync(head, `${cfgPath}.bak.1`);

  fs.copyFileSync(cfgPath, head);
  hardenBackupPermissions(head);
}

function hardenBackupPermissions(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort — some filesystems (FAT32, network mounts) reject chmod.
  }
}

// Apply mode 0o600 to the live brigade.json after a successful write.
// Same semantics as hardenBackupPermissions but kept as a separate symbol
// so future audits can grep for "live" config-perm hardening specifically.
function hardenLiveConfigPermissions(cfgPath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(cfgPath, 0o600);
  } catch {
    // Best-effort — chmod can fail on FAT32/network mounts.
  }
}

function appendConfigAudit(cfgPath: string, contents: string): void {
  try {
    ensureDir(resolveLogsDir());
    const sha = createHash("sha256").update(contents).digest("hex");
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      path: cfgPath,
      bytes: Buffer.byteLength(contents, "utf8"),
      sha256: sha,
    });
    fs.appendFileSync(resolveConfigAuditLogPath(), `${record}\n`, "utf8");
  } catch {
    // Audit logging is best-effort; never block a successful config write.
  }
}

// In-place resolution of `${VAR}` references against process.env. The
// caller (readConfigOrInit) takes a snapshot of the parsed config before
// invoking this so write-time restoration has a comparison baseline.
function resolveSecretsInPlace(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === "string") {
        const m = SECRET_REF_PATTERN.exec(v);
        if (m && m[1]) obj[i] = process.env[m[1]] ?? "";
      } else {
        resolveSecretsInPlace(v);
      }
    }
    return;
  }

  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") {
      const m = SECRET_REF_PATTERN.exec(v);
      if (m && m[1]) (obj as Record<string, unknown>)[key] = process.env[m[1]] ?? "";
    } else if (v !== null && typeof v === "object") {
      resolveSecretsInPlace(v);
    }
  }
}

// Recursive structural restoration. Walks `incoming` and `parsed` together
// — at every string leaf, if the parsed form was `${VAR}` and the incoming
// form matches the env-resolved value, the leaf is restored to `${VAR}`.
// New fields (in `incoming` but not in `parsed`) are written through
// verbatim. Keys in `parsed` but missing from `incoming` are dropped (the
// wizard intentionally removed them). Non-string mismatches are written
// through.
//
// Behaviour parity: this matches the reference's restoreEnvVarRefs walker.
// Crucially, it does NOT depend on object identity, so the wizard's spread
// chain (`{ ...cfg, gateway: ... }`) does not break restoration.
export function restoreEnvVarRefsRecursive(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  if (typeof incoming === "string") {
    if (typeof parsed === "string") {
      const m = SECRET_REF_PATTERN.exec(parsed);
      if (m && m[1]) {
        const resolved = env[m[1]] ?? "";
        if (resolved === incoming) return parsed;
      }
    }
    return incoming;
  }

  if (Array.isArray(incoming)) {
    const parsedArr = Array.isArray(parsed) ? parsed : [];
    return incoming.map((v, i) =>
      restoreEnvVarRefsRecursive(v, parsedArr[i], env),
    );
  }

  if (incoming !== null && typeof incoming === "object") {
    const parsedObj =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      out[k] = restoreEnvVarRefsRecursive(v, parsedObj[k], env);
    }
    return out;
  }

  return incoming;
}

// Test-only hook: reset the parsed-config snapshot so tests that share a
// process can run readConfigOrInit/writeConfigSafe pairs in isolation.
export function __resetConfigParseCacheForTests(): void {
  lastParsedConfig = undefined;
}

// Top-level key order mirroring the reference's onboard output:
//   agents, gateway, session, tools, auth, wizard, meta, plugins
// Keys not in this list are appended in their existing insertion order
// after the canonical sequence so unknown / future sections don't get
// dropped on round-trip.
const CANONICAL_TOP_LEVEL_KEY_ORDER = [
  "agents",
  "gateway",
  "session",
  "tools",
  "auth",
  "wizard",
  "meta",
  "plugins",
] as const;

function orderTopLevelKeys(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CANONICAL_TOP_LEVEL_KEY_ORDER) {
    if (key in src) out[key] = src[key];
  }
  for (const [k, v] of Object.entries(src)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}
