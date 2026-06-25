import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import JSON5 from "json5";

import {
  ensureDir,
  peekConvexMode,
  resolveConfigAuditLogPath,
  resolveConfigHealthPath,
  resolveConfigPath,
  resolveLogsDir,
} from "./paths.js";
import { getCachedConfigRaw, primeConfigCache } from "../storage/config-cache.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";

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
  // ── OPTIONAL virtual-office layer (Stage A: inert).
  // When this field is ABSENT (the default for every existing install),
  // Brigade behaves identically to the pre-org runtime — no rendering,
  // no A2A changes, no new tools, no new prompt sections. The full data
  // model lives in `src/agents/org/types.ts`. Stage A only declares the
  // type so consumers can take a typed reference; the actual derivation
  // + lints + validation live in `src/agents/org/derive-graph.ts`,
  // `lints.ts`, and `validate.ts`. NO existing runtime path reads this
  // field at Stage A.
  org?: BrigadeOrgConfig;
  [key: string]: unknown;
}

// Stage-A inert declaration of the org config block. This type is the
// canonical surface for `cfg.org`; `src/agents/org/types.ts` re-exports
// it alongside the derivation graph types so both the config layer and
// the agents layer share a single source of truth without a cross-file
// import cycle. The block is OPTIONAL — when `cfg.org` is absent the
// derivation helper returns `undefined` and every consumer falls back
// to legacy behaviour. See `src/agents/org/derive-graph.ts` for the
// seven derivation rules and `src/agents/org/lints.ts` for warnings.
export interface BrigadeOrgConfig {
  /** Agent id at the top of the virtual office (e.g. "main"). Required
   *  when `cfg.org` is present; defaults applied by derivation use
   *  `cfg.defaults.agentId` or the literal `"main"` when omitted. The
   *  top-of-org agent MUST have `reportsTo === null`. */
  topOrder: string;
  /** A2A policy mode. `derived` (default) computes the allow matrix
   *  from the seven rules in `derive-graph.ts`; `explicit` returns
   *  `undefined` from the deriver so the legacy A2A allowlist takes
   *  effect; `open` derives an all-to-all matrix (useful for tests). */
  a2a: {
    mode: "derived" | "explicit" | "open";
    /** Optional extra (from, to) pairs unioned into the derived matrix. */
    extraAllow?: Array<{ from: string; to: string; reason?: string }>;
    /** Optional (from, to) pairs subtracted from the derived matrix.
     *  Deny wins last when an extraAllow + extraDeny collide on the
     *  same edge. */
    extraDeny?: Array<{ from: string; to: string; reason?: string }>;
  };
  /** Optional department-head pin. `departmentHeads[<dept>] === <agentId>`
   *  marks one member as the canonical head of that department. Stage A
   *  validates the references but no runtime path consumes them yet —
   *  Stage C wires the lateral / escalation routing. */
  departmentHeads?: Record<string, string>;
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
  /**
   * Default skill allowlist applied to every agent that does NOT declare
   * its own `skills` field. Semantics: `[]` = no skills; absent =
   * every discovered/enabled skill is allowed. Mirrors the reference
   * codebase's `agents.defaults.skills` field.
   */
  skills?: string[];
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
  /**
   * Per-agent skill allowlist. When set, only skills whose `name` is in
   * this list are exposed in the assembled `<available_skills>` block.
   * Semantics:
   *   - `[]`     — agent sees no skills at all
   *   - absent  — fall back to `agents.defaults.skills`; if THAT is also
   *               absent, every discovered/enabled skill is allowed
   * Mirrors the reference codebase's per-agent `skills` field.
   */
  skills?: string[];
  /**
   * OPTIONAL virtual-office membership for this agent. Inert at Stage A —
   * `agents/org/derive-graph.ts` reads it ONLY when the top-level
   * `cfg.org` block is also present. When `cfg.org` is absent the field
   * is type-checked but has zero runtime effect, preserving the legacy
   * code path bit-for-bit. See `src/agents/org/types.ts` for the wider
   * data model and `src/agents/org/derive-graph.ts` for consumption.
   */
  org?: {
    /** Department slug this agent belongs to (e.g. "engineering"). */
    department: string;
    /** Agent id of this agent's manager. `null` only on the top-of-org
     *  agent. Cycles are rejected by `agents/org/validate.ts`. */
    reportsTo: string | null;
    /** Optional human role label (e.g. "Backend Engineer"). Cosmetic. */
    role?: string;
    /** Optional short bio surfaced in the org-aware prompt sections. */
    bio?: string;
  };
  [key: string]: unknown;
}

