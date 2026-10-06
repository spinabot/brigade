#!/usr/bin/env node
/**
 * expense-split — a tiny, dependency-free ledger for shared group expenses.
 *
 * Part of the bundled `expense-split` skill. One JSON file holds every
 * group, expense, and repayment; every command prints plain, fixed-width
 * text an agent (or a human) can read straight from a terminal.
 *
 * Money is exact: every amount is parsed into integer cents and every
 * share is an integer number of cents (remainder cents go deterministically
 * to the first names in the split), so balances always sum to exactly zero.
 * `simplify` reduces the debt graph to the fewest transfers via greedy
 * min-matching, and every computed transfer list is verified to zero out
 * the balances before it is printed.
 *
 * Usage:
 *   split.mjs [--db <path>] group add <name> --members a,b,c
 *   split.mjs [--db <path>] group list | group show <group> | group remove <group> --yes
 *   split.mjs [--db <path>] member add <group> <name> | member remove <group> <name>
 *   split.mjs [--db <path>] expense add <group> <payer> <amount> [--desc D] [--split a,b] [--date D]
 *   split.mjs [--db <path>] expense list <group> | expense remove <group> <expenseId>
 *   split.mjs [--db <path>] balances <group> [--json]
 *   split.mjs [--db <path>] simplify <group> [--json]
 *   split.mjs [--db <path>] settle <group> <from> <to> <amount> [--note N] [--date D]
 *
 * Exit codes: 0 ok | 1 usage error | 2 data error (corrupt ledger, unknown id)
 */

import * as fs from "node:fs";
import * as path from "node:path";

const USAGE = `Usage: split.mjs [--db <path>] <command> [options]

Commands:
  group add <name> --members a,b,c
  group list | group show <group> | group remove <group> --yes
  member add <group> <name> | member remove <group> <name>
  expense add <group> <payer> <amount> [--desc D] [--split a,b] [--date D]
  expense list <group> | expense remove <group> <expenseId>
  balances <group> [--json]
  simplify <group> [--json]
  settle <group> <from> <to> <amount> [--note N] [--date D]

Groups are referenced by name or id; members by name (case-insensitive).
Amounts are dollars with up to 2 decimals (90, 42.80). The ledger
defaults to <cwd>/expenses/expenses.json; --db overrides it.
Dates are local YYYY-MM-DD (default: today).`;

function die(message, code = 1) {
	process.stderr.write(`split: ${message}\n`);
	process.exit(code);
}

