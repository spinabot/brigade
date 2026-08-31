/**
 * Does Pi ACTUALLY run Brigade's transform chain?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS TO CATCH
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade passed `transformContext` to `createAgentSession(...)`.
 * `createAgentSession` does not accept it: it reads a fixed option list and
 * installs a `transformContext` of its own for the extension runner
 * (pi-coding-agent/dist/core/sdk.js:219-224). The property was silently
 * dropped, and an `as never` cast on the options object meant the compiler
 * never complained.
 *
 * So the entire chain was dead in production — the transcript pairing repair,
 * the surrogate sanitizer, the Anthropic cache-control sweep and
 * thinking-strip, the Mistral tool-id rewrite, the tool-result shrink, mid-turn
 * compaction. Every one had passing unit tests, because those tests called
 * `buildBrigadeTransformContext` directly and asserted that the function does
 * what it says. None asserted that Pi ever calls it. A test that exercises your
 * own function proves your own function works; it proves nothing about wiring.
 *
 * These tests drive the REAL `Agent` from `@earendil-works/pi-agent-core` with
 * a stub `streamFn`, so what they assert is Pi's behaviour, not a mock's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { installBrigadeTransformContext } from "./payload-mutators.js";

/**
 * Minimal streamFn recording exactly what Pi decided to send.
 *
 * Pi calls `streamFunction(model, llmContext, options)` and iterates the result
 * as an async iterable with a `result()` promise (`agent-loop.js:189-240`), so
 * that is what this returns — the real contract, not a convenient shape.
 * `llmContext.messages` is the transform's output after `convertToLlm`, which
 * makes it the ground truth for "what actually reached the provider".
 */
function makeRecordingAgent() {
	const sent: unknown[][] = [];
	const finalMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const agent = new Agent({
		streamFn: ((_model: unknown, llmContext: { messages?: unknown[] }) => {
			sent.push([...(llmContext?.messages ?? [])]);
			const iterable = {
				[Symbol.asyncIterator]: async function* () {
					yield { type: "done" as const };
				},
				result: async () => finalMessage,
			};
			return iterable;
		}) as never,
	});
	return { agent, sent };
}

/** The session shape `installBrigadeTransformContext` expects. */
const asSession = (agent: unknown) => ({ agent }) as never;

test("Pi invokes a transform installed AFTER the agent is constructed", async () => {
	// This is the property the fix rests on: `Agent.transformContext` is a
	// public mutable field, and `createLoopConfig()` re-reads it on every run.
	const { agent, sent } = makeRecordingAgent();
	let called = 0;
	installBrigadeTransformContext(asSession(agent), async (messages) => {
		called += 1;
		return messages;
	});
	await agent.prompt("hello");
	assert.equal(called, 1, "Pi must call the transform we attached post-construction");
	assert.equal(sent.length, 1);
});

test("the array the transform RETURNS is what Pi sends to the provider", async () => {
	// The failure mode that made Vercel's `prepareStep` useless for compaction:
	// the hook was called, its return value was discarded, and the request was
	// rebuilt from the untouched history. If Pi did that, mid-turn compaction
	// would be decorative.
	const { agent, sent } = makeRecordingAgent();
	const replacement: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "REDUCED" }], timestamp: 1 } as never,
	];
	installBrigadeTransformContext(asSession(agent), async () => replacement);
	await agent.prompt("a very long conversation that should have been replaced");

	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.length, 1, "Pi sent exactly what the transform returned");
	assert.match(JSON.stringify(sent[0]), /REDUCED/);
	assert.equal(
		/should have been replaced/.test(JSON.stringify(sent[0])),
		false,
		"the original history must NOT reach the provider",
	);
});

test("reducing the request does not damage the session's own history", async () => {
	// Compaction is a per-request VIEW. The transcript must survive untouched —
	// that is the whole "compact, don't replace" contract.
	const { agent } = makeRecordingAgent();
	installBrigadeTransformContext(asSession(agent), async () => [
		{ role: "user", content: [{ type: "text", text: "REDUCED" }], timestamp: 1 } as never,
	]);
	await agent.prompt("the original question");
	const history = JSON.stringify(agent.state.messages);
	assert.match(history, /the original question/, "history is preserved in full");
});

