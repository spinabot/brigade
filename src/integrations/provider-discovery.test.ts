import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	describeModelProbe,
	discoverCloudModelMeta,
	fetchOpenAICompatibleModelIds,
	probeModelReachable,
} from "./provider-discovery.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetch(payload: unknown, ok = true): void {
	globalThis.fetch = (async () =>
		({
			ok,
			json: async () => payload,
		}) as unknown as Response) as typeof fetch;
}

describe("discoverCloudModelMeta — OpenRouter parsing", () => {
	it("extracts context window, vision, and reasoning from /api/v1/models", async () => {
		mockFetch({
			data: [
				{
					id: "vendor/cool-model",
					context_length: 256000,
					architecture: { input_modalities: ["text", "image"] },
					supported_parameters: ["reasoning", "tools"],
				},
			],
		});
		const res = await discoverCloudModelMeta("openrouter", "vendor/cool-model");
		assert.equal(res.exists, true);
		assert.equal(res.meta.contextWindow, 256000);
		assert.equal(res.meta.vision, true);
		assert.equal(res.meta.reasoning, true);
	});

	it("returns exists:false when the id is absent from the list", async () => {
		mockFetch({ data: [{ id: "vendor/other" }] });
		const res = await discoverCloudModelMeta("openrouter", "vendor/missing");
		assert.equal(res.exists, false);
		assert.deepEqual(res.meta, {});
	});

	it("never throws on a network/parse failure (returns empty)", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const res = await discoverCloudModelMeta("openrouter", "vendor/x");
		assert.deepEqual(res, { exists: false, meta: {} });
	});
});

describe("discoverCloudModelMeta — generic OpenAI-compatible", () => {
	it("reads context_window (Groq-style) from <baseUrl>/models", async () => {
		mockFetch({ data: [{ id: "llama-3.3-70b", context_window: 131072 }] });
		const res = await discoverCloudModelMeta("groq", "llama-3.3-70b", {
			baseUrl: "https://api.groq.com/openai/v1",
			apiKey: "k",
		});
		assert.equal(res.exists, true);
		assert.equal(res.meta.contextWindow, 131072);
	});

	it("returns empty for a non-openrouter provider with no baseUrl (no fetch)", async () => {
		// No baseUrl → no endpoint to hit → empty, without touching the network.
		mockFetch({ data: [{ id: "should-not-be-read" }] });
		const res = await discoverCloudModelMeta("groq", "anything");
		assert.deepEqual(res, { exists: false, meta: {} });
	});
});

describe("fetchOpenAICompatibleModelIds — live model discovery (NVIDIA NIM etc.)", () => {
	it("returns chat model ids from /models, filtering out embedding/reranking", async () => {
		mockFetch({
			data: [
				{ id: "meta/llama-3.3-70b-instruct" },
				{ id: "deepseek-ai/deepseek-r1" },
				{ id: "nvidia/nv-embedqa-e5-v5" }, // embedding — excluded
				{ id: "nvidia/llama-3.2-nv-rerankqa-1b-v2" }, // reranking — excluded
				{ id: "qwen/qwen2.5-coder-32b-instruct" },
			],
		});
		const ids = await fetchOpenAICompatibleModelIds("https://integrate.api.nvidia.com/v1", "nvapi-xxx");
		assert.deepEqual(ids, [
			"meta/llama-3.3-70b-instruct",
			"deepseek-ai/deepseek-r1",
			"qwen/qwen2.5-coder-32b-instruct",
		]);
	});

	it("returns null on a failed request (bad key / unreachable) — never throws", async () => {
		mockFetch({ error: "unauthorized" }, false);
		assert.equal(await fetchOpenAICompatibleModelIds("https://integrate.api.nvidia.com/v1", "bad"), null);
	});

	it("returns null when the endpoint yields no usable ids", async () => {
		mockFetch({ data: [] });
		assert.equal(await fetchOpenAICompatibleModelIds("https://integrate.api.nvidia.com/v1", "nvapi-xxx"), null);
	});
});

describe("probeModelReachable — does a listed model actually respond", () => {
	it("ok when the completion returns 200", async () => {
		globalThis.fetch = (async () => ({ ok: true, status: 200 }) as unknown as Response) as typeof fetch;
		assert.deepEqual(await probeModelReachable("https://x/v1", "k", "m"), { ok: true });
	});

	it("auth when the completion is 401", async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 401 }) as unknown as Response) as typeof fetch;
		assert.deepEqual(await probeModelReachable("https://x/v1", "k", "m"), { ok: false, reason: "auth" });
	});

	it("model_unavailable on a 404", async () => {
		globalThis.fetch = (async () =>
			({ ok: false, status: 404, text: async () => "" }) as unknown as Response) as typeof fetch;
		const r = await probeModelReachable("https://x/v1", "k", "m");
		assert.equal(r.ok, false);
		assert.equal((r as { reason?: string }).reason, "model_unavailable");
	});

	it("model_unavailable when the completion hangs but /models is reachable (the NVIDIA case)", async () => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			if (String(url).includes("/chat/completions")) throw new Error("timed out");
			return { ok: true, status: 200 } as unknown as Response; // /models is up
		}) as typeof fetch;
		assert.deepEqual(await probeModelReachable("https://x/v1", "k", "m"), {
			ok: false,
			reason: "model_unavailable",
			detail: "no response",
		});
	});

	it("provider_unreachable when both the completion AND /models fail", async () => {
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		assert.deepEqual(await probeModelReachable("https://x/v1", "k", "m"), {
			ok: false,
			reason: "provider_unreachable",
		});
	});
});

describe("describeModelProbe — actionable, jargon-free copy", () => {
	it("returns null for a healthy model (no message)", () => {
		assert.equal(describeModelProbe({ ok: true }, "NVIDIA NIM", "m"), null);
	});

	it("guides to /model for a dead model", () => {
		const msg = describeModelProbe(
			{ ok: false, reason: "model_unavailable" },
			"NVIDIA NIM",
			"deepseek-ai/deepseek-v4-pro",
		);
		assert.match(msg!, /isn't responding/);
		assert.match(msg!, /\/model/);
		assert.match(msg!, /deepseek-v4-pro/);
	});

	it("distinguishes an unreachable provider from a dead model", () => {
		assert.match(describeModelProbe({ ok: false, reason: "provider_unreachable" }, "NVIDIA NIM", "m")!, /reach/i);
	});
});
