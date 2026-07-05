import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyResultFrame,
	foldUsage,
	frameSessionId,
	parseClaudeCliLine,
	type ResultFrame,
} from "./stream-json.js";

test("parseClaudeCliLine: parses a well-formed frame", () => {
	const f = parseClaudeCliLine('{"type":"system","subtype":"init","session_id":"abc"}');
	assert.equal(f?.type, "system");
	assert.equal(frameSessionId(f!), "abc");
});

test("parseClaudeCliLine: blank / non-JSON / malformed lines → null (never throws)", () => {
	assert.equal(parseClaudeCliLine(""), null);
	assert.equal(parseClaudeCliLine("   "), null);
	assert.equal(parseClaudeCliLine("debug: starting up"), null);
	assert.equal(parseClaudeCliLine('{"type":'), null);
	assert.equal(parseClaudeCliLine("[1,2,3]"), null); // not an object
	assert.equal(parseClaudeCliLine('{"no":"type"}'), null);
});

test("classifyResultFrame: success", () => {
	const f: ResultFrame = { type: "result", subtype: "success", result: "hello" };
	assert.equal(classifyResultFrame(f), "success");
});

test("classifyResultFrame: undefined subtype + no error → success", () => {
	assert.equal(classifyResultFrame({ type: "result", result: "hi" }), "success");
});

test("classifyResultFrame: out-of-extra-usage → limit", () => {
	const f: ResultFrame = {
		type: "result",
		subtype: "error_during_execution",
		is_error: true,
		error: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
	};
	assert.equal(classifyResultFrame(f), "limit");
});

test("classifyResultFrame: usage-limit phrasing anywhere → limit", () => {
	assert.equal(
		classifyResultFrame({ type: "result", subtype: "error", message: "Claude usage limit reached; limit will reset at 3am" }),
		"limit",
	);
});

test("classifyResultFrame: other error → error", () => {
	assert.equal(
		classifyResultFrame({ type: "result", subtype: "error_max_turns", is_error: true, error: "too many turns" }),
		"error",
	);
});

test("foldUsage: folds cache tokens into input", () => {
	const u = foldUsage({
		input_tokens: 10,
		output_tokens: 5,
		cache_read_input_tokens: 20,
		cache_creation_input_tokens: 3,
	});
	assert.deepEqual(u, { input: 33, output: 5 });
});

test("foldUsage: undefined → zeros", () => {
	assert.deepEqual(foldUsage(undefined), { input: 0, output: 0 });
});

test("classifyResultFrame: dead-login (401/expired/revoked) → auth", () => {
	assert.equal(classifyResultFrame({ type: "result", subtype: "error", is_error: true, error: "401 Unauthorized" }), "auth");
	assert.equal(classifyResultFrame({ type: "result", subtype: "error", is_error: true, error: "OAuth token has expired, please login again" }), "auth");
	assert.equal(classifyResultFrame({ type: "result", subtype: "error", is_error: true, message: "invalid_grant: refresh token revoked" }), "auth");
});

test("classifyResultFrame: usage-limit still wins over auth patterns", () => {
	assert.equal(classifyResultFrame({ type: "result", subtype: "error", is_error: true, error: "You're out of extra usage. Add more at claude.ai/settings/usage" }), "limit");
});
