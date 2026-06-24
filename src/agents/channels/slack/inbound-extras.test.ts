import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildSlackSenderName,
	expandSlackTokens,
	extractSlackMentions,
	extractSlackReplyContext,
	extractSlackText,
	hasInboundMedia,
	resolveInboundFiles,
	resolveSlackFileKind,
	slackChannelType,
	slackThreadId,
	type SlackFileObject,
	type SlackMessageEvent,
} from "./inbound-extras.js";

const ev = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent =>
	({ type: "message", user: "U1", channel: "C1", channel_type: "channel", ts: "1.1", ...over }) as SlackMessageEvent;

describe("expandSlackTokens", () => {
	it("expands a user mention with a label to @label", () => {
		assert.equal(expandSlackTokens("hi <@U123|alex>"), "hi @alex");
	});

	it("expands a bare user mention to @id", () => {
		assert.equal(expandSlackTokens("hi <@U123>"), "hi @U123");
	});

	it("resolves a bare user mention via the directory resolver", () => {
		const names = new Map([["U123", "Alex"]]);
		assert.equal(expandSlackTokens("hi <@U123>", (id) => names.get(id)), "hi @Alex");
	});

	it("keeps the inline label over the resolver", () => {
		const names = new Map([["U123", "Alex"]]);
		assert.equal(expandSlackTokens("hi <@U123|raw>", (id) => names.get(id)), "hi @raw");
	});

	it("falls back to the id when the resolver has no name", () => {
		assert.equal(expandSlackTokens("hi <@U123>", () => undefined), "hi @U123");
	});

	it("expands a channel mention", () => {
		assert.equal(expandSlackTokens("see <#C1|general>"), "see #general");
		assert.equal(expandSlackTokens("see <#C1>"), "see #C1");
	});

	it("expands special mentions and subteams", () => {
		assert.equal(expandSlackTokens("<!here> ping"), "@here ping");
		assert.equal(expandSlackTokens("<!subteam^S1|@ops>"), "@ops");
	});

	it("expands a link to its label, or the bare url", () => {
		assert.equal(expandSlackTokens("see <https://e.com|docs>"), "see docs");
		assert.equal(expandSlackTokens("see <https://e.com>"), "see https://e.com");
	});
});

describe("extractSlackText", () => {
	it("expands tokens and unescapes entities", () => {
		assert.equal(extractSlackText(ev({ text: "yo <@U9|sam> &amp; &lt;x&gt;" })), "yo @sam & <x>");
	});

	it("resolves bare mentions through the directory resolver", () => {
		const names = new Map([["U9", "Sam"]]);
		assert.equal(extractSlackText(ev({ text: "yo <@U9>" }), (id) => names.get(id)), "yo @Sam");
	});

	it("drops binary/control-byte payloads", () => {
		const withNul = `a${String.fromCharCode(0)}b`;
		assert.equal(extractSlackText(ev({ text: withNul })), "");
	});

	it("surfaces the edited text on a message_changed envelope", () => {
		const edited = ev({ subtype: "message_changed", message: ev({ text: "new text", ts: "1.1" }), text: undefined });
		assert.equal(extractSlackText(edited), "new text");
	});

	it("returns empty string for empty text", () => {
		assert.equal(extractSlackText(ev({ text: "" })), "");
	});
});

describe("slackChannelType", () => {
	it("maps im → direct and the rest → group", () => {
		assert.equal(slackChannelType(ev({ channel_type: "im" })), "direct");
		assert.equal(slackChannelType(ev({ channel_type: "mpim" })), "group");
		assert.equal(slackChannelType(ev({ channel_type: "channel" })), "group");
		assert.equal(slackChannelType(ev({ channel_type: "group" })), "group");
	});

	it("falls back to the channel-id prefix when channel_type is absent", () => {
		assert.equal(slackChannelType({ channel: "D123" }), "direct");
		assert.equal(slackChannelType({ channel: "C123" }), "group");
	});
});

