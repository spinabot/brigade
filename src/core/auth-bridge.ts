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
import * as fs from "node:fs";

import { AuthStorage } from "@mariozechner/pi-coding-agent";

import { DEFAULT_AGENT_ID, resolveAuthProfilesPath } from "../config/paths.js";
import { PROVIDERS } from "../providers/catalog.js";

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
}

interface ReadProfilesFile {
  profiles?: Record<string, ReadProfile>;
}

/**
 * Build a Pi `AuthStorage` populated from Brigade's auth-profiles.json. Returns
 * an empty storage when the file is missing or unparseable so callers can
 * decide whether to surface "no key" themselves (chat re-onboards; gateway
 * throws a clean config error).
 */
export function loadBrigadeAuthStorage(agentId: string = DEFAULT_AGENT_ID): unknown {
  const credentials = readBrigadeCredentials(agentId);
  const Storage = AuthStorage as unknown as {
    inMemory?: (data?: unknown) => unknown;
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof Storage.inMemory === "function") {
    return Storage.inMemory(credentials);
  }
  if (typeof Storage.fromStorage === "function") {
    return Storage.fromStorage({
      withLock<T>(update: (current: string) => { result: T; next?: string }): T {
        const { result } = update(JSON.stringify(credentials, null, 2));
        return result;
      },
    });
  }
  throw new Error(
    "Pi AuthStorage exposes neither inMemory nor fromStorage; pin to 0.70.x or update brigade.",
  );
}

function readBrigadeCredentials(agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const profilesPath = resolveAuthProfilesPath(agentId);
  if (fs.existsSync(profilesPath)) {
    let parsed: ReadProfilesFile;
    try {
      parsed = JSON.parse(fs.readFileSync(profilesPath, "utf8")) as ReadProfilesFile;
      for (const profile of Object.values(parsed.profiles ?? {})) {
        if (!profile?.provider || profile.type !== "api_key") continue;
        const resolvedKey = resolveProfileKey(profile);
        if (!resolvedKey) continue;
        // First-wins per provider — matches Primitive #1's no-cooldown path.
        if (out[profile.provider] === undefined) {
          out[profile.provider] = { type: "api_key", key: resolvedKey };
        }
      }
    } catch {
      // Fall through to env-backed bootstrap.
    }
  }
  // Env-backed bootstrap — mirrors OpenClaw's `addEnvBackedPiCredentials`
  // (src/agents/pi-model-discovery.ts:243). If a user has ANTHROPIC_API_KEY (etc)
  // exported in their shell but never ran `brigade onboard`, Pi's registry would
  // hide the provider unless we surface that key here. Profile-stored keys take
  // precedence — env is only consulted when a provider has no profile entry.
  for (const provider of PROVIDERS) {
    if (!provider.envVar || provider.noAuth) continue;
    if (out[provider.id] !== undefined) continue;
    const apiKey = process.env[provider.envVar];
    if (!apiKey) continue;
    out[provider.id] = { type: "api_key", key: apiKey };
  }
  return out;
}

function resolveProfileKey(profile: ReadProfile): string {
  if (profile.key && profile.key.length > 0) return profile.key;
  const ref = profile.keyRef;
  if (!ref) return "";
  // String form (legacy): `${ENV_VAR}` literal. Matches the regex agent-loop
  // uses for the same shape.
  if (typeof ref === "string") {
    const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
    if (m && m[1]) return process.env[m[1]] ?? "";
    return ref;
  }
  // BrigadeSecretRef object form: only env-source is resolvable synchronously.
  if (ref.source === "env" && ref.id) {
    return process.env[ref.id] ?? "";
  }
  return "";
}
