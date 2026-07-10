import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildClaudeCliArgs,
	composeClaudeCliSystemPrompt,
	isStructuredJsonPrompt,
	buildClaudeCliEnv,
	CLAUDE_CLI_FORBIDDEN_ENV,
	resolveCliModelArg,
	stripClaudeCliPrefix,
	resolveClaudeCliCommand,
	__resetBundledClaudeCache,
} from "./catalog.js";
import { EXTRACTION_PROMPT } from "../memory/extract.js";
import { CONSOLIDATION_PROMPT } from "../memory/consolidate.js";

/* ─────────────────────── structured JSON utility mode ─────────────────────── */

test("isStructuredJsonPrompt: fires ONLY on the utility JSON contract", () => {
	assert.equal(isStructuredJsonPrompt('Return STRICT JSON only:\n{"facts":[]}'), true);
	assert.equal(isStructuredJsonPrompt("Output STRICT JSON only, no fences"), true);
	// The REAL distiller prompts must trip it — guards against a phrase reword
	// silently reverting extraction to the prose-nudged, un-parseable path.
	assert.equal(isStructuredJsonPrompt(EXTRACTION_PROMPT), true);
	assert.equal(isStructuredJsonPrompt(CONSOLIDATION_PROMPT), true);
	// A normal chat persona (or undefined) must NOT trip it.
	assert.equal(isStructuredJsonPrompt("You are Brigade, a helpful crew."), false);
	assert.equal(isStructuredJsonPrompt("Please return the data as JSON if you can."), false);
	assert.equal(isStructuredJsonPrompt(undefined), false);
});

test("composeClaudeCliSystemPrompt: structured drops the prose nudge, reinforces JSON", () => {
	const sys = composeClaudeCliSystemPrompt({ systemPrompt: EXTRACTION_PROMPT });
	assert.doesNotMatch(sys, /do not use tools/i, "prose nudge gone for a JSON distiller");
	assert.doesNotMatch(sys, /Respond directly in prose/i);
	assert.match(sys, /Output ONLY the JSON/i);
	assert.match(sys, /starting with \{ and ending with \}/i);
});

test("composeClaudeCliSystemPrompt: explicit structured flag overrides detection", () => {
	const sys = composeClaudeCliSystemPrompt({ systemPrompt: "You are Brigade.", structured: true });
	assert.doesNotMatch(sys, /do not use tools/i);
	assert.match(sys, /Output ONLY the JSON/i);
});

test("composeClaudeCliSystemPrompt: toolPlane turn allows the memory MCP tools, still no fs", () => {
	const sys = composeClaudeCliSystemPrompt({ systemPrompt: "You are Brigade.", toolPlane: true });
	assert.match(sys, /mcp__brigade__memory_add/);
	assert.match(sys, /mcp__brigade__memory_search/);
	assert.match(sys, /Do not use any other tools/i);
	assert.doesNotMatch(sys, /Respond directly in prose; do not use tools/, "plain nudge replaced");
	// STRUCTURED still wins over toolPlane (distillers never get tools).
	const both = composeClaudeCliSystemPrompt({
		systemPrompt: 'Return STRICT JSON only: {"facts":[]}',
		toolPlane: true,
	});
	assert.match(both, /Output ONLY the JSON/i);
	assert.doesNotMatch(both, /mcp__brigade/);
});

test("buildClaudeCliArgs: a structured turn stays tool-less (distiller must not touch fs)", () => {
	assert.ok(buildClaudeCliArgs({ modelId: "claude-sonnet-4-6", structured: true }).includes("--disallowedTools"));
	// auto-derived from the prompt too
	assert.ok(buildClaudeCliArgs({ modelId: "claude-sonnet-4-6", systemPrompt: EXTRACTION_PROMPT }).includes("--disallowedTools"));
});

