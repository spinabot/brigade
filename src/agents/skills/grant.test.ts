/**
 * Skill command-grant tests (point 3b). Writes a skill with a command
 * manifest into a temp workspace + a temp state dir, then exercises
 * preview → grant → revoke through the real exec-approvals store.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-grant-"));
const prevState = process.env.BRIGADE_STATE_DIR;
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
process.env.BRIGADE_STATE_DIR = tmp;
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { grantSkill, revokeSkill } = await import("./grant.js");
const { decideApproval, _resetApprovalsCacheForTests } = await import("../../core/exec-approvals.js");
const { clearBinaryCache } = await import("./eligibility.js");

const workspaceDir = path.join(tmp, "ws");

function writeSkill(name: string, frontmatterExtra: string): void {
	const dir = path.join(workspaceDir, "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} skill\n${frontmatterExtra}\n---\nBody.\n`,
		"utf8",
	);
}

const cfg = {} as never;

before(() => {
	writeSkill(
		"gmail-oauth",
		['commands:', '  - "node oauth-flow.mjs"', "command-patterns:", '  - "^node .*gmail-oauth"'].join("\n"),
	);
	writeSkill("danger", ['commands:', '  - "rm -rf /"', '  - "ls -la"'].join("\n"));
	writeSkill("nocmds", "emoji: 🎯");
});

beforeEach(() => {
	_resetApprovalsCacheForTests();
	try {
		fs.rmSync(path.join(tmp, "agents"), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	clearBinaryCache();
});

after(() => {
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = prevProfile;
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("grantSkill / revokeSkill", () => {
	it("preview (apply:false) reports the manifest but does NOT approve", () => {
		const res = grantSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "gmail-oauth", apply: false });
		assert.equal(res.found, true);
		assert.equal(res.applied, false);
		assert.deepEqual(res.manifest.commands, ["node oauth-flow.mjs"]);
		assert.deepEqual(res.manifest.patterns, ["^node .*gmail-oauth"]);
		// Nothing recorded yet — the command still prompts.
		assert.equal(decideApproval("node oauth-flow.mjs", "acc"), "prompt");
	});

	it("apply:true approves the skill's commands AND patterns for that agent", () => {
		const res = grantSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "gmail-oauth", apply: true });
		assert.equal(res.applied, true);
		assert.equal(decideApproval("node oauth-flow.mjs", "acc"), "allow");
		// Pattern matches a different-but-covered command.
		assert.equal(decideApproval("node scripts/gmail-oauth/send.mjs", "acc"), "allow");
		// Scoped to the agent — a different agent is unaffected.
		assert.equal(decideApproval("node oauth-flow.mjs", "other"), "prompt");
	});

	it("refuses hard-deny commands in the manifest, grants the rest", () => {
		const res = grantSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "danger", apply: true });
		assert.ok(res.refused.includes("rm -rf /"));
		assert.deepEqual(res.granted.commands, ["ls -la"]);
		assert.equal(decideApproval("ls -la", "acc"), "allow");
		// rm -rf / stays hard-denied regardless.
		assert.equal(decideApproval("rm -rf /", "acc"), "deny");
	});

	it("a skill with no manifest reports emptyManifest", () => {
		const res = grantSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "nocmds", apply: true });
		assert.equal(res.found, true);
		assert.equal(res.emptyManifest, true);
		assert.equal(res.applied, false);
	});

	it("unknown skill → found:false", () => {
		const res = grantSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "ghost", apply: true });
		assert.equal(res.found, false);
	});

	it("revoke removes the granted commands", () => {
		grantSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "gmail-oauth", apply: true });
		assert.equal(decideApproval("node oauth-flow.mjs", "acc"), "allow");
		const r = revokeSkill({ config: cfg, workspaceDir, agentId: "acc", skillName: "gmail-oauth" });
		assert.equal(r.found, true);
		assert.ok(r.removed >= 1);
		assert.equal(decideApproval("node oauth-flow.mjs", "acc"), "prompt");
	});
});
