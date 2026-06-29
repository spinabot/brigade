/**
 * Auth bridge — reads Brigade's `auth-profiles.json` (the file `brigade onboard`
 * actually writes) and produces a Pi `AuthStorage` that the lifted CLI surfaces
 * (`brigade chat`, `brigade gateway`) can hand to `ModelRegistry`.
 *
 * Without this, those commands would default to `AuthStorage.create(<dir>/auth.json)` —
 * Pi's vanilla on-disk store — and never see the keys onboarding wrote into
 * `~/.brigade/agents/main/agent/auth-profiles.json`. Mutually invisible.
 *
 * This is a deliberately small subset of `agents/agent-loop.ts`'s
 * `readAuthProfilesAsCredentialMap` + `buildAuthStorage` (cooldown filtering
 * skipped — only Primitive #1's run loop needs that). Duplicating the small
 * surface here keeps the agent-loop module untouched per the lift-scope rule.
 */
import { AuthStorage } from "@earendil-works/pi-coding-agent";

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import { PROVIDERS } from "../providers/catalog.js";
import { readProfiles, updateOAuthTokens } from "../auth/profiles.js";

// Minimal shape we read from auth-profiles.json. Mirrors `AuthProfile` in
// `src/auth/profiles.ts` but only the fields the credential-map build needs.
interface ReadProfile {
  provider?: string;
  type?: string;
  key?: string;
  // BrigadeSecretRef when set: {source, provider, id}. We only resolve
  // `source: "env"` here — file/exec backends require an async resolver and
  // are out of scope for the bridge's synchronous build.
  keyRef?: { source?: string; provider?: string; id?: string } | string;
  // oauth / token profiles (subscription login).
  access?: string;
  accessRef?: { source?: string; provider?: string; id?: string } | string;
  refresh?: string;
  refreshRef?: { source?: string; provider?: string; id?: string } | string;
  expires?: number;
  token?: string;
  tokenRef?: { source?: string; provider?: string; id?: string } | string;
  // Free-form provider metadata (scopes, account id, availableModelIds, …).
  // Must reach Pi for the oauth path — Copilot enterprise refresh +
  // availableModelIds ride here.
  metadata?: Record<string, unknown>;
}

interface ReadProfilesFile {
  profiles?: Record<string, ReadProfile>;
}

interface LockResult<T> {
  result: T;
  next?: string;
}

/**
 * An `AuthStorageBackend` that READS Brigade's resolved credential map and
 * PERSISTS any OAuth refresh Pi performs back into auth-profiles.json.
 *
 * Pi's `AuthStorage` auto-refreshes an expired OAuth token on `getApiKey()` and
 * persists the result through the backend's `withLock` — calling our `fn` with
 * the current serialized credential map and handing back the refreshed map as
 * `next`. Every subscription provider that matters (Anthropic / OpenAI-Codex /
 * Google) ROTATES its refresh token on each refresh, so the refreshed map
 * carries a NEW refresh token and the old one is now dead. We diff `next`
 * against `current` and write each changed oauth credential back via
 * `updateOAuthTokens`. Generic across providers — whatever Pi refreshed lands
 * on disk, so the rotated token survives a gateway restart.
 *
 * Brigade previously used `AuthStorage.inMemory`, which kept refreshes only in
 * the live process: after a restart it re-read the stale (rotated-out) on-disk
 * refresh token, every turn 401'd, and the subscription login looked like the
 * gateway "disconnecting" a day or two after onboarding. This backend closes
 * that gap.
 */