export interface BrigadeGatewayConfig {
  mode?: "local" | "remote";
  port?: number;
  bind?: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  auth?: { mode?: "none" | "token" | "password"; token?: string; password?: string };
  tailscale?: { mode?: "off" | "serve" | "funnel"; resetOnExit?: boolean };
  /**
   * `brigade expose` ( = `brigade bloody benchmark` ) settings. Tunnels the
   * gateway to the public internet WITHOUT changing its localhost bind: a
   * token-checking auth-proxy stands in front of the gateway and only that
   * proxy is published. The gateway WS itself stays unauthenticated +
   * loopback-only (the `startServer` localhost guard is untouched). See
   * `src/core/tunnel/`.
   */
  tunnel?: {
    /** Tunnel backend. `cloudflare` = anonymous TryCloudflare quick tunnel
     *  (zero-config, auto-managed binary). `bore` = the OSS `bore` client
     *  (self-hostable relay). `custom` = a user-supplied command template. */
    provider?: "cloudflare" | "bore" | "custom";
    /** Shared bearer token required on the public URL. Auto-generated on the
     *  first `brigade expose` and persisted here. Never sent to the gateway
     *  itself — the auth-proxy enforces it. */
    token?: string;
    /** Self-hosted relay address for the `bore` / `custom` providers
     *  (e.g. `bore.example.com`). Defaults to the provider's public relay. */
    relay?: string;
    /** `custom` provider command template; `{port}` is replaced with the
     *  local auth-proxy port (e.g. `ssh -R 80:localhost:{port} nokey@localhost.run`). */
    command?: string;
  };
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
   *  to collapse e.g. `{ alex: ["telegram:111", "whatsapp:+1…"] }` into
   *  one canonical peer id, so the same person on two surfaces shares the
   *  same session under `dmScope: "per-peer"`. */
  identityLinks?: Record<string, string[]>;
  /** Agent-to-agent messaging policy (used by `sessions_send` A2A flow). */
  agentToAgent?: AgentToAgentPolicy;
  /** When `true` (default), creating a new agent (via `brigade agents add` or
   *  the `manage_agent` tool) seeds `cfg.session.agentToAgent` so A2A is
   *  available immediately. Set `false` for strict-allowlist mode where the
   *  operator authors every A2A pair by hand. Mirrors the
   *  `agents.defaults.subagents.autoAllowOnCreate` toggle. */
  autoEnableA2AOnAgentCreate?: boolean;
  /** When `true` (default), gateway boot canonicalises
   *  `cfg.session.agentToAgent` to the wide-open `{ enabled: true, allow:
   *  [{ from: "*", to: "*" }] }` shape so A2A messaging via `sessions_send`
   *  works out of the box on personal installs. Operators set this to
   *  `false` for strict-allowlist installs where every A2A pair is hand-
   *  authored in `brigade.json`. Sibling of `autoEnableA2AOnAgentCreate`
   *  (which fires inside `agents add` / `manage_agent`); this one fires
   *  inside `continueBoot()` immediately after `loadConfig()`. The two
   *  toggles are independent. */
  autoEnableA2AAtBoot?: boolean;
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
    /** Sender id who pinned this peer to the agent via the in-channel
     *  `/agent <id>` slash command. Display-only — the resolver never
     *  reads it, so the binding still routes by agent + match.peer. */
    boundBy?: string;
    /** ISO timestamp the binding was created (channel-command flow). */
    boundAt?: string;
    /** Provenance of the binding: `"channel-command"` for `/agent` writes,
     *  `"cli"` for `brigade agents bind`, `"manual"` for hand-edited
     *  `brigade.json`. Display-only. */
    source?: "channel-command" | "cli" | "manual";
  };
};

