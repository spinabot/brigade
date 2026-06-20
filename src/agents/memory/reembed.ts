/**
 * Re-embed pass — fills vectors that embed-on-write SKIPPED.
 *
 * `FactStore.write` embeds inline ONLY when the default embedder is SYNC (the
 * bundled HRR). When a LEARNED (async) embedder is selected (OpenAI / local
 * node-llama-cpp), write can't await it, so the fact is stored WITHOUT a vector —
 * recall still works via BM25-primary, but the vector recovery lane has nothing to
 * match. This pass runs OFF the hot path (the gateway sweep), embeds those pending
 * facts with the current embedder (await handles sync + async) and writes the
 * vectors back via {@link FactStore.applyEmbeddings} — so a selected learned
 * embedder progressively gains its true-synonymy recall. Bounded per pass +
 * best-effort (never throws into the sweep).
 *
 * All-facts scope: facts written under a PRIOR embedder keep their old vector —
 * cross-family cosine just falls below the recovery floor, so they still recall via
 * BM25. A full back-catalogue re-embed on a family switch would need an embedder
 * fingerprint on the record (deferred); this pass fills ALL unembedded facts
 * (newly-written AND legacy pre-embed-on-write records alike).
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { Embedder } from "./embedder.js";

const log = createSubsystemLogger("memory/reembed");

/** Minimal store surface this pass needs (a `FactStore` satisfies it structurally). */
export interface ReembedStore {
	list(): Array<{ memoryId: string; content: string; embedding?: number[] }>;
	applyEmbeddings(updates: ReadonlyArray<{ memoryId: string; embedding: number[] }>): void;
}

/**
 * Embed up to `limit` active facts that currently have NO vector, using
 * `embedder` (async-safe). Returns the count embedded. No-op when nothing is
 * pending (the sync HRR default vectors everything on write, so this only does
 * work once a learned embedder is selected).
 */
export async function reembedPending(
	store: ReembedStore,
	embedder: Embedder,
	opts: { limit?: number } = {},
): Promise<number> {
	const limit = opts.limit && opts.limit > 0 ? opts.limit : 64;
	const pending = store
		.list()
		.filter((r) => r.embedding === undefined || r.embedding.length === 0)
		.slice(0, limit);
	if (pending.length === 0) return 0;
	let vectors: number[][];
	try {
		vectors = await Promise.resolve(embedder.embed(pending.map((r) => r.content)));
	} catch (err) {
		log.warn("reembed batch failed", { error: err instanceof Error ? err.message : String(err) });
		return 0; // best-effort — the facts stay vector-less; recall falls back to BM25
	}
	const updates: Array<{ memoryId: string; embedding: number[] }> = [];
	for (let i = 0; i < pending.length; i++) {
		const v = vectors[i];
		// Exact-width gate (not just non-empty): a misconfigured learned embedder
		// emitting a wrong-width vector would otherwise reach the convex by_embedding
		// (fixed 256-dim) insert and THROW — losing the fact. Drop the bad vector
		// instead; the fact stays vector-less and still recalls via BM25.
		if (Array.isArray(v) && v.length === embedder.dims) {
			updates.push({ memoryId: pending[i]!.memoryId, embedding: v });
		}
	}
	store.applyEmbeddings(updates);
	if (updates.length > 0) log.info("reembed pass", { embedded: updates.length });
	return updates.length;
}
