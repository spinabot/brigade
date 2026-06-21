import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import { BrigadeExtensionRegistry } from "../../extensions/registry.js";
import type { ChannelStartContext, InboundMessage } from "../sdk.js";
import { createTelegramAdapter } from "./adapter.js";
import type { ConnectTelegramArgs, TelegramConnection } from "./connection.js";
import { telegramModule } from "./module.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

const enabledCfg = (botToken = "123456:AAExampleTokenValueABCDEFGHIJKLMNOP"): BrigadeConfig =>
	({ channels: { telegram: { enabled: true, botToken } } }) as unknown as BrigadeConfig;

/** Recorded calls to the fake connection's action methods (for parity assertions). */
interface FakeConnCalls {
	sentText: Array<{ chatId: string; text: string; html?: boolean; threadId?: string }>;
	sentInteractive: Array<{ chatId: string; text: string; replyMarkup: unknown; threadId?: string }>;
	polls: Array<{ chatId: string; question: string; options: string[] }>;
	edits: Array<{ chatId: string; messageId: string; text: string; html?: boolean }>;
	deletes: Array<{ chatId: string; messageId: string }>;
	reactions: Array<{ chatId: string; messageId: string; emoji: string }>;
	pins: Array<{ chatId: string; messageId: string }>;
	unpins: Array<{ chatId: string; messageId?: string }>;
	forumLabels: Array<{ chatId: string; threadId: string; name: string }>;
	commandMenus: Array<Array<{ command: string; description: string }>>;
	fedUpdates: unknown[];
}

/** A fake connection + the args it was constructed with (so tests can drive callbacks). */
interface FakeConnHandle {
	conn: TelegramConnection;
	args: ConnectTelegramArgs;
	sentText: FakeConnCalls["sentText"];
	calls: FakeConnCalls;
	connected: boolean;
	tokenInvalid: boolean;
}

function makeFakeConnectImpl(opts: { sendTextImpl?: FakeConnHandle["conn"]["sendText"]; mode?: "polling" | "webhook" } = {}): {
	connectImpl: (a: ConnectTelegramArgs) => Promise<TelegramConnection>;
	handle: () => FakeConnHandle | null;
} {
	let handle: FakeConnHandle | null = null;
	const connectImpl = async (args: ConnectTelegramArgs): Promise<TelegramConnection> => {
		const state = { connected: true, tokenInvalid: false };
		const calls: FakeConnCalls = {
			sentText: [],
			sentInteractive: [],
			polls: [],
			edits: [],
			deletes: [],
			reactions: [],
			pins: [],
			unpins: [],
			forumLabels: [],
			commandMenus: [],
			fedUpdates: [],
		};
		const conn: TelegramConnection = {
			selfId: () => "42",
			selfUsername: () => "brigadebot",
			connectedAt: () => 1234,
			isConnected: () => state.connected,
			isTokenInvalid: () => state.tokenInvalid,
			sendText:
				opts.sendTextImpl ??
				(async (chatId, text, o) => {
					calls.sentText.push({ chatId, text, html: o?.html, threadId: o?.threadId });
					return { messageId: calls.sentText.length };
				}),
			sendInteractive: async (chatId, text, replyMarkup, o) => {
				calls.sentInteractive.push({ chatId, text, replyMarkup, threadId: o?.threadId });
				return { messageId: calls.sentInteractive.length };
			},
			sendMedia: async () => {},
			sendPoll: async (chatId, poll) => {
				calls.polls.push({ chatId, question: poll.question, options: poll.options });
				return { messageId: calls.polls.length };
			},
			react: async (chatId, messageId, emoji) => {
				calls.reactions.push({ chatId, messageId, emoji });
			},
			editMessageText: async (chatId, messageId, text, o) => {
				calls.edits.push({ chatId, messageId, text, html: o?.html });
			},
			deleteMessage: async (chatId, messageId) => {
				calls.deletes.push({ chatId, messageId });
			},
			pinMessage: async (chatId, messageId) => {
				calls.pins.push({ chatId, messageId });
			},
			unpinMessage: async (chatId, messageId) => {
				calls.unpins.push({ chatId, messageId });
			},
			editForumTopic: async (chatId, threadId, name) => {
				calls.forumLabels.push({ chatId, threadId, name });
			},
			answerCallback: async () => {},
			getIdentity: async () => ({ id: 42, username: "brigadebot" }),
			setCommandMenu: async (commands) => {
				calls.commandMenus.push(commands);
			},
			feedUpdate: (update) => {
				calls.fedUpdates.push(update);
			},
			mode: () => opts.mode ?? "polling",
			setComposing: async () => {},
			markRead: async () => {},
			close: async () => {
				state.connected = false;
			},
		};
		handle = {
			conn,
			args,
			sentText: calls.sentText,
			calls,
			get connected() {
				return state.connected;
			},
			set connected(v: boolean) {
				state.connected = v;
			},
			get tokenInvalid() {
				return state.tokenInvalid;
			},
			set tokenInvalid(v: boolean) {
				state.tokenInvalid = v;
			},
		};
		// Mimic a successful connect → fire onConnected so the adapter flips healthy.
		args.onConnected?.();
		return conn;
	};
	return { connectImpl, handle: () => handle };
}

