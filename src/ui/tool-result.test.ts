import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { summarizeToolResult } from "./tool-result.js";

describe("summarizeToolResult — success mode", () => {
	it("collapses whitespace to a single line", () => {
		const r = summarizeToolResult("line1\nline2\nline3");
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, false);
		assert.equal(r.preview, "line1 line2 line3");
	});

	it("previews only the FIRST PARAGRAPH — a blank line means prose, not output", () => {
		// Collapsing the whole result turned a 5,814-char `spawn_agent` reply into a
		// one-line mash that cut through the middle of a sentence two paragraphs down.
		const r = summarizeToolResult("Verdict: ship it.\n\nHere is the long reasoning that follows, at length…");
		assert.equal(r.preview, "Verdict: ship it.");
		assert.equal(r.multiline, false);
	});

	it("output-shaped results (no blank line) still collapse whole", () => {
		const r = summarizeToolResult("total 12\ndrwxr-xr-x  a\n-rw-r--r--  b");
		assert.equal(r.preview, "total 12 drwxr-xr-x a -rw-r--r-- b");
	});

	it("a result that OPENS with a blank line still previews its content", () => {
		const r = summarizeToolResult("\n\nActual content here.");
		assert.equal(r.preview, "Actual content here.");
		assert.equal(r.hasContent, true);
	});

	it("truncates at 120 chars with ellipsis", () => {
		const r = summarizeToolResult("x".repeat(200));
		assert.equal(r.preview.length, 120);
		assert.match(r.preview, /…$/);
	});

	it("returns empty when result is null/empty", () => {
		assert.equal(summarizeToolResult(null).hasContent, false);
		assert.equal(summarizeToolResult("   ").hasContent, false);
	});

	it("extracts text from {content: string} (Brigade AgentTool shape)", () => {
		const r = summarizeToolResult({ content: "hello", details: { x: 1 } });
		assert.equal(r.preview, "hello");
	});

	it("extracts text from MCP-style array blocks", () => {
		const r = summarizeToolResult([
			{ type: "text", text: "alpha" },
			{ type: "text", text: "beta" },
		]);
		assert.equal(r.preview, "alpha beta");
	});
});

describe("summarizeToolResult — error mode (preserveNewlines)", () => {
	it("preserves newlines so multi-line block reasons stay readable", () => {
		const blockReason =
			'Tool "bash" was blocked: command "ls" is not on the exec-approvals allowlist. ' +
			"The operator must run\n" +
			'  brigade exec allow "ls"\n' +
			'(or `brigade exec allow-pattern <regex>` for a family of commands) before this command can execute.';
		const r = summarizeToolResult(blockReason, { preserveNewlines: true });
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, true);
		// The full "brigade exec allow" line MUST be in the output — that's the
		// whole point of error-mode preservation.
		assert.match(r.preview, /brigade exec allow "ls"/);
		// Newlines preserved
		assert.ok(r.preview.includes("\n"));
	});

	it("uses an 800-char budget in error mode (not 120)", () => {
		const longError = "x".repeat(500);
		const r = summarizeToolResult(longError, { preserveNewlines: true });
		assert.equal(r.preview.length, 500);
		assert.equal(r.multiline, false);
	});

	it("truncates at 800 chars when error reason is even longer", () => {
		const longError = "x".repeat(2000);
		const r = summarizeToolResult(longError, { preserveNewlines: true });
		assert.equal(r.preview.length, 800);
		assert.match(r.preview, /…$/);
	});

	it("collapses to single-line when error has no newlines", () => {
		const r = summarizeToolResult("short error", { preserveNewlines: true });
		assert.equal(r.multiline, false);
		assert.equal(r.preview, "short error");
	});

	it("trims outer whitespace but keeps indentation on non-first lines", () => {
		// `replace(/^\s+|\s+$/g, "")` strips leading whitespace through to
		// the first non-whitespace char and trailing whitespace from the
		// last non-whitespace char — that's what we want for block reasons
		// (the call-to-action's indentation on subsequent lines stays).
		const r = summarizeToolResult("\n  intro line\n  brigade exec allow X\n", {
			preserveNewlines: true,
		});
		assert.equal(r.preview, "intro line\n  brigade exec allow X");
		assert.equal(r.multiline, true);
	});
});

describe("summarizeToolResult — AgentToolResult envelope (Pi shape)", () => {
	it("peels the {content: [{type:'text',text:'...'}]} envelope and shows just the inner text", () => {
		// Regression: the TUI used to dump the raw JSON envelope verbatim:
		//   ✓ bash · {"content":[{"type":"text","text":"DIR\tagents..."}],"details":{}}
		// because the object branch fell through to `JSON.stringify(result)`.
		const result = {
			content: [{ type: "text", text: "DIR\tagents\t156\t8\t1.4 MB" }],
			details: {},
		};
		const r = summarizeToolResult(result);
		assert.equal(r.preview, "DIR agents 156 8 1.4 MB");
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, false);
		assert.ok(!r.preview.includes('"content"'));
		assert.ok(!r.preview.includes('"text"'));
	});

	it("concatenates multiple text blocks in the envelope", () => {
		const result = {
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
			details: {},
		};
		const r = summarizeToolResult(result);
		assert.equal(r.preview, "first second");
	});

	it("represents image blocks as `[image <mime>]` placeholders", () => {
		const result = {
			content: [
				{ type: "text", text: "the image is:" },
				{ type: "image", mimeType: "image/png", data: "base64..." },
			],
		};
		const r = summarizeToolResult(result);
		assert.equal(r.preview, "the image is: [image image/png]");
	});

	it("preserves newlines in envelope text when in error mode", () => {
		const result = {
			content: [{ type: "text", text: "line one\nline two" }],
		};
		const r = summarizeToolResult(result, { preserveNewlines: true });
		assert.equal(r.preview, "line one\nline two");
		assert.equal(r.multiline, true);
	});
});

describe("summarizeToolResult — opts.maxLength override", () => {
	it("respects an explicit maxLength in success mode", () => {
		const r = summarizeToolResult("a".repeat(50), { maxLength: 10 });
		assert.equal(r.preview.length, 10);
	});

	it("respects an explicit maxLength in error mode", () => {
		const r = summarizeToolResult("a".repeat(50), { preserveNewlines: true, maxLength: 10 });
		assert.equal(r.preview.length, 10);
	});
});
