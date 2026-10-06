/**
 * Guard suite for the bundled `reading-list` skill.
 *
 * Spawns the shipped script in a throwaway workspace and pins the invariants
 * the SKILL.md promises: honest page progress, a refused page past the end, an
 * exact id beating a partial match, `--yes` on remove, atomic writes with no
 * temp leftovers, and a corrupt ledger being refused (exit 2) rather than
 * overwritten.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveBundledSkillsDir } from "../../config/paths.js";
import { discoverSkills } from "./discovery.js";

let cwd: string;

/** The shipped script. Clears the test-wide bundled-dir override so this points
 *  at the REAL `<packageRoot>/skills`. */
function scriptPath(): string {
	delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	return path.join(resolveBundledSkillsDir(), "reading-list", "scripts", "reading.mjs");
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(process.execPath, [scriptPath(), ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as { status?: number | null; stdout?: string; stderr?: string };
		return {
			code: typeof e.status === "number" ? e.status : 1,
			stdout: String(e.stdout ?? ""),
			stderr: String(e.stderr ?? ""),
		};
	}
}

function ledger(): { items: Array<Record<string, unknown>> } {
	return JSON.parse(fs.readFileSync(path.join(cwd, "reading", "reading.json"), "utf8")) as {
		items: Array<Record<string, unknown>>;
	};
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-reading-"));
});

afterEach(() => {
	try {
		fs.rmSync(cwd, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe("bundled reading-list skill", () => {
	it("is discoverable as a bundled skill", () => {
		delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
		const res = discoverSkills({
			workspaceSkillsDir: path.join(cwd, "empty-ws"),
			bundledSkillsDir: resolveBundledSkillsDir(),
		});
		const found = res.skills.find((s) => s.name === "reading-list");
		assert.ok(found, `expected reading-list in ${JSON.stringify(res.skills.map((s) => s.name))}`);
		assert.equal(found?.source, "bundled");
	});

	it("tracks progress and only finishes at the last page", () => {
		assert.equal(run(["add", "Dune", "--pages", "412", "--tags", "scifi"]).code, 0);
		assert.equal(ledger().items[0]?.status, "want");

		assert.equal(run(["start", "dune"]).code, 0);
		assert.equal(ledger().items[0]?.status, "reading");

		assert.equal(run(["progress", "dune", "200"]).code, 0);
		assert.equal(ledger().items[0]?.currentPage, 200);
		assert.equal(ledger().items[0]?.status, "reading", "mid-book progress must not finish it");

		assert.equal(run(["progress", "dune", "412"]).code, 0);
		assert.equal(ledger().items[0]?.status, "finished");
		assert.ok(ledger().items[0]?.finishedAt, "finishing stamps finishedAt");
	});

	it("refuses a page past the end of a known-length item", () => {
		run(["add", "Dune", "--pages", "412"]);
		const res = run(["progress", "dune", "500"]);
		assert.equal(res.code, 1);
		assert.match(res.stderr, /past the end/);
		assert.equal(ledger().items[0]?.currentPage, 0, "the refused write must not land");
	});

	it("prefers an exact id over a partial match, and refuses an ambiguous fragment", () => {
		run(["add", "Dune"]);
		run(["add", "Dune Messiah"]);
		assert.equal(run(["show", "dune"]).code, 0, "exact id wins");
		// A fragment matching BOTH items must be refused, not guessed at.
		const ambiguous = run(["finish", "dun"]);
		assert.equal(ambiguous.code, 1);
		assert.match(ambiguous.stderr, /ambiguous/);
	});

	it("refuses to remove an item without --yes", () => {
		run(["add", "Gone"]);
		const refused = run(["remove", "gone"]);
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /--yes/);
		assert.equal(ledger().items.length, 1, "the refused removal must not land");
		assert.equal(run(["remove", "gone", "--yes"]).code, 0);
		assert.equal(ledger().items.length, 0);
	});

	it("writes atomically and leaves no temp files behind", () => {
		run(["add", "One"]);
		run(["add", "Two"]);
		run(["note", "one", "a note"]);
		const strays = fs.readdirSync(path.join(cwd, "reading")).filter((n) => n.includes(".tmp-"));
		assert.deepEqual(strays, []);
	});

	it("refuses a corrupt ledger with exit 2 and does not overwrite it", () => {
		fs.mkdirSync(path.join(cwd, "reading"), { recursive: true });
		const p = path.join(cwd, "reading", "reading.json");
		fs.writeFileSync(p, "{ this is not json", "utf8");
		const res = run(["list"]);
		assert.equal(res.code, 2);
		assert.match(res.stderr, /corrupt/);
		assert.equal(fs.readFileSync(p, "utf8"), "{ this is not json", "the corrupt ledger must be left untouched");
	});

	it("filters `list` by status and tag", () => {
		run(["add", "Dune", "--tags", "scifi"]);
		run(["add", "Sapiens", "--tags", "history"]);
		run(["start", "dune"]);
		const reading = run(["list", "--status", "reading"]);
		assert.match(reading.stdout, /Dune/);
		assert.doesNotMatch(reading.stdout, /Sapiens/);
		const tagged = run(["list", "--tag", "history"]);
		assert.match(tagged.stdout, /Sapiens/);
		assert.doesNotMatch(tagged.stdout, /Dune/);
	});

	it("reports stats without inventing data", () => {
		run(["add", "Dune", "--pages", "100", "--tags", "scifi"]);
		run(["finish", "dune", "--rating", "4"]);
		const res = run(["stats", "--json"]);
		assert.equal(res.code, 0);
		const stats = JSON.parse(res.stdout) as {
			total: number;
			pagesRead: number;
			averageRating: number;
			byStatus: Record<string, number>;
		};
		assert.equal(stats.total, 1);
		assert.equal(stats.pagesRead, 100);
		assert.equal(stats.averageRating, 4);
		assert.equal(stats.byStatus.finished, 1);
	});
});
