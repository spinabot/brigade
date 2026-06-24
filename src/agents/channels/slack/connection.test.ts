import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	connectSlack,
	isSlackUnauthorized,
	redactSlackToken,
	slackBackoffDelay,
	type SlackInboundMessage,
	type SlackSocketClientLike,
	type SlackWebClientLike,
} from "./connection.js";

/* ─────────────────────── fake socket + web client harness ─────────────────────── */

type Handler = (args: unknown) => unknown;

interface FakeSocket extends SlackSocketClientLike {
	handlers: Map<string, Handler[]>;
	started: number;
	disconnected: number;
	/** Emit an events_api event (message/app_mention/reaction) under its type name. */
	emitEvent(eventType: string, event: Record<string, unknown>, teamId?: string): void;
	/** Emit an `interactive` (block_actions) payload. */
	emitInteractive(payload: Record<string, unknown>): void;
	/** Emit a `slash_commands` payload. */
	emitSlash(payload: Record<string, unknown>): void;
	/** Emit a RAW argument to a named handler (e.g. `error` carries the error directly). */
	emitRaw(eventType: string, arg: unknown): void;
}

function makeFakeSocket(): FakeSocket {
	const handlers = new Map<string, Handler[]>();
	const ackNoop = async () => {};
	const socket: FakeSocket = {
		handlers,
		started: 0,
		disconnected: 0,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler as Handler);
			handlers.set(event, list);
		},
		async start() {
			socket.started += 1;
			return undefined;
		},
		async disconnect() {
			socket.disconnected += 1;
			return undefined;
		},
		emitEvent(eventType, event, teamId) {
			for (const h of handlers.get(eventType) ?? []) {
				h({ ack: ackNoop, body: { team_id: teamId, event }, event });
			}
		},
		emitInteractive(payload) {
			for (const h of handlers.get("interactive") ?? []) h({ ack: ackNoop, body: payload });
		},
		emitSlash(payload) {
			for (const h of handlers.get("slash_commands") ?? []) h({ ack: ackNoop, body: payload });
		},
		emitRaw(eventType, arg) {
			for (const h of handlers.get(eventType) ?? []) h(arg);
		},
	};
	return socket;
}

interface FakeWeb extends SlackWebClientLike {
	posts: Array<Record<string, unknown>>;
	updates: Array<Record<string, unknown>>;
	deletes: Array<Record<string, unknown>>;
	reactionsAdded: Array<Record<string, unknown>>;
	reactionsRemoved: Array<Record<string, unknown>>;
	opened: Array<Record<string, unknown>>;
}

