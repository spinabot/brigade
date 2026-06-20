import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { restoreSkillsSnapshot, skillsArchiveRoot, skillsSnapshotsRoot } from "./skill-curator.js";
import {
	parseSkillConsolidation,
	runSkillConsolidation,
	type SkillConsolidationLlm,
} from "./skill-consolidate.js";
import { recordSkillCreated, setSkillPinned } from "./skill-usage.js";

const T0 = 1_700_000_000_000;
let tmp: string;
let root: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-skillcons-"));
	root = path.join(tmp, "skills");
	fs.mkdirSync(root, { recursive: true });
});
afterEach(() => {
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/** Write an agent-created skill (with a usage record so it's curation-eligible). */
function writeSkill(name: string, body = "the procedure"): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`, "utf8");
	recordSkillCreated(root, name, T0);
}
function llm(plan: unknown): SkillConsolidationLlm {
	return async () => JSON.stringify(plan);
}
const live = (name: string) => fs.existsSync(path.join(root, name, "SKILL.md"));
const archived = (name: string) => fs.existsSync(path.join(skillsArchiveRoot(root), name, "SKILL.md"));

describe("parseSkillConsolidation", () => {
	it("parses merges + prunes", () => {
		const p = parseSkillConsolidation('{"merges":[{"keeper":"a","fold":["b"],"section":"## x"}],"prunes":["c"]}');
		assert.equal(p.merges.length, 1);
		assert.equal(p.merges[0]?.keeper, "a");
		assert.deepEqual(p.merges[0]?.fold, ["b"]);
		assert.deepEqual(p.prunes, ["c"]);
	});
	it("drops malformed merges + tolerates garbage", () => {
		assert.deepEqual(parseSkillConsolidation("no json"), { merges: [], prunes: [] });
		// keeper empty, fold empty, section missing → all dropped
		assert.deepEqual(
			parseSkillConsolidation('{"merges":[{"keeper":"","fold":["b"],"section":"x"},{"keeper":"a","fold":[],"section":"x"}],"prunes":[]}'),
			{ merges: [], prunes: [] },
		);
	});
});

describe("runSkillConsolidation", () => {
	it("no-op below minSkills (no LLM-driven change)", async () => {
		writeSkill("a");
		writeSkill("b");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "a", fold: ["b"], section: "## x" }], prunes: [] }),
			now: T0,
		});
		assert.equal(res.ran, false);
		assert.ok(live("b"));
	});

	it("merges a fold skill into the keeper: appends the section + archives the sibling", async () => {
		writeSkill("deploy");
		writeSkill("deployment", "deploy v2 details");
		writeSkill("ship");
		writeSkill("release");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "deploy", fold: ["deployment"], section: "## From deployment\n\nv2 notes" }], prunes: [] }),
			now: T0,
		});
		assert.equal(res.merged, 1);
		assert.match(fs.readFileSync(path.join(root, "deploy", "SKILL.md"), "utf8"), /v2 notes/); // keeper got it
		assert.equal(live("deployment"), false); // sibling gone from live
		assert.ok(archived("deployment")); // …and recoverable in the archive
		assert.ok(live("deploy")); // keeper survives
	});

	it("prunes an obsolete skill (archives it)", async () => {
		writeSkill("a");
		writeSkill("b");
		writeSkill("c");
		writeSkill("obsolete");
		const res = await runSkillConsolidation({ skillsRoot: root, llm: llm({ merges: [], prunes: ["obsolete"] }), now: T0 });
		assert.equal(res.pruned, 1);
		assert.equal(live("obsolete"), false);
		assert.ok(archived("obsolete"));
	});

	it("rejects a hallucinated keeper (name not in the list)", async () => {
		writeSkill("a");
		writeSkill("b");
		writeSkill("c");
		writeSkill("d");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "ghost", fold: ["a"], section: "## x" }], prunes: [] }),
			now: T0,
		});
		assert.equal(res.merged, 0);
		assert.ok(live("a")); // nothing folded into a non-existent keeper
	});

	it("the keeper always survives, even on an aggressive 3→1 merge", async () => {
		writeSkill("umbrella");
		writeSkill("x");
		writeSkill("y");
		writeSkill("z");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "umbrella", fold: ["x", "y", "z"], section: "## merged" }], prunes: [] }),
			now: T0,
		});
		assert.equal(res.merged, 3);
		assert.ok(live("umbrella")); // keeper survives
		assert.equal(live("x"), false);
		assert.equal(live("z"), false);
	});

	it("never touches a pinned skill", async () => {
		writeSkill("a");
		writeSkill("b");
		writeSkill("c");
		writeSkill("d");
		setSkillPinned(root, "b", true, T0);
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "a", fold: ["b"], section: "## x" }], prunes: ["b"] }),
			now: T0,
		});
		assert.equal(res.merged, 0); // b is pinned → not a candidate → can't be folded
		assert.ok(live("b"));
	});

	it("dry-run: surfaces the plan + writes a report but applies NOTHING", async () => {
		writeSkill("deploy");
		writeSkill("deployment", "v2");
		writeSkill("ship");
		writeSkill("release");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "deploy", fold: ["deployment"], section: "## x\n\nnotes" }], prunes: [] }),
			now: T0,
			dryRun: true,
		});
		assert.equal(res.ran, true);
		assert.equal(res.dryRun, true);
		assert.equal(res.merged, 0);
		assert.equal(res.plan.merges.length, 1); // the plan IS surfaced for preview
		assert.ok(live("deployment")); // …but nothing was applied
		assert.equal(res.snapshotPath, undefined); // no snapshot on a dry-run
		const report = path.join(skillsSnapshotsRoot(root), `report-${T0}.json`);
		assert.ok(fs.existsSync(report), "a dry-run report was written");
		assert.match(fs.readFileSync(report, "utf8"), /"dryRun": true/);
	});

	it("snapshots the full library before applying + records the rename-map", async () => {
		writeSkill("deploy");
		writeSkill("deployment", "v2 details");
		writeSkill("ship");
		writeSkill("release");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "deploy", fold: ["deployment"], section: "## From deployment\n\nv2" }], prunes: [] }),
			now: T0,
		});
		assert.equal(res.merged, 1);
		assert.deepEqual(res.appliedMerges, [{ keeper: "deploy", folded: ["deployment"] }]);
		assert.ok(res.snapshotPath, "a snapshot path was returned");
		// the snapshot captured the PRE-merge state
		assert.ok(fs.existsSync(path.join(res.snapshotPath ?? "", "deployment", "SKILL.md")));
		assert.ok(!fs.readFileSync(path.join(res.snapshotPath ?? "", "deploy", "SKILL.md"), "utf8").includes("v2"));
	});

	it("restoreSkillsSnapshot rolls back a consolidation, undoing the keeper append", async () => {
		writeSkill("deploy");
		writeSkill("deployment", "v2 details");
		writeSkill("ship");
		writeSkill("release");
		const res = await runSkillConsolidation({
			skillsRoot: root,
			llm: llm({ merges: [{ keeper: "deploy", fold: ["deployment"], section: "## From deployment\n\nrollback-marker" }], prunes: [] }),
			now: T0,
		});
		assert.ok(res.snapshotPath);
		assert.equal(live("deployment"), false);
		assert.match(fs.readFileSync(path.join(root, "deploy", "SKILL.md"), "utf8"), /rollback-marker/);
		const r = restoreSkillsSnapshot(root, res.snapshotPath ?? "", T0 + 1000);
		assert.equal(r.ok, true);
		assert.ok(live("deployment"), "folded skill is live again after rollback");
		assert.ok(
			!fs.readFileSync(path.join(root, "deploy", "SKILL.md"), "utf8").includes("rollback-marker"),
			"keeper's appended section is undone",
		);
	});
});
