import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: paths ⇄ storage/runtime-context is a benign ESM cycle — both sides
// only dereference the other inside function bodies (call time), never
// during module evaluation.
import { tryGetRuntimeContext } from "../storage/runtime-context.js";

// All filesystem paths the brigade runtime touches resolve through this module.
// Override via BRIGADE_STATE_DIR / BRIGADE_CONFIG_PATH so tests + alt installs
// can run isolated from ~/.brigade.

// Canonical default agent id. Session-key resolution hardcodes this same
// value; changing it requires a state migration so existing transcripts
// remain reachable.
export const DEFAULT_AGENT_ID = "main";

export function resolveStateDir(): string {
  const override = process.env.BRIGADE_STATE_DIR?.trim();
  if (override && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".brigade");
}

/**
 * True when Brigade is in convex mode — INCLUDING the pre-context windows
 * (onboard before bootRuntimeContext, the BOOT_OPTIONAL repair commands when
 * the backend is unreachable, and the boot window before setRuntimeContext is
 * installed).
 *
 * The installed runtime context is authoritative and fast, so consult it
 * first. Only when NO context exists do we peek the sticky sentinel/env
 * directly — so callers fail CLOSED (resolve to the OS cache, never under
 * ~/.brigade; refuse a disk write) instead of leaking state just because the
 * context hadn't booted yet. Mirrors subsystem-logger's peekStorageMode, the
 * proven fail-closed pattern. No caching: the no-context branch is rare (when
 * a context exists we return immediately), and not caching avoids serving a
 * stale mode across an onboard that flips the sentinel mid-process.
 */
export function peekConvexMode(): boolean {
  const ctx = tryGetRuntimeContext();
  if (ctx) return ctx.mode === "convex";
  try {
    const explicit = process.env.BRIGADE_MODE?.trim();
    if (explicit === "convex") return true;
    if (explicit === "filesystem") return false;
    const sentinelPath = path.join(resolveStateDir(), "mode.sentinel");
    if (fs.existsSync(sentinelPath)) {
      const parsed = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as { mode?: string };
      return parsed.mode === "convex";
    }
    if (process.env.BRIGADE_CONVEX_URL?.trim()) return true;
  } catch {
    // Unreadable/corrupt sentinel — boot will throw a proper error. Default to
    // filesystem behaviour meanwhile (matches subsystem-logger's peek).
  }
  return false;
}

export function resolveConfigPath(): string {
  const override = process.env.BRIGADE_CONFIG_PATH?.trim();
  if (override && override.length > 0) return path.resolve(override);
  return path.join(resolveStateDir(), "brigade.json");
}

export function resolveAgentDir(agentId: string): string {
  return path.join(resolveStateDir(), "agents", agentId);
}

// Auth lives at <agentDir>/agent/ — NOT <agentDir>/.brigade/.
// auth-profiles.json, auth-state.json, models.json all live here.
export function resolveAuthDir(agentId: string): string {
  return path.join(resolveAgentDir(agentId), "agent");
}

export function resolveAuthProfilesPath(agentId: string): string {
  return path.join(resolveAuthDir(agentId), "auth-profiles.json");
}

export function resolveAuthStatePath(agentId: string): string {
  return path.join(resolveAuthDir(agentId), "auth-state.json");
}

export function resolveModelsPath(_agentId: string): string {
  // models.json is the per-USER provider catalog (Ollama, custom
  // OpenAI-compatible endpoints, etc.) — NOT per-agent. It lives at the
  // state-dir root alongside brigade.json, which is the canonical path
  // onboarding writes to AND the gateway reads at boot. The per-turn runtime
  // (runSingleTurn) MUST read the same file: previously this returned the
  // per-agent auth dir, so the gateway accepted a model at boot (reading
  // ~/.brigade/models.json) but the turn failed "Model not registered"
  // (reading an empty ~/.brigade/agents/<id>/agent/models.json). Auth
  // profiles stay per-agent; the provider catalog is shared per-user.
  //
  // Convex mode: Pi's ModelRegistry.create reads this path with sync fs, so
  // a real file is unavoidable — but it lives in the OS cache dir (NOT under
  // ~/.brigade). Boot materialises the catalog from its Convex blob there;
  // catalog writers push the blob back after every file write so the file
  // is a regenerable cache, never the source of truth.
  if (peekConvexMode()) {
    return path.join(resolveOsCacheDir(), "models.json");
  }
  return path.join(resolveStateDir(), "models.json");
}