/** Brigade bindings block. Indexed once per config-load by the resolver
 *  so the hot routing path is a flat array walk, not a per-request scan. */
export type BrigadeBindings = { entries?: BindingEntry[] };

export interface BrigadeToolsConfig {
  profile?: "minimal" | "coding" | "messaging" | "full";
  /**
   * Optional per-kind defaults for the direct-provider media-understanding
   * subsystem that backs `analyze_media` (video / native-PDF / text-only-model
   * images). Keys are the media kind ("video" | "pdf" | "image" | "audio").
   *   - `models[kind]`    — provider model id override (e.g. "gemini-2.5-pro").
   *   - `providers[kind]` — preferred provider ("google" | "anthropic"); used
   *     only when that provider has a configured key, else auto-selection
   *     falls through to whichever capable provider is keyed.
   * When ABSENT, the subsystem auto-detects from available provider keys and
   * uses sensible built-in model defaults — no config required.
   */
  mediaUnderstanding?: BrigadeMediaUnderstandingConfig;
  [key: string]: unknown;
}

export interface BrigadeMediaUnderstandingConfig {
  models?: Partial<Record<"video" | "pdf" | "image" | "audio", string>>;
  providers?: Partial<Record<"video" | "pdf" | "image" | "audio", "google" | "anthropic">>;
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
  /**
   * Let an agent see the skills of agents it's connected to in the org
   * hierarchy. Off by default. Org-visible skills sit BELOW every operator-
   * placed root (managed/personal/project/workspace) and below config paths,
   * so they can never shadow a local skill, and an agent's OWN workspace
   * skills always win a name collision. Honours the org POLICY graph, so an
   * `org.a2a.mode: "explicit"` install turns this off (matches A2A posture).
   */
  orgAccess?: BrigadeSkillsOrgAccessConfig;
  [key: string]: unknown;
}

export interface BrigadeSkillsOrgAccessConfig {
  enabled?: boolean;
  /**
   * `down` (default): the agent sees its reports' skills. `up`: its manager
   * chain's skills. `both`: union. Direct relationships only unless
   * `transitive` is set.
   */
  direction?: "down" | "up" | "both";
  /** Walk the whole sub-tree / manager-chain rather than just direct edges. */
  transitive?: boolean;
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
  // Convex mode — serve from the boot-primed in-process cache. This is THE
  // dispatch point for every config read in the codebase (the call sites
  // stay untouched; sync callers like the per-turn loop keep working).
  // The cache holds the raw `${VAR}`-refs-intact form; clone + resolve per
  // call, mirroring the disk path's read-parse-resolve sequence below.
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    const raw = getCachedConfigRaw();
    if (raw === undefined) {
      throw new Error(
        "config cache not primed — storage boot did not complete. " +
          "This is a Brigade bug: bootRuntimeContext() must hydrate the config cache in convex mode.",
      );
    }
    const parsed = structuredClone(raw);
    lastParsedConfig = structuredClone(parsed);
    resolveSecretsInPlace(parsed);
    return parsed;
  }

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

// H8: in-process serialization for read-modify-write callers. Sync writes
// already serialize on the event-loop tick, but async tasks that each
// `loadConfig() → mutate → saveConfig()` would otherwise interleave: two
// readers see the same on-disk state, both write back their own diff,
// and one mutation gets stomped. `mutateConfigAtomic` does the read +
// mutate + write under a single Promise-chain queue so every callback
// observes (and writes back) the freshest state on disk.
let writeChain: Promise<void> = Promise.resolve();

