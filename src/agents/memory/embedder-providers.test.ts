import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { HrrEmbedder, type Embedder } from "./embedder.js";
import {
	__resetEmbedderRegistryForTests,
	EMBEDDER_DIMS,
	localLlamaEmbedderAdapter,
	normalizeTo,
	OpenAiEmbedder,
	openAiEmbedderAdapter,
	registerEmbedderAdapter,
	resolveEmbedder,
	type EmbedderAdapter,
} from "./embedder-providers.js";

let prevKey: string | undefined;
beforeEach(() => {
	prevKey = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY; // deterministic: no ambient key
	__resetEmbedderRegistryForTests();
});
afterEach(() => {
	if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = prevKey;
	__resetEmbedderRegistryForTests();
});

describe("normalizeTo", () => {
	it("truncates to dims (Matryoshka) and L2-normalises to unit length", () => {
		const out = normalizeTo([3, 4, 99, 99], 2); // truncate to 2 → [3,4] → /5
		assert.deepEqual(out, [0.6, 0.8]);
		let mag = 0;
		for (const x of normalizeTo([1, 1, 1, 1])) mag += x * x;
		assert.ok(Math.abs(mag - 1) < 1e-9, "unit length");
	});
	it("maps a near-zero vector to all-zeros (no NaN)", () => {
		assert.deepEqual(normalizeTo([0, 0, 0]), [0, 0, 0]);
		assert.deepEqual(normalizeTo([Number.NaN, 0]), [0, 0]);
	});
});

describe("resolveEmbedder — graceful degradation (always-fallback invariant)", () => {
	it("model-free → HRR (zero-dep, air-gap), always", async () => {
		const e = await resolveEmbedder("model-free");
		assert.ok(e instanceof HrrEmbedder);
		assert.equal(e.dims, EMBEDDER_DIMS);
	});

	it("auto with no key + no local dep → falls back to HRR (never throws)", async () => {
		// built-ins: local (node-llama-cpp not installed → null) + openai (no key → null)
		const e = await resolveEmbedder("auto");
		assert.ok(e instanceof HrrEmbedder, "degrades to the model-free floor");
		assert.equal(e.dims, EMBEDDER_DIMS);
		assert.equal(e.id, "hrr-v1:256");
	});

	it("auto picks the lowest-priority adapter that creates successfully", async () => {
		const fake: Embedder = { id: "fake", dims: EMBEDDER_DIMS, embed: () => [[1]] };
		const adapter: EmbedderAdapter = {
			id: "fake-learned",
			transport: "remote",
			autoSelectPriority: 1, // beats local(10)/openai(20)
			create: async () => fake,
		};
		registerEmbedderAdapter(adapter);
		const e = await resolveEmbedder("auto");
		assert.equal(e.id, "fake", "highest-priority (lowest number) successful adapter wins");
	});

	it("a requested adapter that yields null degrades to HRR (not a throw)", async () => {
		registerEmbedderAdapter({ id: "broken", transport: "remote", create: async () => null });
		const e = await resolveEmbedder("broken");
		assert.ok(e instanceof HrrEmbedder);
		assert.equal(e.dims, EMBEDDER_DIMS);
		assert.equal(e.id, "hrr-v1:256");
	});

	it("a create() that THROWS still degrades to HRR (never propagates)", async () => {
		registerEmbedderAdapter({
			id: "throws",
			transport: "remote",
			autoSelectPriority: 1,
			create: async () => {
				throw new Error("boom");
			},
		});
		const e = await resolveEmbedder("auto");
		assert.ok(e instanceof HrrEmbedder);
		assert.equal(e.dims, EMBEDDER_DIMS);
		assert.equal(e.id, "hrr-v1:256");
	});
});

describe("OpenAI remote adapter", () => {
	it("adapter create() returns null without a key (degrade), an embedder with one", async () => {
		assert.equal(await openAiEmbedderAdapter().create(), null);
		assert.equal(openAiEmbedderAdapter().id, "openai-256");
		process.env.OPENAI_API_KEY = "sk-test";
		const e = await openAiEmbedderAdapter().create();
		assert.ok(e instanceof OpenAiEmbedder);
		assert.equal(e?.dims, EMBEDDER_DIMS);
		assert.equal(e?.id, "openai:text-embedding-3-small:256");
	});

	it("embed() requests dims:256, preserves input order, L2-normalises each row", async () => {
		const calls: { body: string }[] = [];
		const fakeFetch = (async (_url: string, init: { body: string }) => {
			calls.push({ body: init.body });
			return {
				ok: true,
				json: async () => ({ data: [{ embedding: [3, 4] }, { embedding: [0, 0, 0] }] }),
			};
		}) as unknown as typeof fetch;
		const e = new OpenAiEmbedder("sk-test", "text-embedding-3-small", fakeFetch);
		const out = await e.embed(["a", "b"]);
		assert.equal(calls.length, 1, "two texts sent in a single batch request");
		assert.equal(out.length, 2);
		assert.deepEqual(out[0], [0.6, 0.8]); // normalised
		assert.deepEqual(out[1], [0, 0, 0]); // zero vector stays zero
		assert.match(calls[0]!.body, /"dimensions":256/);
		assert.match(calls[0]!.body, /"input":\["a","b"\]/);
	});

	it("embed() throws on a non-OK HTTP response", async () => {
		const fakeFetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
		const e = new OpenAiEmbedder("sk-test", "text-embedding-3-small", fakeFetch);
		await assert.rejects(() => e.embed(["x"]), /openai embeddings HTTP 429/);
	});
});

describe("local node-llama-cpp adapter", () => {
	it("create() degrades to null when the optional dep is not installed (no throw)", async () => {
		// node-llama-cpp is an OPTIONAL dep, absent in the test env → graceful null.
		const adapter = localLlamaEmbedderAdapter();
		const e = await adapter.create();
		assert.equal(e, null);
		assert.match(adapter.formatSetupError?.() ?? "", /node-llama-cpp/);
	});
});