function makeStartCtx(over: Partial<ChannelStartContext> = {}): ChannelStartContext & { inbound: InboundMessage[] } {
	const inbound: InboundMessage[] = [];
	const ctx = {
		signal: new AbortController().signal,
		log: () => {},
		onInbound: async (m: InboundMessage) => {
			inbound.push(m);
		},
		inbound,
		...over,
	} as ChannelStartContext & { inbound: InboundMessage[] };
	return ctx;
}

describe("Telegram adapter identity + config gating", () => {
	it("identifies as the telegram channel", () => {
		const a = createTelegramAdapter();
		assert.equal(a.id, "telegram");
		assert.equal(a.label, "Telegram");
	});

	it("is configured only when enabled AND a token resolves", () => {
		const a = createTelegramAdapter();
		assert.equal(a.isConfigured({} as BrigadeConfig, {}), false);
		assert.equal(a.isConfigured({ channels: { telegram: {} } } as unknown as BrigadeConfig, {}), false);
		assert.equal(a.isConfigured({ channels: { telegram: { enabled: true } } } as unknown as BrigadeConfig, {}), false);
		assert.equal(a.isConfigured(enabledCfg(), {}), true);
	});

	it("honours the TELEGRAM_BOT_TOKEN env fallback for configuration", () => {
		const a = createTelegramAdapter();
		const cfg = { channels: { telegram: { enabled: true } } } as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
		assert.equal(a.isConfigured(cfg, { TELEGRAM_BOT_TOKEN: "123:ABC" } as NodeJS.ProcessEnv), true);
	});

	it("legacy adapter steps aside when >1 accounts are declared", () => {
		const legacy = createTelegramAdapter();
		const multiCfg = {
			channels: { telegram: { enabled: true, accounts: [{ id: "a", botToken: "1:AAA" }, { id: "b", botToken: "2:BBB" }] } },
		} as unknown as BrigadeConfig;
		assert.equal(legacy.isConfigured(multiCfg, {}), false);
	});

	it("exposes a pairing slot with idLabel='username'", () => {
		const a = createTelegramAdapter();
		assert.equal(a.pairing?.idLabel, "username");
	});

	it("declares a setup wizard prompting for botToken with an env fallback", () => {
		const a = createTelegramAdapter();
		assert.ok(a.setup, "Telegram needs a setup wizard (token-based, no QR)");
		assert.equal(a.setup?.credentialKeys[0]?.key, "botToken");
		assert.equal(a.setup?.credentialKeys[0]?.envVar, "TELEGRAM_BOT_TOKEN");
		// validateInput accepts a real-looking token + a ${VAR} ref, rejects junk.
		assert.equal(a.setup?.validateInput?.("botToken", "123456:AAExampleTokenValueABCDEFGHIJKLMNOP"), null);
		assert.equal(a.setup?.validateInput?.("botToken", "${TELEGRAM_BOT_TOKEN}"), null);
		assert.match(a.setup?.validateInput?.("botToken", "nope") ?? "", /bot token/i);
	});
});

describe("Telegram adapter no-throw before start()", () => {
	it("refuses sendText before start()", async () => {
		const a = createTelegramAdapter();
		await assert.rejects(() => a.sendText("555", "hi"), /not started/);
	});

	it("stop() / react() / setComposing() before start() are harmless no-ops", async () => {
		const a = createTelegramAdapter();
		assert.ok(a.react && a.setComposing, "adapter exposes react + setComposing slots");
		await a.stop();
		await a.react!("555", "1", "👍");
		await a.setComposing!("555", "composing");
	});

	it("health() before start() is 'starting'", () => {
		const a = createTelegramAdapter();
		assert.ok(a.health, "adapter exposes a health slot");
		const h = a.health!();
		assert.equal(h.ok, false);
		assert.equal(h.ok === false && h.kind, "starting");
	});
});

