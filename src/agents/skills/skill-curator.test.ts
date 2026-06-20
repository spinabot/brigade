import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	archiveSkill,
	detectAndRecordSkillUses,
	restoreSkill,
	runSkillCurator,
	skillsArchiveRoot,
} from "./skill-curator.js";
import {
	listCurationCandidates,
	loadUsage,
	recordSkillCreated,
	recordSkillUse,
	setSkillPinned,
	setSkillState,
} from "./skill-usage.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed epoch ms for determinism

let tmp: string;
let root: string; // the skills root

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-skillcur-"));
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

/** Write `<root>/<name>/SKILL.md`. */
function writeSkill(name: string, body = "the procedure"): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`, "utf8");
}

describe("skill-usage sidecar", () => {
	it("recordSkillCreated marks agent provenance + anchors createdAt", () => {
		writeSkill("a-skill");
		recordSkillCreated(root, "a-skill", T0);
		const rec = loadUsage(root)["a-skill"];
		assert.equal(rec?.createdBy, "agent");
		assert.equal(rec?.state, "active");
		assert.equal(rec?.lastUsedAt, null);
		assert.equal(new Date(rec!.createdAt).getTime(), T0);
	});

	it("recordSkillUse bumps count + lastUsedAt (no state flip — curator owns that)", () => {
		writeSkill("a-skill");
		recordSkillCreated(root, "a-skill", T0);
		setSkillState(root, "a-skill", "stale", T0);
		recordSkillUse(root, "a-skill", T0 + DAY);
		const rec = loadUsage(root)["a-skill"];
		assert.equal(rec?.useCount, 1);
		assert.equal(new Date(rec!.lastUsedAt!).getTime(), T0 + DAY);
		assert.equal(rec?.state, "stale"); // bump_use does NOT flip — the curator does
	});

	it("listCurationCandidates returns only agent-created skills present on disk", () => {
		writeSkill("agent-made");
		recordSkillCreated(root, "agent-made", T0);
		writeSkill("hand-authored"); // on disk, but no record → not managed
		const names = listCurationCandidates(root, T0).map((c) => c.name);
		assert.deepEqual(names, ["agent-made"]);
	});
});

describe("runSkillCurator — pure age transitions", () => {
	it("archives an agent skill unused past archiveAfterDays (and moves the dir aside)", () => {
		writeSkill("stale-one");
		recordSkillCreated(root, "stale-one", T0);
		const counts = runSkillCurator({
			skillsRoot: root,
			staleAfterDays: 30,
			archiveAfterDays: 90,
			now: T0 + 100 * DAY,
		});
		assert.equal(counts.archived, 1);
		// Live dir gone, archived under the sibling archive root, state archived.
		assert.equal(fs.existsSync(path.join(root, "stale-one", "SKILL.md")), false);
		assert.ok(fs.existsSync(path.join(skillsArchiveRoot(root), "stale-one", "SKILL.md")));
		assert.equal(loadUsage(root)["stale-one"]?.state, "archived");
	});

	it("marks stale (not archived) between the two cutoffs", () => {
		writeSkill("aging");
		recordSkillCreated(root, "aging", T0);
		const counts = runSkillCurator({
			skillsRoot: root,
			staleAfterDays: 30,
			archiveAfterDays: 90,
			now: T0 + 45 * DAY,
		});
		assert.equal(counts.markedStale, 1);
		assert.equal(counts.archived, 0);
		assert.equal(loadUsage(root)["aging"]?.state, "stale");
		assert.ok(fs.existsSync(path.join(root, "aging", "SKILL.md"))); // still live
	});

	it("reactivates a stale skill that was used again", () => {
		writeSkill("revived");
		recordSkillCreated(root, "revived", T0);
		setSkillState(root, "revived", "stale", T0 + 40 * DAY);
		recordSkillUse(root, "revived", T0 + 89 * DAY); // fresh use, but state still stale
		const counts = runSkillCurator({
			skillsRoot: root,
			staleAfterDays: 30,
			archiveAfterDays: 90,
			now: T0 + 90 * DAY,
		});
		assert.equal(counts.reactivated, 1);
		assert.equal(loadUsage(root)["revived"]?.state, "active");
	});

	it("never touches a pinned skill", () => {
		writeSkill("keep-me");
		recordSkillCreated(root, "keep-me", T0);
		setSkillPinned(root, "keep-me", true, T0);
		const counts = runSkillCurator({
			skillsRoot: root,
			staleAfterDays: 30,
			archiveAfterDays: 90,
			now: T0 + 1000 * DAY,
		});
		assert.equal(counts.checked, 1);
		assert.equal(counts.archived, 0);
		assert.ok(fs.existsSync(path.join(root, "keep-me", "SKILL.md")));
	});

	it("never touches a hand-authored skill (no agent record)", () => {
		writeSkill("by-hand"); // no recordSkillCreated
		const counts = runSkillCurator({
			skillsRoot: root,
			staleAfterDays: 0,
			archiveAfterDays: 0,
			now: T0 + 1000 * DAY,
		});
		assert.equal(counts.checked, 0);
		assert.ok(fs.existsSync(path.join(root, "by-hand", "SKILL.md")));
	});

	it("a used skill stays alive past the archive cutoff (use resets the anchor)", () => {
		writeSkill("active-one");
		recordSkillCreated(root, "active-one", T0);
		recordSkillUse(root, "active-one", T0 + 95 * DAY); // used recently
		const counts = runSkillCurator({
			skillsRoot: root,
			staleAfterDays: 30,
			archiveAfterDays: 90,
			now: T0 + 100 * DAY, // anchor (95d) is only 5d old → fresh
		});
		assert.equal(counts.archived, 0);
		assert.equal(counts.markedStale, 0);
		assert.ok(fs.existsSync(path.join(root, "active-one", "SKILL.md")));
	});
});

describe("archive / restore round-trip", () => {
	it("archive then restore returns the skill to the live root", () => {
		writeSkill("trip");
		recordSkillCreated(root, "trip", T0);
		const a = archiveSkill(root, "trip", T0);
		assert.equal(a.ok, true);
		assert.equal(fs.existsSync(path.join(root, "trip", "SKILL.md")), false);
		const r = restoreSkill(root, "trip", T0 + DAY);
		assert.equal(r.ok, true);
		assert.ok(fs.existsSync(path.join(root, "trip", "SKILL.md")));
		assert.equal(loadUsage(root)["trip"]?.state, "active");
	});

	it("restore refuses to clobber a live skill of the same name", () => {
		writeSkill("dup");
		recordSkillCreated(root, "dup", T0);
		archiveSkill(root, "dup", T0);
		writeSkill("dup"); // a new live one appears
		const r = restoreSkill(root, "dup", T0 + DAY);
		assert.equal(r.ok, false);
		assert.match(r.message, /already exists/);
	});
});

describe("detectAndRecordSkillUses", () => {
	it("bumps use when a skill's SKILL.md path appears in the messages", () => {
		writeSkill("deploy-runbook");
		recordSkillCreated(root, "deploy-runbook", T0);
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: `${root}/deploy-runbook/SKILL.md` } }] },
		];
		const used = detectAndRecordSkillUses(root, messages, T0 + DAY);
		assert.deepEqual(used, ["deploy-runbook"]);
		assert.equal(loadUsage(root)["deploy-runbook"]?.useCount, 1);
	});

	it("does NOT bump on a bare skill name in chat (no SKILL.md read)", () => {
		writeSkill("note-taker");
		recordSkillCreated(root, "note-taker", T0);
		const messages = [{ role: "user", content: "use the note-taker approach please" }];
		const used = detectAndRecordSkillUses(root, messages, T0 + DAY);
		assert.deepEqual(used, []);
		assert.equal(loadUsage(root)["note-taker"]?.useCount, 0);
	});
});
