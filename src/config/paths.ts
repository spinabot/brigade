import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return path.join(resolveSessionsDir(agentId), `${sessionId}.jsonl`);
}

// Workspace lives at the state-dir level (NOT under <agentDir>/) so personas
// are shared across agents. This matches the reference's layout — one set of
// IDENTITY/SOUL/AGENTS/USER/TOOLS/HEARTBEAT/BOOTSTRAP files per host, not
// per-agent. The `agentId` parameter is kept on the signature for forward
// compatibility (a future per-agent override could honour it) but ignored
// today; the optional `override` and `BRIGADE_PROFILE` env var are the only
// paths that diverge from the canonical `<stateDir>/workspace/`.
export function resolveAgentWorkspaceDir(_agentId: string, override?: string): string {
  if (override && override.length > 0) return path.resolve(override);
  const profile = process.env.BRIGADE_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(resolveStateDir(), `workspace-${profile}`);
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
  return path.join(resolveStateDir(), "cache");
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
export function resolveChannelAllowFromPath(channelId: string): string {
  return path.join(resolveChannelStateDir(channelId), "allow-from.json");
}
// Group allow-from is a separate file so revoking a group's access doesn't
// kick the operator out of their own DMs and vice-versa.
export function resolveChannelGroupAllowFromPath(channelId: string): string {
  return path.join(resolveChannelStateDir(channelId), "group-allow-from.json");
}
export function resolveChannelPairingPath(channelId: string): string {
  return path.join(resolveChannelStateDir(channelId), "pairing.json");
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