test("Pi's own transform is composed with, never replaced", async () => {
	// Pi's `createAgentSession` installs a transform that runs the EXTENSION
	// `context` hooks. Overwriting it would silently disable every extension.
	const { agent, sent } = makeRecordingAgent();
	const order: string[] = [];
	(agent as { transformContext?: unknown }).transformContext = async (
		messages: AgentMessage[],
	) => {
		order.push("pi");
		return [...messages, { role: "user", content: [{ type: "text", text: "FROM-EXT" }], timestamp: 2 } as never];
	};
	installBrigadeTransformContext(asSession(agent), async (messages) => {
		order.push("brigade");
		return messages;
	});
	await agent.prompt("hi");

	assert.deepEqual(order, ["pi", "brigade"], "extensions run first, Brigade sees the final array");
	assert.match(JSON.stringify(sent[0]), /FROM-EXT/, "the extension's contribution survives");
});

test("a throwing Brigade transform cannot take down the turn", async () => {
	// Pi's call site has no try/catch (`agent-loop.js:175-177`): a throw becomes
	// a failed turn. The guard is ours.
	const { agent, sent } = makeRecordingAgent();
	installBrigadeTransformContext(asSession(agent), async () => {
		throw new Error("boom");
	});
	await agent.prompt("still works?");
	assert.equal(sent.length, 1, "the request still went out");
	assert.match(JSON.stringify(sent[0]), /still works\?/, "unreduced, but intact");
});

test("an empty array from the transform is refused", async () => {
	// A zero-message provider request is a 400. Pi does not guard it.
	const { agent, sent } = makeRecordingAgent();
	installBrigadeTransformContext(asSession(agent), async () => []);
	await agent.prompt("do not send nothing");
	assert.ok(sent[0]!.length > 0, "never send a zero-message request");
});

test("a throwing EXTENSION transform does not skip Brigade's passes", async () => {
	// The pairing repair and surrogate sanitizer are what stop malformed history
	// from 400-ing the provider. A broken third-party extension must not disable
	// them.
	const { agent } = makeRecordingAgent();
	let brigadeRan = false;
	(agent as { transformContext?: unknown }).transformContext = async () => {
		throw new Error("bad extension");
	};
	installBrigadeTransformContext(asSession(agent), async (messages) => {
		brigadeRan = true;
		return messages;
	});
	await agent.prompt("hi");
	assert.equal(brigadeRan, true);
});

test("installing on a session with no agent is a no-op, not a crash", () => {
	assert.doesNotThrow(() => installBrigadeTransformContext({} as never, async (m) => m));
});

/* ───────────── the whole path: real Pi + the real Brigade chain ───────────── */

test("real Pi runs the real Brigade chain, and mid-turn compaction reduces the request", async () => {
	// End to end, with nothing stubbed but the network: Pi's Agent, Brigade's
	// composed transform chain, and the mid-turn compactor inside it. This is
	// the assertion whose absence let a dead feature ship green.
	const { buildBrigadeTransformContext } = await import("./payload-mutators.js");
	const { createMidTurnCompactor } = await import("./compaction/mid-turn-runner.js");

	const { agent, sent } = makeRecordingAgent();
	let summarized = 0;

	// A transcript comfortably over an 8k window.
	const history: AgentMessage[] = [];
	for (let i = 0; i < 12; i += 1) {
		history.push({
			role: "user",
			content: [{ type: "text", text: `ask ${i} ${"padding ".repeat(400)}` }],
			timestamp: i * 2,
		} as never);
		history.push({
			role: "assistant",
			content: [{ type: "text", text: `answer ${i} ${"padding ".repeat(400)}` }],
			timestamp: i * 2 + 1,
		} as never);
	}
	agent.state.messages.push(...(history as never[]));

	installBrigadeTransformContext(
		asSession(agent),
		buildBrigadeTransformContext({
			midTurnCompactor: createMidTurnCompactor({
				contextWindowTokens: 8_000,
				summarize: async () => {
					summarized += 1;
					return "## Goal\nfinish the migration";
				},
			}),
		}),
	);

	await agent.prompt("carry on");

	assert.equal(summarized, 1, "the summarization actually ran inside a real Pi turn");
	assert.equal(sent.length, 1);
	assert.ok(
		sent[0]!.length < agent.state.messages.length,
		`Pi sent ${sent[0]!.length} messages from a history of ${agent.state.messages.length}`,
	);
	assert.match(JSON.stringify(sent[0]), /finish the migration/, "the summary reached the provider");
	// And the transcript is untouched — compact, don't replace.
	assert.match(JSON.stringify(agent.state.messages), /ask 0/, "full history preserved");
});
