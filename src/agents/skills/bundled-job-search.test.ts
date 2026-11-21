/**
 * Guards the bundled `job-search` skill — the SHIPPED assets, not fixtures.
 *
 * The skill is data + scripts, so nothing else in the suite exercises it;
 * without these checks a broken frontmatter or a syntax-errored tracker
 * script would only surface at a user's first hunt. Three layers:
 *
 *   1. Discovery + spec conformance — the skill is found via the real bundled
 *      root, its frontmatter satisfies the Agent Skills validation Pi applies
 *      (name matches dir, lowercase kebab, description present ≤ 1024 chars),
 *      and it declares no eligibility constraints (it's keyless by design).
 *   2. The tracker script actually works — a real `node` child process runs
 *      the shipped ledger through its full loop (add → list → update →
 *      followups → stats → remove) plus its error contract (usage errors vs.
 *      data errors, distinct exit codes).
 *   3. The dashboard server serves that same ledger — the shipped script is
 *      booted for real and probed over loopback (read-only pages, JSON data,
 *      HTML escaping, 404/405, fresh reads after tracker writes, and its
 *      exit-code contract).
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
	return path.join(shippedRoot(), "job-search", ...parts);
}

/** Same budget the manage-skill tool enforces for support files. */
const MAX_SUPPORT_FILE_BYTES = 300 * 1024;

