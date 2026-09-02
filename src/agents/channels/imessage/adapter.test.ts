import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { IMessageRpcClient } from "./client.js";
import { createIMessageAdapter } from "./adapter.js";
import type { ConnectIMessageArgs, IMessageConnection } from "./connection.js";
import type { ChannelStartContext, InboundMessage } from "../sdk.js";

const cfg = { channels: { imessage: { enabled: true } } } as never;

/** A fake connection that records sends + lets the test push inbound messages. */
function fakeConnection(): IMessageConnection & {
	sentText: Array<{ to: string; text: string }>;
	typing: boolean[];
} {
	const sentText: Array<{ to: string; text: string }> = [];
	const typing: boolean[] = [];
	return {
		sentText,
		typing,
		async setTyping(_conversationId: string, on: boolean): Promise<void> {
			typing.push(on);
		},
		isConnected: () => true,
	lastWatchError: () => undefined,
		connectedAt: () => Date.now(),
		async sendText(conversationId, text): Promise<{ messageId?: string }> {
			sentText.push({ to: conversationId, text });
			return { messageId: "M-1" };
		},
		async sendMedia(): Promise<{ messageId?: string }> {
			return { messageId: "M-2" };
		},
		async close(): Promise<void> {},
	};
}

function startCtx(onInbound: (m: InboundMessage) => Promise<void>): ChannelStartContext {
	return {
		onInbound,
		log: () => {},
		signal: new AbortController().signal,
	};
}

describe("createIMessageAdapter", () => {
	it("is configured when the channel is enabled", () => {
		const adapter = createIMessageAdapter();
		assert.equal(adapter.isConfigured(cfg), true);
		assert.equal(adapter.isConfigured({ channels: {} } as never), false);
	});

	it("dispatches a normalized inbound through onInbound", async () => {
		const captured: ConnectIMessageArgs[] = [];
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({
			connectImpl: async (args) => {
				captured.push(args);
				return conn;
			},
		});
		const received: InboundMessage[] = [];
		adapter.isConfigured(cfg);
		await adapter.start(startCtx(async (m) => void received.push(m)));
		const args = captured[0];
		assert.ok(args);
		// Push a dispatched inbound (the connection emits the post-gating shape).
		args.onMessage({
			conversationId: "+1555",
			from: "+1555",
			text: "hello",
			isGroup: false,
			raw: { sender: "+1555", text: "hello" },
		});
		assert.equal(received.length, 1);
		assert.equal(received[0]?.channel, "imessage");
		assert.equal(received[0]?.from, "+1555");
		assert.equal(received[0]?.chatType, "direct");
	});

	it("chunk-sends + plain-text-ifies markdown tables on sendText", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		adapter.isConfigured(cfg);
		await adapter.start(startCtx(async () => {}));
		await adapter.sendText("+1555", "| a | b |\n| --- | --- |\n| 1 | 2 |");
		assert.equal(conn.sentText.length, 1);
		assert.ok(!conn.sentText[0]?.text.includes("---"));
		assert.ok(conn.sentText[0]?.text.includes("a | b"));
	});

	it("reports starting health before start", () => {
		const adapter = createIMessageAdapter();
		const h = adapter.health?.();
		assert.equal(h?.ok, false);
		if (h && !h.ok) assert.equal(h.kind, "starting");
	});

	// Fix 2 — selfId() surfaces the configured selfHandle for the group mention gate.
	it("selfId() returns the normalised selfHandle after start", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		const cfgWithSelf = { channels: { imessage: { enabled: true, selfHandle: "+1 555 123 4567" } } } as never;
		adapter.isConfigured(cfgWithSelf);
		await adapter.start(startCtx(async () => {}));
		assert.equal(adapter.selfId?.(), "15551234567");
	});

	it("selfId() is undefined when no selfHandle is configured", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		adapter.isConfigured(cfg);
		await adapter.start(startCtx(async () => {}));
		assert.equal(adapter.selfId?.(), undefined);
	});

	// Fixes 2 & 9 — mentions[] forwarded + history context prepended to the body.
	it("forwards mentions[] and prepends the history context block", async () => {
		const captured: ConnectIMessageArgs[] = [];
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({
			connectImpl: async (args) => {
				captured.push(args);
				return conn;
			},
		});
		const received: InboundMessage[] = [];
		adapter.isConfigured(cfg);
		await adapter.start(startCtx(async (m) => void received.push(m)));
		const args = captured[0];
		assert.ok(args);
		args.onMessage({
			conversationId: "chat:7",
			from: "+1999",
			text: "current message",
			isGroup: true,
			mentions: ["15551234567"],
			historyContext: "[recent conversation context]\nAlice: earlier\n[end context]",
			raw: {},
		});
		assert.equal(received.length, 1);
		assert.deepEqual(received[0]?.mentions, ["15551234567"]);
		assert.ok(received[0]?.text.startsWith("[recent conversation context]"));
		assert.ok(received[0]?.text.includes("current message"));
	});

	// Fix 10 — config-driven textChunkLimit is honoured.
	it("honours a config-driven textChunkLimit when chunking", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		const cfgSmall = { channels: { imessage: { enabled: true, textChunkLimit: 20 } } } as never;
		adapter.isConfigured(cfgSmall);
		await adapter.start(startCtx(async () => {}));
		await adapter.sendText("+1555", "a".repeat(50));
		assert.ok(conn.sentText.length >= 2, "long text split into multiple chunks at the small limit");
		for (const s of conn.sentText) assert.ok(s.text.length <= 20, `chunk len ${s.text.length} <= 20`);
	});

	// Fix 10 — chunkMode "newline" delivers one message per line.
	it("chunkMode 'newline' sends one message per non-empty line", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		const cfgNl = { channels: { imessage: { enabled: true, chunkMode: "newline" } } } as never;
		adapter.isConfigured(cfgNl);
		await adapter.start(startCtx(async () => {}));
		await adapter.sendText("+1555", "line one\nline two\n\nline three");
		assert.equal(conn.sentText.length, 3);
		assert.deepEqual(
			conn.sentText.map((s) => s.text),
			["line one", "line two", "line three"],
		);
	});
});

