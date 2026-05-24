/**
 * `brigade cron <subcommand>` — operator-facing scheduler management.
 *
 * 9 subcommands wired here:
 *   status / list / add / edit / remove / enable / disable / run / runs
 *
 * Each handler constructs its OWN short-lived `CronServiceState`. The
 * per-storePath lock in `cron/service/locked.ts` serialises writes across
 * processes, so a CLI invocation running while the gateway daemon is up
 * cannot corrupt the cron.json (both read-modify-write under the lock).
 * The CLI never arms the timer — only the gateway daemon does that.
 *
 * Output:
 *   - `--json`            → machine-readable JSON (one object per subcommand).
 *   - default (no `--json`) → human-readable table / paragraph.
 *
 * Exit codes:
 *   - 0 on success.
 *   - 1 on validation / not-found errors (with a stderr explanation).
 *   - 2 on unexpected exception (with the message + stack on stderr).
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { createCronServiceState } from "../../cron/service/state.js";
import {
	add as cronAdd,
	enqueueRun as cronEnqueueRun,
	listPage as cronListPage,
	remove as cronRemove,
	runs as cronRuns,
	setEnabled as cronSetEnabled,
	status as cronStatus,
	update as cronUpdate,
} from "../../cron/service/ops.js";
import type {
	CronJob,
	CronJobCreate,
	CronJobPatch,
} from "../../cron/types.js";

const log = createSubsystemLogger("cli/cron");

/** Build a fresh, timer-less service state for one CLI invocation. */
function freshCronState(): ReturnType<typeof createCronServiceState> {
	return createCronServiceState({
		deps: { log },
	});
}

/** Common JSON-vs-human flag every subcommand accepts. */
export interface CronJsonFlag {
	json?: boolean;
}