// Convex-mode persistence chain. `writeConfigSafeInternal`'s convex branch
// updates the in-process cache synchronously and appends the actual store
// write here; async awaiters join it for durability.
let convexConfigFlushChain: Promise<void> = Promise.resolve();

/** Resolves when every config write enqueued so far has reached the
 *  backend (convex mode) — shutdown paths await this so a sync
 *  `writeConfigSafe` just before exit isn't lost. Filesystem mode resolves
 *  immediately (sync writes are already durable). */
export function awaitConfigFlush(): Promise<void> {
  return convexConfigFlushChain;
}

export function writeConfigSafe(config: BrigadeConfig): void {
  writeConfigSafeInternal(config);
  // Refresh the queue head so any async awaiter that lands later
  // serializes after this sync call has already flushed to disk.
  writeChain = writeChain.then(() => {
    /* serial fence */
  });
}

export function writeConfigSafeAsync(config: BrigadeConfig): Promise<void> {
  const next = writeChain
    .then(() => {
      writeConfigSafeInternal(config);
    })
    // In convex mode the internal call only ENQUEUES the persist; join the
    // flush chain so awaiters get end-to-end durability. Filesystem mode:
    // resolved chain, no added latency.
    .then(() => convexConfigFlushChain);
  writeChain = next.catch(() => {});
  return next;
}

/**
 * Async read-modify-write under the in-process queue. Each mutator runs
 * with the just-loaded cfg as input and its returned cfg becomes the
 * next on-disk state. Failures in one mutator do not poison subsequent
 * awaiters.
 */
export function mutateConfigAtomic(
  mutate: (current: BrigadeConfig) => BrigadeConfig | Promise<BrigadeConfig>,
): Promise<BrigadeConfig> {
  let resultRef: BrigadeConfig | undefined;
  const next = writeChain.then(async () => {
    const current = readConfigOrInit();
    const updated = await mutate(current);
    writeConfigSafeInternal(updated);
    resultRef = updated;
  });
  writeChain = next.catch(() => {});
  return (
    next
      // Convex mode: the internal call only enqueues the persist — join the
      // flush chain so the resolved promise means "the backend has it".
      .then(() => awaitConfigFlush())
      .then(() => resultRef as BrigadeConfig)
  );
}

function writeConfigSafeInternal(config: BrigadeConfig): void {
  // Convex mode — the brigadeConfig row is the destination, never disk.
  // Same `${VAR}` restoration as the disk path (resolved secrets must not
  // land in the row either), then: (1) prime the in-process cache so the
  // very next readConfigOrInit sees this write, (2) enqueue the Convex
  // persist on a serial flush chain. `writeConfigSafe` stays synchronous
  // for its callers; awaiters that need durability use
  // `writeConfigSafeAsync` / `mutateConfigAtomic`, which join the chain.
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    const restoredForStore = restoreEnvVarRefsRecursive(
      config,
      lastParsedConfig,
      process.env,
    ) as BrigadeConfig;
    primeConfigCache(restoredForStore);
    lastParsedConfig = structuredClone(restoredForStore);
    const store = rctx.store;
    convexConfigFlushChain = convexConfigFlushChain
      .then(async () => {
        await store.config.write(restoredForStore);
        // Observability parity with the disk path's 4-file commit: the
        // audit chain + health snapshot land in their tables after the
        // config row. Best-effort — a failed audit row never blocks the
        // config write itself.
        const serialized = JSON.stringify(restoredForStore, null, 2);
        const sha = createHash("sha256").update(serialized).digest("hex");
        await store.logs
          .appendConfigAudit({
            ts: new Date().toISOString(),
            sha256: sha,
            bytes: Buffer.byteLength(serialized, "utf8"),
            pid: process.pid,
          } as never)
          .catch(() => {});
        await store.logs
          .writeConfigHealth({
            ts: new Date().toISOString(),
            configPath: "convex://brigadeConfig",
            bytes: Buffer.byteLength(serialized, "utf8"),
            sha256: sha,
            mtimeMs: Date.now(),
            pid: process.pid,
          } as never)
          .catch(() => {});
      })
      .catch((err) => {
        // The cache already serves the new value in-process; surface the
        // persistence failure loudly so the operator knows the backend
        // didn't take the write. Subsequent writes retry the chain.
        console.error(
          `brigade: config write to convex failed — ${(err as Error).message}`,
        );
      });
    return;
  }

  // Fail CLOSED: the sentinel/env says convex but no runtime context (and thus
  // no store) is installed in this process — a context-less window such as a
  // command that skipped storage boot or a BOOT_OPTIONAL command whose backend
  // was unreachable. Falling through to the disk write would (a) leak
  // brigade.json + .bak + config logs under ~/.brigade and (b) be silently
  // ignored on the next convex boot (the brigadeConfig row is authoritative,
  // not the file). Refuse loudly instead of writing somewhere that gets lost.
  if (!rctx && peekConvexMode()) {
    throw new Error(
      "Cannot write Brigade config: storage is in convex mode but the backend " +
        "isn't connected in this process. Run this after the gateway is up, or " +
        "verify the deployment URL — config must go to the convex backend, not disk.",
    );
  }

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

