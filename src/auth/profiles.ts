import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureDir,
  resolveAuthDir,
  resolveAuthProfilesPath,
  resolveAuthStatePath,
  resolveModelsPath,
} from "../config/paths.js";

// Auth files all live under <agentDir>/agent/ at mode 0600 on POSIX. The
// shape mirrors the Pi SDK auth-profile contract so Pi can read brigade's
// store directly:
//
//   auth-profiles.json — long-lived secrets, keyed by `<provider>:<alias>`
//   auth-state.json    — order/lastGood/usageStats (cooldowns, success/fail)
//   models.json        — provider→model registry snapshot
//
// Splitting state out of the secrets file means rewriting failure counters
// or cooldowns can't accidentally rewrite the secret blob.

export interface AuthProfilesFile {
  version: number;
  // Keyed by `<provider>:<alias>` (alias defaults to "default").
  profiles: Record<string, AuthProfile>;
}

// Structured reference to a secret stored outside auth-profiles.json. Mirrors
// the reference's `SecretRef` shape exactly so downstream consumers reading
// either side's profile see identical bytes:
//
//   { source: "env", provider: "env", id: "OPENROUTER_API_KEY" }
//
// `source` describes the secret-resolution mechanism — must match the
// reference's enum exactly (`"env" | "file" | "exec"`) so cross-tool reads
// never reject a profile on `source` validation. Keychain/vault backends
// are exposed as `source: "exec"` + a named `provider` (e.g.
// `provider: "1password"`), keeping the source axis stable while allowing
// new backends to slot in.
//
// `provider` is the named backend within the source: `env` for
// environment variables, an exec-handler id for keychain/vault flows.
// `id` is the lookup key (env var name, keychain item id, exec arg).
export interface BrigadeSecretRef {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
}

export interface AuthProfile {
  provider: string;
  alias?: string;
  type: "api_key" | "oauth" | "token";
  // api_key — `key` (literal) and `keyRef` (env-var reference) are mutually
  // exclusive on disk: when `keyRef` is set, the `key` field is omitted
  // entirely, matching the reference's persisted-store sanitiser.
  key?: string;
  keyRef?: BrigadeSecretRef;
  // oauth
  access?: string;
  accessRef?: BrigadeSecretRef;
  refresh?: string;
  refreshRef?: BrigadeSecretRef;
  expires?: number;
  // token (e.g. Anthropic setup-token flow)
  token?: string;
  tokenRef?: BrigadeSecretRef;
  // Free-form provider metadata (scopes, account id, etc.).
  metadata?: Record<string, unknown>;
}

export interface AuthStateFile {
  version: number;
  // Failover ordering — first profile in this list per provider is tried first.
  order?: Record<string, string[]>;
  // Last profile that succeeded for a provider — used for sticky selection.
  lastGood?: Record<string, string>;
  // Per-profile-id usage stats. Cooldown disables a profile until a timestamp.
  usageStats?: Record<string, ProfileUsageStats>;
}

export interface ProfileUsageStats {
  lastUsedAt?: number;
  successCount?: number;
  failureCount?: number;
  cooldownUntil?: number;
  cooldownReason?: string;
  disabledUntil?: number;
}

const CURRENT_VERSION = 1;

export function profileId(provider: string, alias?: string): string {
  return `${provider}:${alias ?? "default"}`;
}

export function initAuthProfiles(agentId: string): void {
  const dir = resolveAuthDir(agentId);
  ensureDir(dir);

  const profilesPath = resolveAuthProfilesPath(agentId);
  if (!fs.existsSync(profilesPath)) {
    writeProfilesFile(profilesPath, {
      version: CURRENT_VERSION,
      profiles: {},
    });
  }

  const statePath = resolveAuthStatePath(agentId);
  if (!fs.existsSync(statePath)) {
    writeStateFile(statePath, {
      version: CURRENT_VERSION,
      order: {},
      lastGood: {},
      usageStats: {},
    });
  }

  const modelsPath = resolveModelsPath(agentId);
  if (!fs.existsSync(modelsPath)) {
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({ version: CURRENT_VERSION, providers: {} }, null, 2),
      { mode: 0o600 },
    );
    chmodIfPosix(modelsPath, 0o600);
  }
}

export function readProfiles(agentId: string): AuthProfilesFile {
  const profilesPath = resolveAuthProfilesPath(agentId);
  if (!fs.existsSync(profilesPath)) {
    return { version: CURRENT_VERSION, profiles: {} };
  }
  const raw = fs.readFileSync(profilesPath, "utf8");
  try {
    return JSON.parse(raw) as AuthProfilesFile;
  } catch {
    return { version: CURRENT_VERSION, profiles: {} };
  }
}

export function writeProfiles(agentId: string, file: AuthProfilesFile): void {
  writeProfilesFile(resolveAuthProfilesPath(agentId), file);
}