export function persistentAuthBackend(
  agentId: string,
  seedCredentials?: Record<string, unknown>,
): {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
} {
  const readCurrent = (): string => {
    // When seeded (the per-turn path), return the already-resolved
    // (cooldown-filtered) credential map so Pi's profile SELECTION is
    // preserved; otherwise read the raw on-disk profiles (boot path).
    if (seedCredentials) return JSON.stringify(seedCredentials);
    try {
      return JSON.stringify(readBrigadeCredentials(agentId));
    } catch {
      return "{}";
    }
  };
  const persist = (next: string | undefined, current: string): void => {
    if (!next || next === current) return;
    let nextMap: Record<string, unknown>;
    try {
      nextMap = JSON.parse(next) as Record<string, unknown>;
    } catch {
      return;
    }
    let curMap: Record<string, unknown> = {};
    try {
      curMap = JSON.parse(current) as Record<string, unknown>;
    } catch {
      /* treat as empty — persist everything oauth in `next` */
    }
    for (const [provider, raw] of Object.entries(nextMap)) {
      if (!raw || typeof raw !== "object") continue;
      const cred = raw as Record<string, unknown>;
      if (cred.type !== "oauth") continue; // only oauth creds refresh/rotate
      // Only persist what actually changed — leave untouched providers alone.
      if (JSON.stringify(curMap[provider]) === JSON.stringify(raw)) continue;
      const { type: _type, access, refresh, expires, ...rest } = cred;
      void _type;
      try {
        updateOAuthTokens(agentId, provider, {
          access: typeof access === "string" ? access : undefined,
          refresh: typeof refresh === "string" ? refresh : undefined,
          expires: typeof expires === "number" ? expires : undefined,
          metadata: Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : undefined,
        });
      } catch {
        /* best-effort — a write-back failure must never break the turn */
      }
    }
  };
  return {
    withLock(fn) {
      const current = readCurrent();
      const out = fn(current);
      try {
        persist(out.next, current);
      } catch {
        /* best-effort */
      }
      return out.result;
    },
    async withLockAsync(fn) {
      const current = readCurrent();
      const out = await fn(current);
      try {
        persist(out.next, current);
      } catch {
        /* best-effort */
      }
      return out.result;
    },
  };
}

/**
 * Build a Pi `AuthStorage` populated from Brigade's auth-profiles.json. Returns
 * an empty storage when the file is missing or unparseable so callers can
 * decide whether to surface "no key" themselves (chat re-onboards; gateway
 * throws a clean config error).
 *
 * Prefers a PERSISTENT backend (`fromStorage`) so Pi's OAuth refresh is written
 * back to disk — see `persistentAuthBackend`. Falls back to `inMemory` only on a
 * Pi build that lacks `fromStorage` (refreshes then live only for the process).
 */
export function loadBrigadeAuthStorage(agentId: string = DEFAULT_AGENT_ID): unknown {
  const Storage = AuthStorage as unknown as {
    fromStorage?: (storage: unknown) => unknown;
    inMemory?: (data?: unknown) => unknown;
  };
  if (typeof Storage.fromStorage === "function") {
    return Storage.fromStorage(persistentAuthBackend(agentId));
  }
  if (typeof Storage.inMemory === "function") {
    return Storage.inMemory(readBrigadeCredentials(agentId));
  }
  throw new Error(
    "Pi AuthStorage exposes neither fromStorage nor inMemory; pin to 0.70.x or update brigade.",
  );
}

export function readBrigadeCredentials(agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Route through the mode-aware `readProfiles` choke point: filesystem mode
  // reads auth-profiles.json, convex mode reads the in-process cache primed
  // at boot from the sealed authProfiles table. Either way the bridge sees
  // the same profiles the agent kernel does.
  let parsed: ReadProfilesFile = {};
  try {
    parsed = readProfiles(agentId) as unknown as ReadProfilesFile;
  } catch {
    // Fall through to env-backed bootstrap.
  }
  for (const profile of Object.values(parsed.profiles ?? {})) {
    if (!profile?.provider) continue;
    if (out[profile.provider] !== undefined) continue; // first-wins per provider
    // Subscription credentials (OAuth login / setup-token) pass straight
    // through — Pi's AuthStorage handles {type:"oauth"} (auto-refresh) and
    // detects an `sk-ant-oat…` token to switch to Bearer auth.
    if (profile.type === "oauth" || profile.type === "token") {
      const cred = subscriptionProfileToCredential(profile);
      if (cred) out[profile.provider] = cred;
      continue;
    }
    if (profile.type !== "api_key") continue;
    const resolvedKey = resolveProfileKey(profile);
    if (resolvedKey) out[profile.provider] = { type: "api_key", key: resolvedKey };
  }
  // Env-backed bootstrap. If a user has ANTHROPIC_API_KEY (or the OAuth-token
  // fallback ANTHROPIC_OAUTH_TOKEN) exported but never ran `brigade onboard`,
  // surface it so Pi's registry exposes the provider. Profile-stored creds
  // take precedence — env is only consulted when a provider has no profile.
  for (const provider of PROVIDERS) {
    if (provider.noAuth) continue;
    if (out[provider.id] !== undefined) continue;
    const envNames = [provider.envVar, ...(provider.envVarFallbacks ?? [])];
    for (const name of envNames) {
      if (!name) continue;
      const value = process.env[name];
      if (!value) continue;
      out[provider.id] = { type: "api_key", key: value };
      break;
    }
  }
  // Main-agent credential fallback. Org agents (eng-intern-1, ceo, …) have no
  // auth profile of their own and the env fallback is dead in convex mode — so
  // a non-`main` agent would otherwise resolve an empty credential map. For any
  // provider STILL missing after its own profiles + env, merge in `main`'s
  // credential. Precedence is preserved (per-agent profile → env → main), so a
  // non-main agent with its OWN key keeps it. Mode-agnostic.
  if (agentId !== DEFAULT_AGENT_ID) {
    const mainCreds = readAgentProfileCredentials(DEFAULT_AGENT_ID);
    for (const [provider, cred] of Object.entries(mainCreds)) {
      if (out[provider] !== undefined) continue;
      out[provider] = cred;
    }
  }
  return out;
}