// Sessions are Pi SDK JSONL transcripts: one file per session.
export function resolveSessionsDir(agentId: string): string {
  return path.join(resolveAgentDir(agentId), "sessions");
}

export function resolveSessionStorePath(agentId: string): string {
  return path.join(resolveSessionsDir(agentId), "sessions.json");
}

export function resolveSessionTranscriptPath(agentId: string, sessionId: string): string {
  // Convex mode: the transcript JSONL is never written (SessionManager.inMemory
  // + the write-behind factory own it), but Pi's getSessionFile() and the
  // advisory write-lock sidecar still need a real path — route it to the OS
  // cache dir, NEVER under ~/.brigade. Filesystem mode unchanged.
  if (peekConvexMode()) {
    return path.join(resolveOsCacheDir(), "sessions", agentId, `${sessionId}.jsonl`);
  }
  return path.join(resolveSessionsDir(agentId), `${sessionId}.jsonl`);
}

// Per-agent workspace dir resolver. The DEFAULT agent ("main") uses the
// shared `<stateDir>/workspace/` so v1 single-agent installs keep their
// existing layout. Non-default agents get their own per-agent workspace at
// `<stateDir>/agents/<id>/workspace/` so each agent has isolated SOUL.md /
// IDENTITY.md / AGENTS.md / TOOLS.md / USER.md / BOOTSTRAP.md / HEARTBEAT.md
// + skills + memory state.
//
// Resolution order:
//
//   1. Explicit `override` argument (caller pinned it)
//   2. `BRIGADE_PROFILE` env var override (named profile)
//   3. Non-default agent → `<stateDir>/agents/<id>/workspace/`
//   4. Default agent → `<stateDir>/workspace/` (shared, v1-compatible)
//
// Config-driven per-agent override (`cfg.agents.<id>.workspace`) is read by
// the gateway boot path (server.ts) and passed through as `override` to
// this function. Keeping cfg out of this signature lets the helper stay
// config-agnostic.
export function resolveAgentWorkspaceDir(agentId: string, override?: string): string {
  if (override && override.length > 0) return path.resolve(override);
  const profile = process.env.BRIGADE_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(resolveStateDir(), `workspace-${profile}`);
  }
  const normalizedId = (agentId ?? "").trim().toLowerCase();
  if (normalizedId && normalizedId !== DEFAULT_AGENT_ID) {
    // Per-agent isolated workspace. Created lazily on first turn by the
    // bootstrap path; agent-loop.ts:bootstrapWorkspace seeds the .md files.
    return path.join(resolveStateDir(), "agents", normalizedId, "workspace");
  }
  return path.join(resolveStateDir(), "workspace");
}

// User-authored skills live under the shared workspace (NOT per-agent),
// exactly like persona files and memory/facts.jsonl — drop a folder
// `<workspace>/skills/<name>/SKILL.md` and it's discovered. Honours the same
// `override` / BRIGADE_PROFILE divergence as the workspace itself.
export function resolveSkillsDir(agentId: string, override?: string): string {
  return path.join(resolveAgentWorkspaceDir(agentId, override), "skills");
}

