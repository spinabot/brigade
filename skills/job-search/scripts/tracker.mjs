#!/usr/bin/env node
/**
 * job-search tracker — a tiny, dependency-free ledger for a job hunt.
 *
 * Part of the bundled `job-search` skill. One JSON file holds every
 * application; every command prints plain, fixed-width text an agent (or a
 * human) can read straight from a terminal. The ledger is created on first
 * use and every write is atomic (temp file + rename).
 *
 * Usage:
 *   tracker.mjs [--db <path>] add --company <name> --role <title>
 *               [--url U] [--source S] [--location L] [--notes N] [--date YYYY-MM-DD]
 *   tracker.mjs [--db <path>] update <id> --status <status> [--notes N] [--date D]
 *   tracker.mjs [--db <path>] note <id> --notes N [--date D]
 *   tracker.mjs [--db <path>] list [--status S] [--company SUBSTRING] [--json]
 *   tracker.mjs [--db <path>] show <id> [--json]
 *   tracker.mjs [--db <path>] followups [--stale-days N] [--json]
 *   tracker.mjs [--db <path>] stats [--json]
 *   tracker.mjs [--db <path>] remove <id>
 *
 * Exit codes: 0 ok | 1 usage error | 2 data error (corrupt ledger, unknown id)
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Fixed status vocabulary, in pipeline order. */
const STATUSES = ["applied", "screening", "interview", "offer", "rejected", "withdrawn", "accepted"];
/** A terminal status means the hunt is over for that application. */
const TERMINAL = new Set(["rejected", "withdrawn", "accepted"]);
/** Statuses that count as "a human replied" for the response rate. */
const RESPONDED = new Set(["screening", "interview", "offer", "rejected", "accepted"]);

/** What to do next, per status, printed by `followups`. */
const NEXT_ACTION = {
	applied: "Nudge: a short follow-up is overdue",
	screening: "Check in on next steps",
	interview: "Send a thank-you / check stage progress",
	offer: "Decision pending — respond, negotiate, or decline",
};

const USAGE = `Usage: tracker.mjs [--db <path>] <command> [options]

Commands:
  add --company <name> --role <title> [--url U] [--source S] [--location L] [--notes N] [--date YYYY-MM-DD]
  update <id> --status <${STATUSES.join("|")}> [--notes N] [--date D]
  note <id> --notes N [--date D]
  list [--status S] [--company SUBSTRING] [--json]
  show <id> [--json]
  followups [--stale-days N] [--json]
  stats [--json]
  remove <id>

The ledger defaults to <cwd>/job-search/applications.json; --db overrides it.
Dates are local YYYY-MM-DD (default: today).`;

function die(message, code = 1) {
	process.stderr.write(`tracker: ${message}\n`);
	process.exit(code);
}

