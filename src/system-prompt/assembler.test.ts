import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { assembleSystemPrompt } from "./assembler.js";
import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";
import type { OrgGraph } from "../agents/org/types.js";

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
	nowLocal: "Fri 2026-05-08 00:00",
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

	// SUB_AGENTS_GUIDANCE is now wired into the assembler (anti-hallucination
	// fix). Renders when `capabilities.subAgents` is true and we're not in
	// minimal mode — its body carries the load-bearing "use agents_list to
	// see what peer agents are configured" rule that trains the model to
	// hit the live tool instead of free-associating from stale transcript
	// history. Previously dead-exported.
	it("injects the Sub-agents guidance when capabilities.subAgents is true", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { subAgents: true },
		});
		assert.match(out.text, /# Sub-agents/);
		assert.match(out.text, /Use `agents_list` to see what peer agents are configured/);
	});

	it("does NOT inject the Sub-agents guidance when capabilities.subAgents is absent", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.doesNotMatch(out.text, /# Sub-agents/);
	});

	it("does NOT inject the Sub-agents guidance in minimal mode (sub-agent / cron)", () => {
		const sub = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [],
			capabilities: { subAgents: true, subagentMode: true },
		});
		assert.doesNotMatch(sub.text, /# Sub-agents/);
		const cron = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [],
			capabilities: { subAgents: true, cronMode: true },
		});
		assert.doesNotMatch(cron.text, /# Sub-agents/);
	});
});

describe("assembleSystemPrompt — Delegation Cascade (sessions_send + sessions_spawn)", () => {
	// The Delegation Cascade rule fires when BOTH `sessions_send` AND
	// `sessions_spawn` are present in the tool surface. Teaches the model the
	// strict ORDER to attempt cross-agent delegation (A2A first, spawn fallback,
	// then surface the failure with a concrete remediation), and that
	// `brigade.json` is OFF-LIMITS for self-service policy fixes.

	it("emits the cascade when BOTH sessions_send AND sessions_spawn are in the tool surface", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [
				{ name: "sessions_send", summary: "send to peer" },
				{ name: "sessions_spawn", summary: "spawn a child session" },
			],
		});
		assert.match(out.text, /## Delegating to peer agents/);
		assert.match(out.text, /First try sessions_send/);
		assert.match(out.text, /try sessions_spawn/);
		assert.match(out.text, /surface the failure to the operator/);
		assert.match(out.text, /NEVER hand-edit brigade\.json/);
		// Self vs peer-fan-out clarifier — model must not confuse the two.
		assert.match(out.text, /spawn_agent — not sessions_send or sessions_spawn/);
	});

	it("does NOT emit the cascade when only sessions_send is present", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [
				{ name: "sessions_send", summary: "send to peer" },
			],
		});
		assert.doesNotMatch(out.text, /## Delegating to peer agents/);
	});

	it("does NOT emit the cascade when only sessions_spawn is present", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [
				{ name: "sessions_spawn", summary: "spawn a child session" },
			],
		});
		assert.doesNotMatch(out.text, /## Delegating to peer agents/);
	});

	it("does NOT emit the cascade in subagent mode (minimal) even with both tools", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [
				{ name: "sessions_send", summary: "send to peer" },
				{ name: "sessions_spawn", summary: "spawn a child session" },
			],
			capabilities: { subagentMode: true },
		});
		assert.doesNotMatch(out.text, /## Delegating to peer agents/);
	});

	it("does NOT emit the cascade in cron mode (minimal) even with both tools", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [
				{ name: "sessions_send", summary: "send to peer" },
				{ name: "sessions_spawn", summary: "spawn a child session" },
			],
			capabilities: { cronMode: true },
		});
		assert.doesNotMatch(out.text, /## Delegating to peer agents/);
	});
});