test("stripClaudeCliPrefix: removes provider prefix, leaves bare id", () => {
	assert.equal(stripClaudeCliPrefix("claude-cli/claude-sonnet-4-6"), "claude-sonnet-4-6");
	assert.equal(stripClaudeCliPrefix("claude-sonnet-4-6"), "claude-sonnet-4-6");
	assert.equal(stripClaudeCliPrefix("  claude-cli/opus  "), "opus");
});

test("resolveCliModelArg: catalogued + full ids pass through; families map; junk → default", () => {
	assert.equal(resolveCliModelArg("claude-cli/claude-sonnet-4-6"), "claude-sonnet-4-6");
	assert.equal(resolveCliModelArg("claude-opus-4-8"), "claude-opus-4-8"); // full id verbatim
	assert.equal(resolveCliModelArg("opus"), "opus");
	assert.equal(resolveCliModelArg("sonnet"), "sonnet");
	assert.equal(resolveCliModelArg("claude-future-9-9"), "claude-future-9-9"); // trust newer snapshot
	assert.equal(resolveCliModelArg(""), "claude-sonnet-4-6"); // default
	assert.equal(resolveCliModelArg("gpt-4o"), "claude-sonnet-4-6"); // non-claude → default
});

test("buildClaudeCliArgs: fresh turn argv shape (system prompt NOT on argv)", () => {
	const args = buildClaudeCliArgs({ modelId: "claude-cli/claude-sonnet-4-6" });
	assert.ok(args.includes("-p"));
	assert.deepEqual(args.slice(1, 5), ["--output-format", "stream-json", "--include-partial-messages", "--verbose"]);
	assert.ok(args.includes("--permission-mode"));
	assert.ok(args.includes("bypassPermissions"));
	// model
	const mi = args.indexOf("--model");
	assert.equal(args[mi + 1], "claude-sonnet-4-6");
	// conversational default → deny mutating tools
	assert.ok(args.includes("--disallowedTools"));
	// The system prompt is delivered via a FILE by the spawner, never on argv
	// (dodges the OS command-line length limit) — so no inline flag here.
	assert.ok(!args.includes("--append-system-prompt"));
	assert.ok(!args.includes("--append-system-prompt-file"));
});

test("composeClaudeCliSystemPrompt: persona + conversational nudge", () => {
	const sys = composeClaudeCliSystemPrompt({ systemPrompt: "You are Brigade." });
	assert.match(sys, /You are Brigade\./);
	assert.match(sys, /do not use tools/i);
});

test("composeClaudeCliSystemPrompt: no persona still yields the nudge; conversational:false → empty", () => {
	assert.match(composeClaudeCliSystemPrompt({}), /do not use tools/i);
	assert.equal(composeClaudeCliSystemPrompt({ systemPrompt: "x", conversational: false }), "x");
	assert.equal(composeClaudeCliSystemPrompt({ conversational: false }), "");
});

test("buildClaudeCliArgs: conversational:false drops the tool-deny flag", () => {
	const args = buildClaudeCliArgs({ modelId: "opus", conversational: false });
	assert.ok(!args.includes("--disallowedTools"));
});

test("buildClaudeCliEnv: strips credential/routing/telemetry vars + the host-managed marker", () => {
	const base = {
		PATH: "/usr/bin",
		HOME: "/home/me",
		ANTHROPIC_API_KEY: "sk-ant-api-xxx",
		ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-xxx",
		ANTHROPIC_BASE_URL: "https://proxy.example",
		CLAUDE_CONFIG_DIR: "/foreign/.claude",
		OTEL_SDK_DISABLED: "true",
		[CLAUDE_CLI_FORBIDDEN_ENV]: "1",
	} as NodeJS.ProcessEnv;
	const out = buildClaudeCliEnv(base);
	// preserved
	assert.equal(out.PATH, "/usr/bin");
	assert.equal(out.HOME, "/home/me");
	// scrubbed
	assert.equal(out.ANTHROPIC_API_KEY, undefined);
	assert.equal(out.ANTHROPIC_OAUTH_TOKEN, undefined);
	assert.equal(out.ANTHROPIC_BASE_URL, undefined);
	assert.equal(out.CLAUDE_CONFIG_DIR, undefined);
	assert.equal(out.OTEL_SDK_DISABLED, undefined);
	assert.equal(out[CLAUDE_CLI_FORBIDDEN_ENV], undefined);
	// input not mutated
	assert.equal(base.ANTHROPIC_API_KEY, "sk-ant-api-xxx");
});

