import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createBlueBubblesAdapter } from "./adapter.js";
import type { BlueBubblesConnection, BlueBubblesInboundMessage, ConnectBlueBubblesArgs } from "./connection.js";
import type { BlueBubblesProbeResult } from "./probe.js";
import type { BrigadeConfig } from "../../../config/io.js";
import type { ChannelStartContext, InboundMessage } from "../sdk.js";

const ENV_PW = ["adp", "bb", "pw"].join("-");

function baseCfg(): BrigadeConfig {
	return {
		channels: { bluebubbles: { enabled: true, serverUrl: "http://10.0.0.1:1234", password: ENV_PW } },
	} as unknown as BrigadeConfig;
}

/** A fake connection capturing its connect args (so the test can push inbound) + recording actions. */
function makeFake(): {
	conn: BlueBubblesConnection;
	args: { value: ConnectBlueBubblesArgs | null };
	sends: Array<{ to: string; text: string }>;
	actions: string[];
	catchupRuns: { count: number };
} {
	const sends: Array<{ to: string; text: string }> = [];
	const actions: string[] = [];
	const catchupRuns = { count: 0 };
	const conn: BlueBubblesConnection = {
		feedWebhookEvent() {},
		async sendText(to, text) {
			sends.push({ to, text });
			return { messageId: "S-1" };
		},
		async sendMedia() {
			return { messageId: "M-1" };
		},
		async react() {
			actions.push("react");
		},
		async edit() {
			actions.push("edit");
		},
		async unsend() {
			actions.push("unsend");
		},
		async setTyping(_conversationId, typing) {
			actions.push(`typing:${typing ? "on" : "off"}`);
		},
		async markRead() {
			actions.push("mark-read");
		},
		async runCatchup() {
			catchupRuns.count++;
			return {
				querySucceeded: true,
				fetched: 0,
				replayed: 0,
				givenUp: 0,
				skippedGivenUp: 0,
				failed: 0,
				cursorBefore: null,
				cursorAfter: 0,
				windowStartMs: 0,
			};
		},
		setPrivateApi() {},
		setMacOSMajor() {},
		connectedAt: () => Date.now(),
		close() {},
	};
	return { conn, args: { value: null }, sends, actions, catchupRuns };
}

function startCtx(onInbound: (m: InboundMessage) => void): ChannelStartContext {
	return { log: () => {}, onInbound: async (m: InboundMessage) => onInbound(m) } as unknown as ChannelStartContext;
}

const probeOk = (privateApi: boolean | null, macOSMajor: number | null = null): typeof import("./probe.js").probeBlueBubbles =>
	(async (): Promise<BlueBubblesProbeResult> => ({ ok: true, privateApi, macOSMajor, elapsedMs: 1 })) as never;

