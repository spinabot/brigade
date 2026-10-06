#!/usr/bin/env node
/**
 * reading-list — a durable per-workspace reading ledger.
 *
 * Tracks books, papers, and articles from "want to read" to "finished", with
 * page progress, ratings, tags, and notes. The ledger is a single JSON file at
 * `<cwd>/reading/reading.json` so it travels with the workspace (git-friendly,
 * diffable) instead of living in an opaque database.
 *
 * Design invariants:
 *   - The ledger is the source of truth; every command re-reads it.
 *   - Writes are atomic (temp file + rename) so a crash can never leave a
 *     half-written ledger behind.
 *   - A corrupt or malformed ledger is REFUSED (exit 2) rather than silently
 *     overwritten — losing a reading history to a bad parse is unacceptable.
 *   - Progress is honest: you cannot finish a book with 300 pages by reporting
 *     page 3, and you cannot report page 900 of a 300-page book.
 *
 * Exit codes: 0 success · 1 usage / not-found / refused · 2 corrupt ledger.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const LEDGER_DIR = "reading";
const LEDGER_FILE = "reading.json";
const KINDS = ["book", "paper", "article"];
const STATUSES = ["want", "reading", "finished"];

class UsageError extends Error {}
class CorruptLedgerError extends Error {}

function ledgerPath() {
	return path.join(process.cwd(), LEDGER_DIR, LEDGER_FILE);
}

function emptyLedger() {
	return { version: 1, items: [] };
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
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
		throw new CorruptLedgerError(`refusing to touch a malformed ledger at ${p} (missing "items" array)`);
	}
	return { version: 1, items: parsed.items };
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

function slugify(title) {
	const base = String(title)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return base || "item";
}

function uniqueId(ledger, base) {
	let id = base;
	let n = 2;
	while (ledger.items.some((i) => i.id === id)) id = `${base}-${n++}`;
	return id;
}

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq !== -1) {
				flags[a.slice(2, eq)] = a.slice(eq + 1);
				continue;
			}
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i += 1;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

function requireInt(value, label) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new UsageError(`${label} must be a non-negative whole number`);
	return n;
}

function requireRating(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 5) throw new UsageError("rating must be a whole number from 1 to 5");
	return n;
}

function findAll(ledger, query) {
	const needle = String(query).toLowerCase();
	const exact = ledger.items.filter((i) => i.id === needle);
	if (exact.length > 0) return exact;
	return ledger.items.filter((i) => i.id.includes(needle) || i.title.toLowerCase().includes(needle));
}

function findOne(ledger, query) {
	const hits = findAll(ledger, query);
	if (hits.length === 0) throw new UsageError(`no item matches "${query}"`);
	if (hits.length > 1) {
		throw new UsageError(`"${query}" is ambiguous — it matches ${hits.map((h) => h.id).join(", ")}`);
	}
	return hits[0];
}

function parseTags(raw) {
	if (raw === undefined || raw === true) return [];
	const tags = String(raw)
		.split(",")
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set(tags)];
}

function formatItem(item) {
	const bits = [item.id, `[${item.status}]`, item.title];
	if (item.author) bits.push(`— ${item.author}`);
	const line = bits.join(" ");
	const meta = [];
	meta.push(item.kind);
	if (typeof item.pages === "number") {
		meta.push(item.status === "finished" ? `${item.pages}p` : `${item.currentPage}/${item.pages}p`);
	}
	if (typeof item.rating === "number") meta.push(`★${item.rating}`);
	if (item.tags.length > 0) meta.push(item.tags.map((t) => `#${t}`).join(" "));
	return meta.length > 0 ? `${line}  (${meta.join(" · ")})` : line;
}

/* ─────────────────────────────── commands ─────────────────────────────── */

function cmdAdd(ledger, args, flags) {
	const title = args.join(" ").trim();
	if (!title) throw new UsageError('usage: add <title> [--author A] [--kind book|paper|article] [--pages N] [--tags a,b] [--url U]');
	const kind = typeof flags.kind === "string" ? flags.kind.toLowerCase() : "book";
	if (!KINDS.includes(kind)) throw new UsageError(`--kind must be one of: ${KINDS.join(", ")}`);
	const item = {
		id: uniqueId(ledger, slugify(title)),
		title,
		author: typeof flags.author === "string" ? flags.author.trim() : "",
		kind,
		status: "want",
		pages: flags.pages !== undefined ? requireInt(flags.pages, "--pages") : null,
		currentPage: 0,
		rating: null,
		url: typeof flags.url === "string" ? flags.url.trim() : "",
		tags: parseTags(flags.tags),
		notes: [],
		addedAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
	};
	ledger.items.push(item);
	saveLedger(ledger);
	process.stdout.write(`Added ${item.id} — "${item.title}" [${item.kind}] (${item.status}).\n`);
	return 0;
}

