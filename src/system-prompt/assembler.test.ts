import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { assembleSystemPrompt } from "./assembler.js";
import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";

const MOCK_RUNTIME = {
	agentId: "default",
	workspaceDir: "/mock/workspace",
	cwd: "/mock/cwd",
	hostName: "test-host",
	platform: "linux" as NodeJS.Platform,
	arch: "x64",
	nodeVersion: "v22.12.0",
	shell: "/bin/bash",
	modelLabel: "anthropic/claude-opus-4-7",
	channelLabel: "cli",
	thinkingLevel: "off",
	timezone: "UTC",
	nowIso: "2026-05-08T00:00:00.000Z",
	repoRoot: undefined,
};

describe("assembleSystemPrompt — universal sections (standard order)", () => {
	it("emits the universal section sequence in the right order", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const order = [
			"## Tooling",
			"## Tool Call Style",
			"## Execution Bias",
			"## Safety",
			"## Brigade CLI Quick Reference",
			"## Workspace",
			"# Project Context",
			CACHE_BOUNDARY_MARKER_LINE,
			"## Runtime",
		];
		let lastIdx = -1;
		for (const marker of order) {
			const idx = out.text.indexOf(marker);
			assert.ok(idx > lastIdx, `${marker} should appear AFTER the previous section`);
			lastIdx = idx;
		}
	});

	it("Tool Call Style block carries the narration + sensitive-action rules", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Tool Call Style/);
		assert.match(out.text, /do not narrate routine, low-risk tool calls/i);
		assert.match(out.text, /sensitive actions/i);
		// Universal narration lines that were previously missing.
		assert.match(out.text, /Keep narration brief and value-dense/i);
		assert.match(out.text, /When a first-class tool exists/i);
	});

	it("Execution Bias block tells the model to start doing it", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Execution Bias/);
		assert.match(out.text, /start doing it/);
		// Execution Bias is the 4 universal lines only — no Brigade-specific
		// response-length / anti-checklist editorializing.
		assert.match(out.text, /Commentary-only turns are incomplete/);
		assert.doesNotMatch(out.text, /Match response length to the question/);
	});

	it("Safety block keeps the three durable rules", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Safety/);
		// Constitution-style baseline (anti-self-preservation, human-
		// oversight priority, no-self-modification). Replaces the earlier
		// operator-protection bullets which were already covered at the
		// exec-gate layer (workdir/env refusal + decideApproval).
		assert.match(out.text, /no independent goals/i);
		assert.match(out.text, /human oversight/i);
		assert.match(out.text, /never bypass safeguards/i);
		assert.match(out.text, /Anthropic's constitution/i);
	});

	it("Brigade CLI Quick Reference lists operator-critical subcommands", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Brigade CLI Quick Reference/);
		// Trimmed to gateway lifecycle + onboard + doctor. The earlier
		// enumeration of every subcommand trained the model to suggest
		// `brigade <foo>` in conversational replies about unrelated topics
		// — see assembler.ts comment at the CLI block for details.
		assert.match(out.text, /brigade gateway/);
		assert.match(out.text, /brigade gateway status/);
		assert.match(out.text, /brigade gateway stop/);
		assert.match(out.text, /brigade onboard/);
		assert.match(out.text, /brigade doctor/);
		// And the help-fallback line that lets the model defer to the operator
		// instead of guessing at command shapes it doesn't know.
		assert.match(out.text, /brigade --help/);
	});

	it("Workspace block declares the absolute workspace dir", () => {
		const out = assembleSystemPrompt({
			runtime: { ...MOCK_RUNTIME, workspaceDir: "/home/me/.brigade/workspace" },
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Workspace/);
		assert.match(out.text, /\/home\/me\/\.brigade\/workspace/);
		assert.match(out.text, /single global workspace/);
	});

	it("everything in the canonical mirror sits ABOVE the cache boundary", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		const checkpoints = [
			"## Tooling",
			"## Tool Call Style",
			"## Execution Bias",
			"## Safety",
			"## Brigade CLI Quick Reference",
			"## Workspace",
			"# Project Context",
		];
		for (const c of checkpoints) {
			const idx = out.text.indexOf(c);
			assert.ok(idx > 0 && idx < boundaryIdx, `${c} must sit above the cache boundary`);
		}
	});
});

