import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	findProvider,
	PROVIDERS,
	readProviderEnvKey,
	resolveProviderEnvVarSource,
} from "./catalog.js";

// Snapshot + restore the env vars we mutate so tests can run in any order
// without leaking state across tests OR back into the parent process.
const ENV_KEYS_TO_GUARD = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"MISTRAL_API_KEY",
];

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS_TO_GUARD) {
		originalEnv[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of ENV_KEYS_TO_GUARD) {
		if (originalEnv[k] !== undefined) process.env[k] = originalEnv[k];
		else delete process.env[k];
	}
});

describe("catalog — env-key detection works for every cloud provider", () => {
	// All cloud providers whose env-confirm prompt the wizard fires for.
	// Ollama + custom are excluded (no API key in env, by design).
	const CLOUD_PROVIDERS_WITH_ENV: Array<{ id: string; envVar: string }> = [
		{ id: "anthropic", envVar: "ANTHROPIC_API_KEY" },
		{ id: "openai", envVar: "OPENAI_API_KEY" },
		{ id: "google", envVar: "GEMINI_API_KEY" },
		{ id: "openrouter", envVar: "OPENROUTER_API_KEY" },
		{ id: "groq", envVar: "GROQ_API_KEY" },
		{ id: "cerebras", envVar: "CEREBRAS_API_KEY" },
		{ id: "xai", envVar: "XAI_API_KEY" },
		{ id: "deepseek", envVar: "DEEPSEEK_API_KEY" },
		{ id: "mistral", envVar: "MISTRAL_API_KEY" },
	];

	for (const { id, envVar } of CLOUD_PROVIDERS_WITH_ENV) {
		it(`detects ${envVar} for provider "${id}"`, () => {
			const provider = findProvider(id);
			assert.ok(provider, `provider ${id} missing from catalog`);
			assert.equal(
				provider!.envVar,
				envVar,
				`catalog has ${id}.envVar = ${provider!.envVar}, expected ${envVar}`,
			);
			// Empty env → undefined.
			assert.equal(readProviderEnvKey(provider!), undefined);
			assert.equal(resolveProviderEnvVarSource(provider!), undefined);
			// Set env → readProviderEnvKey returns value, resolveProviderEnvVarSource
			// returns matched name + value.
			process.env[envVar] = `test-${id}-key-12345`;
			assert.equal(readProviderEnvKey(provider!), `test-${id}-key-12345`);
			assert.deepEqual(resolveProviderEnvVarSource(provider!), {
				name: envVar,
				value: `test-${id}-key-12345`,
			});
		});
	}

	it("Anthropic falls back to ANTHROPIC_OAUTH_TOKEN when ANTHROPIC_API_KEY is unset", () => {
		const anthropic = findProvider("anthropic")!;
		assert.deepEqual(anthropic.envVarFallbacks, ["ANTHROPIC_OAUTH_TOKEN"]);
		// Only fallback set.
		process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oauth-test";
		assert.equal(readProviderEnvKey(anthropic), "sk-ant-oauth-test");
		assert.deepEqual(resolveProviderEnvVarSource(anthropic), {
			name: "ANTHROPIC_OAUTH_TOKEN",
			value: "sk-ant-oauth-test",
		});
	});

	it("Anthropic primary API key wins over OAuth fallback", () => {
		const anthropic = findProvider("anthropic")!;
		process.env.ANTHROPIC_API_KEY = "sk-ant-primary";
		process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-fallback";
		assert.equal(readProviderEnvKey(anthropic), "sk-ant-primary");
		assert.deepEqual(resolveProviderEnvVarSource(anthropic), {
			name: "ANTHROPIC_API_KEY",
			value: "sk-ant-primary",
		});
	});

	it("Ollama has no envVar (noAuth, local)", () => {
		const ollama = findProvider("ollama")!;
		assert.equal(ollama.envVar, "");
		assert.equal(ollama.noAuth, true);
		assert.equal(ollama.local, true);
		// Ollama's "env" is its base URL — no API key in process.env.
		assert.equal(readProviderEnvKey(ollama), undefined);
	});

	it("Custom provider has no envVar (user-provided)", () => {
		const custom = findProvider("custom")!;
		assert.equal(custom.envVar, "");
		assert.equal(custom.custom, true);
		assert.equal(readProviderEnvKey(custom), undefined);
	});

	it("readProviderEnvKey ignores whitespace-only env values", () => {
		const openrouter = findProvider("openrouter")!;
		process.env.OPENROUTER_API_KEY = "   ";
		assert.equal(readProviderEnvKey(openrouter), undefined);
		assert.equal(resolveProviderEnvVarSource(openrouter), undefined);
	});

	it("Catalog covers every provider id we expect (regression guard)", () => {
		const ids = PROVIDERS.map((p) => p.id).sort();
		assert.deepEqual(ids, [
			"anthropic",
			"cerebras",
			"claude-cli",
			"claude-code",
			"custom",
			"deepseek",
			"deepseek-sub",
			"github-copilot",
			"glm",
			"google",
			"groq",
			"kimi",
			"minimax-sub",
			"mistral",
			"nvidia-nim",
			"ollama",
			"openai",
			"openai-codex",
			"openrouter",
			"qwen",
			"xai",
		]);
	});
});