// ============================================================================
// Public config-audit + config-health helpers (added in Phase 2 PR4 so the
// BrigadeStore `LogStore` adapter wraps the audit chain through a typed
// seam). The internal `appendConfigAudit` + `writeConfigHealth` keep firing
// from `writeConfigSafe` unchanged — these public siblings are for explicit
// audit-line writes (test fixtures, recovery flows, the future store layer).
//
// Audit-chain integrity: each new line carries a `prevHash` referencing
// the previous line's `lineHash`. `verifyConfigAuditChain()` walks the
// file and reports the first break, if any. Backward-compatible: pre-PR4
// lines without `prevHash` are treated as the start of a new chain.
// ============================================================================

export interface ConfigAuditInput {
  /** ISO timestamp; defaults to `new Date().toISOString()` when omitted. */
  ts?: string;
  /** Path the audit row refers to (defaults to the active config path). */
  path?: string;
  /** SHA-256 of the contents this row records. Required. */
  sha256: string;
  /** Byte length of the recorded contents. Optional but recommended. */
  bytes?: number;
  /** Free-form tag (e.g. "write", "restore", "migrate"). Optional. */
  kind?: string;
  /** Arbitrary structured fields the operator wants to capture alongside. */
  fields?: Record<string, unknown>;
}

export interface ConfigAuditRecord {
  ts: string;
  path: string;
  sha256: string;
  bytes?: number;
  kind?: string;
  prevHash?: string;
  /** sha256 of the canonical-stringified row excluding `lineHash`. */
  lineHash: string;
  /** Monotonic sequence (1-indexed). */
  seq: number;
  [field: string]: unknown;
}

function readAuditLinesRaw(): string[] {
  const p = resolveConfigAuditLogPath();
  if (!fs.existsSync(p)) return [];
  try {
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function computeLineHash(payload: Record<string, unknown>): string {
  // Canonical serialisation: keys sorted alphabetically so equivalent
  // payloads always hash to the same digest. The hash NEVER includes
  // `lineHash` itself.
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    if (key === "lineHash") continue;
    filtered[key] = payload[key];
  }
  return createHash("sha256").update(JSON.stringify(filtered)).digest("hex");
}

/**
 * Append one row to the config-audit JSONL. Chains via `prevHash` →
 * `lineHash`. Returns the persisted record so callers can hand it back
 * to the storage layer.
 */
export function appendConfigAuditLine(entry: ConfigAuditInput): ConfigAuditRecord {
  ensureDir(resolveLogsDir());
  const lines = readAuditLinesRaw();
  let prevHash: string | undefined;
  let nextSeq = 1;
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last) {
      try {
        const parsed = JSON.parse(last) as Partial<ConfigAuditRecord>;
        if (typeof parsed.lineHash === "string") prevHash = parsed.lineHash;
        if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) {
          nextSeq = parsed.seq + 1;
        }
      } catch {
        // Treat malformed tail as "start a new chain from here".
      }
    }
  }
  const payload: Record<string, unknown> = {
    ts: entry.ts ?? new Date().toISOString(),
    path: entry.path ?? resolveConfigPath(),
    sha256: entry.sha256,
    seq: nextSeq,
    ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    ...(entry.fields ?? {}),
    ...(prevHash !== undefined ? { prevHash } : {}),
  };
  const lineHash = computeLineHash(payload);
  const record: ConfigAuditRecord = { ...payload, lineHash } as ConfigAuditRecord;
  try {
    fs.appendFileSync(resolveConfigAuditLogPath(), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort — surface the record to the caller so an in-memory
    // chain can keep advancing even when disk writes fail.
  }
  return record;
}

