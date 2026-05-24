/**
 * Cron run history — one JSONL file per job at
 * `~/.brigade/cron/runs/<jobId>.jsonl`.
 *
 * Append-only on every finished run. Pruned in-place when the file crosses
 * either of two caps:
 *   - byte size (default 2 MB)
 *   - line count (default 2000)
 *
 * On prune, we keep the TAIL — the newest entries are the ones the operator
 * actually cares about ("did my nightly backup run last night?"). Older
 * entries get dropped silently.
 *
 * The pruner reads the whole file into memory before rewriting; given the
 * 2 MB cap that's a one-shot tens-of-milliseconds operation on any modern
 * disk. We don't bother with rotated-file archives — the operator wants a
 * single fresh view, not a history of pruned chunks.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import type { CronRunLogEntry } from "./types.js";

const log = createSubsystemLogger("cron/runs");

export const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2_000_000;
export const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2000;

export interface CronRunLogLimits {
	maxBytes?: number;
	keepLines?: number;
}

/** Path to the run-log directory: `~/.brigade/cron/runs/`. */
export function resolveCronRunLogDir(): string {
	return path.join(resolveStateDir(), "cron", "runs");
}

/** Path to the per-job run-log file. */
export function resolveCronRunLogPath(jobId: string): string {
	return path.join(resolveCronRunLogDir(), `${jobId}.jsonl`);
}

/**
 * Append one `CronRunLogEntry` to the per-job JSONL. Best-effort: if the
 * filesystem is full or unwritable, we log a warning and return — the run's
 * actual outcome (in the cron event + the task ledger) is the authoritative
 * record. The log file is for human-facing forensics, not for correctness.
 */
export async function appendCronRunLog(
	entry: CronRunLogEntry,
	limits?: CronRunLogLimits,
): Promise<void> {
	const dir = resolveCronRunLogDir();
	const filePath = resolveCronRunLogPath(entry.jobId);
	try {
		await fs.mkdir(dir, { recursive: true });
		const line = `${JSON.stringify(entry)}\n`;
		await fs.appendFile(filePath, line, "utf8");
		await maybePruneCronRunLog(filePath, limits);
	} catch (err) {
		log.warn("append failed — run history may be missing this entry", {
			jobId: entry.jobId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Tail-retain prune: if the file is over either cap, drop the oldest lines
 * until we're back under both. Idempotent — when neither cap is exceeded
 * we never even read the file.
 */
async function maybePruneCronRunLog(
	filePath: string,
	limits: CronRunLogLimits | undefined,
): Promise<void> {
	const maxBytes = limits?.maxBytes ?? DEFAULT_CRON_RUN_LOG_MAX_BYTES;
	const keepLines = limits?.keepLines ?? DEFAULT_CRON_RUN_LOG_KEEP_LINES;
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(filePath);
	} catch {
		return; // file vanished mid-flight — nothing to prune
	}
	if (stat.size <= maxBytes) {
		// Still need to check line count even if bytes are under cap, but
		// the line count usually correlates so this is the common short-
		// circuit path.
		const raw = await fs.readFile(filePath, "utf8");
		const lines = raw.split("\n").filter((l) => l.length > 0);
		if (lines.length <= keepLines) return;
		const keep = lines.slice(-keepLines);
		await atomicReplace(filePath, `${keep.join("\n")}\n`);
		return;
	}
	const raw = await fs.readFile(filePath, "utf8");
	const lines = raw.split("\n").filter((l) => l.length > 0);
	const sliceFrom = Math.max(0, lines.length - keepLines);
	const kept = lines.slice(sliceFrom);
	await atomicReplace(filePath, `${kept.join("\n")}\n`);
}

/** Atomic rewrite via tmp + rename so a crash mid-prune doesn't lose data. */
async function atomicReplace(filePath: string, contents: string): Promise<void> {
	const tmp = `${filePath}.tmp`;
	await fs.writeFile(tmp, contents, "utf8");
	await fs.rename(tmp, filePath);
}

export interface ReadCronRunLogOpts {
	limit?: number;
	offset?: number;
	status?: "ok" | "error" | "skipped";
}

/**
 * Read run history entries newest-first. Returns up to `limit` entries
 * starting at `offset`. Filters by `status` when supplied. Missing file →
 * empty result (treated as "no runs yet").
 */
export async function readCronRunLogEntries(
	jobId: string,
	opts: ReadCronRunLogOpts = {},
): Promise<CronRunLogEntry[]> {
	const filePath = resolveCronRunLogPath(jobId);
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const limit = Math.max(0, opts.limit ?? 50);
	const offset = Math.max(0, opts.offset ?? 0);
	const lines = raw.split("\n").filter((l) => l.length > 0);
	const decoded: CronRunLogEntry[] = [];
	// Iterate newest-first by walking the array in reverse.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		let parsed: CronRunLogEntry;
		try {
			parsed = JSON.parse(line) as CronRunLogEntry;
		} catch {
			continue;
		}
		if (opts.status !== undefined && parsed.status !== opts.status) continue;
		decoded.push(parsed);
		if (decoded.length >= offset + limit) break;
	}
	return decoded.slice(offset, offset + limit);
}
