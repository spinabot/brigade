import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Message, Update } from "@grammyjs/types";

import {
	connectTelegram,
	isTelegramGetUpdatesConflict,
	isTelegramUnauthorized,
	redactTelegramToken,
	telegramBackoffDelay,
	type TelegramBotLike,
	type TgInboundMessage,
} from "./connection.js";

/* ─────────────────────── fake bot + runner harness ─────────────────────── */

type MessageHandler = (ctx: { update: Update; message?: Message }) => unknown;
type CallbackHandler = (ctx: {
	update: Update;
	callbackQuery?: unknown;
	answerCallbackQuery: (opts?: Record<string, unknown>) => Promise<unknown>;
}) => unknown;

interface FakeRunner {
	isRunning(): boolean;
	stop(): void;
	task(): Promise<void>;
	/** Resolve the active task() with an optional thrown error. */
	finish(err?: unknown): void;
}

interface FakeBot extends TelegramBotLike {
	handlers: MessageHandler[];
	callbackHandlers: CallbackHandler[];
	deletedWebhook: boolean;
	stopped: number;
	/** Push a message update into all registered message handlers. */
	emit(update: Update): void;
	/** Push a callback_query update into all registered callback handlers. */
	emitCallback(update: Update): void;
	sent: Array<{ chatId: string | number; text: string; opts?: Record<string, unknown> }>;
	/** Recorded calls to the action / menu / webhook API methods. */
	calls: {
		polls: Array<{ chatId: string | number; question: string; options: string[]; opts?: Record<string, unknown> }>;
		edits: Array<{ chatId: string | number; messageId: number; text: string; opts?: Record<string, unknown> }>;
		deletes: Array<{ chatId: string | number; messageId: number }>;
		reactions: Array<{ chatId: string | number; messageId: number; reaction: unknown }>;
		pins: Array<{ chatId: string | number; messageId: number; opts?: Record<string, unknown> }>;
		unpins: Array<{ chatId: string | number; opts?: Record<string, unknown> }>;
		forumLabels: Array<{ chatId: string | number; threadId: number; opts?: Record<string, unknown> }>;
		commandMenus: Array<Array<{ command: string; description: string }>>;
		answeredCallbacks: Array<{ id: string; opts?: Record<string, unknown> }>;
		setWebhooks: Array<{ url: string; opts?: Record<string, unknown> }>;
	};
}

function makeFakeBot(overrides: Partial<TelegramBotLike["api"]> & { meId?: number; meUsername?: string } = {}): FakeBot {
	const handlers: MessageHandler[] = [];
	const callbackHandlers: CallbackHandler[] = [];
	const sent: FakeBot["sent"] = [];
	const calls: FakeBot["calls"] = {
		polls: [],
		edits: [],
		deletes: [],
		reactions: [],
		pins: [],
		unpins: [],
		forumLabels: [],
		commandMenus: [],
		answeredCallbacks: [],
		setWebhooks: [],
	};
	const bot: FakeBot = {
		handlers,
		callbackHandlers,
		deletedWebhook: false,
		stopped: 0,
		sent,
		calls,
		api: {
			async getMe() {
				return {
					id: overrides.meId ?? 42,
					username: overrides.meUsername ?? "brigadebot",
					first_name: "Brigade",
					can_join_groups: true,
				};
			},
			async deleteWebhook() {
				bot.deletedWebhook = true;
				return true;
			},
			async sendMessage(chatId, text, opts) {
				sent.push({ chatId, text, opts });
				return { message_id: sent.length };
			},
			async sendChatAction() {
				return true;
			},
			async getFile() {
				return { file_path: "photos/file_1.jpg", file_unique_id: "uniq1" };
			},
			async sendPoll(chatId, question, options, opts) {
				calls.polls.push({ chatId, question, options, opts });
				return { message_id: 999 };
			},
			async editMessageText(chatId, messageId, text, opts) {
				calls.edits.push({ chatId, messageId, text, opts });
				return true;
			},
			async deleteMessage(chatId, messageId) {
				calls.deletes.push({ chatId, messageId });
				return true;
			},
			async setMessageReaction(chatId, messageId, reaction) {
				calls.reactions.push({ chatId, messageId, reaction });
				return true;
			},
			async pinChatMessage(chatId, messageId, opts) {
				calls.pins.push({ chatId, messageId, opts });
				return true;
			},
			async unpinChatMessage(chatId, opts) {
				calls.unpins.push({ chatId, opts });
				return true;
			},
			async editForumTopic(chatId, threadId, opts) {
				calls.forumLabels.push({ chatId, threadId, opts });
				return true;
			},
			async setMyCommands(commands) {
				calls.commandMenus.push(commands);
				return true;
			},
			async answerCallbackQuery(id, opts) {
				calls.answeredCallbacks.push({ id, opts });
				return true;
			},
			async setWebhook(url, opts) {
				calls.setWebhooks.push({ url, opts });
				return true;
			},
			...overrides,
		},
		on(filter, handler) {
			if (filter === "callback_query") callbackHandlers.push(handler as CallbackHandler);
			else handlers.push(handler as MessageHandler);
		},
		stop() {
			bot.stopped += 1;
		},
		emit(update: Update) {
			for (const h of handlers) h({ update, message: update.message });
		},
		emitCallback(update: Update) {
			const cb = (update as { callback_query?: unknown }).callback_query;
			for (const h of callbackHandlers) {
				h({
					update,
					callbackQuery: cb,
					answerCallbackQuery: async (opts) => {
						const id = (cb as { id?: string })?.id ?? "";
						calls.answeredCallbacks.push({ id, opts: opts ?? undefined });
						return true;
					},
				});
			}
		},
	};
	return bot;
}

