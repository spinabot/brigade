import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrigadeConfig } from "../../config/io.js";
import type { ChannelAdapter, ChannelStartContext, InboundMessage } from "../extensions/types.js";
import { addAllowFrom, readPendingPairings } from "./access-control/index.js";
import { startChannels } from "./manager.js";
import { channelSessionKey } from "./session-key.js";

// Most non-ACL tests in this file don't care about the gate — they pre-date
// access control and just verify the inbound→turn→reply flow. We default the
// fake channel to `open` policy here so those tests keep working; ACL-specific
// tests below pass their own config (`pairing` / `disabled` / `allowlist`).
const CONFIG = { channels: { fake: { dmPolicy: "open" } } } as unknown as BrigadeConfig;

/** A controllable fake channel that captures its start ctx + sent messages. */
function makeFakeChannel(overrides: Partial<ChannelAdapter> = {}): {
	adapter: ChannelAdapter;
	ctx: () => ChannelStartContext;
	sent: { conversationId: string; text: string }[];
	stopped: () => boolean;
} {
	let ctx: ChannelStartContext | undefined;
	const sent: { conversationId: string; text: string }[] = [];
	let stopped = false;
	const adapter: ChannelAdapter = {
		id: "fake",
		label: "Fake",
		isConfigured: () => true,
		async start(c) {
			ctx = c;
		},
		async stop() {
			stopped = true;
		},
		async sendText(conversationId, text) {
			sent.push({ conversationId, text });
		},
		...overrides,
	};
	return { adapter, ctx: () => ctx!, sent, stopped: () => stopped };
}

describe("channelSessionKey", () => {
	it("scopes per agent + channel + conversation with a readable prefix", () => {
		const key = channelSessionKey("main", "whatsapp", "123@s.whatsapp.net");
		assert.match(key, /^agent:main:whatsapp:123@s\.whatsapp\.net\.[0-9a-f]{8}$/);
	});
	it("sanitizes whitespace + reserved separators in the readable prefix", () => {
		const key = channelSessionKey("main", "slack", "C 01:thread");
		assert.match(key, /^agent:main:slack:C_01_thread\.[0-9a-f]{8}$/);
	});
	it("never collides distinct ids that sanitize to the same prefix", () => {
		// "a:b" and "a b" both sanitize to "a_b" — the raw-id hash keeps them apart.
		assert.notEqual(channelSessionKey("main", "x", "a:b"), channelSessionKey("main", "x", "a b"));
	});
	it("is stable for the same id", () => {
		assert.equal(channelSessionKey("main", "x", "c1"), channelSessionKey("main", "x", "c1"));
	});
});

