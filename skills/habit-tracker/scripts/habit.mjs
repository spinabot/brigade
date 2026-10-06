#!/usr/bin/env node
/**
 * habit-tracker — a tiny, dependency-free ledger for building habits.
 *
 * Part of the bundled `habit-tracker` skill. One JSON file holds every
 * habit and its check-ins; every command prints plain, fixed-width text
 * an agent (or a human) can read straight from a terminal. Streaks are
 * computed honestly: a day without a check-in breaks a daily streak, a
 * week without all scheduled days breaks a weekly one, and pauses freeze
 * the streak clock rather than accumulate silent debt.
 *
 * Usage:
 *   habit.mjs [--db <path>] add <name> --schedule daily|weekly [--days mon,wed] [--goal DUR]
 *   habit.mjs [--db <path>] check <name> [--date YYYY-MM-DD] [--note N]
 *   habit.mjs [--db <path>] uncheck <name> --date YYYY-MM-DD
 *   habit.mjs [--db <path>] due [--json]
 *   habit.mjs [--db <path>] list [--json]
 *   habit.mjs [--db <path>] stats <name> [--weeks N] [--json]
 *   habit.mjs [--db <path>] pause <name> | resume <name> | archive <name>
 *   habit.mjs [--db <path>] remove <name>
 *
 * Exit codes: 0 ok | 1 usage error | 2 data error (corrupt ledger, unknown habit)
 */

import * as fs from "node:fs";
import * as path from "node:path";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** Mon=0 … Sun=6 — the ledger's canonical weekday ordering. */
const DAY_INDEX = new Map(WEEKDAYS.map((d, i) => [d, i]));

const USAGE = `Usage: habit.mjs [--db <path>] <command> [options]

Commands:
  add <name> --schedule daily | --schedule weekly --days mon,wed [, ...] [--goal DUR]
  check <name> [--date YYYY-MM-DD] [--note N]
  uncheck <name> --date YYYY-MM-DD
  due [--json]
  list [--json]
  stats <name> [--weeks N] [--json]
  pause <name> | resume <name> | archive <name>
  remove <name>

The ledger defaults to <cwd>/habits/habits.json; --db overrides it.
Dates are local YYYY-MM-DD (default: today). --goal accepts minutes
(45) or durations (10m, 45min, 1.5h).`;

