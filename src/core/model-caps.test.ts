/**
 * H4: persisted-thinking-level read-back.
 *
 * `set-thinking` writes `cfg.agents.<id>.thinking` to brigade.json so the
 * operator's selection survives a daemon restart. The boot + seed paths
 * read that value back via `readPersistedThinkingLevel` before falling
 * back to the model-derived initial level — this test pins the
 * accept/reject behaviour for known + bogus values.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { readPersistedThinkingLevel, remapThinkingLevel } from "./model-caps.js";

describe("readPersistedThinkingLevel (H4)", () => {
	it("returns the persisted level for every valid ThinkingLevel string", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
			assert.equal(
				readPersistedThinkingLevel({ thinking: level }),
				level,
				`should round-trip "${level}"`,
			);
		}
	});

	it("returns undefined when the entry is missing or non-object", () => {
		assert.equal(readPersistedThinkingLevel(undefined), undefined);
		assert.equal(readPersistedThinkingLevel(null), undefined);
		assert.equal(readPersistedThinkingLevel("high"), undefined);
		assert.equal(readPersistedThinkingLevel(42), undefined);
	});

	it("returns undefined when the entry omits `thinking` or stores a non-string", () => {
		assert.equal(readPersistedThinkingLevel({}), undefined);
		assert.equal(readPersistedThinkingLevel({ thinking: 3 }), undefined);
		assert.equal(readPersistedThinkingLevel({ thinking: null }), undefined);
		assert.equal(readPersistedThinkingLevel({ thinking: ["high"] }), undefined);
	});

	it("rejects bogus strings so a corrupted file can't poison the runtime", () => {
		assert.equal(readPersistedThinkingLevel({ thinking: "" }), undefined);
		assert.equal(readPersistedThinkingLevel({ thinking: "extreme" }), undefined);
		assert.equal(readPersistedThinkingLevel({ thinking: "OFF" }), undefined);
		assert.equal(readPersistedThinkingLevel({ thinking: "low " }), undefined);
	});

	it("simulates the daemon-restart path: a persisted 'high' beats the model default", () => {
		// Mirrors the boot/seed branch in server.ts — given a freshly loaded
		// cfg entry where the operator previously set thinking to "high",
		// the resolved runtime level should be "high" (NOT the model-derived
		// pickInitialThinkingLevel fallback).
		const cfgEntry = {
			provider: "anthropic",
			model: { primary: "claude-3-5-sonnet" },
			thinking: "high",
		};
		const persisted = readPersistedThinkingLevel(cfgEntry);
		const modelDefault = "low" as const; // pretend pickInitialThinkingLevel returned this
		const resolved = persisted ?? modelDefault;
		assert.equal(resolved, "high");
	});
});

describe("remapThinkingLevel (model-switch continuity)", () => {
	const reasoning = { id: "anthropic/claude-opus-4.8", reasoning: true } as never;
	const nonReasoning = { id: "openai/gpt-4o", reasoning: false } as never;
	const reasoningOnly = { id: "google/gemini-2.5-pro", reasoning: false } as never; // rejects budget=0

	it("preserves the operator's level when the new model can reason", () => {
		assert.equal(remapThinkingLevel("high", reasoning), "high");
		assert.equal(remapThinkingLevel("medium", reasoning), "medium");
	});

	it("drops to off when the new model can't reason", () => {
		assert.equal(remapThinkingLevel("high", nonReasoning), "off");
		assert.equal(remapThinkingLevel("xhigh", nonReasoning), "off");
	});

	it("bumps off→low for a reasoning-only model that rejects a zero budget", () => {
		assert.equal(remapThinkingLevel("off", reasoningOnly), "low");
	});

	it("keeps off for a normal reasoning model", () => {
		assert.equal(remapThinkingLevel("off", reasoning), "off");
	});

	it("falls back to the model's initial level when current is missing/invalid", () => {
		assert.equal(remapThinkingLevel(undefined, reasoning), "low"); // reasoning → low
		assert.equal(remapThinkingLevel(undefined, nonReasoning), "off");
	});
});
