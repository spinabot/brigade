import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createClaudeCliStreamFn, serializeConversationPrompt } from "./stream.js";
import { getLimits, resetLimitsForTest } from "../usage/limits.js";
import { resolveClaudeCliEffort } from "./catalog.js";
import { stampClaudeCliToolPlane } from "./tool-plane.js";

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
const CTX = { systemPrompt: "You are Brigade.", messages: [{ role: "user", content: "hey" }] } as never;

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

test("text blocks separated by a tool call get a paragraph break, not a fused sentence", async () => {
	// The binary runs its own tool loop, so one Brigade turn is many internal steps,
	// each opening its own text block. Accumulating them without a separator produced
	// exactly this, all over a working turn:
	//
	//   "Let me load my tools and look.Good — real assets: the lion mascot set…"
	//   "…study the reference video's style.The reference is Anthropic's launch video"
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me load my tools and look."}}}',
		// the model acts…
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"mcp__brigade__read"}}}',
		// …then resumes in a NEW text block
		'{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Good — real assets."}}}',
		'{"type":"result","subtype":"success","result":"x"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	const text = message.content.find((c: any) => c.type === "text")?.text;
	assert.equal(text, "Let me load my tools and look.\n\nGood — real assets.");
	assert.equal(text.includes("look.Good"), false, "the two utterances must not fuse");
});

test("a text block opening on already-broken text does not stack blank lines", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done.\\n\\n"}}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Next."}}}',
		'{"type":"result","subtype":"success","result":"x"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "Done.\n\nNext.");
});

test("the FIRST text block never opens with a leading blank line", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}',
		'{"type":"result","subtype":"success","result":"Hello"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "Hello");
});

test("two thinking blocks across a tool call do not fuse either", async () => {
	// Steps 2..N of the binary's loop each open their own thinking block. Fused, the
	// model's separate trains of thought read as one: "hmm" + "second thought" →
	// "hmmsecond thought", in the transcript and in `/reasoning`.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking."}}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","name":"mcp__brigade__read"}}}',
		// step 2: a fresh thinking block, then fresh text
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"second thought"}}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Found it."}}}',
		'{"type":"result","subtype":"success","result":"Found it."}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "thinking")?.thinking, "hmm\n\nsecond thought");
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "Looking.\n\nFound it.");
});

test("no tool_use block ever reaches the returned message's content", async () => {
	// Pi's runLoop executes `message.content.filter(c => c.type === "toolCall")`. If a
	// tool_use block survived into the returned message, Pi would re-run every tool the
	// binary already ran — `bash ./deploy.sh` twice.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"mcp__brigade__bash"}}}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"tu_1","name":"mcp__brigade__bash"}]}}',
		'{"type":"result","subtype":"success","result":"ok"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	const types = message.content.map((c: any) => c.type);
	assert.deepEqual(types.filter((t: string) => t === "toolCall" || t === "tool_use"), []);
	assert.ok(types.every((t: string) => t === "text" || t === "thinking"), `unexpected block: ${types.join(",")}`);
});

test("a thinking block opening does not inject a paragraph break into the text", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer."}}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}}',
		'{"type":"result","subtype":"success","result":"Answer."}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "Answer.");
});

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

test("usage.input is the FIRST step's prompt, not the binary's cumulative total", async () => {
	// The binary runs its own tool loop inside one turn: a message_start per internal
	// step, each with a bigger prompt, and a `result` frame carrying the CUMULATIVE
	// usage of the whole run (prompt caching re-counts cache_read on every step).
	//
	// Pi reads an assistant message's usage as "tokens currently in the context window"
	// (calculateContextTokens = input + output + cacheRead + cacheWrite) and compacts
	// when it crosses the threshold. Feeding it the cumulative total made a 39%-full
	// session report 889% of a 200k window — and Pi "compacted" it twice, discarding
	// real history both times.
	const lines = [
		'{"type":"system","subtype":"init","session_id":"s1"}',
		// step 1 — the conversation Brigade actually handed the binary
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":40000,"cache_read_input_tokens":38000}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"working"}}}',
		// steps 2..N — the binary's own scratch context, which Pi cannot compact
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":5000,"cache_read_input_tokens":190000}}}}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":9000,"cache_read_input_tokens":195000}}}}',
		'{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":12941}}}',
		// the result frame's usage is a BILLING total for the run, not a context size
		'{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":54000,"cache_read_input_tokens":1702936,"output_tokens":12941}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);

	// The prompt legs are reported SPLIT so a caller can see what was cached.
	// They sum to the same 78000 the folded convention produced.
	assert.equal(message.usage.input, 40000, "first step's FRESH prompt");
	assert.equal(message.usage.cacheRead, 38000, "first step's cached prompt, no longer hidden inside input");
	assert.equal(message.usage.cacheWrite, 0);
	assert.equal(message.usage.input + message.usage.cacheRead, 78000, "legs still sum to the first step's prompt");
	assert.equal(message.usage.output, 12941);

	// `totalTokens` is the field Pi's `calculateContextTokens` actually reads, so
	// it — not `input` — is what the compaction threshold sees. It must be
	// identical to the pre-split value (78000 + 12941), or splitting the legs
	// would have silently re-opened the inflation this test exists to prevent.
	assert.equal(message.usage.totalTokens, 90941, "context size is unchanged by reporting the legs separately");
	assert.notEqual(message.usage.totalTokens, 1_756_936, "must NOT be the run's cumulative total");
	// 90941 of a 200k window is 45% — the honest figure. The bug reported 889%.
	assert.ok(message.usage.totalTokens / 200_000 < 0.5, "a healthy session must not look overfull");
});