describe("Telegram adapter health transitions", () => {
	it("ok once connected, logged-out after token invalid, disconnected on drop", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		const health = a.health!.bind(a);
		a.isConfigured(enabledCfg(), {}); // capture config
		await a.start(makeStartCtx());
		assert.equal(health().ok, true);

		// Simulate a transient drop.
		handle()!.connected = false;
		const drop = health();
		assert.equal(drop.ok, false);
		assert.equal(drop.ok === false && drop.kind, "disconnected");

		// Simulate the connection going token-invalid (sticky logged-out).
		handle()!.connected = true;
		handle()!.tokenInvalid = true;
		const dead = health();
		assert.equal(dead.ok, false);
		assert.equal(dead.ok === false && dead.kind, "logged-out");
	});

	it("onTokenInvalid callback flips the adapter to logged-out", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		const health = a.health!.bind(a);
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		assert.equal(health().ok, true);
		handle()!.args.onTokenInvalid?.();
		const h = health();
		assert.equal(h.ok === false && h.kind, "logged-out");
	});
});

describe("Telegram adapter inbound wiring", () => {
	it("stamps channel + accountId and forwards the deferred media thunk", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const ctx = makeStartCtx();
		await a.start(ctx);
		const thunk = async () => [];
		handle()!.args.onMessage({
			conversationId: "555",
			messageId: "1",
			from: "555",
			fromName: "Alice",
			text: "hi",
			chatType: "group",
			threadId: "88",
			mentions: ["42"],
			resolveMedia: thunk,
			raw: {} as never,
		});
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(ctx.inbound.length, 1);
		const msg = ctx.inbound[0]!;
		assert.equal(msg.channel, "telegram");
		assert.equal(msg.accountId, "default");
		assert.equal(msg.conversationId, "555");
		assert.equal(msg.isGroup, true);
		assert.equal(msg.threadId, "88");
		assert.deepEqual(msg.mentions, ["42"]);
		assert.equal(msg.resolveMedia, thunk, "deferred media thunk must pass through untouched");
	});
});

describe("Telegram adapter sendText chunk → HTML → send", () => {
	it("converts markdown to HTML and sends with html=true", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		await a.sendText("555", "hello **world**");
		const sent = handle()!.sentText;
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.text, "hello <b>world</b>");
		assert.equal(sent[0]?.html, true);
	});

	it("retries as PLAIN text when the HTML send hits a parse error", async () => {
		const calls: Array<{ text: string; html?: boolean }> = [];
		const sendTextImpl: TelegramConnection["sendText"] = async (_chatId, text, o) => {
			calls.push({ text, html: o?.html });
			if (o?.html) throw new Error("Bad Request: can't parse entities: unexpected end tag");
			return { messageId: calls.length };
		};
		const { connectImpl } = makeFakeConnectImpl({ sendTextImpl });
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		await a.sendText("555", "tricky **md**");
		assert.equal(calls.length, 2, "one HTML attempt + one plain fallback");
		assert.equal(calls[0]?.html, true);
		assert.equal(calls[1]?.html, undefined);
		assert.equal(calls[1]?.text, "tricky **md**", "fallback sends the raw chunk, not the HTML");
	});

	it("chunks long text under the 4096 limit into multiple sends", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		// Two paragraphs each ~3000 chars → must split into ≥2 sends.
		const para = "x".repeat(3000);
		await a.sendText("555", `${para}\n\n${para}`);
		assert.ok(handle()!.sentText.length >= 2, `expected ≥2 chunks, got ${handle()!.sentText.length}`);
	});

	it("rejects sendText after token invalid", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		handle()!.tokenInvalid = true;
		await assert.rejects(() => a.sendText("555", "hi"), /token is invalid/i);
	});
});

