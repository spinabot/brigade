/**
 * Searching the conversation you are in.
 *
 * Brigade's TUI does not own a scrollable viewport — it appends into the
 * terminal's own scrollback — so there is no "jump to message" to implement.
 * Search RENDERS the matches instead, which for the thing people actually look
 * for ("what was that path", "what did the error say") beats scrolling to it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WireMessage } from "../protocol.js";
import { searchTranscript } from "./transcript-search.js";

const user = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (content: unknown[]): WireMessage =>
	({ role: "assistant", content }) as WireMessage;
const toolResult = (toolName: string, text: string): WireMessage =>
	({ role: "toolResult", toolName, content: [{ type: "text", text }] }) as WireMessage;

test("finds prose and reports where it was", () => {
	const r = searchTranscript([user("fix the parser"), assistant([{ type: "text", text: "done" }])], "parser");
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0]!.index, 0);
	assert.equal(r.hits[0]!.role, "user");
	assert.equal(r.hits[0]!.where, "text");
});

test("searches TOOL RESULTS — where the answer usually is", () => {
	// "what was that error" and "which file did it read" live in tool output. A
	// search that skipped it would miss the most common question.
	const r = searchTranscript(
		[toolResult("bash", "TypeError: cannot read x at src/core/server.ts:42")],
		"TypeError",
	);
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0]!.where, "tool-result");
	assert.equal(r.hits[0]!.toolName, "bash");
});

test("searches tool CALLS and their arguments", () => {
	const r = searchTranscript(
		[assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/app.ts" } }])],
		"app.ts",
	);
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0]!.where, "tool-call");
	assert.equal(r.hits[0]!.toolName, "read");
});

test("thinking is NOT searched", () => {
	// The model's scratch is not the conversation — same reason it is excluded
	// from exports by default.
	const r = searchTranscript(
		[assistant([{ type: "thinking", thinking: "SECRET-SCRATCH" }, { type: "text", text: "ok" }])],
		"SECRET-SCRATCH",
	);
	assert.equal(r.hits.length, 0);
});

test("the snippet highlights the right span", () => {
	const r = searchTranscript([user("the error was in the parser module")], "parser");
	const h = r.hits[0]!;
	assert.equal(h.snippet.slice(h.matchStart, h.matchEnd), "parser");
});

test("a long line is clipped with ellipses on both sides", () => {
	const long = `${"a".repeat(500)} NEEDLE ${"b".repeat(500)}`;
	const h = searchTranscript([user(long)], "NEEDLE").hits[0]!;
	assert.ok(h.snippet.length < 200, `snippet was ${h.snippet.length} chars`);
	assert.ok(h.snippet.startsWith("…"));
	assert.ok(h.snippet.endsWith("…"));
	assert.equal(h.snippet.slice(h.matchStart, h.matchEnd), "NEEDLE");
});

test("case-insensitive by default, case-sensitive on request", () => {
	const msgs = [user("The Parser failed")];
	assert.equal(searchTranscript(msgs, "parser").hits.length, 1);
	assert.equal(searchTranscript(msgs, "parser", { caseSensitive: true }).hits.length, 0);
	assert.equal(searchTranscript(msgs, "Parser", { caseSensitive: true }).hits.length, 1);
});

test("a literal query with regex characters is not a regex by default", () => {
	// `(` is a perfectly ordinary thing to look for in a transcript full of code.
	const r = searchTranscript([user("call foo(bar) now")], "foo(bar)");
	assert.equal(r.hits.length, 1);
	assert.equal(r.usedRegex, false);
});

test("an INVALID regex falls back to literal instead of throwing", () => {
	// The operator typed a query, not a program.
	const r = searchTranscript([user("a ( b")], "(", { regex: true });
	assert.equal(r.usedRegex, false, "reported honestly as a literal search");
	assert.equal(r.hits.length, 1);
});

test("a valid regex is honoured when asked for", () => {
	const r = searchTranscript([user("err code 4041 here")], String.raw`code \d+`, { regex: true });
	assert.equal(r.usedRegex, true);
	assert.equal(r.hits[0]!.snippet.slice(r.hits[0]!.matchStart, r.hits[0]!.matchEnd), "code 4041");
});

test("a zero-width match cannot hang the search", () => {
	// `a*` matches the empty string at every position; without advancing
	// lastIndex this loops forever.
	const r = searchTranscript([user("aaa bbb")], "a*", { regex: true, limit: 5 });
	assert.ok(r.hits.length <= 5);
});

test("results are capped so a common word cannot flood the scrollback", () => {
	const msgs = Array.from({ length: 200 }, () => user("the the the"));
	const r = searchTranscript(msgs, "the", { limit: 10 });
	assert.equal(r.hits.length, 10);
	assert.equal(r.truncated, true, "and it says it was capped");
});

test("hits come back oldest-first, matching the conversation above", () => {
	const msgs = [user("needle one"), user("nothing"), user("needle two")];
	const idx = searchTranscript(msgs, "needle").hits.map((h) => h.index);
	assert.deepEqual(idx, [0, 2]);
});

test("an empty or whitespace query returns nothing rather than everything", () => {
	const msgs = [user("anything")];
	assert.equal(searchTranscript(msgs, "").hits.length, 0);
	assert.equal(searchTranscript(msgs, "   ").hits.length, 0);
});

test("malformed messages do not throw", () => {
	const junk = [null, undefined, 42, { role: "user" }, { role: "user", content: 7 }] as unknown as WireMessage[];
	assert.doesNotThrow(() => searchTranscript(junk, "x"));
});
