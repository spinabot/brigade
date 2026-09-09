import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { MemoryRecord } from "../store/records.js";
import { contextualEmbedText, identityReranker, rerank, setReranker, type RerankHit } from "./rerank.js";

/** Rerank seam (step 16) — opt-in, off-hot-path; default = identity. */

function hit(id: string, score: number): RerankHit {
	return { memoryId: id, content: id, segment: "knowledge", tier: "long", importance: 0.5, decayRate: 0.03, accessCount: 0, lastAccessedAt: 0, createdAt: 0, lifecycle: "active", score } as MemoryRecord & { score: number };
}

describe("rerank seam", () => {
	afterEach(() => setReranker(identityReranker)); // reset the process default

	it("default is identity — recall order unchanged (model-free)", async () => {
		const cands = [hit("a", 3), hit("b", 2), hit("c", 1)];
		const out = await rerank("q", cands);
		assert.deepEqual(out.map((h) => h.memoryId), ["a", "b", "c"]);
	});

	it("identity preserves INPUT order — not a score re-sort", async () => {
		// input order (a,b,c) differs from a score-descending sort (b,c,a)
		const out = await rerank("q", [hit("a", 1), hit("b", 3), hit("c", 2)]);
		assert.deepEqual(out.map((h) => h.memoryId), ["a", "b", "c"]);
	});

	it("a plugged reranker reorders the top-k", async () => {
		setReranker((_q, c) => [...c].reverse());
		const out = await rerank("q", [hit("a", 3), hit("b", 2), hit("c", 1)]);
		assert.deepEqual(out.map((h) => h.memoryId), ["c", "b", "a"]);
	});

	it("a plugged ASYNC reranker reorders the top-k (await path)", async () => {
		setReranker(async (_q, c) => [...c].reverse());
		const out = await rerank("q", [hit("a", 3), hit("b", 2), hit("c", 1)]);
		assert.deepEqual(out.map((h) => h.memoryId), ["c", "b", "a"]);
	});

	it("an async-REJECTING reranker falls back to the original order (await/catch)", async () => {
		setReranker(async () => {
			throw new Error("model timed out");
		});
		const out = await rerank("q", [hit("a", 1), hit("b", 2)]);
		assert.deepEqual(out.map((h) => h.memoryId), ["a", "b"]);
	});

	it("is best-effort — a reranker error falls back to the original order", async () => {
		const out = await rerank("q", [hit("a", 1), hit("b", 2)], () => {
			throw new Error("model down");
		});
		assert.deepEqual(out.map((h) => h.memoryId), ["a", "b"]);
	});

	it("a throwing PROCESS-DEFAULT reranker falls back (no 3rd arg, default error path)", async () => {
		setReranker(() => {
			throw new Error("model down");
		});
		const out = await rerank("q", [hit("a", 1), hit("b", 2)]);
		assert.deepEqual(out.map((h) => h.memoryId), ["a", "b"]);
	});

	it("contextualEmbedText prepends the segment (contextual retrieval)", () => {
		assert.equal(contextualEmbedText({ segment: "identity", content: "I live in X" }), "[identity] I live in X");
	});
});