function die(message, code = 1) {
	process.stderr.write(`habit: ${message}\n`);
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

/** Local calendar date → ISO weekday index (Mon=0 … Sun=6). */
function weekdayOf(iso) {
	const [y, m, d] = iso.split("-").map(Number);
	return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** Whole calendar days from date `a` (older) to date `b` (newer). */
function daysBetween(a, b) {
	const pa = a.split("-").map(Number);
	const pb = b.split("-").map(Number);
	const da = new Date(pa[0], pa[1] - 1, pa[2]);
	const db = new Date(pb[0], pb[1] - 1, pb[2]);
	return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Monday of the week containing `iso`, as YYYY-MM-DD (weeks start Monday). */
function weekStartOf(iso) {
	const [y, m, d] = iso.split("-").map(Number);
	const dt = new Date(y, m - 1, d);
	dt.setDate(dt.getDate() - weekdayOf(iso));
	const mm = String(dt.getMonth() + 1).padStart(2, "0");
	const dd = String(dt.getDate()).padStart(2, "0");
	return `${dt.getFullYear()}-${mm}-${dd}`;
}

/** Parse --goal values: plain minutes, "10m", "45min", "1.5h". Returns minutes. */
function parseGoalMinutes(raw) {
	if (raw === undefined) return undefined;
	const s = String(raw).trim().toLowerCase();
	if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
	const minutes = /^(\d+(?:\.\d+)?)\s*m(?:in)?$/.exec(s);
	if (minutes) return Math.round(Number(minutes[1]));
	const hours = /^(\d+(?:\.\d+)?)\s*h$/.exec(s);
	if (hours) return Math.round(Number(hours[1]) * 60);
	return null;
}

/** Flags that take a value; every other --flag is boolean. */
const VALUE_FLAGS = new Set(["schedule", "days", "goal", "date", "note", "weeks", "db", "json"]);

/**
 * Peel off the global `--json` / `--help` flags, leaving every other token
 * (command, name, value flags incl. `--db`) for readFlags, which resolves
 * them position-independently.
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
	return dbFlag ?? path.join(process.cwd(), "habits", "habits.json");
}

function loadLedger(dbPath) {
	if (!fs.existsSync(dbPath)) return { version: 1, nextId: 1, habits: [] };
	let raw;
	try {
		raw = fs.readFileSync(dbPath, "utf8");
	} catch (err) {
		die(`cannot read ledger ${dbPath}: ${err instanceof Error ? err.message : String(err)}`, 2);
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.habits)) {
			throw new Error("not a habit ledger (missing habits array)");
		}
		parsed.nextId ??= parsed.habits.length + 1;
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

function findHabit(ledger, name) {
	const key = String(name ?? "").toLowerCase();
	const habit = ledger.habits.find((h) => h.name.toLowerCase() === key);
	if (!habit) {
		const known = ledger.habits.length > 0 ? ` (known habits: ${ledger.habits.map((h) => h.name).join(", ")})` : " — the ledger is empty";
		die(`unknown habit "${name === undefined ? "<missing>" : name}"${known}`, 2);
	}
	return habit;
}

/** The habit's scheduled weekday indexes, or every day for daily habits. */
function scheduledDays(habit) {
	return habit.schedule === "daily" ? [0, 1, 2, 3, 4, 5, 6] : habit.days.map((d) => DAY_INDEX.get(d)).filter((n) => n !== undefined);
}

/** Whether `iso` is a scheduled day for this habit. */
function isScheduledOn(habit, iso) {
	return scheduledDays(habit).includes(weekdayOf(iso));
}

/** The habit's check-in dates as a Set of YYYY-MM-DD strings. */
function checkSet(habit) {
	return new Set(habit.checkins.map((c) => c.date));
}

/**
 * Current streak, counted honestly.
 *
 * Daily: walk back day by day; every missed scheduled day breaks the
 * streak; today does not break it (the day isn't over yet — the streak
 * still counts while today is still due).
 * Weekly: the current week counts if all of its scheduled days (up to
 * today) are checked; every earlier week must have every scheduled day
 * checked. The current week also doesn't break the streak while incomplete.
 * Returns 0 when the habit is paused (the clock is frozen, not broken).
 */
function currentStreak(habit, today) {
	if (habit.paused) return 0;
	const checks = checkSet(habit);
	if (habit.schedule === "daily") {
		let streak = 0;
		for (let back = 0; back < 3650; back++) {
			const d = new Date(today.slice(0, 4) - 0, today.slice(5, 7) - 1, today.slice(8, 10));
			d.setDate(d.getDate() - back);
			const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			if (!isScheduledOn(habit, iso)) continue;
			if (checks.has(iso)) {
				streak++;
				continue;
			}
			if (iso === today) continue; // today still owed — not a break yet
			break;
		}
		return streak;
	}
	// weekly: count fully-checked scheduled days; compare against the
	// Monday-start week. The current week counts if all scheduled days up
	// to today are checked.
	const days = scheduledDays(habit);
	let streak = 0;
	let weekStart = weekStartOf(today);
	for (let week = 0; week < 520; week++) {
		let owed = 0;
		let done = 0;
		for (const dayIdx of days) {
			const d = new Date(weekStart.slice(0, 4) - 0, weekStart.slice(5, 7) - 1, weekStart.slice(8, 10));
			d.setDate(d.getDate() + dayIdx);
			const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			if (iso > today) continue; // future day of the current week
			owed++;
			if (checks.has(iso)) done++;
		}
		if (owed > 0 && done === owed) {
			streak += owed;
		} else if (week === 0) {
			// current week incomplete — streak not broken yet, but nothing to add
		} else {
			break;
		}
		// step back one week
		const d = new Date(weekStart.slice(0, 4) - 0, weekStart.slice(5, 7) - 1, weekStart.slice(8, 10));
		d.setDate(d.getDate() - 7);
		weekStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	}
	return streak;
}

/** ISO date `daysAgo` nominal days before `today`. */
function isoDaysBefore(today, daysAgo) {
	const d = new Date(today.slice(0, 4) - 0, today.slice(5, 7) - 1, today.slice(8, 10));
	d.setDate(d.getDate() - daysAgo);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Best-ever streak in scheduled-day units since the habit was added. */
function bestStreak(habit) {
	const checks = [...checkSet(habit)].sort();
	if (checks.length === 0) return 0;
	if (habit.schedule === "daily") {
		let best = 1;
		let run = 1;
		for (let i = 1; i < checks.length; i++) {
			const gap = daysBetween(checks[i - 1], checks[i]);
			// consecutive scheduled days = gap of 1, or 2 across a weekend
			// that has no scheduled days (weekly habit handled below)
			if (gap === 1 || (gap > 1 && everyDayBetweenUnscheduled(habit, checks[i - 1], checks[i]))) {
				run++;
				best = Math.max(best, run);
			} else {
				run = 1;
			}
		}
		return best;
	}
	// weekly: best count of fully-checked scheduled days in consecutive weeks
	const days = scheduledDays(habit);
	const weeks = [...new Set(checks.map((c) => weekStartOf(c)))].sort();
	let best = 0;
	let run = 0;
	let prevStart = null;
	for (const ws of weeks) {
		const allDone = days.every((dayIdx) => {
			const d = new Date(ws.slice(0, 4) - 0, ws.slice(5, 7) - 1, ws.slice(8, 10));
			d.setDate(d.getDate() + dayIdx);
			const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			return checkSet(habit).has(iso);
		});
		const consecutive = prevStart !== null && daysBetween(prevStart, ws) === 7;
		if (allDone && consecutive) run += days.length;
		else if (allDone) run = days.length;
		else run = 0;
		best = Math.max(best, run);
		prevStart = ws;
	}
	return best;
}

/** True when no day strictly between a and b is scheduled (skippable gap). */
function everyDayBetweenUnscheduled(habit, a, b) {
	let cursor = a;
	const bGap = daysBetween(a, b);
	for (let i = 1; i < bGap; i++) {
		const d = new Date(cursor.slice(0, 4) - 0, cursor.slice(5, 7) - 1, cursor.slice(8, 10));
		d.setDate(d.getDate() + i);
		const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		if (isScheduledOn(habit, iso)) return false;
	}
	return true;
}

/** 28-day scheduled-day completion rate (0-100), most recent first. */
function recentScore(habit, today) {
	let owed = 0;
	let done = 0;
	const checks = checkSet(habit);
	for (let back = 0; back < 28; back++) {
		const iso = isoDaysBefore(today, back);
		if (!isScheduledOn(habit, iso)) continue;
		owed++;
		if (checks.has(iso)) done++;
	}
	return owed === 0 ? null : Math.round((done / owed) * 100);
}

function cmdAdd(ledger, name, flags) {
	if (name === undefined) die("add requires a habit name");
	const schedule = flags.get("schedule");
	if (schedule !== "daily" && schedule !== "weekly") {
		die(`add requires --schedule daily or weekly (got "${schedule ?? "<missing>"}")`);
	}
	let days = [];
	if (schedule === "weekly") {
		const raw = String(flags.get("days") ?? "");
		days = raw
			.split(",")
			.map((d) => d.trim().toLowerCase())
			.filter((d) => d.length > 0);
		if (days.length === 0) die("weekly schedule requires --days mon,tue,… (three-letter weekday names)");
		const bad = days.filter((d) => !DAY_INDEX.has(d));
		if (bad.length > 0) die(`--days must be three-letter weekday names from: ${WEEKDAYS.join(",")} (got "${bad.join(", ")}")`);
		if (new Set(days).size !== days.length) die(`--days must not repeat a weekday (got "${days.join(",")}")`);
	}
	const goalRaw = flags.get("goal");
	let goal = undefined;
	if (goalRaw !== undefined) {
		goal = parseGoalMinutes(goalRaw);
		if (goal === null) die(`--goal must be minutes (45) or a duration (10m, 45min, 1.5h) (got "${goalRaw}")`);
		if (goal === 0) die("--goal must be at least 1 minute");
	}
	const key = String(name).toLowerCase();
	if (ledger.habits.some((h) => h.name.toLowerCase() === key)) {
		die(`habit "${name}" already exists — use check/uncheck to log it`, 1);
	}
	const today = todayISO();
	const habit = {
		id: String(ledger.nextId),
		name: String(name).trim(),
		schedule,
		...(schedule === "weekly" ? { days } : {}),
		...(goal !== undefined ? { goalMinutes: goal } : {}),
		createdAt: today,
		paused: false,
		archived: false,
		checkins: [],
	};
	ledger.habits.push(habit);
	ledger.nextId += 1;
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(habit, null, 2)}\n`);
	} else {
		const sched = schedule === "daily" ? "daily" : `weekly on ${days.join(",")}`;
		process.stdout.write(`Added #${habit.id} "${habit.name}" (${sched}${goal !== undefined ? `, goal ${goal}m` : ""})\n`);
	}
}

function cmdCheck(ledger, name, flags) {
	if (name === undefined) die("check requires a habit name");
	const habit = findHabit(ledger, name);
	if (habit.archived) die(`habit "${habit.name}" is archived — resume it first`, 1);
	const date = flags.get("date") ?? todayISO();
	if (!isRealDate(date)) die(`--date must be a real YYYY-MM-DD calendar date (got "${date}")`);
	if (date > todayISO()) die(`--date is in the future (${date}) — check-ins are for days that happened`);
	const note = String(flags.get("note") ?? "").trim();
	if (!isScheduledOn(habit, date) && !flags.get("__json")) {
		process.stdout.write(`note: ${date} is not a scheduled day for "${habit.name}" — logging anyway\n`);
	}
	let entry = habit.checkins.find((c) => c.date === date);
	if (entry) {
		if (note) entry.note = note;
		if (flags.get("__json")) {
			process.stdout.write(`${JSON.stringify({ habit: habit.name, date, updated: true, note: entry.note ?? "" }, null, 2)}\n`);
		} else {
			process.stdout.write(`#${habit.id} "${habit.name}" — ${date} already checked${note ? " (note updated)" : " (no change)"}\n`);
		}
		return;
	}
	entry = { date, ...(note ? { note } : {}) };
	habit.checkins.push(entry);
	habit.checkins.sort((a, b) => (a.date < b.date ? -1 : 1));
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ habit: habit.name, date, streak: currentStreak(habit, todayISO()), note: entry.note ?? "" }, null, 2)}\n`);
	} else {
		const streak = currentStreak(habit, todayISO());
		process.stdout.write(`#${habit.id} "${habit.name}" — ${date} checked ✓ (streak ${streak})\n`);
	}
}