test("total_cost_usd from the result frame becomes the turn's cost", async () => {
	// The binary reports the turn's real equivalent spend. It was parsed into a
	// typed field and never read, so every claude-cli turn reported $0.0000 no
	// matter what it consumed — across 591 real assistant messages on a live
	// install, not one carried a non-zero cost.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_creation_input_tokens":500}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
		'{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":42}}}',
		'{"type":"result","subtype":"success","result":"hi","total_cost_usd":0.0731,"usage":{"input_tokens":1000,"output_tokens":42}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.usage.cost.total, 0.0731, "the binary's own figure, not a computed price");
	assert.equal(message.usage.cacheWrite, 500, "cache-write leg is reported, not folded away");
	assert.equal(
		(message.usage as unknown as { costKnown?: boolean }).costKnown,
		true,
		"a reported cost is distinguishable from an absent one",
	);
});

test("a turn with no reported cost is marked unknown, not free", async () => {
	// `cost.total === 0` alone cannot tell "this turn was genuinely free" from
	// "we have no cost signal". A renderer that cannot tell them apart shows a
	// confident $0.0000 for a turn that may have cost real money.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":10}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
		'{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":10,"output_tokens":2}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.usage.cost.total, 0);
	assert.equal((message.usage as unknown as { costKnown?: boolean }).costKnown, false, "absent cost is not $0");
});

test("a rate_limit_event frame reaches the plan-limit store", async () => {
	// End-to-end through the real frame loop, not just the store in isolation:
	// this frame type used to fall through to `// no-op`, so the one backend
	// with no cost signal also had no quota signal.
	resetLimitsForTest();
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"allowed","resetsAt":1800000000,"isUsingOverage":false}}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":10}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
		'{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":10,"output_tokens":2}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	await drain(fn(MODEL, CTX, undefined) as never);

	const windows = getLimits();
	assert.equal(windows.length, 1, "the frame must not be dropped");
	assert.equal(windows[0]?.kind, "five_hour");
	assert.equal(windows[0]?.label, "5-hour window");
	assert.equal(windows[0]?.status, "ok");
	assert.equal(windows[0]?.provider, "claude-cli", "normalized onto the neutral provider-keyed shape");
	assert.equal(windows[0]?.resetsAt, 1_800_000_000_000, "seconds converted to ms");
	resetLimitsForTest();
});

test("stop_reason max_tokens maps to length so the continuation loop can fire", async () => {
	// `stopReason` was initialized to "stop" and never reassigned, so a response
	// truncated at the output cap was reported as a clean finish. The agent
	// loop's auto-continuation is gated on "length", so it was dead for this
	// backend only — the same prompt on `anthropic` or `ollama` auto-continued.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":10}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"cut off mid-"}}}',
		'{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}}}',
		'{"type":"result","subtype":"success","result":"cut off mid-","usage":{"input_tokens":10,"output_tokens":4096}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.stopReason, "length", "truncation must be visible to the continuation loop");
});

test("usage.output is the streamed value, NOT the result frame's cumulative total", async () => {
	// The `result` frame's usage is cumulative over every internal step — that is why
	// `input` is guarded. `output_tokens` on the SAME object is just as cumulative
	// (every step's generation, tool-call JSON included), and `calculateContextTokens`
	// is `input + output`. Overwriting output re-opened half of the very inflation the
	// input guard exists to prevent.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":40000}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
		'{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":300}}}',
		'{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":999999,"output_tokens":90000}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.usage.input, 40000, "first step's prompt");
	assert.equal(message.usage.output, 300, "the streamed per-step value, not 90000");
	assert.notEqual(message.usage.output, 90000, "the run's cumulative generation must not become our context");
	assert.equal(message.usage.totalTokens, 40300, "context size is the first step's prompt plus streamed output");
});

