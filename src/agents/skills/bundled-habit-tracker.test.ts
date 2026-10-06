/**
 * Guards the bundled `habit-tracker` skill — the SHIPPED assets, not fixtures.
 *
 * Same pattern as the job-search guard: without these checks a broken
 * frontmatter or a syntax-errored script would only surface at a user's
 * first habit session. Three layers:
 *
 *   1. Discovery + spec conformance — the skill is found via the real
 *      bundled root and its frontmatter satisfies the Agent Skills
 *      validation Pi applies (name matches dir, lowercase kebab,
 *      description present ≤ 1024 chars), with no eligibility constraints.
 *   2. The habit script works — a real `node` child process drives the
 *      shipped ledger through add → check → uncheck → due → list → stats,
 *      including the honest-streak contract (a missed scheduled day breaks
 *      the streak; an unowed today does not) and weekly schedules.
 *   3. The error contract — usage errors vs data errors on distinct exit
 *      codes, corrupt ledgers refused, no partial mutation on failure.
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { resolveBundledSkillsDir } from "../../config/paths.js";
import { discoverSkills } from "./discovery.js";

/** The repo's shipped skills root (tests elsewhere may override the env). */
function shippedRoot(): string {
	const prev = process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	try {
		return resolveBundledSkillsDir();
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
		else process.env.BRIGADE_BUNDLED_SKILLS_DIR = prev;
	}
}

function skillFile(...parts: string[]): string {
	return path.join(shippedRoot(), "habit-tracker", ...parts);
}

/** Same budget the manage-skill tool enforces for support files. */
const MAX_SUPPORT_FILE_BYTES = 300 * 1024;

