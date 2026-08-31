/**
 * Safety properties of the transform chain, now that it actually runs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * `buildBrigadeTransformContext` never executed in production: it was passed
 * to `createAgentSession`, which does not read that option. Its passes had unit
 * tests, and those tests passed, and none of it ran.
 *
 * It is live now, on every provider request for every user, including every
 * iteration of a tool loop. So the per-pass unit tests are no longer the
 * interesting question. These are the whole-chain invariants that a real
 * conversation depends on, asserted over transcripts shaped like real ones —
 * tool calls, tool results, thinking blocks, images, surrogate pairs, and a
 * deliberately damaged pair for the repair path.
 *
 * Every property here is one where a violation corrupts a live session rather
 * than merely failing a test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildBrigadeTransformContext } from "./payload-mutators.js";

let clock = 1;
const ts = () => clock++;

const user = (text: string): AgentMessage =>
	({ role: "user", content: [{ type: "text", text }], timestamp: ts() }) as never;

const assistant = (content: unknown[]): AgentMessage =>
	({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ts(),
	}) as never;

/** An assistant turn that was interrupted or errored mid-stream. */
const brokenAssistant = (content: unknown[], stopReason: "aborted" | "error"): AgentMessage =>
	({ ...(assistant(content) as object), stopReason }) as never;

const toolResult = (id: string, text: string): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts(),
	}) as never;

const image = (): AgentMessage =>
	({
		role: "user",
		content: [
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: "what is this?" },
		],
		timestamp: ts(),
	}) as never;

/** A transcript shaped like real traffic: prose, tools, thinking, images. */
function realisticTranscript(): AgentMessage[] {
	const msgs: AgentMessage[] = [user("start the migration")];
	for (let i = 0; i < 6; i += 1) {
		msgs.push(
			assistant([
				{ type: "thinking", thinking: `reasoning ${i} `.repeat(20) },
				{ type: "text", text: `step ${i}` },
				{ type: "toolCall", id: `call_${i}`, name: "bash", arguments: { command: `run ${i}` } },
			]),
		);
		msgs.push(toolResult(`call_${i}`, `output ${i} `.repeat(50)));
		msgs.push(user(`next ${i}`));
	}
	msgs.push(image());
	msgs.push(assistant([{ type: "text", text: "done" }]));
	return msgs;
}

/** The chain as production wires it, for an Anthropic turn. */
const chain = (over: Record<string, unknown> = {}) =>
	buildBrigadeTransformContext({
		applyAnthropicSweep: true,
		pruneOldImages: true,
		toolResultContextWindow: 200_000,
		...over,
	});

/* ─────────────────── invariant 1: no in-place mutation ─────────────────── */

test("the chain never mutates the caller's messages", async () => {
	// `Agent.state.messages` IS the live transcript. While the chain was dead
	// this was harmless; running on every request, an in-place edit would
	// corrupt the session permanently and irreversibly.
	const messages = realisticTranscript();
	const snapshot = JSON.stringify(messages);
	await chain()(messages);
	assert.equal(JSON.stringify(messages), snapshot, "input transcript was modified in place");
});

/* ─────────────────── invariant 2: required fields survive ─────────────────── */

test("every message keeps the fields its Pi type requires", async () => {
	// Pi's UserMessage / AssistantMessage / ToolResultMessage all require
	// `timestamp`; assistants also require api, provider, model, usage,
	// stopReason. A pass that rebuilds a message and drops one now ships that
	// defect on every request.
	const out = await chain()(realisticTranscript());
	for (const m of out) {
		const msg = m as unknown as Record<string, unknown>;
		assert.equal(typeof msg.role, "string", "message lost its role");
		assert.equal(typeof msg.timestamp, "number", `${msg.role} lost its timestamp`);
		if (msg.role === "assistant") {
			for (const field of ["api", "provider", "model", "usage", "stopReason"]) {
				assert.ok(msg[field] !== undefined, `assistant lost ${field}`);
			}
		}
		if (msg.role === "toolResult") {
			assert.equal(typeof msg.toolCallId, "string", "toolResult lost its toolCallId");
		}
	}
});

/* ─────────────────── invariant 3: nothing empty goes out ─────────────────── */

test("no message is emitted with empty content", async () => {
	// Providers reject an empty content array outright, and an empty text block
	// is rejected by Anthropic. Both are shapes a stripping pass can create.
	const out = await chain()(realisticTranscript());
	assert.ok(out.length > 0, "the chain must never return an empty array");
	for (const m of out) {
		const content = (m as { content?: unknown }).content;
		if (Array.isArray(content)) {
			assert.ok(content.length > 0, `${(m as { role: string }).role} has empty content`);
		}
	}
});