test("text_start and text_end agree on contentIndex even when thinking arrives later", async () => {
	// `textIdx()` used to be a function of MUTABLE state (`thinkingStarted ? 1 : 0`).
	// A step that wrote text BEFORE ever thinking, followed by a later step that opened
	// a thinking block, reported text_start@0 and text_end@1 for the same block.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"acting first"}}}',
		// a later internal step finally thinks
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}',
		'{"type":"result","subtype":"success","result":"acting first"}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { events } = await drain(fn(MODEL, CTX, undefined) as never);
	const start = events.find((e: any) => e.type === "text_start");
	const end = events.find((e: any) => e.type === "text_end");
	assert.equal(start.contentIndex, 0);
	assert.equal(end.contentIndex, 0, "the same logical block cannot change index mid-flight");
});

test("the no-partials fallback separates multiple text blocks like the streaming path", async () => {
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"First."},{"type":"text","text":"Second."}]}}',
		'{"type":"result","subtype":"success","result":"First.\\n\\nSecond."}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.content.find((c: any) => c.type === "text")?.text, "First.\n\nSecond.");
});

test("usage.input falls back to the result frame when no partial frames stream", async () => {
	// An older CLI emits no message_start; the run is a single step, so its cumulative
	// total IS that step's prompt. Filling in a missing input is correct there.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
		'{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":1200,"output_tokens":8}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal(message.usage.input, 1200);
	assert.equal(message.usage.output, 8);
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
	const { events } = await drain(fn(MODEL, CTX, { signal: ac.signal }) as never);
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

/* ─────────────────────── MCP tool-plane gates ─────────────────────── */

function ctxWithStamp(over: { senderIsOwner: boolean; systemPrompt?: string; structured?: boolean }) {
	const ctx: Record<string, unknown> = {
		systemPrompt: over.systemPrompt ?? "You are Brigade.",
		messages: [{ role: "user", content: "hey" }],
	};
	stampClaudeCliToolPlane(ctx, {
		agentId: "main",
		senderIsOwner: over.senderIsOwner,
		...(over.structured !== undefined ? { structured: over.structured } : {}),
	});
	return ctx as never;
}

test("tool-plane: OWNER chat turn gets --mcp-config + --strict-mcp-config", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	await drain(fn(MODEL, ctxWithStamp({ senderIsOwner: true }), undefined) as never);
	assert.ok(captured.args?.includes("--mcp-config"), "mcp config attached for owner");
	assert.ok(captured.args?.includes("--strict-mcp-config"), "strict pinning attached");
});

test("tool-plane: PEER turn gets NO mcp flags (owner-origin isolation)", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	await drain(fn(MODEL, ctxWithStamp({ senderIsOwner: false }), undefined) as never);
	assert.ok(!captured.args?.includes("--mcp-config"), "peer must not reach the memory MCP");
});

test("tool-plane: UNSTAMPED context (isolated distiller sessions) gets NO mcp flags", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	await drain(fn(MODEL, CTX, undefined) as never);
	assert.ok(!captured.args?.includes("--mcp-config"));
});

test("tool-plane: a DECLARED structured turn gets NO mcp flags even when owner-stamped", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	// Distiller sessions stamp `structured: true` (installStructuredTurnStamp). Even
	// owner-stamped, they stay tool-less on every backend.
	const ctx = ctxWithStamp({ senderIsOwner: true, structured: true });
	await drain(fn(MODEL, ctx, undefined) as never);
	assert.ok(!captured.args?.includes("--mcp-config"), "distillers stay tool-less on every backend");
});

test("tool-plane: an owner turn whose PERSONA says 'STRICT JSON only' keeps its tools", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	// The assembled persona splices in operator-authored files (TOOLS.md, USER.md) and
	// skill descriptions verbatim. Documenting a JSON API must NOT make the transport
	// mistake a chat turn for a distiller and strip its whole tool surface — which the
	// operator would see only as an agent that mysteriously "won't use its tools".
	const ctx = ctxWithStamp({
		senderIsOwner: true,
		structured: false,
		systemPrompt: "You are Brigade.\n\n## TOOLS.md\nOur /v1/facts endpoint returns STRICT JSON only.",
	});
	await drain(fn(MODEL, ctx, undefined) as never);
	assert.ok(captured.args?.includes("--mcp-config"), "a stamped agent turn keeps its plane regardless of prose");
});