function cmdList(ledger, _args, flags) {
	let items = ledger.items.slice();
	const status = typeof flags.status === "string" ? flags.status.toLowerCase() : null;
	if (status) {
		if (!STATUSES.includes(status)) throw new UsageError(`--status must be one of: ${STATUSES.join(", ")}`);
		items = items.filter((i) => i.status === status);
	}
	const tag = typeof flags.tag === "string" ? flags.tag.trim().toLowerCase() : null;
	if (tag) items = items.filter((i) => i.tags.includes(tag));
	items.sort((a, b) => a.title.localeCompare(b.title));
	if (items.length === 0) {
		process.stdout.write("No items match.\n");
		return 0;
	}
	for (const item of items) process.stdout.write(`${formatItem(item)}\n`);
	process.stdout.write(`${items.length} item(s).\n`);
	return 0;
}

function cmdShow(ledger, args) {
	if (args.length === 0) throw new UsageError("usage: show <id>");
	const item = findOne(ledger, args[0]);
	process.stdout.write(`${item.title}\n`);
	process.stdout.write(`  id:       ${item.id}\n`);
	process.stdout.write(`  kind:     ${item.kind}\n`);
	if (item.author) process.stdout.write(`  author:   ${item.author}\n`);
	process.stdout.write(`  status:   ${item.status}\n`);
	if (typeof item.pages === "number") process.stdout.write(`  progress: ${item.currentPage}/${item.pages} pages\n`);
	if (typeof item.rating === "number") process.stdout.write(`  rating:   ${item.rating}/5\n`);
	if (item.tags.length > 0) process.stdout.write(`  tags:     ${item.tags.join(", ")}\n`);
	if (item.url) process.stdout.write(`  url:      ${item.url}\n`);
	process.stdout.write(`  added:    ${item.addedAt}\n`);
	if (item.startedAt) process.stdout.write(`  started:  ${item.startedAt}\n`);
	if (item.finishedAt) process.stdout.write(`  finished: ${item.finishedAt}\n`);
	if (item.notes.length > 0) {
		process.stdout.write("  notes:\n");
		for (const note of item.notes) process.stdout.write(`    - [${note.at}] ${note.text}\n`);
	}
	return 0;
}

function cmdStart(ledger, args, flags) {
	if (args.length === 0) throw new UsageError("usage: start <id> [--page N]");
	const item = findOne(ledger, args[0]);
	if (item.status === "finished") throw new UsageError(`"${item.title}" is already finished`);
	if (flags.page !== undefined) {
		const page = requireInt(flags.page, "--page");
		if (typeof item.pages === "number" && page > item.pages) {
			throw new UsageError(`page ${page} is past the end of a ${item.pages}-page item`);
		}
		item.currentPage = page;
	}
	if (item.status !== "reading") {
		item.status = "reading";
		item.startedAt = item.startedAt ?? new Date().toISOString();
	}
	saveLedger(ledger);
	process.stdout.write(`Started "${item.title}" (page ${item.currentPage}${typeof item.pages === "number" ? `/${item.pages}` : ""}).\n`);
	return 0;
}

function cmdProgress(ledger, args) {
	if (args.length < 2) throw new UsageError("usage: progress <id> <page>");
	const item = findOne(ledger, args[0]);
	const page = requireInt(args[1], "page");
	if (typeof item.pages === "number" && page > item.pages) {
		throw new UsageError(`page ${page} is past the end of a ${item.pages}-page item`);
	}
	if (item.status === "want") {
		item.status = "reading";
		item.startedAt = new Date().toISOString();
	}
	item.currentPage = page;
	const done = typeof item.pages === "number" && page >= item.pages;
	if (done && item.status !== "finished") {
		item.status = "finished";
		item.finishedAt = new Date().toISOString();
		saveLedger(ledger);
		process.stdout.write(`Finished "${item.title}" (${item.pages} pages). Pass --rating on \`rate\` to score it.\n`);
		return 0;
	}
	saveLedger(ledger);
	process.stdout.write(`"${item.title}" → page ${page}${typeof item.pages === "number" ? `/${item.pages}` : ""}.\n`);
	return 0;
}

function cmdFinish(ledger, args, flags) {
	if (args.length === 0) throw new UsageError("usage: finish <id> [--rating 1-5]");
	const item = findOne(ledger, args[0]);
	if (typeof flags.rating !== "undefined" && flags.rating !== true) {
		item.rating = requireRating(flags.rating);
	}
	if (item.status !== "finished") {
		item.status = "finished";
		item.startedAt = item.startedAt ?? new Date().toISOString();
		item.finishedAt = new Date().toISOString();
		if (typeof item.pages === "number") item.currentPage = item.pages;
	}
	saveLedger(ledger);
	process.stdout.write(`Finished "${item.title}"${typeof item.rating === "number" ? ` (★${item.rating})` : ""}.\n`);
	return 0;
}