describe("startChannels", () => {
	it("starts a configured channel and reports it", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({ adapters: [f.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "" }) });
		assert.deepEqual(mgr.started, ["fake"]);
	});

	it("routes inbound → runTurn(sessionKey) → sendText(reply)", async () => {
		const f = makeFakeChannel();
		const calls: { text: string; sessionKey: string }[] = [];
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async (a) => {
				calls.push(a);
				return { reply: "pong" };
			},
		});
		const msg: InboundMessage = { channel: "fake", conversationId: "c1", from: "u1", text: "ping" };
		await f.ctx().onInbound(msg);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.text, "ping");
		assert.match(calls[0]?.sessionKey ?? "", /^agent:main:fake:c1\.[0-9a-f]{8}$/);
		assert.deepEqual(f.sent, [{ conversationId: "c1", text: "pong" }]);
		await mgr.stop();
	});

	it("does not send when the reply is empty", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({ adapters: [f.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "   " }) });
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "hi" });
		assert.equal(f.sent.length, 0);
		await mgr.stop();
	});

	it("ignores empty inbound text without running a turn", async () => {
		const f = makeFakeChannel();
		let ran = false;
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				ran = true;
				return { reply: "x" };
			},
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "   " });
		assert.equal(ran, false);
		assert.equal(f.sent.length, 0);
		await mgr.stop();
	});

	it("a turn that throws is swallowed AND surfaces a friendly error reply", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				throw new Error("model down");
			},
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "hi" }); // must not reject
		assert.equal(f.sent.length, 1, "should reply with an error message instead of going silent");
		assert.match(f.sent[0]?.text ?? "", /error|try again/i);
		await mgr.stop();
	});

	it("skips a channel that is not configured", async () => {
		const f = makeFakeChannel({ isConfigured: () => false });
		const mgr = await startChannels({ adapters: [f.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "" }) });
		assert.deepEqual(mgr.started, []);
	});

	it("skips a channel whose requiresEnv is missing", async () => {
		const f = makeFakeChannel({ requiresEnv: ["MISSING_XYZ_123"] });
		const mgr = await startChannels({ adapters: [f.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "" }), env: {} });
		assert.deepEqual(mgr.started, []);
	});

	it("a channel that fails to start does not block the others", async () => {
		const boom = makeFakeChannel({
			id: "boom",
			async start() {
				throw new Error("connect failed");
			},
		});
		const ok = makeFakeChannel({ id: "ok" });
		const mgr = await startChannels({ adapters: [boom.adapter, ok.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "" }) });
		assert.deepEqual(mgr.started, ["ok"]);
		await mgr.stop();
	});

	it("intercepts a /command before the LLM and replies with the handler output", async () => {
		const f = makeFakeChannel();
		let turnRan = false;
		const seenArgs: string[] = [];
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "should not happen" };
			},
			commands: [
				{
					name: "echo",
					handler: (ctx) => {
						seenArgs.push(ctx.args);
						return `you said: ${ctx.args}`;
					},
				},
			],
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "/echo hi there" });
		assert.equal(turnRan, false); // command short-circuits the turn
		assert.deepEqual(seenArgs, ["hi there"]);
		assert.deepEqual(f.sent, [{ conversationId: "c1", text: "you said: hi there" }]);
		await mgr.stop();
	});

	it("refuses an unauthorized /command", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => ({ reply: "x" }),
			commands: [{ name: "secret", authorize: () => false, handler: () => "leaked" }],
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "/secret" });
		assert.equal(f.sent[0]?.text, "Not authorized to run that command.");
		await mgr.stop();
	});

	it("an unknown /command falls through to a normal turn", async () => {
		const f = makeFakeChannel();
		let turnRan = false;
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				turnRan = true;
				return { reply: "answered" };
			},
			commands: [{ name: "known", handler: () => "k" }],
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "/unknown please" });
		assert.equal(turnRan, true);
		assert.deepEqual(f.sent, [{ conversationId: "c1", text: "answered" }]);
		await mgr.stop();
	});

	it("default policy (`pairing`) challenges a stranger with a code instead of running a turn", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-acl-mgr-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel();
			let turnRan = false;
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: {} as BrigadeConfig, // no policy override → default = `pairing`
				agentId: "main",
				runTurn: async () => {
					turnRan = true;
					return { reply: "should not happen" };
				},
			});
			await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "+1 555-000-0001", text: "hi" });
			assert.equal(turnRan, false, "stranger must not reach the agent");
			assert.equal(f.sent.length, 1, "a challenge reply was sent");
			assert.match(f.sent[0]?.text ?? "", /one-time code|approve your access|brigade pairing approve/i);
			assert.match(f.sent[0]?.text ?? "", /[A-Z2-9]{8}/);
			const pending = readPendingPairings("fake");
			assert.equal(pending.length, 1);
			// senderId is normalized (whitespace stripped) by the store.
			assert.equal(pending[0]?.senderId, "+1555-000-0001");
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("an allow-listed sender reaches the agent (turn runs, reply sent)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-acl-mgr-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			addAllowFrom("fake", "alice");
			const f = makeFakeChannel();
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: {} as BrigadeConfig, // default pairing policy
				agentId: "main",
				runTurn: async () => ({ reply: "pong" }),
			});
			await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "alice", text: "ping" });
			assert.deepEqual(f.sent, [{ conversationId: "c1", text: "pong" }]);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("`disabled` policy silently drops every inbound (no challenge, no reply, no turn)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-acl-mgr-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel();
			let turnRan = false;
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "disabled" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => {
					turnRan = true;
					return { reply: "x" };
				},
			});
			await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "alice", text: "hi" });
			assert.equal(turnRan, false);
			assert.equal(f.sent.length, 0);
			assert.equal(readPendingPairings("fake").length, 0);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("`open` policy lets any sender through (legacy/test mode)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-acl-mgr-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel();
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "open" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => ({ reply: "ok" }),
			});
			await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "stranger", text: "hi" });
			assert.deepEqual(f.sent, [{ conversationId: "c1", text: "ok" }]);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("self (adapter.selfId === sender) is always allowed, even with no allow-from entries", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-acl-mgr-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel({ selfId: () => "owner" });
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: {} as BrigadeConfig, // default pairing policy
				agentId: "main",
				runTurn: async () => ({ reply: "hi self" }),
			});
			await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "owner", text: "note to self" });
			assert.deepEqual(f.sent, [{ conversationId: "c1", text: "hi self" }]);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("media-only inbound synthesizes a path note into the turn text", async () => {
		const f = makeFakeChannel();
		const calls: { text: string }[] = [];
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async (a) => {
				calls.push({ text: a.text });
				return { reply: "got it" };
			},
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c1",
			from: "u",
			text: "",
			media: [{ kind: "image", path: "/tmp/abc.jpg", mimeType: "image/jpeg", caption: "look at this" }],
		});
		assert.equal(calls.length, 1, "media-only inbound should still produce a turn");
		assert.match(calls[0]?.text ?? "", /\[attached image.*look at this.*\/tmp\/abc\.jpg\]/);
		await mgr.stop();
	});

	it("`/stop` with no in-flight turn replies with a friendly 'nothing running' line", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => ({ reply: "x" }),
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "/stop" });
		assert.match(f.sent[0]?.text ?? "", /nothing was running|try again/i);
		await mgr.stop();
	});

	it("a `/stop` mid-turn aborts the AbortSignal and replies 'Stopped.'", async () => {
		const f = makeFakeChannel();
		let observedSignal: AbortSignal | undefined;
		let releaseTurn: () => void = () => {};
		const turnDone = new Promise<void>((r) => {
			releaseTurn = r;
		});
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async (a) => {
				observedSignal = a.signal;
				await turnDone; // simulate a slow turn
				return { reply: "should-be-suppressed" };
			},
		});
		// Kick off the slow turn (don't await — it pends on `turnDone`).
		const inboundP = f
			.ctx()
			.onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "do something long" });
		// Give the manager a tick to register the controller.
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(observedSignal, "runTurn must have been called with a signal");
		assert.equal(observedSignal?.aborted, false);
		// Now send /stop; should abort + reply "Stopped." synchronously.
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "stop" });
		assert.equal(observedSignal?.aborted, true, "the in-flight turn's signal must have been aborted");
		assert.ok(f.sent.some((s) => /Stopped\./.test(s.text)));
		// Now finish the originally-slow turn; its (stale) reply must be dropped.
		releaseTurn();
		await inboundP;
		assert.equal(f.sent.filter((s) => s.text === "should-be-suppressed").length, 0);
		await mgr.stop();
	});

	it("stop() tears down every started channel and is idempotent", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({ adapters: [f.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "" }) });
		await mgr.stop();
		await mgr.stop(); // idempotent — no throw, no double-stop side effects
		assert.equal(f.stopped(), true);
	});

	it("fires the abort signal on stop so listeners can unwind", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({ adapters: [f.adapter], config: CONFIG, agentId: "main", runTurn: async () => ({ reply: "" }) });
		assert.equal(f.ctx().signal.aborted, false);
		await mgr.stop();
		assert.equal(f.ctx().signal.aborted, true);
	});
});