describe("assembleSystemPrompt — Media guidance (analyze_media tool)", () => {
	// A2. The ## Media & documents block fires when `analyze_media` is in the
	// tool surface — keyed on the tool NAME, not a capability flag — so it only
	// renders when the model actually has the tool to call. Teaches the model to
	// call analyze_media on an `[attached … → <path>]` note BEFORE answering, and
	// that inbound images are already visible inline (no tool call needed).

	it("emits the ## Media block when analyze_media is in the tool surface", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [{ name: "analyze_media", summary: "read a media file" }],
		});
		assert.match(out.text, /## Media & documents/);
		assert.match(out.text, /analyze_media\(\{ source:/);
		assert.match(out.text, /BEFORE answering/);
		// The image-already-visible affordance (A3 pairing).
		assert.match(out.text, /already visible to you inline/);
	});

	it("does NOT emit the ## Media block when analyze_media is absent", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [{ name: "web_search", summary: "search" }],
		});
		assert.doesNotMatch(out.text, /## Media & documents/);
	});

	it("emits the ## Media block even in minimal mode (a cron/sub-agent may get a file path)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [{ name: "analyze_media", summary: "read a media file" }],
			capabilities: { subagentMode: true },
		});
		assert.match(out.text, /## Media & documents/);
	});
});

