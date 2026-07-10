import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeConversationPrompt } from "./claude-cli/stream.js";
import {
	buildHarnessToolMessages,
	mergeHarnessRecordsIntoSession,
	recordHarnessToolCall,
	type HarnessToolRecord,
} from "./harness-transcript.js";

const MODEL = { api: "claude-cli", provider: "claude-cli", model: "claude-opus-4-8" };

const rec = (over: Partial<HarnessToolRecord> = {}): HarnessToolRecord => ({
	toolCallId: "mcp-abc123",
	toolName: "bash",
	args: { command: "echo hi" },
	content: [{ type: "text", text: "hi" }],
	isError: false,
	...over,
});

test("builds the assistant(toolCall) + toolResult pair Pi's loop would have produced", () => {
	const [assistant, result] = buildHarnessToolMessages(rec(), MODEL) as any[];
	assert.equal(assistant.role, "assistant");
	assert.deepEqual(assistant.content, [
		{ type: "toolCall", id: "mcp-abc123", name: "bash", arguments: { command: "echo hi" } },
	]);
	assert.equal(assistant.api, "claude-cli");
	assert.equal(assistant.model, "claude-opus-4-8");
	assert.equal(assistant.usage.cost.total, 0, "a tool call draws no per-token charge");

	assert.equal(result.role, "toolResult");
	assert.equal(result.toolCallId, "mcp-abc123", "pairs by toolCallId");
	assert.equal(result.toolName, "bash");
	assert.deepEqual(result.content, [{ type: "text", text: "hi" }]);
	assert.equal(result.isError, false);
});

test("the pair stays ADJACENT — an API provider requires tool_use to be answered", () => {
	const msgs = buildHarnessToolMessages(rec(), MODEL) as any[];
	assert.equal(msgs.length, 2);
	assert.equal(msgs[0].role, "assistant");
	assert.equal(msgs[1].role, "toolResult");
	assert.equal(msgs[0].content[0].id, msgs[1].toolCallId);
});

test("an errored tool is recorded as isError, not silently dropped", () => {
	const [, result] = buildHarnessToolMessages(
		rec({ isError: true, content: [{ type: "text", text: "boom" }] }),
		MODEL,
	) as any[];
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "boom" }]);
});

test("recordHarnessToolCall appends both messages to the JSONL immediately", () => {
	const appended: unknown[] = [];
	const session = { messages: [{ role: "user" }], sessionManager: { appendMessage: (m: unknown) => appended.push(m) } };
	const out = recordHarnessToolCall(session, rec(), MODEL);
	assert.equal(out.messages.length, 2);
	assert.equal(out.insertAt, 1, "tagged with its position when the tool finished");
	assert.equal(appended.length, 2, "written as the tool runs — before Pi persists the final text");
	assert.equal((appended[0] as any).role, "assistant");
	assert.equal((appended[1] as any).role, "toolResult");
});

test("a failing transcript write never breaks the tool call", () => {
	const session = {
		sessionManager: {
			appendMessage: () => {
				throw new Error("disk full");
			},
		},
	};
	let count = 0;
	assert.doesNotThrow(() => {
		count = recordHarnessToolCall(session, rec(), MODEL).messages.length;
	});
	assert.equal(count, 2, "caller still gets the messages to merge");
});

test("recordHarnessToolCall tolerates a session with no sessionManager (cold path)", () => {
	assert.doesNotThrow(() => recordHarnessToolCall(undefined, rec(), MODEL));
	assert.equal(recordHarnessToolCall({}, rec(), MODEL).messages.length, 2);
});

/* ───────────────────────── in-memory reconciliation ───────────────────────── */

const batch = (insertAt: number, over: Partial<HarnessToolRecord> = {}) => ({
	insertAt,
	messages: buildHarnessToolMessages(rec(over), MODEL),
});

test("merge puts each pair back where it ran — before the assistant that followed it", () => {
	const finalText = { role: "assistant", content: [{ type: "text", text: "done" }] };
	const messages: unknown[] = [{ role: "user", content: "go" }, finalText];

	mergeHarnessRecordsIntoSession({ messages, isStreaming: false }, [batch(1)]);

	assert.deepEqual(messages.map((m: any) => m.role), ["user", "assistant", "toolResult", "assistant"]);
	assert.equal(messages.at(-1), finalText, "the model's reply stays last");
	assert.equal((messages[1] as any).content[0].type, "toolCall");
});

