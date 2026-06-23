/**
 * Tests for the channel-messaging registry — the OUTBOUND addressing seam
 * (FIX #2). Covers: explicit-target parse, normalize, the optional
 * name→targetResolver path, and the CRITICAL raw-id back-compat fallback
 * (no messaging adapter registered → the `to` is returned byte-for-byte).
 *
 * The registry is a process-global singleton; each case clears its dynamic
 * registrations in afterEach so they don't bleed across tests.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	getChannelMessagingAdapter,
	looksLikeContactName,
	registerChannelMessagingAdapter,
	resetChannelMessagingRegistryForTests,
	resolveOutboundTarget,
	syncChannelMessagingAdaptersFromPlugins,
} from "./channel-messaging-registry.js";
import type { ChannelMessagingAdapter } from "./types.adapters.js";

afterEach(() => {
	resetChannelMessagingRegistryForTests();
});

/** A representative adapter: `name:value` explicit scheme, `@`-trim normalize,
 *  and a tiny contact directory. */
function fakeMessaging(over: Partial<ChannelMessagingAdapter> = {}): ChannelMessagingAdapter {
	return {
		parseExplicitTarget: (text) => {
			const m = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(text.trim());
			if (!m) return null;
			return { channelId: m[1]!.toLowerCase(), target: m[2]! };
		},
		normalizeTarget: (raw) => raw.trim().replace(/^@/, "").toLowerCase(),
		...over,
	};
}

describe("registerChannelMessagingAdapter / getChannelMessagingAdapter", () => {
	it("registers and looks up by id (case-insensitive)", () => {
		const adapter = fakeMessaging();
		registerChannelMessagingAdapter("telegram", adapter);
		assert.equal(getChannelMessagingAdapter("telegram"), adapter);
		assert.equal(getChannelMessagingAdapter("TELEGRAM"), adapter);
		assert.equal(getChannelMessagingAdapter("  Telegram "), adapter);
	});

	it("returns undefined for an unregistered / nullish channel", () => {
		assert.equal(getChannelMessagingAdapter("signal"), undefined);
		assert.equal(getChannelMessagingAdapter(""), undefined);
		assert.equal(getChannelMessagingAdapter(null), undefined);
		assert.equal(getChannelMessagingAdapter(undefined), undefined);
	});

	it("last registration per id wins", () => {
		const first = fakeMessaging();
		const second = fakeMessaging();
		registerChannelMessagingAdapter("x", first);
		registerChannelMessagingAdapter("x", second);
		assert.equal(getChannelMessagingAdapter("x"), second);
	});

	it("no-ops on an unusable channel id", () => {
		registerChannelMessagingAdapter("   ", fakeMessaging());
		assert.equal(getChannelMessagingAdapter("   "), undefined);
	});
});

describe("syncChannelMessagingAdaptersFromPlugins", () => {
	it("registers only plugins that declare a messaging adapter", () => {
		const tg = fakeMessaging();
		syncChannelMessagingAdaptersFromPlugins([
			{ id: "telegram", messaging: tg },
			{ id: "whatsapp" /* no messaging slot */ },
		]);
		assert.equal(getChannelMessagingAdapter("telegram"), tg);
		assert.equal(getChannelMessagingAdapter("whatsapp"), undefined);
	});
});

describe("looksLikeContactName", () => {
	it("treats bare words and @handles as names", () => {
		assert.equal(looksLikeContactName("Alex"), true);
		assert.equal(looksLikeContactName("@alex"), true);
		assert.equal(looksLikeContactName("Team Lead"), true);
	});

	it("treats concrete ids as NOT names", () => {
		assert.equal(looksLikeContactName("telegram:123456"), false);
		assert.equal(looksLikeContactName("14057144199@s.whatsapp.net"), false);
		assert.equal(looksLikeContactName("+15551234567"), false);
		assert.equal(looksLikeContactName("15551234567"), false);
		assert.equal(looksLikeContactName(""), false);
	});
});

describe("resolveOutboundTarget — back-compat (no messaging adapter)", () => {
	it("returns the raw `to` byte-for-byte when no adapter is registered", async () => {
		const raw = "14057144199@s.whatsapp.net";
		const res = await resolveOutboundTarget({ channelId: "whatsapp", to: raw });
		assert.equal(res.to, raw);
		assert.equal(res.usedAdapter, false);
		assert.equal(res.resolvedByName, false);
		assert.equal(res.channelId, undefined);
	});

	it("does NOT touch an arbitrary string when no adapter is registered", async () => {
		const res = await resolveOutboundTarget({ channelId: "whatsapp", to: "Alex" });
		assert.equal(res.to, "Alex");
		assert.equal(res.usedAdapter, false);
	});
});

