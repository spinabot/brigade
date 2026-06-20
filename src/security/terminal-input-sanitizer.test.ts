import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hasTerminalControlBytes, sanitizeTerminalInput } from "./terminal-input-sanitizer.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("sanitizeTerminalInput", () => {
	it("strips a DSR/CPR cursor-position response", () => {
		assert.equal(sanitizeTerminalInput(`hello${ESC}[53;1Rworld`), "helloworld");
	});
	it("strips an SGR mouse report", () => {
		assert.equal(sanitizeTerminalInput(`a${ESC}[<65;1;49Mb`), "ab");
	});
	it("strips bracketed-paste wrappers, keeping the pasted text", () => {
		assert.equal(sanitizeTerminalInput(`${ESC}[200~pasted text${ESC}[201~`), "pasted text");
	});
	it("strips OSC sequences (title / clipboard set — OSC 52)", () => {
		assert.equal(sanitizeTerminalInput(`${ESC}]0;evil title${BEL}hi`), "hi");
		assert.equal(sanitizeTerminalInput(`${ESC}]52;c;ZXZpbA==${BEL}x`), "x");
	});
	it("strips leaked literal bracketed-paste fragments", () => {
		assert.equal(sanitizeTerminalInput("[200~hello[201~"), "hello");
		assert.equal(sanitizeTerminalInput("^[[200~hi"), "hi");
	});
	it("does not over-strip embedded literal [200~ / [201~ inside ordinary text", () => {
		assert.equal(sanitizeTerminalInput("x[200~210]"), "x[200~210]");
		assert.equal(sanitizeTerminalInput("range=[200~]"), "range=[200~]");
		assert.equal(sanitizeTerminalInput("list[201~]end"), "list[201~]end");
		assert.equal(
			sanitizeTerminalInput("literal[200~tag and literal[201~tag should stay"),
			"literal[200~tag and literal[201~tag should stay",
		);
	});
	it("strips caret-notation CPR/DSR and SGR-mouse leaks", () => {
		assert.equal(sanitizeTerminalInput("typed^[[53;1Rmore"), "typedmore");
		assert.equal(sanitizeTerminalInput("typed^[[<65;1;49Mmore"), "typedmore");
	});
	it("preserves caret-prefixed prose that is not a numeric report (e.g. ^[[0m)", () => {
		assert.equal(sanitizeTerminalInput("the seq ^[[0m resets color"), "the seq ^[[0m resets color");
	});
	it("strips lone ESC bytes", () => {
		assert.equal(sanitizeTerminalInput(`a${ESC}b`), "ab");
	});
	it("replaces lone UTF-16 surrogates with U+FFFD, preserves valid pairs", () => {
		assert.equal(sanitizeTerminalInput("x\uD800y"), "x�y");
		assert.equal(sanitizeTerminalInput("😀"), "😀"); // valid surrogate pair untouched
	});
	it("leaves ordinary text untouched (prose, brackets, CJK, emoji, newlines, tabs)", () => {
		for (const s of [
			"hello world",
			"a range 200~300 is ok",
			"[hello] {world} (parens)",
			"日本語テスト 中文",
			"line1\nline2\ttab",
			"café ☕ 🚀 naïve",
		]) {
			assert.equal(sanitizeTerminalInput(s), s, `should be unchanged: ${JSON.stringify(s)}`);
		}
	});
	it("is idempotent", () => {
		const dirty = `${ESC}[200~a${ESC}[31mb${ESC}[201~`;
		const once = sanitizeTerminalInput(dirty);
		assert.equal(sanitizeTerminalInput(once), once);
		assert.equal(once, "ab");
	});
	it("hasTerminalControlBytes flags dirty vs clean", () => {
		assert.equal(hasTerminalControlBytes(`${ESC}[200~x${ESC}[201~`), true);
		assert.equal(hasTerminalControlBytes("clean text"), false);
	});
});
