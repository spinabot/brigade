/**
 * Rendering a transcript to something a person can read and attach.
 *
 * The source is `ResumeSnapshot.messages` — the same array the TUI renders — so
 * export is a pure function of what is already on the wire.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WireMessage } from "../protocol.js";
import { exportFileName, renderTranscriptMarkdown } from "./transcript-export.js";

const AT = new Date("2026-08-31T12:34:56.000Z");
const render = (m: WireMessage[], o = {}) =>
	renderTranscriptMarkdown(m, { now: () => AT, ...o });

const user = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (content: unknown[]): WireMessage =>
	({ role: "assistant", content }) as WireMessage;
const toolResult = (toolName: string, text: string, isError = false): WireMessage =>
	({ role: "toolResult", toolName, isError, content: [{ type: "text", text }] }) as WireMessage;

test("a conversation renders as readable markdown", () => {
	const md = render([
		user("fix the failing test"),
		assistant([{ type: "text", text: "Looking at it now." }]),
	]);
	assert.match(md, /^# Brigade transcript/m);
	assert.match(md, /fix the failing test/);
	assert.match(md, /Looking at it now\./);
	assert.match(md, /### 🧑 User/);
	assert.match(md, /### 🤖 Assistant/);
});

test("the header warns that redaction is not a guarantee", () => {
	// The reader who assumes it is exhaustive is exactly who this line is for.
	assert.match(render([user("hi")]), /read before sharing/i);
});

test("the timestamp is ISO, never a locale format", () => {
	// An export is a file that travels; a locale date renders differently on the
	// reader's machine and makes two exports of the same session differ.
	assert.match(render([user("hi")]), /2026-08-31T12:34:56\.000Z/);
});

test("tool CALLS are named with their arguments", () => {
	// "we already ran this" is most of what makes a transcript useful later.
	const md = render([
		assistant([
			{ type: "text", text: "Running the tests." },
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
		]),
	]);
	assert.match(md, /→ bash/);
	assert.match(md, /npm test/);
});

test("tool RESULTS are truncated by default and whole with `full`", () => {
	const big = "x".repeat(9_000);
	const brief = render([toolResult("bash", big)]);
	assert.ok(brief.length < 5_000, "default export must not carry every byte of tool output");
	assert.match(brief, /more characters truncated/);
	assert.match(brief, /\/export full/, "and it says how to get the rest");

	const whole = render([toolResult("bash", big)], { full: true });
	assert.ok(whole.includes(big), "`full` keeps it");
});

test("thinking is excluded by default and included on request", () => {
	// The model's scratch is the largest thing in a reasoning transcript and the
	// part an operator is least likely to want published.
	const msgs = [
		assistant([
			{ type: "thinking", thinking: "SECRET-SCRATCHPAD" },
			{ type: "text", text: "the answer" },
		]),
	];
	assert.equal(render(msgs).includes("SECRET-SCRATCHPAD"), false);
	const withIt = render(msgs, { includeThinking: true });
	assert.match(withIt, /SECRET-SCRATCHPAD/);
	assert.match(withIt, /<details>/, "folded away so it does not dominate the read");
});

test("an errored tool result is visually distinct", () => {
	assert.match(render([toolResult("bash", "boom", true)]), /✗ bash/);
	assert.match(render([toolResult("bash", "ok")]), /← bash/);
});

test("content containing code fences cannot break out of its block", () => {
	// Tool output is full of markdown. A naive three-backtick fence would let a
	// result terminate its own block and corrupt everything after it.
	const md = render([toolResult("read", "```js\nconst x = 1;\n```")]);
	const opener = md.match(/`{4,}/);
	assert.ok(opener, "the fence must grow past the longest run inside the content");
});

test("empty and contentless messages are skipped, not rendered blank", () => {
	const md = render([
		user(""),
		{ role: "assistant", content: [] } as WireMessage,
		user("real message"),
	]);
	assert.equal((md.match(/### 🧑 User/g) ?? []).length, 1);
	assert.equal(md.includes("### 🤖 Assistant"), false);
});

test("an unknown role does not throw or leak a raw object", () => {
	const md = render([{ role: "mystery", content: "x" } as WireMessage, user("hi")]);
	assert.match(md, /hi/);
	assert.equal(md.includes("[object Object]"), false);
});

test("output is deterministic — the same transcript exports byte-identically", () => {
	const msgs = [user("a"), assistant([{ type: "text", text: "b" }])];
	assert.equal(render(msgs), render(msgs));
});

test("the file ends with exactly one newline", () => {
	const md = render([user("hi")]);
	assert.match(md, /\n$/);
	assert.equal(md.endsWith("\n\n"), false);
});

/* ─────────────────── filenames ─────────────────── */