/**
 * Walk the config-audit chain and verify each row's `lineHash` matches
 * the canonical hash of its own payload + that its `prevHash` matches
 * the previous row's `lineHash`. Returns the seq number of the first
 * broken row, or `undefined` when the chain is intact.
 *
 * Pre-PR4 rows without a `lineHash` are tolerated — they're treated as
 * the start of a new chain, so existing audit files stay valid.
 */
export function verifyConfigAuditChain(): { ok: boolean; brokenAt?: number } {
  const lines = readAuditLinesRaw();
  let previousLineHash: string | undefined;
  let expectedSeq: number | undefined;
  for (const raw of lines) {
    let row: Partial<ConfigAuditRecord>;
    try {
      row = JSON.parse(raw) as Partial<ConfigAuditRecord>;
    } catch {
      return { ok: false, brokenAt: expectedSeq ?? 0 };
    }
    // Legacy row (no lineHash) → reset the chain from here.
    if (typeof row.lineHash !== "string") {
      previousLineHash = undefined;
      expectedSeq = typeof row.seq === "number" ? row.seq + 1 : undefined;
      continue;
    }
    // prevHash must match
    if (previousLineHash !== undefined && row.prevHash !== previousLineHash) {
      return { ok: false, brokenAt: typeof row.seq === "number" ? row.seq : 0 };
    }
    // lineHash must match the canonical hash of the rest of the row
    const recomputed = computeLineHash(row as Record<string, unknown>);
    if (recomputed !== row.lineHash) {
      return { ok: false, brokenAt: typeof row.seq === "number" ? row.seq : 0 };
    }
    // seq must be monotonic
    if (
      expectedSeq !== undefined &&
      typeof row.seq === "number" &&
      row.seq !== expectedSeq
    ) {
      return { ok: false, brokenAt: row.seq };
    }
    previousLineHash = row.lineHash;
    expectedSeq = typeof row.seq === "number" ? row.seq + 1 : undefined;
  }
  return { ok: true };
}

export interface ConfigHealthRecord {
  ts: string;
  configPath: string;
  bytes: number;
  sha256: string;
  mtimeMs: number;
  pid: number;
  ownerId?: string;
  [field: string]: unknown;
}

/**
 * Atomically write a config-health snapshot. The internal writer fired by
 * `writeConfigSafe` keeps doing its own write — this sibling is for
 * explicit snapshots from the storage layer / tests / `brigade doctor`.
 */
export function writeConfigHealthSnapshot(snapshot: ConfigHealthRecord): void {
  try {
    ensureDir(resolveLogsDir());
    const out = resolveConfigHealthPath();
    const tmp = `${out}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, out);
  } catch {
    // Best-effort — same discipline as the internal writer.
  }
}

/** Read the latest config-health snapshot, or `undefined` when none exists. */
export function readConfigHealthSnapshot(): ConfigHealthRecord | undefined {
  const p = resolveConfigHealthPath();
  if (!fs.existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ConfigHealthRecord>;
    if (
      typeof parsed.ts === "string" &&
      typeof parsed.configPath === "string" &&
      typeof parsed.sha256 === "string"
    ) {
      return parsed as ConfigHealthRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