test("tool-plane: an UNSTAMPED distiller prompt still falls back to the text sniff", async () => {
	const captured: FakeSpawnScript["captured"] = {};
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }) });
	// The cold path (no stamp at all) has nothing else to go on.
	const ctx = { systemPrompt: 'Distill. Return STRICT JSON only: {"facts":[]}', messages: [] };
	await drain(fn(MODEL, ctx as never, undefined) as never);
	assert.ok(!captured.args?.includes("--mcp-config"));
});

/* ─────────────────────────── reasoning flags ─────────────────────────── */

test("the operator's thinking level reaches the binary as --effort", async () => {
	// It did not before: BuildArgsInput had no thinking field, so `/thinking` was
	// decorative on 100% of claude-cli traffic while the catalog advertised
	// `reasoning: true` for every Opus/Sonnet/Fable entry.
	const captured: { args?: string[] } = {};
	const fn = createClaudeCliStreamFn({
		spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }),
	});
	await drain(fn(MODEL, CTX, { reasoning: "high" } as never) as never);

	const args = captured.args ?? [];
	const i = args.indexOf("--effort");
	assert.ok(i >= 0, "--effort must be sent");
	assert.equal(args[i + 1], "high");
});

test("requesting thinking also asks the binary to stop redacting it", async () => {
	// `showThinkingSummaries` defaults to false in the binary, and while false the
	// CLI asks the API to redact reasoning. That default is why a real 591-message
	// transcript history contained ZERO thinking blocks — the reasoning never
	// arrived, so no renderer could have shown it.
	const captured: { args?: string[] } = {};
	const fn = createClaudeCliStreamFn({
		spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }),
	});
	await drain(fn(MODEL, CTX, { reasoning: "medium" } as never) as never);

	const args = captured.args ?? [];
	const i = args.indexOf("--settings");
	assert.ok(i >= 0, "--settings must be sent");
	assert.deepEqual(JSON.parse(args[i + 1] as string), { showThinkingSummaries: true });
});

test("thinking OFF sends neither reasoning flag", async () => {
	// Silence means the binary keeps its own behaviour. Inventing a lowest effort
	// would spend tokens the operator declined.
	const captured: { args?: string[] } = {};
	const fn = createClaudeCliStreamFn({
		spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }),
	});
	await drain(fn(MODEL, CTX, { reasoning: "off" } as never) as never);

	const args = captured.args ?? [];
	assert.equal(args.includes("--effort"), false);
	assert.equal(args.includes("--settings"), false);
});

test("a turn with no reasoning option is unchanged", async () => {
	const captured: { args?: string[] } = {};
	const fn = createClaudeCliStreamFn({
		spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES, captured }),
	});
	await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal((captured.args ?? []).includes("--effort"), false);
});

test("Pi's thinking vocabulary maps onto the binary's effort vocabulary", () => {
	// The two differ at both ends: Pi's `minimal` floors to the CLI's `low`, and
	// the CLI's `max` has no Pi equivalent.
	assert.equal(resolveClaudeCliEffort("minimal"), "low");
	assert.equal(resolveClaudeCliEffort("low"), "low");
	assert.equal(resolveClaudeCliEffort("medium"), "medium");
	assert.equal(resolveClaudeCliEffort("high"), "high");
	assert.equal(resolveClaudeCliEffort("xhigh"), "xhigh");
	assert.equal(resolveClaudeCliEffort("off"), undefined);
	assert.equal(resolveClaudeCliEffort(undefined), undefined);
	assert.equal(resolveClaudeCliEffort("nonsense"), undefined, "an unknown level is not guessed at");
});

test("reasoning tokens are read from the relayed API frames when present", async () => {
	// Pi folds reasoning into `output` and exposes no breakdown, and `--betas` is
	// API-key-only so the CLI's own thinking-token beta is unreachable on a
	// subscription. But these frames are the RAW Anthropic events the binary
	// relays, so the field arrives whenever the API sends it.
	const lines = [
		'{"type":"system","subtype":"init"}',
		'{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":100}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
		'{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":900,"output_tokens_details":{"thinking_tokens":740}}}}',
		'{"type":"result","subtype":"success","result":"hi","usage":{"input_tokens":100,"output_tokens":900}}',
	];
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: lines }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal((message.usage as { reasoningTokens?: number }).reasoningTokens, 740);
	assert.equal(message.usage.output, 900, "output still carries the full generation");
});

test("a turn with no reasoning breakdown reports absent, not zero", async () => {
	// `0 reasoning tokens` would assert a measurement we do not have.
	const fn = createClaudeCliStreamFn({ spawnFn: makeFakeSpawn({ stdoutLines: HAPPY_LINES }) });
	const { message } = await drain(fn(MODEL, CTX, undefined) as never);
	assert.equal((message.usage as { reasoningTokens?: number }).reasoningTokens, undefined);
});
