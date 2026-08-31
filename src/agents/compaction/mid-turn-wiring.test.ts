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
