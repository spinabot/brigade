import assert from "node:assert/strict";
import { test } from "node:test";

import { isClaudeCliAvailable, __resetClaudeCliAvailabilityCache } from "./availability.js";
import {
	isClaudeCliProvider,
	listClaudeCliModels,
	synthClaudeCliModel,
} from "./register.js";

test("synthClaudeCliModel: catalogued id keeps metadata + api", () => {
	const m = synthClaudeCliModel("claude-cli/claude-sonnet-4-6");
	assert.equal(m.provider, "claude-cli");
	assert.equal(m.api, "claude-cli");
	assert.equal(m.id, "claude-sonnet-4-6");
	assert.equal(m.reasoning, true);
	assert.equal((m.cost as any).total ?? (m.cost as any).input, 0); // zero cost
});

test("synthClaudeCliModel: unknown id still resolves to a usable claude-cli model", () => {
	const m = synthClaudeCliModel("claude-cli/claude-future-9-9");
	assert.equal(m.api, "claude-cli");
	assert.equal(m.id, "claude-future-9-9");
	assert.equal(m.contextWindow, 200_000);
});

test("synthClaudeCliModel: empty id → default model", () => {
	const m = synthClaudeCliModel("claude-cli/");
	assert.equal(m.id, "claude-sonnet-4-6");
});

test("isClaudeCliProvider: matches only the backend id", () => {
	assert.equal(isClaudeCliProvider("claude-cli"), true);
	assert.equal(isClaudeCliProvider("CLAUDE-CLI"), true);
	assert.equal(isClaudeCliProvider("anthropic"), false);
	assert.equal(isClaudeCliProvider(undefined), false);
});

test("listClaudeCliModels: returns all catalogued models as claude-cli api", () => {
	const models = listClaudeCliModels();
	assert.ok(models.length >= 3);
	assert.ok(models.every((m) => m.api === "claude-cli" && m.provider === "claude-cli"));
	assert.ok(models.some((m) => m.id === "claude-sonnet-4-6"));
});

test("isClaudeCliAvailable: PATH scan is cached + never throws", () => {
	__resetClaudeCliAvailabilityCache();
	// Point at a definitely-absent binary via the env override so the scan is
	// deterministic regardless of the host having claude installed.
	const prev = process.env.BRIGADE_CLAUDE_CLI_PATH;
	process.env.BRIGADE_CLAUDE_CLI_PATH = "/nonexistent/path/to/claude-xyz";
	try {
		__resetClaudeCliAvailabilityCache();
		assert.equal(isClaudeCliAvailable({ force: true }), false);
		// cached value returned without re-scan
		assert.equal(isClaudeCliAvailable(), false);
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_CLAUDE_CLI_PATH;
		else process.env.BRIGADE_CLAUDE_CLI_PATH = prev;
		__resetClaudeCliAvailabilityCache();
	}
});
