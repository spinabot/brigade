#!/usr/bin/env node
/**
 * invoice-maker — a per-workspace invoicing ledger for getting paid.
 *
 * Tracks invoices from draft → sent → (partially) paid → paid, with
 * escalation-ready reminders for overdue clients and an earnings report.
 * The ledger is a single JSON file at `<cwd>/invoices/invoices.json` so it
 * travels with the workspace (git-friendly, diffable) instead of living in
 * an opaque database.
 *
 * Design invariants:
 *   - The ledger is the source of truth; every command re-reads it.
 *   - Money is integer cents everywhere. Rates are parsed to cents, line
 *     amounts are rounded exactly once (qty × rateCents), tax applies after
 *     discount, and no total ever passes through binary floating point.
 *   - Payments are honest: `pay` refuses an amount above the outstanding
 *     balance — an overpayment is a bookkeeping error, not a windfall.
 *   - Financial records are never deleted: unpaid invoices are voided,
 *     paid invoices cannot be voided, and there is no `remove`.
 *   - Writes are atomic (temp file + rename) so a crash can never leave a
 *     half-written ledger behind.
 *   - A corrupt or malformed ledger is REFUSED (exit 2) rather than
 *     silently overwritten — losing an invoice history is unacceptable.
 *
 * Exit codes: 0 success · 1 usage / not-found / refused · 2 corrupt ledger.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const LEDGER_DIR = "invoices";
const LEDGER_FILE = "invoices.json";
const STATUSES = ["draft", "sent", "partial", "paid", "void"];
const ID_PREFIX = "INV-";
const DEFAULT_TERMS_DAYS = 14;

class UsageError extends Error {}
class CorruptLedgerError extends Error {}

function ledgerPath() {
	return path.join(process.cwd(), LEDGER_DIR, LEDGER_FILE);
}

function emptyLedger() {
	return { version: 1, nextNumber: 1, invoices: [] };
}

function loadLedger() {
	const p = ledgerPath();
	let raw;
	try {
		raw = readFileSync(p, "utf8");
	} catch {
		return emptyLedger();
	}
	if (!raw.trim()) return emptyLedger();
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CorruptLedgerError(`refusing to touch a corrupt ledger at ${p} (invalid JSON)`);
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.invoices) || !Number.isInteger(parsed.nextNumber)) {
		throw new CorruptLedgerError(
			`refusing to touch a malformed ledger at ${p} (missing "invoices" array or "nextNumber")`,
		);
	}
	return { version: 1, nextNumber: parsed.nextNumber, invoices: parsed.invoices };
}

function saveLedger(ledger) {
	const p = ledgerPath();
	mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`;
	writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, p);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* best-effort temp cleanup */
		}
		throw err;
	}
}

/* ─────────────────────────────── parsing ─────────────────────────────── */

function pushFlag(flags, key, value) {
	if (Object.prototype.hasOwnProperty.call(flags, key)) {
		const prev = flags[key];
		flags[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
	} else {
		flags[key] = value;
	}
}

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq !== -1) {
				pushFlag(flags, a.slice(2, eq), a.slice(eq + 1));
				continue;
			}
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				pushFlag(flags, key, next);
				i += 1;
			} else {
				pushFlag(flags, key, true);
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

/** A flag as a trimmed string, or "" when absent / given without a value. */
function strFlag(flags, key) {
	const v = flags[key];
	return typeof v === "string" ? v.trim() : "";
}

/** Parse a money amount (dollars) into integer cents. Strict: max 2 decimals. */
function toCents(value, label) {
	const s = String(value).trim();
	if (!/^\d+(\.\d{1,2})?$/.test(s)) {
		throw new UsageError(`${label} must be a non-negative amount with at most 2 decimal places (got "${value}")`);
	}
	const [whole, frac = ""] = s.split(".");
	const cents = Number(whole) * 100 + Number(`${(frac + "00").slice(0, 2)}`);
	if (!Number.isSafeInteger(cents)) throw new UsageError(`${label} is too large`);
	return cents;
}

function requireQty(value) {
	const s = String(value).trim();
	if (!/^\d+(\.\d+)?$/.test(s)) {
		throw new UsageError(`item quantity must be a positive number (got "${value}")`);
	}
	const n = Number(s);
	if (!Number.isFinite(n) || n <= 0) throw new UsageError(`item quantity must be greater than zero (got "${value}")`);
	return n;
}

function requirePercent(value, label) {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0 || n > 100) {
		throw new UsageError(`${label} must be a percentage from 0 to 100 (got "${value}")`);
	}
	return n;
}