/** Local YYYY-MM-DD for `daysAgo` nominal days back, in the script's timezone-free contract. */
function isoDaysAgo(daysAgo: number): string {
	const d = new Date(Date.now() - daysAgo * 86_400_000);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run the shipped habit script as a real child process; never throws on nonzero exit. */
function runHabit(args: string[], cwd: string): Promise<Result> {
	return new Promise((resolve) => {
		execFile(process.execPath, [skillFile("scripts", "habit.mjs"), ...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err === null) {
				resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
				return;
			}
			const raw = (err as NodeJS.ErrnoException).code;
			const code = typeof raw === "number" ? raw : Number(raw);
			resolve({ code: Number.isFinite(code) ? code : 1, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

describe("bundled habit-tracker skill (shipped assets)", () => {
	it("ships as an eligible bundled skill with no eligibility constraints", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-habit-tracker-"));
		try {
			const res = discoverSkills({
				workspaceSkillsDir: path.join(root, "empty-ws"),
				bundledSkillsDir: resolveBundledSkillsDir(),
			});
			const skill = res.skills.find((s) => s.name === "habit-tracker");
			assert.ok(skill, `expected habit-tracker among discovered skills: ${JSON.stringify(res.skills.map((s) => s.name))}`);
			assert.equal(skill.source, "bundled");
			assert.equal(skill.eligibility.os.length, 0, "keyless skill must not constrain OS");
			assert.equal(skill.eligibility.requiresBins.length, 0, "keyless skill must not require binaries");
			assert.equal(skill.eligibility.requiresEnv.length, 0, "keyless skill must not require env vars");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frontmatter satisfies the Agent Skills validation Pi applies", () => {
		const dir = path.dirname(skillFile("SKILL.md"));
		assert.equal(path.basename(dir), "habit-tracker", "skill dir name must be habit-tracker");
		const raw = fs.readFileSync(skillFile("SKILL.md"), "utf8");
		assert.ok(raw.length < MAX_SUPPORT_FILE_BYTES, "SKILL.md must stay within the support-file budget");
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		assert.ok(fm, "SKILL.md must open with a frontmatter block");
		const body = fm[1] ?? "";
		const name = /^name:\s*(\S+)\s*$/m.exec(body);
		assert.ok(name, "frontmatter must carry a name");
		const nameValue = name[1] ?? "";
		assert.equal(nameValue, "habit-tracker");
		assert.match(nameValue, /^[a-z0-9-]+$/, "name must be lowercase kebab-case");
		assert.ok(!nameValue.startsWith("-") && !nameValue.endsWith("-") && !nameValue.includes("--"), "name must not game the hyphen rules");
		const description = /^description:\s*(.+)$/m.exec(body);
		assert.ok(description, "frontmatter must carry a description (the discovery hook)");
		const descriptionValue = (description[1] ?? "").trim();
		assert.ok(descriptionValue.length > 0 && descriptionValue.length <= 1024, "description must be 1..1024 chars");
		const script = fs.statSync(skillFile("scripts", "habit.mjs"));
		assert.ok(script.isFile() && script.size > 0 && script.size < MAX_SUPPORT_FILE_BYTES, "habit script must ship within the support-file budget");
	});

	it("habit script runs the full ledger loop end-to-end with honest streaks", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-habit-tracker-run-"));
		try {
			const t = (args: string[]): Promise<Result> => runHabit(["--db", path.join(work, "ledger.json"), ...args], work);

			// No --db on the add below would default to <cwd>/habits/...; the
			// suite pins the --db contract here and the default-path contract
			// in the error test (a usage error must not create the file).
			const addDaily = await t(["add", "Meditate", "--schedule", "daily", "--goal", "10"]);
			assert.equal(addDaily.code, 0, `add daily failed: ${addDaily.stderr}`);
			assert.match(addDaily.stdout, /Added #1 "Meditate" \(daily, goal 10m\)/);

			const addWeekly = await t(["add", "Gym", "--schedule", "weekly", "--days", "mon,wed,fri"]);
			assert.equal(addWeekly.code, 0, `add weekly failed: ${addWeekly.stderr}`);
			assert.match(addWeekly.stdout, /Added #2 "Gym" \(weekly on mon,wed,fri\)/);

			// Check-ins: yesterday + today → streak 2 (consecutive scheduled days).
			const c1 = await t(["check", "Meditate", "--date", isoDaysAgo(1), "--note", "breathing"]);
			assert.equal(c1.code, 0, `check failed: ${c1.stderr}`);
			const c2 = await t(["check", "Meditate"]);
			assert.equal(c2.code, 0);
			assert.match(c2.stdout, /streak 2\)/, `expected streak 2 after two consecutive days: ${c2.stdout}`);

			// Honest streaks: uncheck yesterday (a scheduled day) → the streak
			// breaks to 1, not 0 — today still counts.
			const u1 = await t(["uncheck", "Meditate", "--date", isoDaysAgo(1)]);
			assert.equal(u1.code, 0, `uncheck failed: ${u1.stderr}`);
			// Honest correction: with yesterday gone, the streak is 1 (today
			// still counts) — stats reports it without a duplicate check-in.
			const corrected = await t(["stats", "Meditate", "--weeks", "1"]);
			assert.equal(corrected.code, 0, `stats failed: ${corrected.stderr}`);
			assert.match(corrected.stdout, /Current streak: 1/, `expected streak 1 after honest correction: ${corrected.stdout}`);

			// Duplicate check-in updates the note, never duplicates the entry.
			const dup = await t(["check", "Meditate", "--note", "longer sit"]);
			assert.equal(dup.code, 0);
			const ledger = JSON.parse(fs.readFileSync(path.join(work, "ledger.json"), "utf8")) as {
				habits: Array<{ name: string; checkins: Array<{ date: string; note?: string }> }>;
			};
			const meditate = ledger.habits.find((h) => h.name === "Meditate");
			assert.ok(meditate);
			assert.equal(meditate.checkins.filter((c) => c.date === isoDaysAgo(0)).length, 1, "duplicate check must not duplicate the entry");
			assert.equal(meditate.checkins.find((c) => c.date === isoDaysAgo(0))?.note, "longer sit");

			// Weekly habit: future-dated check-ins are refused.
			const future = await t(["check", "Gym", "--date", "2099-01-01"]);
			assert.equal(future.code, 1, "future-dated check-ins are a usage error");
			assert.match(future.stderr, /in the future/);

			// Due list: Meditate is checked today; Gym may or may not be owed
			// today depending on the runner's weekday — both are valid, but the
			// output must always carry the checked habit.
			const due = await t(["due"]);
			assert.equal(due.code, 0);
			assert.match(due.stdout, /Due today|Nothing due today/);

			const list = await t(["list"]);
			assert.equal(list.code, 0);
			assert.match(list.stdout, /Meditate/);
			assert.match(list.stdout, /Gym/);
			assert.match(list.stdout, /weekly:mon,wed,fri/);

			const stats = await t(["stats", "Meditate", "--weeks", "2"]);
			assert.equal(stats.code, 0);
			assert.match(stats.stdout, /Current streak: 1/);
			assert.match(stats.stdout, /Last 2 week\(s\):/);
			assert.match(stats.stdout, /[xo]/, "heatmap rows must be present");

			// Pause freezes the streak clock; archived habits refuse check-ins.
			assert.equal((await t(["pause", "Meditate"])).code, 0);
			const paused = await t(["list"]);
			assert.match(paused.stdout, /paused/);
			// A paused habit can still be checked in (the user may keep doing
			// it) — the entry is recorded but the streak stays frozen at 0.
			const checkPaused = await t(["check", "Meditate", "--note", "did it anyway"]);
			assert.equal(checkPaused.code, 0, `checking a paused habit must succeed: ${checkPaused.stderr}`);
			const pausedStats = await t(["stats", "Meditate", "--weeks", "1"]);
			assert.match(pausedStats.stdout, /Current streak: 0/, "a paused habit's streak stays frozen");
			assert.match(pausedStats.stdout, /\(paused\)/, "stats must disclose the pause");
			assert.equal((await t(["resume", "Meditate"])).code, 0);
			assert.equal((await t(["archive", "Meditate"])).code, 0);
			const checkArchived = await t(["check", "Meditate"]);
			assert.equal(checkArchived.code, 1);
			assert.match(checkArchived.stderr, /archived/);

			const remove = await t(["remove", "Meditate"]);
			assert.equal(remove.code, 0);
			assert.match(remove.stdout, /Removed "Meditate"/);
			const after = await t(["list"]);
			assert.ok(!after.stdout.includes("Meditate"), "removed habit must disappear from the ledger");
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});

	it("habit script keeps usage errors and data errors on distinct exit codes", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-habit-tracker-err-"));
		try {
			const db = path.join(work, "ledger.json");
			const t = (args: string[]): Promise<Result> => runHabit(["--db", db, ...args], work);

			assert.equal((await t(["add", "X"])).code, 1, "add without --schedule is a usage error (exit 1)");
			assert.ok(!fs.readdirSync(work).includes("ledger.json"), "a usage error must not create a ledger file");

			assert.equal((await t(["add", "X", "--schedule", "weekly"])).code, 1, "weekly without --days is a usage error");
			assert.match((await t(["add", "X", "--schedule", "weekly", "--days", "mon,mon"])).stderr, /must not repeat a weekday/);
			assert.equal((await t(["add", "X", "--schedule", "sometimes"])).code, 1, "unknown schedule is a usage error");
			assert.match((await t(["add", "X", "--schedule", "daily", "--goal", "abc"])).stderr, /--goal must be minutes/);
			assert.equal((await t(["add", "X", "--schedule", "daily", "--goal", "0"])).code, 1);

			const seeded = await t(["add", "Meditate", "--schedule", "daily"]);
			assert.equal(seeded.code, 0, `seeding failed: ${seeded.stderr}`);

			assert.equal((await t(["add", "Meditate", "--schedule", "daily"])).code, 1, "duplicate habit is a usage error");
			assert.equal((await t(["check", "Nope"])).code, 2, "unknown habit is a data error (exit 2)");
			assert.match((await t(["check", "Nope"])).stderr, /unknown habit "Nope"/);
			assert.equal((await t(["uncheck", "Meditate"])).code, 1, "uncheck without --date is a usage error");
			assert.equal((await t(["uncheck", "Meditate", "--date", "2026-02-30"])).code, 1, "impossible calendar date is a usage error");
			const noEntry = await t(["uncheck", "Meditate", "--date", "2026-01-01"]);
			assert.equal(noEntry.code, 2, "unchecking a date with no check-in is a data error (exit 2)");
			assert.match(noEntry.stderr, /nothing to uncheck/);
			assert.equal((await t(["stats", "Meditate", "--weeks", "99"])).code, 1, "--weeks out of range is a usage error");
			assert.equal((await t(["frobnicate"])).code, 1, "unknown command is a usage error");

			fs.writeFileSync(db, '{"oops":true}\n', "utf8");
			const corrupt = await t(["list"]);
			assert.equal(corrupt.code, 2, "a corrupt ledger is a data error (exit 2)");
			assert.match(corrupt.stderr, /is corrupt/);
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});
