import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitReasoning, stripReasoningTags } from "./reasoning-tags.js";

describe("stripReasoningTags", () => {
	it("returns text unchanged when there are no reasoning tags", () => {
		assert.equal(stripReasoningTags("just a plain answer"), "just a plain answer");
		assert.equal(stripReasoningTags(""), "");
	});

	it("drops a complete <think> block, keeping the answer", () => {
		assert.equal(
			stripReasoningTags("<think>let me consider this</think>The answer is 42.").trim(),
			"The answer is 42.",
		);
	});

	it("handles <thinking> and <thought> variants (with attributes)", () => {
		assert.equal(stripReasoningTags('<thinking key="x">reasoning</thinking>hi').trim(), "hi");
		assert.equal(stripReasoningTags("<thought>hmm</thought>done").trim(), "done");
	});

	it("does not mismatch openers/closers (backref)", () => {
		// <thinking> must close with </thinking>, not </think>
		assert.equal(
			stripReasoningTags("<thinking>a</thinking>X<think>b</think>Y").trim(),
			"XY",
		);
	});

	it("strips an UNCLOSED reasoning block to end of text (stream cut mid-thought)", () => {
		assert.equal(stripReasoningTags("answer here <think>started reasoning but cut").trim(), "answer here");
	});

	it("unwraps <final>…</final>, keeping the inner answer", () => {
		assert.equal(
			stripReasoningTags("<think>plan</think><final>The final answer.</final>").trim(),
			"The final answer.",
		);
	});

	it("leaves JSON intact after stripping the reasoning that surrounds it", () => {
		const raw = '<think>I should return facts</think>{"facts":[{"content":"x"}]}';
		assert.equal(stripReasoningTags(raw).trim(), '{"facts":[{"content":"x"}]}');
	});
});

describe("splitReasoning", () => {
	it("separates reasoning from the visible answer", () => {
		const { visible, reasoning } = splitReasoning("<think>because Y</think>Answer.");
		assert.equal(visible.trim(), "Answer.");
		assert.equal(reasoning, "because Y");
	});

	it("concatenates multiple reasoning blocks", () => {
		const { reasoning } = splitReasoning("<think>a</think>x<thought>b</thought>y");
		assert.equal(reasoning, "a\nb");
	});

	it("reports empty reasoning when there is none", () => {
		assert.deepEqual(splitReasoning("plain"), { visible: "plain", reasoning: "" });
	});
});
