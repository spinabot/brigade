/**
 * Tests for the Anthropic media-understanding adapter.
 *
 * ALL provider HTTP is mocked. Covers the native/scanned-PDF `document` block,
 * the image block, the auth header branch (console key vs OAuth token), and
 * error/empty handling.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runAnthropic } from "./anthropic-adapter.js";
import { MediaUnderstandingProviderError } from "./types.js";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function headersToRecord(init: RequestInit["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!init) return out;
	const h = new Headers(init);
	h.forEach((v, k) => {
		out[k.toLowerCase()] = v;
	});
	return out;
}

function captureFetch(responseBody: unknown, status = 200): { fetchFn: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: headersToRecord(init?.headers),
			body: init?.body ? JSON.parse(init.body as string) : undefined,
		});
		return new Response(JSON.stringify(responseBody), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchFn, calls };
}

describe("anthropic-adapter — native / scanned PDF", () => {
	it("sends a document block (base64 application/pdf) + prompt and returns text", async () => {
		const { fetchFn, calls } = captureFetch({
			content: [{ type: "text", text: "This invoice totals $1,200." }],
		});
		const res = await runAnthropic({
			kind: "pdf",
			bytes: Buffer.from("SCANNEDPDF"),
			mimeType: "application/pdf",
			apiKey: "sk-ant-api-xyz",
			prompt: "what is the total?",
			fetchFn,
		});
		assert.equal(res.text, "This invoice totals $1,200.");
		assert.equal(res.provider, "anthropic");
		assert.equal(res.model, "claude-sonnet-4-5"); // default
		assert.equal(calls.length, 1);
		const call = calls[0]!;
		assert.match(call.url, /api\.anthropic\.com\/v1\/messages/);
		assert.equal(call.method, "POST");
		// auth header: console key → x-api-key, with version header.
		assert.equal(call.headers["x-api-key"], "sk-ant-api-xyz");
		assert.equal(call.headers["anthropic-version"], "2023-06-01");
		assert.ok(!call.headers["authorization"], "no Bearer for a console key");
		// content: document block first, then the text prompt.
		const body = call.body as {
			model: string;
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		const content = body.messages[0]!.content;
		const doc = content[0] as { type: string; source: { type: string; media_type: string; data: string } };
		assert.equal(doc.type, "document");
		assert.equal(doc.source.type, "base64");
		assert.equal(doc.source.media_type, "application/pdf");
		assert.equal(doc.source.data, Buffer.from("SCANNEDPDF").toString("base64"));
		const text = content[1] as { type: string; text: string };
		assert.equal(text.type, "text");
		assert.equal(text.text, "what is the total?");
	});

	it("uses the OAuth Bearer header branch for an sk-ant-oat token", async () => {
		const { fetchFn, calls } = captureFetch({ content: [{ type: "text", text: "ok" }] });
		await runAnthropic({
			kind: "pdf",
			bytes: Buffer.from("P"),
			mimeType: "application/pdf",
			apiKey: "sk-ant-oat-TOKEN",
			fetchFn,
		});
		const h = calls[0]!.headers;
		assert.equal(h["authorization"], "Bearer sk-ant-oat-TOKEN");
		assert.equal(h["anthropic-beta"], "oauth-2025-04-20");
		assert.ok(!h["x-api-key"], "no x-api-key for an OAuth token");
	});
});

describe("anthropic-adapter — image", () => {
	it("sends an image block with the declared media_type", async () => {
		const { fetchFn, calls } = captureFetch({ content: [{ type: "text", text: "A dog." }] });
		const res = await runAnthropic({
			kind: "image",
			bytes: Buffer.from([9, 9, 9]),
			mimeType: "image/jpeg",
			apiKey: "sk-ant-api-k",
			model: "claude-opus-4-8",
			fetchFn,
		});
		assert.equal(res.text, "A dog.");
		assert.equal(res.model, "claude-opus-4-8");
		const body = calls[0]!.body as { messages: Array<{ content: Array<Record<string, unknown>> }> };
		const img = body.messages[0]!.content[0] as { type: string; source: { media_type: string } };
		assert.equal(img.type, "image");
		assert.equal(img.source.media_type, "image/jpeg");
	});
});

describe("anthropic-adapter — maxTokens", () => {
	it("defaults max_tokens to 4096 when unset", async () => {
		const { fetchFn, calls } = captureFetch({ content: [{ type: "text", text: "x" }] });
		await runAnthropic({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", apiKey: "sk-ant-api-k", fetchFn });
		assert.equal((calls[0]!.body as { max_tokens: number }).max_tokens, 4096);
	});

	it("uses a caller maxTokens (clamped to a sane window)", async () => {
		const { fetchFn, calls } = captureFetch({ content: [{ type: "text", text: "x" }] });
		await runAnthropic({
			kind: "pdf",
			bytes: Buffer.from([1]),
			mimeType: "application/pdf",
			apiKey: "sk-ant-api-k",
			maxTokens: 1500,
			fetchFn,
		});
		assert.equal((calls[0]!.body as { max_tokens: number }).max_tokens, 1500);
		// An absurd value is clamped down to the ceiling (not passed verbatim).
		const cap = captureFetch({ content: [{ type: "text", text: "x" }] });
		await runAnthropic({
			kind: "pdf",
			bytes: Buffer.from([1]),
			mimeType: "application/pdf",
			apiKey: "sk-ant-api-k",
			maxTokens: 9_999_999,
			fetchFn: cap.fetchFn,
		});
		assert.ok((cap.calls[0]!.body as { max_tokens: number }).max_tokens <= 32_000, "clamped to ceiling");
	});
});

describe("anthropic-adapter — errors", () => {
	it("throws a provider error on non-2xx (with status + message)", async () => {
		const { fetchFn } = captureFetch({ error: { message: "overloaded" } }, 529);
		await assert.rejects(
			() =>
				runAnthropic({ kind: "pdf", bytes: Buffer.from("P"), mimeType: "application/pdf", apiKey: "k", fetchFn }),
			(err: unknown) =>
				err instanceof MediaUnderstandingProviderError &&
				err.status === 529 &&
				/overloaded/.test(err.message),
		);
	});

	it("throws when there is no text in the response", async () => {
		const { fetchFn } = captureFetch({ content: [] });
		await assert.rejects(
			() =>
				runAnthropic({ kind: "image", bytes: Buffer.from([1]), mimeType: "image/png", apiKey: "k", fetchFn }),
			/no text/i,
		);
	});

	it("rejects an unsupported kind (e.g. video)", async () => {
		await assert.rejects(
			() =>
				runAnthropic({
					// "video" is a valid MediaUnderstandingKind at the type level;
					// the adapter rejects it at runtime (image + pdf only).
					kind: "video",
					bytes: Buffer.from([1]),
					mimeType: "video/mp4",
					apiKey: "k",
				}),
			/image \+ pdf only/i,
		);
	});

	it("rejects with a clear error when no API key is supplied", async () => {
		await assert.rejects(
			() => runAnthropic({ kind: "pdf", bytes: Buffer.from("P"), mimeType: "application/pdf", apiKey: "" }),
			/no anthropic api key/i,
		);
	});
});