function makeFakeRunner(): FakeRunner {
	let running = true;
	let resolveTask: (() => void) | undefined;
	let rejectTask: ((e: unknown) => void) | undefined;
	const taskPromise = new Promise<void>((resolve, reject) => {
		resolveTask = resolve;
		rejectTask = reject;
	});
	return {
		isRunning: () => running,
		// grammY's runner.stop() resolves the pending task() — mirror that so a
		// close()/teardown unblocks the supervise loop's `await r.task()`.
		stop: () => {
			running = false;
			resolveTask?.();
		},
		task: () => taskPromise,
		finish: (err?: unknown) => {
			running = false;
			if (err !== undefined) rejectTask?.(err);
			else resolveTask?.();
		},
	};
}

/** Build a minimal grammY Message for normalization tests. */
function makeMessage(over: Partial<Message> = {}): Message {
	return {
		message_id: 1001,
		date: 1_700_000_000,
		chat: { id: 555, type: "private", first_name: "Alice" },
		from: { id: 555, is_bot: false, first_name: "Alice", username: "alice" },
		text: "hello",
		...over,
	} as Message;
}

const noopLog = () => {};
const instantSleep = async () => {};

/* ─────────────────────────── error classifiers ─────────────────────────── */

describe("telegram error classifiers", () => {
	it("isTelegramUnauthorized matches 401 + 'Unauthorized'", () => {
		assert.equal(isTelegramUnauthorized({ error_code: 401, description: "Unauthorized" }), true);
		assert.equal(isTelegramUnauthorized(new Error("401: Unauthorized")), true);
		assert.equal(isTelegramUnauthorized({ error_code: 409 }), false);
	});

	it("isTelegramGetUpdatesConflict matches 409 conflict", () => {
		assert.equal(
			isTelegramGetUpdatesConflict({ error_code: 409, description: "Conflict: terminated by other getUpdates request" }),
			true,
		);
		assert.equal(isTelegramGetUpdatesConflict({ error_code: 401 }), false);
		assert.equal(isTelegramGetUpdatesConflict({ error_code: 409, description: "something else" }), false);
	});

	it("redactTelegramToken strips the exact token and bot<token> URL fragments", () => {
		const token = "123456:AAExampleTokenValueABCDEFGHIJKLMNOP";
		assert.equal(redactTelegramToken(`url /bot${token}/getMe`, token), "url /bot<redacted>/getMe");
		assert.match(redactTelegramToken("see https://api.telegram.org/bot999888:ZZZZZZZZZZZZZZZZZZZZZZ/x", "other"), /bot<redacted>/);
	});
});