describe("assembleSystemPrompt — no ## Agents block (OC mirror)", () => {
	// The assembler deliberately does NOT enumerate peer agents in the
	// system prompt. The model learns the agent catalog exclusively via
	// the `agents_list` tool (allowlist-scoped) + the Runtime line's
	// `agent=<id>` field. This is the anti-hallucination contract: prompt-
	// side silence + a scoped tool the model must call.

	it("never emits a ## Agents block", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.doesNotMatch(out.text, /## Agents/);
	});

	it("does not emit a ## Agents block in any minimal mode either", () => {
		const sub = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [],
			capabilities: { subagentMode: true },
		});
		assert.doesNotMatch(sub.text, /## Agents/);
		const cron = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" }],
			toolDescriptions: [],
			capabilities: { cronMode: true },
		});
		assert.doesNotMatch(cron.text, /## Agents/);
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

	it("includes the reference-style behavioural rules block", () => {
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
		assert.match(out.text, /Sub-agents below you/);
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

// ─────────────────────────────────────────────────────────────────────
// Virtual-office layer — single-line org anchor tests.
//
// Pin the additive-conditional contract:
//   1. cfg.org absent (orgGraph undefined) → the assembled prompt is
//      BYTE-IDENTICAL to a baseline assembled with no orgGraph at all.
//      No new bytes are introduced when the feature is off.
//   2. cfg.org defined (orgGraph present)  → a SINGLE-LINE anchor
//      ("Org: you are <id>, ...") appears WITHOUT modifying any
//      existing section.
//   3. sub-agent mode + orgGraph defined   → the operator-facing anchor
//      is NOT rendered (operator-only surface); upstream injects a
//      one-line spawn anchor via the ephemeral suffix instead.
// ─────────────────────────────────────────────────────────────────────

const FIXTURE_ORG: OrgGraph = {
	topOrder: "default",
	mode: "derived",
	members: {
		default: {
			department: "office",
			reportsTo: null,
			role: "Chief of Staff",
			source: "explicit",
		},
		helper: {
			department: "office",
			reportsTo: "default",
			role: "Assistant",
			source: "explicit",
		},
	},
	departments: { office: ["default", "helper"] },
	edges: [],
};

describe("assembleSystemPrompt — org anchor (cfg.org absent → byte-identical)", () => {
	it("cfg.org absent: omitting orgGraph produces the exact same text as before the org layer", () => {
		// Two identical calls with no orgGraph; the result must be stable
		// AND must not contain the anchor / org-tool vocabulary.
		const a = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const b = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		assert.equal(a.text, b.text, "two no-orgGraph calls must produce identical text");
		// The anchor + any legacy multi-section vocabulary must be absent.
		assert.doesNotMatch(a.text, /^## Org$/m);
		assert.doesNotMatch(a.text, /^Org: you are /m);
		assert.doesNotMatch(a.text, /Call org\(\{action:"describe"\}\)/);
		assert.doesNotMatch(a.text, /Spawned by /);
	});

	it("orgGraph: undefined vs not-passed produce identical output (zero-cost no-op)", () => {
		const omitted = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const explicitUndef = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			orgGraph: undefined as any,
		});
		assert.equal(omitted.text, explicitUndef.text);
	});
});

describe("assembleSystemPrompt — org anchor (cfg.org defined → anchor appears, no existing sections mutated)", () => {
	it("emits the single-line anchor exactly once, between existing sections", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			orgGraph: FIXTURE_ORG,
		});
		// The single-line anchor appears.
		assert.match(out.text, /^Org: you are default, Chief of Staff, top-of-org\. Call org\(\{action:"describe"\}\) for direct reports \+ departments\./m);
		// And only once — defensive against an accidental double-render.
		const occurrences = out.text.split(/^Org: you are /m).length - 1;
		assert.equal(occurrences, 1, "anchor must render exactly once");
		// Legacy `## Org` header must NOT appear (consolidation drops it).
		assert.doesNotMatch(out.text, /^## Org$/m);
	});

	it("places the anchor line ABOVE the cache boundary (cached prefix)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			orgGraph: FIXTURE_ORG,
		});
		const anchorIdx = out.text.indexOf("\nOrg: you are ");
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		assert.ok(anchorIdx > 0, "anchor line must appear in the output");
		assert.ok(boundaryIdx > 0, "cache boundary must appear in the output");
		assert.ok(anchorIdx < boundaryIdx, "anchor line must sit above the cache boundary");
	});

	it("does NOT modify any existing canonical section when orgGraph is added", () => {
		// Snapshot a few load-bearing existing-section signatures with and
		// without orgGraph; they should match byte-for-byte EXCEPT for the
		// added anchor line.
		const without = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const withOrg = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			orgGraph: FIXTURE_ORG,
		});
		// Universal sections present in BOTH and unchanged.
		for (const marker of [
			"## Tooling",
			"## Tool Call Style",
			"## Execution Bias",
			"## Safety",
			"## Brigade CLI Quick Reference",
			"## Workspace",
			"# Project Context",
			CACHE_BOUNDARY_MARKER_LINE,
			"## Runtime",
		]) {
			assert.ok(without.text.includes(marker), `${marker} must exist in baseline`);
			assert.ok(withOrg.text.includes(marker), `${marker} must still exist with orgGraph`);
		}
		// The with-org output is a strict super-sequence of the without-org
		// output: removing the anchor line (the line itself + the assembler's
		// trailing blank-line padding) brings the two back into alignment.
		const anchorStart = withOrg.text.indexOf("Org: you are ");
		assert.ok(anchorStart > 0);
		// End is the next "\n\n" after the line — that pair is the blank-line
		// separator the assembler appends. We strip up to and including ONE
		// newline of that pair so the legacy single \n separator between the
		// preceding section and the next section is what remains.
		const blankPairIdx = withOrg.text.indexOf("\n\n", anchorStart);
		assert.ok(blankPairIdx > anchorStart);
		const stripped = withOrg.text.slice(0, anchorStart) + withOrg.text.slice(blankPairIdx + 2);
		assert.equal(stripped, without.text, "removing the anchor line must yield the legacy text");
	});
});