/** Local YYYY-MM-DD for `daysAgo` nominal days back. */
function isoDaysAgo(daysAgo: number): string {
	const d = new Date(Date.now() - daysAgo * 86_400_000);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

interface TrackerResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Minimal HTTP probe helper for the dashboard server. */
async function fetchProbe(url: string, init?: RequestInit): Promise<{ status: number; contentType: string; text: string }> {
	const res = await fetch(url, init);
	return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
}

/**
 * Start the shipped dashboard on a fixed loopback port (default 3219) and
 * wait until /healthz answers; returns the base URL and a stop handle.
 */
async function startDashboard(dbPath: string, port = 3219): Promise<{ base: string; stop: () => Promise<void>; exitCode: Promise<number> }> {
	const child = execFile(process.execPath, [skillFile("scripts", "dashboard.mjs"), "--db", dbPath, "--port", String(port)], { encoding: "utf8" });
	const exitCode = new Promise<number>((resolve) => {
		child.on("exit", (code, signal) => resolve(code ?? (signal === null ? -1 : -2)));
	});
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			const res = await fetch(`${base}/healthz`);
			if (res.ok) break;
		} catch {
			// not listening yet — retry until the deadline
		}
		if (Date.now() > deadline) {
			child.kill();
			throw new Error(`dashboard did not become ready within 10s (port ${port})`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return {
		base,
		stop: async () => {
			child.kill();
			await new Promise((r) => setTimeout(r, 150));
		},
		exitCode,
	};
}

/** Run the shipped tracker as a real child process; never throws on nonzero exit. */
function runTracker(args: string[], cwd: string): Promise<TrackerResult> {
	return new Promise((resolve) => {
		execFile(process.execPath, [skillFile("scripts", "tracker.mjs"), ...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
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

describe("bundled job-search skill (shipped assets)", () => {
	it("ships as an eligible bundled skill with no eligibility constraints", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-"));
		try {
			const res = discoverSkills({
				workspaceSkillsDir: path.join(root, "empty-ws"),
				bundledSkillsDir: resolveBundledSkillsDir(),
			});
			const js = res.skills.find((s) => s.name === "job-search");
			assert.ok(js, `expected job-search among discovered skills: ${JSON.stringify(res.skills.map((s) => s.name))}`);
			assert.equal(js.source, "bundled");
			assert.equal(js.eligibility.os.length, 0, "keyless skill must not constrain OS");
			assert.equal(js.eligibility.requiresBins.length, 0, "keyless skill must not require binaries");
			assert.equal(js.eligibility.requiresEnv.length, 0, "keyless skill must not require env vars");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frontmatter satisfies the Agent Skills validation Pi applies", () => {
		const dir = path.dirname(skillFile("SKILL.md"));
		assert.equal(path.basename(dir), "job-search", "skill dir name must be job-search");
		const raw = fs.readFileSync(skillFile("SKILL.md"), "utf8");
		assert.ok(raw.length < MAX_SUPPORT_FILE_BYTES, "SKILL.md must stay within the support-file budget");
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
		assert.ok(fm, "SKILL.md must open with a frontmatter block");
		const body = fm[1] ?? "";
		const name = /^name:\s*(\S+)\s*$/m.exec(body);
		assert.ok(name, "frontmatter must carry a name");
		const nameValue = name[1] ?? "";
		assert.equal(nameValue, "job-search");
		assert.match(nameValue, /^[a-z0-9-]+$/, "name must be lowercase kebab-case");
		assert.ok(!nameValue.startsWith("-") && !nameValue.endsWith("-") && !nameValue.includes("--"), "name must not game the hyphen rules");
		const description = /^description:\s*(.+)$/m.exec(body);
		assert.ok(description, "frontmatter must carry a description (the discovery hook)");
		const descriptionValue = (description[1] ?? "").trim();
		assert.ok(descriptionValue.length > 0 && descriptionValue.length <= 1024, "description must be 1..1024 chars");
		const tracker = fs.statSync(skillFile("scripts", "tracker.mjs"));
		assert.ok(tracker.isFile() && tracker.size > 0 && tracker.size < MAX_SUPPORT_FILE_BYTES, "tracker script must ship within the support-file budget");
	});

	it("tracker runs the full ledger loop end-to-end", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-run-"));
		try {
			// No --db here on purpose: the loop below runs against the DEFAULT
			// ledger location (<cwd>/job-search/applications.json) and thereby
			// pins the default-path contract the skill's instructions rely on.
			const add = await runTracker(["add", "--company", "Acme Corp", "--role", "Backend Engineer", "--url", "https://acme.example/careers/123", "--source", "linkedin", "--date", isoDaysAgo(9)], work);
			assert.equal(add.code, 0, `add failed: ${add.stderr}`);
			assert.match(add.stdout, /Added #1 — Acme Corp — Backend Engineer/);
			assert.ok(fs.existsSync(path.join(work, "job-search", "applications.json")), "add must create the ledger at the default workspace path");

			const add2 = await runTracker(["add", "--company", "Globex", "--role", "Platform Engineer"], work);
			assert.equal(add2.code, 0, `second add failed: ${add2.stderr}`);
			assert.match(add2.stdout, /Added #2/);

			const list = await runTracker(["list"], work);
			assert.equal(list.code, 0);
			assert.match(list.stdout, /#1\s+.*Acme Corp\s+.*Backend Engineer\s+.*applied/);
			assert.match(list.stdout, /#2\s+.*Globex/);

			const update = await runTracker(["update", "2", "--status", "interview", "--notes", "Tech screen Thu 2pm"], work);
			assert.equal(update.code, 0, `update failed: ${update.stderr}`);
			assert.match(update.stdout, /#2 .*: interview/);

			// #1 was added 9 days ago and never touched → it is the stale one.
			const followups = await runTracker(["followups", "--stale-days", "3"], work);
			assert.equal(followups.code, 0);
			assert.match(followups.stdout, /1 application\(s\) need attention/);
			assert.match(followups.stdout, /#1\s+.*Acme Corp\s+.*Nudge: a short follow-up is overdue/);
			assert.ok(!followups.stdout.includes("#2"), "freshly-updated #2 must not be flagged as stale");

			const stats = await runTracker(["stats"], work);
			assert.equal(stats.code, 0);
			assert.match(stats.stdout, /Applications: 2/);
			assert.match(stats.stdout, /applied 1 \| screening 0 \| interview 1/);
			assert.match(stats.stdout, /Responses: 1\/2 \(50%\)/);

			const filter = await runTracker(["list", "--status", "interview"], work);
			assert.equal(filter.code, 0);
			assert.match(filter.stdout, /Globex/);
			assert.ok(!filter.stdout.includes("Acme Corp"), "status filter must exclude other applications");

			const remove = await runTracker(["remove", "1"], work);
			assert.equal(remove.code, 0);
			assert.match(remove.stdout, /Removed #1/);
			const after = await runTracker(["list"], work);
			assert.ok(!after.stdout.includes("Acme Corp"), "removed application must disappear from the ledger");
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});

	it("tracker keeps usage errors and data errors on distinct exit codes", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-err-"));
		try {
			const db = path.join(work, "ledger.json");
			const t = (args: string[]): Promise<TrackerResult> => runTracker(["--db", db, ...args], work);
			assert.equal((await t(["add", "--company", "Acme"])).code, 1, "add without --role is a usage error (exit 1)");
			// Directory listing, not existsSync: a usage error must not create the
			// ledger file (and this avoids a check-then-act pattern on the path).
			assert.ok(!fs.readdirSync(work).includes("ledger.json"), "a usage error must not create a ledger file");
			const seeded = await t(["add", "--company", "Acme", "--role", "Eng"]);
			assert.equal(seeded.code, 0, `seeding failed: ${seeded.stderr}`);

			const badStatus = await t(["update", "1", "--status", "bogus"]);
			assert.equal(badStatus.code, 1, "invalid status is a usage error (exit 1)");
			assert.match(badStatus.stderr, /--status must be one of:/);

			const badDate = await t(["add", "--company", "X", "--role", "Y", "--date", "2026-02-30"]);
			assert.equal(badDate.code, 1, "a non-existent calendar date is a usage error (exit 1)");
			assert.match(badDate.stderr, /real YYYY-MM-DD calendar date/);

			const unknownId = await t(["show", "99"]);
			assert.equal(unknownId.code, 2, "unknown id is a data error (exit 2)");
			assert.match(unknownId.stderr, /unknown application id #99/);

			fs.writeFileSync(db, '{"oops":true}\n', "utf8");
			const corrupt = await t(["stats"]);
			assert.equal(corrupt.code, 2, "a corrupt ledger is a data error (exit 2)");
			assert.match(corrupt.stderr, /is corrupt/);
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("bundled job-search skill: ledger dashboard (shipped server)", () => {
	it("serves the ledger read-only: funnel, follow-ups, escaping, and JSON data", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-dash-"));
		try {
			const db = path.join(work, "applications.json");
			const t = (args: string[]): Promise<TrackerResult> => runTracker(["--db", db, ...args], work);
			assert.equal((await t(["add", "--company", "Acme & Sons", "--role", 'Backend "Engineer"'])).code, 0);
			assert.equal((await t(["update", "1", "--status", "interview", "--notes", "screen scheduled"])).code, 0);
			assert.equal((await t(["add", "--company", "Globex", "--role", "Platform Eng", "--date", isoDaysAgo(9)])).code, 0);

			const dash = await startDashboard(db);
			try {
				const page = await fetchProbe(`${dash.base}/`);
				assert.equal(page.status, 200);
				assert.match(page.contentType, /text\/html/);
				// Ledger values are user data; the page must render them inert.
				assert.ok(page.text.includes("Acme &amp; Sons"), "company must be HTML-escaped");
				assert.ok(page.text.includes("&quot;Engineer&quot;"), "quotes in the role must be HTML-escaped");
				assert.ok(!page.text.includes("Acme & Sons"), "raw unescaped ledger text must never appear");
				assert.ok(page.text.includes("Needs attention"), "stale section must be present");
				assert.ok(page.text.includes("Globex"), "the stale record must be listed");

				const css = await fetchProbe(`${dash.base}/style.css`);
				assert.equal(css.status, 200);
				assert.match(css.contentType, /text\/css/);

				const data = await fetchProbe(`${dash.base}/data`);
				assert.equal(data.status, 200);
				assert.match(data.contentType, /application\/json/);
				const payload = JSON.parse(data.text) as {
					stats: { total: number; responses: number; responseRate: string };
					followups: Array<{ id: string }>;
					records: Array<{ id: string; status: string; company: string }>;
				};
				assert.equal(payload.stats.total, 2);
				assert.equal(payload.stats.responses, 1, "only the interview record counts as a response");
				assert.equal(payload.stats.responseRate, "50%");
				assert.deepEqual(payload.followups.map((f) => f.id), ["2"], "only the 9-day-stale record needs attention");

				// The dashboard is strictly read-only: serving must not rewrite
				// the ledger, and edits remain the tracker's job.
				const before = fs.readFileSync(db, "utf8");
				await fetchProbe(`${dash.base}/`);
				await fetchProbe(`${dash.base}/data`);
				assert.equal(fs.readFileSync(db, "utf8"), before, "serving pages must not rewrite the ledger");
				assert.equal((await t(["update", "2", "--status", "screening"])).code, 0);
				const after = await fetchProbe(`${dash.base}/data`);
				const payload2 = JSON.parse(after.text) as { records: Array<{ id: string; status: string }> };
				assert.equal(payload2.records.find((r) => r.id === "2")?.status, "screening", "a tracker edit must be visible on the next request (no caching)");
			} finally {
				await dash.stop();
			}
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});

	it("keeps the route surface tight and rejects non-GET methods", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-dash-routes-"));
		try {
			const db = path.join(work, "applications.json");
			assert.equal((await runTracker(["--db", db, "add", "--company", "Initech", "--role", "SRE"], work)).code, 0);
			const dash = await startDashboard(db, 3220);
			try {
				assert.equal((await fetchProbe(`${dash.base}/healthz`)).status, 200);
				assert.equal((await fetchProbe(`${dash.base}/nope/nope`)).status, 404);
				// A path-traversal lookup must stay inside the fixed route table.
				assert.equal((await fetchProbe(`${dash.base}/..%2fpackage.json`)).status, 404);
				const post = await fetchProbe(`${dash.base}/`, { method: "POST" });
				assert.equal(post.status, 405, "writes must be refused — the dashboard never mutates");
				assert.equal((await fetchProbe(`${dash.base}/`, { method: "DELETE" })).status, 405);
			} finally {
				await dash.stop();
			}
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});

	it("exits 0 with --help, 1 on usage errors, and 2 on a corrupt ledger before binding", async () => {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-job-search-dash-err-"));
		try {
			const db = path.join(work, "applications.json");
			const run = (args: string[]): Promise<TrackerResult> =>
				new Promise((resolve) => {
					execFile(process.execPath, [skillFile("scripts", "dashboard.mjs"), ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
						if (err === null) {
							resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
							return;
						}
						const raw = (err as NodeJS.ErrnoException).code;
						const code = typeof raw === "number" ? raw : Number(raw);
						resolve({ code: Number.isFinite(code) ? code : 1, stdout: String(stdout), stderr: String(stderr) });
					});
				});
			const help = await run(["--help"]);
			assert.equal(help.code, 0);
			assert.match(help.stdout, /Usage: dashboard\.mjs/);

			const badFlag = await run(["--bogus"]);
			assert.equal(badFlag.code, 1, "unknown flags are usage errors");
			const badPort = await run(["--port", "99999"]);
			assert.equal(badPort.code, 1, "out-of-range ports are usage errors");
			assert.match(badPort.stderr, /--port must be a whole number/);

			fs.writeFileSync(db, '{"oops":true}\n', "utf8");
			const corrupt = await run(["--db", db, "--port", "3221"]);
			assert.equal(corrupt.code, 2, "a corrupt ledger is a data error (exit 2)");
			assert.match(corrupt.stderr, /is corrupt/);
			const listening = await fetchProbe("http://127.0.0.1:3221/healthz").then(
				() => true,
				() => false,
			);
			assert.equal(listening, false, "a corrupt ledger must not leave a server listening");
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});