describe("telegramBackoffDelay", () => {
	it("grows with attempts and is capped at 30s", () => {
		const a0 = telegramBackoffDelay(0);
		assert.ok(a0 >= 1500 && a0 <= 2500, `first attempt ~2s, got ${a0}`);
		// Large attempt is capped near 30s (±25% jitter).
		const big = telegramBackoffDelay(20);
		assert.ok(big >= 22_000 && big <= 38_000, `capped near 30s, got ${big}`);
	});
});

/* ─────────────────────────── lifecycle ─────────────────────────── */

describe("connectTelegram lifecycle", () => {
	it("deletes the webhook before polling and reports connected + self", async () => {
		const bot = makeFakeBot({ meId: 42, meUsername: "brigadebot" });
		const runner = makeFakeRunner();
		let connectedCalls = 0;
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onConnected: () => {
				connectedCalls += 1;
			},
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		assert.equal(bot.deletedWebhook, true, "webhook must be cleared before polling");
		assert.equal(conn.isConnected(), true);
		assert.equal(conn.selfId(), "42");
		assert.equal(conn.selfUsername(), "brigadebot");
		assert.equal(connectedCalls, 1);
		assert.ok(conn.connectedAt() && conn.connectedAt()! > 0);
		runner.finish();
		await conn.close();
	});

	it("401 on getMe → sticky tokenInvalid, no reconnect, onTokenInvalid fires", async () => {
		let attempts = 0;
		const bot = makeFakeBot();
		bot.api.getMe = async () => {
			attempts += 1;
			throw { error_code: 401, description: "Unauthorized" };
		};
		let invalidCalls = 0;
		const conn = await connectTelegram({
			token: "bad",
			log: noopLog,
			onTokenInvalid: () => {
				invalidCalls += 1;
			},
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => makeFakeRunner(),
			sleepImpl: instantSleep,
		});
		assert.equal(conn.isTokenInvalid(), true);
		assert.equal(conn.isConnected(), false);
		assert.equal(invalidCalls, 1);
		assert.equal(attempts, 1, "must NOT retry a 401");
		await conn.close();
	});

	it("409 conflict clears the webhook and restarts once", async () => {
		let getMeCalls = 0;
		let webhookClears = 0;
		const runners: FakeRunner[] = [];
		const bot = makeFakeBot();
		bot.api.getMe = async () => {
			getMeCalls += 1;
			return { id: 7, username: "b" };
		};
		bot.api.deleteWebhook = async () => {
			webhookClears += 1;
			return true;
		};
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => {
				const r = makeFakeRunner();
				runners.push(r);
				return r;
			},
			sleepImpl: instantSleep,
		});
		// First runner errors with a 409 conflict → the loop should clear the
		// webhook again and start a SECOND runner.
		runners[0]?.finish({ error_code: 409, description: "Conflict: terminated by other getUpdates" });
		// Give the loop a couple of microtask turns to spin up the restart.
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(getMeCalls >= 2, `expected a restart (getMe called ${getMeCalls}x)`);
		assert.ok(webhookClears >= 2, `webhook re-cleared on conflict restart (cleared ${webhookClears}x)`);
		await conn.close();
	});
});

/* ─────────────────────────── inbound normalization ─────────────────────────── */