function cmdRate(ledger, args) {
	if (args.length < 2) throw new UsageError("usage: rate <id> <1-5>");
	const item = findOne(ledger, args[0]);
	item.rating = requireRating(args[1]);
	saveLedger(ledger);
	process.stdout.write(`Rated "${item.title}" ★${item.rating}.\n`);
	return 0;
}

function cmdNote(ledger, args) {
	if (args.length < 2) throw new UsageError("usage: note <id> <text>");
	const item = findOne(ledger, args[0]);
	const text = args.slice(1).join(" ").trim();
	if (!text) throw new UsageError("note text is empty");
	item.notes.push({ at: new Date().toISOString(), text });
	saveLedger(ledger);
	process.stdout.write(`Noted on "${item.title}" (${item.notes.length} note(s)).\n`);
	return 0;
}

function cmdRemove(ledger, args, flags) {
	if (args.length === 0) throw new UsageError("usage: remove <id> --yes");
	const item = findOne(ledger, args[0]);
	if (flags.yes !== true) {
		throw new UsageError(`refusing to remove "${item.title}" without --yes`);
	}
	ledger.items = ledger.items.filter((i) => i.id !== item.id);
	saveLedger(ledger);
	process.stdout.write(`Removed "${item.title}".\n`);
	return 0;
}

function cmdStats(ledger, _args, flags) {
	const items = ledger.items;
	const byStatus = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
	const rated = items.filter((i) => typeof i.rating === "number");
	const avgRating = rated.length > 0 ? rated.reduce((sum, i) => sum + i.rating, 0) / rated.length : null;
	const thisYear = new Date().getUTCFullYear();
	const finishedThisYear = items.filter(
		(i) => i.status === "finished" && typeof i.finishedAt === "string" && i.finishedAt.startsWith(String(thisYear)),
	).length;
	const pagesRead = items.reduce((sum, i) => {
		if (i.status === "finished" && typeof i.pages === "number") return sum + i.pages;
		if (i.status === "reading") return sum + (typeof i.currentPage === "number" ? i.currentPage : 0);
		return sum;
	}, 0);
	const tagCounts = new Map();
	for (const i of items) for (const t of i.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
	const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

	if (flags.json === true) {
		process.stdout.write(
			`${JSON.stringify(
				{
					total: items.length,
					byStatus,
					finishedThisYear,
					pagesRead,
					averageRating: avgRating === null ? null : Number(avgRating.toFixed(2)),
					ratedCount: rated.length,
					topTags: topTags.map(([tag, count]) => ({ tag, count })),
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	process.stdout.write(`Reading ledger — ${items.length} item(s)\n`);
	process.stdout.write(`  want: ${byStatus.want} · reading: ${byStatus.reading} · finished: ${byStatus.finished}\n`);
	process.stdout.write(`  finished this year: ${finishedThisYear}\n`);
	process.stdout.write(`  pages read: ${pagesRead}\n`);
	if (avgRating !== null) {
		process.stdout.write(`  average rating: ${avgRating.toFixed(2)}/5 (over ${rated.length} rated)\n`);
	} else {
		process.stdout.write("  average rating: — (nothing rated yet)\n");
	}
	if (topTags.length > 0) {
		process.stdout.write(`  top tags: ${topTags.map(([t, c]) => `${t}(${c})`).join(", ")}\n`);
	}
	const reading = items.filter((i) => i.status === "reading").sort((a, b) => a.title.localeCompare(b.title));
	if (reading.length > 0) {
		process.stdout.write("  in progress:\n");
		for (const i of reading) {
			process.stdout.write(`    - ${formatItem(i)}\n`);
		}
	}
	return 0;
}

function usage() {
	return [
		"reading-list — a durable per-workspace reading ledger (<cwd>/reading/reading.json)",
		"",
		"  add <title> [--author A] [--kind book|paper|article] [--pages N] [--tags a,b] [--url U]",
		"  list [--status want|reading|finished] [--tag T]",
		"  show <id>",
		"  start <id> [--page N]",
		"  progress <id> <page>",
		"  finish <id> [--rating 1-5]",
		"  rate <id> <1-5>",
		"  note <id> <text>",
		"  remove <id> --yes",
		"  stats [--json]",
	].join("\n");
}

const COMMANDS = {
	add: cmdAdd,
	list: cmdList,
	show: cmdShow,
	start: cmdStart,
	progress: cmdProgress,
	finish: cmdFinish,
	rate: cmdRate,
	note: cmdNote,
	remove: cmdRemove,
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