function cmdUncheck(ledger, name, flags) {
	if (name === undefined) die("uncheck requires a habit name");
	const date = flags.get("date");
	if (date === undefined) die("uncheck requires --date YYYY-MM-DD (say which day to correct)");
	if (!isRealDate(date)) die(`--date must be a real YYYY-MM-DD calendar date (got "${date}")`);
	const habit = findHabit(ledger, name);
	const before = habit.checkins.length;
	habit.checkins = habit.checkins.filter((c) => c.date !== date);
	if (habit.checkins.length === before) {
		die(`no check-in for "${habit.name}" on ${date} — nothing to uncheck`, 2);
	}
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ habit: habit.name, date, removed: true }, null, 2)}\n`);
	} else {
		process.stdout.write(`#${habit.id} "${habit.name}" — ${date} unchecked (streak ${currentStreak(habit, todayISO())})\n`);
	}
}

function cmdDue(ledger, flags) {
	const today = todayISO();
	const rows = ledger.habits
		.filter((h) => !h.archived)
		.map((h) => {
			const checks = checkSet(h);
			const scheduledToday = isScheduledOn(h, today);
			const doneToday = checks.has(today);
			// weekly habits: this week's owed-so-far vs done
			let weekOwed = null;
			let weekDone = null;
			if (h.schedule === "weekly") {
				weekOwed = 0;
				weekDone = 0;
				for (const dayIdx of scheduledDays(h)) {
					const d = new Date(weekStartOf(today).slice(0, 4) - 0, weekStartOf(today).slice(5, 7) - 1, weekStartOf(today).slice(8, 10));
					d.setDate(d.getDate() + dayIdx);
					const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
					if (iso > today) continue;
					weekOwed++;
					if (checks.has(iso)) weekDone++;
				}
			}
			return {
				id: h.id,
				name: h.name,
				schedule: h.schedule,
				...(h.goalMinutes !== undefined ? { goalMinutes: h.goalMinutes } : {}),
				paused: h.paused === true,
				dueToday: scheduledToday && !doneToday && h.paused !== true,
				checkedToday: doneToday,
				streak: currentStreak(h, today),
				...(h.schedule === "weekly" ? { weekProgress: { done: weekDone, owed: weekOwed } } : {}),
			};
		});
	const due = rows.filter((r) => r.dueToday);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ date: today, due, all: rows }, null, 2)}\n`);
		return;
	}
	if (rows.every((r) => r.paused || !r.dueToday)) {
		const anyActive = rows.some((r) => !r.paused);
		process.stdout.write(anyActive ? `Nothing due today (${today}) — every scheduled habit is checked.\n` : `No active habits — add one with the add command.\n`);
		return;
	}
	process.stdout.write(`Due today (${today}):\n`);
	for (const r of due) {
		const goal = r.goalMinutes !== undefined ? ` — goal ${r.goalMinutes}m` : "";
		const week = r.weekProgress ? ` [week ${r.weekProgress.done}/${r.weekProgress.owed}]` : "";
		process.stdout.write(`  #${r.id}  ${r.name}${week}${goal}  (streak ${r.streak})\n`);
	}
	const paused = rows.filter((r) => r.paused);
	if (paused.length > 0) process.stdout.write(`paused (not counted): ${paused.map((r) => r.name).join(", ")}\n`);
}

