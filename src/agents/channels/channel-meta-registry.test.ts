import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	getChatChannelMeta,
	getRegisteredChannelPluginMeta,
	listChannelMetas,
	registerChannelMeta,
	resetChannelMetaRegistryForTests,
} from "./channel-meta-registry.js";
import type { ChannelMeta } from "./types.core.js";

// The registry is a process-global singleton; drop any dynamically-registered
// metas after each case so tests don't bleed into each other. The built-in
// bundled catalog (whatsapp/telegram) is NOT cleared — it's static data.
afterEach(() => {
	resetChannelMetaRegistryForTests();
});

function fakeMeta(over: Partial<ChannelMeta> & { id: string }): ChannelMeta {
	return {
		label: over.id,
		selectionLabel: over.id,
		docsPath: `channels/${over.id}`,
		blurb: "",
		...over,
	};
}

describe("getRegisteredChannelPluginMeta", () => {
	it("resolves the built-in bundled channels by id", () => {
		const wa = getRegisteredChannelPluginMeta("whatsapp");
		const tg = getRegisteredChannelPluginMeta("telegram");
		assert.equal(wa?.id, "whatsapp");
		assert.equal(wa?.markdownCapable, true);
		assert.equal(tg?.id, "telegram");
		assert.equal(tg?.markdownCapable, true);
	});

	it("is case-insensitive and tolerates surrounding whitespace", () => {
		assert.equal(getRegisteredChannelPluginMeta("WhatsApp")?.id, "whatsapp");
		assert.equal(getRegisteredChannelPluginMeta("  TELEGRAM ")?.id, "telegram");
	});

	it("returns undefined for an unknown channel id", () => {
		assert.equal(getRegisteredChannelPluginMeta("signal"), undefined);
	});

	it("returns undefined for empty / nullish input", () => {
		assert.equal(getRegisteredChannelPluginMeta(""), undefined);
		assert.equal(getRegisteredChannelPluginMeta(null), undefined);
		assert.equal(getRegisteredChannelPluginMeta(undefined), undefined);
	});

	it("surfaces a dynamically-registered channel", () => {
		assert.equal(getRegisteredChannelPluginMeta("sms"), undefined);
		registerChannelMeta(fakeMeta({ id: "sms", markdownCapable: false }));
		const meta = getRegisteredChannelPluginMeta("sms");
		assert.equal(meta?.id, "sms");
		assert.equal(meta?.markdownCapable, false);
	});

	it("resolves a channel by a declared alias", () => {
		registerChannelMeta(fakeMeta({ id: "discord", aliases: ["disco"] }));
		assert.equal(getRegisteredChannelPluginMeta("disco")?.id, "discord");
	});

	it("lets a dynamic registration override a bundled channel's meta (last wins)", () => {
		assert.equal(getRegisteredChannelPluginMeta("whatsapp")?.markdownCapable, true);
		registerChannelMeta(fakeMeta({ id: "whatsapp", markdownCapable: false }));
		assert.equal(getRegisteredChannelPluginMeta("whatsapp")?.markdownCapable, false);
	});

	it("ignores a meta without a usable id", () => {
		const before = listChannelMetas().length;
		registerChannelMeta(fakeMeta({ id: "   " }));
		assert.equal(listChannelMetas().length, before);
	});
});

describe("getChatChannelMeta (alias)", () => {
	it("behaves identically to getRegisteredChannelPluginMeta", () => {
		assert.deepEqual(getChatChannelMeta("telegram"), getRegisteredChannelPluginMeta("telegram"));
		assert.equal(getChatChannelMeta("nope"), undefined);
	});
});

describe("listChannelMetas", () => {
	it("includes both bundled channels by default", () => {
		const ids = listChannelMetas().map((m) => m.id);
		assert.ok(ids.includes("whatsapp"), "expected whatsapp in the catalog");
		assert.ok(ids.includes("telegram"), "expected telegram in the catalog");
	});

	it("includes dynamic registrations and de-dupes by id", () => {
		registerChannelMeta(fakeMeta({ id: "slack" }));
		// Re-register the same id with a different label — must not duplicate.
		registerChannelMeta(fakeMeta({ id: "slack", label: "Slack!" }));
		const slackEntries = listChannelMetas().filter((m) => m.id === "slack");
		assert.equal(slackEntries.length, 1);
		assert.equal(slackEntries[0]?.label, "Slack!");
	});
});
