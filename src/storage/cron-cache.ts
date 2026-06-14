// src/storage/cron-cache.ts
//
// Convex-mode in-process cache for the cron jobs store (cron.json
// equivalent). The cron service's whole-file load/save choke points
// (src/cron/service/store.ts) dispatch here in convex mode: loads serve the
// cache, saves prime it and enqueue the per-job mutations realising the
// diff. Boot hydration fills it from `store.cron.listJobs()`.
//
// Filesystem mode never touches this module.

import type { CronJob } from "../cron/types.js";
import type { BrigadeStore } from "./store.js";

let _jobs: CronJob[] | undefined;
let _flushChain: Promise<void> = Promise.resolve();

export function primeCronCache(jobs: CronJob[]): void {
	_jobs = structuredClone(jobs);
}

export function getCachedCronJobs(): CronJob[] {
	return _jobs ?? [];
}

export function isCronCachePrimed(): boolean {
	return _jobs !== undefined;
}

/** Diff `next.jobs` against the cache by job id, prime, and enqueue the
 *  insert/update/delete mutations. The cron service serialises its own
 *  saves under the per-instance lock, so the diff base is always the
 *  previous save's state. */
export function writeThroughCronCache(
	store: BrigadeStore,
	next: { jobs: CronJob[] },
): void {
	const prev = _jobs ?? [];
	primeCronCache(next.jobs);

	const prevById = new Map(prev.map((j) => [j.id, j] as const));
	const nextById = new Map(next.jobs.map((j) => [j.id, j] as const));
	type StoreCronJob = Parameters<BrigadeStore["cron"]["insertJob"]>[0];
	const ops: Array<() => Promise<unknown>> = [];
	for (const [id, job] of nextById) {
		const old = prevById.get(id);
		if (!old) {
			const frozen = structuredClone(job) as unknown as StoreCronJob;
			ops.push(() => store.cron.insertJob(frozen));
			continue;
		}
		if (JSON.stringify(old) === JSON.stringify(job)) continue;
		const frozen = structuredClone(job) as unknown as StoreCronJob;
		ops.push(() => store.cron.updateJob(id, () => frozen));
	}
	for (const id of prevById.keys()) {
		if (!nextById.has(id)) ops.push(() => store.cron.deleteJob(id));
	}
	if (ops.length === 0) return;

	_flushChain = _flushChain
		.then(async () => {
			for (const op of ops) await op();
		})
		.catch((err) => {
			console.error(
				`brigade: cron store write to convex failed — ${(err as Error).message}`,
			);
		});
}

/** Resolves when every cron mutation enqueued so far reached the backend. */
export function awaitCronFlush(): Promise<void> {
	return _flushChain;
}

/** Test-only. */
export function __resetCronCacheForTests(): void {
	_jobs = undefined;
	_flushChain = Promise.resolve();
}
