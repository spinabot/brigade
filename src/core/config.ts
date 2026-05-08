/**
 * Adapter shim — re-exports F:\Brigade's existing config functions under the
 * names the lifted TUI (src/ui/chat.ts, src/cli/commands/chat.ts) expects.
 *
 * The lifted code was authored against the published v0.1.3 module shape
 * (`src/core/config.ts`), but F:\Brigade's active config layer lives at
 * `src/config/io.ts` + `src/config/paths.ts`. Rather than rewrite every
 * import site, this shim maps the old names to the new ones.
 */

import {
  resolveStateDir,
  resolveAgentWorkspaceDir,
  resolveSessionsDir,
  DEFAULT_AGENT_ID,
} from "../config/paths.js";
import {
  readConfigOrInit,
  writeConfigSafe,
  type BrigadeConfig,
} from "../config/io.js";

// Top-level state dir — `~/.brigade` (or whatever BRIGADE_STATE_DIR env override
// resolves to). Lifted callers use this to compose paths under the agent's
// workspace; resolveStateDir does the env override lookup correctly.
export const BRIGADE_DIR: string = resolveStateDir();

// Lifted callers expect a synchronous `loadConfig() => Config` that returns
// the brigade.json contents (or an empty default). F:\Brigade's
// readConfigOrInit does exactly this.
export function loadConfig(): BrigadeConfig {
  return readConfigOrInit();
}

// `saveConfig(cfg)` — write back through the safe atomic + ${VAR}-restore path.
//
// Two backward-compat behaviours live here for the lifted v0.1.3 callers:
//
//   1. Merge-with-existing. The lifted ui/chat.ts calls saveConfig with a
//      partial like `{defaultProvider, defaultModelId}` only — but
//      writeConfigSafe writes its argument verbatim. Without merge, the
//      first `/model` switch in chat would wipe agents/auth/gateway/wizard/
//      meta blocks. We load the current brigade.json and shallow-merge top-
//      level keys (with deep-merge for `agents.defaults.model`) before
//      handing to writeConfigSafe.
//
//   2. Legacy-shape remap. The v0.1.3 callers persist the active provider/
//      model under flat top-level keys (`defaultProvider` / `defaultModelId`).
//      Brigade's runtime reads `agents.defaults.{provider, model.primary}`.
//      We translate the flat keys into the canonical shape on every write,
//      then drop the flat keys from the persisted output so the file shape
//      stays clean.
//
// Direct callers (onboard's bridge, the F:\Brigade-native wizards) that
// already build the full canonical-shape config still pass through cleanly —
// the merge is a no-op when the input doesn't carry the legacy keys.
export function saveConfig(cfg: BrigadeConfig): void {
  const next = mergeAndNormalizeConfig(cfg);
  writeConfigSafe(next);
}

function mergeAndNormalizeConfig(input: BrigadeConfig): BrigadeConfig {
  const existing = readConfigOrInit();
  const merged: BrigadeConfig = { ...existing, ...input };

  // Remap legacy flat keys → agents.defaults.{provider, model.primary}.
  const flat = input as { defaultProvider?: unknown; defaultModelId?: unknown };
  const provider =
    typeof flat.defaultProvider === "string" && flat.defaultProvider.length > 0
      ? flat.defaultProvider
      : undefined;
  const modelId =
    typeof flat.defaultModelId === "string" && flat.defaultModelId.length > 0
      ? flat.defaultModelId
      : undefined;

  if (provider || modelId) {
    const agents = (merged.agents as Record<string, unknown> | undefined) ?? {};
    const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
    const model = (defaults.model as Record<string, unknown> | undefined) ?? {};
    if (provider) defaults.provider = provider;
    if (modelId) model.primary = modelId;
    defaults.model = model;
    agents.defaults = defaults;
    merged.agents = agents as never;
  }

  // Drop the flat keys so the persisted file stays in canonical shape. This
  // is safe because the canonical fields above carry the same information.
  delete (merged as Record<string, unknown>).defaultProvider;
  delete (merged as Record<string, unknown>).defaultModelId;

  return merged;
}

// Workspace dir for the default agent. Lifted onboarding code threads an
// override through; chat.ts uses the default.
export function getBrigadeWorkspaceDir(agentId: string = DEFAULT_AGENT_ID): string {
  return resolveAgentWorkspaceDir(agentId);
}

// Session storage dir. Mirrors the reference's `resolveAgentSessionsDir`
// from `src/config/sessions/paths.ts:9-17` exactly:
//
//   ~/.brigade/agents/<id>/sessions/<sessionId>.jsonl
//
// Flat layout, no cwd partitioning. Pi's
// `SessionManager.continueRecent(cwd, sessionDir)` takes `cwd` ONLY for
// matching the recent session via JSONL-header read; the dir argument is
// the storage location and stays flat. The lifted call site
// (`core/agent.ts:112`) passes cwd as the first arg of this function for
// signature compatibility, but we ignore it for path construction —
// matching how the reference handles the same case.
//
// Critical: this MUST point under `~/.brigade/...` not Pi's default
// `~/.pi/agent/sessions/` so a single `rm -rf ~/.brigade` truly wipes all
// Brigade state (the rule that motivated this shim in the first place).
export function getBrigadeSessionDir(_cwd?: string): string {
  return resolveSessionsDir(DEFAULT_AGENT_ID);
}

// Re-export the type so lifted callers that import `Config` keep compiling.
// (The lifted code uses unstructured access — `cfg.providers?.openrouter?.apiKey`
// — which works against BrigadeConfig's `[key: string]: unknown` index sig.)
export type { BrigadeConfig as Config } from "../config/io.js";
