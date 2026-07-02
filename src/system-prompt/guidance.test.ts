import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { assembleSystemPrompt } from "./assembler.js";
import {
	MEMORY_GUIDANCE,
	pickModelFamilyGuidance,
	REASONING_FORMAT_GUIDANCE,
	shouldUseReasoningFormat,
	SKILLS_GUIDANCE,
	SUB_AGENTS_GUIDANCE,
} from "./guidance.js";
import type { RuntimeParams } from "./runtime-params.js";

const MOCK_RUNTIME: RuntimeParams = {
	agentId: "main",
	workspaceDir: "/tmp/.brigade/workspace",
	cwd: "/tmp/.brigade/workspace",
	hostName: "host",
	platform: "linux",
	arch: "x64",
	nodeVersion: "v22.12.0",
	shell: "/bin/bash",
	modelLabel: "anthropic/claude-opus-4-7",
	channelLabel: "cli",
	thinkingLevel: "off",
	timezone: "UTC",
	nowIso: "2026-05-08T00:00:00.000Z",
	nowLocal: "Fri 2026-05-08 00:00",
	repoRoot: undefined,
};

describe("guidance constants — bodies still load-bearing", () => {
	// These five constants are CURRENTLY EMITTED into the system prompt
	// (REASONING_FORMAT) or queued for upcoming primitives (MEMORY, SKILLS,
	// SUB_AGENTS). Assert their key invariants here so a future refactor
	// doesn't accidentally strip the load-bearing language.

	it("REASONING_FORMAT_GUIDANCE keeps the <think> tag contract", () => {
		assert.match(REASONING_FORMAT_GUIDANCE, /<think>/);
		assert.match(REASONING_FORMAT_GUIDANCE, /Do not output analysis outside/i);
	});

	it("MEMORY_GUIDANCE teaches declarative-not-imperative (Primitive #4)", () => {
		assert.match(MEMORY_GUIDANCE, /DECLARATIVE FACTS/);
		assert.match(MEMORY_GUIDANCE, /not instructions/i);
	});

	it("MEMORY_GUIDANCE keeps the OC-mirror positive scope + citations line", () => {
		// Mirrors the reference codebase's `## Memory Recall` block: a
		// POSITIVE scope ("prior work, decisions, dates, people, preferences,
		// or todos") and a Citations footer — but NO "do not use memory for
		// live state" exclusion paragraph. The exclusion was a Brigade-only
		// divergence; OC uses dedicated `## Tooling` / `## Runtime` sections
		// to handle inventory questions and lets the positive scope do the
		// steering work.
		assert.match(MEMORY_GUIDANCE, /prior work, decisions, dates, people, preferences, or todos/);
		assert.match(MEMORY_GUIDANCE, /Citations: include Source:/);
		assert.doesNotMatch(MEMORY_GUIDANCE, /Do NOT use memory for questions about what currently exists/);
		assert.doesNotMatch(MEMORY_GUIDANCE, /the live tool wins/i);
		assert.doesNotMatch(MEMORY_GUIDANCE, /project conventions, environment, people/);
	});

	it("SKILLS_GUIDANCE covers scan-before-reply + patch-while-using (Primitive #5)", () => {
		assert.match(SKILLS_GUIDANCE, /Before replying/i);
		assert.match(SKILLS_GUIDANCE, /patch it before finishing/i);
	});

	it("SUB_AGENTS_GUIDANCE describes delegation boundaries (Primitive #6)", () => {
		assert.match(SUB_AGENTS_GUIDANCE, /independent/i);
		assert.match(SUB_AGENTS_GUIDANCE, /Don't delegate trivial work/i);
	});

	it("SUB_AGENTS_GUIDANCE does NOT use 'crew' framing (locked positioning)", () => {
		// Saved feedback: Brigade is positioned as "personal AI" not "team
		// tool" in v1; "crew" framing reads as the latter.
		assert.doesNotMatch(SUB_AGENTS_GUIDANCE, /\bcrew\b/i);
	});
});

describe("shouldUseReasoningFormat", () => {
	it("returns false when thinkingLevel is off / undefined", () => {
		assert.equal(shouldUseReasoningFormat("gpt-4o", "off"), false);
		assert.equal(shouldUseReasoningFormat("gpt-4o", undefined), false);
	});

	it("returns false for Claude (native extended thinking)", () => {
		assert.equal(shouldUseReasoningFormat("claude-opus-4-7", "high"), false);
		assert.equal(shouldUseReasoningFormat("anthropic/claude-3-5-sonnet", "high"), false);
		assert.equal(shouldUseReasoningFormat("openrouter/anthropic/claude-3", "high"), false);
	});

	it("returns false for OpenAI reasoning models (o1, o3)", () => {
		assert.equal(shouldUseReasoningFormat("o1", "high"), false);
		assert.equal(shouldUseReasoningFormat("o3-mini", "high"), false);
		assert.equal(shouldUseReasoningFormat("openai/o1-preview", "high"), false);
	});

	it("returns true for gpt-* / gemini-* / mistral / llama with thinking on", () => {
		assert.equal(shouldUseReasoningFormat("gpt-4o", "high"), true);
		assert.equal(shouldUseReasoningFormat("gemini-2.5-pro", "high"), true);
		assert.equal(shouldUseReasoningFormat("mistral-large-2", "high"), true);
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

	it("OpenAI block contains identity-override clause + grounded-data hint", () => {
		const text = pickModelFamilyGuidance("gpt-4o");
		assert.ok(text);
		assert.match(text!, /baseline training tells you to identify as "ChatGPT"/i);
		assert.match(text!, /draw your identity from the persona files/i);
		assert.match(text!, /answer from memory when a tool gives grounded data/i);
	});

	it("returns Google block for gemini-* / gemma-*", () => {
		assert.ok(pickModelFamilyGuidance("gemini-2.5-pro"));
		assert.ok(pickModelFamilyGuidance("gemma-7b"));
		assert.ok(pickModelFamilyGuidance("google/gemini-2.5-flash"));
		assert.ok(pickModelFamilyGuidance("openrouter/google/gemini-2.5-pro"));
	});

	it("Google block contains identity-override clause + brevity clause", () => {
		const text = pickModelFamilyGuidance("gemini-2.5-pro");
		assert.ok(text);
		assert.match(text!, /baseline training tells you to identify as "Gemini/i);
		assert.match(text!, /draw your identity from the persona files/i);
		assert.match(text!, /Keep prose brief/i);
	});

	it("returns null for Claude (no extras needed)", () => {
		assert.equal(pickModelFamilyGuidance("claude-opus-4-7"), null);
		assert.equal(pickModelFamilyGuidance("anthropic/claude-3-5-sonnet"), null);
		assert.equal(pickModelFamilyGuidance("openrouter/anthropic/claude-3"), null);
	});

	it("returns the GENERIC identity override for unknown / niche models (so they can't leak base-model identity)", () => {
		for (const id of ["mistral-large-2", "llama-3.1-70b", "ornith:35b", "qwen3:32b", "deepseek-r1:14b"]) {
			const g = pickModelFamilyGuidance(id);
			assert.ok(g, `expected an identity override for ${id}`);
			assert.match(g as string, /# Identity override/);
			assert.match(g as string, /Never identify as the base model/);
		}
	});

	it("trims whitespace + handles empty input", () => {
		assert.equal(pickModelFamilyGuidance(""), null);
		assert.equal(pickModelFamilyGuidance("   "), null);
		assert.equal(pickModelFamilyGuidance(undefined), null);
		assert.ok(pickModelFamilyGuidance(" gpt-4o "));
	});
});

describe("guidance — wired into assembled prompt (not vapourware)", () => {
	// Earlier audits found that pickModelFamilyGuidance was exported but
	// never CALLED by the assembler — the per-family identity-override
	// block was vapourware. These tests assert against the FULL ASSEMBLED
	// PROMPT to confirm the block actually lands.

	it("OpenAI family block appears in the assembled prompt for gpt-* models", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			modelId: "gpt-4o",
			thinkingLevel: "off",
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /# Identity override \(OpenAI family\)/);
		assert.match(out.text, /I am ChatGPT/i); // explicit forbidden-string literal
	});

	it("Google family block appears in the assembled prompt for gemini-* models", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			modelId: "gemini-2.5-pro",
			thinkingLevel: "off",
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /# Identity override \(Google family\)/);
		assert.match(out.text, /I am Gemini/i);
	});

	it("Claude family adds NO extra block (clean prompt)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			modelId: "claude-opus-4-7",
			thinkingLevel: "off",
			personaFiles: [],
			toolDescriptions: [],
		});
		// Identity-override block is absent for Claude.
		assert.doesNotMatch(out.text, /# Identity override/i);
	});

	it("Reasoning format block appears when thinking is on AND model supports it", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			modelId: "gpt-4o",
			thinkingLevel: "high",
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /Reasoning format/i);
		assert.match(out.text, /<think>/);
	});

	it("Reasoning format block is suppressed for Claude (native thinking)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			modelId: "claude-opus-4-7",
			thinkingLevel: "high",
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.doesNotMatch(out.text, /# Reasoning format/i);
	});
});
