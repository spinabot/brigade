/**
 * Tests for `send_message` — focused on the `senderIsOwner` per-call gate.
 * Stubs the channel manager + adapter so we never touch a real WhatsApp /
 * Slack socket.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	getActiveChannelManager,
	setActiveChannelManager,
} from "../channels/active-manager.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import {
	registerChannelMessagingAdapter,
	resetChannelMessagingRegistryForTests,
} from "../channels/channel-messaging-registry.js";
import { makeSendMessageTool } from "./send-message-tool.js";

interface StubAdapter {
	sendText: (to: string, text: string, opts?: Record<string, unknown>) => Promise<void>;
	health?: () => { ok: boolean; kind?: string; reason?: string; remediation?: string };
}

interface StubManager {
	started: string[];
	adapter(channel: string, accountId?: string): StubAdapter | undefined;
}

const peerA: ChannelApprovalRoute = {
	channelId: "whatsapp",
	conversationId: "14057144199@s.whatsapp.net",
} as unknown as ChannelApprovalRoute;

function mount(channels: string[] = ["whatsapp"]): { capture: Array<{ to: string; text: string }>; manager: StubManager } {
	const capture: Array<{ to: string; text: string }> = [];
	const adapter: StubAdapter = {
		sendText: async (to, text) => {
			capture.push({ to, text });
		},
		health: () => ({ ok: true }),
	};
	const manager: StubManager = {
		started: channels,
		adapter(channel) {
			return channels.includes(channel) ? adapter : undefined;
		},
	};
	setActiveChannelManager(manager as never);
	return { capture, manager };
}

function isRefused(result: unknown): boolean {
	const text = JSON.stringify(result);
	return /your own chat|approved channel|cross-conversation/i.test(text);
}

describe("send_message — senderIsOwner per-call gate", () => {
	afterEach(() => {
		setActiveChannelManager(null);
	});

	it("owner (default): cross-channel/conversation send is ALLOWED", async () => {
		const { capture } = mount(["whatsapp", "slack"]);
		const tool = makeSendMessageTool({ /* no senderIsOwner = owner */ });
		const result = await tool.execute("c1", {
			text: "hi from operator",
			channel: "slack",
			to: "C123",
		} as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture.length, 1);
		assert.equal(capture[0]?.to, "C123");
	});

	it("non-owner: auto-fill (no channel/to) is ALLOWED — replies to own chat", async () => {
		const { capture } = mount();
		const tool = makeSendMessageTool({ senderIsOwner: false, channelContext: peerA });
		const result = await tool.execute("c2", { text: "follow-up" } as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture.length, 1);
		assert.equal(capture[0]?.to, peerA.conversationId);
	});

	it("non-owner: explicit channel+to equal to channelContext is ALLOWED", async () => {
		const { capture } = mount();
		const tool = makeSendMessageTool({ senderIsOwner: false, channelContext: peerA });
		const result = await tool.execute("c3", {
			text: "explicit same-chat",
			channel: peerA.channelId,
			to: peerA.conversationId,
		} as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture.length, 1);
	});

	it("non-owner: cross-channel send REFUSES", async () => {
		const { capture } = mount(["whatsapp", "slack"]);
		const tool = makeSendMessageTool({ senderIsOwner: false, channelContext: peerA });
		const result = await tool.execute("c4", {
			text: "leak attempt",
			channel: "slack",
			to: "C123",
		} as never);
		assert.equal(isRefused(result), true);
		assert.equal(capture.length, 0);
	});

	it("non-owner: cross-conversation send (same channel, different peer) REFUSES", async () => {
		const { capture } = mount();
		const tool = makeSendMessageTool({ senderIsOwner: false, channelContext: peerA });
		const result = await tool.execute("c5", {
			text: "leak attempt",
			channel: peerA.channelId,
			to: "999@s.whatsapp.net",
		} as never);
		assert.equal(isRefused(result), true);
		assert.equal(capture.length, 0);
	});

	it("non-owner with no channelContext REFUSES every send (defensive)", async () => {
		mount();
		const tool = makeSendMessageTool({ senderIsOwner: false });
		const result = await tool.execute("c6", {
			text: "no-ctx",
			channel: "whatsapp",
			to: peerA.conversationId,
		} as never);
		assert.equal(isRefused(result), true);
	});
});

describe("send_message — OUTBOUND addressing (messaging adapter)", () => {
	afterEach(() => {
		setActiveChannelManager(null);
		resetChannelMessagingRegistryForTests();
	});

	it("BACK-COMPAT: no messaging adapter registered → raw `to` reaches sendText unchanged", async () => {
		const { capture } = mount(["whatsapp"]);
		const tool = makeSendMessageTool({}); // owner
		const raw = "14057144199@s.whatsapp.net";
		const result = await tool.execute("m1", { text: "hi", channel: "whatsapp", to: raw } as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture.length, 1);
		// Byte-for-byte identical to pre-FIX behaviour.
		assert.equal(capture[0]?.to, raw);
	});

	it("resolves a human NAME → concrete id via the channel's targetResolver", async () => {
		const { capture } = mount(["whatsapp"]);
		registerChannelMessagingAdapter("whatsapp", {
			parseExplicitTarget: (text) => {
				const m = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(text.trim());
				return m ? { channelId: m[1]!.toLowerCase(), target: m[2]! } : null;
			},
			normalizeTarget: (raw) => raw.trim(),
			targetResolver: (name) =>
				name.toLowerCase() === "alex" ? "14050000000@s.whatsapp.net" : null,
		});
		const tool = makeSendMessageTool({}); // owner
		const result = await tool.execute("m2", { text: "yo", channel: "whatsapp", to: "Alex" } as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture.length, 1);
		assert.equal(capture[0]?.to, "14050000000@s.whatsapp.net");
	});

	it("parses an explicit `scheme:value` target before sendText", async () => {
		const { capture } = mount(["telegram"]);
		registerChannelMessagingAdapter("telegram", {
			parseExplicitTarget: (text) => {
				const m = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(text.trim());
				return m ? { channelId: m[1]!.toLowerCase(), target: m[2]! } : null;
			},
			normalizeTarget: (raw) => raw.trim(),
		});
		const tool = makeSendMessageTool({});
		const result = await tool.execute("m3", { text: "ping", channel: "telegram", to: "telegram:987" } as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture[0]?.to, "987");
	});

	it("a misbehaving messaging adapter NEVER breaks the send (raw-id fallback)", async () => {
		const { capture } = mount(["whatsapp"]);
		registerChannelMessagingAdapter("whatsapp", {
			parseExplicitTarget: () => {
				throw new Error("kaboom");
			},
			normalizeTarget: (raw) => raw,
		});
		const tool = makeSendMessageTool({});
		const result = await tool.execute("m4", { text: "still sends", channel: "whatsapp", to: "raw-id" } as never);
		assert.equal(isRefused(result), false);
		assert.equal(capture[0]?.to, "raw-id");
	});
});