// Resolve only an agent's STORED profile credentials (api_key / oauth / token),
// without env or main fallback. Used by the non-main fallback above to surface
// `main`'s keys for org agents. Routes through the mode-aware `readProfiles`.
function readAgentProfileCredentials(agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let parsed: ReadProfilesFile = {};
  try {
    parsed = readProfiles(agentId) as unknown as ReadProfilesFile;
  } catch {
    parsed = {};
  }
  for (const profile of Object.values(parsed.profiles ?? {})) {
    if (!profile?.provider) continue;
    if (out[profile.provider] !== undefined) continue; // first-wins per provider
    if (profile.type === "oauth" || profile.type === "token") {
      const cred = subscriptionProfileToCredential(profile);
      if (cred) out[profile.provider] = cred;
      continue;
    }
    if (profile.type !== "api_key") continue;
    const resolvedKey = resolveProfileKey(profile);
    if (resolvedKey) out[profile.provider] = { type: "api_key", key: resolvedKey };
  }
  return out;
}

// Resolve a literal-or-ref secret value (key / access / refresh / token).
// String refs are the legacy `${ENV_VAR}` form; object refs (BrigadeSecretRef)
// resolve only env source synchronously — file/exec backends are out of scope
// for the bridge's sync build.
function resolveRefValue(
  value: string | undefined,
  ref: { source?: string; provider?: string; id?: string } | string | undefined,
): string {
  if (value && value.length > 0) return value;
  if (!ref) return "";
  if (typeof ref === "string") {
    const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
    if (m && m[1]) return process.env[m[1]] ?? "";
    return ref;
  }
  if (ref.source === "env" && ref.id) return process.env[ref.id] ?? "";
  return "";
}

function resolveProfileKey(profile: ReadProfile): string {
  return resolveRefValue(profile.key, profile.keyRef);
}

// Map an OAuth-login / setup-token profile to a Pi credential. OAuth →
// {type:"oauth", access, refresh, expires} (Pi auto-refreshes); token →
// {type:"api_key", key} so Pi's value-based `sk-ant-oat` Bearer detection
// fires. Returns null when no secret resolves.
function subscriptionProfileToCredential(profile: ReadProfile): Record<string, unknown> | null {
  if (profile.type === "oauth") {
    const access = resolveRefValue(profile.access, profile.accessRef);
    if (!access) return null;
    const refresh = resolveRefValue(profile.refresh, profile.refreshRef);
    // A durable oauth profile CAN lack `expires` (the Claude/Codex CLI-login
    // path). Coerce a missing/garbage value to 0 so Pi treats the access token
    // as expired and refreshes via the refresh token immediately. Spread
    // `metadata` FIRST so the known oauth fields always win — it carries the
    // extras (Copilot enterprise refresh + availableModelIds) Pi needs.
    const expires =
      typeof profile.expires === "number" && Number.isFinite(profile.expires)
        ? profile.expires
        : 0;
    return {
      ...(profile.metadata && typeof profile.metadata === "object" ? profile.metadata : {}),
      type: "oauth",
      access,
      refresh: refresh || undefined,
      expires,
    };
  }
  if (profile.type === "token") {
    const token = resolveRefValue(profile.token, profile.tokenRef);
    if (!token) return null;
    return { type: "api_key", key: token };
  }
  return null;
}