/** Today as a local YYYY-MM-DD string. */
function todayISO() {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Accept only real calendar dates in YYYY-MM-DD form. */
function isRealDate(s) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const [y, m, d] = s.split("-").map(Number);
	const dt = new Date(y, m - 1, d);
	return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Parse a dollar amount into integer cents; null when not a valid amount. */
function parseAmountCents(raw) {
	const s = String(raw ?? "").trim().replace(/^\$/, "");
	if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
	const dot = s.indexOf(".");
	if (dot === -1) return Number(s) * 100;
	const dollars = Number(s.slice(0, dot));
	const frac = s.slice(dot + 1);
	const cents = frac.length === 1 ? Number(frac) * 10 : Number(frac);
	return dollars * 100 + cents;
}

/** Format integer cents as a display string; never introduces float error. */
function money(cents) {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Flags that take a value; every other --flag is boolean (e.g. --yes). */
const VALUE_FLAGS = new Set(["members", "desc", "split", "date", "note", "db", "json"]);

/**
 * Peel off the global `--json` / `--help` flags, leaving every other token
 * (command words, names, value flags incl. `--db`) for readFlags, which
 * resolves them position-independently.
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

/** Collect `--flag value` / boolean `--flag` pairs; non-flags are positional. */
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

function ledgerPath(dbFlag) {
	return dbFlag ?? path.join(process.cwd(), "expenses", "expenses.json");
}

function loadLedger(dbPath) {
	if (!fs.existsSync(dbPath)) return { version: 1, nextGroupId: 1, nextEntryId: 1, groups: [] };
	let raw;
	try {
		raw = fs.readFileSync(dbPath, "utf8");
	} catch (err) {
		die(`cannot read ledger ${dbPath}: ${err instanceof Error ? err.message : String(err)}`, 2);
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.groups)) {
			throw new Error("not an expense-split ledger (missing groups array)");
		}
		parsed.nextGroupId ??= parsed.groups.length + 1;
		parsed.nextEntryId ??= 1;
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

/** Find a group by name (case-insensitive) or id. */
function findGroup(ledger, ref) {
	const key = String(ref ?? "").toLowerCase();
	const group = ledger.groups.find((g) => g.name.toLowerCase() === key || g.id.toLowerCase() === key);
	if (!group) {
		const known = ledger.groups.length > 0 ? ` (known groups: ${ledger.groups.map((g) => g.name).join(", ")})` : " — the ledger has no groups";
		die(`unknown group "${ref === undefined ? "<missing>" : ref}"${known}`, 2);
	}
	return group;
}

/** Case-insensitive member lookup; dies as a data error when absent. */
function findMember(group, name) {
	const key = String(name ?? "").toLowerCase();
	const member = group.members.find((m) => m.toLowerCase() === key);
	if (!member) {
		die(`unknown member "${name === undefined ? "<missing>" : name}" in group "${group.name}" (members: ${group.members.join(", ")})`, 2);
	}
	return member;
}

/** Validate + normalize a member list; dies as a usage error on garbage. */
function parseMemberList(raw, context) {
	const names = String(raw ?? "")
		.split(",")
		.map((n) => n.trim())
		.filter((n) => n.length > 0);
	if (names.length === 0) die(`${context} requires at least one member name`);
	for (const n of names) {
		if (n.length > 40) die(`member names must be at most 40 chars (got a ${n.length}-char name in "${raw}")`);
		if (n.includes(",")) die(`member names must not contain commas (got "${n}")`);
	}
	const lower = names.map((n) => n.toLowerCase());
	if (new Set(lower).size !== lower.length) die(`${context} must not repeat a member (got "${raw}")`);
	return names;
}

/**
 * Split `totalCents` among `sharers` exactly: everyone gets floor(total/n),
 * the first (total mod n) sharers get one extra cent. Deterministic, and
 * the shares always sum back to the total.
 */
function splitEvenly(totalCents, sharers) {
	const base = Math.floor(totalCents / sharers.length);
	let remainder = totalCents % sharers.length;
	const shares = new Map();
	for (const name of sharers) {
		const share = remainder > 0 ? base + 1 : base;
		if (remainder > 0) remainder--;
		shares.set(name, share);
	}
	return shares;
}

/**
 * Net balance per member in integer cents: payers are owed what they laid
 * out, sharers owe their share, settlements move real repayments.
 * Always sums to exactly zero.
 */
function computeBalances(group) {
	const balances = new Map(group.members.map((m) => [m, 0]));
	for (const e of group.expenses) {
		balances.set(e.payer, (balances.get(e.payer) ?? 0) + e.amountCents);
		const sharers = e.split.length > 0 ? e.split : group.members;
		const shares = splitEvenly(e.amountCents, sharers);
		for (const [name, share] of shares) {
			balances.set(name, (balances.get(name) ?? 0) - share);
		}
	}
	for (const s of group.settlements) {
		balances.set(s.from, (balances.get(s.from) ?? 0) + s.amountCents);
		balances.set(s.to, (balances.get(s.to) ?? 0) - s.amountCents);
	}
	return balances;
}

/**
 * Minimal-transfer settle-up via greedy min-matching: the largest debtor
 * pays the largest creditor until both are even. Produces at most
 * (members - 1) transfers and is verified below to zero every balance.
 */
function simplifyDebts(balances) {
	const creditors = [...balances.entries()].filter(([, c]) => c > 0).map(([name, c]) => ({ name, c })).sort((a, b) => b.c - a.c);
	const debtors = [...balances.entries()].filter(([, c]) => c < 0).map(([name, c]) => ({ name, c: -c })).sort((a, b) => b.c - a.c);
	const transfers = [];
	let ci = 0;
	let di = 0;
	while (ci < creditors.length && di < debtors.length) {
		const amount = Math.min(creditors[ci].c, debtors[di].c);
		transfers.push({ from: debtors[di].name, to: creditors[ci].name, amountCents: amount });
		creditors[ci].c -= amount;
		debtors[di].c -= amount;
		if (creditors[ci].c === 0) ci++;
		if (debtors[di].c === 0) di++;
	}
	// Sanity: the transfer list must exactly cancel every balance.
	const applied = new Map(balances);
	for (const t of transfers) {
		applied.set(t.from, (applied.get(t.from) ?? 0) + t.amountCents);
		applied.set(t.to, (applied.get(t.to) ?? 0) - t.amountCents);
	}
	for (const [name, c] of applied) {
		if (c !== 0) die(`internal: transfer plan leaves ${name} at ${money(c)} — refusing to display it`, 2);
	}
	return transfers;
}

function cmdGroupAdd(ledger, name, flags) {
	if (name === undefined) die("group add requires a group name");
	const groupName = String(name).trim();
	if (groupName.length === 0 || groupName.length > 80) die("group name must be 1..80 chars");
	if (groupName.includes(",")) die("group name must not contain commas");
	if (ledger.groups.some((g) => g.name.toLowerCase() === groupName.toLowerCase())) {
		die(`group "${groupName}" already exists`, 1);
	}
	const members = parseMemberList(flags.get("members"), "group add --members");
	const group = {
		id: `g${ledger.nextGroupId}`,
		name: groupName,
		createdAt: todayISO(),
		members,
		expenses: [],
		settlements: [],
	};
	ledger.groups.push(group);
	ledger.nextGroupId += 1;
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(group, null, 2)}\n`);
	} else {
		process.stdout.write(`Added ${group.id} "${groupName}" — members: ${members.join(", ")}\n`);
	}
}

function cmdGroupList(ledger, flags) {
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(ledger.groups.map((g) => ({ id: g.id, name: g.name, members: g.members.length, expenses: g.expenses.length, settlements: g.settlements.length })), null, 2)}\n`);
		return;
	}
	if (ledger.groups.length === 0) {
		process.stdout.write("No groups yet — create one with: group add <name> --members a,b,c\n");
		return;
	}
	for (const g of ledger.groups) {
		const total = g.expenses.reduce((sum, e) => sum + e.amountCents, 0);
		process.stdout.write(`${g.id}  ${g.name}  — ${g.members.length} member(s), ${g.expenses.length} expense(s), ${money(total)} logged\n`);
	}
}