/* ─────────────────── invariant 4: tool pairing stays valid ─────────────────── */

test("every tool result still has its call, and no call is orphaned", async () => {
	// The single most common cause of a hard provider 400.
	const out = await chain()(realisticTranscript());
	const calls = new Set<string>();
	for (const m of out) {
		const msg = m as { role?: string; content?: unknown[]; toolCallId?: string };
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) {
				const blk = b as { type?: string; id?: string };
				if (blk.type === "toolCall" && blk.id) calls.add(blk.id);
			}
		}
	}
	for (const m of out) {
		const msg = m as { role?: string; toolCallId?: string };
		if (msg.role === "toolResult") {
			assert.ok(calls.has(msg.toolCallId!), `orphaned tool result ${msg.toolCallId}`);
		}
	}
});

test("a damaged transcript is repaired rather than passed through broken", async () => {
	// Power-loss recovery: a tool call whose result never landed. Before the
	// chain ran, this reached the provider as-is and crashed the turn.
	const messages: AgentMessage[] = [
		user("do it"),
		assistant([{ type: "toolCall", id: "orphan", name: "bash", arguments: {} }]),
		user("still there?"),
	];
	let repaired = false;
	const transform = buildBrigadeTransformContext(
		{ applyAnthropicSweep: true },
		{ onTranscriptRepaired: () => { repaired = true; } },
	);
	const out = await transform(messages);
	assert.equal(repaired, true, "the repair hook should have fired");
	const results = out.filter((m) => (m as { role?: string }).role === "toolResult");
	assert.equal(results.length, 1, "a synthetic result was inserted for the orphaned call");
	const synth = results[0] as unknown as Record<string, unknown>;
	assert.equal(synth.toolCallId, "orphan");
	assert.equal(typeof synth.timestamp, "number", "the synthetic result needs a timestamp too");
	assert.ok(Array.isArray(synth.content) && (synth.content as unknown[]).length > 0);
});

/* ─────────────────── invariant 5: idempotence / cache stability ─────────────────── */

