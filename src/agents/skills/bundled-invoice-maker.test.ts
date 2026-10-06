/**
 * Guard suite for the bundled `invoice-maker` skill.
 *
 * Spawns the shipped script in a throwaway workspace and pins the invariants
 * the SKILL.md promises: money math on exact integer cents (tax after
 * discount), no over-recorded payments, reminders only for overdue invoices
 * with an escalation ladder, void-not-delete record keeping, HTML rendering
 * with escaped client content, atomic writes with no temp leftovers, and a
 * corrupt ledger being refused (exit 2) rather than overwritten.
 *
 * All date-sensitive expectations are computed relative to "today" (UTC, the
 * same clock the script uses) so the suite does not rot as the calendar
 * advances.
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
	return path.join(resolveBundledSkillsDir(), "invoice-maker", "scripts", "invoice.mjs");
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

function ledger(): { invoices: Array<Record<string, unknown>>; nextNumber: number } {
	return JSON.parse(fs.readFileSync(path.join(cwd, "invoices", "invoices.json"), "utf8")) as {
		invoices: Array<Record<string, unknown>>;
		nextNumber: number;
	};
}

/** UTC date `offset` days from today — the same clock the script uses. */
function day(offset: number): string {
	return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-invoice-"));
});

afterEach(() => {
	try {
		fs.rmSync(cwd, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe("bundled invoice-maker skill", () => {
	it("is discoverable as a bundled skill", () => {
		delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
		const res = discoverSkills({
			workspaceSkillsDir: path.join(cwd, "empty-ws"),
			bundledSkillsDir: resolveBundledSkillsDir(),
		});
		const found = res.skills.find((s) => s.name === "invoice-maker");
		assert.ok(found, `expected invoice-maker in ${JSON.stringify(res.skills.map((s) => s.name))}`);
		assert.equal(found?.source, "bundled");
	});

	it("computes money on exact integer cents (tax after discount)", () => {
		const res = run([
			"new",
			"Acme Inc",
			"--item",
			"Logo design|2|500",
			"--item",
			"Consulting|1.5|120.55",
			"--tax",
			"10",
			"--discount",
			"5",
			"--date",
			"2026-10-01",
			"--due-date",
			"2026-10-15",
		]);
		assert.equal(res.code, 0);
		const inv = ledger().invoices[0];
		assert.ok(inv, "the invoice must land in the ledger");
		// Hand-computed: subtotal 1000.00 + 180.83 = 118083¢
		// discount 5% → 5904¢ (118083 × 0.05 = 5904.15, rounded once)
		// taxable 112179¢; tax 10% → 11218¢ (11217.9, rounded once)
		// total 123397¢ — no float drift is possible.
		assert.equal(inv.subtotal, 118083);
		assert.equal(inv.discountAmount, 5904);
		assert.equal(inv.taxAmount, 11218);
		assert.equal(inv.total, 123397);
		assert.match(res.stdout, /USD 1,233\.97/);
		assert.equal(inv.dueDate, "2026-10-15");
		assert.equal(inv.status, "draft");
	});

	it("defaults the due date to the terms window after the issue date", () => {
		run(["new", "A", "--item", "x|1|10", "--date", "2026-10-01"]);
		run(["new", "B", "--item", "x|1|10", "--date", "2026-10-01", "--terms", "30"]);
		const invoices = ledger().invoices;
		assert.equal(invoices[0]?.dueDate, "2026-10-15");
		assert.equal(invoices[1]?.dueDate, "2026-10-31");
	});

	it("refuses malformed items, zero quantities, bad dates, and a due date before issue", () => {
		const cases: string[][] = [
			["new", "X", "--item", "no pipes here"],
			["new", "X", "--item", "zero qty|0|100"],
			["new", "X", "--item", "too precise|1|1.005"],
			["new", "X", "--item", "a|1|100", "--due-date", "2026-02-30"],
			["new", "X", "--item", "a|1|100", "--date", "2026-10-10", "--due-date", "2026-10-01"],
			["new", "X"],
		];
		for (const args of cases) {
			const res = run(args);
			assert.equal(res.code, 1, `expected refusal for: ${args.join(" ")}`);
		}
		assert.ok(
			!fs.readdirSync(cwd).includes("invoices"),
			"every refusal must happen before the ledger is created — nothing may land",
		);
	});

	it("walks draft → sent → partial → paid and refuses an overpayment", () => {
		run(["new", "Acme", "--item", "Work|1|100"]);
		const draftPay = run(["pay", "1", "10"]);
		assert.equal(draftPay.code, 1, "paying a draft is refused — send it first");
		assert.match(draftPay.stderr, /draft/);

		assert.equal(run(["send", "1"]).code, 0);
		assert.equal(run(["send", "1"]).code, 1, "an invoice can only be sent once");

		assert.equal(run(["pay", "1", "40"]).code, 0);
		assert.equal(ledger().invoices[0]?.status, "partial");

		const overpay = run(["pay", "1", "61"]);
		assert.equal(overpay.code, 1, "over-recording a payment is a bookkeeping error");
		assert.match(overpay.stderr, /exceeds the outstanding balance/);
		assert.equal(ledger().invoices[0]?.amountPaid, 4000, "the refused payment must not land");

		assert.equal(run(["pay", "1", "60"]).code, 0);
		const inv = ledger().invoices[0];
		assert.equal(inv?.status, "paid");
		assert.ok(inv?.paidAt, "paid invoices stamp paidAt");
		assert.equal(run(["pay", "1", "1"]).code, 1, "a paid invoice accepts no more money");
		assert.equal(run(["send", "1"]).code, 1, "a paid invoice cannot be re-sent");
	});

	it("keeps financial records: void refuses on paid, payments refuse on void", () => {
		run(["new", "A", "--item", "x|1|50"]);
		run(["new", "B", "--item", "x|1|50"]);
		run(["send", "1"]);
		run(["send", "2"]);
		run(["pay", "2", "50"]);

		const voidPaid = run(["void", "2"]);
		assert.equal(voidPaid.code, 1);
		assert.match(voidPaid.stderr, /cannot be voided/);

		assert.equal(run(["void", "1"]).code, 0);
		assert.equal(ledger().invoices[0]?.status, "void");
		assert.equal(run(["void", "1"]).code, 1, "voiding twice is refused");
		const payVoid = run(["pay", "1", "10"]);
		assert.equal(payVoid.code, 1);
		assert.match(payVoid.stderr, /void/);
		assert.equal(ledger().invoices.length, 2, "no command ever deletes an invoice");
	});

	it("reminds only overdue invoices, escalating with age", () => {
		run(["new", "Draft Co", "--item", "x|1|10"]);
		assert.match(run(["remind", "1"]).stderr, /draft/);

		run(["new", "Future Co", "--item", "x|1|10", "--due-date", day(7)]);
		run(["send", "2"]);
		const early = run(["remind", "2"]);
		assert.equal(early.code, 1, "a not-yet-due invoice has nothing to chase");
		assert.match(early.stderr, /not overdue yet/);

		run(["new", "Fresh Co", "--item", "x|1|10", "--date", day(-10), "--due-date", day(-3)]);
		run(["new", "Lapsed Co", "--item", "x|1|10", "--date", day(-40), "--due-date", day(-15)]);
		run(["new", "Ancient Co", "--item", "x|1|10", "--date", day(-90), "--due-date", day(-60)]);
		run(["send", "3"]);
		run(["send", "4"]);
		run(["send", "5"]);

		const friendly = run(["remind", "3"]);
		assert.equal(friendly.code, 0);
		assert.match(friendly.stdout, /\[friendly\]/);
		const firm = run(["remind", "4"]);
		assert.equal(firm.code, 0);
		assert.match(firm.stdout, /\[firm\]/);
		const final = run(["remind", "5"]);
		assert.equal(final.code, 0);
		assert.match(final.stdout, /\[final\]/);
		assert.match(final.stdout, /final notice/);
	});

	it("renders a standalone HTML invoice with client content escaped", () => {
		run([
			"new",
			"<script>alert(1)</script> Corp",
			"--item",
			"Work|1|500",
			"--pay-instructions",
			"Bank: ACCT-1234",
		]);
		const res = run(["render", "1"]);
		assert.equal(res.code, 0);
		const dir = path.join(cwd, "invoices", "rendered");
		assert.ok(
			fs.readdirSync(dir).includes("INV-0001.html"),
			"render must write invoices/rendered/INV-0001.html",
		);
		const html = fs.readFileSync(path.join(dir, "INV-0001.html"), "utf8");
		assert.match(html, /INVOICE/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "client name must be HTML-escaped");
		assert.doesNotMatch(html, /<script>alert\(1\)/, "raw script tags must never reach the document");
		assert.match(html, /USD 500\.00/);
		assert.match(html, /Bank: ACCT-1234/);
	});

	it("filters list by status, overdue, and client, and refuses an ambiguous id", () => {
		run(["new", "Globex", "--item", "x|1|10"]);
		run(["new", "Initech", "--item", "x|1|10", "--date", day(-30), "--due-date", day(-20)]);
		run(["new", "Umbrella", "--item", "x|1|10"]);
		run(["send", "1"]);
		run(["send", "2"]);

		const overdue = run(["list", "--status", "overdue", "--json"]);
		assert.equal(overdue.code, 0);
		const rows = JSON.parse(overdue.stdout) as Array<{ id: string; overdue: boolean }>;
		assert.deepEqual(
			rows.map((r) => r.id),
			["INV-0002"],
			"only the past-due sent invoice is overdue",
		);

		const client = run(["list", "--client", "glob"]);
		assert.match(client.stdout, /Globex/);
		assert.doesNotMatch(client.stdout, /Initech/);

		assert.equal(run(["show", "1"]).code, 0, "a bare number resolves to its invoice");
		const ambiguous = run(["show", "INV-000"]);
		assert.equal(ambiguous.code, 1);
		assert.match(ambiguous.stderr, /ambiguous/);
	});

	it("reports stats per currency without ever summing across them", () => {
		run(["new", "Acme", "--item", "x|1|100"]);
		run(["send", "1"]);
		run(["pay", "1", "100"]);
		run(["new", "Globex", "--item", "y|1|2500", "--currency", "EUR", "--date", day(-30), "--due-date", day(-20)]);
		run(["send", "2"]);

		const res = run(["stats", "--json"]);
		assert.equal(res.code, 0);
		const stats = JSON.parse(res.stdout) as {
			total: number;
			overdueCount: number;
			currencies: string[];
			byCurrency: Array<{ currency: string; collected: number; outstanding: number; overdueAmount: number }>;
			averageDaysToPay: number | null;
		};
		assert.equal(stats.total, 2);
		assert.equal(stats.overdueCount, 1);
		assert.deepEqual(stats.currencies, ["EUR", "USD"]);
		assert.equal(stats.byCurrency.length, 2, "a mixed-currency book is broken out, never pooled");
		const usd = stats.byCurrency.find((c) => c.currency === "USD");
		const eur = stats.byCurrency.find((c) => c.currency === "EUR");
		assert.equal(usd?.collected, 100);
		assert.equal(usd?.outstanding, 0);
		assert.equal(eur?.outstanding, 2500);
		assert.equal(eur?.overdueAmount, 2500);
		assert.equal(typeof stats.averageDaysToPay, "number");
	});

	it("writes atomically and leaves no temp files behind", () => {
		run(["new", "One", "--item", "a|1|10"]);
		run(["new", "Two", "--item", "a|1|10"]);
		run(["send", "1"]);
		run(["pay", "1", "5"]);
		run(["render", "1"]);
		const strays = fs.readdirSync(path.join(cwd, "invoices")).filter((n) => n.includes(".tmp-"));
		assert.deepEqual(strays, []);
	});

	it("refuses a corrupt ledger with exit 2 and does not overwrite it", () => {
		fs.mkdirSync(path.join(cwd, "invoices"), { recursive: true });
		const p = path.join(cwd, "invoices", "invoices.json");
		fs.writeFileSync(p, "{ this is not json", "utf8");
		const res = run(["list"]);
		assert.equal(res.code, 2);
		assert.match(res.stderr, /corrupt/);
		assert.equal(fs.readFileSync(p, "utf8"), "{ this is not json", "the corrupt ledger must be left untouched");
	});
});