function cmdGroupShow(ledger, ref, flags) {
	if (ref === undefined) die("group show requires a group name or id");
	const group = findGroup(ledger, ref);
	const total = group.expenses.reduce((sum, e) => sum + e.amountCents, 0);
	const paid = new Map(group.members.map((m) => [m, 0]));
	for (const e of group.expenses) paid.set(e.payer, (paid.get(e.payer) ?? 0) + e.amountCents);
	const settled = group.settlements.reduce((sum, s) => sum + s.amountCents, 0);
	if (flags.get("__json")) {
		process.stdout.write(
			`${JSON.stringify({ id: group.id, name: group.name, createdAt: group.createdAt, members: group.members, totalLoggedCents: total, totalSettledCents: settled, expenses: group.expenses, settlements: group.settlements }, null, 2)}\n`,
		);
		return;
	}
	process.stdout.write(`${group.id} "${group.name}" (created ${group.createdAt})\n`);
	process.stdout.write(`Members: ${group.members.join(", ")}\n`);
	process.stdout.write(`Logged: ${money(total)} across ${group.expenses.length} expense(s); ${money(settled)} settled in ${group.settlements.length} repayment(s)\n`);
	for (const m of group.members) {
		process.stdout.write(`  ${m}: paid ${money(paid.get(m) ?? 0)}\n`);
	}
}

