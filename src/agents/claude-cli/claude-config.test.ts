import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	CLAUDE_CODE_OAUTH_SCOPES,
	clearBrigadeClaudeLogin,
	hasBrigadeClaudeLogin,
	readBrigadeClaudeCredential,
	resolveBrigadeClaudeConfigDir,
	writeBrigadeClaudeCredential,
} from "./claude-config.js";

function withTempConfigDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(path.join(tmpdir(), "brigade-cc-"));
	const prev = process.env.BRIGADE_CLAUDE_CONFIG_DIR;
	process.env.BRIGADE_CLAUDE_CONFIG_DIR = dir;
	try {
		fn(dir);
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_CLAUDE_CONFIG_DIR;
		else process.env.BRIGADE_CLAUDE_CONFIG_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("resolveBrigadeClaudeConfigDir: honours the env override", () => {
	withTempConfigDir((dir) => {
		assert.equal(resolveBrigadeClaudeConfigDir(), dir);
	});
});

test("writeBrigadeClaudeCredential: writes Claude Code's on-disk shape", () => {
	withTempConfigDir((dir) => {
		writeBrigadeClaudeCredential({
			access: "sk-ant-oat01-abc",
			refresh: "sk-ant-ort01-xyz",
			expires: 1_900_000_000_000,
			subscriptionType: "max",
		});
		const raw = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"));
		assert.equal(raw.claudeAiOauth.accessToken, "sk-ant-oat01-abc");
		assert.equal(raw.claudeAiOauth.refreshToken, "sk-ant-ort01-xyz");
		assert.equal(raw.claudeAiOauth.expiresAt, 1_900_000_000_000);
		assert.equal(raw.claudeAiOauth.subscriptionType, "max");
		assert.deepEqual(raw.claudeAiOauth.scopes, CLAUDE_CODE_OAUTH_SCOPES);
	});
});

test("writeBrigadeClaudeCredential: missing expiry coerces to a near-future timestamp", () => {
	withTempConfigDir(() => {
		const before = Date.now();
		writeBrigadeClaudeCredential({ access: "a", refresh: "r" });
		const cred = readBrigadeClaudeCredential();
		assert.ok(cred);
		assert.ok(cred!.expiresAt > before, "expiresAt should be in the future");
	});
});

test("hasBrigadeClaudeLogin: false before, true after a write, false after clear", () => {
	withTempConfigDir(() => {
		assert.equal(hasBrigadeClaudeLogin(), false);
		writeBrigadeClaudeCredential({ access: "a", refresh: "r", expires: Date.now() + 1000 });
		assert.equal(hasBrigadeClaudeLogin(), true);
		clearBrigadeClaudeLogin();
		assert.equal(hasBrigadeClaudeLogin(), false);
	});
});

test("readBrigadeClaudeCredential: null on missing/garbage; never throws", () => {
	withTempConfigDir((dir) => {
		assert.equal(readBrigadeClaudeCredential(), null);
		fs.writeFileSync(path.join(dir, ".credentials.json"), "{ not json");
		assert.equal(readBrigadeClaudeCredential(), null);
		assert.equal(hasBrigadeClaudeLogin(), false);
	});
});
