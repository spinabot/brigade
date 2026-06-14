// src/storage/local/cron-store.ts
//
// LocalCronStore — filesystem-mode wrapper around `cron/service/store.ts` +
// `cron/run-log.ts` + `cron/service/locked.ts`. Implements `CronStore`.
//
// The per-path promise-chain lock (`withCronStoreLock`) serialises every
// read-modify-write against `~/.brigade/cron.json`. We surface it as
// `withMutation` so consumers can compose multiple operations atomically
// without re-deriving the lock key.
//
// Reservation atomicity (`markJobRunning`) — the two-phase tick pattern —
// preserves today's behaviour: mark running with a timestamp, then race
// only against the same job's outcome; sibling jobs land in parallel.
//
// Run-log + isolated-session cleanup live in the cron service ops surface
// today; the in-flight `listIsolatedCronSessions` / `deleteIsolatedCron-
// Session` calls cross into the SessionStore and stay stubbed here until
// PR14 lands sessions.

import * as path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import { appendCronRunLog, readCronRunLogEntries } from "../../cron/run-log.js";
import { withCronStoreLock } from "../../cron/service/locked.js";
import { loadCronStore, saveCronStore } from "../../cron/service/store.js";
import type { CronJob as InternalCronJob, CronJobState as InternalCronJobState } from "../../cron/types.js";

import { watchFile } from "./file-watcher.js";

import { NotImplementedYet } from "../store.js";
import type {
	CronJob,
	CronJobState,
	CronRunLogEntry,
	CronStore,
	ReadCronRunLogOpts,
	Unsub,
} from "../store.js";

function resolveCronStorePath(): string {
	return path.join(resolveStateDir(), "cron.json");
}

function asInternal(job: CronJob): InternalCronJob {
	return job as unknown as InternalCronJob;
}
function asInternalArr(jobs: InternalCronJob[]): CronJob[] {
	return jobs as unknown as CronJob[];
}

export class LocalCronStore implements CronStore {
	constructor(private readonly _stateDir: string) {}

	async listJobs(filter?: {
		enabled?: boolean;
		query?: string;
		ownerOnly?: boolean;
	}): Promise<CronJob[]> {
		const storePath = resolveCronStorePath();
		const { jobs } = loadCronStore(storePath);
		let out = jobs;
		if (filter?.enabled !== undefined) {
			out = out.filter((j) => j.enabled === filter.enabled);
		}
		if (filter?.query) {
			const q = filter.query.toLowerCase();
			out = out.filter((j) => {
				const name = (j as { name?: string }).name?.toLowerCase() ?? "";
				const desc = (j as { description?: string }).description?.toLowerCase() ?? "";
				const id = (j.id ?? "").toLowerCase();
				return name.includes(q) || desc.includes(q) || id.includes(q);
			});
		}
		if (filter?.ownerOnly) {
			out = out.filter((j) => {
				const kind = (j as { createdBy?: { kind?: string } }).createdBy?.kind;
				return kind === undefined || kind === "owner" || kind === "legacy";
			});
		}
		return asInternalArr(out);
	}

	async getJob(jobId: string): Promise<CronJob | null> {
		const { jobs } = loadCronStore(resolveCronStorePath());
		const found = jobs.find((j) => j.id === jobId);
		return found ? (found as unknown as CronJob) : null;
	}

	async insertJob(job: CronJob): Promise<void> {
		const storePath = resolveCronStorePath();
		await withCronStoreLock(storePath, async () => {
			const store = loadCronStore(storePath);
			// First-write-wins for identical ids — the caller should pre-check
			// for collisions via getJob. We don't dedupe here to keep the
			// adapter byte-for-byte with the existing ops layer.
			store.jobs.push(asInternal(job));
			saveCronStore(storePath, store);
		});
	}