// Fix 8 — setup wizard builds config incl. dmPolicy + allowFrom + selfHandle.
describe("createIMessageAdapter — setup wizard (Fix 8)", () => {
	it("prompts cliPath + dmPolicy + allowFrom + selfHandle and builds the config", () => {
		const adapter = createIMessageAdapter();
		const setup = adapter.setup;
		assert.ok(setup);
		const keys = setup!.credentialKeys.map((k) => k.key);
		assert.deepEqual(keys, ["cliPath", "dmPolicy", "allowFrom", "selfHandle"]);
		// The cliPath prompt carries the Full-Disk-Access + Automation guidance.
		const cliPrompt = setup!.credentialKeys.find((k) => k.key === "cliPath")?.prompt ?? "";
		assert.match(cliPrompt, /Full Disk Access/i);
		assert.match(cliPrompt, /Automation/i);
		// dmPolicy validation rejects junk.
		assert.equal(setup!.validateInput?.("dmPolicy", "nonsense"), "dmPolicy must be one of: pairing, allowlist, open, disabled.");
		assert.equal(setup!.validateInput?.("dmPolicy", "allowlist"), null);
		// buildAccountConfig assembles a full block.
		const out = setup!.buildAccountConfig!({
			cliPath: "/opt/imsg",
			dmPolicy: "allowlist",
			allowFrom: "+15555550123, user@example.com",
			selfHandle: "+15551234567",
		});
		assert.equal(out.enabled, true);
		assert.equal(out.cliPath, "/opt/imsg");
		assert.equal(out.dmPolicy, "allowlist");
		assert.deepEqual(out.allowFrom, ["+15555550123", "user@example.com"]);
		assert.equal(out.selfHandle, "+15551234567");
	});

	it("omits dmPolicy when left at the pairing default and skips empty allowFrom/selfHandle", () => {
		const adapter = createIMessageAdapter();
		const out = adapter.setup!.buildAccountConfig!({ cliPath: "", dmPolicy: "pairing", allowFrom: "", selfHandle: "" });
		assert.equal(out.dmPolicy, undefined);
		assert.equal(out.allowFrom, undefined);
		assert.equal(out.selfHandle, undefined);
		assert.equal(out.cliPath, undefined);
		assert.equal(out.enabled, true);
	});
});

describe("IMessageRpcClient (test-env guard)", () => {
	it("refuses to spawn a subprocess in the test environment", async () => {
		// The guard fires under NODE_ENV=test / VITEST. The hermetic runner doesn't
		// pin NODE_ENV, so force it for this one assertion (restore after) to prove
		// the production guard refuses rather than shelling out to a real binary.
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		try {
			const client = new IMessageRpcClient({ cliPath: "imsg" });
			await assert.rejects(() => client.start(), /Refusing to start imsg rpc/);
		} finally {
			if (prev === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prev;
		}
	});
});

// iMessage was the only channel without a typing indicator — every other one
// implements `setComposing`, so a thread just sat silent until the reply landed.
describe("iMessage adapter — typing indicator", () => {
	it("maps composing/paused onto the connection's typing call", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		await adapter.start(startCtx(async () => {}));
		await adapter.setComposing!("+15551234567", "composing");
		await adapter.setComposing!("+15551234567", "paused");
		assert.deepEqual(conn.typing, [true, false]);
	});
});