function cmdGroupRemove(ledger, ref, flags) {
	if (ref === undefined) die("group remove requires a group name or id");
	if (!flags.get("yes")) die(`group remove is destructive and needs --yes (this deletes "${ref}" and all its expenses)`, 1);
	const group = findGroup(ledger, ref);
	ledger.groups = ledger.groups.filter((g) => g.id !== group.id);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ removed: group.name, expensesDropped: group.expenses.length, settlementsDropped: group.settlements.length }, null, 2)}\n`);
	} else {
		process.stdout.write(`Removed "${group.name}" and its ${group.expenses.length} expense(s) + ${group.settlements.length} settlement(s).\n`);
	}
}

function cmdMemberAdd(ledger, groupRef, name, flags) {
	if (groupRef === undefined || name === undefined) die("member add requires a group and a member name");
	const group = findGroup(ledger, groupRef);
	const [member] = parseMemberList(String(name), "member add");
	if (group.members.some((m) => m.toLowerCase() === member.toLowerCase())) {
		die(`"${member}" is already a member of "${group.name}"`, 1);
	}
	group.members.push(member);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ group: group.name, added: member, members: group.members }, null, 2)}\n`);
	} else {
		process.stdout.write(`Added ${member} to "${group.name}" (starting balance ${money(0)}).\n`);
	}
}

function cmdMemberRemove(ledger, groupRef, name, flags) {
	if (groupRef === undefined || name === undefined) die("member remove requires a group and a member name");
	const group = findGroup(ledger, groupRef);
	const member = findMember(group, name);
	const balances = computeBalances(group);
	if ((balances.get(member) ?? 0) !== 0) {
		die(`"${member}" has a non-zero balance (${money(balances.get(member) ?? 0)}) — settle up first; removing them now would lose money`, 1);
	}
	group.members = group.members.filter((m) => m !== member);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ group: group.name, removed: member, members: group.members }, null, 2)}\n`);
	} else {
		process.stdout.write(`Removed ${member} from "${group.name}".\n`);
	}
}

function cmdExpenseAdd(ledger, groupRef, payerRef, amountRaw, flags) {
	if (groupRef === undefined || payerRef === undefined || amountRaw === undefined) {
		die("expense add requires a group, a payer, and an amount");
	}
	const cents = parseAmountCents(amountRaw);
	if (cents === null) die(`amount must be dollars with up to 2 decimals (got "${amountRaw}")`);
	if (cents === 0) die("amount must be greater than zero");
	const date = flags.get("date") ?? todayISO();
	if (!isRealDate(date)) die(`--date must be a real YYYY-MM-DD calendar date (got "${date}")`);
	if (date > todayISO()) die(`--date is in the future (${date}) — expenses are for purchases that happened`);
	const group = findGroup(ledger, groupRef);
	const payer = findMember(group, payerRef);
	const desc = String(flags.get("desc") ?? "").trim();
	let split = [];
	const splitRaw = flags.get("split");
	if (splitRaw !== undefined) {
		split = parseMemberList(splitRaw, "expense add --split");
		for (const name of split) findMember(group, name);
	}
	const expense = {
		id: `e${ledger.nextEntryId}`,
		payer,
		amountCents: cents,
		...(desc ? { desc } : {}),
		date,
		split,
	};
	ledger.nextEntryId += 1;
	group.expenses.push(expense);
	if (flags.get("__json")) {
		const shares = splitEvenly(cents, split.length > 0 ? split : group.members);
		process.stdout.write(`${JSON.stringify({ ...expense, shares: Object.fromEntries(shares) }, null, 2)}\n`);
	} else {
		const who = split.length > 0 ? split.join(", ") : "everyone";
		process.stdout.write(`Added ${expense.id} — ${payer} paid ${money(cents)} for ${desc || "expense"} (shared by ${who}, ${date})\n`);
	}
}

function cmdExpenseList(ledger, groupRef, flags) {
	if (groupRef === undefined) die("expense list requires a group");
	const group = findGroup(ledger, groupRef);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(group.expenses, null, 2)}\n`);
		return;
	}
	if (group.expenses.length === 0) {
		process.stdout.write(`No expenses in "${group.name}" yet — add one with: expense add ${group.name} <payer> <amount>\n`);
		return;
	}
	const header = "ID    DATE        PAYER            AMOUNT    SPLIT          DESCRIPTION";
	process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
	for (const e of group.expenses) {
		const who = e.split.length > 0 ? e.split.join(",").slice(0, 12) : "everyone";
		process.stdout.write(`${e.id.padEnd(6)}${e.date.padEnd(12)}${e.payer.slice(0, 15).padEnd(17)}${money(e.amountCents).padStart(8)}  ${who.padEnd(14)}${e.desc ?? ""}\n`);
	}
}

