import assert from "node:assert/strict";
import { test } from "node:test";

import {
	describeReasoningVisibility,
	hasReadableReasoning,
	initialReasoningVisibility,
	refineReasoningVisibility,
} from "./visibility.js";

test("Anthropic is summary, never raw", () => {
	// Vendor docs: "the text in a thinking block is a summary of Claude's
	// reasoning" and no setting returns the raw chain of thought. Labelling it
	// as the model's own thinking is a misrepresentation.
	for (const p of ["anthropic", "claude-cli", "claude-code", "amazon-bedrock", "google-vertex"]) {
		assert.equal(initialReasoningVisibility({ provider: p }), "summary", p);
	}
});

test("OpenAI hosted reasoning models are summary; gpt-oss is raw", () => {
	assert.equal(initialReasoningVisibility({ provider: "openai" }), "summary");
	assert.equal(initialReasoningVisibility({ provider: "openai", modelId: "gpt-5.2" }), "summary");
	// gpt-oss returns raw CoT wherever it is served from.
	assert.equal(initialReasoningVisibility({ provider: "openai", modelId: "gpt-oss-120b" }), "raw");
	assert.equal(initialReasoningVisibility({ provider: "groq", modelId: "gpt-oss-20b" }), "raw");
	assert.equal(initialReasoningVisibility({ provider: "ollama", modelId: "gpt-oss:20b" }), "raw");
});

test("providers documented as returning the model's own reasoning are raw", () => {
	for (const p of ["deepseek", "qwen", "ollama", "groq"]) {
		assert.equal(initialReasoningVisibility({ provider: p }), "raw", p);
	}
});

test("an unknown provider defaults to summary, not raw", () => {
	// Understating fidelity is a smaller error than telling the operator they
	// are reading actual chain-of-thought when they are reading a paraphrase.
	assert.equal(initialReasoningVisibility({ provider: "some-new-vendor" }), "summary");
	assert.equal(initialReasoningVisibility({ provider: undefined }), "summary");
});

test("an empty thinking block WITH a signature is hidden, not absent", () => {
	// This is the current Anthropic default (`display:"omitted"` on Opus 5,
	// Sonnet 5, Opus 4.8/4.7): empty text, real signature, FULLY BILLED, and no
	// thinking_delta events at all. Reporting it as "no reasoning" hides cost
	// and would justify dropping a block that must be round-tripped.
	const v = refineReasoningVisibility("summary", { thinking: "", thinkingSignature: "abc123" });
	assert.equal(v, "hidden");
	assert.equal(refineReasoningVisibility("summary", { thinking: "   ", thinkingSignature: "sig" }), "hidden");
});

test("a redacted block reports redacted regardless of prior visibility", () => {
	assert.equal(refineReasoningVisibility("raw", { redacted: true, thinkingSignature: "op" }), "redacted");
	assert.equal(refineReasoningVisibility("summary", { redacted: true }), "redacted");
});

test("refinement never widens fidelity", () => {
	// A block can prove reasoning is hidden or redacted. It can never prove a
	// summary was actually the raw chain of thought.
	assert.equal(refineReasoningVisibility("summary", { thinking: "long text", thinkingSignature: "s" }), "summary");
	assert.equal(refineReasoningVisibility("summary", undefined), "summary");
});

test("an empty block with NO signature leaves visibility unchanged", () => {
	// Nothing observed — not evidence of omission.
	assert.equal(refineReasoningVisibility("raw", { thinking: "" }), "raw");
});

test("only raw and summary carry readable text", () => {
	assert.equal(hasReadableReasoning("raw"), true);
	assert.equal(hasReadableReasoning("summary"), true);
	assert.equal(hasReadableReasoning("hidden"), false);
	assert.equal(hasReadableReasoning("redacted"), false);
	assert.equal(hasReadableReasoning("none"), false);
});

test("labels never call a summary the model's thinking", () => {
	assert.match(describeReasoningVisibility("summary"), /summary/i);
	assert.doesNotMatch(describeReasoningVisibility("summary"), /^the model's reasoning$/);
	// The hidden label must mention that it is still billed, or the operator
	// reads "hidden" as "free".
	assert.match(describeReasoningVisibility("hidden"), /billed/i);
	for (const v of ["raw", "summary", "redacted", "hidden", "none"] as const) {
		assert.ok(describeReasoningVisibility(v).length > 0, v);
	}
});
