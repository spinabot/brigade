/**
 * Tests for the Gemini media-understanding adapter.
 *
 * ALL provider HTTP is mocked — zero real network. The Files API video path
 * (resumable upload → poll until ACTIVE → generateContent with a file_data
 * part) and the inline image/pdf path are exercised against a stub `fetchFn`
 * that records every request and returns canned responses.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runGemini } from "./gemini-adapter.js";
import { MediaUnderstandingProviderError } from "./types.js";

/* ─────────────────────────── fetch stub helpers ─────────────────────────── */

interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | Uint8Array;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Normalize headers init into a lowercased plain record. */
function headersToRecord(init: RequestInit["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!init) return out;
	const h = new Headers(init);
	h.forEach((v, k) => {
		out[k.toLowerCase()] = v;
	});
	return out;
}

/** No-op sleep so the poll loop doesn't actually wait. */
const fastSleep = async (): Promise<void> => {};

/* ─────────────────────────── inline path (image / pdf) ─────────────────────────── */

describe("gemini-adapter — inline (image / pdf)", () => {
	it("posts an inline_data part + prompt and returns the model text", async () => {
		const requests: RecordedRequest[] = [];
		const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input),
				method: init?.method ?? "GET",
				headers: headersToRecord(init?.headers),
				...(init?.body ? { body: init.body as string } : {}),
			});
			return jsonResponse({
				candidates: [{ content: { parts: [{ text: "A red square." }] } }],
			});
		}) as typeof fetch;

		const res = await runGemini({
			kind: "image",
			bytes: Buffer.from([1, 2, 3, 4]),
			mimeType: "image/png",
			apiKey: "test-key",
			prompt: "what color?",
			fetchFn,
		});

		assert.equal(res.text, "A red square.");
		assert.equal(res.provider, "google");
		assert.equal(res.model, "gemini-2.5-flash"); // default image model
		assert.equal(requests.length, 1);
		const req = requests[0]!;
		assert.match(req.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent/);
		assert.match(req.url, /[?&]key=test-key/);
		assert.equal(req.method, "POST");
		const parsed = JSON.parse(req.body as string);
		assert.equal(parsed.contents[0].parts[0].text, "what color?");
		assert.equal(parsed.contents[0].parts[1].inline_data.mime_type, "image/png");
		assert.equal(parsed.contents[0].parts[1].inline_data.data, Buffer.from([1, 2, 3, 4]).toString("base64"));
	});

	it("uses a pdf default prompt + model override for pdf inline", async () => {
		let captured = "";
		const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
			captured = String(input);
			void init;
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "Doc summary." }] } }] });
		}) as typeof fetch;

		const res = await runGemini({
			kind: "pdf",
			bytes: Buffer.from("PDFBYTES"),
			mimeType: "application/pdf",
			apiKey: "k",
			model: "models/gemini-2.5-pro", // leading models/ should be normalized away
			fetchFn,
		});
		assert.equal(res.text, "Doc summary.");
		assert.equal(res.model, "gemini-2.5-pro");
		assert.match(captured, /models\/gemini-2\.5-pro:generateContent/);
	});

	it("omits generationConfig when no maxTokens, and sets maxOutputTokens when given", async () => {
		// No maxTokens → no generationConfig in the body.
		let body1: { generationConfig?: { maxOutputTokens?: number } } = {};
		const f1 = (async (_i: string | URL | Request, init?: RequestInit) => {
			body1 = JSON.parse((init?.body as string) ?? "{}");
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
		}) as typeof fetch;
		await runGemini({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", apiKey: "k", fetchFn: f1 });
		assert.equal(body1.generationConfig, undefined, "no generationConfig without maxTokens");

		// With maxTokens → maxOutputTokens present and clamped.
		let body2: { generationConfig?: { maxOutputTokens?: number } } = {};
		const f2 = (async (_i: string | URL | Request, init?: RequestInit) => {
			body2 = JSON.parse((init?.body as string) ?? "{}");
			return jsonResponse({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
		}) as typeof fetch;
		await runGemini({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", apiKey: "k", maxTokens: 2000, fetchFn: f2 });
		assert.equal(body2.generationConfig?.maxOutputTokens, 2000);
	});

	it("throws a provider error on a non-2xx response (with the API message)", async () => {
		const fetchFn = (async () =>
			jsonResponse({ error: { message: "bad key" } }, 401)) as typeof fetch;
		await assert.rejects(
			() =>
				runGemini({
					kind: "image",
					bytes: Buffer.from([1]),
					mimeType: "image/png",
					apiKey: "k",
					fetchFn,
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingProviderError &&
				err.status === 401 &&
				/bad key/.test(err.message),
		);
	});

	it("throws when the response carries no text", async () => {
		const fetchFn = (async () => jsonResponse({ candidates: [] })) as typeof fetch;
		await assert.rejects(
			() =>
				runGemini({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", apiKey: "k", fetchFn }),
			/no text/i,
		);
	});

	it("rejects with a clear error when no API key is supplied", async () => {
		await assert.rejects(
			() => runGemini({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", apiKey: "" }),
			/no google\/gemini api key/i,
		);
	});
});

/* ─────────────────────────── Files API path (video) ─────────────────────────── */

describe("gemini-adapter — video via the Files API", () => {
	/**
	 * Build a fetch stub that walks the full Files API dance:
	 *   1. POST <base>/upload/v1beta/files (start) → 200 + x-goog-upload-url header
	 *   2. POST <session-url> (upload, finalize) → 200 + { file: { state: "PROCESSING" } }
	 *   3. GET <base>/files/<id> (poll) → 200 + { state: "ACTIVE", uri }
	 *   4. POST <base>/models/<m>:generateContent → 200 + candidates text
	 */
	function buildVideoFetch(opts?: {
		initialState?: string;
		pollStates?: string[];
		uploadStatus?: number;
	}) {
		const requests: RecordedRequest[] = [];
		const pollStates = [...(opts?.pollStates ?? ["ACTIVE"])];
		const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			requests.push({
				url,
				method,
				headers: headersToRecord(init?.headers),
				...(init?.body ? { body: init.body as string | Uint8Array } : {}),
			});
			// Step 1 — start resumable upload.
			if (url.includes("/upload/v1beta/files") && method === "POST") {
				if (opts?.uploadStatus && opts.uploadStatus >= 400) {
					return jsonResponse({ error: { message: "upload denied" } }, opts.uploadStatus);
				}
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-goog-upload-url": "https://upload.example/session/abc",
					},
				});
			}
			// Step 2 — finalize upload to the session URL.
			if (url === "https://upload.example/session/abc") {
				return jsonResponse({
					file: {
						uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz",
						name: "files/xyz",
						state: opts?.initialState ?? "PROCESSING",
						mimeType: "video/mp4",
					},
				});
			}
			// Step 3 — poll file status.
			if (/\/v1beta\/files\/xyz/.test(url) && method === "GET") {
				const state = pollStates.shift() ?? "ACTIVE";
				return jsonResponse({
					state,
					uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz",
					mimeType: "video/mp4",
				});
			}
			// Step 4 — generateContent.
			if (/:generateContent/.test(url) && method === "POST") {
				return jsonResponse({
					candidates: [{ content: { parts: [{ text: "A cat plays piano." }] } }],
				});
			}
			throw new Error(`unexpected request: ${method} ${url}`);
		}) as typeof fetch;
		return { fetchFn, requests };
	}

	it("uploads → polls until ACTIVE → generates from the file_data uri", async () => {
		const { fetchFn, requests } = buildVideoFetch({
			initialState: "PROCESSING",
			pollStates: ["PROCESSING", "ACTIVE"],
		});

		const res = await runGemini({
			kind: "video",
			bytes: Buffer.from("FAKEVIDEOBYTES"),
			mimeType: "video/mp4",
			apiKey: "vkey",
			prompt: "what happens?",
			fetchFn,
			sleepFn: fastSleep,
		});

		assert.equal(res.text, "A cat plays piano.");
		assert.equal(res.provider, "google");
		assert.equal(res.model, "gemini-2.5-pro"); // default video model

		// Verify the request sequence: start, finalize, ≥1 poll, generate.
		const start = requests.find((r) => r.url.includes("/upload/v1beta/files"));
		assert.ok(start, "start upload request present");
		assert.equal(start!.headers["x-goog-upload-protocol"], "resumable");
		assert.equal(start!.headers["x-goog-upload-command"], "start");
		assert.equal(start!.headers["x-goog-upload-header-content-type"], "video/mp4");

		const finalize = requests.find((r) => r.url === "https://upload.example/session/abc");
		assert.ok(finalize, "finalize upload request present");
		assert.equal(finalize!.headers["x-goog-upload-command"], "upload, finalize");

		const polls = requests.filter((r) => /\/v1beta\/files\/xyz/.test(r.url) && r.method === "GET");
		assert.ok(polls.length >= 2, "polled until ACTIVE");

		const generate = requests.find((r) => /:generateContent/.test(r.url));
		assert.ok(generate, "generate request present");
		const body = JSON.parse(generate!.body as string);
		assert.equal(body.contents[0].parts[0].text, "what happens?");
		assert.equal(
			body.contents[0].parts[1].file_data.file_uri,
			"https://generativelanguage.googleapis.com/v1beta/files/xyz",
		);
		assert.equal(body.contents[0].parts[1].file_data.mime_type, "video/mp4");
	});

	it("skips polling when the upload is ACTIVE immediately", async () => {
		const { fetchFn, requests } = buildVideoFetch({ initialState: "ACTIVE" });
		const res = await runGemini({
			kind: "video",
			bytes: Buffer.from("V"),
			mimeType: "video/mp4",
			apiKey: "k",
			fetchFn,
			sleepFn: fastSleep,
		});
		assert.equal(res.text, "A cat plays piano.");
		const polls = requests.filter((r) => /\/v1beta\/files\/xyz/.test(r.url) && r.method === "GET");
		assert.equal(polls.length, 0, "no poll needed when ACTIVE on upload");
	});

	it("fails cleanly when the file processing state goes FAILED", async () => {
		const { fetchFn } = buildVideoFetch({ initialState: "PROCESSING", pollStates: ["FAILED"] });
		await assert.rejects(
			() =>
				runGemini({
					kind: "video",
					bytes: Buffer.from("V"),
					mimeType: "video/mp4",
					apiKey: "k",
					fetchFn,
					sleepFn: fastSleep,
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingProviderError && /FAILED/.test(err.message),
		);
	});

	it("surfaces an upload (start) HTTP error", async () => {
		const { fetchFn } = buildVideoFetch({ uploadStatus: 403 });
		await assert.rejects(
			() =>
				runGemini({
					kind: "video",
					bytes: Buffer.from("V"),
					mimeType: "video/mp4",
					apiKey: "k",
					fetchFn,
					sleepFn: fastSleep,
				}),
			(err: unknown) =>
				err instanceof MediaUnderstandingProviderError &&
				err.status === 403 &&
				/upload/i.test(err.message),
		);
	});
});
