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
	/** Display name shown in the picker. */
	name: string;
	/** One-line tagline for the picker description column. */
	description: string;
	/** Where to grab an API key, or install instructions for local providers. */
	keyUrl: string;
	/** Env var Pi will auto-detect (matches Pi's findEnvKeys). Empty for local providers. */
	envVar: string;
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
}

export const PROVIDERS: ProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		description: "Claude — best for tool use & long context",
		keyUrl: "https://console.anthropic.com/settings/keys",
		envVar: "ANTHROPIC_API_KEY",
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
		id: "ollama",
		name: "Ollama (local)",
		description: "Run models locally — no API key, fully private",
		keyUrl: "https://ollama.com/download",
		envVar: "", // no env key
		noAuth: true,
		local: true,
		baseUrl: "http://localhost:11434",
	},
	{
		id: "custom",
		name: "Custom (OpenAI-compatible)",
		description: "Together, Fireworks, vLLM, LM Studio, any /v1/chat/completions endpoint",
		keyUrl: "—",
		envVar: "",
		custom: true,
	},
];

export function findProvider(id: string): ProviderInfo | undefined {
	return PROVIDERS.find((p) => p.id === id);
}
