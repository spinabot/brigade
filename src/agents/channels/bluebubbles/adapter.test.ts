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
} {
	const sends: Array<{ to: string; text: string }> = [];
	const actions: string[] = [];
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
		setPrivateApi() {},
		connectedAt: () => Date.now(),
		close() {},
	};
	return { conn, args: { value: null }, sends, actions };
}

function startCtx(onInbound: (m: InboundMessage) => void): ChannelStartContext {
	return { log: () => {}, onInbound: async (m: InboundMessage) => onInbound(m) } as unknown as ChannelStartContext;
}

const probeOk = (privateApi: boolean | null): typeof import("./probe.js").probeBlueBubbles =>
	(async (): Promise<BlueBubblesProbeResult> => ({ ok: true, privateApi, elapsedMs: 1 })) as never;

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
});