function cmdList(ledger, flags) {
	const today = todayISO();
	const rows = ledger.habits
		.filter((h) => !h.archived)
		.map((h) => ({
			id: h.id,
			name: h.name,
			schedule: h.schedule === "daily" ? "daily" : `weekly:${h.days.join(",")}`,
			...(h.goalMinutes !== undefined ? { goalMinutes: h.goalMinutes } : {}),
			...(h.paused ? { paused: true } : {}),
			checkedToday: checkSet(h).has(today),
			streak: currentStreak(h, today),
			best: bestStreak(h),
			recentScore: recentScore(h, today),
		}));
	const archived = ledger.habits.filter((h) => h.archived).length;
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ habits: rows, archived }, null, 2)}\n`);
		return;
	}
	if (rows.length === 0) {
		process.stdout.write(archived > 0 ? `No active habits (${archived} archived) — add one with the add command.\n` : `The ledger is empty — add your first habit with the add command.\n`);
		return;
	}
	const header = "ID  NAME                      SCHEDULE            TODAY  STREAK  BEST  28D";
	process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
	for (const r of rows) {
		const name = r.name.length <= 23 ? r.name.padEnd(24) : `${r.name.slice(0, 21)}... `;
		const goal = r.goalMinutes !== undefined ? ` (${r.goalMinutes}m)` : "";
		const todayMark = r.paused ? "paused" : r.checkedToday ? "done" : "due";
		const score = r.recentScore === null ? "  —" : `${String(r.recentScore).padStart(2)}%`;
		process.stdout.write(`${`#${r.id}`.padEnd(4)}${name}${r.schedule.padEnd(20)}${(todayMark + goal).padEnd(12)}${String(r.streak).padStart(5)}  ${String(r.best).padStart(4)}  ${score}\n`);
	}
	if (archived > 0) process.stdout.write(`(${archived} archived habit(s) not shown)\n`);
}

function cmdStats(ledger, name, flags) {
	if (name === undefined) die("stats requires a habit name");
	const habit = findHabit(ledger, name);
	const today = todayISO();
	const weeksRaw = flags.get("weeks");
	if (weeksRaw !== undefined && (!/^\d+$/.test(weeksRaw) || Number(weeksRaw) < 1 || Number(weeksRaw) > 52)) {
		die(`--weeks must be a whole number between 1 and 52 (got "${weeksRaw}")`);
	}
	const weeks = weeksRaw === undefined ? 8 : Number(weeksRaw);
	const checks = checkSet(habit);
	// heatmap: one cell per scheduled day, `weeks` columns
	const cells = [];
	for (let w = weeks - 1; w >= 0; w--) {
		const weekStart = (() => {
			const d = new Date(weekStartOf(today).slice(0, 4) - 0, weekStartOf(today).slice(5, 7) - 1, weekStartOf(today).slice(8, 10));
			d.setDate(d.getDate() - 7 * w);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		})();
		for (const dayIdx of scheduledDays(habit)) {
			const d = new Date(weekStart.slice(0, 4) - 0, weekStart.slice(5, 7) - 1, weekStart.slice(8, 10));
			d.setDate(d.getDate() + dayIdx);
			const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			if (iso > today) continue;
			cells.push({ date: iso, checked: checks.has(iso) });
		}
	}
	const owed = cells.length;
	const done = cells.filter((c) => c.checked).length;
	const payload = {
		habit: habit.name,
		schedule: habit.schedule === "daily" ? "daily" : `weekly:${habit.days.join(",")}`,
		...(habit.goalMinutes !== undefined ? { goalMinutes: habit.goalMinutes } : {}),
		...(habit.paused ? { paused: true } : {}),
		createdAt: habit.createdAt,
		windowDays: owed,
		completed: done,
		completionRate: owed === 0 ? "n/a" : `${Math.round((done / owed) * 100)}%`,
		currentStreak: currentStreak(habit, today),
		bestStreak: bestStreak(habit),
		heatmap: cells,
	};
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	process.stdout.write(`#${habit.id} "${habit.name}" — ${payload.schedule}${habit.paused ? " (paused)" : ""}\n`);
	process.stdout.write(`Last ${weeks} week(s): ${done}/${owed} scheduled day(s) done${owed > 0 ? ` (${payload.completionRate})` : ""}\n`);
	process.stdout.write(`Current streak: ${payload.currentStreak} · best: ${payload.bestStreak}\n`);
	// grid: one row per week, x/o per scheduled day
	for (let i = 0; i < cells.length; ) {
		const row = cells.slice(i, i + 7).map((c) => (c.checked ? "x" : "o")).join("");
		process.stdout.write(`  ${cells[i].date}  ${row}\n`);
		i += 7;
	}
}