function makeFakeWeb(over: { authOk?: boolean; authError?: string } = {}): FakeWeb {
	const posts: FakeWeb["posts"] = [];
	const updates: FakeWeb["updates"] = [];
	const deletes: FakeWeb["deletes"] = [];
	const reactionsAdded: FakeWeb["reactionsAdded"] = [];
	const reactionsRemoved: FakeWeb["reactionsRemoved"] = [];
	const opened: FakeWeb["opened"] = [];
	let postSeq = 0;
	return {
		posts,
		updates,
		deletes,
		reactionsAdded,
		reactionsRemoved,
		opened,
		auth: {
			async test() {
				if (over.authOk === false) return { ok: false, error: over.authError ?? "invalid_auth" };
				return { ok: true, user_id: "UBOT", user: "brigade", team_id: "T1", team: "Acme" };
			},
		},
		chat: {
			async postMessage(args) {
				posts.push(args);
				return { ok: true, ts: `100.${++postSeq}`, channel: String(args.channel) };
			},
			async update(args) {
				updates.push(args);
				return { ok: true, ts: String(args.ts) };
			},
			async delete(args) {
				deletes.push(args);
				return { ok: true };
			},
		},
		reactions: {
			async add(args) {
				reactionsAdded.push(args);
				return { ok: true };
			},
			async remove(args) {
				reactionsRemoved.push(args);
				return { ok: true };
			},
		},
		conversations: {
			async open(args) {
				opened.push(args);
				return { ok: true, channel: { id: "D123" } };
			},
		},
		files: {
			async uploadV2() {
				return { ok: true };
			},
		},
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("slackBackoffDelay", () => {
	it("grows with the attempt and is bounded by the max (± jitter)", () => {
		// The shared curve applies the maxMs cap to the BASE, then a two-sided
		// ±25% jitter — so a late attempt lands within ±jitter of 30s, not strictly
		// under it (see backoff.ts). Bound the upper edge by maxMs * (1 + jitter).
		const d0 = slackBackoffDelay(0);
		const d5 = slackBackoffDelay(5);
		assert.ok(d0 > 0 && d0 <= 2_000 * 1.25);
		assert.ok(d5 > 0 && d5 <= 30_000 * 1.25);
	});
});

describe("isSlackUnauthorized", () => {
	it("recognises invalid_auth + unrecoverable start error", () => {
		assert.equal(isSlackUnauthorized({ data: { error: "invalid_auth" } }), true);
		assert.equal(isSlackUnauthorized({ name: "UnrecoverableSocketModeStartError" }), true);
		assert.equal(isSlackUnauthorized({ data: { error: "channel_not_found" } }), false);
	});

	it("recognises the broadened non-recoverable codes (expired / invalid / inactive / scope)", () => {
		for (const code of ["token_expired", "invalid_token", "account_inactive", "org_login_required", "missing_scope"]) {
			assert.equal(isSlackUnauthorized({ data: { error: code } }), true, code);
		}
		// A transient / unrelated error is NOT terminal.
		assert.equal(isSlackUnauthorized({ data: { error: "ratelimited" } }), false);
	});
});

describe("redactSlackToken", () => {
	it("redacts both explicit tokens and any xox?-/xapp- fragment", () => {
		const out = redactSlackToken("bot=xoxb-AAA app=xapp-BBB other=xoxb-1234567890abcdef", "xoxb-AAA", "xapp-BBB");
		assert.ok(!out.includes("xoxb-AAA"));
		assert.ok(!out.includes("xapp-BBB"));
		assert.ok(!out.includes("xoxb-1234567890abcdef"), "stray token caught by the pattern too");
	});
});

describe("connectSlack — display-name resolution", () => {
	/** A fake web whose `users.info` resolves U2 → "Alex" (others → their id). */
	function webWithDirectory(): FakeWeb {
		const web = makeFakeWeb();
		web.users = {
			async info({ user }: { user: string }) {
				return { ok: true, user: { profile: { display_name: user === "U2" ? "Alex" : user } } };
			},
		};
		return web;
	}

	it("resolves the sender + bare mention to names once the directory primes", async () => {
		const socket = makeFakeSocket();
		const web = webWithDirectory();
		const messages: SlackInboundMessage[] = [];
		const conn = await connectSlack({
			botToken: "xoxb-AAA",
			appToken: "xapp-BBB",
			webClientFactory: () => web,
			socketModeFactory: () => socket,
			sleepImpl: async () => {},
			log: () => {},
			onMessage: (m) => messages.push(m),
		});
		// First contact from U2: nothing cached yet → the name falls back to the id,
		// but this message PRIMES U2 in the background.
		socket.emitEvent("message", { type: "message", user: "U2", channel: "C1", channel_type: "channel", text: "hello <@U2>", ts: "1.1" }, "T1");
		await flush();
		assert.equal(messages[0]?.fromName, "U2");
		assert.equal(messages[0]?.text, "hello @U2");
		// Second message from U2: the prime has settled → the name resolves.
		socket.emitEvent("message", { type: "message", user: "U2", channel: "C1", channel_type: "channel", text: "again <@U2>", ts: "1.2" }, "T1");
		await flush();
		assert.equal(messages[1]?.fromName, "Alex");
		assert.equal(messages[1]?.text, "again @Alex");
		await conn.close();
	});

	it("resolves the reactor's name for the synthesized reaction note", async () => {
		const socket = makeFakeSocket();
		const web = webWithDirectory();
		const reactions: SlackInboundMessage[] = [];
		const conn = await connectSlack({
			botToken: "xoxb-AAA",
			appToken: "xapp-BBB",
			webClientFactory: () => web,
			socketModeFactory: () => socket,
			sleepImpl: async () => {},
			log: () => {},
			onMessage: () => {},
			onReaction: (m) => reactions.push(m),
		});
		// First reaction primes U2 (no name yet); the second resolves to "Alex".
		socket.emitEvent("reaction_added", { type: "reaction_added", user: "U2", reaction: "thumbsup", item: { type: "message", channel: "C1", ts: "5.0" } }, "T1");
		await flush();
		socket.emitEvent("reaction_added", { type: "reaction_added", user: "U2", reaction: "tada", item: { type: "message", channel: "C1", ts: "6.0" } }, "T1");
		await flush();
		assert.equal(reactions[1]?.fromName, "Alex");
		await conn.close();
	});
});

describe("connectSlack — inbound routing", () => {
	async function connect(over: { authOk?: boolean; authError?: string } = {}) {
		const socket = makeFakeSocket();
		const web = makeFakeWeb(over);
		const messages: SlackInboundMessage[] = [];
		const callbacks: SlackInboundMessage[] = [];
		const reactions: SlackInboundMessage[] = [];
		let tokenInvalid = false;
		const conn = await connectSlack({
			botToken: "xoxb-AAA",
			appToken: "xapp-BBB",
			webClientFactory: () => web,
			socketModeFactory: () => socket,
			sleepImpl: async () => {},
			log: () => {},
			onMessage: (m) => messages.push(m),
			onCallbackQuery: (m) => callbacks.push(m),
			onReaction: (m) => reactions.push(m),
			onTokenInvalid: () => {
				tokenInvalid = true;
			},
		});
		return { socket, web, conn, messages, callbacks, reactions, tokenInvalid: () => tokenInvalid };
	}

	it("boots via auth.test, caches the self id + team, and starts the socket", async () => {
		const { socket, conn } = await connect();
		assert.equal(conn.isConnected(), true);
		assert.equal(conn.selfId(), "UBOT");
		assert.equal(conn.teamId(), "T1");
		assert.equal(socket.started, 1);
	});

	it("routes a plain message to onMessage with normalized fields", async () => {
		const { socket, messages } = await connect();
		socket.emitEvent("message", { type: "message", user: "U2", channel: "C1", channel_type: "channel", text: "hi <@UBOT>", ts: "5.5" }, "T1");
		await flush();
		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.conversationId, "C1");
		assert.equal(messages[0]?.from, "U2");
		assert.equal(messages[0]?.text, "hi @UBOT");
		assert.equal(messages[0]?.messageId, "5.5");
		assert.equal(messages[0]?.teamId, "T1");
		assert.deepEqual(messages[0]?.mentions, ["UBOT"]);
	});

	it("emulates typing — reacts ⏳ to the user's last message on composing, removes it on paused", async () => {
		const { socket, web, conn } = await connect();
		socket.emitEvent("message", { type: "message", user: "U2", channel: "C1", text: "do a thing", ts: "9.0" });
		await flush();
		await conn.setComposing("C1", "composing");
		assert.equal(web.reactionsAdded.length, 1);
		assert.equal(web.reactionsAdded[0]?.name, "hourglass_flowing_sand");
		assert.equal(web.reactionsAdded[0]?.channel, "C1");
		assert.equal(web.reactionsAdded[0]?.timestamp, "9.0");
		await conn.setComposing("C1", "paused");
		assert.equal(web.reactionsRemoved.length, 1);
		assert.equal(web.reactionsRemoved[0]?.timestamp, "9.0");
	});

	it("typing is a no-op when the channel has no prior inbound message", async () => {
		const { web, conn } = await connect();
		await conn.setComposing("CNONE", "composing");
		assert.equal(web.reactionsAdded.length, 0);
	});

	it("filters the bot's own messages (no self-reply loop)", async () => {
		const { socket, messages } = await connect();
		socket.emitEvent("message", { type: "message", user: "UBOT", channel: "C1", text: "my own echo", ts: "6.0" });
		await flush();
		assert.equal(messages.length, 0);
	});

	it("dedupes a redelivered message by ts", async () => {
		const { socket, messages } = await connect();
		const e = { type: "message", user: "U2", channel: "C1", text: "once", ts: "7.0" };
		socket.emitEvent("message", e);
		socket.emitEvent("message", e);
		await flush();
		assert.equal(messages.length, 1);
	});

	it("flags an edit (message_changed) and surfaces the new text", async () => {
		const { socket, messages } = await connect();
		socket.emitEvent("message", {
			type: "message",
			subtype: "message_changed",
			channel: "C1",
			message: { type: "message", user: "U2", text: "edited!", ts: "8.0" },
		});
		await flush();
		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.edited, true);
		assert.equal(messages[0]?.text, "edited!");
	});

	it("routes an app_mention as an addressed message", async () => {
		const { socket, messages } = await connect();
		socket.emitEvent("app_mention", { type: "app_mention", user: "U2", channel: "C1", text: "<@UBOT> yo", ts: "9.0" });
		await flush();
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0]?.mentions, ["UBOT"]);
	});

	it("collapses a message + app_mention with the SAME ts into ONE onMessage (no double-dispatch)", async () => {
		const { socket, messages } = await connect();
		// A channel @-mention arrives as BOTH events: `message` (carries
		// client_msg_id) and `app_mention` (only ts). Keying on channel+ts must
		// collapse them so the agent runs/replies/bills only once.
		socket.emitEvent("message", { type: "message", user: "U2", channel: "C1", text: "<@UBOT> hi", ts: "12.0", client_msg_id: "cmid-1" });
		socket.emitEvent("app_mention", { type: "app_mention", user: "U2", channel: "C1", text: "<@UBOT> hi", ts: "12.0" });
		await flush();
		assert.equal(messages.length, 1);
	});

	it("routes BOTH edits of the same message when edited.ts differs (no edit-drop)", async () => {
		const { socket, messages } = await connect();
		const editOf = (editTs: string, text: string) => ({
			type: "message",
			subtype: "message_changed",
			channel: "C1",
			message: { type: "message", user: "U2", text, ts: "13.0", edited: { ts: editTs, user: "U2" } },
		});
		socket.emitEvent("message", editOf("13.1", "first edit"));
		socket.emitEvent("message", editOf("13.2", "second edit"));
		await flush();
		assert.equal(messages.length, 2);
		assert.equal(messages[0]?.text, "first edit");
		assert.equal(messages[1]?.text, "second edit");
	});

	it("routes a block_actions press to onCallbackQuery carrying the value", async () => {
		const { socket, callbacks } = await connect();
		socket.emitInteractive({
			type: "block_actions",
			user: { id: "U2" },
			channel: { id: "C1" },
			message: { ts: "10.0" },
			actions: [{ action_id: "brigade_approval", value: "bv1:abc:o" }],
		});
		await flush();
		assert.equal(callbacks.length, 1);
		assert.equal(callbacks[0]?.callbackQuery?.data, "bv1:abc:o");
		assert.equal(callbacks[0]?.conversationId, "C1");
	});

	it("routes a reaction_added to onReaction", async () => {
		const { socket, reactions } = await connect();
		socket.emitEvent("reaction_added", { type: "reaction_added", user: "U2", reaction: "thumbsup", item: { type: "message", channel: "C1", ts: "11.0" } });
		await flush();
		assert.equal(reactions.length, 1);
		assert.deepEqual(reactions[0]?.reaction, { emojis: ["thumbsup"], targetMessageId: "11.0" });
	});

	it("re-routes a re-added reaction after a removal (add→remove→add fires onReaction twice)", async () => {
		const { socket, reactions } = await connect();
		const added = { type: "reaction_added", user: "U2", reaction: "eyes", item: { type: "message", channel: "C1", ts: "14.0" } };
		const removed = { type: "reaction_removed", user: "U2", reaction: "eyes", item: { type: "message", channel: "C1", ts: "14.0" } };
		// Flush between events so each is fully processed in arrival order (the
		// reaction_added handler defers its dedupe-claim behind an async ack).
		socket.emitEvent("reaction_added", added);
		await flush();
		socket.emitEvent("reaction_removed", removed);
		await flush();
		socket.emitEvent("reaction_added", added);
		await flush();
		// Without the release on removal the re-add is dropped as a redelivery (1).
		assert.equal(reactions.length, 2);
	});

	it("routes a slash command as a message ('/status foo')", async () => {
		const { socket, messages } = await connect();
		socket.emitSlash({ command: "/status", text: "foo", user_id: "U2", channel_id: "C1", team_id: "T1" });
		await flush();
		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.text, "/status foo");
	});

	it("goes terminal on an invalid_auth at boot", async () => {
		const { conn, tokenInvalid } = await connect({ authOk: false, authError: "invalid_auth" });
		assert.equal(conn.isTokenInvalid(), true);
		assert.equal(conn.isConnected(), false);
		assert.equal(tokenInvalid(), true);
	});

	it("detects a token revoked MID-SESSION via a socket `error` event", async () => {
		const { socket, conn, tokenInvalid } = await connect();
		assert.equal(conn.isConnected(), true);
		// @slack/socket-mode emits `error` (not a useful `disconnected` arg) when the
		// token is revoked after connect.
		socket.emitRaw("error", { data: { error: "invalid_auth" } });
		await flush();
		assert.equal(conn.isTokenInvalid(), true);
		assert.equal(conn.isConnected(), false);
		assert.equal(tokenInvalid(), true);
	});

	it("detects a bad token via `unable_to_socket_mode_start`", async () => {
		const { socket, conn, tokenInvalid } = await connect();
		socket.emitRaw("unable_to_socket_mode_start", { data: { error: "token_expired" } });
		await flush();
		assert.equal(conn.isTokenInvalid(), true);
		assert.equal(tokenInvalid(), true);
	});

	it("ignores a non-auth socket `error` (stays connected)", async () => {
		const { socket, conn, tokenInvalid } = await connect();
		socket.emitRaw("error", { data: { error: "ratelimited" } });
		await flush();
		assert.equal(conn.isTokenInvalid(), false);
		assert.equal(conn.isConnected(), true);
		assert.equal(tokenInvalid(), false);
	});
});