function requireNonNegInt(value, label) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new UsageError(`${label} must be a non-negative whole number`);
	return n;
}

function requireDate(value, label) {
	const s = String(value).trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		throw new UsageError(`${label} must be an ISO date (YYYY-MM-DD), got "${value}"`);
	}
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
		throw new UsageError(`${label} is not a real calendar date: "${value}"`);
	}
	return s;
}

function todayIso() {
	return new Date().toISOString().slice(0, 10);
}

function nowIso() {
	return new Date().toISOString();
}

function addDays(iso, days) {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (positive when to is later). */
function dayDiff(fromIso, toIso) {
	return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

/* ─────────────────────────────── money ─────────────────────────────── */

/** `123456` → `USD 1,234.56`. Locale-free so output is identical everywhere. */
function formatMoney(cents, currency) {
	const abs = Math.abs(cents);
	const whole = Math.floor(abs / 100)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${cents < 0 ? "-" : ""}${currency} ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents → a JSON-safe dollar number (2 dp). */
function centsToNumber(cents) {
	return Number((cents / 100).toFixed(2));
}

/**
 * Totals from line items (amounts already in integer cents).
 * Order matters and is pinned by tests: discount applies to the subtotal,
 * then tax applies to the discounted amount, each rounded once.
 */
function computeTotals(items, taxPercent, discountPercent) {
	const subtotal = items.reduce((sum, it) => sum + it.amount, 0);
	const discount = Math.round((subtotal * discountPercent) / 100);
	const taxable = subtotal - discount;
	const tax = Math.round((taxable * taxPercent) / 100);
	return { subtotal, discount, tax, total: taxable + tax };
}

function parseItem(raw) {
	const s = String(raw);
	const r2 = s.lastIndexOf("|");
	const r1 = r2 === -1 ? -1 : s.lastIndexOf("|", r2 - 1);
	if (r1 === -1) {
		throw new UsageError(`--item must look like "description|qty|rate" (got "${s}")`);
	}
	const description = s.slice(0, r1).trim();
	if (!description) throw new UsageError("--item description is empty");
	const qty = requireQty(s.slice(r1 + 1, r2).trim());
	const rate = toCents(s.slice(r2 + 1).trim(), `--item rate for "${description}"`);
	return { description, qty, rate, amount: Math.round(qty * rate) };
}

function balanceOf(inv) {
	return inv.total - inv.amountPaid;
}

function isOverdue(inv, today) {
	if (inv.status !== "sent" && inv.status !== "partial") return false;
	return dayDiff(inv.dueDate, today) > 0;
}

/* ─────────────────────────────── lookup ─────────────────────────────── */

function normalizeQuery(query) {
	const s = String(query).trim();
	if (/^\d+$/.test(s)) return `${ID_PREFIX}${s.padStart(4, "0")}`;
	return s.toUpperCase();
}

function findAll(ledger, query) {
	const q = String(query).trim();
	const norm = normalizeQuery(q);
	const exact = ledger.invoices.filter((i) => i.id.toUpperCase() === norm);
	if (exact.length > 0) return exact;
	const needle = q.toLowerCase();
	return ledger.invoices.filter(
		(i) => i.id.toLowerCase().includes(needle) || i.client.toLowerCase().includes(needle),
	);
}

function findOne(ledger, query) {
	const hits = findAll(ledger, query);
	if (hits.length === 0) throw new UsageError(`no invoice matches "${query}"`);
	if (hits.length > 1) {
		throw new UsageError(`"${query}" is ambiguous — it matches ${hits.map((h) => h.id).join(", ")}`);
	}
	return hits[0];
}

/* ─────────────────────────────── output ─────────────────────────────── */

function statusLabel(inv, today) {
	return isOverdue(inv, today) ? "OVERDUE" : inv.status;
}

function lineItem(inv, item) {
	return `${item.description} — ${item.qty} × ${formatMoney(item.rate, inv.currency)} = ${formatMoney(item.amount, inv.currency)}`;
}

/* ─────────────────────────────── commands ─────────────────────────────── */

function cmdNew(ledger, args, flags) {
	const client = args.join(" ").trim();
	if (!client) {
		throw new UsageError(
			'usage: new <client> --item "description|qty|rate" [--item ...] [--currency CUR] [--tax PCT] [--discount PCT] [--terms N|--due-date D] [--date D] [--from S] [--email S] [--pay-instructions S] [--notes S]',
		);
	}
	const raw = flags.item;
	const rawItems = raw === undefined || raw === true ? [] : Array.isArray(raw) ? raw : [raw];
	if (rawItems.length === 0) {
		throw new UsageError('at least one --item "description|qty|rate" is required');
	}
	const items = rawItems.map((r) => parseItem(r));
	const currency = strFlag(flags, "currency") ? strFlag(flags, "currency").toUpperCase() : "USD";
	if (!/^[A-Z]{3}$/.test(currency)) throw new UsageError(`--currency must be a 3-letter ISO code (got "${currency}")`);
	const taxPercent = flags.tax === undefined || flags.tax === true ? 0 : requirePercent(flags.tax, "--tax");
	const discountPercent =
		flags.discount === undefined || flags.discount === true ? 0 : requirePercent(flags.discount, "--discount");
	const terms =
		flags.terms === undefined || flags.terms === true ? DEFAULT_TERMS_DAYS : requireNonNegInt(flags.terms, "--terms");
	const issueDate = strFlag(flags, "date") ? requireDate(strFlag(flags, "date"), "--date") : todayIso();
	let dueDate;
	if (strFlag(flags, "due-date")) {
		dueDate = requireDate(strFlag(flags, "due-date"), "--due-date");
		if (dayDiff(issueDate, dueDate) < 0) {
			throw new UsageError(`--due-date (${dueDate}) is before the issue date (${issueDate})`);
		}
	} else {
		dueDate = addDays(issueDate, terms);
	}
	const totals = computeTotals(items, taxPercent, discountPercent);
	const id = `${ID_PREFIX}${String(ledger.nextNumber).padStart(4, "0")}`;
	const now = nowIso();
	const inv = {
		id,
		client,
		email: strFlag(flags, "email"),
		from: strFlag(flags, "from"),
		payInstructions: strFlag(flags, "pay-instructions"),
		notes: strFlag(flags, "notes"),
		currency,
		issueDate,
		dueDate,
		items,
		taxPercent,
		discountPercent,
		subtotal: totals.subtotal,
		discountAmount: totals.discount,
		taxAmount: totals.tax,
		total: totals.total,
		amountPaid: 0,
		status: "draft",
		payments: [],
		createdAt: now,
		updatedAt: now,
		sentAt: null,
		paidAt: null,
		voidedAt: null,
	};
	ledger.invoices.push(inv);
	ledger.nextNumber += 1;
	saveLedger(ledger);
	process.stdout.write(
		`Created ${id} for "${client}" — ${formatMoney(inv.total, inv.currency)} due ${inv.dueDate} (draft). Render with: render ${id}\n`,
	);
	return 0;
}

function cmdList(ledger, _args, flags) {
	const today = todayIso();
	let rows = ledger.invoices.slice();
	const status = strFlag(flags, "status").toLowerCase();
	if (status) {
		if (!STATUSES.includes(status) && status !== "overdue") {
			throw new UsageError(`--status must be one of: ${STATUSES.join(", ")}, overdue`);
		}
		rows = rows.filter((i) => (status === "overdue" ? isOverdue(i, today) : i.status === status));
	}
	const client = strFlag(flags, "client").toLowerCase();
	if (client) rows = rows.filter((i) => i.client.toLowerCase().includes(client));
	rows.sort((a, b) => a.id.localeCompare(b.id));
	if (flags.json === true) {
		process.stdout.write(
			`${JSON.stringify(
				rows.map((i) => ({
					id: i.id,
					client: i.client,
					status: i.status,
					overdue: isOverdue(i, today),
					currency: i.currency,
					total: centsToNumber(i.total),
					balance: centsToNumber(balanceOf(i)),
					issueDate: i.issueDate,
					dueDate: i.dueDate,
				})),
				null,
				2,
			)}\n`,
		);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write("No invoices match.\n");
		return 0;
	}
	for (const inv of rows) {
		const bits = [
			`${inv.id} `,
			statusLabel(inv, today).padEnd(8),
			inv.client,
			formatMoney(inv.total, inv.currency),
			`due ${inv.dueDate}`,
		];
		const bal = balanceOf(inv);
		if (bal > 0 && (inv.status === "sent" || inv.status === "partial")) {
			bits.push(`balance ${formatMoney(bal, inv.currency)}`);
		}
		process.stdout.write(`${bits.join("  ")}\n`);
	}
	process.stdout.write(`${rows.length} invoice(s).\n`);
	return 0;
}

function cmdShow(ledger, args) {
	if (args.length === 0) throw new UsageError("usage: show <id>");
	const inv = findOne(ledger, args[0]);
	const today = todayIso();
	const overdueDays = isOverdue(inv, today) ? dayDiff(inv.dueDate, today) : 0;
	process.stdout.write(`${inv.id} — ${inv.client}\n`);
	if (inv.email) process.stdout.write(`  email:    ${inv.email}\n`);
	if (inv.from) process.stdout.write(`  from:     ${inv.from}\n`);
	process.stdout.write(`  status:   ${statusLabel(inv, today)}${overdueDays > 0 ? ` (${overdueDays} days past due)` : ""}\n`);
	process.stdout.write(`  issued:   ${inv.issueDate}\n`);
	process.stdout.write(`  due:      ${inv.dueDate}\n`);
	process.stdout.write(`  currency: ${inv.currency}\n`);
	process.stdout.write("  items:\n");
	for (const item of inv.items) process.stdout.write(`    - ${lineItem(inv, item)}\n`);
	process.stdout.write(`  subtotal:      ${formatMoney(inv.subtotal, inv.currency)}\n`);
	if (inv.discountAmount > 0) {
		process.stdout.write(`  discount ${inv.discountPercent}%: -${formatMoney(inv.discountAmount, inv.currency)}\n`);
	}
	if (inv.taxAmount > 0) process.stdout.write(`  tax ${inv.taxPercent}%:      +${formatMoney(inv.taxAmount, inv.currency)}\n`);
	process.stdout.write(`  total:         ${formatMoney(inv.total, inv.currency)}\n`);
	process.stdout.write(`  paid:          ${formatMoney(inv.amountPaid, inv.currency)} (${inv.payments.length} payment(s))\n`);
	process.stdout.write(`  balance:       ${formatMoney(balanceOf(inv), inv.currency)}\n`);
	if (inv.payments.length > 0) {
		process.stdout.write("  payments:\n");
		for (const p of inv.payments) {
			process.stdout.write(`    - [${p.date}] ${formatMoney(p.amount, inv.currency)}${p.method ? ` via ${p.method}` : ""}\n`);
		}
	}
	if (inv.payInstructions) process.stdout.write(`  pay via:   ${inv.payInstructions}\n`);
	if (inv.notes) process.stdout.write(`  notes:     ${inv.notes}\n`);
	process.stdout.write(`  created:   ${inv.createdAt}\n`);
	if (inv.sentAt) process.stdout.write(`  sent:      ${inv.sentAt}\n`);
	if (inv.paidAt) process.stdout.write(`  paid:      ${inv.paidAt}\n`);
	if (inv.voidedAt) process.stdout.write(`  voided:    ${inv.voidedAt}\n`);
	return 0;
}

function cmdSend(ledger, args) {
	if (args.length === 0) throw new UsageError("usage: send <id>");
	const inv = findOne(ledger, args[0]);
	if (inv.status !== "draft") {
		throw new UsageError(`${inv.id} is already ${inv.status} — only a draft can be sent (use \`remind\` to nudge a sent invoice)`);
	}
	inv.status = "sent";
	inv.sentAt = nowIso();
	inv.updatedAt = inv.sentAt;
	saveLedger(ledger);
	process.stdout.write(`Sent ${inv.id} to "${inv.client}" — ${formatMoney(inv.total, inv.currency)} due ${inv.dueDate}.\n`);
	return 0;
}

function cmdPay(ledger, args, flags) {
	if (args.length < 2) throw new UsageError("usage: pay <id> <amount> [--method S] [--date D]");
	const inv = findOne(ledger, args[0]);
	if (inv.status === "void") throw new UsageError(`${inv.id} is void — payments cannot be recorded against it`);
	if (inv.status === "draft") throw new UsageError(`${inv.id} is still a draft — \`send ${inv.id}\` before recording payment`);
	if (inv.status === "paid") throw new UsageError(`${inv.id} is already paid in full`);
	const amount = toCents(args[1], "payment amount");
	if (amount <= 0) throw new UsageError("payment amount must be greater than zero");
	const balance = balanceOf(inv);
	if (amount > balance) {
		throw new UsageError(
			`payment ${formatMoney(amount, inv.currency)} exceeds the outstanding balance ${formatMoney(balance, inv.currency)} — refusing to over-record`,
		);
	}
	const date = strFlag(flags, "date") ? requireDate(strFlag(flags, "date"), "--date") : todayIso();
	inv.payments.push({ date, amount, method: strFlag(flags, "method") });
	inv.amountPaid += amount;
	inv.updatedAt = nowIso();
	const remaining = balanceOf(inv);
	if (remaining === 0) {
		inv.status = "paid";
		inv.paidAt = inv.updatedAt;
	} else {
		inv.status = "partial";
	}
	saveLedger(ledger);
	if (inv.status === "paid") {
		process.stdout.write(
			`Recorded ${formatMoney(amount, inv.currency)} on ${inv.id} — paid in full (total ${formatMoney(inv.total, inv.currency)}).\n`,
		);
	} else {
		process.stdout.write(
			`Recorded ${formatMoney(amount, inv.currency)} on ${inv.id} for "${inv.client}" — balance ${formatMoney(remaining, inv.currency)}.\n`,
		);
	}
	return 0;
}

function cmdVoid(ledger, args) {
	if (args.length === 0) throw new UsageError("usage: void <id>");
	const inv = findOne(ledger, args[0]);
	if (inv.status === "void") throw new UsageError(`${inv.id} is already void`);
	if (inv.status === "paid") {
		throw new UsageError(`${inv.id} is paid — paid invoices cannot be voided (financial records are never deleted)`);
	}
	const was = inv.status;
	inv.status = "void";
	inv.voidedAt = nowIso();
	inv.updatedAt = inv.voidedAt;
	saveLedger(ledger);
	process.stdout.write(`Voided ${inv.id} (was ${was}) — kept as a record, excluded from earnings stats.\n`);
	return 0;
}

/** Escalation ladder: ≤7 days friendly, 8–30 firm, >30 final notice. */
function reminderTier(daysOverdue) {
	if (daysOverdue <= 7) {
		return {
			label: "friendly",
			opening: "Just a friendly reminder that the following invoice is now overdue:",
			closing: "If you've already sent the payment, thank you! Otherwise we'd appreciate payment at your earliest convenience.",
		};
	}
	if (daysOverdue <= 30) {
		return {
			label: "firm",
			opening: "Our records show the following invoice is now significantly overdue:",
			closing: "Please arrange payment this week. If something is blocking it, reply and let us know.",
		};
	}
	return {
		label: "final",
		opening: "This is a final notice for the following seriously overdue invoice:",
		closing:
			"Until this invoice is settled we will need to pause further work on your account. Please arrange payment immediately, or reply to agree a payment plan.",
	};
}

function cmdRemind(ledger, args) {
	if (args.length === 0) throw new UsageError("usage: remind <id>");
	const inv = findOne(ledger, args[0]);
	if (inv.status === "draft") throw new UsageError(`${inv.id} is still a draft — \`send ${inv.id}\` first`);
	if (inv.status === "void") throw new UsageError(`${inv.id} is void — nothing to chase`);
	if (inv.status === "paid") throw new UsageError(`${inv.id} is already paid in full — nothing to chase`);
	const today = todayIso();
	if (!isOverdue(inv, today)) {
		const untilDue = dayDiff(today, inv.dueDate);
		throw new UsageError(
			`${inv.id} is not overdue yet — due ${inv.dueDate}${untilDue > 0 ? ` (in ${untilDue} day(s))` : " (due today)"}`,
		);
	}
	const days = dayDiff(inv.dueDate, today);
	const balance = balanceOf(inv);
	const tier = reminderTier(days);
	const lines = [
		`Reminder for ${inv.id} (${inv.client}) — ${days} day(s) overdue, balance ${formatMoney(balance, inv.currency)} [${tier.label}]:`,
		"",
		`Hi ${inv.client},`,
		"",
		`${tier.opening}`,
		`  Invoice:  ${inv.id}`,
		`  Amount:   ${formatMoney(balance, inv.currency)} outstanding of ${formatMoney(inv.total, inv.currency)}`,
		`  Due date: ${inv.dueDate} (${days} day(s) ago)`,
	];
	if (inv.payInstructions) lines.push(`  Pay via:   ${inv.payInstructions}`);
	lines.push("", tier.closing);
	if (inv.from) lines.push("", `— ${inv.from}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

/* ─────────────────────────────── render ─────────────────────────────── */

function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderHtml(inv, today) {
	const badge = statusLabel(inv, today);
	const itemRows = inv.items
		.map(
			(it) =>
				`<tr><td>${esc(it.description)}</td><td class="num">${esc(String(it.qty))}</td><td class="num">${esc(
					formatMoney(it.rate, inv.currency),
				)}</td><td class="num">${esc(formatMoney(it.amount, inv.currency))}</td></tr>`,
		)
		.join("\n      ");
	const discountRow =
		inv.discountAmount > 0
			? `<tr><td colspan="3">Discount (${esc(String(inv.discountPercent))}%)</td><td class="num">-${esc(
					formatMoney(inv.discountAmount, inv.currency),
				)}</td></tr>`
			: "";
	const taxRow =
		inv.taxAmount > 0
			? `<tr><td colspan="3">Tax (${esc(String(inv.taxPercent))}%)</td><td class="num">${esc(
					formatMoney(inv.taxAmount, inv.currency),
				)}</td></tr>`
			: "";
	const payBlock = inv.payInstructions
		? `<h2>How to pay</h2><p class="pay">${esc(inv.payInstructions)}</p>`
		: "";
	const notesBlock = inv.notes ? `<h2>Notes</h2><p>${esc(inv.notes)}</p>` : "";
	const fromBlock = inv.from
		? `<div class="col"><h3>From</h3><p>${esc(inv.from)}${inv.email ? `<br>${esc(inv.email)}` : ""}</p></div>`
		: "";
	const badgeClass = badge === "OVERDUE" ? "badge overdue" : badge === "paid" ? "badge paid" : "badge";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(inv.id)} — ${esc(inv.client)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #16181d; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; line-height: 1.5; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #16181d; padding-bottom: .75rem; }
  h1 { font-size: 1.6rem; margin: 0; letter-spacing: .04em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .1em; color: #5b616e; margin: 1.5rem 0 .35rem; }
  h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .1em; color: #5b616e; margin: 0 0 .35rem; }
  .badge { font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; border: 1.5px solid #16181d; border-radius: 999px; padding: .15rem .6rem; }
  .badge.overdue { border-color: #b42318; color: #b42318; }
  .badge.paid { border-color: #157f3d; color: #157f3d; }
  .cols { display: flex; gap: 2rem; flex-wrap: wrap; margin-top: 1.25rem; }
  .col p { margin: 0; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 1.25rem; }
  table.items th { text-align: left; font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: #5b616e; border-bottom: 1px solid #d5d8de; padding: .4rem 0; }
  table.items td { padding: .45rem 0; border-bottom: 1px solid #eceef1; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.totals { margin-left: auto; margin-top: 1rem; border-collapse: collapse; }
  table.totals td { padding: .25rem 0 .25rem 1.5rem; font-variant-numeric: tabular-nums; }
  table.totals tr.grand td { font-weight: 700; font-size: 1.1rem; border-top: 2px solid #16181d; }
  .pay { background: #f5f7fa; border: 1px solid #dfe3e9; border-radius: 8px; padding: .75rem 1rem; white-space: pre-wrap; }
  footer { margin-top: 2.5rem; font-size: .75rem; color: #8a919e; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>INVOICE</h1>
      <div>${esc(inv.id)}</div>
    </div>
    <span class="${badgeClass}">${esc(badge)}</span>
  </header>
  <div class="cols">
    ${fromBlock}
    <div class="col">
      <h3>Bill to</h3>
      <p>${esc(inv.client)}${inv.email ? `<br>${esc(inv.email)}` : ""}</p>
    </div>
    <div class="col">
      <h3>Dates</h3>
      <p>Issued ${esc(inv.issueDate)}<br>Due ${esc(inv.dueDate)}</p>
    </div>
  </div>
  <table class="items">
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td>${esc(formatMoney(inv.subtotal, inv.currency))}</td></tr>
    ${discountRow}
    ${taxRow}
    <tr class="grand"><td>Total</td><td>${esc(formatMoney(inv.total, inv.currency))}</td></tr>
    ${
			inv.amountPaid > 0
				? `<tr><td>Paid</td><td>-${esc(formatMoney(inv.amountPaid, inv.currency))}</td></tr><tr><td>Balance due</td><td>${esc(
						formatMoney(balanceOf(inv), inv.currency),
					)}</td></tr>`
				: ""
		}
  </table>
  ${payBlock}
  ${notesBlock}
  <footer>Generated by brigade invoice-maker · ${esc(today)}</footer>
</body>
</html>
`;
}

function cmdRender(ledger, args, flags) {
	if (args.length === 0) throw new UsageError("usage: render <id> [--out PATH]");
	const inv = findOne(ledger, args[0]);
	const cwd = process.cwd();
	const out = strFlag(flags, "out")
		? path.resolve(cwd, strFlag(flags, "out"))
		: path.join(cwd, LEDGER_DIR, "rendered", `${inv.id}.html`);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, renderHtml(inv, todayIso()), "utf8");
	process.stdout.write(`Rendered ${inv.id} → ${out}\n`);
	return 0;
}

/* ─────────────────────────────── stats ─────────────────────────────── */

function cmdStats(ledger, _args, flags) {
	const today = todayIso();
	const invoices = ledger.invoices;
	const active = invoices.filter((i) => i.status !== "void");
	const overdue = active.filter((i) => isOverdue(i, today));
	const byStatus = Object.fromEntries(STATUSES.map((s) => [s, invoices.filter((i) => i.status === s).length]));

	// Money is never summed across currencies — each currency is totalled on
	// its own, so a mixed-currency book reports a breakdown instead of a fake
	// aggregate that would quietly add USD to EUR.
	const year = today.slice(0, 4);
	const month = today.slice(0, 7);
	const currencies = [...new Set(active.map((i) => i.currency))].sort();
	const byCurrency = currencies.map((currency) => {
		const set = active.filter((i) => i.currency === currency);
		const sent = set.filter((i) => i.status === "sent" || i.status === "partial");
		const od = set.filter((i) => isOverdue(i, today));
		let collectedThisMonth = 0;
		let collectedThisYear = 0;
		for (const inv of set) {
			for (const p of inv.payments) {
				if (typeof p.date === "string" && p.date.startsWith(month)) collectedThisMonth += p.amount;
				if (typeof p.date === "string" && p.date.startsWith(year)) collectedThisYear += p.amount;
			}
		}
		return {
			currency,
			collected: centsToNumber(set.reduce((sum, i) => sum + i.amountPaid, 0)),
			outstanding: centsToNumber(sent.reduce((sum, i) => sum + balanceOf(i), 0)),
			overdueAmount: centsToNumber(od.reduce((sum, i) => sum + balanceOf(i), 0)),
			collectedThisMonth: centsToNumber(collectedThisMonth),
			collectedThisYear: centsToNumber(collectedThisYear),
		};
	});
	const byClient = new Map();
	for (const inv of active) {
		for (const p of inv.payments) {
			const key = `${inv.client}\u0000${inv.currency}`;
			byClient.set(key, (byClient.get(key) ?? 0) + p.amount);
		}
	}
	const topClients = [...byClient.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([key, cents]) => {
			const [client, currency] = key.split("\u0000");
			return { client, currency, collected: centsToNumber(cents) };
		});

	const paidDurations = active
		.filter((i) => i.status === "paid" && i.paidAt && i.issueDate)
		.map((i) => Math.max(0, dayDiff(i.issueDate, i.paidAt.slice(0, 10))));
	const averageDaysToPay =
		paidDurations.length > 0
			? Number((paidDurations.reduce((a, b) => a + b, 0) / paidDurations.length).toFixed(1))
			: null;

	if (flags.json === true) {
		process.stdout.write(
			`${JSON.stringify(
				{
					total: invoices.length,
					byStatus,
					overdueCount: overdue.length,
					currencies,
					byCurrency,
					averageDaysToPay,
					paidCount: paidDurations.length,
					topClients,
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	process.stdout.write(`Invoice book — ${invoices.length} invoice(s)\n`);
	process.stdout.write(
		`  status: ${STATUSES.map((s) => `${s} ${byStatus[s]}`).join(" · ")}${overdue.length > 0 ? ` · overdue ${overdue.length}` : ""}\n`,
	);
	if (byCurrency.length === 0) {
		process.stdout.write("  no active invoices yet.\n");
	}
	for (const c of byCurrency) {
		if (byCurrency.length > 1) process.stdout.write(`  ${c.currency}:\n`);
		const pad = byCurrency.length > 1 ? "    " : "  ";
		process.stdout.write(`${pad}collected:      ${formatMoney(Math.round(c.collected * 100), c.currency)}  (this month ${formatMoney(Math.round(c.collectedThisMonth * 100), c.currency)}, this year ${formatMoney(Math.round(c.collectedThisYear * 100), c.currency)})\n`);
		process.stdout.write(`${pad}outstanding:    ${formatMoney(Math.round(c.outstanding * 100), c.currency)}\n`);
		process.stdout.write(`${pad}overdue:        ${formatMoney(Math.round(c.overdueAmount * 100), c.currency)}\n`);
	}
	process.stdout.write(
		`  average days to pay: ${averageDaysToPay === null ? "—" : averageDaysToPay} (over ${paidDurations.length} paid)\n`,
	);
	if (topClients.length > 0) {
		process.stdout.write(`  top clients:\n`);
		for (const c of topClients) {
			process.stdout.write(`    - ${c.client}: ${formatMoney(Math.round(c.collected * 100), c.currency)}\n`);
		}
	}
	return 0;
}

/* ─────────────────────────────── dispatch ─────────────────────────────── */

function usage() {
	return [
		"invoice-maker — a per-workspace invoicing ledger (<cwd>/invoices/invoices.json)",
		"",
		'  new <client> --item "description|qty|rate" [--item ...] [--currency CUR] [--tax PCT]',
		"      [--discount PCT] [--terms N|--due-date D] [--date D] [--from S] [--email S]",
		"      [--pay-instructions S] [--notes S]",
		"  list [--status draft|sent|partial|paid|void|overdue] [--client C] [--json]",
		"  show <id>",
		"  render <id> [--out PATH]",
		"  send <id>",
		"  pay <id> <amount> [--method S] [--date D]",
		"  void <id>",
		"  remind <id>",
		"  stats [--json]",
	].join("\n");
}

const COMMANDS = {
	new: cmdNew,
	list: cmdList,
	show: cmdShow,
	render: cmdRender,
	send: cmdSend,
	pay: cmdPay,
	void: cmdVoid,
	remind: cmdRemind,
	stats: cmdStats,
};

function main(argv) {
	const { positional, flags } = parseArgs(argv);
	if (positional.length === 0) {
		process.stdout.write(`${usage()}\n`);
		return 1;
	}
	const [command, ...args] = positional;
	if (command === "help" || flags.help === true) {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	const handler = COMMANDS[command];
	if (!handler) {
		process.stderr.write(`${usage()}\n`);
		process.stderr.write(`error: unknown command "${command}"\n`);
		return 1;
	}
	const ledger = loadLedger();
	return handler(ledger, args, flags) ?? 0;
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (err) {
	if (err instanceof CorruptLedgerError) {
		process.stderr.write(`error: ${err.message}\n`);
		process.exitCode = 2;
	} else if (err instanceof UsageError) {
		process.stderr.write(`error: ${err.message}\n`);
		process.exitCode = 1;
	} else {
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	}
}