describe("Telegram adapter capabilities", () => {
	it("advertises edit / unsend / reactions / reply / threads / media / polls / nativeCommands", () => {
		const a = createTelegramAdapter();
		const caps = a.capabilities;
		assert.ok(caps, "adapter must advertise capabilities");
		assert.equal(caps?.edit, true);
		assert.equal(caps?.unsend, true);
		assert.equal(caps?.reactions, true);
		assert.equal(caps?.reply, true);
		assert.equal(caps?.threads, true);
		assert.equal(caps?.media, true);
		assert.equal(caps?.polls, true);
		assert.equal(caps?.nativeCommands, true);
		assert.deepEqual(caps?.chatTypes, ["direct", "group", "thread"]);
	});
});

describe("Telegram adapter handleAction dispatch", () => {
	async function started() {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		return { a, handle: () => handle()! };
	}

	it("edit → editMessageText with HTML-converted text + ok result", async () => {
		const { a, handle } = await started();
		const r = await a.handleAction!({ conversationId: "555", action: { kind: "edit", messageId: "7", text: "new **bold**" } });
		assert.equal(r.ok, true);
		assert.equal(r.messageId, "7");
		const edits = handle().calls.edits;
		assert.equal(edits.length, 1);
		assert.equal(edits[0]?.messageId, "7");
		assert.equal(edits[0]?.text, "new <b>bold</b>", "edit text runs through the HTML formatter");
		assert.equal(edits[0]?.html, true);
	});

	it("delete → deleteMessage", async () => {
		const { a, handle } = await started();
		const r = await a.handleAction!({ conversationId: "555", action: { kind: "delete", messageId: "9" } });
		assert.equal(r.ok, true);
		assert.deepEqual(handle().calls.deletes, [{ chatId: "555", messageId: "9" }]);
	});

	it("react → setMessageReaction (via connection.react)", async () => {
		const { a, handle } = await started();
		const r = await a.handleAction!({ conversationId: "555", action: { kind: "react", messageId: "3", emoji: "👍" } });
		assert.equal(r.ok, true);
		assert.deepEqual(handle().calls.reactions, [{ chatId: "555", messageId: "3", emoji: "👍" }]);
	});

	it("pin / unpin → pinChatMessage / unpinChatMessage", async () => {
		const { a, handle } = await started();
		await a.handleAction!({ conversationId: "555", action: { kind: "pin", messageId: "5" } });
		await a.handleAction!({ conversationId: "555", action: { kind: "unpin", messageId: "5" } });
		assert.deepEqual(handle().calls.pins, [{ chatId: "555", messageId: "5" }]);
		assert.deepEqual(handle().calls.unpins, [{ chatId: "555", messageId: "5" }]);
	});

	it("returns ok:false when the connection method throws", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		// Make delete throw.
		handle()!.conn.deleteMessage = async () => {
			throw new Error("Bad Request: message to delete not found");
		};
		const r = await a.handleAction!({ conversationId: "555", action: { kind: "delete", messageId: "404" } });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /message to delete not found/);
	});

	it("handleAction before start returns ok:false (not started)", async () => {
		const a = createTelegramAdapter();
		const r = await a.handleAction!({ conversationId: "555", action: { kind: "delete", messageId: "1" } });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /not started/);
	});
});

describe("Telegram adapter sendPoll", () => {
	it("normalizes + forwards a poll to the connection", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		const tg = a as ReturnType<typeof createTelegramAdapter> & {
			sendPoll: (c: string, p: { question: string; options: string[] }) => Promise<{ messageId?: string }>;
		};
		const out = await tg.sendPoll("555", { question: "Lunch?", options: ["Pizza", "Sushi"] });
		assert.equal(out.messageId, "1");
		assert.deepEqual(handle()!.calls.polls, [{ chatId: "555", question: "Lunch?", options: ["Pizza", "Sushi"] }]);
	});

	it("rejects a poll with fewer than 2 options", async () => {
		const { connectImpl } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		const tg = a as ReturnType<typeof createTelegramAdapter> & {
			sendPoll: (c: string, p: { question: string; options: string[] }) => Promise<{ messageId?: string }>;
		};
		await assert.rejects(() => tg.sendPoll("555", { question: "?", options: ["only one"] }), /at least 2 options/);
	});
});