describe("assembleSystemPrompt — sub-agent mode (no operator-facing anchor; ephemeral spawn anchor)", () => {
	it("does NOT emit the operator-facing anchor when subagentMode is true, even with orgGraph defined", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			orgGraph: FIXTURE_ORG,
			capabilities: { subagentMode: true },
		});
		// Operator-only anchor is suppressed in sub-agent mode.
		assert.doesNotMatch(out.text, /^## Org$/m);
		assert.doesNotMatch(out.text, /^Org: you are /m);
	});

	it("does NOT emit the operator-facing anchor in cron mode either (operator-only surface)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			orgGraph: FIXTURE_ORG,
			capabilities: { cronMode: true },
		});
		assert.doesNotMatch(out.text, /^## Org$/m);
		assert.doesNotMatch(out.text, /^Org: you are /m);
	});

	it("upstream-injected sub-agent anchor lands BELOW the cache boundary via ephemeralSuffix", () => {
		// Mirrors how agent-loop.ts prepends `renderSubAgentAnchor(...)` to
		// args.ephemeralSuffix when subagentMode + orgGraph are both set.
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			orgGraph: FIXTURE_ORG,
			capabilities: { subagentMode: true },
			ephemeralSuffix: "Spawned by default, inheriting office.",
		});
		const anchorIdx = out.text.indexOf("Spawned by default, inheriting office.");
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		assert.ok(anchorIdx > 0, "anchor line must appear in the output");
		assert.ok(boundaryIdx > 0);
		assert.ok(anchorIdx > boundaryIdx, "sub-agent anchor must sit BELOW the cache boundary");
	});
});


describe("assembleSystemPrompt — ## Messaging linked self-accounts", () => {
	it("surfaces the linked operator number and forbids asking for it", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			channels: {
				started: ["whatsapp"],
				linked: [{ channelId: "whatsapp", selfId: "15550100001" }],
			},
		});
		assert.match(out.text, /## Messaging/);
		assert.match(out.text, /whatsapp is linked to the operator's own account: `15550100001`/);
		assert.match(out.text, /never ask the operator for their number/);
		assert.match(out.text, /send_message\(\{channel: "whatsapp", to: "15550100001", text\}\)/);
	});

	it("omits the linked line when no adapter reported a selfId", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			channels: { started: ["whatsapp"] },
		});
		assert.match(out.text, /## Messaging/);
		assert.doesNotMatch(out.text, /linked to the operator's own account/);
	});

	it("emits one linked line per channel", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			channels: {
				started: ["whatsapp", "telegram"],
				linked: [
					{ channelId: "whatsapp", selfId: "15550100001" },
					{ channelId: "telegram", selfId: "operator_tg" },
				],
			},
		});
		assert.match(out.text, /whatsapp is linked to the operator's own account: `15550100001`/);
		assert.match(out.text, /telegram is linked to the operator's own account: `operator_tg`/);
	});
});

describe("assembleSystemPrompt — ## Messaging available-but-not-connected channels", () => {
	it("renders ## Messaging with a connect offer when nothing is started but a channel is connectable", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			channels: {
				started: [],
				available: [{ channelId: "telegram", label: "Telegram", connectable: true }],
			},
		});
		assert.match(out.text, /## Messaging/);
		assert.match(out.text, /No messaging channel is connected yet/);
		assert.match(out.text, /Available to connect \(not yet connected\): Telegram/);
		assert.match(out.text, /connect_channel/);
		// No "send now" line when nothing is connected.
		assert.doesNotMatch(out.text, /To send now: `send_message`/);
	});

	it("lists both the connected channel AND the connectable one when both exist", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			channels: {
				started: ["whatsapp"],
				available: [{ channelId: "telegram", label: "Telegram", connectable: true }],
			},
		});
		assert.match(out.text, /## Messaging/);
		assert.match(out.text, /message the operator.*on: whatsapp/);
		assert.match(out.text, /Available to connect \(not yet connected\): Telegram/);
	});

	it("does NOT render a connect line for a channel marked connectable:false", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			channels: {
				started: ["whatsapp"],
				available: [{ channelId: "telegram", label: "Telegram", connectable: false }],
			},
		});
		assert.match(out.text, /## Messaging/);
		assert.doesNotMatch(out.text, /Available to connect/);
	});

	it("omits the ## Messaging block entirely in sub-agent mode even with connectable channels", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { subagentMode: true },
			channels: {
				started: [],
				available: [{ channelId: "telegram", label: "Telegram", connectable: true }],
			},
		});
		assert.doesNotMatch(out.text, /## Messaging/);
	});
});