test("buildClaudeCliEnv: sets CLAUDE_CONFIG_DIR when a managed dir is passed", () => {
	const out = buildClaudeCliEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/inherited/foreign" }, { configDir: "/managed/brigade" });
	// inherited value scrubbed, then Brigade's own set deliberately
	assert.equal(out.CLAUDE_CONFIG_DIR, "/managed/brigade");
});

test("buildClaudeCliEnv: no managed dir → inherited CLAUDE_CONFIG_DIR is stripped, not set", () => {
	const out = buildClaudeCliEnv({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/inherited/foreign" });
	assert.equal(out.CLAUDE_CONFIG_DIR, undefined);
});

test("resolveClaudeCliCommand: env override wins over everything", () => {
	const prev = process.env.BRIGADE_CLAUDE_CLI_PATH;
	process.env.BRIGADE_CLAUDE_CLI_PATH = "/custom/claude";
	try {
		assert.equal(resolveClaudeCliCommand(), "/custom/claude");
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_CLAUDE_CLI_PATH;
		else process.env.BRIGADE_CLAUDE_CLI_PATH = prev;
	}
});

test("resolveClaudeCliCommand: falls back to `claude` on PATH when no override + no bundle", () => {
	const prev = process.env.BRIGADE_CLAUDE_CLI_PATH;
	delete process.env.BRIGADE_CLAUDE_CLI_PATH;
	__resetBundledClaudeCache();
	try {
		const cmd = resolveClaudeCliCommand();
		// Either the bundled absolute path (if the optional dep is installed) or the
		// bare "claude" fallback — never empty.
		assert.ok(cmd === "claude" || cmd.length > 0);
	} finally {
		if (prev !== undefined) process.env.BRIGADE_CLAUDE_CLI_PATH = prev;
		__resetBundledClaudeCache();
	}
});

test("composeClaudeCliSystemPrompt: the FULL plane tells the model to USE its tools", () => {
	const sys = composeClaudeCliSystemPrompt({ systemPrompt: "You are Brigade.", fullPlane: true });
	// The regression that shipped: the full plane reused the memory-only suffix,
	// which forbids "any other tools" — so the model obediently refused to act.
	assert.doesNotMatch(sys, /Do not use any other tools/i, "must not forbid the tools we just served");
	assert.doesNotMatch(sys, /respond directly in prose/i, "must not be nudged into prose-only");
	assert.match(sys, /mcp__brigade__/, "names the MCP tool namespace");
	assert.match(sys, /Call them whenever they help/i);
	// ...and it names the guarded filesystem/shell it now actually has.
	assert.match(sys, /read, write, edit, bash, grep and ls/i);
	assert.match(sys, /pause for the operator's approval/i);
});

test("composeClaudeCliSystemPrompt: precedence structured > fullPlane > toolPlane", () => {
	// a distiller never gets tools, even if both plane flags are set
	const distiller = composeClaudeCliSystemPrompt({
		systemPrompt: 'Return STRICT JSON only: {"facts":[]}',
		toolPlane: true,
		fullPlane: true,
	});
	assert.match(distiller, /Output ONLY the JSON/i);
	assert.doesNotMatch(distiller, /mcp__brigade/);
	// full plane wins over the memory-only plane
	const full = composeClaudeCliSystemPrompt({ systemPrompt: "x", toolPlane: true, fullPlane: true });
	assert.match(full, /Call them whenever they help/i);
	assert.doesNotMatch(full, /memory_context/, "not the memory-only suffix");
	// memory-only plane still works on its own (the cold/stdio path)
	const mem = composeClaudeCliSystemPrompt({ systemPrompt: "x", toolPlane: true });
	assert.match(mem, /mcp__brigade__memory_add/);
});