describe("assembleSystemPrompt — Reasoning Format (conditional)", () => {
	it("emits <think>/<final> guidance for non-native-reasoning model with thinking ON", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "openai/gpt-4o",
			thinkingLevel: "high",
		});
		assert.match(out.text, /Reasoning format/i);
		assert.match(out.text, /<think>/);
	});

	it("does NOT emit <think> guidance when thinkingLevel is off", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "openai/gpt-4o",
			thinkingLevel: "off",
		});
		assert.doesNotMatch(out.text, /<think>/);
	});

	it("does NOT emit <think> guidance for Claude (native extended thinking)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "anthropic/claude-opus-4-7",
			thinkingLevel: "high",
		});
		assert.doesNotMatch(out.text, /<think>/);
	});

	it("does NOT emit <think> guidance for o1/o3 (native internal reasoning)", () => {
		for (const id of ["o1-preview", "o3-mini", "openai/o3-mini"]) {
			const out = assembleSystemPrompt({
				runtime: MOCK_RUNTIME,
				personaFiles: [],
				toolDescriptions: [],
				modelId: id,
				thinkingLevel: "high",
			});
			assert.doesNotMatch(out.text, /<think>/, `${id} should not get <think> guidance`);
		}
	});
});

describe("assembleSystemPrompt — persona file canonical sort", () => {
	it("orders persona files: AGENTS, SOUL, IDENTITY, USER, TOOLS, BOOTSTRAP, MEMORY", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "MEMORY.md", path: "/x/MEMORY.md", content: "m" },
				{ name: "USER.md", path: "/x/USER.md", content: "u" },
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "a" },
				{ name: "BOOTSTRAP.md", path: "/x/BOOTSTRAP.md", content: "b" },
				{ name: "SOUL.md", path: "/x/SOUL.md", content: "s" },
				{ name: "TOOLS.md", path: "/x/TOOLS.md", content: "t" },
				{ name: "IDENTITY.md", path: "/x/IDENTITY.md", content: "i" },
			],
			toolDescriptions: [],
		});
		const order = ["## AGENTS", "## SOUL", "## IDENTITY", "## USER", "## TOOLS", "## BOOTSTRAP", "## MEMORY"];
		let lastIdx = -1;
		for (const h of order) {
			const idx = out.text.indexOf(h);
			assert.ok(idx > lastIdx, `${h} should appear in canonical order`);
			lastIdx = idx;
		}
	});
});

describe("assembleSystemPrompt — capability-gated sections", () => {
	// Primitive #4 wires the Memory block. Skills (#5) + Sub-agents (#6)
	// are still defined-but-unwired (their primitives haven't shipped), so
	// their flags are accepted but produce no section yet.

	it("injects the ## Memory block when capabilities.memory is true", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { memory: true },
		});
		assert.match(out.text, /## Memory/);
		assert.match(out.text, /recall_memory/);
		assert.match(out.text, /memory\/<YYYY-MM-DD>\.md/);
	});

	it("does NOT inject ## Memory when capabilities.memory is absent/false", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.doesNotMatch(out.text, /## Memory/);
	});

	it("injects the ## Skills block + rendered list when capabilities.skills is true", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { skills: true },
			skillsPromptBlock: "<available_skills>\n  <skill><name>demo</name></skill>\n</available_skills>",
		});
		assert.match(out.text, /## Skills/);
		assert.match(out.text, /Before replying to anything non-trivial/);
		assert.match(out.text, /<available_skills>/);
		assert.match(out.text, /<name>demo<\/name>/);
	});

	it("emits ## Skills guidance even with no rendered block, but omits the empty block", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { skills: true },
		});
		assert.match(out.text, /## Skills/);
		assert.doesNotMatch(out.text, /<available_skills>/);
	});

	it("does NOT inject ## Skills when capabilities.skills is absent/false", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			skillsPromptBlock: "<available_skills>x</available_skills>",
		});
		assert.doesNotMatch(out.text, /## Skills/);
		assert.doesNotMatch(out.text, /<available_skills>/);
	});

	it("Sub-agents block is still unwired (Primitive #6)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { subAgents: true },
		});
		assert.doesNotMatch(out.text, /# Sub-agents/);
	});
});

