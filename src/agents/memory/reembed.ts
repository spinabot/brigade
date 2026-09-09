/** Compatibility entry. Canonical implementation lives in src/tideline/. */
export * from "../../tideline/embeddings/reembed.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { reembedPending as reembedCore } from "../../tideline/embeddings/reembed.js";

const logger = createSubsystemLogger("memory/reembed");

export async function reembedPending(...args: Parameters<typeof reembedCore>): Promise<number> {
	const [store, embedder, opts = {}] = args;
	await store.ready?.();
	const count = await reembedCore(store, embedder, { ...opts, logger: opts.logger ?? logger });
	await store.flush?.();
	return count;
}
