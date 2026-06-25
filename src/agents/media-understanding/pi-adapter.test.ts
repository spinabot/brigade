/**
 * Tests for the Pi-SDK media-understanding adapter (the general image path that
 * makes EVERY configured provider work, not just google/anthropic). Image-only:
 * Pi carries no audio block, so audio is Gemini's job (see index.ts).
 *
 * The actual model call (`completeSimple`) is injected as `cfg.piComplete`, so
 * no real model traffic happens. Model resolution is injected via
 * `cfg.resolveModel` + `cfg.listKeyedProviders`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolvePiModel, runPi, modelAcceptsImage } from "./pi-adapter.js";
import {
	MediaUnderstandingProviderError,
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingModel,
	type PiCompleteRequest,
} from "./types.js";

/** An image-capable model for `provider`. */
function imageModel(provider: string, id = `${provider}-vision`): MediaUnderstandingModel {
	return { provider, id, input: ["text", "image"] };
}

/** A text-only (no image) model for `provider`. */
function textModel(provider: string, id = `${provider}-text`): MediaUnderstandingModel {
	return { provider, id, input: ["text"] };
}

/**
 * Build a config wired for the Pi path:
 *   - `keys`: provider→key map (resolveKey).
 *   - `models`: provider→model map (resolveModel); a missing provider yields none.
 *   - `keyed`: listKeyedProviders order.
 *   - `complete`: the piComplete stub (records the request).
 */
function piCfg(opts: {
	keys?: Record<string, string>;
	models?: Record<string, MediaUnderstandingModel>;
	keyed?: string[];
	complete?: (req: PiCompleteRequest) => Promise<string>;
}): { cfg: MediaUnderstandingConfig; calls: PiCompleteRequest[] } {
	const calls: PiCompleteRequest[] = [];
	const cfg: MediaUnderstandingConfig = {
		resolveKey: (p) => opts.keys?.[p] ?? "",
		resolveModel: (provider) => (provider ? opts.models?.[provider] : undefined),
		listKeyedProviders: () => opts.keyed ?? [],
		piComplete: async (req) => {
			calls.push(req);
			return (opts.complete ? await opts.complete(req) : "stub description");
		},
	};
	return { cfg, calls };
}

describe("pi-adapter — modelAcceptsImage", () => {
	it("true only when input includes image", () => {
		assert.equal(modelAcceptsImage(imageModel("openai")), true);
		assert.equal(modelAcceptsImage(textModel("openai")), false);
		assert.equal(modelAcceptsImage(undefined), false);
		assert.equal(modelAcceptsImage({ provider: "x", id: "y" }), false);
	});
});

describe("pi-adapter — resolvePiModel", () => {
	it("returns undefined when resolveModel is absent (Pi path unwired)", () => {
		const cfg: MediaUnderstandingConfig = { resolveKey: () => "k" };
		assert.equal(resolvePiModel("image", cfg), undefined);
	});

	it("picks the first keyed provider with an image-capable model", () => {
		const { cfg } = piCfg({
			models: { groq: textModel("groq"), openai: imageModel("openai") },
			keyed: ["groq", "openai"], // groq first but it has no image model
		});
		const m = resolvePiModel("image", cfg);
		assert.equal(m?.provider, "openai");
	});

	it("honors an explicit provider override", () => {
		const { cfg } = piCfg({
			models: { openai: imageModel("openai"), openrouter: imageModel("openrouter") },
			keyed: ["openai", "openrouter"],
		});
		assert.equal(resolvePiModel("image", cfg, "openrouter")?.provider, "openrouter");
		// Override to a provider with no image model → undefined.
		assert.equal(resolvePiModel("image", piCfg({ models: { x: textModel("x") } }).cfg, "x"), undefined);
	});

	it("returns undefined when no keyed provider has an image model", () => {
		const { cfg } = piCfg({ models: { groq: textModel("groq") }, keyed: ["groq"] });
		assert.equal(resolvePiModel("image", cfg), undefined);
	});

	it("requires image input for EVERY kind (Pi has no audio block)", () => {
		const { cfg } = piCfg({ models: { openai: textModel("openai") }, keyed: ["openai"] });
		// A text-only model is rejected regardless of kind — the Pi path can only
		// carry an image block, so audio cannot smuggle a non-image model through
		// (which would 400 at the provider). Audio normally never reaches here
		// anyway (its provider chain excludes `pi`); this is the defensive gate.
		assert.equal(resolvePiModel("image", cfg), undefined);
		assert.equal(resolvePiModel("audio", cfg), undefined);
	});
});

describe("pi-adapter — runPi", () => {
	it("runs a one-shot completion and returns the text + pi provider tag", async () => {
		const { cfg, calls } = piCfg({
			keys: { openai: "sk-openai" },
			models: { openai: imageModel("openai", "gpt-4o") },
			keyed: ["openai"],
			complete: async () => "A red bicycle leaning on a wall.",
		});
		const res = await runPi({
			kind: "image",
			bytes: Buffer.from([1, 2, 3]),
			mimeType: "image/png",
			cfg,
			prompt: "what is this?",
		});
		assert.equal(res.provider, "pi");
		assert.equal(res.model, "openai/gpt-4o");
		assert.equal(res.text, "A red bicycle leaning on a wall.");
		// The stub saw the resolved key + the prompt + the bytes.
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.apiKey, "sk-openai");
		assert.equal(calls[0]?.prompt, "what is this?");
		assert.equal(calls[0]?.mimeType, "image/png");
	});

	it("throws Unavailable when no capable model resolves", async () => {
		const { cfg } = piCfg({ models: {}, keyed: [] });
		await assert.rejects(
			() => runPi({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", cfg }),
			(err: unknown) => err instanceof MediaUnderstandingUnavailableError,
		);
	});

	it("wraps a piComplete throw in a provider error", async () => {
		const { cfg } = piCfg({
			keys: { openai: "k" },
			models: { openai: imageModel("openai") },
			keyed: ["openai"],
			complete: async () => {
				throw new Error("HTTP 500 upstream");
			},
		});
		await assert.rejects(
			() => runPi({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", cfg }),
			(err: unknown) =>
				err instanceof MediaUnderstandingProviderError && /HTTP 500 upstream/.test(err.message),
		);
	});

	it("treats an empty model answer as a provider error", async () => {
		const { cfg } = piCfg({
			keys: { openai: "k" },
			models: { openai: imageModel("openai") },
			keyed: ["openai"],
			complete: async () => "   ",
		});
		await assert.rejects(
			() => runPi({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", cfg }),
			(err: unknown) =>
				err instanceof MediaUnderstandingProviderError && /returned no text/i.test(err.message),
		);
	});

	it("tolerates a keyless local provider (empty apiKey passes through)", async () => {
		const { cfg, calls } = piCfg({
			keys: {}, // ollama is keyless → resolveKey returns ""
			models: { ollama: imageModel("ollama", "llava") },
			keyed: ["ollama"],
			complete: async () => "local vision output",
		});
		const res = await runPi({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", cfg });
		assert.equal(res.text, "local vision output");
		assert.equal(calls[0]?.apiKey, "");
	});
});