describe("assembleSystemPrompt — ephemeral suffix", () => {
	it("ephemeralSuffix lands BELOW the cache boundary (not cached)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			ephemeralSuffix: "Sub-agent task: review the diff.",
		});
		const ephIdx = out.text.indexOf("Sub-agent task: review the diff.");
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		assert.ok(ephIdx > 0, "ephemeral suffix must appear in the output");
		assert.ok(boundaryIdx > 0);
		assert.ok(
			ephIdx > boundaryIdx,
			"ephemeralSuffix MUST appear AFTER the cache boundary or it busts the prefix",
		);
	});

	it("empty / whitespace ephemeralSuffix is omitted entirely", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			ephemeralSuffix: "   ",
		});
		assert.doesNotMatch(out.text, /# Per-turn Notes/);
	});

	it("non-empty ephemeralSuffix renders under the Per-turn Notes header", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			ephemeralSuffix: "do the thing",
		});
		assert.match(out.text, /# Per-turn Notes/);
		assert.match(out.text, /do the thing/);
	});
});

describe("assembleSystemPrompt — tool listing", () => {
	it("empty tool list emits permissive line", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /Tools are wired into this turn/);
	});

	it("non-empty tool list emits each tool by name + summary", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [
				{ name: "read", summary: "Read a file" },
				{ name: "bash", summary: "Run a shell command" },
			],
		});
		// Standard opener; case-sensitivity is enforced by the unknown-tool
		// guard at the tool layer, not narrated in the prompt.
		assert.match(out.text, /Tool availability \(filtered by policy\):/);
		assert.match(out.text, /- read: Read a file/);
		assert.match(out.text, /- bash: Run a shell command/);
	});
});

describe("assembleSystemPrompt — subagent mode (Primitive #6)", () => {
	it("swaps the identity opener for the SUB-AGENT banner", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			capabilities: { subagentMode: true },
		});
		assert.match(out.text, /You are a SUB-AGENT running inside Brigade/);
		assert.doesNotMatch(out.text, /^You are a personal assistant/m);
		// Top-level banner heading.
		assert.match(out.text, /# Sub-agent Context/);
	});

	it("includes the OC-style behavioural rules block", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			capabilities: { subagentMode: true },
		});
		assert.match(out.text, /Stay focused/);
		assert.match(out.text, /Complete the task/);
		assert.match(out.text, /Don't initiate/);
		assert.match(out.text, /Be ephemeral/);
		assert.match(out.text, /No further sub-agents/);
		assert.match(out.text, /Recover from truncated tool output/);
		assert.match(out.text, /Don't poll/);
	});

	it("includes the Output Format guidance", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			capabilities: { subagentMode: true },
		});
		assert.match(out.text, /## Output Format/);
		assert.match(out.text, /what you accomplished or found/);
		assert.match(out.text, /specific details the parent needs/);
	});

	it("gates off operator-only sections in subagent mode", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			capabilities: { subagentMode: true, memory: true, skills: true },
			heartbeatFile: { name: "HEARTBEAT.md", path: "/x/HEARTBEAT.md", content: "tick" },
			modelId: "gemini-2.5-pro",
			skillsPromptBlock: "<available_skills><skill name=\"audit\" /></available_skills>",
		});
		assert.doesNotMatch(out.text, /## Execution Bias/);
		assert.doesNotMatch(out.text, /## Output Formatting/);
		assert.doesNotMatch(out.text, /## Brigade CLI Quick Reference/);
		assert.doesNotMatch(out.text, /## Memory/);
		assert.doesNotMatch(out.text, /## Skills/);
		assert.doesNotMatch(out.text, /<available_skills>/);
		assert.doesNotMatch(out.text, /## HEARTBEAT/);
		// Per-family identity override would normally fire for `gemini-*`.
		assert.doesNotMatch(out.text, /You are NOT Gemini/i);
	});

	it("keeps universal sections (tooling, tool call style, safety, workspace) in subagent mode", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [{ name: "read", summary: "Read a file" }],
			capabilities: { subagentMode: true },
		});
		assert.match(out.text, /## Tooling/);
		assert.match(out.text, /## Tool Call Style/);
		assert.match(out.text, /## Safety/);
		assert.match(out.text, /## Workspace/);
		assert.match(out.text, /# Project Context/);
		assert.match(out.text, /## Runtime/);
	});

	it("does NOT modify the opener when subagentMode is unset / false", () => {
		const baseline = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const explicitFalse = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			capabilities: { subagentMode: false },
		});
		assert.match(baseline.text, /You are a personal assistant running inside Brigade/);
		assert.match(explicitFalse.text, /You are a personal assistant running inside Brigade/);
		assert.doesNotMatch(baseline.text, /SUB-AGENT/);
		assert.doesNotMatch(explicitFalse.text, /SUB-AGENT/);
	});
});
