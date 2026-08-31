/**
 * Wiring test — does mid-turn compaction actually fire through the REAL
 * transform chain Pi calls?
 *
 * The decision core and the runner are unit-tested in isolation. This asserts
 * the thing those tests cannot: that `buildBrigadeTransformContext` invokes the
 * compactor, threads Pi's AbortSignal to it, orders it after the free
 * tool-result shrink, and still returns a usable array when it fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildBrigadeTransformContext } from "../payload-mutators.js";
import { createMidTurnCompactor } from "./mid-turn-runner.js";
import { createCompactionSummarizer } from "./summarizer.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as AgentMessage;
const asst = (text: string) =>
	({ role: "assistant", content: [{ type: "text", text }] }) as AgentMessage;

function bigConversation(): AgentMessage[] {
	const msgs: AgentMessage[] = [];
	for (let i = 0; i < 12; i += 1) {
		msgs.push(user(`ask ${i} `.repeat(400)));
		msgs.push(asst(`answer ${i} `.repeat(400)));
	}
	return msgs;
}

const WINDOW = 8_000;

test("the transform chain invokes the compactor and returns the reduced array", async () => {
	let calls = 0;
	const transform = buildBrigadeTransformContext({
		midTurnCompactor: createMidTurnCompactor({
			contextWindowTokens: WINDOW,
			summarize: async () => {
				calls += 1;
				return "## GOAL\nfinish the migration";
			},
		}),
	});
	const messages = bigConversation();
	const out = await transform(messages);

	assert.equal(calls, 1, "the compactor ran inside the chain, not just in its own test");
	assert.ok(out.length < messages.length);
	assert.match(JSON.stringify(out[0]), /finish the migration/);
});

test("Pi's AbortSignal reaches the compactor", async () => {
	// The chain previously declared `signal` and dropped it. Mid-turn compaction
	// is the first pass that can block, so a Ctrl+C has to reach it.
	let seen: AbortSignal | undefined;
	const transform = buildBrigadeTransformContext({
		midTurnCompactor: async (messages, signal) => {
			seen = signal;
			return messages;
		},
	});
	const controller = new AbortController();
	await transform(bigConversation(), controller.signal);
	assert.equal(seen, controller.signal);
});

test("a compactor that throws cannot take down the turn", async () => {
	// Pi's contract: transformContext must not throw. The compactor is not
	// supposed to, but the chain must survive it if it does.
	const transform = buildBrigadeTransformContext({
		midTurnCompactor: async () => {
			throw new Error("boom");
		},
	});
	const messages = bigConversation();
	const out = await transform(messages);
	assert.equal(out.length, messages.length, "the request proceeds unreduced");
});

test("a compactor that returns an empty array is ignored", async () => {
	// Sending zero messages to a provider is a 400. Treat it as a failed
	// reduction rather than passing it through.
	const transform = buildBrigadeTransformContext({
		midTurnCompactor: async () => [],
	});
	const messages = bigConversation();
	const out = await transform(messages);
	assert.equal(out.length, messages.length);
});

test("no compactor configured leaves behaviour exactly as it was", async () => {
	const transform = buildBrigadeTransformContext({});
	const messages = bigConversation();
	const out = await transform(messages);
	assert.equal(out.length, messages.length);
});

test("the free tool-result shrink runs BEFORE the paid summarization", async () => {
	// Ordering is the cost story: truncating an old 40 KB `read` is free and is
	// often enough on its own. The summarizer must only see what the free pass
	// could not fix.
	let sawTokens = 0;
	const huge = "x".repeat(200_000);
	const messages: AgentMessage[] = [
		user("do the thing"),
		{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read" }] } as AgentMessage,
		{
			role: "toolResult",
			toolCallId: "t1",
			content: [{ type: "text", text: huge }],
		} as unknown as AgentMessage,
	];
	for (let i = 0; i < 8; i += 1) {
		messages.push(user(`ask ${i} `.repeat(50)));
		messages.push(asst(`answer ${i} `.repeat(50)));
	}
	const before = JSON.stringify(messages).length;

	const transform = buildBrigadeTransformContext({
		toolResultContextWindow: WINDOW,
		midTurnCompactor: async (msgs) => {
			sawTokens = JSON.stringify(msgs).length;
			return msgs;
		},
	});
	await transform(messages);
	assert.ok(
		sawTokens < before,
		`compactor saw ${sawTokens} chars, chain received ${before} — the shrink must run first`,
	);
});

test("Ctrl+C reaches the summarizer's own LLM call, not just the runner's wait", async () => {
	// THE HOP THAT WAS DEAD. Every layer above this one threaded the signal —
	// Pi hands it to `transformContext`, the chain forwards it to the compactor,
	// the runner races it against the summarization — and then the summarizer
	// accepted it as `_signal` and dropped it on the floor. The visible effect
	// was a lie: Ctrl+C stopped Brigade WAITING for the summary while the
	// isolated session underneath kept streaming a full context window to the
	// provider and kept billing for it. Compaction is one of the largest single
	// calls Brigade makes, so the one call an operator most wants to cancel was
	// the only one they could not.
	//
	// The proof has to run against the REAL summarizer and the REAL isolated-LLM
	// factory, because the defect lived precisely in the wiring between them —
	// a test that stubbed either end would have passed the whole time it was
	// broken. The workspace, registry and model below are deliberate junk: an
	// aborted signal must short-circuit BEFORE any of them is touched, so the
	// call cannot reach a provider. Drop the signal again and this same junk
	// blows up with a TypeError instead of an AbortError, which is exactly the
	// assertion below.
	const summarize = createCompactionSummarizer({
		workspaceDir: "/nonexistent-brigade-abort-probe",
		agentDir: "/nonexistent-brigade-abort-probe",
		authStorage: {},
		modelRegistry: {},
		model: { id: "probe" },
	});
	assert.ok(summarize, "a summarizer is built when a model and registry are present");

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		summarize("some transcript to summarize", controller.signal),
		(err: Error) =>
			// Shaped as a DOM AbortError so `retry-policy.ts` never mistakes a
			// cancellation for a transient fault and re-bills the call.
			err.name === "AbortError" &&
			(err as Error & { code?: string }).code === "ABORT_ERR",
		"an aborted turn cancels the summarization instead of paying for it",
	);
});

test("an aborted summarization is a cancellation, never a compaction failure", async () => {
	// The whole chain, end to end: an abort raised inside the summarizer must
	// surface through the runner as `aborted` — the ONE outcome that neither
	// truncates history nor disables the compactor for the rest of the turn.
	// Read as an error instead, a Ctrl+C would silently drop the older half of
	// the conversation from every remaining request in the turn.
	const outcomes: string[] = [];
	const abortError = Object.assign(new Error("isolated LLM call was cancelled by the caller"), {
		name: "AbortError",
		code: "ABORT_ERR",
	});
	const transform = buildBrigadeTransformContext({
		midTurnCompactor: createMidTurnCompactor({
			contextWindowTokens: WINDOW,
			summarize: async () => {
				throw abortError;
			},
			onEnd: (o) => outcomes.push(o.reason),
		}),
	});
	const messages = bigConversation();
	const out = await transform(messages);

	assert.equal(outcomes.at(-1), "aborted", "not `error`, and not `fallback-truncated`");
	assert.equal(out.length, messages.length, "an interrupted turn keeps its history intact");
});
