import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { markdownToWhatsApp } from "./format.js";

describe("markdownToWhatsApp", () => {
	it("converts **bold** → *bold*", () => {
		assert.equal(markdownToWhatsApp("hello **world**"), "hello *world*");
	});

	it("converts __italic__ → _italic_", () => {
		assert.equal(markdownToWhatsApp("__strong__ vibes"), "_strong_ vibes");
	});

	it("converts headings to a bold line", () => {
		assert.equal(markdownToWhatsApp("# Title\nbody"), "*Title*\nbody");
		assert.equal(markdownToWhatsApp("### subtitle"), "*subtitle*");
	});

	it("flattens markdown links to label (url)", () => {
		assert.equal(markdownToWhatsApp("see [docs](https://example.com)"), "see docs (https://example.com)");
	});

	it("converts `- ` and `* ` list markers into bullets", () => {
		assert.equal(markdownToWhatsApp("- one\n- two\n* three"), "• one\n• two\n• three");
	});

	it("flattens a markdown table into pipe-separated lines (no separator row)", () => {
		const md = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
		assert.equal(markdownToWhatsApp(md), ["a | b", "1 | 2", "3 | 4"].join("\n"));
	});

	it("is a no-op on plain text", () => {
		assert.equal(markdownToWhatsApp("hello there"), "hello there");
	});
});
