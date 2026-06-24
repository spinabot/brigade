import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import type { ChannelStartContext, InboundMessage } from "../sdk.js";
import { createSlackAdapter, SLACK_CAPABILITIES, buildReactionNote, type SlackAdapter } from "./adapter.js";
import type { ConnectSlackArgs, SlackConnection } from "./connection.js";

const enabledCfg = (over: Record<string, unknown> = {}): BrigadeConfig =>
	({ channels: { slack: { enabled: true, botToken: "xoxb-AAAAAAAAAA", appToken: "xapp-BBBBBBBBBB", ...over } } }) as unknown as BrigadeConfig;

/** Recorded calls to the fake connection's methods (for parity assertions). */
interface FakeConnCalls {
	sentText: Array<{ channel: string; text: string; threadId?: string; replyToMessageId?: string }>;
	sentInteractive: Array<{ channel: string; text: string; blocks: unknown; threadId?: string }>;
	edits: Array<{ channel: string; messageId: string; text: string }>;
	deletes: Array<{ channel: string; messageId: string }>;
	reactions: Array<{ channel: string; messageId: string; emoji: string }>;
	reactionsCleared: Array<{ channel: string; messageId: string }>;
	fed: Array<{ kind: string; payload: unknown }>;
}

interface FakeConnHandle {
	args: ConnectSlackArgs;
	calls: FakeConnCalls;
}

function makeFakeConnectImpl(): {
	connectImpl: (a: ConnectSlackArgs) => Promise<SlackConnection>;
	handle: () => FakeConnHandle | null;
} {
	let handle: FakeConnHandle | null = null;
	const connectImpl = async (args: ConnectSlackArgs): Promise<SlackConnection> => {
		const state = { connected: true, tokenInvalid: false };
		const calls: FakeConnCalls = { sentText: [], sentInteractive: [], edits: [], deletes: [], reactions: [], reactionsCleared: [], fed: [] };
		let seq = 0;
		const conn: SlackConnection = {
			selfId: () => "UBOT",
			selfName: () => "brigade",
			teamId: () => "T1",
			connectedAt: () => 1234,
			lastEventAt: () => 5678,
			isConnected: () => state.connected,
			isTokenInvalid: () => state.tokenInvalid,
			sendText: async (channel, text, o) => {
				calls.sentText.push({ channel, text, threadId: o?.threadId, replyToMessageId: o?.replyToMessageId });
				return { messageId: `100.${++seq}` };
			},
			sendInteractive: async (channel, text, blocks, o) => {
				calls.sentInteractive.push({ channel, text, blocks, threadId: o?.threadId });
				return { messageId: `200.${++seq}` };
			},
			sendMedia: async () => {},
			react: async (channel, messageId, emoji) => {
				calls.reactions.push({ channel, messageId, emoji });
			},
			removeReaction: async () => {},
			removeOwnReactions: async (channel, messageId) => {
				calls.reactionsCleared.push({ channel, messageId });
			},
			editMessageText: async (channel, messageId, text) => {
				calls.edits.push({ channel, messageId, text });
			},
			deleteMessage: async (channel, messageId) => {
				calls.deletes.push({ channel, messageId });
			},
			openDirectMessage: async () => "D1",
			feedEvent: (kind, payload) => {
				calls.fed.push({ kind, payload });
			},
			mode: () => "socket",
			setComposing: async () => {},
			markRead: async () => {},
			close: async () => {
				state.connected = false;
			},
		};
		handle = { args, calls };
		// Simulate the connection announcing readiness so the adapter flips connected.
		args.onConnected?.();
		return conn;
	};
	return { connectImpl, handle: () => handle };
}

function makeStartCtx(onInbound: (m: InboundMessage) => void): ChannelStartContext {
	return {
		onInbound: async (m) => onInbound(m),
		log: () => {},
		signal: new AbortController().signal,
	};
}

describe("createSlackAdapter — config gating", () => {
	it("is configured when enabled + bot + app token resolve (socket mode)", () => {
		const a = createSlackAdapter();
		assert.equal(a.isConfigured(enabledCfg(), {}), true);
	});

	it("is NOT configured when socket mode lacks an app token", () => {
		const a = createSlackAdapter();
		const cfg = { channels: { slack: { enabled: true, botToken: "xoxb-x" } } } as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
	});

	it("is NOT configured when disabled", () => {
		const a = createSlackAdapter();
		const cfg = { channels: { slack: { enabled: false } } } as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
	});

	it("steps aside (legacy default) when >1 account is configured", () => {
		const a = createSlackAdapter();
		const cfg = {
			channels: {
				slack: { enabled: true, accounts: [{ id: "a", botToken: "xoxb-a", appToken: "xapp-a" }, { id: "b", botToken: "xoxb-b", appToken: "xapp-b" }] },
			},
		} as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
	});
});

