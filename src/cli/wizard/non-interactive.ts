import {
  type BrigadeConfig,
} from "../../config/io.js";
import {
  type BrigadeSecretRef,
  upsertApiKeyProfile,
  upsertApiKeyRefProfile,
  upsertTokenProfile,
  upsertTokenRefProfile,
} from "../../auth/profiles.js";

import {
  applyAuthProfileMeta,
  applyGatewayCredentials,
  applyModelSelection,
  applyOnboardDefaults,
  applyPluginEnable,
  buildProfileId,
  normalizeGatewayTokenInput,
} from "./helpers.js";
import {
  buildAliasFragment,
  resolveModelInProvider,
  resolveProviderById,
} from "./providers.js";

// Non-interactive path. Driven entirely by flags (or programmatic call) so
// CI / scripted installs can produce the same brigade.json shape the
// interactive wizard does.
//
// Inputs:
//   workspace        — agent workspace dir (already resolved by caller)
//   provider         — provider id from BRIGADE_PROVIDER_CATALOG
//   apiKey           — literal key OR ${VAR} ref OR undefined for noAuth providers
//   secretInputMode  — "plaintext" (default) → store literal in auth-profiles.json
//                      "ref"                 → store BrigadeSecretRef pointing at envVar
//   model            — primary model id (must belong to the picked provider)
//   fallbackModel    — optional second model id (model fallback chain)
//   gatewayPort      — explicit port; if omitted, reads BRIGADE_GATEWAY_PORT env or defaults
//   gatewayToken     — explicit token; if omitted, randomToken()
//   agentId          — agent whose auth-profiles.json receives the key
//
// Output:
//   { config: BrigadeConfig — caller writes via writeConfigSafe,
//     profileId: string     — `<provider>:default` for log/print,
//     wroteSecret: boolean  — true when an api-key landed on disk }

export interface BrigadeNonInteractiveSetupArgs {
  config: BrigadeConfig;
  workspace: string;
  agentId: string;
  provider: string;
  apiKey?: string;
  secretInputMode?: "plaintext" | "ref";
  model?: string;
  fallbackModel?: string;
  gatewayPort?: number;
  gatewayToken?: string;
  mode?: "local" | "remote";
  hasExistingConfig?: boolean;
}

export interface BrigadeNonInteractiveSetupResult {
  config: BrigadeConfig;
  profileId: string;
  wroteSecret: boolean;
}

// 18789 is the same default port the reference uses. Pinned (not random)
// so a user pulling Brigade fresh sees a predictable URL on first run.
export const BRIGADE_DEFAULT_GATEWAY_PORT = 18789;

// Resolve the gateway port using the same precedence the reference does:
//   1. explicit caller-provided value
//   2. $BRIGADE_GATEWAY_PORT (operator override)
//   3. compile-time default 18789
export function resolveGatewayPortDefault(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const raw = env.BRIGADE_GATEWAY_PORT?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return BRIGADE_DEFAULT_GATEWAY_PORT;
}

export function runNonInteractiveSetup(
  args: BrigadeNonInteractiveSetupArgs,
): BrigadeNonInteractiveSetupResult {
  const provider = resolveProviderById(args.provider);
  if (!provider) {
    throw new Error(
      `Unknown provider "${args.provider}". Known providers: openrouter, anthropic, openai, ollama`,
    );
  }

  const primaryModelId = args.model ?? provider.defaultModel;
  if (!resolveModelInProvider(provider, primaryModelId)) {
    throw new Error(
      `Model "${primaryModelId}" is not in provider "${provider.id}". ` +
        `Choose one of: ${provider.models.map((m) => m.id).join(", ")}`,
    );
  }
  const fallbackModelId = args.fallbackModel?.trim() || undefined;
  if (fallbackModelId && !resolveModelInProvider(provider, fallbackModelId)) {
    // Fallbacks across providers are valid in the running system but the
    // wizard refuses to set them up — they require multiple auth profiles
    // and we want the simple path to stay simple.
    throw new Error(
      `Fallback model "${fallbackModelId}" is not in provider "${provider.id}". ` +
        `For multi-provider fallbacks, run \`brigade onboard\` once per provider.`,
    );
  }

  let next: BrigadeConfig = applyOnboardDefaults(args.config, {
    workspace: args.workspace,
    mode: args.mode ?? "local",
    hasExistingConfig: args.hasExistingConfig === true,
  });

  const normalisedToken = normalizeGatewayTokenInput(args.gatewayToken);
  next = applyGatewayCredentials(next, {
    port: resolveGatewayPortDefault(args.gatewayPort),
    ...(normalisedToken ? { token: normalisedToken } : {}),
  });

  // Auth — split into "secret to disk" and "metadata to brigade.json".
  let wroteSecret = false;
  const profileId = buildProfileId(provider.id);
  const secretInputMode = args.secretInputMode ?? "plaintext";

  if (provider.noAuth) {
    // Ollama and similar local-only providers — no key, but we still
    // register a metadata entry so the model fallback layer treats the
    // provider as "available" without prompting.
    next = applyAuthProfileMeta(next, {
      profileId,
      provider: provider.id,
      mode: provider.authMode,
    });
  } else if (secretInputMode === "ref") {
    // Ref mode — write a structured BrigadeSecretRef instead of a literal.
    // The runtime resolves $envVar at startup; the literal never lands on
    // disk. Shape mirrors the reference's SecretRef:
    //   { source: "env", provider: "env", id: "<VAR_NAME>" }
    if (!provider.envVar) {
      throw new Error(
        `Provider "${provider.id}" does not declare an env var; secret-input-mode "ref" is unavailable.`,
      );
    }
    const ref: BrigadeSecretRef = { source: "env", provider: "env", id: provider.envVar };
    if (provider.authMode === "token") {
      upsertTokenRefProfile(args.agentId, { provider: provider.id, tokenRef: ref });
    } else {
      upsertApiKeyRefProfile(args.agentId, { provider: provider.id, keyRef: ref });
    }
    wroteSecret = true;
    next = applyAuthProfileMeta(next, {
      profileId,
      provider: provider.id,
      mode: provider.authMode,
    });
  } else {
    // Plaintext mode — literal landed on disk at mode 0o600.
    if (!args.apiKey || args.apiKey.trim().length === 0) {
      throw new Error(
        `Provider "${provider.id}" requires an API key — pass --api-key or set ${provider.envVar}.`,
      );
    }
    if (provider.authMode === "token") {
      upsertTokenProfile(args.agentId, { provider: provider.id, token: args.apiKey });
    } else {
      upsertApiKeyProfile(args.agentId, { provider: provider.id, key: args.apiKey });
    }
    wroteSecret = true;
    next = applyAuthProfileMeta(next, {
      profileId,
      provider: provider.id,
      mode: provider.authMode,
    });
  }

  // Plugins.entries — flip the picked provider on so subsequent boots
  // load it without reprompting.
  next = applyPluginEnable(next, provider.id);

  // Model selection — primary + optional fallback within the same provider.
  // Cross-provider fallback chains are deferred to a future "advanced"
  // wizard step; the smoke-tested path is single-provider.
  const fallbacks = fallbackModelId ? [fallbackModelId] : undefined;
  next = applyModelSelection(next, {
    primary: primaryModelId,
    fallbacks,
    aliases: buildAliasFragment(
      provider,
      fallbacks ? [primaryModelId, ...fallbacks] : [primaryModelId],
    ),
  });

  return { config: next, profileId, wroteSecret };
}
