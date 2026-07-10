// A `spawn_agent` can run for a minute. The operator's terminal must show that a
// child turn is working — not go silent and look wedged.
//
// This regressed invisibly once: `consoleStream.pi()` is wired inside
// `attachTurnSession`, which is only ever called for a depth-0 gateway turn. Sub-agent
// turns streamed to attached WS clients and printed nothing to the gateway console,
// so the log jumped straight from "sub-agent starting" to "sub-agent settled" 57
// seconds later with nothing in between.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { createConsoleStream } from "./console-stream.js";

function capture(level: "info" | "debug" = "debug") {
	const lines: string[] = [];
	const stream = createConsoleStream({ level, color: false, write: (l) => lines.push(l) });
	return { stream, lines };
}

const toolStart = { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } } as unknown as AgentSessionEvent;

test("a depth-0 event prints unindented, with no child marker", () => {
	const { stream, lines } = capture();
	stream.pi(toolStart);
	assert.equal(lines.length, 1);
	assert.match(lines[0] as string, /tool_start/);
	assert.equal((lines[0] as string).includes("↳"), false);
});

test("a sub-agent event is printed, marked and indented by depth", () => {
	const { stream, lines } = capture();
	stream.pi(toolStart, 1);
	assert.equal(lines.length, 1, "the child's work must reach the operator's terminal");
	assert.match(lines[0] as string, /↳/, "marked as a child turn");
	assert.match(lines[0] as string, /tool_start/);

	stream.pi(toolStart, 2);
	assert.ok(
		(lines[1] as string).indexOf("↳") > (lines[0] as string).indexOf("↳"),
		"depth 2 indents further than depth 1",
	);
});

test("an explicit depth of 0 is treated as top level", () => {
	const { stream, lines } = capture();
	stream.pi(toolStart, 0);
	assert.equal((lines[0] as string).includes("↳"), false);
});

test("a child's token deltas stay behind the same noise gate as the parent's", () => {
	// `message_update` fires once per delta. It floods a terminal, so it is debug-only —
	// and that must hold for sub-agents too, or one `spawn_agent` drowns the log.
	const quiet = capture("info");
	quiet.stream.pi({ type: "message_update" } as unknown as AgentSessionEvent, 1);
	assert.deepEqual(quiet.lines, [], "suppressed at info, exactly as at depth 0");

	const loud = capture("debug");
	loud.stream.pi({ type: "message_update" } as unknown as AgentSessionEvent, 1);
	assert.equal(loud.lines.length, 1, "…and visible at debug");
	assert.match(loud.lines[0] as string, /↳/);
});
