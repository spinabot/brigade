import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { escapeSlackMrkdwn, markdownToSlackMrkdwn, slackMrkdwnIsEmpty } from "./format.js";

describe("markdownToSlackMrkdwn", () => {
	it("escapes &, <, > in plain text", () => {
		assert.equal(markdownToSlackMrkdwn("a & b < c > d"), "a &amp; b &lt; c &gt; d");
	});

	it("escapeSlackMrkdwn escapes the three required chars (not quotes)", () => {
		assert.equal(escapeSlackMrkdwn(`<a> & "q"`), `&lt;a&gt; &amp; "q"`);
	});

	it("converts **bold** and __bold__ to Slack *bold*", () => {
		assert.equal(markdownToSlackMrkdwn("hi **there**"), "hi *there*");
		assert.equal(markdownToSlackMrkdwn("__strong__ vibes"), "*strong* vibes");
	});

	it("converts *italic* and _italic_ to Slack _italic_", () => {
		assert.equal(markdownToSlackMrkdwn("an *emphatic* word"), "an _emphatic_ word");
		assert.equal(markdownToSlackMrkdwn("an _emphatic_ word"), "an _emphatic_ word");
	});

	it("does not italicize underscores inside identifiers", () => {
		assert.equal(markdownToSlackMrkdwn("call foo_bar_baz now"), "call foo_bar_baz now");
	});

	it("converts ~~strike~~ to Slack ~strike~", () => {
		assert.equal(markdownToSlackMrkdwn("~~gone~~"), "~gone~");
	});

	it("renders inline `code` verbatim + escaped, with NO emphasis inside", () => {
		assert.equal(markdownToSlackMrkdwn("run `a < b && *x*`"), "run `a &lt; b &amp;&amp; *x*`");
	});

	it("renders a fenced block as ``` with lang dropped + interior escaped", () => {
		const md = ["```ts", "const x = a < b && c > d;", "```"].join("\n");
		assert.equal(markdownToSlackMrkdwn(md), "```\nconst x = a &lt; b &amp;&amp; c &gt; d;\n```");
	});

	it("renders an unterminated fence with what it captured", () => {
		const md = ["```", "line one", "line two"].join("\n");
		assert.equal(markdownToSlackMrkdwn(md), "```\nline one\nline two\n```");
	});

	it("converts [label](url) to a Slack <url|label> link", () => {
		assert.equal(
			markdownToSlackMrkdwn("see [docs](https://example.com/a?b=1&c=2)"),
			"see <https://example.com/a?b=1&c=2|docs>",
		);
	});

	it("leaves a non-http link literal (never emits a bad token)", () => {
		assert.equal(markdownToSlackMrkdwn("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
		assert.equal(markdownToSlackMrkdwn("see [readme](./README.md)"), "see [readme](./README.md)");
	});

	it("converts ATX headings to a bold line", () => {
		assert.equal(markdownToSlackMrkdwn("# Title\nbody"), "*Title*\nbody");
		assert.equal(markdownToSlackMrkdwn("### sub *x*"), "*sub _x_*");
	});

	it("converts bullet markers to • and renders inline markup", () => {
		assert.equal(markdownToSlackMrkdwn("- one\n- **two**\n+ three\n* four"), "•  one\n•  *two*\n•  three\n•  four");
	});

	it("renders > blockquote lines with a Slack > prefix", () => {
		assert.equal(markdownToSlackMrkdwn("> quoted\n> more"), "> quoted\n> more");
	});

	it("flattens a markdown table to pipe-joined rows (drops separator)", () => {
		const md = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
		assert.equal(markdownToSlackMrkdwn(md), ["a | b", "1 | 2", "3 | 4"].join("\n"));
	});

	it("is a no-op on plain text", () => {
		assert.equal(markdownToSlackMrkdwn("hello there"), "hello there");
	});

	it("returns empty string for empty input", () => {
		assert.equal(markdownToSlackMrkdwn(""), "");
	});
});

describe("slackMrkdwnIsEmpty", () => {
	it("is true for empty / whitespace-only / marker-only", () => {
		assert.equal(slackMrkdwnIsEmpty(""), true);
		assert.equal(slackMrkdwnIsEmpty("   \n  "), true);
		assert.equal(slackMrkdwnIsEmpty("** __"), true);
	});

	it("is false when there is visible content", () => {
		assert.equal(slackMrkdwnIsEmpty("*hi*"), false);
		assert.equal(slackMrkdwnIsEmpty("plain"), false);
	});

	it("treats a link label / mention as visible content", () => {
		assert.equal(slackMrkdwnIsEmpty("<https://e.com|docs>"), false);
		assert.equal(slackMrkdwnIsEmpty("<@U123>"), false);
	});
});
