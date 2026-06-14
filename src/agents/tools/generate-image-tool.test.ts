/**
 * `generate_image` tool tests — fetch is injected, no network.
 *
 * The parser-breadth cases mirror the production failure (2026-06-11): a
 * billed 69-second generation was dropped because a hand-written parser
 * only knew one response shape. Every shape OpenRouter image models emit
 * must round-trip to a saved file here.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractImageUrls, makeGenerateImageTool } from "./generate-image-tool.js";

// 1×1 transparent PNG.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

let outDir: string;

beforeEach(() => {
	outDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-genimg-"));
});

afterEach(() => {
	fs.rmSync(outDir, { recursive: true, force: true });
});

function fakeFetch(bodyFor: (url: string, init?: RequestInit) => unknown): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		const body = bodyFor(String(url), init);
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

function makeTool(fetchFn: typeof fetch) {
	return makeGenerateImageTool({
		fetchFn,
		outDirOverride: outDir,
		resolveApiKey: () => "test-key",
	});
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

describe("generate_image — response-shape breadth", () => {
	it("canonical shape: message.images[] with data URL → file saved + MEDIA path", async () => {
		const tool = makeTool(
			fakeFetch(() => ({
				choices: [
					{
						message: {
							content: "Here is your image",
							images: [{ type: "image_url", image_url: { url: DATA_URL } }],
						},
					},
				],
			})),
		);
		const res = await tool.execute("t1", { prompt: "a lion" });
		const text = textOf(res);
		assert.match(text, /Generated 1 image with openrouter\//);
		assert.match(text, /MEDIA:.+\.png/);
		assert.match(text, /send_media/);
		const savedPath = res.details?.paths?.[0];
		assert.ok(savedPath && fs.existsSync(savedPath), "image file should exist");
		assert.ok(fs.statSync(savedPath).size > 0);
	});

	it("content-array shape: image_url part inside content[]", async () => {
		const tool = makeTool(
			fakeFetch(() => ({
				choices: [
					{
						message: {
							content: [
								{ type: "text", text: "done" },
								{ type: "image_url", image_url: { url: DATA_URL } },
							],
						},
					},
				],
			})),
		);
		const res = await tool.execute("t2", { prompt: "a lion" });
		assert.equal(res.details?.ok, true);
		assert.equal(res.details?.paths?.length, 1);
	});

	it("b64_json part shape decodes too", async () => {
		const tool = makeTool(
			fakeFetch(() => ({
				choices: [{ message: { content: [{ b64_json: PNG_B64 }] } }],
			})),
		);
		const res = await tool.execute("t3", { prompt: "a lion" });
		assert.equal(res.details?.ok, true);
	});

	it("no images in response → honest failure, no retry-bait", async () => {
		const tool = makeTool(
			fakeFetch(() => ({ choices: [{ message: { content: "I cannot do that" } }] })),
		);
		const res = await tool.execute("t4", { prompt: "a lion" });
		const parsed = JSON.parse(textOf(res)) as { ok: boolean; message: string };
		assert.equal(parsed.ok, false);
		assert.match(parsed.message, /returned no images/);
	});
});

describe("generate_image — guard rails", () => {
	it("missing key → actionable message, no network call", async () => {
		let called = false;
		const tool = makeGenerateImageTool({
			fetchFn: (async () => {
				called = true;
				return new Response("{}");
			}) as typeof fetch,
			outDirOverride: outDir,
			resolveApiKey: () => "",
		});
		const res = await tool.execute("t5", { prompt: "x" });
		const parsed = JSON.parse(textOf(res)) as { ok: boolean; message: string };
		assert.equal(parsed.ok, false);
		assert.match(parsed.message, /No OpenRouter key/);
		assert.equal(called, false);
	});

	it("missing prompt → clear error", async () => {
		const tool = makeTool(fakeFetch(() => ({})));
		const res = await tool.execute("t6", {});
		const parsed = JSON.parse(textOf(res)) as { ok: boolean; message: string };
		assert.equal(parsed.ok, false);
		assert.match(parsed.message, /`prompt` is required/);
	});

	it("action=list filters to image-output models", async () => {
		const tool = makeTool(
			fakeFetch((url) => {
				assert.match(url, /\/models$/);
				return {
					data: [
						{ id: "openai/gpt-5-image", architecture: { output_modalities: ["image", "text"] } },
						{ id: "openai/gpt-5.4", architecture: { output_modalities: ["text"] } },
						{ id: "google/gemini-2.5-flash-image", architecture: { output_modalities: ["image"] } },
					],
				};
			}),
		);
		const res = await tool.execute("t7", { action: "list" });
		const parsed = JSON.parse(textOf(res)) as { ok: boolean; models: string[] };
		assert.deepEqual(parsed.models, ["google/gemini-2.5-flash-image", "openai/gpt-5-image"]);
	});

	it("count generates that many files", async () => {
		const tool = makeTool(
			fakeFetch((url) =>
				url.endsWith("/chat/completions")
					? { choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] }
					: {},
			),
		);
		const res = await tool.execute("t8", { prompt: "x", count: 3 });
		assert.equal(res.details?.paths?.length, 3);
		const unique = new Set(res.details?.paths);
		assert.equal(unique.size, 3, "each generation gets a distinct filename");
	});
});

describe("extractImageUrls — unit", () => {
	it("handles all shapes and ignores junk", () => {
		assert.deepEqual(extractImageUrls(null), []);
		assert.deepEqual(extractImageUrls({}), []);
		assert.deepEqual(extractImageUrls({ choices: [{ message: { content: "plain" } }] }), []);
		const fromImages = extractImageUrls({
			choices: [{ message: { images: [{ image_url: { url: "https://x/i.png" } }] } }],
		});
		assert.deepEqual(fromImages, ["https://x/i.png"]);
		const fromString = extractImageUrls({
			choices: [{ message: { content: `look ${DATA_URL} end` } }],
		});
		assert.equal(fromString.length, 1);
		assert.ok(fromString[0]?.startsWith("data:image/png"));
	});
});
