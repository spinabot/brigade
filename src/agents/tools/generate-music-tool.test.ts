import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { makeGenerateMusicTool } from "./generate-music-tool.js";

let outDir: string;
beforeEach(() => {
	outDir = mkdtempSync(join(tmpdir(), "brigade-music-"));
});
afterEach(() => rmSync(outDir, { recursive: true, force: true }));

/** A minimal Response stand-in for the raw-audio-bytes providers. */
function audioResponse(bytes: number[]): Response {
	return {
		ok: true,
		status: 200,
		arrayBuffer: async () => new Uint8Array(bytes).buffer,
		text: async () => "",
		json: async () => ({}),
	} as unknown as Response;
}

/** A JSON Response stand-in. */
function jsonResponse(payload: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => payload,
		text: async () => "",
		arrayBuffer: async () => new ArrayBuffer(0),
	} as unknown as Response;
}

test("generate (google) → Lyria generateContent, base64 audio saved as mp3 + MEDIA path", async () => {
	const b64 = Buffer.from([0xff, 0xfb, 0x90]).toString("base64");
	let calledUrl = "";
	let body: unknown;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calledUrl = String(url);
		body = JSON.parse(String(init?.body));
		return jsonResponse({
			candidates: [{ content: { parts: [{ inlineData: { data: b64, mimeType: "audio/mpeg" } }] } }],
		});
	}) as unknown as typeof fetch;

	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "google" ? "k" : "") });
	const res = await tool.execute("c1", { prompt: "upbeat lo-fi" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "google");
	assert.ok(calledUrl.includes("generativelanguage.googleapis.com"));
	assert.ok(calledUrl.includes(":generateContent"));
	assert.deepEqual((body as { generationConfig?: { responseModalities?: string[] } }).generationConfig?.responseModalities, [
		"AUDIO",
		"TEXT",
	]);
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp3"));
	assert.ok(existsSync(saved));
	assert.deepEqual([...readFileSync(saved)], [0xff, 0xfb, 0x90]);
	const first = res.content[0];
	assert.ok(first?.type === "text" && first.text.includes(`MEDIA:${saved}`));
});

test("google folds instrumental + lyrics into the prompt text (mutually exclusive guard not tripped)", async () => {
	let body: { contents?: Array<{ parts?: Array<{ text?: string }> }> } | undefined;
	const b64 = Buffer.from([1, 2, 3]).toString("base64");
	const fetchFn = (async (_url: string, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { data: b64 } }] } }] });
	}) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "google" ? "k" : "") });
	// instrumental alone (no lyrics) → hint appended.
	const res = await tool.execute("c1", { prompt: "calm piano", instrumental: true }, undefined as never);
	assert.equal(res.details.ok, true);
	const text = body?.contents?.[0]?.parts?.[0]?.text ?? "";
	assert.match(text, /Instrumental only/i);
});

test("minimax → hex-encoded inline audio decoded to an mp3 file", async () => {
	const hex = Buffer.from([0xff, 0xfb, 0x90]).toString("hex");
	const fetchFn = (async () => jsonResponse({ data: { audio: hex }, base_resp: { status_code: 0 } })) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "minimax" ? "k" : "") });
	const res = await tool.execute("c1", { prompt: "jazz", provider: "minimax" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "minimax");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp3"));
	assert.deepEqual([...readFileSync(saved)], [0xff, 0xfb, 0x90]);
});

test("minimax → audio_url is downloaded via GET", async () => {
	const audioBytes = [0x12, 0x34, 0x56];
	let getUrl = "";
	let calls = 0;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calls += 1;
		if (calls === 1) {
			// generation POST
			assert.equal((init?.method ?? "GET"), "POST");
			return jsonResponse({ data: { audio_url: "https://cdn.example/song.mp3" }, base_resp: { status_code: 0 } });
		}
		// download GET
		getUrl = String(url);
		assert.equal(init?.method, "GET");
		return audioResponse(audioBytes);
	}) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "minimax" ? "k" : "") });
	const res = await tool.execute("c1", { prompt: "edm", provider: "minimax" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(getUrl, "https://cdn.example/song.mp3");
	assert.deepEqual([...readFileSync(res.details.path!)], audioBytes);
});

test("explicit provider override (elevenlabs) hits /v1/music with raw mp3 bytes", async () => {
	let calledUrl = "";
	let body: unknown;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calledUrl = String(url);
		body = JSON.parse(String(init?.body));
		return audioResponse([0x49, 0x44, 0x33]); // "ID3"
	}) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: () => "key" });
	const res = await tool.execute("c1", { prompt: "ambient", provider: "elevenlabs", durationSeconds: 30 }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "elevenlabs");
	assert.ok(calledUrl.includes("api.elevenlabs.io/v1/music"));
	assert.equal((body as { music_length_ms?: number }).music_length_ms, 30_000);
	assert.ok(res.details.path!.endsWith(".mp3"));
});

test("auto-select preference: google before minimax before elevenlabs", async () => {
	// only minimax + elevenlabs keyed → minimax wins (preference order). MiniMax
	// returns JSON, so feed a JSON inline-audio response.
	const fetchFn = (async () =>
		jsonResponse({ data: { audio: Buffer.from([1]).toString("hex") }, base_resp: { status_code: 0 } })) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({
		fetchFn,
		outDirOverride: outDir,
		resolveKey: (p) => (p === "minimax" || p === "elevenlabs" ? "key" : ""),
	});
	const res = await tool.execute("c1", { prompt: "song" }, undefined as never);
	assert.equal(res.details.provider, "minimax");
});

test("no key configured → ok:false with a clear message, no file written", async () => {
	const fetchFn = (async () => audioResponse([1])) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: () => "" });
	const res = await tool.execute("c1", { prompt: "hi" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /no music provider|configured/i);
});

test("empty prompt → ok:false", async () => {
	const tool = makeGenerateMusicTool({ outDirOverride: outDir, resolveKey: () => "key" });
	const res = await tool.execute("c1", { prompt: "   " }, undefined as never);
	assert.equal(res.details.ok, false);
});

test("action=list reports configured providers", async () => {
	const tool = makeGenerateMusicTool({ outDirOverride: outDir, resolveKey: (p) => (p === "google" ? "k" : "") });
	const res = await tool.execute("c1", { action: "list" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.deepEqual(res.details.providers, ["google"]);
});

test("instrumental + lyrics together → ok:false (conflict)", async () => {
	const fetchFn = (async () => audioResponse([1])) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: () => "key" });
	const res = await tool.execute(
		"c1",
		{ prompt: "song", instrumental: true, lyrics: "la la la" },
		undefined as never,
	);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /instrumental.*lyrics|lyrics.*instrumental/i);
});

test("provider HTTP error → ok:false, message carries the status", async () => {
	const fetchFn = (async () =>
		({ ok: false, status: 401, text: async () => "bad key", arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
	const tool = makeGenerateMusicTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "google" ? "k" : "") });
	const res = await tool.execute("c1", { prompt: "hi" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /401/);
});