test("running the chain twice on the same input gives the same output", async () => {
	// It runs on EVERY request, including each tool-loop iteration. A pass that
	// keeps changing its own output would rewrite the prompt prefix every call
	// and destroy prompt caching — on Anthropic, trading a 10%-of-input cache
	// read for a 125% cache write, per step, for the whole turn.
	const messages = realisticTranscript();
	const once = await chain()(messages);
	const twice = await chain()(messages);
	assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test("re-feeding the chain its own output converges", async () => {
	// Stronger than idempotence on the input: the chain must be a fixed point,
	// or successive turns drift.
	const messages = realisticTranscript();
	const first = await chain()(messages);
	const second = await chain()(first);
	assert.equal(JSON.stringify(first), JSON.stringify(second), "the chain does not converge");
});

/* ─────────────────── invariant 6: the live image survives ─────────────────── */

test("the image in the current turn is never pruned", async () => {
	// The prune replaces old images with a placeholder. Removing the image the
	// user just sent would silently break every vision turn.
	const messages: AgentMessage[] = [user("hi"), assistant([{ type: "text", text: "hello" }]), image()];
	const out = await chain()(messages);
	const last = out[out.length - 1] as { content: { type: string }[] };
	assert.ok(
		last.content.some((b) => b.type === "image"),
		"the just-sent image was pruned — vision turns would break",
	);
});

/* ─────────────────── invariant 7: it cannot throw ─────────────────── */

test("malformed messages cannot take down the turn", async () => {
	// Pi's call site has no try/catch. Anything the chain throws becomes a
	// failed turn for the user.
	const junk = [
		null,
		undefined,
		42,
		"a string",
		{},
		{ role: "assistant" },
		{ role: "user", content: null },
		{ role: "toolResult", content: "not-an-array" },
		{ role: "assistant", content: [{ type: "toolCall" }] },
	] as unknown as AgentMessage[];
	const out = await chain()(junk);
	assert.ok(Array.isArray(out), "must always return an array");
});

test("an empty transcript is handled without throwing", async () => {
	assert.ok(Array.isArray(await chain()([])));
});

/* ─────────────────── invariant 8: bounded cost ─────────────────── */

test("the chain stays fast on a large transcript", async () => {
	// It is now in the hot path of every request. An O(n^2) pass would show up
	// as latency on exactly the long sessions that need it most.
	const messages: AgentMessage[] = [];
	for (let i = 0; i < 500; i += 1) {
		messages.push(user(`turn ${i} ${"x".repeat(200)}`));
		messages.push(assistant([{ type: "text", text: `reply ${i} ${"y".repeat(200)}` }]));
	}
	const started = Date.now();
	await chain()(messages);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2_000, `chain took ${elapsed}ms on 1000 messages`);
});

/* ─────────────────── invariant 9: non-Anthropic providers ─────────────────── */

test("the chain is safe with no model information", async () => {
	// `activeModel` is optional; absent, the provider quirks run in
	// strip-everything defensive mode. That path is now live too.
	const out = await buildBrigadeTransformContext({})(realisticTranscript());
	assert.ok(out.length > 0);
	for (const m of out) {
		const content = (m as { content?: unknown }).content;
		if (Array.isArray(content)) assert.ok(content.length > 0);
	}
});

test("surrogate pairs in real text survive, lone halves do not", async () => {
	// The sanitizer runs last. It must clean lone halves without mangling valid
	// emoji, which are ordinary in commit messages and build logs.
	const messages: AgentMessage[] = [
		user("shipped 🚀 with 日本語 and \ud83d a lone half"),
		assistant([{ type: "text", text: "ok ✅" }]),
	];
	const out = await chain()(messages);
	const text = JSON.stringify(out);
	assert.match(text, /🚀/, "valid emoji must survive");
	assert.match(text, /日本語/, "valid CJK must survive");
	assert.match(text, /✅/);
	assert.equal(/\\ud83d(?!\\ude)/.test(text), false, "a lone surrogate half reached the provider");
});

/* ───────── invariant 10: an interrupted turn must not brick the session ───────── */

/**
 * Pi DELETES assistant messages with `stopReason: "error" | "aborted"` before
 * sending (`pi-ai/dist/providers/transform-messages.js:156`) — they may carry
 * partial content, and replaying them causes API errors.
 *
 * That makes them radioactive for anything that reasons about tool calls. A
 * pass that synthesises a tool result for a call inside such a message produces
 * a `tool_result` answering a call the provider never sees, and all three
 * providers reject that outright. Since the aborted message is written to the
 * transcript, a single Ctrl+C during a tool call would brick the session for
 * every subsequent request.
 *
 * Every other test in this file builds assistants with `stopReason: "stop"`,
 * so none of them could see it — the same blind spot that hid the original bug.
 */

/** What the provider actually receives, after Pi's own drop rule. */
function asProviderSees(out: readonly AgentMessage[]): AgentMessage[] {
	return out.filter((m) => {
		const msg = m as { role?: string; stopReason?: string };
		return !(msg.role === "assistant" && (msg.stopReason === "aborted" || msg.stopReason === "error"));
	});
}

function hasOrphanedResult(msgs: readonly AgentMessage[]): boolean {
	const calls = new Set<string>();
	for (const m of msgs) {
		const msg = m as { role?: string; content?: unknown[] };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const b of msg.content) {
			const blk = b as { type?: string; id?: string };
			if (blk.type === "toolCall" && blk.id) calls.add(blk.id);
		}
	}
	return msgs.some((m) => {
		const msg = m as { role?: string; toolCallId?: string };
		return msg.role === "toolResult" && !calls.has(msg.toolCallId ?? "");
	});
}

for (const stopReason of ["aborted", "error"] as const) {
	test(`a ${stopReason} turn with an unanswered tool call does not orphan a result`, async () => {
		// One Ctrl+C after the tool_use block finished streaming.
		const messages: AgentMessage[] = [
			user("read the file"),
			brokenAssistant(
				[{ type: "toolCall", id: "T1", name: "read", arguments: { path: "a.ts" } }],
				stopReason,
			),
			user("never mind, do this instead"),
		];
		const out = await chain()(messages);
		assert.equal(
			hasOrphanedResult(asProviderSees(out)),
			false,
			`synthesised a result for a call the provider will never see (${stopReason})`,
		);
	});

	test(`a REAL result belonging to a ${stopReason} turn is dropped, not orphaned`, async () => {
		// The other half of the same 400: the call is deleted by Pi, so its
		// genuine result has nothing to answer.
		const messages: AgentMessage[] = [
			user("read the file"),
			brokenAssistant([{ type: "toolCall", id: "T2", name: "read", arguments: {} }], stopReason),
			toolResult("T2", "file contents"),
			user("carry on"),
		];
		const out = await chain()(messages);
		assert.equal(hasOrphanedResult(asProviderSees(out)), false);
	});
}

test("a healthy unanswered tool call IS still repaired", async () => {
	// The guard above must not disable the repair for the case it exists for:
	// a normally-completed turn whose result never landed (power loss).
	const messages: AgentMessage[] = [
		user("read the file"),
		assistant([{ type: "toolCall", id: "T3", name: "read", arguments: {} }]),
		user("still there?"),
	];
	const out = await chain()(messages);
	const results = out.filter((m) => (m as { role?: string }).role === "toolResult");
	assert.equal(results.length, 1, "the orphaned call still gets a synthetic result");
	assert.equal((results[0] as unknown as { toolCallId?: string }).toolCallId, "T3");
	assert.equal(hasOrphanedResult(asProviderSees(out)), false);
});