describe("Telegram adapter native approval prompt", () => {
	it("sendApprovalPrompt renders an inline keyboard via sendInteractive", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		const cap = a.approvalCapability?.sendApprovalPrompt;
		assert.ok(cap, "adapter must expose sendApprovalPrompt");
		await cap!({
			runtime: {} as never,
			cfg: {} as never,
			conversationId: "555",
			approvalId: "exec-abc-123",
			approvalKind: "exec",
			command: "rm -rf /tmp/x",
			timeoutMs: 300000,
		});
		const sent = handle()!.calls.sentInteractive;
		assert.equal(sent.length, 1, "approval prompt goes through the interactive (reply_markup) path");
		const markup = sent[0]?.replyMarkup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
		assert.ok(Array.isArray(markup?.inline_keyboard), "must carry an inline keyboard");
		const flat = (markup.inline_keyboard ?? []).flat();
		// Three buttons: Allow once / Allow always / Deny.
		assert.equal(flat.length, 3);
		assert.deepEqual(
			flat.map((b) => b.text),
			["Allow once", "Allow always", "Deny"],
		);
		// callback_data must be the codec payload (decodes back to the approval id).
		for (const b of flat) assert.match(b.callback_data, /^bv1:/);
	});

	it("authorizeApprover passes through to the channel's approver gate", () => {
		const a = createTelegramAdapter();
		const verdict = a.approvalCapability?.authorizeApprover?.({
			cfg: {} as never,
			senderId: "555",
			action: "approve",
			approvalKind: "exec",
		});
		// No allow-from configured → authorized.
		assert.equal(verdict?.authorized, true);
	});
});

describe("Telegram adapter callback_query inbound", () => {
	it("forwards a button press as an InboundMessage carrying callbackQuery", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createTelegramAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const ctx = makeStartCtx();
		await a.start(ctx);
		handle()!.args.onCallbackQuery?.({
			conversationId: "555",
			from: "555",
			fromName: "Alice",
			text: "",
			chatType: "direct",
			callbackQuery: { data: "bv1:ZXhlYy1hYmM:o", callbackId: "cbq-1" },
			raw: {} as never,
		});
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(ctx.inbound.length, 1);
		const msg = ctx.inbound[0]!;
		assert.equal(msg.channel, "telegram");
		assert.equal(msg.accountId, "default");
		assert.deepEqual(msg.callbackQuery, { data: "bv1:ZXhlYy1hYmM:o", callbackId: "cbq-1" });
	});
});

describe("Telegram adapter webhook feed", () => {
	it("feedWebhookUpdate forwards to the connection; transportMode reflects mode", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl({ mode: "webhook" });
		const a = createTelegramAdapter({ connectImpl }) as ReturnType<typeof createTelegramAdapter> & {
			feedWebhookUpdate: (u: unknown) => void;
			transportMode: () => string;
		};
		assert.equal(a.transportMode(), "unstarted");
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx());
		assert.equal(a.transportMode(), "webhook");
		a.feedWebhookUpdate({ update_id: 1, message: { text: "hi" } });
		assert.equal(handle()!.calls.fedUpdates.length, 1);
		// Non-object updates are ignored defensively.
		a.feedWebhookUpdate(null);
		a.feedWebhookUpdate("nope");
		assert.equal(handle()!.calls.fedUpdates.length, 1);
	});
});

describe("telegramModule", () => {
	it("registers exactly one telegram channel through the seam", () => {
		const reg = new BrigadeExtensionRegistry();
		telegramModule.register(reg.context(META));
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.channels[0]?.id, "telegram");
		// product-only: registers no tools/hooks into the Pi factory
		assert.deepEqual(reg.toolNames(), []);
	});

	it("registers a webhook HTTP route when webhook mode is configured", () => {
		const reg = new BrigadeExtensionRegistry();
		const webhookCfg = {
			channels: {
				telegram: {
					enabled: true,
					botToken: "1:AAA",
					mode: "webhook",
					webhook: { url: "https://bot.example.com/tg", secretToken: "s3cr3t", path: "/telegram/webhook" },
				},
			},
		} as unknown as BrigadeConfig;
		telegramModule.register(reg.context({ ...META, config: webhookCfg }));
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.httpRoutes.length, 1, "webhook mode registers one HTTP route");
		assert.equal(reg.httpRoutes[0]?.path, "/telegram/webhook");
		assert.equal(reg.httpRoutes[0]?.method, "POST");
		assert.equal(reg.httpRoutes[0]?.auth, "none");
	});

	it("registers NO HTTP route in polling mode (default)", () => {
		const reg = new BrigadeExtensionRegistry();
		telegramModule.register(reg.context({ ...META, config: enabledCfg() }));
		assert.equal(reg.httpRoutes.length, 0, "polling mode exposes no inbound HTTP surface");
	});
});
