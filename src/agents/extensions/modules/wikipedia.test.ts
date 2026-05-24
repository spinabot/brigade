/**
 * Tests for the Wikipedia provider — keyless gating + MediaWiki snippet
 * markup stripper.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createWikipediaSearchProvider, stripMwMarkup } from "./wikipedia.js";

describe("createWikipediaSearchProvider", () => {
	const p = createWikipediaSearchProvider();

	it("identity + keyless", () => {
		assert.equal(p.id, "wikipedia");
		assert.equal(p.requiresCredential, false);
		assert.deepEqual(p.envVars, []);
		assert.equal(p.isConfigured({} as never, {} as never), true);
	});

	it("createTool returns a definition (no key needed)", () => {
		const def = p.createTool({ config: {} as never, env: {} as never, workspaceDir: "/tmp" });
		assert.ok(def);
		assert.match(def?.description ?? "", /Wikipedia/);
	});
});

describe("stripMwMarkup", () => {
	it("removes searchmatch wrappers but keeps text", () => {
		const raw = `Python is a <span class="searchmatch">programming</span> language.`;
		assert.equal(stripMwMarkup(raw), "Python is a programming language.");
	});

	it("decodes common HTML entities", () => {
		assert.equal(stripMwMarkup("a &amp; b &lt; c"), "a & b < c");
	});
});