// Managed skills installed via the `skills.install` RPC live at
// `~/.brigade/skills/`. The drop-zone for installer-managed skills (npm
// global, brew, go install, uv pip install, raw download). Sits ABOVE the
// bundled-shipped skills (so a managed install shadows a stale bundled
// copy) but BELOW the workspace dir (so user-authored skills always win).
export function resolveManagedSkillsDir(): string {
  // Convex mode: managed skills must NOT live under ~/.brigade. The skills
  // table is the source of truth; the on-disk dir is a regenerable cache that
  // persists in the OS cache location (survives `rm -rf ~/.brigade`). Pre-
  // context callers peek the sentinel so an agent's manage_skill({scope:
  // "managed"}) on a not-yet-booted process still resolves to the OS cache,
  // never leaking under ~/.brigade — and never tripping the strict guard
  // (which would THROW under BRIGADE_STRICT_MODE=enforce and break skill
  // creation). Filesystem mode unchanged.
  if (peekConvexMode()) {
    return path.join(resolveOsCacheDir(), "skills");
  }
  return path.join(resolveStateDir(), "skills");
}

// Bundled starter skills ship inside the package at `<packageRoot>/skills`.
// This module sits at `<root>/src/config/paths.ts` in dev and
// `<root>/dist/config/paths.js` once compiled — both are two levels under the
// package root, so `..", ".."` resolves the root in either layout. The npm
// tarball includes `skills/` (package.json "files"), so an installed copy
// finds them at `<pkg>/skills`. Override via BRIGADE_BUNDLED_SKILLS_DIR
// (tests point this at a fixture; set to an empty/missing dir to disable).
export function resolveBundledSkillsDir(): string {
  const override = process.env.BRIGADE_BUNDLED_SKILLS_DIR?.trim();
  if (override && override.length > 0) return path.resolve(override);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "skills");
}

export function resolveTasksDir(): string {
  return path.join(resolveStateDir(), "tasks");
}

export function resolveTasksDbPath(): string {
  return path.join(resolveTasksDir(), "runs.sqlite");
}

export function resolveLogsDir(): string {
  return path.join(resolveStateDir(), "logs");
}

export function resolveIdentityDir(): string {
  return path.join(resolveStateDir(), "identity");
}

export function resolveCompletionsDir(): string {
  return path.join(resolveStateDir(), "completions");
}

export function resolveOauthDir(): string {
  return path.join(resolveStateDir(), "oauth");
}

export function resolveCredentialsDir(): string {
  return path.join(resolveStateDir(), "credentials");
}

export function resolveCacheDir(): string {
  // Regenerable cache artifacts (org-chart PNGs, twemoji SVGs). In convex
  // mode NOTHING may live under ~/.brigade, and these are machine-local
  // scratch by nature — so convex mode uses the OS cache location:
  //   Windows %LOCALAPPDATA%\Brigade\cache, macOS ~/Library/Caches/brigade,
  //   Linux $XDG_CACHE_HOME|~/.cache/brigade.
  // Filesystem mode keeps today's ~/.brigade/cache path unchanged. Pre-boot
  // callers (no runtime context yet) resolve via peekConvexMode's sentinel
  // peek — "no context" does NOT mean convex is inactive (onboard, repair
  // commands with the backend down, the pre-setRuntimeContext boot window),
  // and the old context-only check leaked cache files under ~/.brigade in
  // exactly those windows.
  if (peekConvexMode()) {
    return resolveOsCacheDir();
  }
  return path.join(resolveStateDir(), "cache");
}

/** OS-conventional per-user cache root for Brigade (NOT under ~/.brigade). */
export function resolveOsCacheDir(): string {
  const override = process.env.BRIGADE_CACHE_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Brigade", "cache");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "brigade");
  }
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".cache"), "brigade");
}

/**
 * OS-conventional CONFIG dir (NOT cache — cache dirs are "safe to delete" by
 * platform convention and cleanup tools honour that; config dirs are durable).
 * Windows %LOCALAPPDATA%\Brigade, macOS ~/Library/Application Support/brigade,
 * Linux $XDG_CONFIG_HOME|~/.config/brigade.
 */
export function resolveOsConfigDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Brigade");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "brigade");
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".config"), "brigade");
}

/**
 * Where the auto-generated at-rest encryption key lives. DELIBERATELY outside
 * `~/.brigade`: the key decrypts the Convex data, and `rm -rf ~/.brigade` is
 * the operation convex mode is designed to survive — a key stored inside the
 * wiped dir would turn every wipe into permanent data loss (the n8n lockout
 * failure mode). Also deliberately NOT in the cache dir (cleanup tools may
 * reap caches). `BRIGADE_ENCRYPTION_KEY_FILE` overrides for tests / exotic
 * setups; the `BRIGADE_ENCRYPTION_KEY` env var always beats the file.
 */
