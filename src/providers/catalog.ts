/**
 * Curated list of LLM providers Brigade exposes in the onboarding picker.
 *
 * Pi-AI knows ~25 providers internally — we surface the ~10 most popular for
 * UX. Power users can edit `~/.brigade/models.json` to add anything else Pi
 * supports (Bedrock, Vertex, ZAI, Moonshot, etc.) — see Pi's docs.
 *
 * `id` MUST match Pi-AI's KnownProvider names from
 *   pi-mono/packages/ai/src/types.ts:18
 *
 * `envVar` MUST match Pi's findEnvKeys() conventions from
 *   pi-mono/packages/ai/src/env-api-keys.ts:101
 */

export interface ProviderInfo {
	/** Pi-AI provider id (KnownProvider) — or a custom id we register at runtime (e.g. "ollama"). */
	id: string;
	/**
	 * Real Pi provider id this picker entry resolves to for credential storage +
	 * model routing, when it differs from `id`. Lets ONE Pi provider surface as
	 * TWO picker choices with different auth models — e.g. "Anthropic" (API key,
	 * id "anthropic") and "Claude Code" (subscription, id "claude-code") both
	 * store their credential under, and route their models through, Pi's
	 * `anthropic` provider. Defaults to `id` when unset.
	 */
	providerId?: string;
	/** Display name shown in the picker. */
	name: string;
	/** One-line tagline for the picker description column. */
	description: string;
	/** Where to grab an API key, or install instructions for local providers. */
	keyUrl: string;
	/** Env var Pi will auto-detect (matches Pi's findEnvKeys). Empty for local providers. */
	envVar: string;
	/**
	 * Optional fallback env vars Brigade-side detection will try when `envVar`
	 * itself isn't set. Each provider can list multiple candidate vars —
	 * e.g. Anthropic accepts either `ANTHROPIC_API_KEY` or
	 * `ANTHROPIC_OAUTH_TOKEN`. When ANY of these is set, the auto-select
	 * path treats the provider as "env-detected".
	 *
	 * Note: Pi's own `getEnvApiKey` only checks the primary `envVar`; this
	 * extra layer is Brigade-side and is consulted by the auto-select
	 * shortcut + the provider picker's "detected" badge.
	 */
	envVarFallbacks?: string[];
	/**
	 * Provider does not require an API key (Ollama, LM Studio, etc.). Onboarding
	 * skips the key-entry step and instead validates the local server is reachable.
	 */
	noAuth?: boolean;
	/**
	 * Provider runs on the user's machine. Onboarding discovers the model list at
	 * runtime (e.g. by hitting `/api/tags` for Ollama) instead of using Pi-AI's
	 * static catalogue, since the available models depend on what the user has
	 * actually pulled locally.
	 */
	local?: boolean;
	/** Default base URL for local providers — what we ping during validation. */
	baseUrl?: string;
	/**
	 * Bring-your-own OpenAI-compatible endpoint. Onboarding/provider flow asks
	 * the user for the provider id, baseUrl, apiKey, and one model id at a time
	 * instead of using a built-in catalog.
	 */
	custom?: boolean;
	/** Subscription / OAuth-login support — onboarding offers a browser login instead of an API key. */
	subscription?: { oauthProviderId: string; label: string };
	/**
	 * Reuse a vendor CLI's already-stored login on this machine. When set,
	 * onboarding reads the named CLI's credential file and offers a one-keystroke
	 * "reuse this login" path (no browser, no key) before the subscription / key
	 * flow.
	 */
	cliLogin?: { read: "claude" | "codex"; label: string };
	/**
	 * Pi API shape for a custom (catalog-defined) provider. Determines how Pi
	 * frames requests against `baseUrl` — `anthropic-messages` for an
	 * Anthropic-compatible endpoint, `openai-completions` for an OpenAI-compatible
	 * one. Paired with `custom: true` + `baseUrl` + `models`.
	 */
	api?: "openai-completions" | "anthropic-messages";
	/** Catalog model ids registered into models.json for a custom provider. */
	models?: string[];
	/**
	 * Discover this custom provider's models LIVE from its OpenAI-compatible
	 * `/models` endpoint during onboarding (instead of a hardcoded `models` list),
	 * for providers whose served set changes over time and isn't in Pi's bundled
	 * catalog — e.g. NVIDIA NIM. The fetch also online-validates the key.
	 */
	liveModels?: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		description: "Claude models via an Anthropic API key",
		keyUrl: "https://console.anthropic.com/settings/keys",
		envVar: "ANTHROPIC_API_KEY",
		// `ANTHROPIC_OAUTH_TOKEN` (exported by the Claude CLI subscription auth)
		// stays a valid fallback so the runtime credential pipeline still resolves
		// it. The subscription PATH itself lives on the "claude-code" entry below —
		// this entry is the pay-per-token API-key route.
		envVarFallbacks: ["ANTHROPIC_OAUTH_TOKEN"],
	},
	{
		// Same Pi provider as "anthropic" (so models route + the credential stores
		// under `anthropic`), surfaced as a distinct SUBSCRIPTION choice: log in
		// with Claude Pro / Max, or reuse an existing Claude Code login — no key.
		id: "claude-code",
		providerId: "anthropic",
		name: "Claude Code",
		description: "Use your Claude Pro / Max subscription — no API key",
		keyUrl: "https://claude.ai",
		envVar: "",
		subscription: { oauthProviderId: "anthropic", label: "Log in with Claude Pro / Max" },
		cliLogin: { read: "claude", label: "Use your existing Claude Code login" },
	},
	{
		// The claude-cli backend: Brigade drives the installed `claude` binary as
		// the inference transport, so a turn bills against the Claude subscription
		// EXACTLY like the Claude Code CLI / IDE extension (the binary uses its own
		// login; Anthropic never routes it into the metered "extra usage" tier the
		// raw-HTTP OAuth path can hit). No key + no browser flow here — the binary
		// authenticates itself; if it isn't logged in, the operator runs
		// `claude` once (or `claude /login`). `local:true` makes onboarding skip
		// key entry and validate the binary instead; models are synthesized (see
		// src/agents/claude-cli), so there's no catalog/models.json entry to seed.
		id: "claude-cli",
		name: "Claude (via Claude Code CLI)",
		description: "Run on your Claude subscription through the installed claude binary — no key, no extra-usage",
		keyUrl: "https://claude.ai/download",
		envVar: "",
		noAuth: true,
		local: true,
	},
	{
		id: "openai",
		name: "OpenAI",
		description: "GPT-5, GPT-4o",
		keyUrl: "https://platform.openai.com/api-keys",
		envVar: "OPENAI_API_KEY",
	},
	{
		id: "google",
		name: "Google Gemini",
		description: "Gemini 2.5 — generous free tier",
		keyUrl: "https://aistudio.google.com/apikey",
		envVar: "GEMINI_API_KEY",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		description: "300+ models from one key",
		keyUrl: "https://openrouter.ai/settings/keys",
		envVar: "OPENROUTER_API_KEY",
	},
	{
		id: "groq",
		name: "Groq",
		description: "Very fast inference (Llama, Qwen, Kimi)",
		keyUrl: "https://console.groq.com/keys",
		envVar: "GROQ_API_KEY",
	},
	{
		id: "cerebras",
		name: "Cerebras",
		description: "Extremely fast inference",
		keyUrl: "https://cloud.cerebras.ai",
		envVar: "CEREBRAS_API_KEY",
	},
	{
		id: "xai",
		name: "xAI",
		description: "Grok models",
		keyUrl: "https://console.x.ai",
		envVar: "XAI_API_KEY",
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		description: "Cheap reasoning models",
		keyUrl: "https://platform.deepseek.com/api_keys",
		envVar: "DEEPSEEK_API_KEY",
	},
	{
		id: "mistral",
		name: "Mistral",
		description: "European, strong open-weight roots",
		keyUrl: "https://console.mistral.ai/api-keys",
		envVar: "MISTRAL_API_KEY",
	},
	{
		id: "openai-codex",
		name: "ChatGPT (Codex)",
		description: "Use your ChatGPT Plus/Pro subscription",
		keyUrl: "https://chatgpt.com",
		envVar: "",
		subscription: { oauthProviderId: "openai-codex", label: "Log in with ChatGPT Plus / Pro" },
		cliLogin: { read: "codex", label: "Use your existing Codex login" },
	},
	{
		id: "github-copilot",
		name: "GitHub Copilot",
		description: "Use your Copilot subscription ($10/mo, multi-model)",
		keyUrl: "https://github.com/settings/copilot",
		envVar: "",
		subscription: { oauthProviderId: "github-copilot", label: "Log in with GitHub Copilot" },
	},
	{
		id: "glm",
		name: "GLM (Z.ai)",
		description: "Use your Z.ai GLM coding-plan key",
		keyUrl: "https://z.ai/manage-apikey/apikey-list",
		envVar: "",
		custom: true,
		api: "anthropic-messages",
		baseUrl: "https://api.z.ai/api/anthropic",
		models: ["glm-5.2", "glm-4.7", "glm-4.5-air"],
	},
	{
		id: "kimi",
		name: "Kimi (Moonshot)",
		description: "Use your Moonshot / Kimi key",
		keyUrl: "https://platform.moonshot.ai/console/api-keys",
		envVar: "",
		custom: true,
		api: "anthropic-messages",
		baseUrl: "https://api.moonshot.ai/anthropic",
		models: ["kimi-k2.7-code", "kimi-k2.6"],
	},
	{
		id: "qwen",
		name: "Qwen (DashScope)",
		description: "Use your Alibaba DashScope key",
		keyUrl: "https://bailian.console.alibabacloud.com",
		envVar: "",
		custom: true,
		api: "anthropic-messages",
		baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
		models: ["qwen3-coder-plus", "qwen3-coder-next"],
	},
	{
		id: "minimax-sub",
		name: "MiniMax (coding plan)",
		description: "Use your MiniMax key",
		keyUrl: "https://platform.minimax.io",
		envVar: "",
		custom: true,
		api: "anthropic-messages",
		baseUrl: "https://api.minimax.io/anthropic",
		models: ["MiniMax-M2.7", "MiniMax-M3"],
	},
	{
		id: "deepseek-sub",
		name: "DeepSeek (coding plan)",
		description: "Use your DeepSeek key",
		keyUrl: "https://platform.deepseek.com/api_keys",
		envVar: "",
		custom: true,
		api: "anthropic-messages",
		baseUrl: "https://api.deepseek.com/anthropic",
		models: ["deepseek-v4-flash", "deepseek-v4-pro"],
	},
	{
		id: "nvidia-nim",
		name: "NVIDIA NIM",
		description: "NVIDIA-hosted open models (Llama, DeepSeek, Nemotron, Qwen…) — live catalog",
		keyUrl: "https://build.nvidia.com",
		envVar: "NVIDIA_API_KEY",
		envVarFallbacks: ["NVIDIA_NIM_API_KEY", "NGC_API_KEY"],
		custom: true,
		liveModels: true, // models fetched live from /v1/models at onboarding
		api: "openai-completions",
		baseUrl: "https://integrate.api.nvidia.com/v1",
	},
	{
		id: "ollama",
		name: "Ollama (local)",
		description: "Run models locally — no API key, fully private",
		keyUrl: "https://ollama.com/download",
		envVar: "", // no env key
		noAuth: true,
		local: true,
		baseUrl: "http://127.0.0.1:11434",
	},
	{
		id: "custom",
		name: "Custom (OpenAI-compatible)",
		description: "Together, Fireworks, vLLM, LM Studio — any OpenAI-compatible endpoint",
		keyUrl: "—",
		envVar: "",
		custom: true,
	},
];

