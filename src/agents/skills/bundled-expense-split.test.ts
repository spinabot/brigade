/**
 * Guards the bundled `expense-split` skill — the SHIPPED assets, not fixtures.
 *
 * Same pattern as the job-search and habit-tracker guards: without these
 * checks a broken frontmatter or a syntax-errored script would only surface
 * at a user's first settle-up. Three layers:
 *
 *   1. Discovery + spec conformance — the skill is found via the real
 *      bundled root and its frontmatter satisfies the Agent Skills
 *      validation Pi applies, with no eligibility constraints.
 *   2. The split script works — a real `node` child process drives the
 *      shipped ledger through group → expense → balances → simplify →
 *      settle, asserting the money invariants (integer-cent shares, balances
 *      that always sum to zero, settle-ups that actually persist to disk).
 *   3. The error contract — usage errors vs data errors on distinct exit
 *      codes, corrupt ledgers refused, destructive commands gated on --yes,
 *      no partial mutation on failure.
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
	return path.join(shippedRoot(), "expense-split", ...parts);
}

/** Same budget the manage-skill tool enforces for support files. */
const MAX_SUPPORT_FILE_BYTES = 300 * 1024;

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run the shipped split script as a real child process; never throws on nonzero exit. */
function runSplit(args: string[], cwd: string): Promise<Result> {
	return new Promise((resolve) => {
		execFile(process.execPath, [skillFile("scripts", "split.mjs"), ...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
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

describe("bundled expense-split skill (shipped assets)", () => {
	it("ships as an eligible bundled skill with no eligibility constraints", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-expense-split-"));
		try {
			const res = discoverSkills({
				workspaceSkillsDir: path.join(root, "empty-ws"),
				bundledSkillsDir: resolveBundledSkillsDir(),
			});
			const skill = res.skills.find((s) => s.name === "expense-split");
			assert.ok(skill, `expected expense-split among discovered skills: ${JSON.stringify(res.skills.map((s) => s.name))}`);
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
		assert.equal(path.basename(dir), "expense-split", "skill dir name must be expense-split");
		const raw = fs.readFileSync(skillFile("SKILL.md"), "utf8");
		assert.ok(raw.length < MAX_SUPPORT_FILE_BYTES, "SKILL.md must stay within the support-file budget");
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		assert.ok(fm, "SKILL.md must open with a frontmatter block");
		const body = fm[1] ?? "";
		const name = /^name:\s*(\S+)\s*$/m.exec(body);
		assert.ok(name, "frontmatter must carry a name");
		const nameValue = name[1] ?? "";
		assert.equal(nameValue, "expense-split");
		assert.match(nameValue, /^[a-z0-9-]+$/, "name must be lowercase kebab-case");
		assert.ok(!nameValue.startsWith("-") && !nameValue.endsWith("-") && !nameValue.includes("--"), "name must not game the hyphen rules");
		const description = /^description:\s*(.+)$/m.exec(body);
		assert.ok(description, "frontmatter must carry a description (the discovery hook)");
		const descriptionValue = (description[1] ?? "").trim();
		assert.ok(descriptionValue.length > 0 && descriptionValue.length <= 1024, "description must be 1..1024 chars");
		const script = fs.statSync(skillFile("scripts", "split.mjs"));
		assert.ok(script.isFile() && script.size > 0 && script.size < MAX_SUPPORT_FILE_BYTES, "split script must ship within the support-file budget");
	});

	it("split script runs the full ledger loop with exact, zero-sum money", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-expense-split-run-"));
		try {
			const db = path.join(work, "ledger.json");
			const t = (args: string[]): Promise<Result> => runSplit(["--db", db, ...args], work);

			const group = await t(["group", "add", "Ski Trip", "--members", "ana,bob,cy"]);
			assert.equal(group.code, 0, `group add failed: ${group.stderr}`);
			assert.match(group.stdout, /Added g1 "Ski Trip" — members: ana, bob, cy/);

			const e1 = await t(["expense", "add", "Ski Trip", "ana", "90.00", "--desc", "cabin"]);
			assert.equal(e1.code, 0, `expense add failed: ${e1.stderr}`);
			assert.match(e1.stdout, /Added e1 — ana paid \$90\.00 for cabin \(shared by everyone/);
			const e2 = await t(["expense", "add", "Ski Trip", "bob", "42.80", "--desc", "groceries"]);
			assert.equal(e2.code, 0);
			// Partial split: only ana and bob share the lesson.
			const e3 = await t(["expense", "add", "Ski Trip", "ana", "25.50", "--desc", "lesson", "--split", "ana,bob"]);
			assert.equal(e3.code, 0);
			assert.match(e3.stdout, /shared by ana, bob/);

			// Balances: ana is owed the surplus, bob/cy owe; they must sum to
			// exactly zero in integer cents.
			const bal = await t(["balances", "Ski Trip", "--json"]);
			assert.equal(bal.code, 0, `balances failed: ${bal.stderr}`);
			const parsed = JSON.parse(bal.stdout) as { balances: Array<{ member: string; cents: number }> };
			const sum = parsed.balances.reduce((acc, r) => acc + r.cents, 0);
			assert.equal(sum, 0, `balances must sum to exactly zero, got ${sum}`);
			const byName = new Map(parsed.balances.map((r) => [r.member, r.cents]));
			// ana paid 115.50, owes 30.00 + 14.27 + 12.75 → surplus $58.48
			assert.equal(byName.get("ana"), 5848, "ana's surplus must be exactly $58.48 in cents");
			assert.equal(byName.get("bob"), -1422, "bob's debt must be exactly -$14.22 in cents");
			assert.equal(byName.get("cy"), -4426, "cy's debt must be exactly -$44.26 in cents");

			// Simplify: the transfer plan must zero every balance when applied.
			const simp = await t(["simplify", "Ski Trip", "--json"]);
			assert.equal(simp.code, 0, `simplify failed: ${simp.stderr}`);
			const plan = JSON.parse(simp.stdout) as { transfers: Array<{ from: string; to: string; amountCents: number }> };
			assert.ok(plan.transfers.length > 0 && plan.transfers.length <= 2, `expected 1-2 transfers for 3 members, got ${plan.transfers.length}`);
			const applied = new Map(parsed.balances.map((r) => [r.member, r.cents]));
			for (const tr of plan.transfers) {
				applied.set(tr.from, (applied.get(tr.from) ?? 0) + tr.amountCents);
				applied.set(tr.to, (applied.get(tr.to) ?? 0) - tr.amountCents);
			}
			for (const [member, cents] of applied) {
				assert.equal(cents, 0, `transfer plan must zero ${member}, leaves ${cents}`);
			}

			// Settle: a real repayment must move balances AND persist to disk
			// (regression: the verb-slot bug made settle print success without
			// saving the ledger).
			const settle = await t(["settle", "Ski Trip", "bob", "ana", "14.21", "--note", "cash"]);
			assert.equal(settle.code, 0, `settle failed: ${settle.stderr}`);
			assert.match(settle.stdout, /Recorded s\d+: bob → ana \$14\.21/);
			const onDisk = JSON.parse(fs.readFileSync(db, "utf8")) as {
				groups: Array<{ name: string; settlements: Array<{ from: string; amountCents: number }> }>;
			};
			const skiTrip = onDisk.groups.find((g) => g.name === "Ski Trip");
			assert.ok(skiTrip);
			assert.equal(skiTrip.settlements.length, 1, "settle must persist the settlement to disk");
			assert.equal(skiTrip.settlements[0]?.amountCents, 1421);
			const balAfter = JSON.parse((await t(["balances", "Ski Trip", "--json"])).stdout) as {
				balances: Array<{ member: string; cents: number }>;
			};
			const bobAfter = balAfter.balances.find((r) => r.member === "bob")?.cents;
			assert.equal(bobAfter, -1422 + 1421, "settle must move bob's balance by the repayment");
			const sumAfter = balAfter.balances.reduce((acc, r) => acc + r.cents, 0);
			assert.equal(sumAfter, 0, "balances must stay zero-sum after a settle");

			// Member guard: you cannot walk away owing money.
			const removeOwing = await t(["member", "remove", "Ski Trip", "bob"]);
			assert.equal(removeOwing.code, 1, "removing a member with a non-zero balance is refused");
			assert.match(removeOwing.stderr, /settle up first/);

			// Destructive commands are gated on --yes.
			const noYes = await t(["group", "remove", "Ski Trip"]);
			assert.equal(noYes.code, 1);
			assert.match(noYes.stderr, /--yes/);
			assert.ok((await t(["group", "list"])).stdout.includes("Ski Trip"), "a refused remove must not delete the group");

			// expense remove corrects history instead of offsetting it.
			const rmExpense = await t(["expense", "remove", "Ski Trip", "e2"]);
			assert.equal(rmExpense.code, 0, `expense remove failed: ${rmExpense.stderr}`);
			assert.ok(!(await t(["expense", "list", "Ski Trip"])).stdout.includes("groceries"), "removed expense must disappear");
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});

	it("split script keeps usage errors and data errors on distinct exit codes", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-expense-split-err-"));
		try {
			const db = path.join(work, "ledger.json");
			const t = (args: string[]): Promise<Result> => runSplit(["--db", db, ...args], work);

			assert.equal((await t(["group", "add", "X"])).code, 1, "group add without --members is a usage error (exit 1)");
			assert.ok(!fs.readdirSync(work).includes("ledger.json"), "a usage error must not create a ledger file");
			assert.match((await t(["group", "add", "X", "--members", "a,a"])).stderr, /must not repeat a member/);
			assert.equal((await t(["expense", "add", "X", "a", "5"])).code, 2, "unknown group is a data error (exit 2)");

			assert.equal((await t(["group", "add", "Trip", "--members", "ana,bob"])).code, 0, `seeding failed`);
			assert.match((await t(["expense", "add", "Trip", "ana", "12.345"])).stderr, /up to 2 decimals/);
			assert.equal((await t(["expense", "add", "Trip", "ana", "0"])).code, 1, "zero amount is a usage error");
			assert.match((await t(["expense", "add", "Trip", "zed", "5"])).stderr, /unknown member "zed"/);
			assert.match((await t(["expense", "add", "Trip", "ana", "5", "--date", "2026-02-30"])).stderr, /real YYYY-MM-DD calendar date/);
			const future = await t(["expense", "add", "Trip", "ana", "5", "--date", "2099-01-01"]);
			assert.equal(future.code, 1, "future-dated expenses are a usage error");
			assert.match(future.stderr, /in the future/);
			assert.match((await t(["settle", "Trip", "ana", "ana", "5"])).stderr, /cannot repay themselves/);
			assert.match((await t(["settle", "Trip", "ana", "bob", "-3"])).stderr, /up to 2 decimals/, "negative amounts are not valid dollar strings");
			assert.equal((await t(["simplify"])).code, 1, "simplify without a group is a usage error");
			assert.equal((await t(["expense", "remove", "Trip", "e99"])).code, 2, "unknown expense id is a data error");
			assert.equal((await t(["frobnicate"])).code, 1, "unknown command is a usage error");

			fs.writeFileSync(db, '{"oops":true}\n', "utf8");
			const corrupt = await t(["group", "list"]);
			assert.equal(corrupt.code, 2, "a corrupt ledger is a data error (exit 2)");
			assert.match(corrupt.stderr, /is corrupt/);
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});
