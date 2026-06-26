import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { makeGenerateSpeechTool, wrapPcmAsWav } from "./generate-speech-tool.js";

let outDir: string;
beforeEach(() => {
	outDir = mkdtempSync(join(tmpdir(), "brigade-tts-"));
});
afterEach(() => rmSync(outDir, { recursive: true, force: true }));

/** A minimal Response stand-in for the audio-bytes providers. */
function audioResponse(bytes: number[]): Response {
	return {
		ok: true,
		status: 200,
		arrayBuffer: async () => new Uint8Array(bytes).buffer,
		text: async () => "",
		json: async () => ({}),
	} as unknown as Response;
}

test("generate (openai) → calls /audio/speech, saves mp3, returns MEDIA path", async () => {
	let calledUrl = "";
	let body: unknown;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calledUrl = String(url);
		body = JSON.parse(String(init?.body));
		return audioResponse([0x49, 0x44, 0x33]); // "ID3"
	}) as unknown as typeof fetch;

	const tool = makeGenerateSpeechTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "openai" ? "sk-x" : "") });
	const res = await tool.execute("c1", { text: "hello there" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "openai");
	assert.ok(calledUrl.includes("api.openai.com/v1/audio/speech"));
	assert.equal((body as { input?: string }).input, "hello there");
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".mp3"));
	assert.ok(existsSync(saved));
	const first = res.content[0];
	assert.ok(first?.type === "text" && first.text.includes(`MEDIA:${saved}`));
});

test("auto-select preference: openai before elevenlabs before google", async () => {
	const fetchFn = (async () => audioResponse([1, 2, 3])) as unknown as typeof fetch;
	// only elevenlabs + google keyed → elevenlabs wins (preference order)
	const tool = makeGenerateSpeechTool({
		fetchFn,
		outDirOverride: outDir,
		resolveKey: (p) => (p === "elevenlabs" || p === "google" ? "key" : ""),
	});
	const res = await tool.execute("c1", { text: "hi" }, undefined as never);
	assert.equal(res.details.provider, "elevenlabs");
});

test("explicit provider override is honored (when keyed)", async () => {
	let calledUrl = "";
	const fetchFn = (async (url: string) => {
		calledUrl = String(url);
		return audioResponse([1]);
	}) as unknown as typeof fetch;
	const tool = makeGenerateSpeechTool({ fetchFn, outDirOverride: outDir, resolveKey: () => "key" });
	const res = await tool.execute("c1", { text: "hi", provider: "elevenlabs", voice: "Rachel" }, undefined as never);
	assert.equal(res.details.provider, "elevenlabs");
	assert.ok(calledUrl.includes("api.elevenlabs.io/v1/text-to-speech/Rachel"));
});

test("no key configured → ok:false with a clear message, no file written", async () => {
	const fetchFn = (async () => audioResponse([1])) as unknown as typeof fetch;
	const tool = makeGenerateSpeechTool({ fetchFn, outDirOverride: outDir, resolveKey: () => "" });
	const res = await tool.execute("c1", { text: "hi" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /no TTS provider|configured/i);
});

test("empty text → ok:false", async () => {
	const tool = makeGenerateSpeechTool({ outDirOverride: outDir, resolveKey: () => "key" });
	const res = await tool.execute("c1", { text: "   " }, undefined as never);
	assert.equal(res.details.ok, false);
});

test("action=list reports configured providers", async () => {
	const tool = makeGenerateSpeechTool({ outDirOverride: outDir, resolveKey: (p) => (p === "openai" ? "k" : "") });
	const res = await tool.execute("c1", { action: "list" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.deepEqual(res.details.providers, ["openai"]);
});

test("google PCM response is wrapped into a .wav file", async () => {
	const pcm = Buffer.from([0, 1, 2, 3, 4, 5]).toString("base64");
	const fetchFn = (async () =>
		({
			ok: true,
			status: 200,
			json: async () => ({
				candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: "audio/L16;codec=pcm;rate=24000" } }] } }],
			}),
			text: async () => "",
		}) as unknown as Response) as unknown as typeof fetch;
	const tool = makeGenerateSpeechTool({ fetchFn, outDirOverride: outDir, resolveKey: (p) => (p === "google" ? "k" : "") });
	const res = await tool.execute("c1", { text: "hi", provider: "google" }, undefined as never);
	assert.equal(res.details.ok, true);
	const saved = res.details.path!;
	assert.ok(saved.endsWith(".wav"));
	const head = readFileSync(saved).subarray(0, 4).toString("ascii");
	assert.equal(head, "RIFF");
});

test("provider HTTP error → ok:false, message carries the status", async () => {
	const fetchFn = (async () =>
		({ ok: false, status: 401, text: async () => "bad key", arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch;
	const tool = makeGenerateSpeechTool({ fetchFn, outDirOverride: outDir, resolveKey: () => "k" });
	const res = await tool.execute("c1", { text: "hi" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /401/);
});

test("wrapPcmAsWav writes a valid 44-byte RIFF/WAVE header", () => {
	const wav = wrapPcmAsWav(Buffer.from([1, 2, 3, 4]), 24000);
	assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
	assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
	assert.equal(wav.readUInt32LE(24), 24000); // sample rate
	assert.equal(wav.readUInt16LE(22), 1); // mono
	assert.equal(wav.readUInt32LE(40), 4); // data length
	assert.equal(wav.length, 44 + 4);
});