/* ───────── invariant 11: signed thinking survives a tool loop ───────── */

test("signed thinking blocks survive the whole tool loop on Anthropic", async () => {
	// Anthropic's interleaved-thinking beta is on by default in Pi and requires
	// thinking blocks to be passed back across every step of a tool loop. Pi's
	// own converter keeps any block carrying a `thinkingSignature` for the same
	// model, "needed for replay". Stripping all but the last assistant diverged
	// from that the moment this chain went live.
	const messages: AgentMessage[] = [user("start")];
	for (let i = 0; i < 3; i += 1) {
		messages.push(
			assistant([
				{ type: "thinking", thinking: `plan ${i}`, thinkingSignature: `sig-${i}` },
				{ type: "toolCall", id: `L${i}`, name: "bash", arguments: {} },
			]),
		);
		messages.push(toolResult(`L${i}`, `out ${i}`));
	}
	const out = await buildBrigadeTransformContext({
		applyAnthropicSweep: true,
		activeModel: { provider: "anthropic", api: "anthropic-messages", id: "claude-test" } as never,
	})(messages);

	const sigs = JSON.stringify(out).match(/sig-\d/g) ?? [];
	assert.deepEqual([...new Set(sigs)].sort(), ["sig-0", "sig-1", "sig-2"]);
});

test("UNSIGNED thinking is still stripped from history", async () => {
	// Unsigned blocks carry no replay value, and other providers reject them.
	const messages: AgentMessage[] = [
		user("start"),
		assistant([{ type: "thinking", thinking: "SCRATCH-NOSIG" }, { type: "text", text: "a" }]),
		user("next"),
		assistant([{ type: "text", text: "b" }]),
	];
	const out = await buildBrigadeTransformContext({
		applyAnthropicSweep: true,
		activeModel: { provider: "anthropic", api: "anthropic-messages", id: "claude-test" } as never,
	})(messages);
	assert.equal(JSON.stringify(out).includes("SCRATCH-NOSIG"), false);
});

test("a SIGNED thinking block survives on every provider, not just Anthropic", async () => {
	// The signature is the provider's own replay handle, and Pi knows what to do
	// with each: OpenAI Responses parses it back into the `reasoning` item the
	// API requires alongside a `function_call`; openai-completions replays it as
	// `reasoning_content`; cross-model it becomes plain text so the reasoning
	// survives as prose. Pi's `transformMessages` runs AFTER this chain, so
	// stripping here destroys information it was about to use correctly.
	//
	// This pass used to drop every thinking block on non-Anthropic providers.
	// That was harmless only because the chain never executed; making it live
	// turned it into a real regression.
	const messages: AgentMessage[] = [
		user("start"),
		assistant([
			{ type: "thinking", thinking: "x", thinkingSignature: "sig-a" },
			{ type: "toolCall", id: "T", name: "read", arguments: {} },
		]),
		toolResult("T", "ok"),
		user("next"),
		assistant([{ type: "text", text: "b" }]),
	];
	// Deliberately NOT openai-responses: that API has its own targeted pass
	// (`downgradeOpenAIResponsesReasoningPairs`) which drops reasoning paired
	// with a toolCall, added for a provider-specific rejection. A generic fix
	// must not override a targeted one — so what is asserted here is the GENERIC
	// path, e.g. DeepSeek-R1 / GLM / Kimi over openai-completions, where Pi
	// replays the signature as `reasoning_content`.
	const out = await buildBrigadeTransformContext({
		applyAnthropicSweep: false,
		activeModel: { provider: "deepseek", api: "openai-completions", id: "deepseek-r1" } as never,
	})(messages);
	assert.match(JSON.stringify(out), /sig-a/, "the replay handle must survive for Pi to use");
});

test("an UNSIGNED thinking block is still stripped on a non-Anthropic model", async () => {
	// No replay value, and a provider that does not understand
	// `{type:"thinking"}` rejects it outright.
	const messages: AgentMessage[] = [
		user("start"),
		assistant([{ type: "thinking", thinking: "SCRATCH-NOSIG" }, { type: "text", text: "a" }]),
		user("next"),
		assistant([{ type: "text", text: "b" }]),
	];
	const out = await buildBrigadeTransformContext({
		applyAnthropicSweep: false,
		activeModel: { provider: "google", api: "google-generative-ai", id: "gemini" } as never,
	})(messages);
	assert.equal(JSON.stringify(out).includes("SCRATCH-NOSIG"), false);
});