	async updateJob(jobId: string, mutate: (job: CronJob) => CronJob): Promise<CronJob> {
		const storePath = resolveCronStorePath();
		return withCronStoreLock(storePath, async () => {
			const store = loadCronStore(storePath);
			const idx = store.jobs.findIndex((j) => j.id === jobId);
			if (idx < 0) {
				throw new Error(`LocalCronStore.updateJob: job "${jobId}" not found`);
			}
			const current = store.jobs[idx];
			if (!current) {
				throw new Error(`LocalCronStore.updateJob: job "${jobId}" not found`);
			}
			const next = mutate(current as unknown as CronJob) as unknown as InternalCronJob;
			store.jobs[idx] = next;
			saveCronStore(storePath, store);
			return next as unknown as CronJob;
		});
	}

	async deleteJob(jobId: string): Promise<boolean> {
		const storePath = resolveCronStorePath();
		return withCronStoreLock(storePath, async () => {
			const store = loadCronStore(storePath);
			const before = store.jobs.length;
			store.jobs = store.jobs.filter((j) => j.id !== jobId);
			if (store.jobs.length === before) return false;
			saveCronStore(storePath, store);
			return true;
		});
	}

	async markJobRunning(jobId: string, runningAtMs: number): Promise<boolean> {
		const storePath = resolveCronStorePath();
		return withCronStoreLock(storePath, async () => {
			const store = loadCronStore(storePath);
			const job = store.jobs.find((j) => j.id === jobId);
			if (!job) return false;
			const state = (job.state ?? {}) as InternalCronJobState;
			if (state.runningAtMs && state.runningAtMs > 0) {
				// Already reserved by a sibling tick; caller must back off.
				return false;
			}
			job.state = { ...state, runningAtMs };
			saveCronStore(storePath, store);
			return true;
		});
	}

	async recordJobOutcome(
		jobId: string,
		patch: { state: Partial<CronJobState>; deleteAfterApply: boolean },
	): Promise<CronJob | null> {
		const storePath = resolveCronStorePath();
		return withCronStoreLock(storePath, async () => {
			const store = loadCronStore(storePath);
			const idx = store.jobs.findIndex((j) => j.id === jobId);
			if (idx < 0) return null;
			const job = store.jobs[idx];
			if (!job) return null;
			job.state = { ...(job.state ?? {}), ...(patch.state as InternalCronJobState) };
			if (patch.deleteAfterApply) {
				store.jobs.splice(idx, 1);
				saveCronStore(storePath, store);
				return null;
			}
			saveCronStore(storePath, store);
			return job as unknown as CronJob;
		});
	}

	async appendRunLog(entry: CronRunLogEntry): Promise<void> {
		await appendCronRunLog(
			entry as unknown as Parameters<typeof appendCronRunLog>[0],
		);
	}

	async listRunLog(jobId: string, opts: ReadCronRunLogOpts): Promise<CronRunLogEntry[]> {
		const entries = await readCronRunLogEntries(jobId, {
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
			...((opts as { offset?: number }).offset !== undefined
				? { offset: (opts as { offset?: number }).offset as number }
				: {}),
		});
		return entries as unknown as CronRunLogEntry[];
	}

	async listIsolatedCronSessions(
		_agentId: string,
	): Promise<Array<{ sessionKey: string; sessionId: string; lastUsedAt: string }>> {
		// Crosses into SessionStore; lands when PR14 (sessions + messages)
		// ships. Until then the existing session-reaper path keeps working
		// (it reaches into sessions.json directly, not via the store).
		throw new NotImplementedYet("cron.listIsolatedCronSessions (needs PR14 sessions wrap)");
	}

	async deleteIsolatedCronSession(_agentId: string, _sessionKey: string): Promise<void> {
		throw new NotImplementedYet("cron.deleteIsolatedCronSession (needs PR14 sessions wrap)");
	}

	async withMutation<T>(work: () => Promise<T>): Promise<T> {
		return withCronStoreLock(resolveCronStorePath(), work);
	}

	subscribe(cb: (jobs: CronJob[]) => void): Unsub {
		// fs.watch on cron.json with the standard 500 ms debounce. On change
		// we re-load + emit the fresh job list. Identical semantics to the
		// `LocalConfigStore.subscribe` pattern.
		return watchFile(resolveCronStorePath(), () => {
			try {
				const { jobs } = loadCronStore(resolveCronStorePath());
				cb(asInternalArr(jobs));
			} catch {
				// Mid-write — skip this firing.
			}
		});
	}
}
