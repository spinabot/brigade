import assert from "node:assert/strict";
import { test } from "node:test";

import { makeTranscribeAudioTool, type TranscribeSource } from "./transcribe-audio-tool.js";

/** A fixed in-memory audio source so tests never touch the filesystem. */
const SOURCE: TranscribeSource = { bytes: Buffer.from([1, 2, 3]), mime: "audio/mpeg", extension: "mp3" };
const readSource = async (): Promise<TranscribeSource> => SOURCE;

/** A minimal Response stand-in returning `json`. */
function jsonResponse(payload: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => payload,
		text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
		arrayBuffer: async () => new ArrayBuffer(0),
		headers: { get: () => null },
	} as unknown as Response;
}

test("transcribe (google) → Gemini generateContent joins the transcript parts", async () => {
	let calledUrl = "";
	const fetchFn = (async (url: string) => {
		calledUrl = String(url);
		return jsonResponse({ candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] });
	}) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: (p) => (p === "google" ? "gk" : "") });
	const res = await tool.execute("c1", { source: "voice.mp3", provider: "google" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.ok(calledUrl.includes("generativelanguage.googleapis.com"));
	assert.equal(res.details.transcript, "hello world");
});

test("command provider (offline) runs the local STT CLI via the runner seam (stdout transcript)", async () => {
	let ranCmd = "";
	const tool = makeTranscribeAudioTool({
		readSource,
		resolveKey: () => "",
		sttCommand: "mystt {input} -o {output} -l {language}",
		commandRunner: (cmd) => {
			ranCmd = cmd;
			return { code: 0, stdout: "local transcript", stderr: "" };
		},
	});
	const res = await tool.execute("c1", { source: "voice.mp3", provider: "command" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "command");
	assert.equal(res.details.transcript, "local transcript");
	assert.ok(ranCmd.includes("mystt"));
});

test("transcribe (groq) → posts to groq, returns transcript + provider", async () => {
	let calledUrl = "";
	const fetchFn = (async (url: string) => {
		calledUrl = String(url);
		return jsonResponse({ text: "hello" });
	}) as unknown as typeof fetch;

	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: (p) => (p === "groq" ? "gk" : "") });
	const res = await tool.execute("c1", { source: "voice.mp3" }, undefined as never);

	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "groq");
	assert.equal(res.details.transcript, "hello");
	assert.equal(res.details.chars, 5);
	assert.ok(calledUrl.includes("api.groq.com/openai/v1/audio/transcriptions"));
	const first = res.content[0];
	assert.ok(first?.type === "text" && first.text === "hello");
});

test("auto-select preference: groq before openai before deepgram", async () => {
	const fetchFn = (async () => jsonResponse({ text: "hi" })) as unknown as typeof fetch;
	// only openai + deepgram keyed → openai wins (groq absent, openai next in order)
	const tool = makeTranscribeAudioTool({
		fetchFn,
		readSource,
		resolveKey: (p) => (p === "openai" || p === "deepgram" ? "key" : ""),
	});
	const res = await tool.execute("c1", { source: "voice.mp3" }, undefined as never);
	assert.equal(res.details.provider, "openai");
});

test("explicit provider override hits the right URL (when keyed)", async () => {
	let calledUrl = "";
	const fetchFn = (async (url: string) => {
		calledUrl = String(url);
		return jsonResponse({ text: "hi" });
	}) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: () => "key" });
	const res = await tool.execute("c1", { source: "voice.mp3", provider: "mistral" }, undefined as never);
	assert.equal(res.details.provider, "mistral");
	assert.ok(calledUrl.includes("api.mistral.ai/v1/audio/transcriptions"));
});

test("explicit provider with no key → ok:false", async () => {
	const fetchFn = (async () => jsonResponse({ text: "hi" })) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: (p) => (p === "groq" ? "gk" : "") });
	const res = await tool.execute("c1", { source: "voice.mp3", provider: "openai" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /not available|no key/i);
});

test("no key configured → ok:false with a clear message", async () => {
	const fetchFn = (async () => jsonResponse({ text: "hi" })) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: () => "" });
	const res = await tool.execute("c1", { source: "voice.mp3" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /no STT provider|configured/i);
});

test("missing source → ok:false", async () => {
	const tool = makeTranscribeAudioTool({ readSource, resolveKey: () => "key" });
	const res = await tool.execute("c1", { source: "   " }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /source.*required/i);
});

test("action=list reports configured providers in preference order", async () => {
	const tool = makeTranscribeAudioTool({
		readSource,
		resolveKey: (p) => (p === "groq" || p === "elevenlabs" ? "k" : ""),
	});
	const res = await tool.execute("c1", { action: "list" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.deepEqual(res.details.providers, ["groq", "elevenlabs"]);
});

test("deepgram parses the nested transcript path + sends raw bytes", async () => {
	let calledUrl = "";
	let usedFormData = false;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calledUrl = String(url);
		usedFormData = init?.body instanceof FormData;
		return jsonResponse({
			results: { channels: [{ alternatives: [{ transcript: "deepgram words" }] }] },
		});
	}) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: (p) => (p === "deepgram" ? "dg" : "") });
	const res = await tool.execute("c1", { source: "voice.mp3", language: "en" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(res.details.provider, "deepgram");
	assert.equal(res.details.transcript, "deepgram words");
	assert.ok(calledUrl.includes("api.deepgram.com/v1/listen"));
	assert.ok(calledUrl.includes("model=nova-3"));
	assert.ok(calledUrl.includes("language=en"));
	// Deepgram takes RAW bytes, NOT multipart.
	assert.equal(usedFormData, false);
});

test("elevenlabs uses xi-api-key header + multipart", async () => {
	let calledUrl = "";
	let header: string | undefined;
	let usedFormData = false;
	const fetchFn = (async (url: string, init?: RequestInit) => {
		calledUrl = String(url);
		header = (init?.headers as Record<string, string> | undefined)?.["xi-api-key"];
		usedFormData = init?.body instanceof FormData;
		return jsonResponse({ text: "scribe out" });
	}) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: (p) => (p === "elevenlabs" ? "xi" : "") });
	const res = await tool.execute("c1", { source: "voice.mp3" }, undefined as never);
	assert.equal(res.details.ok, true);
	assert.equal(res.details.transcript, "scribe out");
	assert.ok(calledUrl.includes("api.elevenlabs.io/v1/speech-to-text"));
	assert.equal(header, "xi");
	assert.equal(usedFormData, true);
});

test("provider HTTP error → ok:false, message carries the status", async () => {
	const fetchFn = (async () => jsonResponse("bad key", false, 401)) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: () => "k" });
	const res = await tool.execute("c1", { source: "voice.mp3" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /401/);
});

test("empty transcript → ok:false", async () => {
	const fetchFn = (async () => jsonResponse({ text: "   " })) as unknown as typeof fetch;
	const tool = makeTranscribeAudioTool({ fetchFn, readSource, resolveKey: (p) => (p === "groq" ? "gk" : "") });
	const res = await tool.execute("c1", { source: "voice.mp3" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /empty transcript/i);
});

test("readSource failure → ok:false (e.g. guarded path refusal)", async () => {
	const failingRead = async () => {
		throw new Error("refusing to read that path");
	};
	const tool = makeTranscribeAudioTool({ readSource: failingRead, resolveKey: () => "k" });
	const res = await tool.execute("c1", { source: "/etc/shadow" }, undefined as never);
	assert.equal(res.details.ok, false);
	assert.match(res.details.message ?? "", /could not read the audio source/i);
});
