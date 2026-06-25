/**
 * Tests for the media-understanding entry point + provider selection.
 *
 * Selection is pure (no HTTP). The `runMediaUnderstanding` routing is verified
 * with a stub `fetchImpl` so the right adapter is chosen and called; no real
 * network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	resolveMediaUnderstandingProvider,
	runMediaUnderstanding,
	isRetryableError,
	MediaUnderstandingProviderError,
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingModel,
	type MediaUnderstandingProviderId,
} from "./index.js";

/** Build a config whose key set is exactly `keyed`. */
function cfgWithKeys(
	keyed: MediaUnderstandingProviderId[],
	extra?: Partial<MediaUnderstandingConfig>,
): MediaUnderstandingConfig {
	return {
		resolveKey: (p) => (keyed.includes(p as MediaUnderstandingProviderId) ? `key-${p}` : ""),
		...extra,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("resolveMediaUnderstandingProvider — selection", () => {
	it("video → google when keyed; undefined when not", () => {
		assert.equal(resolveMediaUnderstandingProvider("video", cfgWithKeys(["google"])), "google");
		assert.equal(resolveMediaUnderstandingProvider("video", cfgWithKeys(["anthropic"])), undefined);
		assert.equal(resolveMediaUnderstandingProvider("video", cfgWithKeys([])), undefined);
	});

	it("pdf → prefers anthropic, falls back to google", () => {
		assert.equal(
			resolveMediaUnderstandingProvider("pdf", cfgWithKeys(["anthropic", "google"])),
			"anthropic",
		);
		assert.equal(resolveMediaUnderstandingProvider("pdf", cfgWithKeys(["google"])), "google");
		assert.equal(resolveMediaUnderstandingProvider("pdf", cfgWithKeys([])), undefined);
	});

	it("image → prefers anthropic, falls back to google", () => {
		assert.equal(resolveMediaUnderstandingProvider("image", cfgWithKeys(["anthropic", "google"])), "anthropic");
		assert.equal(resolveMediaUnderstandingProvider("image", cfgWithKeys(["google"])), "google");
	});

	it("honors a config preferredProvider when it is capable AND keyed", () => {
		// pdf would default to anthropic, but pin google and key only google.
		const cfg = cfgWithKeys(["google"], { preferredProvider: { pdf: "google" } });
		assert.equal(resolveMediaUnderstandingProvider("pdf", cfg), "google");
	});

	it("ignores a preferredProvider that has no key (falls back to a keyed one)", () => {
		// Pin anthropic for pdf but only google is keyed → google wins.
		const cfg = cfgWithKeys(["google"], { preferredProvider: { pdf: "anthropic" } });
		assert.equal(resolveMediaUnderstandingProvider("pdf", cfg), "google");
	});

	it("ignores a preferredProvider that is not capable for the kind", () => {
		// anthropic can't do video; pin it and key both → still google.
		const cfg = cfgWithKeys(["google", "anthropic"], { preferredProvider: { video: "anthropic" } });
		assert.equal(resolveMediaUnderstandingProvider("video", cfg), "google");
	});
});

describe("runMediaUnderstanding — routing", () => {
	it("routes video to the Gemini adapter (inline-free Files API path)", async () => {
		const urls: string[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			urls.push(url);
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.includes("/upload/v1beta/files") && method === "POST") {
				return new Response("{}", {
					status: 200,
					headers: { "x-goog-upload-url": "https://up.example/s" },
				});
			}
			if (url === "https://up.example/s") {
				return jsonResponse({ file: { uri: "files/uri", name: "files/uri", state: "ACTIVE", mimeType: "video/mp4" } });
			}
			if (/:generateContent/.test(url)) {
				return jsonResponse({ candidates: [{ content: { parts: [{ text: "video summary" }] } }] });
			}
			throw new Error(`unexpected ${url}`);
		}) as typeof fetch;

		const res = await runMediaUnderstanding({
			kind: "video",
			bytes: Buffer.from("V"),
			mimeType: "video/mp4",
			cfg: cfgWithKeys(["google"]),
			fetchImpl,
		});
		assert.equal(res.provider, "google");
		assert.equal(res.text, "video summary");
		assert.ok(urls.some((u) => u.includes("/upload/v1beta/files")), "used the Files API");
	});

	it("routes pdf to the Anthropic adapter when anthropic is keyed", async () => {
		let hitAnthropic = false;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("api.anthropic.com")) hitAnthropic = true;
			return jsonResponse({ content: [{ type: "text", text: "pdf summary" }] });
		}) as typeof fetch;

		const res = await runMediaUnderstanding({
			kind: "pdf",
			bytes: Buffer.from("P"),
			mimeType: "application/pdf",
			cfg: cfgWithKeys(["anthropic"]),
			fetchImpl,
		});
		assert.equal(res.provider, "anthropic");
		assert.equal(res.text, "pdf summary");
		assert.ok(hitAnthropic, "called the Anthropic API");
	});

	it("throws MediaUnderstandingUnavailableError when no provider has a key", async () => {
		await assert.rejects(
			() =>
				runMediaUnderstanding({
					kind: "video",
					bytes: Buffer.from("V"),
					mimeType: "video/mp4",
					cfg: cfgWithKeys([]),
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingUnavailableError && /Gemini API key/i.test(err.message),
		);
	});

	it("honors an explicit provider override (and validates capability + key)", async () => {
		// Force anthropic for an image even though google is also keyed.
		let hitAnthropic = false;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("api.anthropic.com")) hitAnthropic = true;
			return jsonResponse({ content: [{ type: "text", text: "img" }] });
		}) as typeof fetch;
		const res = await runMediaUnderstanding({
			kind: "image",
			bytes: Buffer.from([1]),
			mimeType: "image/png",
			provider: "anthropic",
			cfg: cfgWithKeys(["anthropic", "google"]),
			fetchImpl,
		});
		assert.equal(res.provider, "anthropic");
		assert.ok(hitAnthropic);
	});

	it("rejects an explicit provider that cannot handle the kind (anthropic+video)", async () => {
		await assert.rejects(
			() =>
				runMediaUnderstanding({
					kind: "video",
					bytes: Buffer.from("V"),
					mimeType: "video/mp4",
					provider: "anthropic",
					cfg: cfgWithKeys(["anthropic", "google"]),
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingUnavailableError && /cannot handle video/i.test(err.message),
		);
	});

	it("rejects an explicit provider with no configured key", async () => {
		await assert.rejects(
			() =>
				runMediaUnderstanding({
					kind: "pdf",
					bytes: Buffer.from("P"),
					mimeType: "application/pdf",
					provider: "anthropic",
					cfg: cfgWithKeys(["google"]), // anthropic NOT keyed
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingUnavailableError && /no configured api key/i.test(err.message),
		);
	});

	it("routes IMAGE through the Pi path when only a non-google/anthropic provider is keyed", async () => {
		// Operator has ONLY an OpenAI-style key (no google/anthropic). The Pi path
		// must engage and understand the image — proving multi-provider coverage.
		const piModel: MediaUnderstandingModel = {
			provider: "openai",
			id: "gpt-4o",
			input: ["text", "image"],
		};
		let sawKey = "";
		const cfg: MediaUnderstandingConfig = {
			resolveKey: (p) => (p === "openai" ? "sk-openai" : ""),
			resolveModel: (provider) => (provider === "openai" ? piModel : undefined),
			listKeyedProviders: () => ["openai"],
			piComplete: async (req) => {
				sawKey = req.apiKey;
				return "An OpenAI vision description of the image.";
			},
		};
		// Selection resolves to the virtual `pi` provider.
		assert.equal(resolveMediaUnderstandingProvider("image", cfg), "pi");
		const res = await runMediaUnderstanding({
			kind: "image",
			bytes: Buffer.from([1, 2, 3]),
			mimeType: "image/png",
			prompt: "describe",
			cfg,
		});
		assert.equal(res.provider, "pi");
		assert.equal(res.model, "openai/gpt-4o");
		assert.match(res.text, /OpenAI vision description/);
		assert.equal(sawKey, "sk-openai");
	});

	it("prefers the bespoke anthropic REST adapter over the Pi path when anthropic is keyed", async () => {
		// Even with a Pi path wired, image selection prefers anthropic (proven REST
		// adapter) — the Pi path is the catch-all for OTHER providers.
		let hitAnthropic = false;
		let piCalled = false;
		const cfg: MediaUnderstandingConfig = {
			resolveKey: (p) => (p === "anthropic" ? "sk-ant" : p === "openai" ? "sk-openai" : ""),
			resolveModel: (provider) =>
				provider === "openai" ? { provider, id: "gpt-4o", input: ["text", "image"] } : undefined,
			listKeyedProviders: () => ["openai"],
			piComplete: async () => {
				piCalled = true;
				return "should not be used";
			},
		};
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("api.anthropic.com")) hitAnthropic = true;
			return jsonResponse({ content: [{ type: "text", text: "anthropic image text" }] });
		}) as typeof fetch;
		assert.equal(resolveMediaUnderstandingProvider("image", cfg), "anthropic");
		const res = await runMediaUnderstanding({
			kind: "image",
			bytes: Buffer.from([1]),
			mimeType: "image/png",
			cfg,
			fetchImpl,
		});
		assert.equal(res.provider, "anthropic");
		assert.ok(hitAnthropic, "used the Anthropic REST adapter");
		assert.equal(piCalled, false, "Pi path not used when anthropic is keyed");
	});

	it("AUDIO does NOT fall back to the Pi path (Pi has no audio block) — stays unavailable", async () => {
		// Operator has ONLY an OpenAI-style key (no google). Pi carries text+image
		// only, so there is no provider Pi can drive that ingests audio — routing a
		// voice note through it would pack audio into an IMAGE block and 400. So
		// selection must report `undefined` (unavailable), NOT "pi". This is the
		// audio-via-Pi false-path fix: a clean unavailable instead of a 400.
		const cfg: MediaUnderstandingConfig = {
			resolveKey: (p) => (p === "openai" ? "sk-openai" : ""),
			resolveModel: (provider) =>
				provider === "openai" ? { provider, id: "gpt-4o-audio", input: ["text", "image"] } : undefined,
			listKeyedProviders: () => ["openai"],
			piComplete: async () => "should never be called for audio",
		};
		assert.equal(resolveMediaUnderstandingProvider("audio", cfg), undefined);
		await assert.rejects(
			() =>
				runMediaUnderstanding({
					kind: "audio",
					bytes: Buffer.from([1, 2]),
					mimeType: "audio/ogg",
					cfg,
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingUnavailableError && /Gemini API key/i.test(err.message),
		);
	});

	it("routes AUDIO to Gemini when a Google key is configured", async () => {
		const fetchImpl = (async (input: string | URL | Request) => {
			assert.ok(String(input).includes("generativelanguage.googleapis.com"), "uses Gemini");
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "Transcript: hello world." }] } }] });
		}) as typeof fetch;
		assert.equal(resolveMediaUnderstandingProvider("audio", cfgWithKeys(["google"])), "google");
		const res = await runMediaUnderstanding({
			kind: "audio",
			bytes: Buffer.from([1, 2]),
			mimeType: "audio/ogg",
			cfg: cfgWithKeys(["google"]),
			fetchImpl,
		});
		assert.equal(res.provider, "google");
		assert.match(res.text, /Transcript: hello world/);
	});

	it("VIDEO does not fall back to the Pi path (no video block) — stays unavailable", () => {
		// Only an OpenAI key + Pi path wired; video must still report unavailable
		// because Pi has no video content block.
		const cfg: MediaUnderstandingConfig = {
			resolveKey: (p) => (p === "openai" ? "sk-openai" : ""),
			resolveModel: (provider) =>
				provider === "openai" ? { provider, id: "gpt-4o", input: ["text", "image"] } : undefined,
			listKeyedProviders: () => ["openai"],
		};
		assert.equal(resolveMediaUnderstandingProvider("video", cfg), undefined);
	});

	it("retries the SAME provider on a 503, then succeeds (bounded retry)", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) return jsonResponse({ error: { message: "overloaded" } }, 503);
			return jsonResponse({ content: [{ type: "text", text: "pdf ok after retry" }] });
		}) as typeof fetch;
		const res = await runMediaUnderstanding({
			kind: "pdf",
			bytes: Buffer.from("P"),
			mimeType: "application/pdf",
			cfg: cfgWithKeys(["anthropic"]),
			fetchImpl,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		assert.equal(res.text, "pdf ok after retry");
		assert.equal(calls, 2, "retried once");
		assert.deepEqual(sleeps, [250], "one backoff sleep before the retry");
	});

	it("falls over to the NEXT provider when the first keeps failing (image: anthropic → google)", async () => {
		const hosts: string[] = [];
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("api.anthropic.com")) {
				hosts.push("anthropic");
				return jsonResponse({ error: { message: "rate limited" } }, 429);
			}
			// Gemini inline image path.
			hosts.push("google");
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "google image text" }] } }] });
		}) as typeof fetch;
		const res = await runMediaUnderstanding({
			kind: "image",
			bytes: Buffer.from([1]),
			mimeType: "image/png",
			cfg: cfgWithKeys(["anthropic", "google"]),
			fetchImpl,
			maxRetries: 0, // no per-provider retry → fall straight over to google
			sleepFn: async () => {},
		});
		assert.equal(res.provider, "google");
		assert.match(res.text, /google image text/);
		assert.ok(hosts.includes("anthropic") && hosts.includes("google"), "tried anthropic then google");
	});

	it("does NOT fall over across providers for an explicit override (honours the pick)", async () => {
		let anthropicCalls = 0;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("api.anthropic.com")) {
				anthropicCalls += 1;
				return jsonResponse({ error: { message: "boom" } }, 500);
			}
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "should not happen" }] } }] });
		}) as typeof fetch;
		await assert.rejects(
			() =>
				runMediaUnderstanding({
					kind: "image",
					bytes: Buffer.from([1]),
					mimeType: "image/png",
					provider: "anthropic", // explicit → no google fallover
					cfg: cfgWithKeys(["anthropic", "google"]),
					fetchImpl,
					maxRetries: 1,
					sleepFn: async () => {},
				}),
			(err: unknown) => err instanceof MediaUnderstandingProviderError,
		);
		// 1 initial + 1 retry on the SAME provider, never google.
		assert.equal(anthropicCalls, 2);
	});

	it("does NOT retry a non-retryable 400 (bad request)", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return jsonResponse({ error: { message: "bad pdf" } }, 400);
		}) as typeof fetch;
		await assert.rejects(
			() =>
				runMediaUnderstanding({
					kind: "pdf",
					bytes: Buffer.from("P"),
					mimeType: "application/pdf",
					cfg: cfgWithKeys(["anthropic"]),
					fetchImpl,
					sleepFn: async () => {},
				}),
			(err: unknown) => err instanceof MediaUnderstandingProviderError && err.status === 400,
		);
		assert.equal(calls, 1, "400 is terminal — no retry");
	});

	it("isRetryableError classifies 429/5xx/transport as retryable, 4xx as not", () => {
		assert.equal(isRetryableError(new MediaUnderstandingProviderError("google", "x", 429)), true);
		assert.equal(isRetryableError(new MediaUnderstandingProviderError("google", "x", 503)), true);
		assert.equal(isRetryableError(new MediaUnderstandingProviderError("google", "x")), true); // transport
		assert.equal(isRetryableError(new MediaUnderstandingProviderError("google", "x", 400)), false);
		assert.equal(isRetryableError(new MediaUnderstandingProviderError("google", "x", 401)), false);
		assert.equal(isRetryableError(new MediaUnderstandingUnavailableError("image", "x")), true);
		assert.equal(isRetryableError(new Error("random")), false);
	});

	it("passes a model + prompt override through to the adapter", async () => {
		let capturedUrl = "";
		let capturedBody: { contents?: Array<{ parts?: Array<{ text?: string }> }> } = {};
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedBody = init?.body ? JSON.parse(init.body as string) : {};
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
		}) as typeof fetch;
		await runMediaUnderstanding({
			kind: "image",
			bytes: Buffer.from([1]),
			mimeType: "image/png",
			provider: "google",
			model: "gemini-3-flash-preview",
			prompt: "describe precisely",
			cfg: cfgWithKeys(["google"]),
			fetchImpl,
		});
		assert.match(capturedUrl, /models\/gemini-3-flash-preview:generateContent/);
		assert.equal(capturedBody.contents?.[0]?.parts?.[0]?.text, "describe precisely");
	});
});