describe("connectTelegram inbound normalization", () => {
	async function captureInbound(message: Message, opts: { meId?: number; meUsername?: string } = {}): Promise<TgInboundMessage> {
		const bot = makeFakeBot({ meId: opts.meId ?? 42, meUsername: opts.meUsername ?? "brigadebot" });
		const runner = makeFakeRunner();
		const received: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: (m) => received.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		bot.emit({ update_id: 1, message } as Update);
		runner.finish();
		await conn.close();
		assert.equal(received.length, 1, "exactly one inbound expected");
		return received[0]!;
	}

	it("normalizes a basic DM", async () => {
		const m = await captureInbound(makeMessage({ text: "hi there" }));
		assert.equal(m.conversationId, "555");
		assert.equal(m.from, "555");
		assert.equal(m.fromName, "Alice");
		assert.equal(m.text, "hi there");
		assert.equal(m.chatType, "direct");
		assert.equal(m.messageId, "1001");
		assert.equal(m.messageTimestampMs, 1_700_000_000 * 1000);
		assert.equal(m.threadId, undefined);
		assert.equal(m.mentions, undefined);
	});

	it("maps supergroup → group and surfaces message_thread_id as threadId", async () => {
		const m = await captureInbound(
			makeMessage({
				chat: { id: -100, type: "supergroup", title: "Room" } as Message["chat"],
				message_thread_id: 88,
				text: "in a topic",
			}),
		);
		assert.equal(m.chatType, "group");
		assert.equal(m.threadId, "88");
	});

	it("extracts reply context (id, sender, truncated body)", async () => {
		const reply = makeMessage({ message_id: 900, from: { id: 1, is_bot: false, first_name: "Bob" }, text: "original body" });
		const m = await captureInbound(makeMessage({ reply_to_message: reply as Message["reply_to_message"], text: "a reply" }));
		assert.ok(m.replyTo);
		assert.equal(m.replyTo?.messageId, "900");
		assert.equal(m.replyTo?.from, "1");
		assert.equal(m.replyTo?.body, "original body");
	});

	it("surfaces the bot's own id in mentions when @-mentioned in a group", async () => {
		const text = "hey @brigadebot do the thing";
		const m = await captureInbound(
			makeMessage({
				chat: { id: -100, type: "group", title: "G" } as Message["chat"],
				text,
				entities: [{ type: "mention", offset: 4, length: 11 }],
			}),
		);
		assert.deepEqual(m.mentions, ["42"], "bot id must appear so the central group ACL treats it as addressed");
	});

	it("expands text_link entities back into markdown link syntax", async () => {
		const m = await captureInbound(
			makeMessage({
				text: "see docs here",
				entities: [{ type: "text_link", offset: 4, length: 4, url: "https://x.io" }],
			}),
		);
		assert.equal(m.text, "see [docs](https://x.io) here");
	});

	it("DEFERS media: resolveMedia thunk is present but NOT called during normalize", async () => {
		let getFileCalls = 0;
		const bot = makeFakeBot();
		bot.api.getFile = async () => {
			getFileCalls += 1;
			return { file_path: "photos/x.jpg", file_unique_id: "u" };
		};
		const runner = makeFakeRunner();
		const received: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: (m) => received.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		const photoMsg = makeMessage({
			text: "",
			caption: "a pic",
			photo: [{ file_id: "small", file_unique_id: "s", width: 90, height: 90 }, { file_id: "big", file_unique_id: "b", width: 800, height: 800 }],
		} as Partial<Message>);
		bot.emit({ update_id: 5, message: photoMsg } as Update);
		runner.finish();
		await conn.close();
		assert.equal(received.length, 1);
		assert.equal(typeof received[0]?.resolveMedia, "function", "media-bearing message must carry a deferred thunk");
		assert.equal(getFileCalls, 0, "normalize must NOT download — download is deferred to the pipeline");
	});

	it("dedupes by update_id — a redelivered update runs the agent once", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const received: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: (m) => received.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		const update = { update_id: 77, message: makeMessage({ text: "once" }) } as Update;
		bot.emit(update);
		bot.emit(update); // redelivery after a (hypothetical) restart
		runner.finish();
		await conn.close();
		assert.equal(received.length, 1, "the same update_id must not double-run");
	});

	it("ignores the bot's own messages (self id)", async () => {
		const bot = makeFakeBot({ meId: 42 });
		const runner = makeFakeRunner();
		const received: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: (m) => received.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		// A message whose `from.id` equals the bot's own id.
		bot.emit({ update_id: 9, message: makeMessage({ from: { id: 42, is_bot: true, first_name: "Brigade" } }) } as Update);
		runner.finish();
		await conn.close();
		assert.equal(received.length, 0);
	});
});

/* ─────────────────────────── outbound ─────────────────────────── */

