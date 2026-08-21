import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	CLAUDE_CODE_OAUTH_SCOPES,
	clearBrigadeClaudeLogin,
	clearClaudeKeychainShadow,
	healClaudeKeychainShadow,
	inspectClaudeKeychainShadow,
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

// ── keychain shadow (macOS) ─────────────────────────────────────────────────
// On macOS the `claude` binary reads its credential from the login keychain,
// which OUTRANKS `<configDir>/.credentials.json`. A tombstoned shadow (empty
// accessToken) therefore made every turn fail with "OAuth session expired" and
// was unrecoverable by re-login — we rewrote a file the binary never read.

test("healClaudeKeychainShadow: reports 'none' when no shadow exists", () => {
	withTempConfigDir(() => {
		// A fresh temp dir hashes to a service name nothing has ever written.
		assert.equal(healClaudeKeychainShadow(), "none");
	});
});

test("clearClaudeKeychainShadow: absent entry is not an error", () => {
	withTempConfigDir(() => {
		// No entry to delete — must return false rather than throw, so the write
		// path never fails just because the shadow was already clean.
		assert.equal(clearClaudeKeychainShadow(), false);
	});
});

test("writeBrigadeClaudeCredential: still writes the file when no shadow exists", () => {
	withTempConfigDir((dir) => {
		writeBrigadeClaudeCredential({ access: "acc-1", refresh: "ref-1", expires: Date.now() + 3_600_000 });
		const raw = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")) as {
			claudeAiOauth: { accessToken: string };
		};
		assert.equal(raw.claudeAiOauth.accessToken, "acc-1");
		assert.equal(hasBrigadeClaudeLogin(), true);
	});
});

test("claude keychain service name is derived from the config dir", () => {
	// Two different dirs must never collide onto one keychain entry — that would
	// let one Brigade install tombstone another's login.
	withTempConfigDir(() => {
		assert.equal(healClaudeKeychainShadow("/tmp/brigade-kc-a"), "none");
		assert.equal(healClaudeKeychainShadow("/tmp/brigade-kc-b"), "none");
	});
});

test("inspectClaudeKeychainShadow: read-only — reports 'none' and changes nothing", () => {
	withTempConfigDir((dir) => {
		writeBrigadeClaudeCredential({ access: "acc-1", refresh: "ref-1", expires: Date.now() + 3_600_000 });
		const before = fs.readFileSync(path.join(dir, ".credentials.json"), "utf8");
		const state = inspectClaudeKeychainShadow();
		// A temp dir hashes to a service nothing has written; on non-darwin the
		// concept does not apply at all.
		assert.ok(state === "none" || state === "unsupported");
		// A diagnostic that mutates is one you cannot use to reproduce a bug.
		assert.equal(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"), before);
	});
});

test("healClaudeKeychainShadow: refuses to clear when OUR credential is unusable", () => {
	withTempConfigDir((dir) => {
		// Empty access token — the shadow may hold the only refresh token left,
		// so clearing it would destroy the last way back in.
		fs.writeFileSync(
			path.join(dir, ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }),
		);
		assert.equal(healClaudeKeychainShadow(), "none");
	});
});