function printJson(payload: unknown): void {
	// `process.stdout.write` to avoid the trailing newline `console.log`
	// adds — keeps the output pipe-friendly (`brigade cron list --json | jq`).
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatTimestamp(ms: number | undefined): string {
	if (ms === undefined) return "-";
	try {
		return new Date(ms).toISOString();
	} catch {
		return String(ms);
	}
}

function formatBoolean(value: boolean | undefined): string {
	if (value === true) return "yes";
	if (value === false) return "no";
	return "-";
}

/* ─────────────────────────── status ────────────────────────────── */

export async function runCronStatus(opts: CronJsonFlag = {}): Promise<number> {
	const state = freshCronState();
	try {
		const status = await cronStatus(state);
		if (opts.json) {
			printJson(status);
		} else {
			process.stdout.write(
				`cron service\n` +
					`  enabled:        ${formatBoolean(status.enabled)}\n` +
					`  storePath:      ${status.storePath}\n` +
					`  jobs:           ${status.jobCount} (${status.enabledJobCount} enabled, ${status.runningJobCount} running)\n` +
					`  nextWakeAt:     ${formatTimestamp(status.nextWakeAtMs)}\n`,
			);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`cron status failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 2;
	}
}

/* ─────────────────────────── list ─────────────────────────────── */

export interface CronListArgs extends CronJsonFlag {
	all?: boolean;
	query?: string;
	limit?: number;
}

export async function runCronList(args: CronListArgs = {}): Promise<number> {
	const state = freshCronState();
	try {
		const result = await cronListPage(state, {
			enabled: args.all ? "all" : "enabled",
			...(args.query !== undefined ? { query: args.query } : {}),
			limit: args.limit ?? 50,
		});
		if (args.json) {
			printJson(result);
			return 0;
		}
		if (result.jobs.length === 0) {
			process.stdout.write("(no cron jobs)\n");
			return 0;
		}
		process.stdout.write(`${result.jobs.length} of ${result.total} cron job(s)\n\n`);
		for (const job of result.jobs) {
			process.stdout.write(formatJobOneLine(job));
		}
		return 0;
	} catch (err) {
		process.stderr.write(`cron list failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 2;
	}
}

function formatJobOneLine(job: CronJob): string {
	const enabled = job.enabled ? "✓" : "·";
	const sched = formatScheduleShort(job);
	const nextAt = formatTimestamp(job.state.nextRunAtMs);
	const status = job.state.lastStatus ? `[${job.state.lastStatus}]` : "";
	return `  ${enabled} ${job.id.slice(0, 8)}  ${job.name.padEnd(30)}  ${sched.padEnd(20)}  next: ${nextAt}  ${status}\n`;
}

function formatScheduleShort(job: CronJob): string {
	const s = job.schedule;
	if (s.kind === "cron") return `cron ${s.expr}`;
	if (s.kind === "every") {
		const minutes = Math.round(s.everyMs / 60_000);
		if (minutes >= 60) return `every ${Math.round(minutes / 60)}h`;
		return `every ${minutes}m`;
	}
	return `at ${formatTimestamp(s.at)}`;
}

/* ─────────────────────────── add ──────────────────────────────── */

export interface CronAddArgs extends CronJsonFlag {
	/** Caller passes the fully-shaped `CronJobCreate` object (CLI helper builds it from flags). */
	job: CronJobCreate;
}

export async function runCronAdd(args: CronAddArgs): Promise<number> {
	const state = freshCronState();
	try {
		const created = await cronAdd(state, args.job);
		if (args.json) {
			printJson(created);
		} else {
			process.stdout.write(`added cron job ${created.id}: ${created.name}\n`);
			process.stdout.write(formatJobOneLine(created));
		}
		return 0;
	} catch (err) {
		process.stderr.write(`cron add failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

/* ─────────────────────────── edit ─────────────────────────────── */

export interface CronEditArgs extends CronJsonFlag {
	jobId: string;
	patch: CronJobPatch;
}

export async function runCronEdit(args: CronEditArgs): Promise<number> {
	const state = freshCronState();
	try {
		const updated = await cronUpdate(state, args.jobId, args.patch);
		if (args.json) {
			printJson(updated);
		} else {
			process.stdout.write(`updated cron job ${updated.id}\n`);
			process.stdout.write(formatJobOneLine(updated));
		}
		return 0;
	} catch (err) {
		process.stderr.write(`cron edit failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

/* ─────────────────────────── remove / enable / disable ────────── */

export interface CronJobIdArgs extends CronJsonFlag {
	jobId: string;
}

export async function runCronRemove(args: CronJobIdArgs): Promise<number> {
	const state = freshCronState();
	try {
		const removed = await cronRemove(state, args.jobId);
		if (args.json) {
			printJson({ removed, jobId: args.jobId });
		} else {
			process.stdout.write(
				removed
					? `removed cron job ${args.jobId}\n`
					: `cron job ${args.jobId} not found\n`,
			);
		}
		return removed ? 0 : 1;
	} catch (err) {
		process.stderr.write(`cron remove failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 2;
	}
}

export async function runCronEnable(args: CronJobIdArgs): Promise<number> {
	return setEnabledCmd(args, true);
}

export async function runCronDisable(args: CronJobIdArgs): Promise<number> {
	return setEnabledCmd(args, false);
}

async function setEnabledCmd(args: CronJobIdArgs, enabled: boolean): Promise<number> {
	const state = freshCronState();
	try {
		const updated = await cronSetEnabled(state, args.jobId, enabled);
		if (args.json) {
			printJson(updated);
		} else {
			process.stdout.write(
				`${enabled ? "enabled" : "disabled"} cron job ${updated.id}\n`,
			);
		}
		return 0;
	} catch (err) {
		process.stderr.write(
			`cron ${enabled ? "enable" : "disable"} failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
}

/* ─────────────────────────── run ──────────────────────────────── */

export interface CronRunArgs extends CronJobIdArgs {
	mode?: "due" | "force";
}

export async function runCronRunCmd(args: CronRunArgs): Promise<number> {
	const state = freshCronState();
	try {
		await cronEnqueueRun(state, args.jobId, args.mode ?? "force");
		if (args.json) {
			printJson({ enqueued: true, jobId: args.jobId, mode: args.mode ?? "force" });
		} else {
			process.stdout.write(
				`enqueued ${args.mode ?? "force"} run for ${args.jobId}\n` +
					`  the gateway daemon's next tick will pick it up (≤ 60s)\n`,
			);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`cron run failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

/* ─────────────────────────── runs (history) ───────────────────── */

export interface CronRunsArgs extends CronJobIdArgs {
	limit?: number;
}

export async function runCronRuns(args: CronRunsArgs): Promise<number> {
	const state = freshCronState();
	try {
		const entries = await cronRuns(state, args.jobId, {
			limit: args.limit ?? 50,
		});
		if (args.json) {
			printJson({ jobId: args.jobId, entries });
			return 0;
		}
		if (entries.length === 0) {
			process.stdout.write(`no runs yet for ${args.jobId}\n`);
			return 0;
		}
		process.stdout.write(`${entries.length} run(s) for ${args.jobId} (newest first)\n\n`);
		for (const entry of entries) {
			const ts = formatTimestamp(entry.ts);
			const dur = entry.durationMs !== undefined
				? `${Math.round(entry.durationMs)}ms`
				: "-";
			const status = entry.status ?? "?";
			const err = entry.error ? ` · error: ${entry.error.slice(0, 80)}` : "";
			const summary = entry.summary ? ` · ${entry.summary.slice(0, 100)}` : "";
			process.stdout.write(`  ${ts}  ${status.padEnd(7)}  ${dur.padEnd(8)}${err}${summary}\n`);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`cron runs failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
