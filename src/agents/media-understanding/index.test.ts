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
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingProviderId,
} from "./index.js";

/** Build a config whose key set is exactly `keyed`. */
function cfgWithKeys(
	keyed: MediaUnderstandingProviderId[],
	extra?: Partial<MediaUnderstandingConfig>,
): MediaUnderstandingConfig {
	return {
		resolveKey: (p) => (keyed.includes(p) ? `key-${p}` : ""),
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
