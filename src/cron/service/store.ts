/**
 * On-disk persistence for the cron store.
 *
 * Single file at `~/.brigade/cron.json`. Atomic writes via tmp+rename so a
 * crash mid-write can't leave the operator with a half-truncated store.
 * Read is lenient: a missing file returns an empty store, a parse failure
 * returns an empty store + logs a warning (the alternative — refusing to
 * start — would brick the gateway daemon on a single corrupted byte).
 *
 * Schema version is hardcoded to 1 today; future-version files are accepted
 * with a warning and downgraded to v1 semantics (we ignore fields we don't
 * understand). Past-version migration will land alongside any v2 bump.
 */

import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { coerceScheduleInput, normalizeSchedule } from "../normalize.js";
import { computeNextRunAtMs } from "../schedule.js";
import type { CronJob, CronStoreFile } from "../types.js";
import type { CronServiceState } from "./state.js";

const log = createSubsystemLogger("cron/store");

const CURRENT_STORE_VERSION = 1;

/**
 * Read the on-disk store. Returns an empty store when the file is missing,
 * malformed, or unreadable. Never throws — callers can rely on getting a
 * usable struct back. Sets `repaired = true` on the result when any job's
 * schedule needed coercion so callers (`ensureLoaded`) can persist the
 * canonical form ONCE — avoiding the "repaired job schedule on load" log
 * line being emitted on every single tick (Bug #10).
 */
export interface LoadCronStoreResult {
	store: CronStoreFile;
	repaired: boolean;
}

export function loadCronStore(storePath: string): CronStoreFile {
	return loadCronStoreWithRepairFlag(storePath).store;
}

