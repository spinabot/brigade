import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createClaudeCliStreamFn, serializeConversationPrompt } from "./stream.js";

/* ─────────────────────────── fake subprocess ─────────────────────────── */

interface FakeSpawnScript {
	/** stdout lines emitted (each gets a trailing newline), in order. */
	stdoutLines?: string[];
	/** Split each line across two data chunks to exercise line buffering. */
	splitChunks?: boolean;
	/** Exit code passed to 'close'. Default 0. */
	code?: number | null;
	/** stderr text emitted before close (for auth-shaped exit tests). */
	stderr?: string;
	/** Emit an 'error' (spawn failure) instead of running. */
	spawnError?: boolean;
	/** Capture the argv + stdin the stream fn passed. */
	captured?: { args?: string[]; stdin?: string };
}

function makeFakeSpawn(script: FakeSpawnScript) {
	return ((_command: string, args: string[]) => {
		if (script.captured) script.captured.args = args;
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter & { setEncoding: (e: string) => void };
			stderr: EventEmitter & { setEncoding: (e: string) => void };
			stdin: { write: (s: string) => void; end: () => void };
			kill: (sig?: string) => void;
		};
		const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
		stdout.setEncoding = () => {};
		const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
		stderr.setEncoding = () => {};
		child.stdout = stdout;
		child.stderr = stderr;
		child.stdin = {
			write: (s: string) => {
				if (script.captured) script.captured.stdin = s;
			},
			end: () => {
				// Once stdin closes, "run" the process on the next tick.
				queueMicrotask(() => {
					if (script.spawnError) {
						child.emit("error", new Error("spawn ENOENT"));
						return;
					}
					for (const line of script.stdoutLines ?? []) {
						if (script.splitChunks && line.length > 2) {
							const mid = Math.floor(line.length / 2);
							stdout.emit("data", line.slice(0, mid));
							stdout.emit("data", `${line.slice(mid)}\n`);
						} else {
							stdout.emit("data", `${line}\n`);
						}
					}
					if (script.stderr) stderr.emit("data", script.stderr);
					child.emit("close", script.code ?? 0);
				});
			},
		};
		child.kill = () => {};
		return child;
	}) as never;
}

const MODEL = { id: "claude-sonnet-4-6", api: "claude-cli", provider: "claude-cli" } as never;
const CTX = { systemPrompt: "You are Brigade.", messages: [{ role: "user", content: "hey" }] };

async function drain(stream: { [Symbol.asyncIterator](): AsyncIterator<unknown>; result(): Promise<unknown> }) {
	const events: any[] = [];
	for await (const ev of stream) events.push(ev);
	const message = (await stream.result().catch(() => undefined)) as any;
	return { events, message };
}

/* ─────────────────────────── prompt serialization ─────────────────────────── */

test("serializeConversationPrompt: lone user message → just that text", () => {
	assert.equal(serializeConversationPrompt([{ role: "user", content: "hey" }]), "hey");
});

test("serializeConversationPrompt: multi-turn → labelled transcript + current message", () => {
	const out = serializeConversationPrompt([
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "hello!" },
		{ role: "user", content: "how are you" },
	]);
	assert.match(out, /Human: hi/);
	assert.match(out, /Assistant: hello!/);
	assert.match(out, /Current message:\n\nhow are you/);
});

test("serializeConversationPrompt: flattens content blocks to text", () => {
	const out = serializeConversationPrompt([
		{ role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", data: "B64" }] },
	]);
	assert.match(out, /look at this/);
	assert.match(out, /\[image omitted\]/);
});

/* ─────────────────────────── streaming happy path ─────────────────────────── */

const HAPPY_LINES = [
	'{"type":"system","subtype":"init","session_id":"s1"}',
	'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":10}}}}',
	'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}',
	'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}}',
	'{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":3}}}',
	'{"type":"result","subtype":"success","result":"Hello there","usage":{"input_tokens":10,"output_tokens":3}}',
];

test("stream fn: emits start → text deltas → done with accumulated text + usage", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	const { events, message } = await drain(fn(MODEL, CTX, undefined) as never);

	const types = events.map((e) => e.type);
	assert.ok(types.includes("start"));
	assert.ok(types.includes("text_start"));
	assert.equal(types.filter((t) => t === "text_delta").length, 2);
	assert.ok(types.includes("done"));

	assert.equal(message.stopReason, "stop");
	const text = message.content.find((c: any) => c.type === "text")?.text;
	assert.equal(text, "Hello there");
	assert.equal(message.usage.input, 10);
	assert.equal(message.usage.output, 3);
	assert.equal(message.usage.cost.total, 0); // subscription — no per-token cost

	// argv + stdin the fn built
	assert.ok(captured.args?.includes("--model"));
	assert.equal(captured.stdin, "hey");
});

test("stream fn: survives stdout chunk splitting mid-line", async () => {
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, splitChunks: true }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "Hello there");
});

test("stream fn: falls back to the assistant frame when no partial deltas arrive", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"Complete answer"}]}}',
		'{"type":"result","subtype":"success","result":"Complete answer"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "Complete answer");
});

/* ─────────────────────────── failure paths ─────────────────────────── */

test("stream fn: out-of-extra-usage result → error event with subscription-limit message", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"result","subtype":"error_during_execution","is_error":true,"error":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { events } = await drain(fn(MODEL, CTX, undefined) as never);
	const err = events.find((e) => e.type === "error");
	assert.ok(err, "expected an error event");
	assert.match(err.error.errorMessage, /usage limit|out of extra usage/i);
});

test("stream fn: spawn failure (binary missing) → clear error event", async () => {
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ spawnError: true, code: null }) });
	const { events } = await drain(fn(MODEL, CTX, undefined) as never);
	const err = events.find((e) => e.type === "error");
	assert.ok(err, "expected an error event");
	assert.match(err.error.errorMessage, /no result|could not be started|installed/i);
});

test("stream fn: abort signal → aborted error event", async () => {
	const ac = new AbortController();
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES }) });
	ac.abort();
	const { events } = await drain(fn(MODEL, { ...CTX }, { signal: ac.signal }) as never);
	// Either an aborted error or a clean end — never a crash. Assert no throw + terminal event present.
	assert.ok(events.some((e) => e.type === "error" || e.type === "done"));
});

test("stream fn: dead-login result → actionable 're-run brigade login claude-cli' error", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"result","subtype":"error_during_execution","is_error":true,"error":"401 Unauthorized: OAuth token expired, please login"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { events } = await drain(fn(MODEL, CTX, undefined) as never);
	const err = events.find((e) => e.type === "error");
	assert.ok(err, "expected an error event");
	assert.match(err.error.errorMessage, /brigade login claude-cli/);
	assert.match(err.error.errorMessage, /sign in again/i);
});

test("stream fn: auth-shaped stderr on non-zero exit → re-auth message", async () => {
	const fn = createClaudeCliStreamFn({
		spawnFn: makeFakeSpawn({ stdoutLines: ['{"type":"system","subtype":"init"}'], code: 1, stderr: "Error: not logged in. Run claude login." }),
	});
	const { events } = await drain(fn(MODEL, CTX, undefined) as never);
	const err = events.find((e) => e.type === "error");
	assert.ok(err);
	assert.match(err.error.errorMessage, /brigade login claude-cli/);
});
