/**
 * Focused test for `modelSupportsImageInput` — the helper that reads the
 * resolved Pi `Model.input` to populate `analyze_media`'s authoritative
 * `imageInput` capability flag (fix for the text-only-vs-vision routing).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { modelSupportsImageInput, resolveInboundImagePrompt } from "./agent-loop.js";

describe("modelSupportsImageInput", () => {
	it("true when input includes image", () => {
		assert.equal(modelSupportsImageInput({ input: ["text", "image"] }), true);
	});
	it("false when input is text-only", () => {
		assert.equal(modelSupportsImageInput({ input: ["text"] }), false);
	});
	it("undefined when input is missing / not an array (unknown → fall back to heuristic)", () => {
		assert.equal(modelSupportsImageInput({}), undefined);
		assert.equal(modelSupportsImageInput({ input: "image" }), undefined);
		assert.equal(modelSupportsImageInput(null), undefined);
		assert.equal(modelSupportsImageInput(undefined), undefined);
	});
});

describe("resolveInboundImagePrompt — A3 multimodal gate", () => {
	const visionModel = { input: ["text", "image"] };
	const textModel = { input: ["text"] };
	const img = { data: "QUJD", mimeType: "image/png" };

	it("attaches images as Pi ImageContent on a VISION model", () => {
		const opts = resolveInboundImagePrompt(visionModel, [img]);
		assert.ok(opts, "vision model + images → prompt options present");
		assert.equal(opts.images.length, 1);
		assert.deepEqual(opts.images[0], { type: "image", data: "QUJD", mimeType: "image/png" });
	});

	it("maps EVERY block + preserves order", () => {
		const opts = resolveInboundImagePrompt(visionModel, [
			{ data: "AAA", mimeType: "image/png" },
			{ data: "BBB", mimeType: "image/jpeg" },
		]);
		assert.equal(opts?.images.length, 2);
		assert.equal(opts?.images[0]?.data, "AAA");
		assert.equal(opts?.images[1]?.mimeType, "image/jpeg");
		// Every block carries the literal Pi tag.
		assert.ok(opts?.images.every((b) => b.type === "image"));
	});

	it("returns undefined on a TEXT-ONLY model (→ string prompt, image falls back to the note)", () => {
		assert.equal(resolveInboundImagePrompt(textModel, [img]), undefined);
	});

	it("returns undefined when the model capability is UNKNOWN (no `input` array)", () => {
		// Unknown ≠ vision — be conservative and take the string path.
		assert.equal(resolveInboundImagePrompt({}, [img]), undefined);
		assert.equal(resolveInboundImagePrompt(null, [img]), undefined);
	});

	it("returns undefined when there are NO images (→ byte-identical string prompt)", () => {
		assert.equal(resolveInboundImagePrompt(visionModel, undefined), undefined);
		assert.equal(resolveInboundImagePrompt(visionModel, []), undefined);
	});
});
