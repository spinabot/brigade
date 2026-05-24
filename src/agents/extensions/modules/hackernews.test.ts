/**
 * Tests for Hacker News (Algolia) provider — keyless identity + schema.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createHackerNewsSearchProvider } from "./hackernews.js";

describe("createHackerNewsSearchProvider", () => {
	const p = createHackerNewsSearchProvider();
	it("keyless + identity", () => {
		assert.equal(p.id, "hackernews");
		assert.equal(p.requiresCredential, false);
		assert.equal(p.isConfigured({} as never, {} as never), true);
	});
	it("createTool returns a definition", () => {
		const def = p.createTool({ config: {} as never, env: {} as never, workspaceDir: "/tmp" });
		assert.ok(def);
		assert.match(def?.description ?? "", /Hacker News|Algolia/i);
	});
});
