/**
 * Tests for npm registry provider — keyless identity + schema.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createNpmSearchProvider } from "./npm-search.js";

describe("createNpmSearchProvider", () => {
	const p = createNpmSearchProvider();
	it("keyless + identity", () => {
		assert.equal(p.id, "npm");
		assert.equal(p.requiresCredential, false);
		assert.equal(p.isConfigured({} as never, {} as never), true);
	});
	it("createTool returns a definition", () => {
		const def = p.createTool({ config: {} as never, env: {} as never, workspaceDir: "/tmp" });
		assert.ok(def);
		assert.match(def?.description ?? "", /npm/);
	});
});
