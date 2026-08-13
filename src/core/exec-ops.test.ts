import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { _resetApprovalsCacheForTests } from "./exec-approvals.js";
import { CATASTROPHIC_TRIO, nestedQuantifier } from "./exec-pattern-fixtures.js";
import {
	handleExecAllow,
	handleExecAllowPattern,
	handleExecDenyTest,
	handleExecList,
	handleExecRemove,
} from "./exec-ops.js";

let prevStateDir: string | undefined;

beforeEach(() => {
	const stateDir = mkdtempSync(join(tmpdir(), "brigade-exec-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	_resetApprovalsCacheForTests();
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	_resetApprovalsCacheForTests();
});

test("allow → list shows the exact command", () => {
	const r = handleExecAllow({ command: "ls -la" });
	assert.equal(r.ok, true);
	assert.equal(r.kind, "exact");
	const list = handleExecList({});
	assert.deepEqual(list.commands, ["ls -la"]);
	assert.deepEqual(list.patterns, []);
});

test("allow-pattern → list shows the pattern; invalid regex rejected", () => {
	assert.equal(handleExecAllowPattern({ pattern: "^git (status|diff)" }).ok, true);
	assert.deepEqual(handleExecList({}).patterns, ["^git (status|diff)"]);
	const bad = handleExecAllowPattern({ pattern: "[unclosed" });
	assert.equal(bad.ok, false);
	assert.match(bad.reason ?? "", /invalid regex/);
});

test("allow refuses a hard-deny command", () => {
	const r = handleExecAllow({ command: "rm -rf /" });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /hard-deny/);
});

test("remove drops a command; not-found reports ok:false", () => {
	handleExecAllow({ command: "echo hi" });
	const rm = handleExecRemove({ value: "echo hi" });
	assert.equal(rm.ok, true);
	assert.equal(rm.removedCommands, 1);
	assert.deepEqual(handleExecList({}).commands, []);
	assert.equal(handleExecRemove({ value: "nope" }).ok, false);
});

test("deny-test classifies allow / prompt / deny", () => {
	handleExecAllow({ command: "ls" });
	assert.equal(handleExecDenyTest({ command: "ls" }).decision, "allow");
	assert.equal(handleExecDenyTest({ command: "some-unapproved-cmd" }).decision, "prompt");
	assert.equal(handleExecDenyTest({ command: "rm -rf /" }).decision, "deny");
});

test("empty command / pattern → ok:false", () => {
	assert.equal(handleExecAllow({ command: "   " }).ok, false);
	assert.equal(handleExecAllowPattern({ pattern: "" }).ok, false);
});

/* ─────────────── pattern guard over the RPC (remote-reachable) ─────────────── */

test("allow-pattern refuses a catastrophically backtracking regex", () => {
	for (const pattern of CATASTROPHIC_TRIO) {
		const started = Date.now();
		const r = handleExecAllowPattern({ pattern });
		const elapsed = Date.now() - started;
		assert.equal(r.ok, false, `stored a catastrophic pattern: ${pattern}`);
		assert.match(r.reason ?? "", /backtracks catastrophically/);
		assert.ok(elapsed < 2000, `${pattern} took ${elapsed}ms — the guard should bail early`);
	}
	assert.deepEqual(handleExecList({}).patterns, [], "nothing reached the store");
});

test("allow-pattern still accepts realistic allowlist patterns", () => {
	const patterns = [
		"^git (status|diff|log)( |$)",
		"^cat package\\.json$",
		"^npm (run|ci|test)\\b.*",
		"^ls( -[a-zA-Z]+)*( |$)",
	];
	for (const pattern of patterns) {
		assert.equal(handleExecAllowPattern({ pattern }).ok, true, `refused: ${pattern}`);
	}
	assert.deepEqual(handleExecList({}).patterns, patterns);
	assert.equal(handleExecDenyTest({ command: "git log --oneline" }).decision, "allow");
	assert.equal(handleExecDenyTest({ command: "npm run build" }).decision, "allow");
	assert.equal(handleExecDenyTest({ command: "git push --force" }).decision, "prompt");
});

test("allow-pattern refuses a pattern past the length cap", () => {
	const r = handleExecAllowPattern({ pattern: `^${"a".repeat(600)}$` });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /too long/);
	assert.deepEqual(handleExecList({}).patterns, []);
});

test("allow-pattern reasons carry the remediation hint for remote clients", () => {
	const r = handleExecAllowPattern({ pattern: nestedQuantifier("a") });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /write `a\+` instead of `\(a\+\)\+`/);
});
