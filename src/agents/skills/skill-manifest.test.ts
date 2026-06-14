import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseSkillCommandManifest } from "./skill-manifest.js";

describe("parseSkillCommandManifest", () => {
	it("reads flat commands + command-patterns block lists", () => {
		const m = parseSkillCommandManifest(
			[
				"name: gmail-oauth",
				"description: send gmail",
				"commands:",
				'  - "node oauth-flow.mjs"',
				'  - "node send.mjs"',
				"command-patterns:",
				'  - "^node .*gmail"',
			].join("\n"),
		);
		assert.deepEqual(m.commands, ["node oauth-flow.mjs", "node send.mjs"]);
		assert.deepEqual(m.patterns, ["^node .*gmail"]);
	});

	it("reads the nested metadata.brigade form", () => {
		const m = parseSkillCommandManifest(
			[
				"name: x",
				"description: y",
				'metadata: { "brigade": { "commands": ["curl https://api"], "commandPatterns": ["^curl "] } }',
			].join("\n"),
		);
		assert.deepEqual(m.commands, ["curl https://api"]);
		// toStrList trims, so the trailing space is dropped.
		assert.deepEqual(m.patterns, ["^curl"]);
	});

	it("accepts a single scalar command", () => {
		const m = parseSkillCommandManifest(["name: x", "description: y", "commands: node x.mjs"].join("\n"));
		assert.deepEqual(m.commands, ["node x.mjs"]);
	});

	it("de-dupes and ignores non-strings; empty when absent", () => {
		const m = parseSkillCommandManifest(
			["name: x", "description: y", "commands:", "  - a", "  - a", "  - 5"].join("\n"),
		);
		assert.deepEqual(m.commands, ["a"]);
		assert.deepEqual(parseSkillCommandManifest("name: x\ndescription: y"), { commands: [], patterns: [] });
	});

	it("never throws on malformed YAML", () => {
		assert.deepEqual(parseSkillCommandManifest(":::not yaml:::"), { commands: [], patterns: [] });
	});
});
