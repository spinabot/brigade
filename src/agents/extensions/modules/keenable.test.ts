/**
 * Tests for the Keenable provider — keyless gating, endpoint selection,
 * snippet fallback. Network paths not exercised.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildKeenableRequest, createKeenableSearchProvider, pickKeenableSnippet } from "./keenable.js";

describe("createKeenableSearchProvider", () => {
	const p = createKeenableSearchProvider();

	it("identity + keyless + sorts after DuckDuckGo", () => {
		assert.equal(p.id, "keenable");
		assert.equal(p.requiresCredential, false);
		assert.equal(p.isConfigured({} as never, {} as never), true);
		assert.ok((p.autoDetectOrder ?? 0) > 100);
	});

	it("createTool returns a definition without a key", () => {
		const def = p.createTool({ config: {} as never, env: {} as never, workspaceDir: "/tmp" });
		assert.ok(def);
	});
});

describe("buildKeenableRequest", () => {
	it("uses the public endpoint without a key", () => {
		const { url, headers } = buildKeenableRequest(undefined);
		assert.equal(url, "https://api.keenable.ai/v1/search/public");
		assert.equal(headers["x-api-key"], undefined);
		assert.equal(headers["x-keenable-title"], "Brigade");
	});

	it("uses the keyed endpoint with a key", () => {
		const { url, headers } = buildKeenableRequest("k-123");
		assert.equal(url, "https://api.keenable.ai/v1/search");
		assert.equal(headers["x-api-key"], "k-123");
	});
});

describe("pickKeenableSnippet", () => {
	it("prefers description, else truncates snippet", () => {
		assert.equal(pickKeenableSnippet({ description: "short", snippet: "long" }), "short");
		const s = pickKeenableSnippet({ snippet: "x".repeat(1_500) }) ?? "";
		assert.equal(s.length, 1_001);
		assert.equal(pickKeenableSnippet({}), undefined);
	});
});
