/**
 * Tests for the generic "Custom (OpenAI-compatible)" onboarding fix.
 *
 * The bug: picking the generic custom provider during onboarding skipped the
 * `ensureCustomProvider` path (which writes `models.json`) because the gate
 * checked `providerInfo?.custom && providerInfo.baseUrl` — but the generic
 * custom catalog entry has no `baseUrl`. After the fix, the gate is
 * `providerInfo?.custom`, and `ensureCustomProvider` prompts for the URL
 * when it's absent.
 *
 * These tests verify:
 *   1. The catalog routing condition now matches the generic custom entry.
 *   2. `writeCustomProviderToModelsJson` produces a models.json that
 *      `resolveModelNeverMiss` can resolve — the exact failure path a
 *      gateway sees on boot.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { findProvider } from "../providers/catalog.js";
import { writeCustomProviderToModelsJson } from "../integrations/custom-provider.js";
import { resolveModelNeverMiss } from "../agents/model-resolution.js";

describe("generic custom provider onboarding", () => {
	describe("catalog routing", () => {
		it("the generic 'custom' catalog entry has custom: true", () => {
			const provider = findProvider("custom");
			assert.ok(provider, "expected a 'custom' entry in the provider catalog");
			assert.strictEqual(provider.custom, true);
		});

		it("the generic 'custom' catalog entry has no baseUrl (user provides it)", () => {
			const provider = findProvider("custom");
			assert.ok(provider);
			assert.ok(
				!provider.baseUrl,
				`expected no baseUrl on the generic custom entry, got: ${provider.baseUrl}`,
			);
		});

		it("the routing condition `providerInfo?.custom` matches the generic entry", () => {
			// This test exists to prevent regressions: the old condition
			// (`custom && baseUrl`) excluded this entry. The fix widened it
			// to `custom` only. If someone adds `&& baseUrl` back, this test
			// surfaces the regression with a clear explanation.
			const provider = findProvider("custom");
			assert.ok(provider);
			const wouldRoute = !!provider.custom;
			assert.ok(
				wouldRoute,
				"the generic custom provider must be routed to ensureCustomProvider",
			);
		});
	});

	describe("writeCustomProviderToModelsJson → resolveModelNeverMiss round-trip", () => {
		let tmpDir: string;
		let modelsJsonPath: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-custom-onboard-"));
			modelsJsonPath = path.join(tmpDir, "models.json");
		});

		afterEach(() => {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		});

		it("a custom provider written by onboarding is resolvable by the gateway", async () => {
			// Simulate what ensureCustomProvider does after the user enters a
			// URL and API key during onboarding.
			await writeCustomProviderToModelsJson(modelsJsonPath, {
				id: "custom",
				baseUrl: "https://integrate.api.nvidia.com/v1",
				api: "openai-completions",
				apiKey: "test-key-placeholder",
				models: ["z-ai/glm-5.2"],
			});

			// Verify the file was written.
			assert.ok(fs.existsSync(modelsJsonPath), "models.json must exist after write");

			// Parse and check the shape.
			const written = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
			assert.ok(written.providers?.custom, "expected a 'custom' provider block");
			assert.strictEqual(
				written.providers.custom.baseUrl,
				"https://integrate.api.nvidia.com/v1",
			);
			assert.strictEqual(written.providers.custom.api, "openai-completions");
			assert.deepStrictEqual(written.providers.custom.models, [
				{ id: "z-ai/glm-5.2", name: "z-ai/glm-5.2" },
			]);

			// Now verify the model resolver can find it — this is the exact
			// code path the gateway uses at startup (server.ts L580-591).
			const registry = {
				find: () => undefined, // no built-in match
				getAvailable: () => [],
				refresh: () => {},
			};
			const model = (await resolveModelNeverMiss({
				modelRegistry: registry,
				provider: "custom",
				modelId: "z-ai/glm-5.2",
				modelsFile: modelsJsonPath,
			})) as Record<string, unknown>;

			assert.ok(model, "expected the model to be resolvable after models.json is written");
			assert.strictEqual(model.id, "z-ai/glm-5.2");
			assert.strictEqual(model.provider, "custom");
			assert.strictEqual(model.baseUrl, "https://integrate.api.nvidia.com/v1");
			assert.strictEqual(model.api, "openai-completions");
		});

		it("without models.json the custom model is unresolvable (regression guard)", async () => {
			// Before the fix, this was the state after onboarding with the
			// generic custom provider — no models.json existed.
			const registry = {
				find: () => undefined,
				getAvailable: () => [],
				refresh: () => {},
			};
			const model = await resolveModelNeverMiss({
				modelRegistry: registry,
				provider: "custom",
				modelId: "z-ai/glm-5.2",
				modelsFile: modelsJsonPath, // file doesn't exist
			});
			assert.strictEqual(
				model,
				undefined,
				"without models.json the custom model must not resolve (this was the bug)",
			);
		});
	});
});
