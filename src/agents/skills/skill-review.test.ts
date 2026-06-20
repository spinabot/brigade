import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveAgentWorkspaceDir } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { discoverEligibleSkills } from "./index.js";
import {
	makeSkillReviewer,
	parseSkillProposals,
	runSkillReview,
	shouldReviewSkills,
	type SkillProposal,
	type SkillReviewer,
} from "./skill-review.js";

let tmpRoot: string;
let prevState: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-skillrev-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevConfig = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	process.env.BRIGADE_CONFIG_PATH = path.join(tmpRoot, "brigade.json");
	fs.writeFileSync(path.join(tmpRoot, "brigade.json"), JSON.stringify({ agents: {} }, null, 2), "utf8");
});

afterEach(() => {
	process.env.BRIGADE_STATE_DIR = prevState;
	process.env.BRIGADE_CONFIG_PATH = prevConfig;
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/** A reviewer seam that returns a fixed proposal list (no model). */
function fakeReviewer(proposals: SkillProposal[]): SkillReviewer {
	return async () => proposals;
}

describe("shouldReviewSkills", () => {
	it("fires at/after the interval; 0 disables", () => {
		assert.equal(shouldReviewSkills(5, 6), false);
		assert.equal(shouldReviewSkills(6, 6), true);
		assert.equal(shouldReviewSkills(7, 6), true);
		assert.equal(shouldReviewSkills(100, 0), false);
	});
});

describe("parseSkillProposals", () => {
	it("parses a valid proposal", () => {
		const out = parseSkillProposals(
			'{"skills":[{"name":"a-b","description":"d","body":"# A\\n\\nx","reason":"r"}]}',
		);
		assert.equal(out.length, 1);
		assert.equal(out[0]?.name, "a-b");
		assert.equal(out[0]?.reason, "r");
	});

	it("ignores prose wrapping AND a leading stray object", () => {
		const out = parseSkillProposals(
			'thinking... {} then {"skills":[{"name":"x","description":"d","body":"b"}]}',
		);
		assert.deepEqual(
			out.map((s) => s.name),
			["x"],
		);
	});

	it("skips malformed elements", () => {
		const out = parseSkillProposals(
			'{"skills":[null,{"name":""},{"name":"ok","description":"d","body":""},{"name":"good","description":"d","body":"b"}]}',
		);
		assert.deepEqual(
			out.map((s) => s.name),
			["good"],
		);
	});

	it("garbage / empty → []", () => {
		assert.deepEqual(parseSkillProposals(""), []);
		assert.deepEqual(parseSkillProposals("no json at all"), []);
		assert.deepEqual(parseSkillProposals('{"skills":[]}'), []);
	});
});

describe("runSkillReview", () => {
	it("writes a new skill to the agent's own workspace and it's discoverable next turn", async () => {
		const res = await runSkillReview({
			transcript: "USER: deploy notes\nASSISTANT: here's the runbook",
			reviewer: fakeReviewer([
				{ name: "deploy-runbook", description: "How to deploy the service", body: "# deploy-runbook\n\nstep 1 do the thing" },
			]),
			agentId: "main",
		});
		assert.deepEqual(res.created, ["deploy-runbook"]);
		const file = path.join(tmpRoot, "workspace", "skills", "deploy-runbook", "SKILL.md");
		assert.ok(fs.existsSync(file), "SKILL.md must exist on disk");
		const onDisk = fs.readFileSync(file, "utf8");
		assert.match(onDisk, /^---\nname: deploy-runbook\n/);
		assert.match(onDisk, /step 1 do the thing/);
		// Round-trip: the learned skill is discovered for the agent's next turn.
		const cfg = loadConfig();
		const disc = discoverEligibleSkills({
			workspaceDir: resolveAgentWorkspaceDir("main"),
			config: cfg,
			agentId: "main",
		});
		assert.ok(
			disc.skills.map((s) => s.name).includes("deploy-runbook"),
			`learned skill must surface; got ${JSON.stringify(disc.skills.map((s) => s.name))}`,
		);
	});

	it("dedups against an existing skill and NEVER clobbers it", async () => {
		const first = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "note-taker", description: "d", body: "original body" }]),
			agentId: "main",
		});
		assert.deepEqual(first.created, ["note-taker"]);
		const second = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "note-taker", description: "d2", body: "DIFFERENT body" }]),
			agentId: "main",
		});
		assert.deepEqual(second.created, []);
		assert.match(second.skipped[0]?.reason ?? "", /already exists/);
		const onDisk = fs.readFileSync(
			path.join(tmpRoot, "workspace", "skills", "note-taker", "SKILL.md"),
			"utf8",
		);
		assert.match(onDisk, /original body/);
		assert.doesNotMatch(onDisk, /DIFFERENT body/);
	});

	it("caps at the per-review maximum (anti-fragmentation)", async () => {
		const res = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([
				{ name: "one", description: "d", body: "b" },
				{ name: "two", description: "d", body: "b" },
				{ name: "three", description: "d", body: "b" },
			]),
			agentId: "main",
		});
		assert.equal(res.created.length, 2);
		assert.ok(res.skipped.some((s) => /cap reached/.test(s.reason)));
	});

	it("patches an existing skill (mode=patch appends a section)", async () => {
		await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "deploy-runbook", description: "d", body: "# deploy-runbook\n\nstep 1" }]),
			agentId: "main",
		});
		const res = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([
				{ name: "deploy-runbook", description: "", body: "## Pitfall\n\nrotate the key first", mode: "patch" },
			]),
			agentId: "main",
		});
		assert.deepEqual(res.patched, ["deploy-runbook"]);
		assert.deepEqual(res.created, []);
		const onDisk = fs.readFileSync(
			path.join(tmpRoot, "workspace", "skills", "deploy-runbook", "SKILL.md"),
			"utf8",
		);
		assert.match(onDisk, /step 1/); // original kept
		assert.match(onDisk, /rotate the key first/); // refinement appended
	});

	it("a patch to a non-existent skill is skipped (never creates via patch)", async () => {
		const res = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "ghost", description: "", body: "## x", mode: "patch" }]),
			agentId: "main",
		});
		assert.deepEqual(res.patched, []);
		assert.deepEqual(res.created, []);
		assert.match(res.skipped[0]?.reason ?? "", /does not exist/);
		assert.equal(fs.existsSync(path.join(tmpRoot, "workspace", "skills", "ghost")), false);
	});

	it("a patch whose section is already present is skipped (dedup)", async () => {
		await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "note-taker", description: "d", body: "# note-taker\n\nuse bullets" }]),
			agentId: "main",
		});
		const res = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "note-taker", description: "", body: "use bullets", mode: "patch" }]),
			agentId: "main",
		});
		assert.deepEqual(res.patched, []);
		assert.match(res.skipped[0]?.reason ?? "", /already present/);
	});

	it("skips an unsafe name without writing anything outside the scope", async () => {
		const res = await runSkillReview({
			transcript: "t",
			reviewer: fakeReviewer([{ name: "../escape", description: "d", body: "b" }]),
			agentId: "main",
		});
		assert.deepEqual(res.created, []);
		assert.equal(res.skipped[0]?.reason, "unsafe name");
		assert.equal(fs.existsSync(path.join(tmpRoot, "escape")), false);
	});

	it("is best-effort: a reviewer error is a no-op, never thrown", async () => {
		const res = await runSkillReview({
			transcript: "t",
			reviewer: async () => {
				throw new Error("boom");
			},
			agentId: "main",
		});
		assert.deepEqual(res.created, []);
		assert.match(res.summary, /reviewer error/);
	});

	it("empty proposals → nothing learned", async () => {
		const res = await runSkillReview({ transcript: "t", reviewer: fakeReviewer([]), agentId: "main" });
		assert.deepEqual(res.created, []);
		assert.match(res.summary, /nothing to learn/);
	});
});

describe("makeSkillReviewer", () => {
	it("builds a reviewer function without invoking a model at construction", () => {
		const reviewer = makeSkillReviewer({
			workspaceDir: tmpRoot,
			agentDir: tmpRoot,
			authStorage: {},
			modelRegistry: {},
			model: {},
		});
		assert.equal(typeof reviewer, "function");
	});
});
