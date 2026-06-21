import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { escapeTelegramHtml, markdownToTelegramHtml, telegramHtmlIsEmpty } from "./format.js";

describe("markdownToTelegramHtml", () => {
	it("escapes &, <, > in plain text", () => {
		assert.equal(markdownToTelegramHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
	});

	it("escapeTelegramHtml escapes the three required chars (not quotes in text)", () => {
		assert.equal(escapeTelegramHtml(`<a> & "q"`), `&lt;a&gt; &amp; "q"`);
	});

	it("converts **bold** and __bold__ to <b>", () => {
		assert.equal(markdownToTelegramHtml("hi **there**"), "hi <b>there</b>");
		assert.equal(markdownToTelegramHtml("__strong__ vibes"), "<b>strong</b> vibes");
	});

	it("converts *italic* and _italic_ to <i>", () => {
		assert.equal(markdownToTelegramHtml("an *emphatic* word"), "an <i>emphatic</i> word");
		assert.equal(markdownToTelegramHtml("an _emphatic_ word"), "an <i>emphatic</i> word");
	});

	it("does not italicize underscores inside identifiers", () => {
		assert.equal(markdownToTelegramHtml("call foo_bar_baz now"), "call foo_bar_baz now");
	});

	it("converts ~~strike~~ to <s> and ||spoiler|| to <tg-spoiler>", () => {
		assert.equal(markdownToTelegramHtml("~~gone~~"), "<s>gone</s>");
		assert.equal(markdownToTelegramHtml("||secret||"), "<tg-spoiler>secret</tg-spoiler>");
	});

	it("renders inline `code` verbatim + escaped, with NO emphasis inside", () => {
		assert.equal(markdownToTelegramHtml("run `a < b && *x*`"), "run <code>a &lt; b &amp;&amp; *x*</code>");
	});

	it("renders a fenced block as <pre><code class=language-..> with escaping", () => {
		const md = ["```ts", "const x = a < b && c > d;", "```"].join("\n");
		assert.equal(
			markdownToTelegramHtml(md),
			'<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>',
		);
	});

	it("renders a fence with no language as plain <pre><code>", () => {
		const md = ["```", "plain code", "```"].join("\n");
		assert.equal(markdownToTelegramHtml(md), "<pre><code>plain code</code></pre>");
	});

	it("renders an unterminated fence with what it captured", () => {
		const md = ["```", "line one", "line two"].join("\n");
		assert.equal(markdownToTelegramHtml(md), "<pre><code>line one\nline two</code></pre>");
	});

	it("converts [label](url) to a safe <a href>", () => {
		assert.equal(
			markdownToTelegramHtml("see [docs](https://example.com/a?b=1&c=2)"),
			'see <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
		);
	});

	it("escapes a double-quote inside the href attribute", () => {
		assert.equal(
			markdownToTelegramHtml(`[x](https://e.com/")`),
			'<a href="https://e.com/&quot;">x</a>',
		);
	});

	it("leaves a non-http link literal (never emits a bad href)", () => {
		// javascript: / file paths must not linkify.
		assert.equal(markdownToTelegramHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
		assert.equal(markdownToTelegramHtml("see [readme](./README.md)"), "see [readme](./README.md)");
	});

	it("converts ATX headings to a bold line", () => {
		assert.equal(markdownToTelegramHtml("# Title\nbody"), "<b>Title</b>\nbody");
		assert.equal(markdownToTelegramHtml("### sub *x*"), "<b>sub <i>x</i></b>");
	});

	it("converts bullet markers to • and renders inline markup", () => {
		assert.equal(markdownToTelegramHtml("- one\n- **two**\n+ three\n* four"), "• one\n• <b>two</b>\n• three\n• four");
	});

	it("renders > blockquote lines into a <blockquote>", () => {
		assert.equal(markdownToTelegramHtml("> quoted\n> more"), "<blockquote>quoted\nmore</blockquote>");
	});

	it("flattens a markdown table to pipe-joined HTML rows (drops separator)", () => {
		const md = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
		assert.equal(markdownToTelegramHtml(md), ["a | b", "1 | 2", "3 | 4"].join("\n"));
	});

	it("is a no-op on plain text", () => {
		assert.equal(markdownToTelegramHtml("hello there"), "hello there");
	});

	it("returns empty string for empty input", () => {
		assert.equal(markdownToTelegramHtml(""), "");
	});
});

describe("telegramHtmlIsEmpty", () => {
	it("is true for empty / whitespace-only", () => {
		assert.equal(telegramHtmlIsEmpty(""), true);
		assert.equal(telegramHtmlIsEmpty("   \n  "), true);
	});

	it("is true for tag-only markup with no visible text", () => {
		assert.equal(telegramHtmlIsEmpty("<b></b>"), true);
		assert.equal(telegramHtmlIsEmpty("<pre><code></code></pre>"), true);
	});

	it("is false when there is visible content", () => {
		assert.equal(telegramHtmlIsEmpty("<b>hi</b>"), false);
		assert.equal(telegramHtmlIsEmpty("plain"), false);
	});

	it("treats an escaped entity as visible content", () => {
		// "&amp;" decodes to "&" which is non-space → not empty.
		assert.equal(telegramHtmlIsEmpty("&amp;"), false);
	});
});