describe("createSlackAdapter — inbound + health", () => {
	it("wires onMessage → ctx.onInbound with channel + team stamped", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const received: InboundMessage[] = [];
		await a.start(makeStartCtx((m) => received.push(m)));
		assert.equal(a.health!().ok, true);
		handle()!.args.onMessage({
			conversationId: "C1",
			from: "U2",
			text: "hi",
			chatType: "group",
			teamId: "T1",
			messageId: "5.5",
			raw: {},
		});
		assert.equal(received.length, 1);
		assert.equal(received[0]?.channel, "slack");
		assert.equal(received[0]?.teamId, "T1");
		assert.equal(received[0]?.isGroup, true);
	});

	it("routes a reaction as a synthesised note", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const received: InboundMessage[] = [];
		await a.start(makeStartCtx((m) => received.push(m)));
		handle()!.args.onReaction?.({
			conversationId: "C1",
			from: "U2",
			text: "",
			chatType: "group",
			reaction: { emojis: ["tada"], targetMessageId: "9.0" },
			raw: {},
		});
		assert.equal(received.length, 1);
		assert.match(received[0]?.text ?? "", /reacted :tada: to message 9\.0/);
	});

	it("health reports starting before start, ok after", async () => {
		const { connectImpl } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl });
		assert.equal(a.health!().ok, false);
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		assert.equal(a.health!().ok, true);
	});
});

describe("createSlackAdapter — outbound", () => {
	it("sendText renders mrkdwn + threads the first chunk only", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		await a.sendText("C1", "hello **bold**", { threadId: "1.0" });
		const sent = handle()!.calls.sentText;
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.text, "hello *bold*");
		assert.equal(sent[0]?.threadId, "1.0");
	});

	it("handleAction edit/delete/react routes to the connection", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl }) as SlackAdapter;
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		const edit = await a.handleAction!({ conversationId: "C1", action: { kind: "edit", messageId: "2.0", text: "new *x*" } });
		assert.equal(edit.ok, true);
		const del = await a.handleAction!({ conversationId: "C1", action: { kind: "delete", messageId: "2.0" } });
		assert.equal(del.ok, true);
		const react = await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "2.0", emoji: "tada" } });
		assert.equal(react.ok, true);
		const calls = handle()!.calls;
		assert.equal(calls.edits[0]?.text, "new _x_");
		assert.equal(calls.deletes[0]?.messageId, "2.0");
		assert.equal(calls.reactions[0]?.emoji, "tada");
	});

	it("handleAction react with an EMPTY emoji clears the bot's own reactions; non-empty adds", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl }) as SlackAdapter;
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		// Empty emoji → clear (removeOwnReactions), not a react add.
		const cleared = await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "7.0", emoji: "" } });
		assert.equal(cleared.ok, true);
		const calls = handle()!.calls;
		assert.equal(calls.reactionsCleared.length, 1);
		assert.equal(calls.reactionsCleared[0]?.messageId, "7.0");
		assert.equal(calls.reactions.length, 0, "empty emoji must NOT add a reaction");
		// Whitespace-only is also treated as clear.
		await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "7.1", emoji: "   " } });
		assert.equal(calls.reactionsCleared.length, 2);
		// A real emoji still adds.
		await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "8.0", emoji: "tada" } });
		assert.equal(calls.reactions.length, 1);
		assert.equal(calls.reactions[0]?.emoji, "tada");
	});

	it("approvalCapability sends Block Kit blocks via the interactive path", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		await a.approvalCapability!.sendApprovalPrompt!({
			runtime: {},
			cfg: enabledCfg(),
			conversationId: "C1",
			approvalId: "exec-abc",
			approvalKind: "exec",
			command: "ls",
			timeoutMs: 1000,
		});
		const inter = handle()!.calls.sentInteractive;
		assert.equal(inter.length, 1);
		assert.ok(Array.isArray(inter[0]?.blocks));
	});

	it("feedWebhookEvent forwards to the connection", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createSlackAdapter({ connectImpl }) as SlackAdapter;
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		a.feedWebhookEvent("event", { event: { type: "message" } });
		assert.equal(handle()!.calls.fed.length, 1);
		assert.equal(handle()!.calls.fed[0]?.kind, "event");
	});
});

describe("SLACK_CAPABILITIES + helpers", () => {
	it("advertises edit/unsend/react/reply/threads/media (no polls/nativeCommands)", () => {
		assert.equal(SLACK_CAPABILITIES.edit, true);
		assert.equal(SLACK_CAPABILITIES.unsend, true);
		assert.equal(SLACK_CAPABILITIES.reactions, true);
		assert.equal(SLACK_CAPABILITIES.threads, true);
		assert.equal(SLACK_CAPABILITIES.media, true);
		assert.equal(SLACK_CAPABILITIES.polls, undefined);
		assert.equal(SLACK_CAPABILITIES.nativeCommands, undefined);
	});

	it("buildReactionNote wraps emoji names in colons", () => {
		assert.equal(buildReactionNote(["tada"], "9.0", "Sam"), "Sam reacted :tada: to message 9.0.");
	});
});
