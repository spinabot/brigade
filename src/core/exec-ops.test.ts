import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { _resetApprovalsCacheForTests } from "./exec-approvals.js";
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
