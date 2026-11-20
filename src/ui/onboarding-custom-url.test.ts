/**
 * Tests for the generic "Custom (OpenAI-compatible)" onboarding fix.
 *
 * The bug: picking the generic custom provider during onboarding skipped the
 * `ensureCustomProvider` path (which writes `models.json`) because the gate
 * checked `providerInfo?.custom && providerInfo.baseUrl` — but the generic
 * custom catalog entry has no `baseUrl`. After the fix, the gate is
 * `routesToCustomProvider(providerInfo)`, and `ensureCustomProvider` prompts
 * for the URL when it's absent.
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

import { findProvider, routesToCustomProvider } from "../providers/catalog.js";
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

		it("routesToCustomProvider() — the REAL onboarding gate — matches the generic entry", () => {
			// Guards the ACTUAL predicate the provider gate calls (onboarding.ts:323),
			// not a re-implemented copy. The old condition (`custom && baseUrl`)
			// excluded the generic entry (no baseUrl); the fix widened it to `custom`.
			// If someone reverts `routesToCustomProvider` to require baseUrl, this fails.
			const generic = findProvider("custom");
			assert.ok(generic);
			assert.ok(!generic.baseUrl, "the generic custom entry has no baseUrl");
			assert.ok(
				routesToCustomProvider(generic),
				"the generic custom provider (no baseUrl) must route to ensureCustomProvider",
			);
			// A named custom (has baseUrl) still routes here — unchanged behavior.
			const named = findProvider("nvidia-nim") ?? findProvider("glm");
			assert.ok(named && routesToCustomProvider(named), "named customs still route to ensureCustomProvider");
			// A non-custom provider uses the plain key path, NOT ensureCustomProvider.
			const nonCustom = findProvider("anthropic");
			assert.ok(nonCustom && !routesToCustomProvider(nonCustom), "non-custom providers must not route here");
		});

		it("OpenDesign Go uses the existing custom flow with live workspace models", () => {
			const provider = findProvider("opendesign-go");
			assert.ok(provider);
			assert.ok(routesToCustomProvider(provider));
			assert.equal(provider.baseUrl, "https://amr-link.open-design.ai/v1");
			assert.equal(provider.api, "openai-completions");
			assert.equal(provider.liveModels, true);
			assert.equal(provider.billing, "subscription");
			assert.equal(provider.subscription, undefined, "API-key setup must not trigger OAuth");
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