function setStatus(ledger, name, status, flags) {
	if (name === undefined) die(`${status} requires a habit name`);
	const habit = findHabit(ledger, name);
	if (status === "pause" && habit.paused) die(`habit "${habit.name}" is already paused`, 1);
	if (status === "resume" && !habit.paused) die(`habit "${habit.name}" is not paused`, 1);
	if (status === "archive" && habit.archived) die(`habit "${habit.name}" is already archived`, 1);
	if (status === "pause") habit.paused = true;
	if (status === "resume") habit.paused = false;
	if (status === "archive") habit.archived = true;
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ habit: habit.name, [status]: true }, null, 2)}\n`);
	} else {
		process.stdout.write(`#${habit.id} "${habit.name}" ${status}d.\n`);
	}
}

function cmdRemove(ledger, name, flags) {
	if (name === undefined) die("remove requires a habit name");
	const habit = findHabit(ledger, name);
	ledger.habits = ledger.habits.filter((h) => h.id !== habit.id);
	if (flags.get("__json")) {
		process.stdout.write(`${JSON.stringify({ removed: habit.name, checkinsDropped: habit.checkins.length }, null, 2)}\n`);
	} else {
		process.stdout.write(`Removed "${habit.name}" and its ${habit.checkins.length} check-in(s) from the ledger.\n`);
	}
}

