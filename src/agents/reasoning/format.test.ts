import assert from "node:assert/strict";
import { test } from "node:test";

import {
	formatDuration,
	formatReasoningLine,
	formatTokens,
	hasExpandableReasoning,
	reasoningSuffix,
} from "./format.js";

test("durations read the way people say them", () => {
	assert.equal(formatDuration(800), "800ms");
	assert.equal(formatDuration(12_000), "12s");
	assert.equal(formatDuration(130_000), "2m 10s");
	assert.equal(formatDuration(120_000), "2m");
	assert.equal(formatDuration(-1), "0s");
	assert.equal(formatDuration(Number.NaN), "0s");
});

test("token counts are rounded, not precise", () => {
	// `4,231` implies an accuracy the providers do not agree on, and the reader
	// wants magnitude, not an audit.
	assert.equal(formatTokens(842), "842");
	assert.equal(formatTokens(4231), "4.2k");
	assert.equal(formatTokens(12_400), "12k");
	assert.equal(formatTokens(1_300_000), "1.3M");
	assert.equal(formatTokens(1000), "1k");
	assert.equal(formatTokens(-5), "0");
});

test("a live phase ticks from the SERVER-stamped start", () => {
	// Two harnesses surveyed seed the timer from component mount, so their
	// elapsed figure resets on reload. A server epoch survives reconnects.
	const line = formatReasoningLine({
		state: { active: true, visibility: "raw", startedAt: 1_000 },
		now: 13_000,
	});
	assert.equal(line, "Thinking 12s…");
});

test("raw reasoning carries NO disclaimer", () => {
	// An unqualified line correctly means "this is the model's own reasoning".
	assert.equal(reasoningSuffix("raw"), "");
	const line = formatReasoningLine({
		state: { active: false, visibility: "raw", tokens: 1800 },
		elapsedMs: 12_000,
	});
	assert.equal(line, "Thought for 12s · 1.8k reasoning tokens");
});

test("a provider summary says so — the thing no surveyed harness does", () => {
	// Anthropic, OpenAI hosted models and Grok all return a summary written by a
	// different model. Every other harness prints the same word for that as for
	// DeepSeek's actual chain of thought.
	const line = formatReasoningLine({
		state: { active: false, visibility: "summary", tokens: 4231 },
		elapsedMs: 12_000,
	});
	assert.equal(line, "Thought for 12s · 4.2k reasoning tokens · provider summary");
});

test("hidden reasoning is legible instead of an empty bubble", () => {
	// The current Anthropic default (`display:"omitted"`): empty text, real
	// signature, FULLY BILLED. Rendering nothing reads as "it didn't think".
	const line = formatReasoningLine({
		state: { active: false, visibility: "hidden", tokens: 4231 },
		elapsedMs: 12_000,
	});
	assert.equal(line, "Thought for 12s · 4.2k reasoning tokens · not exposed by this model");
});

test("redacted reasoning is stated, not silently dropped", () => {
	// One surveyed harness renders nothing at all for a redacted block.
	const line = formatReasoningLine({
		state: { active: false, visibility: "redacted" },
		elapsedMs: 3000,
	});
	assert.equal(line, "Thought for 3s · redacted by the provider");
});

test("absent tokens never render as zero", () => {
	// Claiming `0 reasoning tokens` asserts a measurement we do not have.
	const line = formatReasoningLine({
		state: { active: false, visibility: "raw" },
		elapsedMs: 5000,
	});
	assert.equal(line, "Thought for 5s");
	assert.doesNotMatch(line!, /0 reasoning/);
});

test("a session that never reasoned renders no row at all", () => {
	assert.equal(formatReasoningLine({ state: undefined }), undefined);
	assert.equal(formatReasoningLine({ state: { active: false, visibility: "none" } }), undefined);
});

test("a live phase with no start time still shows something", () => {
	assert.equal(formatReasoningLine({ state: { active: true, visibility: "raw" } }), "Thinking…");
});

test("expand is only offered when there is text behind the line", () => {
	// Offering an expand affordance that opens an empty pane is worse than
	// offering none.
	assert.equal(hasExpandableReasoning({ active: false, visibility: "hidden", tokens: 4000 }), false);
	assert.equal(hasExpandableReasoning({ active: false, visibility: "redacted" }), false);
	assert.equal(hasExpandableReasoning({ active: false, visibility: "raw", chars: 0 }), false);
	assert.equal(hasExpandableReasoning({ active: false, visibility: "raw", chars: 120 }), true);
	assert.equal(hasExpandableReasoning({ active: false, visibility: "summary", chars: 120 }), true);
	assert.equal(hasExpandableReasoning(undefined), false);
});

test("the live line for hidden reasoning still reports tokens", () => {
	// Mid-phase on an omitted-reasoning model there is no text and no deltas —
	// the token count is the ONLY evidence anything is happening.
	const line = formatReasoningLine({
		state: { active: true, visibility: "hidden", startedAt: 0, tokens: 2100 },
		now: 8000,
	});
	assert.equal(line, "Thinking 8s… · 2.1k reasoning tokens · not exposed by this model");
});

test("a completed phase uses the duration carried on the state", () => {
	// No caller passes `elapsedMs`, so without the state fallback this rendered
	// a bare "Thought" forever.
	const line = formatReasoningLine({
		state: { active: false, visibility: "summary", durationMs: 12_000, tokens: 4231 },
	});
	assert.equal(line, "Thought for 12s · 4.2k reasoning tokens · provider summary");
});
