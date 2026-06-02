/**
 * Per-storePath FIFO lock queue for `brigade-store.json` mutations.
 *
 * Brand-scrubbed analogue of upstream `src/config/sessions/store-lock-state.ts`
 * + the `withSessionStoreLock` / drain logic that lived in upstream's
 * `src/config/sessions/store.ts`. Combined here because Brigade's surface
 * is smaller — every store mutation routes through the single
 * `withSessionStoreLock` API.
 *
 * Concurrency model:
 *
 *   - One queue per absolute `storePath` (keyed in `LOCK_QUEUES`).
 *   - Each task acquires the OS-level file lock via
 *     `acquireSessionWriteLock`, runs the supplied work fn, then releases.
 *   - Inside a single process, two callers writing the same store
 *     serialise through `pending` (FIFO).
 *   - Across processes, the OS lock guarantees only one process at a time
 *     holds write rights.
 *
 * Crash semantics:
 *
 *   - In-process queue is in-memory only; if the process dies, its
 *     pending tasks die with it.
 *   - The OS lockfile is PID-tagged and stale-stolen by the next
 *     acquirer — see `acquireSessionWriteLock` for details.
 *
 * Test helpers (`*ForTest`) are exported alongside; the gateway never
 * touches them.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

export type SessionStoreLockTask = {
	fn: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timeoutMs?: number;
	staleMs: number;
};

export type SessionStoreLockQueue = {
	running: boolean;
	pending: SessionStoreLockTask[];
	drainPromise: Promise<void> | null;
};

export type SessionStoreLockOptions = {
	timeoutMs?: number;
	staleMs?: number;
};

/**
 * P1#9 (Wave H) — pinned via `resolveGlobalSingleton` so dual-loaded copies
 * of this module (test harness + runtime; hot-reload in dev) share ONE
 * queue map. Without the pin, two copies of `withSessionStoreLock` would
 * each maintain their own FIFO and a race between callers from each copy
 * could see overlapping critical sections (the OS-level file lock still
 * gates cross-process correctness, but in-process FIFO would split).
 */
const SESSION_STORE_LOCK_QUEUES_KEY = Symbol.for("brigade.sessionStoreLock.queues");

export const LOCK_QUEUES = resolveGlobalSingleton<Map<string, SessionStoreLockQueue>>(
	SESSION_STORE_LOCK_QUEUES_KEY,
	() => new Map<string, SessionStoreLockQueue>(),
);

function getOrCreateLockQueue(storePath: string): SessionStoreLockQueue {
	const existing = LOCK_QUEUES.get(storePath);
	if (existing) return existing;
	const created: SessionStoreLockQueue = { running: false, pending: [], drainPromise: null };
	LOCK_QUEUES.set(storePath, created);
	return created;
}

function lockTimeoutError(storePath: string): Error {
	return new Error(`timeout waiting for session store lock: ${storePath}`);
}

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
	const queue = LOCK_QUEUES.get(storePath);
	if (!queue) return;
	if (queue.drainPromise) {
		await queue.drainPromise;
		return;
	}
	queue.running = true;
	queue.drainPromise = (async () => {
		try {
			while (queue.pending.length > 0) {
				const task = queue.pending.shift();
				if (!task) continue;
				const remainingTimeoutMs = task.timeoutMs ?? Number.POSITIVE_INFINITY;
				if (task.timeoutMs != null && remainingTimeoutMs <= 0) {
					task.reject(lockTimeoutError(storePath));
					continue;
				}
				let lock: { release: () => Promise<void> } | undefined;
				let result: unknown;
				let failed: unknown;
				let hasFailure = false;
				try {
					lock = await acquireSessionWriteLock({
						sessionFile: storePath,
						timeoutMs: Number.isFinite(remainingTimeoutMs)
							? (remainingTimeoutMs as number)
							: undefined,
					});
					result = await task.fn();
				} catch (err) {
					hasFailure = true;
					failed = err;
				} finally {
					await lock?.release().catch(() => undefined);
				}
				if (hasFailure) {
					task.reject(failed);
					continue;
				}
				task.resolve(result);
			}
		} finally {
			queue.running = false;
			queue.drainPromise = null;
			if (queue.pending.length === 0) {
				LOCK_QUEUES.delete(storePath);
			} else {
				queueMicrotask(() => {
					void drainSessionStoreLockQueue(storePath);
				});
			}
		}
	})();
	await queue.drainPromise;
}

export async function withSessionStoreLock<T>(
	storePath: string,
	fn: () => Promise<T>,
	opts: SessionStoreLockOptions = {},
): Promise<T> {
	if (!storePath || typeof storePath !== "string") {
		throw new Error(
			`withSessionStoreLock: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`,
		);
	}
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const staleMs = opts.staleMs ?? 30_000;
	const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
	const queue = getOrCreateLockQueue(storePath);

	return await new Promise<T>((resolve, reject) => {
		const task: SessionStoreLockTask = {
			fn: async () => await fn(),
			resolve: (value) => resolve(value as T),
			reject,
			timeoutMs: hasTimeout ? timeoutMs : undefined,
			staleMs,
		};
		queue.pending.push(task);
		void drainSessionStoreLockQueue(storePath);
	});
}

/** Test-only — reject every queued task and clear all queues. */
export function clearSessionStoreLockQueuesForTest(): void {
	for (const queue of LOCK_QUEUES.values()) {
		for (const task of queue.pending) {
			task.reject(new Error("session store queue cleared for test"));
		}
		queue.pending.length = 0;
	}
	LOCK_QUEUES.clear();
}

/** Test-only — await any active drain promises then clear. */
export async function drainSessionStoreLockQueuesForTest(): Promise<void> {
	while (LOCK_QUEUES.size > 0) {
		const queues = [...LOCK_QUEUES.values()];
		for (const queue of queues) {
			for (const task of queue.pending) {
				task.reject(new Error("session store queue cleared for test"));
			}
			queue.pending.length = 0;
		}
		const activeDrains = queues.flatMap((queue) =>
			queue.drainPromise ? [queue.drainPromise] : [],
		);
		if (activeDrains.length === 0) {
			LOCK_QUEUES.clear();
			return;
		}
		await Promise.allSettled(activeDrains);
	}
}

/** Test-only — current number of distinct storePath queues. */
export function getSessionStoreLockQueueSizeForTest(): number {
	return LOCK_QUEUES.size;
}
