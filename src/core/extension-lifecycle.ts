/**
 * Small, pure helpers for extension lifecycle orchestration — extracted from the
 * gateway so they can be unit-tested in isolation (the gateway closure can't be).
 *
 *  - `withTimeout` time-boxes a module lifecycle call (register/start/stop/import)
 *    so one slow or hung module can never wedge boot, reload, or shutdown.
 *  - `makeOpQueue` serializes async ops onto one chain so e.g. a `reload` can't
 *    race boot and double-start a channel (leaking a second live socket).
 *
 * Note on `withTimeout`: when the timeout wins the race, the input promise keeps
 * running. That is intentional — we can't cancel a started service or a dynamic
 * import — and it is SAFE: `Promise.race` attaches a reaction to the input, so a
 * later rejection is already "handled" and never surfaces as an
 * unhandledRejection (verified empirically). We deliberately do NOT await the
 * straggler.
 */

/** Race a promise against a timeout. On timeout, rejects with a labelled error. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A serialized async-op runner: each queued op starts only after the prior settles. */
export type OpQueue = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Build a FIFO op queue. The returned function runs `fn` after every previously
 * queued op has settled (success OR failure — a rejected op never wedges the
 * chain). The caller still receives `fn`'s real result/rejection.
 */
export function makeOpQueue(): OpQueue {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}