function main() {
	const parsed = parseArgv(process.argv.slice(2));
	if (parsed.tokens.length === 0) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(1);
	}
	const { flags, positional } = readFlags(parsed.tokens, VALUE_FLAGS);
	const command = positional[0];
	const name = positional[1];
	flags.set("__json", parsed.json);

	const dbPath = ledgerPath(flags.get("db"));
	const mutating = new Set(["add", "check", "uncheck", "pause", "resume", "archive", "remove"]);
	const ledger = loadLedger(dbPath);
	switch (command) {
		case "add":
			cmdAdd(ledger, name, flags);
			break;
		case "check":
			cmdCheck(ledger, name, flags);
			break;
		case "uncheck":
			cmdUncheck(ledger, name, flags);
			break;
		case "due":
			cmdDue(ledger, flags);
			break;
		case "list":
			cmdList(ledger, flags);
			break;
		case "stats":
			cmdStats(ledger, name, flags);
			break;
		case "pause":
		case "resume":
		case "archive":
			setStatus(ledger, name, command, flags);
			break;
		case "remove":
			cmdRemove(ledger, name, flags);
			break;
		default:
			die(`unknown command "${command}"\n\n${USAGE}`);
	}
	if (mutating.has(command)) saveLedger(dbPath, ledger);
}

main();
