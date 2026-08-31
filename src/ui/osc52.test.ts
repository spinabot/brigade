import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOsc52, lastCodeBlock, OSC52_MAX_BYTES } from "./osc52.js";

test("builds a well-formed OSC 52 set-clipboard sequence", () => {
	const { sequence, truncated } = buildOsc52("hello");
	assert.equal(sequence, `\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
	assert.equal(truncated, false);
});

test("round-trips unicode", () => {
	const text = "héllo — 🦁 café";
	const { sequence } = buildOsc52(text);
	const b64 = sequence.slice("\x1b]52;c;".length, -1);
	assert.equal(Buffer.from(b64, "base64").toString("utf8"), text);
});

test("empty input produces no sequence", () => {
	assert.deepEqual(buildOsc52(""), { sequence: "", bytes: 0, truncated: false });
});

test("an oversized payload is truncated rather than silently dropped", () => {
	// Terminals (tmux especially) reject large OSC 52 payloads outright, so a
	// too-big copy would appear to work and do nothing.
	const { bytes, truncated } = buildOsc52("x".repeat(OSC52_MAX_BYTES * 2));
	assert.equal(truncated, true);
	assert.ok(bytes <= OSC52_MAX_BYTES);
});

test("truncation cuts on a character boundary, not mid-codepoint", () => {
	// Slicing raw bytes can split a multi-byte character and put a replacement
	// character in the operator's clipboard.
	const { sequence, truncated } = buildOsc52("🦁".repeat(OSC52_MAX_BYTES));
	assert.equal(truncated, true);
	const b64 = sequence.slice("\x1b]52;c;".length, -1);
	assert.equal(Buffer.from(b64, "base64").toString("utf8").includes("�"), false);
});

test("lastCodeBlock takes the LAST block, not the first", () => {
	const md = "intro\n```sh\nfirst\n```\nmiddle\n```js\nconst x = 1;\n```\nend";
	assert.equal(lastCodeBlock(md), "const x = 1;");
});

test("lastCodeBlock handles a block with no language tag", () => {
	assert.equal(lastCodeBlock("```\nplain\n```"), "plain");
});

test("lastCodeBlock returns undefined when there is no block", () => {
	// So the caller falls back to copying the whole reply.
	assert.equal(lastCodeBlock("just prose"), undefined);
	assert.equal(lastCodeBlock(""), undefined);
	assert.equal(lastCodeBlock("```\n\n```"), undefined, "an empty block is not a block");
});

test("consecutive blocks stay separate", () => {
	assert.equal(lastCodeBlock("```\na\n```\n```\nb\n```"), "b");
});
