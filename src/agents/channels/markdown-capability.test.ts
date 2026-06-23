import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	registerChannelMeta,
	resetChannelMetaRegistryForTests,
} from "./channel-meta-registry.js";
import {
	isMarkdownCapableChannel,
	isMarkdownCapableMessageChannel,
} from "./markdown-capability.js";
import type { ChannelMeta } from "./types.core.js";

afterEach(() => {
	resetChannelMetaRegistryForTests();
});

function fakeMeta(id: string, markdownCapable: boolean | undefined): ChannelMeta {
	return {
		id,
		label: id,
		selectionLabel: id,
		docsPath: `channels/${id}`,
		blurb: "",
		...(markdownCapable !== undefined ? { markdownCapable } : {}),
	};
}

describe("isMarkdownCapableChannel", () => {
	it("returns true for a channel whose meta declares markdownCapable: true", () => {
		// Bundled WhatsApp + Telegram both declare markdownCapable: true.
		assert.equal(isMarkdownCapableChannel("whatsapp"), true);
		assert.equal(isMarkdownCapableChannel("telegram"), true);
	});

	it("returns false ONLY for a channel that explicitly opted out (markdownCapable: false)", () => {
		registerChannelMeta(fakeMeta("sms", false));
		assert.equal(isMarkdownCapableChannel("sms"), false);
	});

	it("DEFAULTS markdown ON for an unknown channel (no regression)", () => {
		// No meta registered for "signal" — historical behavior is markdown-on.
		assert.equal(isMarkdownCapableChannel("signal"), true);
	});

	it("DEFAULTS markdown ON when a meta exists but omits the markdownCapable flag", () => {
		registerChannelMeta(fakeMeta("webhook", undefined));
		assert.equal(isMarkdownCapableChannel("webhook"), true);
	});

	it("defaults markdown ON for empty / nullish channel id", () => {
		assert.equal(isMarkdownCapableChannel(""), true);
		assert.equal(isMarkdownCapableChannel(null), true);
		assert.equal(isMarkdownCapableChannel(undefined), true);
	});

	it("is case-insensitive", () => {
		registerChannelMeta(fakeMeta("sms", false));
		assert.equal(isMarkdownCapableChannel("SMS"), false);
	});
});

describe("isMarkdownCapableMessageChannel", () => {
	it("treats the operator-facing surfaces (cli / tui / internal) as markdown-capable", () => {
		assert.equal(isMarkdownCapableMessageChannel("cli"), true);
		assert.equal(isMarkdownCapableMessageChannel("tui"), true);
		assert.equal(isMarkdownCapableMessageChannel("internal"), true);
	});

	it("defaults markdown ON for an unspecified surface (empty / null)", () => {
		assert.equal(isMarkdownCapableMessageChannel(""), true);
		assert.equal(isMarkdownCapableMessageChannel(null), true);
		assert.equal(isMarkdownCapableMessageChannel(undefined), true);
	});

	it("respects an explicit markdownCapable: false channel", () => {
		registerChannelMeta(fakeMeta("sms", false));
		assert.equal(isMarkdownCapableMessageChannel("sms"), false);
	});

	it("keeps markdown ON for markdown-capable + unknown channels", () => {
		assert.equal(isMarkdownCapableMessageChannel("whatsapp"), true);
		assert.equal(isMarkdownCapableMessageChannel("telegram"), true);
		assert.equal(isMarkdownCapableMessageChannel("signal"), true);
	});
});
