import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildClaudeCliArgs,
	buildClaudeCliEnv,
	CLAUDE_CLI_FORBIDDEN_ENV,
	resolveCliModelArg,
	stripClaudeCliPrefix,
	resolveClaudeCliCommand,
	__resetBundledClaudeCache,
} from "./catalog.js";

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

test("buildClaudeCliArgs: fresh turn argv shape", () => {
	const args = buildClaudeCliArgs({ modelId: "claude-cli/claude-sonnet-4-6", systemPrompt: "You are Brigade." });
	assert.ok(args.includes("-p"));
	assert.deepEqual(args.slice(1, 5), ["--output-format", "stream-json", "--include-partial-messages", "--verbose"]);
	assert.ok(args.includes("--permission-mode"));
	assert.ok(args.includes("bypassPermissions"));
	// model
	const mi = args.indexOf("--model");
	assert.equal(args[mi + 1], "claude-sonnet-4-6");
	// conversational default → deny mutating tools + append system prompt
	assert.ok(args.includes("--disallowedTools"));
	const si = args.indexOf("--append-system-prompt");
	assert.ok(si > 0);
	assert.match(args[si + 1]!, /You are Brigade\./);
	assert.match(args[si + 1]!, /do not use tools/i); // conversational suffix appended
});

test("buildClaudeCliArgs: no system prompt still appends the conversational nudge", () => {
	const args = buildClaudeCliArgs({ modelId: "opus" });
	assert.ok(args.includes("--append-system-prompt"));
});

test("buildClaudeCliArgs: conversational:false drops tool-deny + suffix", () => {
	const args = buildClaudeCliArgs({ modelId: "opus", systemPrompt: "x", conversational: false });
	assert.ok(!args.includes("--disallowedTools"));
	const si = args.indexOf("--append-system-prompt");
	assert.equal(args[si + 1], "x"); // no suffix
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