/** Today as a local YYYY-MM-DD string. */
function todayISO() {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Whole calendar days from date `a` (older) to date `b` (newer). */
function daysBetween(a, b) {
	const pa = a.split("-").map(Number);
	const pb = b.split("-").map(Number);
	const da = new Date(pa[0], pa[1] - 1, pa[2]);
	const db = new Date(pb[0], pb[1] - 1, pb[2]);
	return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Accept only real calendar dates in YYYY-MM-DD form. */
function isRealDate(s) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const [y, m, d] = s.split("-").map(Number);
	const dt = new Date(y, m - 1, d);
	return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Truncate to `n` chars, marking a cut with `...` (ASCII-safe on every console). */
function clip(s, n) {
	return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 3))}...`;
}

/** Flags that take a value (everything else starting with -- is boolean). */
const VALUE_FLAGS = new Set(["company", "role", "url", "source", "location", "notes", "date", "status", "stale-days", "db"]);

/**
 * Peel off the global `--json` / `--help` flags, leaving every other token
 * (command, positional ids, and all value flags incl. `--db`) for readFlags,
 * which resolves them position-independently.
 */
function parseArgv(argv) {
	let json = false;
	const tokens = [];
	for (const a of argv) {
		if (a === "--json") {
			json = true;
		} else if (a === "--help" || a === "-h") {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		} else {
			tokens.push(a);
		}
	}
	return { json, tokens };
}

/**
 * Collect `--flag value` / boolean `--flag` pairs from `tokens` (anything not
 * a recognised flag is positional). `db` is handled here too because it may
 * legally appear after the command in the usage string above.
 */
function readFlags(tokens, valueFlags) {
	const flags = new Map();
	const positional = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--db") {
			const v = tokens[++i];
			if (v === undefined) die("--db requires a path");
			flags.set("db", v);
		} else if (t.startsWith("--")) {
			const name = t.slice(2);
			if (valueFlags.has(name)) {
				const v = tokens[++i];
				if (v === undefined) die(`--${name} requires a value`);
				flags.set(name, v);
			} else {
				flags.set(name, true);
			}
		} else {
			positional.push(t);
		}
	}
	return { flags, positional };
}

/** Validate --date / --status up front so a typo never silently corrupts the ledger. */
function checkedFlags(flags) {
	const date = flags.get("date");
	if (date !== undefined && !isRealDate(date)) {
		die(`--date must be a real YYYY-MM-DD calendar date (got "${date}")`);
	}
	const status = flags.get("status");
	if (status !== undefined && !STATUSES.includes(status)) {
		die(`--status must be one of: ${STATUSES.join(", ")} (got "${status}")`);
	}
	return flags;
}

function ledgerPath(dbFlag) {
	return dbFlag ?? path.join(process.cwd(), "job-search", "applications.json");
}

function loadLedger(dbPath) {
	if (!fs.existsSync(dbPath)) return { version: 1, nextId: 1, applications: [] };
	let raw;
	try {
		raw = fs.readFileSync(dbPath, "utf8");
	} catch (err) {
		die(`cannot read ledger ${dbPath}: ${err instanceof Error ? err.message : String(err)}`, 2);
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.applications)) {
			throw new Error("not a job-search ledger (missing applications array)");
		}
		parsed.nextId ??= parsed.applications.length + 1;
		return parsed;
	} catch (err) {
		die(
			`ledger ${dbPath} is corrupt (${err instanceof Error ? err.message : String(err)}). Restore it from a backup or move it aside; refusing to overwrite data.`,
			2,
		);
	}
}

function saveLedger(dbPath, ledger) {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const tmp = `${dbPath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, "\t")}\n`, "utf8");
	try {
		fs.renameSync(tmp, dbPath);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best-effort cleanup */
		}
		die(`cannot write ledger ${dbPath}: ${err instanceof Error ? err.message : String(err)}`, 2);
	}
}

function findRecord(ledger, id) {
	const rec = ledger.applications.find((a) => a.id === id);
	if (!rec) {
		const known = ledger.applications.length > 0 ? ` (known ids: ${ledger.applications.map((a) => a.id).join(", ")})` : " — the ledger is empty";
		die(`unknown application id ${id === undefined ? "<missing>" : `#${id}`}${known}`, 2);
	}
	return rec;
}

function sortedByRecency(records) {
	return [...records].sort((a, b) => {
		if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
		return Number(b.id) - Number(a.id);
	});
}

function cmdAdd(ledger, flags) {
	const company = flags.get("company");
	const role = flags.get("role");
	if (!company || !role) die("add requires --company <name> and --role <title>");
	const date = flags.get("date") ?? todayISO();
	if (!isRealDate(date)) die(`--date must be a real YYYY-MM-DD calendar date (got "${date}")`);
	const rec = {
		id: String(ledger.nextId),
		company: company.trim(),
		role: role.trim(),
		url: String(flags.get("url") ?? "").trim(),
		source: String(flags.get("source") ?? "").trim(),
		location: String(flags.get("location") ?? "").trim(),
		status: "applied",
		createdAt: date,
		updatedAt: date,
		history: [{ date, status: "applied", note: String(flags.get("notes") ?? "").trim() }],
	};
	ledger.applications.push(rec);
	ledger.nextId += 1;
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
	} else {
		process.stdout.write(`Added #${rec.id} — ${rec.company} — ${rec.role} (applied, ${date})\n`);
	}
}

function cmdUpdate(ledger, id, flags) {
	if (id === undefined) die("update requires an application id");
	const status = flags.get("status");
	if (!status) die(`update requires --status (one of: ${STATUSES.join(", ")})`);
	const rec = findRecord(ledger, id);
	const date = flags.get("date") ?? todayISO();
	rec.status = status;
	rec.updatedAt = date;
	rec.history.push({ date, status, note: String(flags.get("notes") ?? "").trim() });
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
	} else {
		process.stdout.write(`#${rec.id} — ${rec.company} — ${rec.role}: ${status} (${date})\n`);
	}
}

function cmdNote(ledger, id, flags) {
	if (id === undefined) die("note requires an application id");
	const note = String(flags.get("notes") ?? "").trim();
	if (!note) die("note requires --notes <text>");
	const rec = findRecord(ledger, id);
	const date = flags.get("date") ?? todayISO();
	rec.updatedAt = date;
	rec.history.push({ date, status: rec.status, note });
	process.stdout.write(`Noted on #${rec.id} (${date})\n`);
}

function cmdList(ledger, flags) {
	let records = ledger.applications;
	const status = flags.get("status");
	if (status !== undefined) {
		if (!STATUSES.includes(status)) die(`--status must be one of: ${STATUSES.join(", ")} (got "${status}")`);
		records = records.filter((r) => r.status === status);
	}
	const company = flags.get("company");
	if (company !== undefined) {
		records = records.filter((r) => r.company.toLowerCase().includes(company.toLowerCase()));
	}
	records = sortedByRecency(records);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
		return;
	}
	if (records.length === 0) {
		process.stdout.write(ledger.applications.length === 0 ? "The ledger is empty — add your first application with the add command.\n" : "No applications match.\n");
		return;
	}
	const header = "ID    APPLIED     COMPANY                   ROLE                           STATUS";
	process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
	for (const r of records) {
		process.stdout.write(`${`#${r.id}`.padEnd(6)}${r.createdAt.padEnd(12)}${clip(r.company, 24).padEnd(26)}${clip(r.role, 29).padEnd(31)}${r.status}\n`);
	}
}

