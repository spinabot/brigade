import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { normalizeBlueBubblesWebhook } from "./normalize.js";
import { resolveBlueBubblesDedupeKey } from "./dedupe.js";

describe("normalizeBlueBubblesWebhook — chat guid resolution", () => {
	it("reads a TOP-LEVEL chatGuid", () => {
		const result = normalizeBlueBubblesWebhook(
			{ data: { guid: "M1", text: "hi", chatGuid: "iMessage;-;+1555", handle: { address: "+1555" } } },
			"new-message",
		);
		assert.equal(result.kind, "message");
		if (result.kind !== "message") return;
		assert.equal(result.message.chatGuid, "iMessage;-;+1555");
		assert.equal(result.message.conversationId, "chat_guid:iMessage;-;+1555");
		assert.equal(result.message.from, "+1555");
		assert.equal(result.message.text, "hi");
		assert.equal(result.message.isGroup, false); // ;-; → DM
	});

	it("reads a NESTED guid at data.chats[0].guid + infers group from ;+;", () => {
		const result = normalizeBlueBubblesWebhook(
			{
				data: {
					guid: "M2",
					text: "yo",
					handle: { address: "+1999" },
					chats: [{ guid: "iMessage;+;chat123" }],
				},
			},
			"new-message",
		);
		assert.equal(result.kind, "message");
		if (result.kind !== "message") return;
		assert.equal(result.message.chatGuid, "iMessage;+;chat123");
		assert.equal(result.message.isGroup, true); // ;+; → group
	});

	it("reads a guid nested under `chat`", () => {
		const result = normalizeBlueBubblesWebhook(
			{ message: { guid: "M3", text: "x", sender: "a@b.com", chat: { chat_guid: "iMessage;-;a@b.com" } } },
			"new-message",
		);
		assert.equal(result.kind, "message");
		if (result.kind !== "message") return;
		assert.equal(result.message.chatGuid, "iMessage;-;a@b.com");
	});
});

describe("normalizeBlueBubblesWebhook — skips", () => {
	it("skips isFromMe", () => {
		const result = normalizeBlueBubblesWebhook(
			{ data: { guid: "M", text: "hi", isFromMe: true, chatGuid: "iMessage;-;+1" } },
			"new-message",
		);
		assert.equal(result.kind, "skip");
		if (result.kind !== "skip") return;
		assert.equal(result.reason, "isFromMe");
	});

	it("skips an empty (no text, no media) message", () => {
		const result = normalizeBlueBubblesWebhook(
			{ data: { guid: "M", text: "", chatGuid: "iMessage;-;+1", handle: { address: "+1" } } },
			"new-message",
		);
		assert.equal(result.kind, "skip");
	});

	it("skips when no chat guid is resolvable", () => {
		const result = normalizeBlueBubblesWebhook({ data: { guid: "M", text: "hi" } }, "new-message");
		assert.equal(result.kind, "skip");
	});
});

describe("normalizeBlueBubblesWebhook — tapbacks", () => {
	it("decodes an ADD tapback (2001 → like) and DROPS it from the message path", () => {
		const result = normalizeBlueBubblesWebhook(
			{
				data: {
					guid: "T1",
					text: "Liked “hi”",
					chatGuid: "iMessage;-;+1",
					handle: { address: "+1" },
					associatedMessageType: 2001,
					associatedMessageGuid: "ORIG",
				},
			},
			"new-message",
		);
		assert.equal(result.kind, "tapback");
		if (result.kind !== "tapback") return;
		assert.equal(result.tapback.action, "added");
		assert.equal(result.tapback.emoji, "👍");
		assert.equal(result.targetGuid, "ORIG");
	});

	it("decodes a REMOVE tapback (3000 → love removed)", () => {
		const result = normalizeBlueBubblesWebhook(
			{
				data: {
					guid: "T2",
					text: "",
					chatGuid: "iMessage;-;+1",
					handle: { address: "+1" },
					associatedMessageType: 3000,
					associatedMessageGuid: "ORIG",
				},
			},
			"new-message",
		);
		assert.equal(result.kind, "tapback");
		if (result.kind !== "tapback") return;
		assert.equal(result.tapback.action, "removed");
		assert.equal(result.tapback.emoji, "❤️");
	});
});

describe("resolveBlueBubblesDedupeKey", () => {
	it("namespaces the message guid by account", () => {
		const key = resolveBlueBubblesDedupeKey(
			"home",
			{ data: { guid: "MSG-9", text: "hi", chatGuid: "iMessage;-;+1", handle: { address: "+1" } } },
			"new-message",
		);
		assert.equal(key, "home:MSG-9");
	});

	it("suffixes :updated for an attachment follow-up so it isn't collapsed", () => {
		const key = resolveBlueBubblesDedupeKey(
			"home",
			{ data: { guid: "MSG-9", text: "hi", chatGuid: "iMessage;-;+1", handle: { address: "+1" } } },
			"updated-message",
		);
		assert.equal(key, "home:MSG-9:updated");
	});

	it("returns undefined for a non-message payload (tapback)", () => {
		const key = resolveBlueBubblesDedupeKey(
			"home",
			{ data: { guid: "T", chatGuid: "iMessage;-;+1", associatedMessageType: 2000, associatedMessageGuid: "O" } },
			"new-message",
		);
		assert.equal(key, undefined);
	});
});
