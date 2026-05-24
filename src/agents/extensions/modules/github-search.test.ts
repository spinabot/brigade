/**
 * Tests for the GitHub search provider — keyless gating + token sanitization.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createGithubSearchProvider, resolveGithubToken } from "./github-search.js";

describe("createGithubSearchProvider", () => {
	const p = createGithubSearchProvider();
	it("keyless + identity", () => {
		assert.equal(p.id, "github");
		assert.equal(p.requiresCredential, false);
		assert.deepEqual(p.envVars, ["GITHUB_TOKEN", "GH_TOKEN"]);
		assert.equal(p.isConfigured({} as never, {} as never), true);
	});
	it("createTool activates with no token (60/hr keyless tier)", () => {
		const def = p.createTool({ config: {} as never, env: {} as never, workspaceDir: "/tmp" });
		assert.ok(def);
	});
});

describe("resolveGithubToken", () => {
	it("env path", () => {
		assert.equal(resolveGithubToken({}, { GITHUB_TOKEN: "ghp_abc" } as never), "ghp_abc");
	});
	it("config beats env", () => {
		assert.equal(
			resolveGithubToken({ token: "ghp_cfg" }, { GITHUB_TOKEN: "ghp_env" } as never),
			"ghp_cfg",
		);
	});
	it("strips CR/LF (header-injection defense)", () => {
		const r = resolveGithubToken({}, { GITHUB_TOKEN: "ghp_x\r\nSmuggled: y" } as never);
		assert.equal(r, "ghp_xSmuggled: y");
		assert.ok(!r?.includes("\r"));
	});
	it("returns undefined when nothing set", () => {
		assert.equal(resolveGithubToken({}, {} as never), undefined);
	});
});
