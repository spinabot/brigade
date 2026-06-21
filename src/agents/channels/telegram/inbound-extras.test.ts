import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Message } from "@grammyjs/types";

import {
	buildTelegramSenderName,
	extractTelegramMentions,
	extractTelegramReplyContext,
	extractTelegramText,
	hasInboundMedia,
	resolveInboundMediaFileId,
	resolveInboundMediaKind,
	telegramChatType,
	telegramThreadId,
} from "./inbound-extras.js";

const msg = (over: Partial<Message> = {}): Message =>
	({
		message_id: 1,
		date: 1,
		chat: { id: 5, type: "private", first_name: "A" },
		from: { id: 5, is_bot: false, first_name: "A" },
		...over,
	}) as Message;

describe("extractTelegramText", () => {
	it("returns the text body trimmed", () => {
		assert.equal(extractTelegramText(msg({ text: "  hi  " })), "hi");
	});

	it("falls back to a media caption when there is no text", () => {
		assert.equal(extractTelegramText(msg({ text: undefined, caption: "a pic" } as Partial<Message>)), "a pic");
	});

	it("drops binary/control-byte payloads", () => {
		// Build the control byte programmatically — a raw NUL must never appear in source.
		const withNul = `a${String.fromCharCode(0)}b`;
		assert.equal(extractTelegramText(msg({ text: withNul })), "");
	});

	it("expands text_link entities into markdown links", () => {
		const out = extractTelegramText(
			msg({ text: "go here now", entities: [{ type: "text_link", offset: 3, length: 4, url: "https://e.com" }] }),
		);
		assert.equal(out, "go [here](https://e.com) now");
	});
});

describe("telegramChatType / telegramThreadId", () => {
	it("private → direct, group/supergroup → group", () => {
		assert.equal(telegramChatType(msg({ chat: { id: 1, type: "private", first_name: "A" } as Message["chat"] })), "direct");
		assert.equal(telegramChatType(msg({ chat: { id: 1, type: "group", title: "G" } as Message["chat"] })), "group");
		assert.equal(telegramChatType(msg({ chat: { id: 1, type: "supergroup", title: "S" } as Message["chat"] })), "group");
	});

	it("threadId is the message_thread_id as a string, else undefined", () => {
		assert.equal(telegramThreadId(msg({ message_thread_id: 7 })), "7");
		assert.equal(telegramThreadId(msg({})), undefined);
	});
});

describe("extractTelegramMentions", () => {
	it("surfaces the bot id when @username is mentioned (entity)", () => {
		const m = msg({ text: "yo @brigadebot hi", entities: [{ type: "mention", offset: 3, length: 11 }] });
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["42"]);
	});

	it("surfaces the bot id for a standalone @username with no entity", () => {
		const m = msg({ text: "ping @brigadebot" });
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["42"]);
	});

	it("treats a reply to the bot's own message as an address", () => {
		const m = msg({
			text: "ok",
			reply_to_message: { message_id: 9, date: 1, chat: { id: 5, type: "group", title: "G" }, from: { id: 42, is_bot: true, first_name: "B" } } as Message["reply_to_message"],
		});
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["42"]);
	});

	it("surfaces a text_mention user's id (not the bot)", () => {
		const m = msg({
			text: "hey there",
			entities: [{ type: "text_mention", offset: 4, length: 5, user: { id: 99, is_bot: false, first_name: "C" } }],
		});
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["99"]);
	});

	it("returns [] when the bot is not addressed", () => {
		assert.deepEqual(extractTelegramMentions(msg({ text: "nobody here" }), "brigadebot", "42"), []);
	});
});

describe("extractTelegramReplyContext", () => {
	it("returns undefined when not a reply", () => {
		assert.equal(extractTelegramReplyContext(msg({ text: "x" })), undefined);
	});

	it("captures id, sender, and a truncated body", () => {
		const long = "y".repeat(400);
		const m = msg({
			reply_to_message: { message_id: 33, date: 1, chat: { id: 5, type: "private", first_name: "A" }, from: { id: 7, is_bot: false, first_name: "B" }, text: long } as Message["reply_to_message"],
		});
		const ctx = extractTelegramReplyContext(m);
		assert.equal(ctx?.messageId, "33");
		assert.equal(ctx?.from, "7");
		assert.equal(ctx?.body?.length, 280);
	});
});

describe("media detection", () => {
	it("hasInboundMedia true for photo/video/doc/sticker/voice", () => {
		assert.equal(hasInboundMedia(msg({ photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] } as Partial<Message>)), true);
		assert.equal(hasInboundMedia(msg({ document: { file_id: "d", file_unique_id: "u" } } as Partial<Message>)), true);
		assert.equal(hasInboundMedia(msg({ text: "no media" })), false);
	});

	it("resolveInboundMediaFileId picks the largest photo / single file", () => {
		const m = msg({
			photo: [
				{ file_id: "small", file_unique_id: "s", width: 90, height: 90 },
				{ file_id: "big", file_unique_id: "b", width: 800, height: 800 },
			],
		} as Partial<Message>);
		assert.equal(resolveInboundMediaFileId(m), "big");
		assert.equal(resolveInboundMediaKind(m), "image");
	});

	it("resolveInboundMediaKind classifies voice vs audio vs document", () => {
		assert.equal(resolveInboundMediaKind(msg({ voice: { file_id: "v", file_unique_id: "u", duration: 1 } } as Partial<Message>)), "voice");
		assert.equal(resolveInboundMediaKind(msg({ audio: { file_id: "a", file_unique_id: "u", duration: 1 } } as Partial<Message>)), "audio");
		assert.equal(resolveInboundMediaKind(msg({ sticker: { file_id: "s", file_unique_id: "u", width: 1, height: 1, type: "regular", is_animated: false, is_video: false } } as Partial<Message>)), "sticker");
	});
});

describe("buildTelegramSenderName", () => {
	it("prefers First Last, falls back to @username", () => {
		assert.equal(buildTelegramSenderName(msg({ from: { id: 1, is_bot: false, first_name: "Jane", last_name: "Doe" } })), "Jane Doe");
		assert.equal(buildTelegramSenderName(msg({ from: { id: 1, is_bot: false, first_name: "", username: "jd" } as Message["from"] })), "@jd");
	});
});