export function readState(agentId: string): AuthStateFile {
  const statePath = resolveAuthStatePath(agentId);
  if (!fs.existsSync(statePath)) {
    return { version: CURRENT_VERSION, order: {}, lastGood: {}, usageStats: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as AuthStateFile;
  } catch {
    return { version: CURRENT_VERSION, order: {}, lastGood: {}, usageStats: {} };
  }
}

export function writeState(agentId: string, file: AuthStateFile): void {
  writeStateFile(resolveAuthStatePath(agentId), file);
}

// Convenience helpers — used by auth-login and the agent kernel.

// Profile field order mirrors the reference's persisted-store shape:
// `type` first (so a quick scan sees the credential kind), then `provider`,
// then the credential payload (key/token/etc.), then optional metadata.
// Keep this order in every upsert helper so the rendered JSON is byte-
// comparable across implementations.
export function upsertApiKeyProfile(
  agentId: string,
  args: { provider: string; alias?: string; key: string; metadata?: Record<string, unknown> },
): string {
  const file = readProfiles(agentId);
  const id = profileId(args.provider, args.alias);
  file.profiles[id] = sanitizeProfileShape({
    type: "api_key",
    provider: args.provider,
    ...(args.alias ? { alias: args.alias } : {}),
    key: args.key,
    metadata: args.metadata,
  });
  writeProfiles(agentId, file);
  return id;
}

// Ref-mode counterpart: stores a structured BrigadeSecretRef instead of the
// literal key. The literal `key` field is NOT persisted — sanitizeProfileShape
// drops it when keyRef is present.
export function upsertApiKeyRefProfile(
  agentId: string,
  args: { provider: string; alias?: string; keyRef: BrigadeSecretRef; metadata?: Record<string, unknown> },
): string {
  const file = readProfiles(agentId);
  const id = profileId(args.provider, args.alias);
  file.profiles[id] = sanitizeProfileShape({
    type: "api_key",
    provider: args.provider,
    ...(args.alias ? { alias: args.alias } : {}),
    keyRef: args.keyRef,
    metadata: args.metadata,
  });
  writeProfiles(agentId, file);
  return id;
}

// Token-type credential (Anthropic setup-token, GitHub PAT, etc.). Stores a
// literal `token` value. Use upsertTokenRefProfile for the ${VAR} variant.
export function upsertTokenProfile(
  agentId: string,
  args: { provider: string; alias?: string; token: string; metadata?: Record<string, unknown> },
): string {
  const file = readProfiles(agentId);
  const id = profileId(args.provider, args.alias);
  file.profiles[id] = sanitizeProfileShape({
    type: "token",
    provider: args.provider,
    ...(args.alias ? { alias: args.alias } : {}),
    token: args.token,
    metadata: args.metadata,
  });
  writeProfiles(agentId, file);
  return id;
}

export function upsertTokenRefProfile(
  agentId: string,
  args: { provider: string; alias?: string; tokenRef: BrigadeSecretRef; metadata?: Record<string, unknown> },
): string {
  const file = readProfiles(agentId);
  const id = profileId(args.provider, args.alias);
  file.profiles[id] = sanitizeProfileShape({
    type: "token",
    provider: args.provider,
    ...(args.alias ? { alias: args.alias } : {}),
    tokenRef: args.tokenRef,
    metadata: args.metadata,
  });
  writeProfiles(agentId, file);
  return id;
}

// Drop the literal credential field whenever its *Ref counterpart is set,
// matching the reference impl's persisted-store sanitiser
// (auth-profiles/persisted.ts:183-213). The on-disk profile then has either
// `key` OR `keyRef`, never both — same for token/tokenRef etc.
function sanitizeProfileShape(profile: AuthProfile): AuthProfile {
  const out: AuthProfile = { ...profile };
  if (out.keyRef && out.key !== undefined) delete out.key;
  if (out.tokenRef && out.token !== undefined) delete out.token;
  if (out.accessRef && out.access !== undefined) delete out.access;
  if (out.refreshRef && out.refresh !== undefined) delete out.refresh;
  if (out.metadata && Object.keys(out.metadata).length === 0) delete out.metadata;
  return out;
}

function writeProfilesFile(profilesPath: string, file: AuthProfilesFile): void {
  ensureDir(path.dirname(profilesPath));
  const tmp = `${profilesPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodIfPosix(tmp, 0o600);
  fs.renameSync(tmp, profilesPath);
}

function writeStateFile(statePath: string, file: AuthStateFile): void {
  ensureDir(path.dirname(statePath));
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodIfPosix(tmp, 0o600);
  fs.renameSync(tmp, statePath);
}

// chmod is a no-op on Windows (NTFS perms model differs). On POSIX we
// enforce 0600 explicitly so secrets in auth-profiles.json stay readable
// only to the owner.
function chmodIfPosix(filePath: string, mode: number): void {
  if (os.platform() === "win32") return;
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Filesystem may not support chmod (e.g. mounted FAT32).
  }
}