describe("slackThreadId", () => {
	it("returns thread_ts when present", () => {
		assert.equal(slackThreadId({ thread_ts: "100.5" }), "100.5");
		assert.equal(slackThreadId({}), undefined);
	});
});

describe("extractSlackMentions", () => {
	it("surfaces the bot id when the bot is @-mentioned", () => {
		assert.deepEqual(extractSlackMentions(ev({ text: "hey <@UBOT> help" }), "UBOT"), ["UBOT"]);
	});

	it("surfaces the bot id for an app_mention event regardless of token", () => {
		assert.deepEqual(extractSlackMentions(ev({ type: "app_mention", text: "hi" }), "UBOT"), ["UBOT"]);
	});

	it("surfaces other user mentions but not the bot when unaddressed", () => {
		assert.deepEqual(extractSlackMentions(ev({ text: "cc <@U2> <@U3>" }), "UBOT"), ["U2", "U3"]);
	});

	it("returns [] when nobody is mentioned", () => {
		assert.deepEqual(extractSlackMentions(ev({ text: "just talking" }), "UBOT"), []);
	});
});

describe("extractSlackReplyContext", () => {
	it("returns the parent ts for a threaded reply", () => {
		const ctx = extractSlackReplyContext(ev({ ts: "2.0", thread_ts: "1.0" }));
		assert.deepEqual(ctx, { messageId: "1.0" });
	});

	it("returns undefined for the thread root (thread_ts === ts)", () => {
		assert.equal(extractSlackReplyContext(ev({ ts: "1.0", thread_ts: "1.0" })), undefined);
	});

	it("returns undefined for a top-level message", () => {
		assert.equal(extractSlackReplyContext(ev({ ts: "1.0" })), undefined);
	});
});

describe("buildSlackSenderName", () => {
	it("prefers a legacy username, else the user id", () => {
		assert.equal(buildSlackSenderName(ev({ user: "U7" })), "U7");
		assert.equal(buildSlackSenderName(ev({ username: "webhook" } as Partial<SlackMessageEvent>)), "webhook");
	});

	it("resolves the user id to a display name when the directory has it", () => {
		const names = new Map([["U7", "Alex"]]);
		assert.equal(buildSlackSenderName(ev({ user: "U7" }), (id) => names.get(id)), "Alex");
	});

	it("falls back to the id when the resolver returns nothing", () => {
		assert.equal(buildSlackSenderName(ev({ user: "U7" }), () => undefined), "U7");
	});
});

describe("slack media detection", () => {
	const file = (over: Partial<SlackFileObject> = {}): SlackFileObject =>
		({ id: "F1", url_private: "https://files.slack.com/F1", mimetype: "image/png", filetype: "png", ...over });

	it("detects a downloadable file", () => {
		assert.equal(hasInboundMedia(ev({ files: [file()] })), true);
		assert.equal(hasInboundMedia(ev({ files: [] })), false);
	});

	it("ignores a tombstoned (deleted) file", () => {
		assert.equal(hasInboundMedia(ev({ files: [file({ mode: "tombstone" })] })), false);
		assert.deepEqual(resolveInboundFiles(ev({ files: [file({ mode: "tombstone" })] })), []);
	});

	it("maps mimetypes to media kinds", () => {
		assert.equal(resolveSlackFileKind(file({ mimetype: "image/png", filetype: "png" })), "image");
		assert.equal(resolveSlackFileKind(file({ mimetype: "video/mp4", filetype: "mp4" })), "video");
		assert.equal(resolveSlackFileKind(file({ mimetype: "audio/mpeg", filetype: "mp3" })), "audio");
		assert.equal(resolveSlackFileKind(file({ mimetype: "audio/mp4", filetype: "m4a" })), "voice");
		assert.equal(resolveSlackFileKind(file({ mimetype: "application/pdf", filetype: "pdf" })), "document");
	});
});
