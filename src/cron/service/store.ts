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
import type { CronJob, CronStoreFile } from "../types.js";
import type { CronServiceState } from "./state.js";

const CURRENT_STORE_VERSION = 1;

/**
 * Read the on-disk store. Returns an empty store when the file is missing,
 * malformed, or unreadable. Never throws — callers can rely on getting a
 * usable struct back.
 */
export function loadCronStore(storePath: string): CronStoreFile {
	if (!fs.existsSync(storePath)) {
		return { version: CURRENT_STORE_VERSION, jobs: [] };
	}
	let raw: string;
	try {
		raw = fs.readFileSync(storePath, "utf8");
	} catch {
		return { version: CURRENT_STORE_VERSION, jobs: [] };
	}
	if (!raw.trim()) {
		return { version: CURRENT_STORE_VERSION, jobs: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { version: CURRENT_STORE_VERSION, jobs: [] };
	}
	if (!parsed || typeof parsed !== "object") {
		return { version: CURRENT_STORE_VERSION, jobs: [] };
	}
	const candidate = parsed as Partial<CronStoreFile>;
	const jobs = Array.isArray(candidate.jobs)
		? candidate.jobs.filter((j): j is CronJob => isMinimalJobShape(j))
		: [];
	// Version is normalized to CURRENT — unknown future fields on each job
	// pass through (CronJob is `[key: string]: unknown`-friendly via the
	// state field) so we don't blow away operator data on read.
	return { version: CURRENT_STORE_VERSION, jobs };
}

/** Atomic write of the store. Throws on I/O failure. */
export function saveCronStore(storePath: string, store: CronStoreFile): void {
	ensureDir(path.dirname(storePath));
	const tmp = `${storePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
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
 */
export async function ensureLoaded(state: CronServiceState): Promise<void> {
	state.store = loadCronStore(state.storePath);
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
	return (
		typeof v.id === "string" &&
		typeof v.name === "string" &&
		typeof v.enabled === "boolean" &&
		typeof v.schedule === "object" && v.schedule !== null &&
		typeof v.payload === "object" && v.payload !== null &&
		typeof v.sessionTarget === "string"
	);
}