describe("connectTelegram outbound", () => {
	it("sendText with html opt sets parse_mode HTML", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		await conn.sendText("555", "<b>hi</b>", { html: true });
		assert.equal(bot.sent.length, 1);
		assert.equal(bot.sent[0]?.text, "<b>hi</b>");
		assert.equal(bot.sent[0]?.opts?.parse_mode, "HTML");
		runner.finish();
		await conn.close();
	});

	it("sendText rejects after a 401 marked the token invalid", async () => {
		const bot = makeFakeBot();
		bot.api.getMe = async () => {
			throw { error_code: 401, description: "Unauthorized" };
		};
		const conn = await connectTelegram({
			token: "bad",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => makeFakeRunner(),
			sleepImpl: instantSleep,
		});
		await assert.rejects(() => conn.sendText("555", "hi"), /token is invalid/i);
		await conn.close();
	});

	it("sendPoll forwards question + options + is_anonymous default", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		const res = await conn.sendPoll("555", { question: "Pick", options: ["a", "b", "c"] });
		assert.equal(res.messageId, 999);
		assert.equal(bot.calls.polls.length, 1);
		assert.equal(bot.calls.polls[0]?.question, "Pick");
		assert.deepEqual(bot.calls.polls[0]?.options, ["a", "b", "c"]);
		assert.equal(bot.calls.polls[0]?.opts?.is_anonymous, true);
		runner.finish();
		await conn.close();
	});

	it("editMessageText sets parse_mode HTML when html opt is set", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		await conn.editMessageText("555", "7", "<b>fixed</b>", { html: true });
		assert.equal(bot.calls.edits.length, 1);
		assert.equal(bot.calls.edits[0]?.messageId, 7);
		assert.equal(bot.calls.edits[0]?.opts?.parse_mode, "HTML");
		runner.finish();
		await conn.close();
	});

	it("pinMessage uses disable_notification; unpinMessage passes message_id", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		await conn.pinMessage("555", "5");
		await conn.unpinMessage("555", "5");
		assert.equal(bot.calls.pins[0]?.messageId, 5);
		assert.equal(bot.calls.pins[0]?.opts?.disable_notification, true);
		assert.equal(bot.calls.unpins[0]?.opts?.message_id, 5);
		runner.finish();
		await conn.close();
	});

	it("editForumTopic clamps the name to 128 chars + best-effort swallows errors", async () => {
		const bot = makeFakeBot();
		bot.api.editForumTopic = async () => {
			throw new Error("Bad Request: not a forum");
		};
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		// Must not throw even though editForumTopic rejects (cosmetic).
		await conn.editForumTopic("555", "88", "x".repeat(200));
		runner.finish();
		await conn.close();
	});
});

/* ─────────────────────────── command menu on connect ─────────────────────────── */

describe("connectTelegram command menu", () => {
	it("calls setMyCommands on connect with the supplied menu", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			commandMenu: [
				{ command: "help", description: "Show help" },
				{ command: "status", description: "Show status" },
			],
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		assert.equal(bot.calls.commandMenus.length, 1, "command menu synced on connect");
		assert.deepEqual(
			bot.calls.commandMenus[0]?.map((c) => c.command),
			["help", "status"],
		);
		runner.finish();
		await conn.close();
	});

	it("getIdentity returns the cached getMe identity", async () => {
		const bot = makeFakeBot({ meId: 7, meUsername: "probebot" });
		const runner = makeFakeRunner();
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		const id = await conn.getIdentity();
		assert.equal(id?.id, 7);
		assert.equal(id?.username, "probebot");
		assert.equal(id?.can_join_groups, true);
		runner.finish();
		await conn.close();
	});
});

/* ─────────────────────────── callback_query (inline buttons) ─────────────────────────── */