export function findProvider(id: string): ProviderInfo | undefined {
	return PROVIDERS.find((p) => p.id === id);
}

/**
 * Whether onboarding routes a picked provider through `ensureCustomProvider`
 * (which writes `models.json` so the model resolves at gateway boot) instead of
 * the plain API-key path. ANY `custom` catalog entry routes here — including the
 * generic "Custom (OpenAI-compatible)" entry that has NO pre-set `baseUrl` (its
 * URL is prompted for). The old gate also required `baseUrl`, which wrongly
 * excluded the generic entry and left its model unresolvable at boot. Kept here
 * (not in onboarding.ts) so tests assert the REAL predicate the gate uses
 * without importing the TUI module — see onboarding-custom-url.test.ts.
 */
export function routesToCustomProvider(p: ProviderInfo | undefined): p is ProviderInfo & { custom: true } {
	return !!p?.custom;
}

/**
 * Look for the provider's API key across `envVar` and any `envVarFallbacks`,
 * in order. Returns the first non-empty value found, or `undefined` if none
 * are set. Used by the onboard auto-select shortcut and the provider picker's
 * "detected" badge — they need to recognise users who have the OAuth token
 * exported (Anthropic CLI subscriptions) just as readily as the standard
 * API-key env var.
 *
 * Pi's own `getEnvApiKey` only consults the primary env var per provider;
 * this helper is the Brigade-side extension that surfaces the fallbacks.
 */
export function readProviderEnvKey(provider: ProviderInfo): string | undefined {
	return resolveProviderEnvVarSource(provider)?.value;
}

/**
 * Like `readProviderEnvKey` but returns BOTH the value AND the env var name
 * that satisfied the read. Critical for `--secret-input-mode ref` — the keyRef
 * persisted to disk must point at the env var that ACTUALLY held the value,
 * not blindly at `provider.envVar`. Otherwise, when a user is authed via a
 * fallback (e.g. `ANTHROPIC_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY`), the
 * stored `keyRef.id = "ANTHROPIC_API_KEY"` resolves to undefined at runtime
 * and the credential silently disappears.
 */
export function resolveProviderEnvVarSource(
	provider: ProviderInfo,
): { name: string; value: string } | undefined {
	const primary = provider.envVar;
	if (primary) {
		const v = process.env[primary];
		if (typeof v === "string" && v.trim().length > 0) return { name: primary, value: v };
	}
	for (const fallback of provider.envVarFallbacks ?? []) {
		const v = process.env[fallback];
		if (typeof v === "string" && v.trim().length > 0) return { name: fallback, value: v };
	}
	return undefined;
}
