// Static provider catalog used by the onboard wizard.
//
// In a fully plugin-discovered world, this list is computed at startup from
// the loaded provider plugins (each plugin contributes its auth methods +
// model list + label). Brigade's plugin system is on the roadmap but not
// shipped yet; until then a curated catalog is the smallest thing that
// produces a wizard with parity behaviour for the providers we have
// actually validated end-to-end (OpenRouter + OpenAI + Anthropic + Ollama).
//
// When the plugin system lands, this module's exported shape is what
// `resolvePluginProviders()` will return — keeping the wizard's call sites
// stable across that migration.

export type BrigadeAuthMode = "api_key" | "token" | "oauth";

export interface BrigadeProviderModel {
  // Fully-qualified id stored in agents.defaults.model.primary.
  id: string;
  // Human label rendered next to the id in pickers + the alias map.
  label: string;
  // Optional context-window hint surfaced in the picker. Not persisted.
  contextWindow?: number;
}

export interface BrigadeProviderEntry {
  // Stable plugin id (lowercase, single token). Used as the auth-profile
  // provider key, the plugins.entries key, and the prefix of the model id.
  id: string;
  // Human label for prompts.
  label: string;
  // Auth method this provider exposes during onboarding.
  authMode: BrigadeAuthMode;
  // env var the user is prompted to put the key in if they pick `--secret-input-mode ref`.
  // Empty string for providers that genuinely don't need an API key (Ollama).
  envVar: string;
  // One-line hint shown next to the API-key prompt — e.g. where to find it.
  apiKeyHint?: string;
  // Recommended/default model id (the primary if the user just hits Enter).
  defaultModel: string;
  // Models the picker offers. Order = render order. The first entry is the
  // recommended choice (matches `defaultModel`).
  models: BrigadeProviderModel[];
  // True when the provider runs locally and does not require auth — the
  // wizard skips the API-key prompt and registers a no-auth-required
  // sentinel profile so the model fallback layer knows it's available.
  noAuth?: boolean;
}

// The 4 providers Brigade has validated end-to-end. New entries land here
// as they are tested; do not advertise providers that have not been smoke-
// tested at least once — the wizard surfaces every entry as an option, so
// listing untested providers would lead users into broken setups.
export const BRIGADE_PROVIDER_CATALOG: readonly BrigadeProviderEntry[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    authMode: "api_key",
    envVar: "OPENROUTER_API_KEY",
    apiKeyHint: "Get a key at https://openrouter.ai/keys (starts with `sk-or-v1-`)",
    defaultModel: "openrouter/auto",
    models: [
      { id: "openrouter/auto", label: "OpenRouter Auto (best-available)" },
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7 (via OpenRouter)" },
      { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (via OpenRouter)" },
      { id: "openai/gpt-5.4", label: "GPT-5.4 (via OpenRouter)" },
      { id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini (via OpenRouter)" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    // Anthropic's onboarding flow centres on a setup-token (the "API key"
    // copied from console.anthropic.com is in fact a bearer token in
    // protocol terms). Mirror the reference: store it as type:"token" so
    // future setup-token / OAuth flows can land alongside without a
    // schema migration. Brigade's token + api_key paths share the same
    // upsert sanitiser, so the on-disk shape stays clean either way.
    authMode: "token",
    envVar: "ANTHROPIC_API_KEY",
    apiKeyHint: "Get a token at https://console.anthropic.com/settings/keys (starts with `sk-ant-`)",
    defaultModel: "claude-opus-4-7",
    models: [
      { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    authMode: "api_key",
    envVar: "OPENAI_API_KEY",
    apiKeyHint: "Get a key at https://platform.openai.com/api-keys (starts with `sk-`)",
    defaultModel: "gpt-5.4",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local, no API key)",
    authMode: "api_key",
    envVar: "",
    apiKeyHint: "Runs on localhost:11434 — install via https://ollama.com",
    defaultModel: "llama3.1:8b",
    noAuth: true,
    models: [
      { id: "llama3.1:8b", label: "Llama 3.1 8B" },
      { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B" },
    ],
  },
];

export function resolveProviderById(id: string): BrigadeProviderEntry | undefined {
  const normalised = id.trim().toLowerCase();
  return BRIGADE_PROVIDER_CATALOG.find((p) => p.id === normalised);
}

export function resolveModelInProvider(
  provider: BrigadeProviderEntry,
  modelId: string,
): BrigadeProviderModel | undefined {
  return provider.models.find((m) => m.id === modelId);
}

// Build the alias map fragment that `applyModelSelection()` consumes for the
// provider's models. Used by both interactive and non-interactive paths so
// the rendered alias map is identical regardless of how the user got here.
export function buildAliasFragment(
  provider: BrigadeProviderEntry,
  modelIds: string[],
): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const id of modelIds) {
    const m = resolveModelInProvider(provider, id);
    if (m) aliases[id] = m.label;
  }
  return aliases;
}