function cmdShow(ledger, id, flags) {
	if (id === undefined) die("show requires an application id");
	const rec = findRecord(ledger, id);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
		return;
	}
	process.stdout.write(`#${rec.id} ${rec.company} — ${rec.role}\n`);
	if (rec.location) process.stdout.write(`Location: ${rec.location}\n`);
	if (rec.url) process.stdout.write(`URL: ${rec.url}\n`);
	if (rec.source) process.stdout.write(`Source: ${rec.source}\n`);
	process.stdout.write(`Status: ${rec.status} (applied ${rec.createdAt}, last activity ${rec.updatedAt})\n`);
	if (rec.history.length > 0) {
		process.stdout.write("History:\n");
		for (const h of rec.history) {
			process.stdout.write(`  ${h.date}  ${h.status}${h.note ? ` — ${h.note}` : ""}\n`);
		}
	}
}

function cmdFollowups(ledger, flags) {
	const staleRaw = flags.get("stale-days");
	if (staleRaw !== undefined && (!/^\d+$/.test(staleRaw) || Number(staleRaw) < 1)) {
		die(`--stale-days must be a positive whole number of days (got "${staleRaw}")`);
	}
	const staleDays = staleRaw === undefined ? 7 : Number(staleRaw);
	const today = todayISO();
	const stale = sortedByRecency(ledger.applications.filter((r) => !TERMINAL.has(r.status)))
		.map((rec) => ({ rec, days: daysBetween(rec.updatedAt, today) }))
		.filter((e) => e.days >= staleDays)
		.sort((a, b) => b.days - a.days);
	if (flags.get("__json")) {
		process.stdout.write(
			`${JSON.stringify(
				stale.map((e) => ({
					id: e.rec.id,
					company: e.rec.company,
					role: e.rec.role,
					status: e.rec.status,
					daysSinceActivity: e.days,
					suggestedAction: NEXT_ACTION[e.rec.status] ?? "Follow up",
				})),
				null,
				2,
			)}\n`,
		);
		return;
	}
	if (stale.length === 0) {
		process.stdout.write(`Nothing is stale — every active application had activity within the last ${staleDays} day(s).\n`);
		return;
	}
	process.stdout.write(`${stale.length} application(s) need attention (no activity for >= ${staleDays} day(s)):\n\n`);
	for (const e of stale) {
		const action = NEXT_ACTION[e.rec.status] ?? "Follow up";
		process.stdout.write(`  #${e.rec.id}  ${clip(e.rec.company, 22).padEnd(24)}${clip(e.rec.role, 26).padEnd(28)}${e.rec.status.padEnd(11)}${e.days}d ago  ${action}\n`);
	}
}

function cmdStats(ledger, flags) {
	const byStatus = {};
	for (const s of STATUSES) byStatus[s] = 0;
	for (const r of ledger.applications) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
	const total = ledger.applications.length;
	const active = ledger.applications.filter((r) => !TERMINAL.has(r.status)).length;
	const responded = ledger.applications.filter((r) => RESPONDED.has(r.status)).length;
	const rate = total === 0 ? "n/a" : `${Math.round((responded / total) * 100)}%`;
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ total, byStatus, active, responses: responded, responseRate: rate }, null, 2)}\n`);
		return;
	}
	process.stdout.write(`Applications: ${total}\n`);
	process.stdout.write(`  ${STATUSES.map((s) => `${s} ${byStatus[s]}`).join(" | ")}\n`);
	process.stdout.write(`Active: ${active}\n`);
	process.stdout.write(`Responses: ${responded}/${total} (${rate})\n`);
}

function cmdRemove(ledger, id) {
	if (id === undefined) die("remove requires an application id");
	findRecord(ledger, id);
	ledger.applications = ledger.applications.filter((a) => a.id !== id);
	process.stdout.write(`Removed #${id} from the ledger.\n`);
}

function main() {
	const parsed = parseArgv(process.argv.slice(2));
	if (parsed.tokens.length === 0) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(1);
	}
	const { flags, positional } = readFlags(parsed.tokens, VALUE_FLAGS);
	const command = positional[0];
	const id = positional[1];
	flags.set("__json", parsed.json);
	checkedFlags(flags);

	const dbPath = ledgerPath(flags.get("db"));
	const mutating = new Set(["add", "update", "note", "remove"]);
	const ledger = loadLedger(dbPath);
	switch (command) {
		case "add":
			cmdAdd(ledger, flags);
			break;
		case "update":
			cmdUpdate(ledger, id, flags);
			break;
		case "note":
			cmdNote(ledger, id, flags);
			break;
		case "list":
			cmdList(ledger, flags);
			break;
		case "show":
			cmdShow(ledger, id, flags);
			break;
		case "followups":
			cmdFollowups(ledger, flags);
			break;
		case "stats":
			cmdStats(ledger, flags);
			break;
		case "remove":
			cmdRemove(ledger, id);
			break;
		default:
			die(`unknown command "${command}"\n\n${USAGE}`);
	}
	if (mutating.has(command)) saveLedger(dbPath, ledger);
}

main();
