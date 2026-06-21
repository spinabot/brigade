import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";

describe("resolveTelegramAllowedUpdates", () => {
	it("always includes message + callback_query (the minimal central set)", () => {
		assert.deepEqual(resolveTelegramAllowedUpdates(), ["message", "callback_query"]);
	});

	it("adds message_reaction only when reactions are enabled", () => {
		assert.deepEqual(resolveTelegramAllowedUpdates({ reactions: true }), [
			"message",
			"callback_query",
			"message_reaction",
		]);
		assert.ok(!resolveTelegramAllowedUpdates({ reactions: false }).includes("message_reaction"));
	});

	it("adds edited_message only when editedMessages is enabled", () => {
		assert.ok(resolveTelegramAllowedUpdates({ editedMessages: true }).includes("edited_message"));
		assert.ok(!resolveTelegramAllowedUpdates().includes("edited_message"));
	});

	it("is deduped + stable order with both flags", () => {
		assert.deepEqual(resolveTelegramAllowedUpdates({ reactions: true, editedMessages: true }), [
			"message",
			"callback_query",
			"message_reaction",
			"edited_message",
		]);
	});

	it("callback_query is present so inline-button approvals are deliverable", () => {
		assert.ok(resolveTelegramAllowedUpdates().includes("callback_query"));
	});
});