describe("resolveOutboundTarget — parse + normalize", () => {
	it("parses an explicit `scheme:value` target and normalizes it", async () => {
		registerChannelMessagingAdapter("telegram", fakeMessaging());
		const res = await resolveOutboundTarget({ channelId: "telegram", to: "telegram:123456" });
		assert.equal(res.to, "123456");
		assert.equal(res.usedAdapter, true);
		// Same channel named → no cross-channel hop surfaced... wait, scheme says
		// "telegram" which equals the send channel; still surfaced as channelId.
		assert.equal(res.channelId, "telegram");
	});

	it("surfaces a CROSS-channel id named by an explicit target", async () => {
		registerChannelMessagingAdapter("whatsapp", fakeMessaging());
		const res = await resolveOutboundTarget({ channelId: "whatsapp", to: "telegram:999" });
		assert.equal(res.to, "999");
		assert.equal(res.channelId, "telegram");
	});

	it("normalizes a plain (non-explicit) id: trims, drops leading @, lowercases", async () => {
		// No targetResolver → a name-ish input is just normalized, not resolved.
		registerChannelMessagingAdapter("slack", fakeMessaging());
		const res = await resolveOutboundTarget({ channelId: "slack", to: "  @Channel-ABC " });
		assert.equal(res.to, "channel-abc");
		assert.equal(res.resolvedByName, false);
	});
});

describe("resolveOutboundTarget — name → targetResolver", () => {
	it("resolves a human name to a concrete id via the channel's directory", async () => {
		const directory: Record<string, string> = { alex: "14050000000@s.whatsapp.net" };
		registerChannelMessagingAdapter(
			"whatsapp",
			fakeMessaging({
				// Pass the resolved id straight through normalize (already canonical).
				normalizeTarget: (raw) => raw.trim(),
				targetResolver: (name) => directory[name.toLowerCase().replace(/^@/, "")] ?? null,
			}),
		);
		const res = await resolveOutboundTarget({ channelId: "whatsapp", to: "Alex" });
		assert.equal(res.to, "14050000000@s.whatsapp.net");
		assert.equal(res.resolvedByName, true);
		assert.equal(res.usedAdapter, true);
	});

	it("supports an async targetResolver", async () => {
		registerChannelMessagingAdapter(
			"whatsapp",
			fakeMessaging({
				normalizeTarget: (raw) => raw.trim(),
				targetResolver: async (name) => (name === "@bob" ? "bob-id" : null),
			}),
		);
		const res = await resolveOutboundTarget({ channelId: "whatsapp", to: "@bob" });
		assert.equal(res.to, "bob-id");
		assert.equal(res.resolvedByName, true);
	});

	it("falls back to the (normalized) name when the resolver returns null", async () => {
		registerChannelMessagingAdapter(
			"whatsapp",
			fakeMessaging({ targetResolver: () => null }),
		);
		const res = await resolveOutboundTarget({ channelId: "whatsapp", to: "Nobody" });
		// normalize lowercases — resolver gave nothing, so we keep the name.
		assert.equal(res.to, "nobody");
		assert.equal(res.resolvedByName, false);
	});

	it("does NOT call the resolver for an explicit target (scheme form)", async () => {
		let resolverCalls = 0;
		registerChannelMessagingAdapter(
			"telegram",
			fakeMessaging({
				targetResolver: () => {
					resolverCalls += 1;
					return "should-not-be-used";
				},
			}),
		);
		const res = await resolveOutboundTarget({ channelId: "telegram", to: "telegram:42" });
		assert.equal(res.to, "42");
		assert.equal(resolverCalls, 0);
	});

	it("does NOT call the resolver when the `to` is plainly an id (JID)", async () => {
		let resolverCalls = 0;
		registerChannelMessagingAdapter(
			"whatsapp",
			fakeMessaging({
				normalizeTarget: (raw) => raw.trim(),
				targetResolver: () => {
					resolverCalls += 1;
					return "x";
				},
			}),
		);
		const res = await resolveOutboundTarget({
			channelId: "whatsapp",
			to: "14057144199@s.whatsapp.net",
		});
		assert.equal(res.to, "14057144199@s.whatsapp.net");
		assert.equal(resolverCalls, 0);
	});
});

describe("resolveOutboundTarget — fault tolerance", () => {
	it("degrades to the raw `to` if the adapter throws", async () => {
		registerChannelMessagingAdapter("telegram", {
			parseExplicitTarget: () => {
				throw new Error("boom");
			},
			normalizeTarget: (raw) => raw,
		});
		const res = await resolveOutboundTarget({ channelId: "telegram", to: "raw-value" });
		assert.equal(res.to, "raw-value");
		assert.equal(res.usedAdapter, false);
	});

	it("degrades to the raw `to` if normalize returns empty", async () => {
		registerChannelMessagingAdapter(
			"telegram",
			fakeMessaging({ normalizeTarget: () => "" }),
		);
		const res = await resolveOutboundTarget({ channelId: "telegram", to: "keepme" });
		// normalize emptied it → fall back to the (parsed/raw) target, not "".
		assert.equal(res.to, "keepme");
	});
});