test("the filename is sortable and safe on every platform", () => {
	const name = exportFileName("agent:main:main", AT);
	// Colons are illegal in Windows filenames and Brigade session keys are full
	// of them.
	assert.equal(name.includes(":"), false);
	assert.match(name, /^brigade-agent-main-main-2026-08-31T12-34-56-000\.md$/);
	assert.equal(name.split(".").length, 2, "exactly one dot — the extension");
});

test("filenames from different sessions do not collide", () => {
	assert.notEqual(exportFileName("agent:main:main", AT), exportFileName("agent:ops:main", AT));
});

test("a missing or hostile session key still yields a usable name", () => {
	assert.match(exportFileName(undefined, AT), /^brigade-session-/);
	const nasty = exportFileName("../../etc/passwd", AT);
	assert.equal(nasty.includes("/"), false, "no path traversal through the filename");
	assert.equal(nasty.includes(".."), false);
});

test("a private key in tool output is redacted even in the DEFAULT (clipped) export", () => {
	// Truncation used to run first. The PEM rule is anchored on the END marker,
	// so clipping a 3 KB key at 2000 chars removed the anchor, the rule stopped
	// matching, and the default export wrote key material in the clear while
	// reporting "no secrets matched". `/export full` was the only safe mode.
	const pem = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA".repeat(200)}\n-----END RSA PRIVATE KEY-----`;
	const md = render([toolResult("read", pem)], {
		redact: (t: string) => (t.includes("PRIVATE KEY") ? "[redacted private key block]" : t),
	});
	assert.equal(md.includes("MIIEowIBAAKCAQEA"), false, "no key material in a clipped export");
	assert.match(md, /redacted private key block/);
});

test("redaction runs before truncation, not after", () => {
	// The ordering assertion itself: the redactor must see the WHOLE body.
	let sawLength = 0;
	render([toolResult("read", "x".repeat(9000))], {
		redact: (t: string) => {
			sawLength = t.length;
			return t;
		},
	});
	assert.equal(sawLength, 9000, "the redactor saw a clipped body — ordering is wrong");
});

/* ─────────────────────────────────────────────────────────────────────────
 * `includeThinking` was supported by this renderer from the day it was
 * written, and no caller ever passed it — so reasoning could not be exported
 * at all. A code-quality bot caught the flag being parsed in the TUI and
 * dropped on the floor, which is the same "built but never called" shape this
 * whole batch of work exists to remove.
 * ───────────────────────────────────────────────────────────────────────── */

test("reasoning is excluded by default", () => {
	const md = renderTranscriptMarkdown(
		[
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET-CHAIN-OF-THOUGHT" },
					{ type: "text", text: "the answer" },
				],
			} as never,
		],
		{ now: () => new Date(0) },
	);
	assert.ok(!md.includes("SECRET-CHAIN-OF-THOUGHT"), "thinking must not leak into a default export");
	assert.match(md, /the answer/);
});

test("reasoning is included when asked for, and the banner says so", () => {
	const md = renderTranscriptMarkdown(
		[
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET-CHAIN-OF-THOUGHT" },
					{ type: "text", text: "the answer" },
				],
			} as never,
		],
		{ includeThinking: true, now: () => new Date(0) },
	);
	assert.match(md, /SECRET-CHAIN-OF-THOUGHT/);
	assert.match(md, /Includes the model's reasoning/, "the artifact must disclose what it carries");
});
