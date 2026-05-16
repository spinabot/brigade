import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	createBrigadeTools,
	listBrigadeToolNames,
} from "./registry.js";

describe("createBrigadeTools — Primitive #3 v1 (framework only)", () => {
	it("returns an empty array (no Brigade-native tools ship in #3)", () => {
		const tools = createBrigadeTools({
			workspaceDir: "/home/me/.brigade/workspace",
			agentId: "main",
			cwd: "/some/cwd",
		});
		assert.equal(tools.length, 0);
		assert.ok(Array.isArray(tools));
	});

	it("does not throw on common option shapes", () => {
		// Tool-author tests will replace this when they add tools; here we
		// just verify the factory contract — accept the options bag, return
		// an array. No side-effects, no thrown errors.
		assert.doesNotThrow(() =>
			createBrigadeTools({
				workspaceDir: "C:\\Users\\me\\.brigade\\workspace",
				agentId: "main",
				cwd: "C:\\Users\\me",
			}),
		);
	});
});

describe("listBrigadeToolNames", () => {
	it("returns an empty array (no Brigade-native tools ship in #3)", () => {
		assert.deepEqual(listBrigadeToolNames(), []);
	});

	it("returns a fresh array on each call (callers may mutate)", () => {
		const a = listBrigadeToolNames();
		const b = listBrigadeToolNames();
		assert.notEqual(a, b, "different array instances");
		a.push("test-pollution");
		assert.deepEqual(listBrigadeToolNames(), [], "subsequent calls unaffected");
	});
});
