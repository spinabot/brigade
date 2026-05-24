/**
 * Sequential per-storePath promise chain for cron-store writes.
 *
 * The cron store is a single JSON file on disk (`~/.brigade/cron.json`).
 * Two callers writing at the same time would race the read-modify-write
 * cycle and one's edit would silently overwrite the other's. We avoid that
 * by serialising every write through a per-path promise chain:
 *
 *   - Caller A starts an `add` op → the chain tail awaits its work then advances.
 *   - Caller B starts a concurrent `add` op → it tacks onto the tail and
 *     runs strictly AFTER A's read-write-persist cycle finishes.
 *
 * Two chain dimensions:
 *
 *   - **state.op** (per-CronServiceState instance) — ensures the in-memory
 *     state mutations stay ordered for callers that share the same service
 *     instance. This is the common path.
 *   - **storeLocks** (per-storePath, process-wide) — protects against TWO
 *     CronServiceState instances pointing at the SAME storePath (test
 *     harnesses do this on purpose; future multi-agent operators might too).
 *     Without this layer the per-instance chain wouldn't prevent
 *     cross-instance interleaving.
 *
 * Both layers are FIFO. No starvation possible since each op is bounded.
 */

const storeLocks = new Map<string, Promise<unknown>>();

/**
 * Run `work` under the per-path lock. Returns the work's result.
 * Re-entrancy: if `work` itself calls `withCronStoreLock` for the same path,
 * it will deadlock (we don't track ownership). Callers must keep the body
 * straight-line.
 */
export function withCronStoreLock<T>(
	storePath: string,
	work: () => Promise<T>,
): Promise<T> {
	const previous = (storeLocks.get(storePath) ?? Promise.resolve()) as Promise<unknown>;
	const next = previous
		.catch(() => undefined) // a previous holder's rejection mustn't block us
		.then(() => work());
	storeLocks.set(
		storePath,
		next.catch(() => undefined),
	);
	return next;
}

/**
 * Chain `work` onto a per-instance promise. The instance owns the chain
 * (passed by reference + reassigned each call). Same FIFO semantics as
 * `withCronStoreLock`; this layer is for in-memory mutations that share a
 * single CronServiceState.
 */
export interface PerInstanceChain {
	tail: Promise<unknown>;
}

export function newPerInstanceChain(): PerInstanceChain {
	return { tail: Promise.resolve() };
}

export function withPerInstanceLock<T>(
	chain: PerInstanceChain,
	work: () => Promise<T>,
): Promise<T> {
	const previous = chain.tail.catch(() => undefined);
	const next = previous.then(() => work());
	chain.tail = next.catch(() => undefined);
	return next;
}

/** Test-only hook: clear the global per-path map. */
export function clearCronStoreLocksForTests(): void {
	storeLocks.clear();
}