describe("connectTelegram callback_query", () => {
	it("acks the press + routes an inbound carrying callbackQuery {data, callbackId}", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const callbacks: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			onCallbackQuery: (m) => callbacks.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		bot.emitCallback({
			update_id: 21,
			callback_query: {
				id: "cbq-9",
				data: "bv1:ZXhlYy1hYmM:o",
				from: { id: 555, first_name: "Alice" },
				message: makeMessage({ chat: { id: 555, type: "private", first_name: "Alice" } }),
			},
		} as unknown as Update);
		runner.finish();
		await conn.close();
		assert.equal(callbacks.length, 1, "one callback inbound expected");
		assert.equal(callbacks[0]?.conversationId, "555");
		assert.equal(callbacks[0]?.from, "555");
		assert.deepEqual(callbacks[0]?.callbackQuery, { data: "bv1:ZXhlYy1hYmM:o", callbackId: "cbq-9" });
		assert.ok(bot.calls.answeredCallbacks.length >= 1, "the press must be acked via answerCallbackQuery");
	});

	it("ignores a callback_query with no data payload", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const callbacks: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			onCallbackQuery: (m) => callbacks.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		bot.emitCallback({
			update_id: 22,
			callback_query: { id: "cbq-empty", from: { id: 555 }, message: makeMessage() },
		} as unknown as Update);
		runner.finish();
		await conn.close();
		assert.equal(callbacks.length, 0, "a dataless button is not an approval press");
	});

	it("dedupes a redelivered callback_query by update_id", async () => {
		const bot = makeFakeBot();
		const runner = makeFakeRunner();
		const callbacks: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			onMessage: () => {},
			onCallbackQuery: (m) => callbacks.push(m),
			botFactory: () => bot,
			runnerFactory: () => runner,
			sleepImpl: instantSleep,
		});
		const update = {
			update_id: 30,
			callback_query: { id: "cbq", data: "bv1:ZA:o", from: { id: 5 }, message: makeMessage() },
		} as unknown as Update;
		bot.emitCallback(update);
		bot.emitCallback(update);
		runner.finish();
		await conn.close();
		assert.equal(callbacks.length, 1, "redelivered callback must not double-fire");
	});
});

/* ─────────────────────────── webhook transport ─────────────────────────── */

describe("connectTelegram webhook mode", () => {
	it("registers the webhook with secret_token + allowed_updates; does NOT build a runner", async () => {
		const bot = makeFakeBot();
		let runnerBuilt = 0;
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			mode: "webhook",
			webhook: { url: "https://bot.example.com/tg", secretToken: "s3cr3t" },
			onMessage: () => {},
			botFactory: () => bot,
			runnerFactory: () => {
				runnerBuilt += 1;
				return makeFakeRunner();
			},
			sleepImpl: instantSleep,
		});
		assert.equal(conn.mode(), "webhook");
		assert.equal(runnerBuilt, 0, "webhook mode must not poll");
		assert.equal(bot.calls.setWebhooks.length, 1);
		assert.equal(bot.calls.setWebhooks[0]?.url, "https://bot.example.com/tg");
		assert.equal(bot.calls.setWebhooks[0]?.opts?.secret_token, "s3cr3t");
		assert.deepEqual(bot.calls.setWebhooks[0]?.opts?.allowed_updates, ["message", "callback_query"]);
		assert.equal(conn.isConnected(), true);
		await conn.close();
	});

	it("feedUpdate routes a message update through the inbound path", async () => {
		const bot = makeFakeBot();
		const received: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			mode: "webhook",
			webhook: { url: "https://bot.example.com/tg", secretToken: "s" },
			onMessage: (m) => received.push(m),
			botFactory: () => bot,
			runnerFactory: () => makeFakeRunner(),
			sleepImpl: instantSleep,
		});
		conn.feedUpdate({ update_id: 50, message: makeMessage({ text: "via webhook" }) } as Update);
		assert.equal(received.length, 1);
		assert.equal(received[0]?.text, "via webhook");
		await conn.close();
	});

	it("feedUpdate routes a callback_query update + acks it", async () => {
		const bot = makeFakeBot();
		const callbacks: TgInboundMessage[] = [];
		const conn = await connectTelegram({
			token: "tkn",
			log: noopLog,
			mode: "webhook",
			webhook: { url: "https://bot.example.com/tg", secretToken: "s" },
			onMessage: () => {},
			onCallbackQuery: (m) => callbacks.push(m),
			botFactory: () => bot,
			runnerFactory: () => makeFakeRunner(),
			sleepImpl: instantSleep,
		});
		conn.feedUpdate({
			update_id: 51,
			callback_query: { id: "cbq-w", data: "bv1:ZA:o", from: { id: 9 }, message: makeMessage() },
		} as unknown as Update);
		// allow the async callback handler to settle
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(callbacks.length, 1);
		assert.deepEqual(callbacks[0]?.callbackQuery, { data: "bv1:ZA:o", callbackId: "cbq-w" });
		assert.ok(bot.calls.answeredCallbacks.length >= 1, "webhook callback must be acked");
		await conn.close();
	});
});