test("MULTI-ASSISTANT turn (continuation loop): records land before the RIGHT assistant", () => {
	// Brigade continues a reply cut off at stopReason:"length", so the turn yields
	// two assistant messages. A tool that ran between them must not be shoved past both.
	const a1 = { role: "assistant", content: [{ type: "text", text: "part 1" }] };
	const a2 = { role: "assistant", content: [{ type: "text", text: "part 2" }] };
	const messages: unknown[] = [{ role: "user", content: "go" }, a1, a2];

	mergeHarnessRecordsIntoSession({ messages, isStreaming: false }, [batch(2)]); // ran after a1

	assert.deepEqual(messages.map((m: any) => m.role), ["user", "assistant", "assistant", "toolResult", "assistant"]);
	assert.equal(messages[1], a1);
	assert.equal(messages.at(-1), a2, "the continuation still follows the tool that preceded it");
});

test("PARALLEL calls at the same position keep each pair adjacent", () => {
	const finalText = { role: "assistant", content: [{ type: "text", text: "done" }] };
	const messages: unknown[] = [{ role: "user", content: "go" }, finalText];

	mergeHarnessRecordsIntoSession({ messages, isStreaming: false }, [
		batch(1, { toolCallId: "mcp-A", toolName: "read" }),
		batch(1, { toolCallId: "mcp-B", toolName: "bash" }),
	]);

	assert.deepEqual(
		messages.map((m: any) => m.role),
		["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"],
	);
	// each tool_use answered by ITS tool_result, adjacently — Anthropic requires this
	assert.equal((messages[1] as any).content[0].id, (messages[2] as any).toolCallId);
	assert.equal((messages[3] as any).content[0].id, (messages[4] as any).toolCallId);
	assert.equal(messages.at(-1), finalText);
});

test("merge PROCEEDS (loudly) if the session still reports streaming — never silently drops history", () => {
	// Skipping would leave the JSONL holding the tool history while the live context
	// lost it for the rest of the process: the model would forget it wrote a file.
	const messages: unknown[] = [{ role: "assistant", content: [] }];
	mergeHarnessRecordsIntoSession({ messages, isStreaming: true }, [batch(0)]);
	assert.equal(messages.length, 3, "records merged, not dropped");
});

test("merge with no records, no messages array, or an out-of-range index is safe", () => {
	const messages: unknown[] = [{ role: "user", content: "hi" }];
	mergeHarnessRecordsIntoSession({ messages }, []);
	assert.equal(messages.length, 1);

	assert.doesNotThrow(() => mergeHarnessRecordsIntoSession(undefined, [batch(0)]));

	mergeHarnessRecordsIntoSession({ messages }, [batch(99)]); // clamps, never throws
	assert.deepEqual(messages.map((m: any) => m.role), ["user", "assistant", "toolResult"]);
});

test("THE TRAP: synthetic toolCalls are historical context, never fresh stream output", () => {
	// Pi's runLoop executes `message.content.filter(c => c.type === "toolCall")` on the
	// message the stream fn just returned. Our messages are appended to the transcript
	// AFTER that message exists, so the loop never sees them as output. Encode the
	// invariant we rely on: the claude-cli transport must never emit toolCall content.
	const [assistant] = buildHarnessToolMessages(rec(), MODEL) as any[];
	assert.equal(assistant.content[0].type, "toolCall");
	assert.equal(assistant.stopReason, "toolUse");
	// Guard: this message is only ever produced HERE, and only appended post-turn.
	// If a future change routes it through the stream fn, Pi would re-run the tool.
	assert.ok(!("streamed" in assistant), "never marked as stream output");
});

test("PAYOFF: the next turn's replayed context now shows what the harness did", () => {
	// Simulate a session AFTER the merge, then serialize it the way the claude-cli
	// transport does when it re-feeds history to the binary on the following turn.
	const messages: any[] = [{ role: "user", content: "write hello.txt" }];
	messages.push(...(buildHarnessToolMessages(rec({ toolName: "write", args: { path: "hello.txt" }, content: [{ type: "text", text: "wrote 5 bytes" }] }), MODEL) as any[]));
	messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }] });
	messages.push({ role: "user", content: "what did you just do?" });

	const prompt = serializeConversationPrompt(messages);
	assert.match(prompt, /\[called tool: write\]/, "the model sees that it called a tool");
	assert.match(prompt, /\[write result\]: wrote 5 bytes/, "…and what came back");
	assert.match(prompt, /Current message:\n\nwhat did you just do\?/);
});