describe("connectSlack — outbound", () => {
	async function connected() {
		const socket = makeFakeSocket();
		const web = makeFakeWeb();
		const conn = await connectSlack({
			botToken: "xoxb-AAA",
			appToken: "xapp-BBB",
			webClientFactory: () => web,
			socketModeFactory: () => socket,
			sleepImpl: async () => {},
			log: () => {},
			onMessage: () => {},
		});
		return { web, conn };
	}

	it("posts text with mrkdwn + thread_ts and returns the ts", async () => {
		const { web, conn } = await connected();
		const out = await conn.sendText("C1", "hello", { threadId: "1.0" });
		assert.equal(web.posts.length, 1);
		assert.equal(web.posts[0]?.text, "hello");
		assert.equal(web.posts[0]?.mrkdwn, true);
		assert.equal(web.posts[0]?.thread_ts, "1.0");
		assert.ok(out.messageId.startsWith("100."));
	});

	it("maps replyToMessageId to thread_ts", async () => {
		const { web, conn } = await connected();
		await conn.sendText("C1", "reply", { replyToMessageId: "55.5" });
		assert.equal(web.posts[0]?.thread_ts, "55.5");
	});

	it("sends interactive blocks", async () => {
		const { web, conn } = await connected();
		await conn.sendInteractive("C1", "fallback", [{ type: "actions", elements: [] }]);
		assert.ok(Array.isArray(web.posts[0]?.blocks));
		assert.equal(web.posts[0]?.text, "fallback");
	});

	it("edits + deletes a message", async () => {
		const { web, conn } = await connected();
		await conn.editMessageText("C1", "2.0", "new");
		await conn.deleteMessage("C1", "2.0");
		assert.equal(web.updates[0]?.ts, "2.0");
		assert.equal(web.updates[0]?.text, "new");
		assert.equal(web.deletes[0]?.ts, "2.0");
	});

	it("reacts with the colon-stripped emoji name", async () => {
		const { web, conn } = await connected();
		await conn.react("C1", "3.0", ":tada:");
		assert.equal(web.reactionsAdded[0]?.name, "tada");
		assert.equal(web.reactionsAdded[0]?.timestamp, "3.0");
	});

	it("opens a DM and returns the channel id", async () => {
		const { web, conn } = await connected();
		const id = await conn.openDirectMessage("U9");
		assert.equal(id, "D123");
		assert.equal(web.opened[0]?.users, "U9");
	});
});