export function resolveEncryptionKeyFilePath(): string {
  const override = process.env.BRIGADE_ENCRYPTION_KEY_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveOsConfigDir(), "encryption.key");
}

// Per-channel state root, e.g. `~/.brigade/channels/whatsapp`. Channels keep
// their own auth/creds here so `rm -rf ~/.brigade` wipes them with everything
// else and a single channel can be reset by deleting just its subdir.
export function resolveChannelStateDir(channelId: string): string {
  return path.join(resolveStateDir(), "channels", channelId);
}

// User-extension root, `~/.brigade/extensions/`. Out-of-tree modules dropped
// here (a `*.js`/`*.mjs` file, or a folder with an `index.js`) are discovered
// + loaded alongside the bundled ones — the "drop a module, it works" path.
export function resolveExtensionsDir(): string {
  return path.join(resolveStateDir(), "extensions");
}

// Per-channel access-control files: the list of allowed senders + any pending
// pairing codes. Co-located with the channel's other state so the existing
// `rm -rf ~/.brigade/channels/<id>` reset wipes them along with the creds.
// Multi-account channels (WhatsApp personal + work) partition the lists under
// `accounts/<accountId>/` so revoking one account never affects the other.
// Legacy single-account installs (no accountId, or accountId === "default")
// keep the historical path so existing approvals stay valid.
export function resolveChannelAllowFromPath(channelId: string, accountId?: string | null): string {
  const id = (accountId ?? "").trim();
  if (!id || id === "default") return path.join(resolveChannelStateDir(channelId), "allow-from.json");
  return path.join(resolveChannelStateDir(channelId), "accounts", id, "allow-from.json");
}
// Group allow-from is a separate file so revoking a group's access doesn't
// kick the operator out of their own DMs and vice-versa.
export function resolveChannelGroupAllowFromPath(channelId: string, accountId?: string | null): string {
  const id = (accountId ?? "").trim();
  if (!id || id === "default") return path.join(resolveChannelStateDir(channelId), "group-allow-from.json");
  return path.join(resolveChannelStateDir(channelId), "accounts", id, "group-allow-from.json");
}
export function resolveChannelPairingPath(channelId: string, accountId?: string | null): string {
  const id = (accountId ?? "").trim();
  if (!id || id === "default") return path.join(resolveChannelStateDir(channelId), "pairing.json");
  return path.join(resolveChannelStateDir(channelId), "accounts", id, "pairing.json");
}

export function resolveConfigAuditLogPath(): string {
  return path.join(resolveLogsDir(), "config-audit.jsonl");
}

// Single-file rolling health snapshot — overwritten on every successful
// config write so callers can inspect the most-recent state without
// scanning the audit JSONL.
export function resolveConfigHealthPath(): string {
  return path.join(resolveLogsDir(), "config-health.json");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export interface BrigadePaths {
  stateDir: string;
  configPath: string;
  agentDir: string;
  authDir: string;
  authProfilesPath: string;
  sessionsDir: string;
  sessionStorePath: string;
  workspaceDir: string;
  tasksDbPath: string;
  logsDir: string;
}

export function resolveAllPaths(agentId: string, workspaceOverride?: string): BrigadePaths {
  return {
    stateDir: resolveStateDir(),
    configPath: resolveConfigPath(),
    agentDir: resolveAgentDir(agentId),
    authDir: resolveAuthDir(agentId),
    authProfilesPath: resolveAuthProfilesPath(agentId),
    sessionsDir: resolveSessionsDir(agentId),
    sessionStorePath: resolveSessionStorePath(agentId),
    workspaceDir: resolveAgentWorkspaceDir(agentId, workspaceOverride),
    tasksDbPath: resolveTasksDbPath(),
    logsDir: resolveLogsDir(),
  };
}
