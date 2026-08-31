/**
 * These tests exist because four production bugs in one day were the SAME
 * mistake: code walking Pi's in-memory messages reached for the Anthropic WIRE
 * spelling. Every one of them compiled and passed a green suite.
 *
 * So the assertions below are deliberately about the DIALECT BOUNDARY, not
 * about the accessors' happy path. A test that only checks `toolCallArguments`
 * returns the arguments would have passed before the fix too.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	contentBlocks,
	isAssistantMessage,
	isToolCall,
	isToolResultMessage,
	messageText,
	toolCallArguments,
	toolCallId,
	toolCallName,
	toolCallsIn,
	toolResultCallId,
	toolResultName,
} from "./pi-dialect.js";

/** A real Pi tool call, exactly as `@earendil-works/pi-ai` declares it. */
const piToolCall = {
	type: "toolCall" as const,
	id: "call_1",
	name: "read",
	arguments: { path: "/etc/hosts" },
};

/** The SAME logical thing, in Anthropic's wire dialect. Must NOT be accepted. */
const wireToolUse = {
	type: "tool_use",
	id: "call_1",
	name: "read",
	input: { path: "/etc/hosts" },
};

test("a Pi toolCall block is recognised", () => {
	assert.equal(isToolCall(piToolCall), true);
	assert.deepEqual(toolCallArguments(piToolCall), { path: "/etc/hosts" });
	assert.equal(toolCallName(piToolCall), "read");
	assert.equal(toolCallId(piToolCall), "call_1");
});

test("a WIRE tool_use block is NOT mistaken for a Pi toolCall", () => {
	// This is the boundary the whole module defends. If this ever passes, the
	// two dialects have been conflated and `.input` will start leaking in.
	assert.equal(isToolCall(wireToolUse), false);
	assert.deepEqual(toolCallArguments(wireToolUse), {});
	assert.equal(toolCallName(wireToolUse), "");
});

test("a tool result is a MESSAGE, not a block inside a user message", () => {
	// `findSafeBoundary` looked for `role === "user"` here and found nothing,
	// which made mid-turn compaction inert inside exactly the tool loops it
	// exists to survive.
	const piToolResult = {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text" as const, text: "127.0.0.1 localhost" }],
		isError: false,
		timestamp: 1,
	};
	assert.equal(isToolResultMessage(piToolResult), true);
	assert.equal(toolResultCallId(piToolResult), "call_1");
	assert.equal(toolResultName(piToolResult), "read");

	// The wire shape — a tool_result BLOCK carried by a `user` message — must
	// not answer to the same accessors.
	const wireShaped = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
	};
	assert.equal(isToolResultMessage(wireShaped), false);
	assert.equal(toolResultCallId(wireShaped), undefined);
});

test("toolCallsIn finds calls on an assistant message and nowhere else", () => {
	const assistant = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "reading" }, piToolCall],
		timestamp: 1,
	};
	assert.equal(isAssistantMessage(assistant), true);
	assert.equal(toolCallsIn(assistant).length, 1);
	assert.equal(toolCallsIn(assistant)[0]?.name, "read");

	// An assistant message carrying WIRE blocks yields nothing, loudly.
	const wireAssistant = { role: "assistant", content: [wireToolUse] };
	assert.equal(toolCallsIn(wireAssistant).length, 0);
});

test("a user message's string content is normalised to a text block", () => {
	// `UserMessage.content` is `string | Content[]`. Forgetting the string form
	// is the next version of this same bug, so it is handled once.
	const stringy = { role: "user" as const, content: "hello", timestamp: 1 };
	assert.deepEqual(contentBlocks(stringy), [{ type: "text", text: "hello" }]);
	assert.equal(messageText(stringy), "hello");
});

test("malformed input never throws", () => {
	// Transcripts come off disk, off the wire, and from other Brigade versions.
	// A read-only accessor must never be the thing that takes down a turn.
	for (const junk of [null, undefined, 0, "", [], { role: 5 }, { content: 7 }]) {
		assert.doesNotThrow(() => {
			isToolCall(junk);
			toolCallArguments(junk);
			toolResultCallId(junk);
			toolCallsIn(junk);
			contentBlocks(junk);
			messageText(junk);
		});
	}
});