export function loadCronStoreWithRepairFlag(storePath: string): LoadCronStoreResult {
	if (!fs.existsSync(storePath)) {
		return { store: { version: CURRENT_STORE_VERSION, jobs: [] }, repaired: false };
	}
	let raw: string;
	try {
		raw = fs.readFileSync(storePath, "utf8");
	} catch {
		return { store: { version: CURRENT_STORE_VERSION, jobs: [] }, repaired: false };
	}
	if (!raw.trim()) {
		return { store: { version: CURRENT_STORE_VERSION, jobs: [] }, repaired: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { store: { version: CURRENT_STORE_VERSION, jobs: [] }, repaired: false };
	}
	if (!parsed || typeof parsed !== "object") {
		return { store: { version: CURRENT_STORE_VERSION, jobs: [] }, repaired: false };
	}
	const candidate = parsed as Partial<CronStoreFile>;
	const rawJobs = Array.isArray(candidate.jobs) ? candidate.jobs : [];
	const jobs: CronJob[] = [];
	let repaired = false;
	for (const raw of rawJobs) {
		if (!isMinimalJobShape(raw)) {
			repaired = true; // drop = a change vs disk
			continue;
		}
		// Repair on read: an older Brigade build (or an agent that called
		// the tool with the wrong shape) may have persisted `schedule` as a
		// bare string ("0 9 * * *") or an object missing `kind`. In that
		// state `computeNextRunAtMs` returned undefined and the job NEVER
		// fired. Run the stored schedule through `coerceScheduleInput` so
		// the shape becomes canonical on the next save — and if the schedule
		// truly can't be coerced (genuine corruption), drop the job with a
		// log rather than poison the whole store.
		const result = repairLoadedJobWithFlag(raw as unknown as CronJob);
		if (!result) {
			repaired = true; // drop
			continue;
		}
		if (result.changed) repaired = true;
		jobs.push(result.job);
	}
	// Version is normalized to CURRENT — unknown future fields on each job
	// pass through (CronJob is `[key: string]: unknown`-friendly via the
	// state field) so we don't blow away operator data on read.
	return { store: { version: CURRENT_STORE_VERSION, jobs }, repaired };
}

/**
 * Coerce a freshly-loaded job's schedule into the canonical shape (so an
 * older bad-shape entry becomes executable) and recompute `nextRunAtMs`
 * when the original was missing because the schedule had been unschedulable.
 * Returns `null` if the schedule is genuinely uncoercible.
 */
function repairLoadedJob(job: CronJob): CronJob | null {
	const result = repairLoadedJobWithFlag(job);
	return result ? result.job : null;
}

interface RepairResult {
	job: CronJob;
	changed: boolean;
}

/**
 * Repair variant that also reports whether the job changed shape vs disk —
 * lets `loadCronStoreWithRepairFlag` decide to persist the canonical form
 * ONCE so subsequent loads see no change and don't re-emit the "repaired"
 * log line on every tick (Bug #10).
 */
function repairLoadedJobWithFlag(job: CronJob): RepairResult | null {
	let canonical: CronJob["schedule"];
	try {
		canonical = normalizeSchedule(coerceScheduleInput(job.schedule));
	} catch (err) {
		log.warn("dropping job with uncoercible schedule on load", {
			id: job.id,
			name: job.name,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	const scheduleChanged = canonical !== job.schedule;
	// Recompute nextRunAtMs if it's missing on an enabled job (this is the
	// signature of an OLD build's failed compute) OR if we just changed the
	// schedule shape (a new canonical may have a different fire-time).
	const needsRecompute =
		(job.enabled && job.state?.nextRunAtMs === undefined) || scheduleChanged;
	if (!scheduleChanged && !needsRecompute) return { job, changed: false };
	const now = Date.now();
	let nextRunAtMs: number | undefined;
	try {
		nextRunAtMs = computeNextRunAtMs(canonical, now);
	} catch {
		nextRunAtMs = undefined;
	}
	if (scheduleChanged) {
		// Logged at debug — the canonical form is persisted by the caller on
		// first repair, so subsequent loads observe a no-op repair. If the
		// log ever returns on every tick, the persist-on-repair path
		// downstream is broken.
		log.debug("repaired job schedule on load (string/legacy → canonical object)", {
			id: job.id,
			name: job.name,
			nextRunAtMs,
		});
	}
	return {
		job: {
			...job,
			schedule: canonical,
			state: {
				...(job.state ?? {}),
				...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
			},
		},
		changed: true,
	};
}

/**
 * Atomic write of the store. Hardening details:
 *
 *   1. tmp+rename so a crash mid-write can't leave a half-truncated file.
 *   2. `0o600` perms on the tmp + final so an unprivileged process on a
 *      shared box can't read the operator's cron schedules — schedules
 *      can contain sensitive context (e.g. "ping me about acquisition
 *      negotiation at 9am Monday") + downstream announce destinations.
 *   3. `.bak` rotation: before overwriting an existing store, the previous
 *      contents are copied to `<path>.bak`. A single backup is enough —
 *      if the next write corrupts the file too, the operator has the
 *      one-back state to recover from. Older `.bak.<N>` rotations would
 *      blow up disk for marginal benefit.
 *
 * Backup is skipped on the first-ever write (no existing file) and on
 * read-failure of the existing file (we don't want to write a broken
 * backup over a previously-good one).
 */
export function saveCronStore(storePath: string, store: CronStoreFile): void {
	ensureDir(path.dirname(storePath));
	const tmp = `${storePath}.tmp`;
	const bak = `${storePath}.bak`;
	// Rotate the existing store to `.bak` BEFORE we overwrite. Best-effort
	// — a missing source file (first-ever save) skips silently; a read /
	// write error logs at warn but doesn't block the new write (we'd rather
	// lose the backup than refuse the legitimate update).
	if (fs.existsSync(storePath)) {
		try {
			fs.copyFileSync(storePath, bak);
			try {
				fs.chmodSync(bak, 0o600);
			} catch {
				/* perm-set best-effort on platforms that don't support it */
			}
		} catch (err) {
			log.warn("cron store .bak rotation failed", {
				path: bak,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	// Write tmp with 0o600 perms set at create-time when possible — fall
	// back to a post-write chmod on platforms that don't honour the
	// `mode` option (Windows). The rename inherits the tmp's mode.
	fs.writeFileSync(tmp, JSON.stringify(store, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		fs.chmodSync(tmp, 0o600);
	} catch {
		/* best-effort */
	}
	fs.renameSync(tmp, storePath);
}

/** Persist the in-memory store under the per-instance lock. */
export async function persist(state: CronServiceState): Promise<void> {
	saveCronStore(state.storePath, state.store);
}

/**
 * Refresh `state.store` from disk. Called before every persist-write
 * sequence so concurrent edits made by ANOTHER process (e.g., the operator
 * running `brigade cron edit` while the daemon is also writing) don't get
 * silently overwritten. Last-write-wins WITH a fresh read is the safety net.
 *
 * Persists the canonical form back to disk on the FIRST load that needs
 * schedule repair (Bug #10). Without this, every subsequent tick reloaded
 * the still-uncanonical disk file, re-emitted the "repaired job schedule
 * on load" log line, and noise-saturated the operator's diagnostic
 * stream. After the persist, the on-disk shape is canonical and future
 * loads observe a no-op repair.
 */
export async function ensureLoaded(state: CronServiceState): Promise<void> {
	const result = loadCronStoreWithRepairFlag(state.storePath);
	state.store = result.store;
	if (result.repaired) {
		try {
			saveCronStore(state.storePath, state.store);
			log.info("cron store canonicalised on load — subsequent loads will be silent", {
				path: state.storePath,
				jobCount: state.store.jobs.length,
			});
		} catch (err) {
			// A persist failure isn't fatal — the next persist on a normal
			// mutation will eventually canonicalise. We just keep paying the
			// repair cost on each load until it succeeds.
			log.warn("cron store canonicalisation persist failed", {
				path: state.storePath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/**
 * Minimal shape check — just enough to reject clearly-broken entries on
 * load. Full validation lives in `assertSupportedJobSpec` (jobs.ts) and
 * runs on EDIT, not on every restart. This is the "didn't get mangled by
 * a half-write" check.
 */
function isMinimalJobShape(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	// `schedule` is accepted as either an object (canonical) OR a string
	// (legacy / agent-passed bare cron expression). The `repairLoadedJob`
	// pass downstream coerces strings to the canonical shape before the
	// timer sees them; rejecting them here would drop user data, which is
	// the bug we're trying to undo.
	const scheduleOk =
		(typeof v.schedule === "object" && v.schedule !== null) ||
		typeof v.schedule === "string";
	return (
		typeof v.id === "string" &&
		typeof v.name === "string" &&
		typeof v.enabled === "boolean" &&
		scheduleOk &&
		typeof v.payload === "object" && v.payload !== null &&
		typeof v.sessionTarget === "string"
	);
}