function cmdExpenseRemove(ledger, groupRef, expenseId, flags) {
	if (groupRef === undefined || expenseId === undefined) die("expense remove requires a group and an expense id");
	const group = findGroup(ledger, groupRef);
	const expense = group.expenses.find((e) => e.id === String(expenseId).toLowerCase());
	if (!expense) {
		const known = group.expenses.length > 0 ? ` (known ids: ${group.expenses.map((e) => e.id).join(", ")})` : " — the group has no expenses";
		die(`unknown expense id "${expenseId}" in "${group.name}"${known}`, 2);
	}
	group.expenses = group.expenses.filter((e) => e.id !== expense.id);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ removed: expense.id, amountCents: expense.amountCents }, null, 2)}\n`);
	} else {
		process.stdout.write(`Removed ${expense.id} (${money(expense.amountCents)}, paid by ${expense.payer}) from "${group.name}".\n`);
	}
}

function cmdBalances(ledger, groupRef, flags) {
	if (groupRef === undefined) die("balances requires a group");
	const group = findGroup(ledger, groupRef);
	const balances = computeBalances(group);
	const rows = group.members.map((m) => ({ member: m, cents: balances.get(m) ?? 0 }));
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ group: group.name, balances: rows }, null, 2)}\n`);
		return;
	}
	process.stdout.write(`Balances for "${group.name}":\n`);
	for (const r of rows) {
		const mark = r.cents > 0 ? "is owed" : r.cents < 0 ? "owes" : "even";
		process.stdout.write(`  ${r.member.padEnd(20)} ${mark.padEnd(8)} ${money(r.cents)}\n`);
	}
}