describe("BlueBubbles adapter", () => {
	it("isConfigured requires enable + serverUrl + password", () => {
		const adapter = createBlueBubblesAdapter();
		assert.equal(adapter.isConfigured(baseCfg()), true);
		assert.equal(
			adapter.isConfigured(
				{ channels: { bluebubbles: { enabled: true, serverUrl: "http://x:1" } } } as never,
				{} as NodeJS.ProcessEnv,
			),
			false,
		);
		assert.equal(adapter.isConfigured({ channels: { bluebubbles: { enabled: false } } } as never), false);
	});

	it("steps aside for the default account when >1 account is configured", () => {
		const adapter = createBlueBubblesAdapter();
		const multi = {
			channels: {
				bluebubbles: {
					enabled: true,
					accounts: [
						{ id: "home", serverUrl: "http://a:1", password: "p" },
						{ id: "work", serverUrl: "http://b:1", password: "p" },
					],
				},
			},
		} as unknown as BrigadeConfig;
		assert.equal(adapter.isConfigured(multi), false);
	});

	it("dispatches an injected inbound message through onInbound", async () => {
		const fake = makeFake();
		const box: { received: InboundMessage | null } = { received: null };
		const adapter = createBlueBubblesAdapter({
			probeImpl: probeOk(true),
			connectImpl: (args) => {
				fake.args.value = args;
				return fake.conn;
			},
		});
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx((m) => (box.received = m)));
		const inbound: BlueBubblesInboundMessage = {
			conversationId: "chat_guid:iMessage;-;+1",
			chatGuid: "iMessage;-;+1",
			messageGuid: "M-9",
			from: "+1",
			text: "hi there",
			isGroup: false,
			attachments: [],
			raw: {},
		};
		fake.args.value!.onMessage(inbound);
		const received = box.received;
		assert.ok(received);
		assert.equal(received.channel, "bluebubbles");
		assert.equal(received.conversationId, "chat_guid:iMessage;-;+1");
		assert.equal(received.text, "hi there");
		assert.equal(received.messageId, "M-9");
	});

	it("surfaces an inbound tapback as a reaction dispatch (not a silent drop)", async () => {
		const fake = makeFake();
		const box: { received: InboundMessage | null } = { received: null };
		const adapter = createBlueBubblesAdapter({
			probeImpl: probeOk(true),
			connectImpl: (args) => {
				fake.args.value = args;
				return fake.conn;
			},
		});
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx((m) => (box.received = m)));
		// The connection decoded a tapback and called onTapback with it.
		fake.args.value!.onTapback!({
			emoji: "❤️",
			action: "added",
			chatGuid: "iMessage;-;+1",
			conversationId: "chat_guid:iMessage;-;+1",
			from: "+1",
			isGroup: false,
			targetGuid: "ORIG-1",
		});
		const received = box.received;
		assert.ok(received, "a tapback produced an inbound dispatch");
		assert.equal(received.channel, "bluebubbles");
		assert.deepEqual(received.reaction, { emojis: ["❤️"], targetMessageId: "ORIG-1" });
		assert.match(received.text, /ORIG-1/);
	});

	it("drops a tapback REMOVAL (only additions wake the agent)", async () => {
		const fake = makeFake();
		const box: { received: InboundMessage | null } = { received: null };
		const adapter = createBlueBubblesAdapter({
			probeImpl: probeOk(true),
			connectImpl: (args) => {
				fake.args.value = args;
				return fake.conn;
			},
		});
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx((m) => (box.received = m)));
		fake.args.value!.onTapback!({
			emoji: "❤️",
			action: "removed",
			chatGuid: "iMessage;-;+1",
			conversationId: "chat_guid:iMessage;-;+1",
			from: "+1",
			isGroup: false,
			targetGuid: "ORIG-1",
		});
		assert.equal(box.received, null, "a removal is not dispatched");
	});

	it("exposes the configured selfHandle as selfId() + surfaces mentions[] (Fix 7)", async () => {
		const fake = makeFake();
		const box: { received: InboundMessage | null } = { received: null };
		const adapter = createBlueBubblesAdapter({
			probeImpl: probeOk(true),
			connectImpl: (args) => {
				fake.args.value = args;
				return fake.conn;
			},
		});
		// selfHandle is normalised to digits for a phone.
		adapter.isConfigured({
			channels: { bluebubbles: { enabled: true, serverUrl: "http://10.0.0.1:1234", password: ENV_PW, selfHandle: "+1 (555) 123-4567" } },
		} as unknown as BrigadeConfig);
		await adapter.start(startCtx((m) => (box.received = m)));
		assert.equal(adapter.selfId?.(), "15551234567");
		// A group inbound carrying mentions surfaces them on the dispatched message.
		fake.args.value!.onMessage({
			conversationId: "chat_guid:iMessage;+;chatABC",
			chatGuid: "iMessage;+;chatABC",
			messageGuid: "M-1",
			from: "+1999",
			text: "hey 15551234567",
			isGroup: true,
			mentions: ["15551234567"],
			attachments: [],
			raw: {},
		});
		assert.ok(box.received);
		assert.deepEqual(box.received.mentions, ["15551234567"]);
	});

	it("advertises rich capabilities only when Private API is enabled", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		assert.equal(adapter.capabilities?.reactions, true);
		assert.equal(adapter.capabilities?.edit, true);
	});

	it("performs a react action when Private API is enabled", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		const r = await adapter.handleAction!({
			conversationId: "chat_guid:G",
			action: { kind: "react", messageId: "M", emoji: "👍" },
		});
		assert.equal(r.ok, true);
		assert.deepEqual(fake.actions, ["react"]);
	});

	it("refuses react when Private API is disabled", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(false), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		assert.equal(adapter.capabilities?.reactions, false);
		const r = await adapter.handleAction!({
			conversationId: "chat_guid:G",
			action: { kind: "react", messageId: "M", emoji: "👍" },
		});
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /Private API/);
	});

	it("performs an edit on macOS 15 (edit supported)", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true, 15), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		const r = await adapter.handleAction!({
			conversationId: "chat_guid:G",
			action: { kind: "edit", messageId: "M", text: "fixed" },
		});
		assert.equal(r.ok, true);
		assert.deepEqual(fake.actions, ["edit"]);
	});

	it("refuses edit cleanly on macOS 26+ (Apple removed iMessage edit)", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true, 26), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		const r = await adapter.handleAction!({
			conversationId: "chat_guid:G",
			action: { kind: "edit", messageId: "M", text: "fixed" },
		});
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /macOS 26/);
		assert.deepEqual(fake.actions, [], "no edit reached the connection");
	});

	it("setComposing maps composing/paused onto the connection's setTyping", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		await adapter.setComposing!("chat_guid:G", "composing");
		await adapter.setComposing!("chat_guid:G", "paused");
		assert.ok(fake.actions.includes("typing:on"));
		assert.ok(fake.actions.includes("typing:off"));
	});

	it("markRead forwards to the connection's markRead", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		await adapter.markRead!("chat_guid:G", "M-1");
		assert.ok(fake.actions.includes("mark-read"));
	});

	it("setup wizard exposes serverUrl/password + webhookPath/dmPolicy/allowFrom prompts", () => {
		const adapter = createBlueBubblesAdapter();
		const keys = (adapter.setup?.credentialKeys ?? []).map((k) => k.key);
		assert.deepEqual(keys, ["serverUrl", "password", "webhookPath", "dmPolicy", "allowFrom"]);
		// The webhook-path prompt carries the BlueBubbles-Server completion guidance.
		const webhookKey = adapter.setup?.credentialKeys.find((k) => k.key === "webhookPath");
		assert.match(webhookKey?.prompt ?? "", /BlueBubbles Server.*Webhooks/i);
	});

	it("setup validateInput rejects a bad dmPolicy + a non-slash webhook path", () => {
		const adapter = createBlueBubblesAdapter();
		assert.match(adapter.setup?.validateInput?.("dmPolicy", "whatever") ?? "", /pairing, allowlist, open, disabled/);
		assert.match(adapter.setup?.validateInput?.("webhookPath", "no-slash") ?? "", /must start with \//);
		assert.equal(adapter.setup?.validateInput?.("dmPolicy", "allowlist"), null);
		assert.equal(adapter.setup?.validateInput?.("webhookPath", "/bb/hook"), null);
	});

	it("setup buildAccountConfig assembles webhookPath + dmPolicy + allowFrom", () => {
		const adapter = createBlueBubblesAdapter();
		const built = adapter.setup?.buildAccountConfig?.({
			serverUrl: "http://10.0.0.5:1234",
			password: "ignored-here",
			webhookPath: "/bb/hook",
			dmPolicy: "allowlist",
			allowFrom: "+15555550123, user@example.com",
		});
		assert.equal(built?.enabled, true);
		assert.equal(built?.serverUrl, "http://10.0.0.5:1234");
		assert.equal(built?.webhookPath, "/bb/hook");
		assert.equal(built?.dmPolicy, "allowlist");
		assert.deepEqual(built?.allowFrom, ["+15555550123", "user@example.com"]);
	});

	it("setup buildAccountConfig omits dmPolicy when left at the pairing default + omits empty allowFrom", () => {
		const adapter = createBlueBubblesAdapter();
		const built = adapter.setup?.buildAccountConfig?.({ serverUrl: "http://10.0.0.5:1234", dmPolicy: "pairing", allowFrom: "" });
		assert.equal(built?.dmPolicy, undefined, "pairing is the default → not written");
		assert.equal(built?.allowFrom, undefined, "empty allowFrom → not written");
	});

	it("runs catch-up once on connect", async () => {
		const fake = makeFake();
		const adapter = createBlueBubblesAdapter({ probeImpl: probeOk(true), connectImpl: () => fake.conn });
		adapter.isConfigured(baseCfg());
		await adapter.start(startCtx(() => {}));
		// catch-up is fire-and-forget on connect; let the microtask settle.
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(fake.catchupRuns.count, 1);
	});
});
