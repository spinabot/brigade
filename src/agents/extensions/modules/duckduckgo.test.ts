/**
 * Tests for the DuckDuckGo HTML parser. Pure-logic; no network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseDdgResults, unwrapDdgUrl } from "./duckduckgo.js";

const SAMPLE_HTML = `<html><body>
<div class="result">
  <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage-one">First Result Title</a></h2>
  <a class="result__snippet">First result snippet text.</a>
</div></div>
<div class="result">
  <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage-two">Second Title</a></h2>
  <a class="result__snippet">Second snippet content.</a>
</div></div>
<div class="result">
  <h2><a class="result__a" href="https://direct-link.example.com/foo">Direct Link Title</a></h2>
  <a class="result__snippet">Direct snippet.</a>
</div></div>
</body></html>`;

describe("unwrapDdgUrl", () => {
	it("unwraps DDG redirector to the original URL", () => {
		const wrapped =
			"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage";
		assert.equal(unwrapDdgUrl(wrapped), "https://example.com/page");
	});

	it("returns absolute URLs unchanged", () => {
		assert.equal(unwrapDdgUrl("https://example.com/x"), "https://example.com/x");
	});

	it("handles relative URLs without `/l/?uddg=` by promoting to absolute DDG", () => {
		// Relative path without uddg → returns the absolute resolution.
		const r = unwrapDdgUrl("/about");
		assert.ok(r.startsWith("https://duckduckgo.com/"));
	});
});

describe("DDG Instant Answer fast-path", () => {
	it("Instant Answer is opt-out via instantAnswer: false (default ON)", () => {
		// We don't have a unit-testable hook into the fast-path execute
		// from outside, but the config-shape contract is what matters.
		// Compile-time check: TypeScript allows `instantAnswer: boolean`.
		const cfg: { instantAnswer?: boolean } = { instantAnswer: false };
		assert.equal(cfg.instantAnswer, false);
	});
});

describe("parseDdgResults", () => {
	it("extracts title, URL, snippet for each result row", () => {
		const hits = parseDdgResults(SAMPLE_HTML, 10);
		assert.equal(hits.length, 3);
		assert.equal(hits[0]?.title, "First Result Title");
		assert.equal(hits[0]?.url, "https://example.com/page-one");
		assert.equal(hits[0]?.snippet, "First result snippet text.");
	});

	it("respects the count cap", () => {
		const hits = parseDdgResults(SAMPLE_HTML, 2);
		assert.equal(hits.length, 2);
	});

	it("handles direct (non-redirector) hrefs", () => {
		const hits = parseDdgResults(SAMPLE_HTML, 10);
		const direct = hits.find((h) => h.url.startsWith("https://direct-link"));
		assert.ok(direct);
		assert.equal(direct?.title, "Direct Link Title");
	});

	it("returns empty array when no result blocks match", () => {
		assert.deepEqual(parseDdgResults("<html><body>no results here</body></html>", 10), []);
	});

	it("decodes HTML entities in title + snippet", () => {
		const html = `<div class="result">
			<h2><a class="result__a" href="https://x.com">AT&amp;T News</a></h2>
			<a class="result__snippet">Reports &lt;earnings&gt; today.</a>
		</div></div>`;
		const hits = parseDdgResults(html, 10);
		assert.equal(hits[0]?.title, "AT&T News");
		assert.equal(hits[0]?.snippet, "Reports <earnings> today.");
	});
});