function cmdSimplify(ledger, groupRef, flags) {
	if (groupRef === undefined) die("simplify requires a group");
	const group = findGroup(ledger, groupRef);
	const transfers = simplifyDebts(computeBalances(group));
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ group: group.name, transfers }, null, 2)}\n`);
		return;
	}
	if (transfers.length === 0) {
		process.stdout.write(`"${group.name}" is fully settled — no transfers needed.\n`);
		return;
	}
	process.stdout.write(`To settle "${group.name}" in ${transfers.length} transfer(s):\n`);
	for (const t of transfers) {
		process.stdout.write(`  ${t.from} → ${t.to}  ${money(t.amountCents)}\n`);
	}
}

function cmdSettle(ledger, groupRef, fromRef, toRef, amountRaw, flags) {
	if (groupRef === undefined || fromRef === undefined || toRef === undefined || amountRaw === undefined) {
		die("settle requires a group, a payer (from), a recipient (to), and an amount");
	}
	const cents = parseAmountCents(amountRaw);
	if (cents === null) die(`amount must be dollars with up to 2 decimals (got "${amountRaw}")`);
	if (cents === 0) die("amount must be greater than zero");
	const date = flags.get("date") ?? todayISO();
	if (!isRealDate(date)) die(`--date must be a real YYYY-MM-DD calendar date (got "${date}")`);
	if (date > todayISO()) die(`--date is in the future (${date}) — settlements are for money that moved`);
	const group = findGroup(ledger, groupRef);
	const from = findMember(group, fromRef);
	const to = findMember(group, toRef);
	if (from === to) die("settle needs two different members — a person cannot repay themselves", 1);
	const note = String(flags.get("note") ?? "").trim();
	const settlement = { id: `s${ledger.nextEntryId}`, from, to, amountCents: cents, ...(note ? { note } : {}), date };
	ledger.nextEntryId += 1;
	group.settlements.push(settlement);
	if (flags.get("__json")) {
		const balances = computeBalances(group);
		process.stdout.write(`${JSON.stringify({ ...settlement, resultingBalances: Object.fromEntries(group.members.map((m) => [m, balances.get(m) ?? 0])) }, null, 2)}\n`);
	} else {
		process.stdout.write(`Recorded ${settlement.id}: ${from} → ${to} ${money(cents)} (${date})${note ? ` — ${note}` : ""}\n`);
	}
}

function main() {
	const parsed = parseArgv(process.argv.slice(2));
	if (parsed.tokens.length === 0) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(1);
	}
	const { flags, positional } = readFlags(parsed.tokens, VALUE_FLAGS);
	flags.set("__json", parsed.json);

	const dbPath = ledgerPath(flags.get("db"));
	const mutating = new Set(["add", "remove", "settle"]);
	const ledger = loadLedger(dbPath);

	const [domain, action, a, b, c] = positional;
	if (domain !== "group" && domain !== "member" && domain !== "expense" && domain !== "balances" && domain !== "simplify" && domain !== "settle") {
		die(`unknown command "${domain ?? "<missing>"}"\n\n${USAGE}`);
	}
	// The mutation verb lives in different slots per domain: `expense add`
	// has it in `action`, but `settle <group> …` carries the group ref there —
	// its verb is the domain itself. Getting this wrong silently drops the
	// write (the command prints success but nothing persists).
	const verb = domain === "settle" ? "settle" : action;

	switch (domain) {
		case "group":
			switch (action) {
				case "add":
					cmdGroupAdd(ledger, a, flags);
					break;
				case "list":
					cmdGroupList(ledger, flags);
					break;
				case "show":
					cmdGroupShow(ledger, a, flags);
					break;
				case "remove":
					cmdGroupRemove(ledger, a, flags);
					break;
				default:
					die(`unknown group command "${action}" — use add, list, show, or remove\n\n${USAGE}`);
			}
			break;
		case "member":
			switch (action) {
				case "add":
					cmdMemberAdd(ledger, a, b, flags);
					break;
				case "remove":
					cmdMemberRemove(ledger, a, b, flags);
					break;
				default:
					die(`unknown member command "${action}" — use add or remove\n\n${USAGE}`);
			}
			break;
		case "expense":
			switch (action) {
				case "add":
					cmdExpenseAdd(ledger, a, b, c, flags);
					break;
				case "list":
					cmdExpenseList(ledger, a, flags);
					break;
				case "remove":
					cmdExpenseRemove(ledger, a, b, flags);
					break;
				default:
					die(`unknown expense command "${action}" — use add, list, or remove\n\n${USAGE}`);
			}
			break;
		case "balances":
			cmdBalances(ledger, action, flags);
			break;
		case "simplify":
			cmdSimplify(ledger, action, flags);
			break;
		case "settle":
			cmdSettle(ledger, action, a, b, c, flags);
			break;
	}
	if (mutating.has(verb)) saveLedger(dbPath, ledger);
}

main();
