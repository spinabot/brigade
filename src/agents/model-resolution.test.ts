import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	ANTHROPIC_SUBSCRIPTION_CONTEXT_WINDOW,
	billingSafeContextWindow,
	resolveModelNeverMiss,
} from "./model-resolution.js";

/**
 * A template Pi-shaped model for a provider — what `getAvailable()` would
 * return. The resolver clones this (api/baseUrl/provider) when synthesizing an
 * uncatalogued id. `baseUrl` is left undefined so the cloud-discovery step
 * makes NO network call (discoverCloudModelMeta returns EMPTY for a
 * non-openrouter provider with no baseUrl) — keeping these tests offline.
 */
function templateModel(provider: string) {
	return {
		provider,
		id: "catalogued-model",
		name: "Catalogued Model",
		api: "openai-completions",
		contextWindow: 131072,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 5, output: 10, cacheRead: 1, cacheWrite: 2 },
	};
}

function fakeRegistry(opts: { available?: unknown[]; findResult?: unknown }) {
	return {
		find: () => opts.findResult,
		getAvailable: () => opts.available ?? [],
		refresh: () => {},
	};
}

describe("resolveModelNeverMiss — synthesize from a provider template", () => {
	it("clones the template's transport (api) and zeroes cost for the new id", async () => {
		const registry = fakeRegistry({ available: [templateModel("groq")] });
		const model = (await resolveModelNeverMiss({
			modelRegistry: registry,
			provider: "groq",
			modelId: "some-new-groq-model",
			modelsFile: "/does/not/exist.json",
		})) as Record<string, unknown>;

		assert.ok(model, "expected a synthesized model, not undefined");
		assert.equal(model.id, "some-new-groq-model");
		assert.equal(model.name, "some-new-groq-model");
		assert.equal(model.provider, "groq");
		assert.equal(model.api, "openai-completions", "inherits transport from template");
		// Cost is per-model + unknown for a synth → zeroed, NOT the template's.
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// Context window falls back to the template's when discovery yields none.
		assert.equal(model.contextWindow, 131072);
	});

	it("applies the reasoning heuristic to the synthesized id", async () => {
		const registry = fakeRegistry({ available: [templateModel("openrouter-x")] });
		// `deepseek-r1*` matches isLikelyReasoningModelId → reasoning:true.
		const model = (await resolveModelNeverMiss({
			modelRegistry: registry,
			provider: "openrouter-x",
			modelId: "deepseek-r1-zzz",
			modelsFile: "/does/not/exist.json",
		})) as Record<string, unknown>;
		assert.equal(model.reasoning, true);
	});

	it("returns undefined when there is no template AND no provider config (legitimate miss)", async () => {
		const registry = fakeRegistry({ available: [] });
		const model = await resolveModelNeverMiss({
			modelRegistry: registry,
			provider: "totally-unknown",
			modelId: "whatever",
			modelsFile: "/does/not/exist.json",
		});
		assert.equal(model, undefined);
	});
});

describe("resolveModelNeverMiss — synthesize from a configured custom provider", () => {
	let tmpFile: string;
	beforeEach(() => {
		tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brigade-models-")), "models.json");
	});
	afterEach(() => {
		try {
			fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("builds a model from a models.json provider block when no template exists", async () => {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify({
				providers: {
					myhost: { baseUrl: "http://my-host:8000/v1", api: "openai-completions", apiKey: "x" },
				},
			}),
			"utf8",
		);
		const registry = fakeRegistry({ available: [] }); // no built-in template
		const model = (await resolveModelNeverMiss({
			modelRegistry: registry,
			provider: "myhost",
			modelId: "my-served-model",
			modelsFile: tmpFile,
		})) as Record<string, unknown>;

		assert.ok(model, "expected a config-synthesized model");
		assert.equal(model.id, "my-served-model");
		assert.equal(model.provider, "myhost");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, "http://my-host:8000/v1");
	});
});

describe("resolveModelNeverMiss — static hit short-circuits", () => {
	it("returns the registry's model without synthesizing", async () => {
		const real = { provider: "anthropic", id: "claude-opus-4-7", api: "anthropic-messages" };
		const registry = fakeRegistry({ findResult: real });
		const model = await resolveModelNeverMiss({
			modelRegistry: registry,
			provider: "anthropic",
			modelId: "claude-opus-4-7",
			modelsFile: "/does/not/exist.json",
		});
		assert.strictEqual(model, real);
	});
});

describe("billingSafeContextWindow — never draw extra-usage credits on a subscription", () => {
	it("clamps a >200K window to the included tier for an Anthropic subscription", () => {
		// claude-opus-4-8 ships a 1,000,000 window; on a subscription that must be
		// sized as 200K so compaction fires before the long-context / extra-usage
		// boundary.
		assert.strictEqual(
			billingSafeContextWindow("anthropic", 1_000_000, true),
			ANTHROPIC_SUBSCRIPTION_CONTEXT_WINDOW,
		);
		assert.strictEqual(billingSafeContextWindow("anthropic", 1_000_000, true), 200_000);
	});

	it("leaves a subscription's already-small window untouched", () => {
		// A 200K (or smaller) model is already inside the included tier.
		assert.strictEqual(billingSafeContextWindow("anthropic", 200_000, true), 200_000);
		assert.strictEqual(billingSafeContextWindow("anthropic", 128_000, true), 128_000);
	});

	it("does NOT clamp an API key — pay-per-token has no extra-usage concept", () => {
		// An operator paying per token keeps the full 1M window if they want it.
		assert.strictEqual(billingSafeContextWindow("anthropic", 1_000_000, false), 1_000_000);
	});

	it("passes through subscription providers absent from the included-window table", () => {
		// Table-driven: a provider is clamped ONLY once its context-overage
		// boundary is confirmed and added to SUBSCRIPTION_INCLUDED_CONTEXT_WINDOW.
		// Providers not in the table (rate/quota-limited subscriptions, not
		// context-overage-billed) are passed through unchanged.
		assert.strictEqual(billingSafeContextWindow("openai", 1_000_000, true), 1_000_000);
		assert.strictEqual(billingSafeContextWindow("google", 2_000_000, true), 2_000_000);
	});

	it("passes an undefined window through unchanged", () => {
		assert.strictEqual(billingSafeContextWindow("anthropic", undefined, true), undefined);
	});
});
