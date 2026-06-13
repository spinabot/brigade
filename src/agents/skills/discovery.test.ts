import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverSkills } from "./discovery.js";
import { clearBinaryCache, type EligibilityEnv } from "./eligibility.js";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-skills-"));
});
afterEach(() => {
	clearBinaryCache();
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/** Write a skill folder `<base>/<name>/SKILL.md` with frontmatter + body. */
function writeSkill(base: string, name: string, frontmatter: string, body = "Body."): void {
	const dir = path.join(base, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n${frontmatter}\n---\n${body}\n`, "utf8");
}

const LINUX: EligibilityEnv = { platform: "linux", env: { PATH: "" } };

describe("discoverSkills", () => {
	it("discovers a workspace skill and renders the prompt block", () => {
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "alpha", "description: Does alpha things.");
		const res = discoverSkills({ workspaceSkillsDir: ws, eligibilityCtx: LINUX });
		assert.equal(res.skills.length, 1);
		assert.equal(res.skills[0]?.name, "alpha");
		assert.equal(res.skills[0]?.source, "workspace");
		assert.ok(res.promptBlock?.includes("<available_skills>"));
		assert.ok(res.promptBlock?.includes("alpha"));
		assert.ok(res.promptBlock?.includes("Does alpha things."));
	});

	it("returns an undefined promptBlock when nothing is eligible", () => {
		const ws = path.join(root, "ws", "skills"); // missing dir
		const res = discoverSkills({ workspaceSkillsDir: ws, eligibilityCtx: LINUX });
		assert.equal(res.skills.length, 0);
		assert.equal(res.promptBlock, undefined);
		assert.equal(res.totalDiscovered, 0);
	});

	it("workspace shadows a same-named bundled skill (precedence)", () => {
		const bundled = path.join(root, "bundled");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(bundled, "shared", "description: BUNDLED version.");
		writeSkill(ws, "shared", "description: WORKSPACE version.");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			bundledSkillsDir: bundled,
			eligibilityCtx: LINUX,
		});
		assert.equal(res.skills.length, 1);
		assert.equal(res.skills[0]?.source, "workspace");
		assert.ok(res.promptBlock?.includes("WORKSPACE version."));
		assert.ok(!res.promptBlock?.includes("BUNDLED version."));
	});

	it("excludes a config-disabled skill by name", () => {
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "alpha", "description: a");
		writeSkill(ws, "beta", "description: b");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			disabledNames: new Set(["beta"]),
			eligibilityCtx: LINUX,
		});
		assert.deepEqual(res.skills.map((s) => s.name), ["alpha"]);
		assert.equal(res.totalDiscovered, 2); // disabled still counts as discovered
	});

	it("filters out an OS-ineligible skill but counts it as discovered", () => {
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "maconly", "description: mac\nos: macos");
		writeSkill(ws, "anyos", "description: any");
		const res = discoverSkills({ workspaceSkillsDir: ws, eligibilityCtx: LINUX });
		assert.deepEqual(res.skills.map((s) => s.name), ["anyos"]);
		assert.equal(res.totalDiscovered, 2);
	});

	it("filters out a skill whose required binary is missing", () => {
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "needsbin", "description: needs\nrequires-bins: definitely-not-real-xyz");
		const res = discoverSkills({ workspaceSkillsDir: ws, eligibilityCtx: LINUX });
		assert.equal(res.skills.length, 0);
		assert.equal(res.promptBlock, undefined);
	});

	it("merges config extraPaths between bundled and workspace precedence", () => {
		const bundled = path.join(root, "bundled");
		const extra = path.join(root, "extra");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(bundled, "only-bundled", "description: from bundled");
		writeSkill(extra, "only-extra", "description: from a config path");
		writeSkill(ws, "only-ws", "description: from workspace");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			bundledSkillsDir: bundled,
			extraPaths: [extra],
			eligibilityCtx: LINUX,
		});
		assert.deepEqual(
			res.skills.map((s) => s.name).sort(),
			["only-bundled", "only-extra", "only-ws"],
		);
	});

	it("a disable-model-invocation skill is counted but absent from the rendered block", () => {
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "hidden", 'description: hidden\n"disable-model-invocation": true');
		const res = discoverSkills({ workspaceSkillsDir: ws, eligibilityCtx: LINUX });
		// It IS eligible + discovered (shows in the count)...
		assert.equal(res.skills.length, 1);
		assert.equal(res.skills[0]?.name, "hidden");
		// ...but the model-facing block is empty → undefined (don't emit "scan
		// the list below" with nothing below).
		assert.equal(res.promptBlock, undefined);
	});

	it("sorts eligible skills by name", () => {
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "zebra", "description: z");
		writeSkill(ws, "apple", "description: a");
		writeSkill(ws, "mango", "description: m");
		const res = discoverSkills({ workspaceSkillsDir: ws, eligibilityCtx: LINUX });
		assert.deepEqual(res.skills.map((s) => s.name), ["apple", "mango", "zebra"]);
	});

	it("discovers a managed skill with source=managed (S3)", () => {
		const managed = path.join(root, "managed");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(managed, "foo", "description: managed install");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			managedSkillsDir: managed,
			eligibilityCtx: LINUX,
		});
		assert.equal(res.skills.length, 1);
		assert.equal(res.skills[0]?.name, "foo");
		assert.equal(res.skills[0]?.source, "managed");
	});

	it("discovers personal + project skills with the correct source tags (S6)", () => {
		const personal = path.join(root, "personal");
		const project = path.join(root, "project");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(personal, "perskill", "description: personal");
		writeSkill(project, "projskill", "description: project");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			personalSkillsDir: personal,
			projectSkillsDir: project,
			eligibilityCtx: LINUX,
		});
		const byName = new Map(res.skills.map((s) => [s.name, s.source]));
		assert.equal(byName.get("perskill"), "agents-skills-personal");
		assert.equal(byName.get("projskill"), "agents-skills-project");
	});

	it("workspace shadows personal which shadows managed which shadows bundled (precedence S6)", () => {
		const bundled = path.join(root, "bundled");
		const managed = path.join(root, "managed");
		const personal = path.join(root, "personal");
		const project = path.join(root, "project");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(bundled, "shared", "description: bundled");
		writeSkill(managed, "shared", "description: managed");
		writeSkill(personal, "shared", "description: personal");
		writeSkill(project, "shared", "description: project");
		writeSkill(ws, "shared", "description: workspace");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			bundledSkillsDir: bundled,
			managedSkillsDir: managed,
			personalSkillsDir: personal,
			projectSkillsDir: project,
			eligibilityCtx: LINUX,
		});
		assert.equal(res.skills.length, 1);
		assert.equal(res.skills[0]?.source, "workspace");
		assert.ok(res.promptBlock?.includes("workspace"));
	});

	it("skillAllowlist drops names not in the list — for SHARED roots (S1)", () => {
		// CONTRACT CHANGE (3a, 2026-06-13): the allowlist gates SHARED skill
		// roots only (bundled/config/org/managed/personal/project). An agent's
		// OWN workspace skills are exempt — see the workspace-exempt test below.
		// So this test exercises the allowlist against a MANAGED root, with an
		// empty workspace, to pin the shared-root semantics.
		const managed = path.join(root, "managed");
		writeSkill(managed, "alpha", "description: a");
		writeSkill(managed, "beta", "description: b");
		const ws = path.join(root, "workspace", "skills"); // empty
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			managedSkillsDir: managed,
			skillAllowlist: ["alpha"],
			eligibilityCtx: LINUX,
		});
		assert.deepEqual(res.skills.map((s) => s.name), ["alpha"]);
		// `[]` denies all SHARED skills.
		const denied = discoverSkills({
			workspaceSkillsDir: ws,
			managedSkillsDir: managed,
			skillAllowlist: [],
			eligibilityCtx: LINUX,
		});
		assert.equal(denied.skills.length, 0);
	});

	it("an agent's OWN workspace skills are EXEMPT from the allowlist (3a)", () => {
		// Regression: setting a shared `agents.defaults.skills` allowlist used to
		// silently blind every agent to its self-authored workspace skills.
		const ws = path.join(root, "workspace", "skills");
		writeSkill(ws, "mine", "description: self-authored");
		// Even a deny-all allowlist leaves the agent's own workspace skill visible.
		const denied = discoverSkills({
			workspaceSkillsDir: ws,
			skillAllowlist: [],
			eligibilityCtx: LINUX,
		});
		assert.deepEqual(denied.skills.map((s) => s.name), ["mine"]);
		assert.equal(denied.skills[0]?.source, "workspace");
		// A non-matching allowlist still leaves it visible (own ≠ shared).
		const filtered = discoverSkills({
			workspaceSkillsDir: ws,
			skillAllowlist: ["something-else"],
			eligibilityCtx: LINUX,
		});
		assert.deepEqual(filtered.skills.map((s) => s.name), ["mine"]);
	});

	it("orgSkillRoots surface as `org:<id>` and never shadow a local skill (3c)", () => {
		// A peer (org-visible) skill is tagged org:<id> and ranks below every
		// operator-placed root, so a same-named workspace skill wins.
		const peer = path.join(root, "peer-skills");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(peer, "shared", "description: PEER version.");
		writeSkill(peer, "peeronly", "description: from a peer.");
		writeSkill(ws, "shared", "description: OWN version.");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			orgSkillRoots: [{ dir: peer, agentId: "accountant" }],
			eligibilityCtx: LINUX,
		});
		const byName = new Map(res.skills.map((s) => [s.name, s]));
		assert.equal(byName.get("peeronly")?.source, "org:accountant");
		// Collision: own workspace beats the peer.
		assert.equal(byName.get("shared")?.source, "workspace");
		assert.ok(res.promptBlock?.includes("OWN version."));
		assert.ok(!res.promptBlock?.includes("PEER version."));
	});

	it("org-visible skills ARE still gated by the allowlist (only OWN workspace is exempt) (3c)", () => {
		const peer = path.join(root, "peer-skills");
		const ws = path.join(root, "workspace", "skills");
		writeSkill(peer, "peerskill", "description: from a peer.");
		writeSkill(ws, "mine", "description: own.");
		const res = discoverSkills({
			workspaceSkillsDir: ws,
			orgSkillRoots: [{ dir: peer, agentId: "cfo" }],
			skillAllowlist: [], // deny-all
			eligibilityCtx: LINUX,
		});
		// Own survives (exempt); the peer's skill is dropped by the allowlist.
		assert.deepEqual(res.skills.map((s) => s.name), ["mine"]);
	});
});
