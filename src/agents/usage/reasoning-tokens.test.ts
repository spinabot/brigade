/**
 * One number, five provider spellings. Getting this wrong does not throw — it
 * silently reports "no reasoning" for a turn that reasoned, which is why the
 * figure appeared on one transport and nowhere else for so long.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractReasoningTokens } from "./reasoning-tokens.js";

test("Anthropic: output_tokens_details.thinking_tokens", () => {
	assert.equal(extractReasoningTokens({ output_tokens_details: { thinking_tokens: 400 } }), 400);
});

test("OpenAI and every API that copied its schema (OpenRouter included)", () => {
	assert.equal(
		extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 6126 } }),
		6126,
	);
});

test("Google Gemini: thoughtsTokenCount, flat or under usageMetadata", () => {
	assert.equal(extractReasoningTokens({ thoughtsTokenCount: 91 }), 91);
	assert.equal(extractReasoningTokens({ usageMetadata: { thoughtsTokenCount: 91 } }), 91);
});

test("flat spellings used by local runtimes", () => {
	assert.equal(extractReasoningTokens({ reasoning_tokens: 12 }), 12);
	assert.equal(extractReasoningTokens({ thinking_tokens: 13 }), 13);
});

test("already-normalised input round-trips", () => {
	assert.equal(extractReasoningTokens({ reasoningTokens: 77 }), 77);
});

test("NOT REPORTED is undefined, never zero", () => {
	// The distinction the whole subsystem rests on: "the provider said nothing"
	// and "the model did not reason" are different facts, and printing 0 for the
	// first asserts a measurement nobody took.
	assert.equal(extractReasoningTokens({ input: 10, output: 5 }), undefined);
	assert.equal(extractReasoningTokens({}), undefined);
	assert.equal(extractReasoningTokens(undefined), undefined);
	assert.equal(extractReasoningTokens(null), undefined);
});

test("a genuine zero is preserved", () => {
	// Anthropic reports 0 for an easy prompt at high effort — that IS a
	// measurement, and it means "the model chose not to think".
	assert.equal(extractReasoningTokens({ output_tokens_details: { thinking_tokens: 0 } }), 0);
});

test("numeric strings are accepted; junk is not", () => {
	assert.equal(extractReasoningTokens({ reasoning_tokens: "128" }), 128);
	for (const junk of [{ reasoning_tokens: "abc" }, { reasoning_tokens: -5 }, { reasoning_tokens: Number.NaN }]) {
		assert.equal(extractReasoningTokens(junk), undefined, JSON.stringify(junk));
	}
});

test("malformed shapes never throw on the usage path", () => {
	for (const junk of [0, "", [], { output_tokens_details: 5 }, { completion_tokens_details: null }]) {
		assert.doesNotThrow(() => extractReasoningTokens(junk));
	}
});
