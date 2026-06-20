import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type Embedder, getDefaultEmbedder, setDefaultEmbedder } from "./embedder.js";
import { FactStore } from "./records.js";
import { reembedPending, type ReembedStore } from "./reembed.js";

function fakeStore(
	facts: Array<{ memoryId: string; content: string; embedding?: number[] }>,
): ReembedStore & { facts: typeof facts } {
	return {
		facts,
		list: () => facts,
		applyEmbeddings(updates) {
			for (const u of updates) {
				const f = facts.find((x) => x.memoryId === u.memoryId);
				if (f) f.embedding = u.embedding;
			}
		},
	};
}

/** A learned-style ASYNC embedder (returns a Promise) for the integration test. */
const asyncEmbedder = (dims = 4): Embedder => ({
	id: "fake-async",
	dims,
	embed: async (texts) => texts.map((t) => [t.length, 1, 0, 0].slice(0, dims)),
});

describe("reembedPending", () => {
	it("embeds only facts MISSING a vector, returns the count", async () => {
		const store = fakeStore([
			{ memoryId: "a", content: "alpha" },
			{ memoryId: "b", content: "beta", embedding: [9, 9, 9, 9] },
			{ memoryId: "c", content: "gamma" },
		]);
		const n = await reembedPending(store, asyncEmbedder());
		assert.equal(n, 2);
		assert.deepEqual(store.facts[0]!.embedding, [5, 1, 0, 0], "a embedded with correct vector");
		assert.deepEqual(store.facts[1]!.embedding, [9, 9, 9, 9], "b untouched (already had a vector)");
		assert.deepEqual(store.facts[2]!.embedding, [5, 1, 0, 0], "c embedded with correct vector");
	});

	it("respects the per-pass limit", async () => {
		const facts = Array.from({ length: 100 }, (_, i) => ({ memoryId: `m${i}`, content: `c${i}` }));
		const n = await reembedPending(fakeStore(facts), asyncEmbedder(), { limit: 10 });
		assert.equal(n, 10);
	});

	it("no-op when nothing is pending", async () => {
		const n = await reembedPending(
			fakeStore([{ memoryId: "a", content: "x", embedding: [1, 2, 3, 4] }]),
			asyncEmbedder(),
		);
		assert.equal(n, 0);
	});

	it("best-effort: an embedder throw yields 0, never propagates", async () => {
		const thrower: Embedder = {
			id: "boom",
			dims: 4,
			embed: async () => {
				throw new Error("boom");
			},
		};
		const n = await reembedPending(fakeStore([{ memoryId: "a", content: "x" }]), thrower);
		assert.equal(n, 0);
	});
});

describe("FactStore — async (learned) embedder integration", () => {
	let dir: string;
	let prev: Embedder;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-reembed-"));
		prev = getDefaultEmbedder();
	});
	afterEach(() => {
		setDefaultEmbedder(prev);
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("write SKIPS the vector under an async embedder; reembedPending fills it; recallAsync works", async () => {
		setDefaultEmbedder(asyncEmbedder());
		const store = new FactStore(dir);
		const rec = store.write({ content: "the deploy runbook", segment: "knowledge" });
		// write can't await an async embedder → no inline vector (graceful skip).
		assert.equal(store.list().find((r) => r.memoryId === rec.memoryId)?.embedding, undefined);
		// the off-hot-path re-embed pass fills it.
		const n = await reembedPending(store, getDefaultEmbedder());
		assert.equal(n, 1);
		assert.deepEqual(store.list().find((r) => r.memoryId === rec.memoryId)?.embedding, [18, 1, 0, 0], "vector filled with correct value");
		// async recall works end-to-end (awaits the learned query embed; never crashes).
		const hits = await store.recallAsync("deploy", { origin: { kind: "owner" } });
		assert.equal(hits.length, 1, "recallAsync returns exactly the one fact in the store");
		assert.equal(hits[0]!.memoryId, rec.memoryId, "recallAsync surfaces the correct fact");
	});

	it("sync recall() under an async embedder degrades to BM25 (never crashes)", async () => {
		setDefaultEmbedder(asyncEmbedder());
		const store = new FactStore(dir);
		const rec = store.write({ content: "the rollback procedure", segment: "knowledge" });
		// SYNC recall with an async embedder: the vector lane gets nothing usable, but
		// BM25-primary still finds the lexical match — graceful, no throw.
		const hits = store.recall("rollback", { origin: { kind: "owner" } });
		assert.equal(hits.length, 1, "BM25-primary returns exactly the one fact in the store");
		assert.equal(hits[0]!.memoryId, rec.memoryId, "BM25-primary surfaces the correct fact");
	});
});
