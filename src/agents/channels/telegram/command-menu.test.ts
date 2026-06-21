import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ChannelCommand } from "../../extensions/types.js";
import { buildTelegramCommandMenu, normalizeTelegramCommandName } from "./command-menu.js";

const cmd = (name: string, description?: string): ChannelCommand => ({
	name,
	...(description !== undefined ? { description } : {}),
	handler: () => "",
});

describe("normalizeTelegramCommandName", () => {
	it("strips a leading slash + lowercases", () => {
		assert.equal(normalizeTelegramCommandName("/Help"), "help");
		assert.equal(normalizeTelegramCommandName("STATUS"), "status");
	});

	it("drops disallowed chars and keeps [a-z0-9_]", () => {
		assert.equal(normalizeTelegramCommandName("my-cmd!"), "mycmd");
		assert.equal(normalizeTelegramCommandName("agent_2"), "agent_2");
	});

	it("returns null for an empty / fully-invalid name", () => {
		assert.equal(normalizeTelegramCommandName("///"), null);
		assert.equal(normalizeTelegramCommandName("   "), null);
	});

	it("clamps to 32 chars", () => {
		const long = "a".repeat(40);
		assert.equal(normalizeTelegramCommandName(long)?.length, 32);
	});
});

describe("buildTelegramCommandMenu", () => {
	it("maps central commands to {command, description}", () => {
		const menu = buildTelegramCommandMenu([cmd("help", "Show help"), cmd("status", "Show status")]);
		assert.deepEqual(menu, [
			{ command: "help", description: "Show help" },
			{ command: "status", description: "Show status" },
		]);
	});

	it("de-dupes by normalized name (first wins)", () => {
		const menu = buildTelegramCommandMenu([cmd("Help"), cmd("/help", "dup")]);
		assert.equal(menu.length, 1);
		assert.equal(menu[0]?.command, "help");
	});

	it("falls back to the name when no description is given", () => {
		const menu = buildTelegramCommandMenu([cmd("whoami")]);
		assert.equal(menu[0]?.description, "whoami");
	});

	it("drops unusable command names", () => {
		const menu = buildTelegramCommandMenu([cmd("///"), cmd("help", "ok")]);
		assert.deepEqual(menu, [{ command: "help", description: "ok" }]);
	});

	it("caps at 100 commands", () => {
		const many = Array.from({ length: 150 }, (_, i) => cmd(`cmd_${i}`, "x"));
		assert.equal(buildTelegramCommandMenu(many).length, 100);
	});
});
