import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	pickModelFamilyGuidance,
	SAFETY_GUARDRAILS_GUIDANCE,
	EXECUTION_BIAS_GUIDANCE,
	TOOL_CALL_STYLE_GUIDANCE,
	TOOL_USE_ENFORCEMENT_GUIDANCE,
	MEMORY_GUIDANCE,
	SKILLS_GUIDANCE,
	SUB_AGENTS_GUIDANCE,
} from "./guidance.js";

describe("guidance constants — non-empty + load-bearing language", () => {
	it("Safety baseline contains anti-self-preservation clause", () => {
		assert.match(SAFETY_GUARDRAILS_GUIDANCE, /no independent goals/i);
		assert.match(SAFETY_GUARDRAILS_GUIDANCE, /human oversight/i);
		assert.match(SAFETY_GUARDRAILS_GUIDANCE, /never bypass/i);
	});
	it("Execution bias forbids commentary-only turns", () => {
		assert.match(EXECUTION_BIAS_GUIDANCE, /commentary-only/i);
	});
	it("Tool-call style allows narration for sensitive actions", () => {
		assert.match(TOOL_CALL_STYLE_GUIDANCE, /sensitive actions/i);
	});
	it("Tool-use enforcement contains the SAY-AND-DO contract", () => {
		assert.match(TOOL_USE_ENFORCEMENT_GUIDANCE, /MUST call the tool in the same response/i);
		assert.match(TOOL_USE_ENFORCEMENT_GUIDANCE, /promise of future action/i);
	});
	it("Memory guidance teaches declarative-not-imperative", () => {
		assert.match(MEMORY_GUIDANCE, /DECLARATIVE FACTS/);
		assert.match(MEMORY_GUIDANCE, /not instructions/i);
	});
	it("Skills guidance covers scan-before-reply + patch-while-using", () => {
		assert.match(SKILLS_GUIDANCE, /Before replying/i);
		assert.match(SKILLS_GUIDANCE, /patch it before finishing/i);
	});
	it("Sub-agents guidance describes delegation boundaries", () => {
		assert.match(SUB_AGENTS_GUIDANCE, /independent/i);
		assert.match(SUB_AGENTS_GUIDANCE, /Don't delegate trivial work/i);
	});
});

describe("pickModelFamilyGuidance", () => {
	it("returns OpenAI block for gpt-* / codex-* / o1-* / o3-*", () => {
		assert.ok(pickModelFamilyGuidance("gpt-4o"));
		assert.ok(pickModelFamilyGuidance("gpt-4o-mini"));
		assert.ok(pickModelFamilyGuidance("o1"));
		assert.ok(pickModelFamilyGuidance("o3-mini"));
		assert.ok(pickModelFamilyGuidance("codex-mini"));
		assert.ok(pickModelFamilyGuidance("openai/gpt-4o"));
		assert.ok(pickModelFamilyGuidance("openrouter/openai/gpt-4o"));
	});
	it("OpenAI block contains identity-override clause + grounded-data list", () => {
		const text = pickModelFamilyGuidance("gpt-4o");
		assert.ok(text);
		assert.match(text!, /OVERRIDDEN by the persona/i);
		assert.match(text!, /never mental math/i);
		assert.match(text!, /Resolve prerequisites first/i);
	});
	it("returns Google block for gemini-* / gemma-*", () => {
		assert.ok(pickModelFamilyGuidance("gemini-2.5-pro"));
		assert.ok(pickModelFamilyGuidance("gemma-7b"));
		assert.ok(pickModelFamilyGuidance("google/gemini-2.5-flash"));
		assert.ok(pickModelFamilyGuidance("openrouter/google/gemini-2.5-pro"));
	});
	it("Google block contains absolute-paths clause + parallel-tool clause", () => {
		const text = pickModelFamilyGuidance("gemini-2.5-pro");
		assert.ok(text);
		assert.match(text!, /ABSOLUTE file paths/);
		assert.match(text!, /single response rather than sequentially/i);
	});
	it("returns null for Claude (no extras needed)", () => {
		assert.equal(pickModelFamilyGuidance("claude-opus-4-7"), null);
		assert.equal(pickModelFamilyGuidance("anthropic/claude-3-5-sonnet"), null);
		assert.equal(pickModelFamilyGuidance("openrouter/anthropic/claude-3"), null);
	});
	it("returns null for unknown / niche models", () => {
		assert.equal(pickModelFamilyGuidance("mistral-large-2"), null);
		assert.equal(pickModelFamilyGuidance("llama-3.1-70b"), null);
	});
	it("trims whitespace + handles empty input", () => {
		assert.equal(pickModelFamilyGuidance(""), null);
		assert.equal(pickModelFamilyGuidance("   "), null);
		assert.equal(pickModelFamilyGuidance(undefined), null);
		assert.ok(pickModelFamilyGuidance(" gpt-4o "));
	});
});
