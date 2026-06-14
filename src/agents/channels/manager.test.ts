import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// File-wide state-dir isolation. The ACL-specific tests below pin
// BRIGADE_STATE_DIR per-test, but the older startChannels tests don't — and
// the fake channel's pairing flow + subsystem logger resolve their paths via
// resolveStateDir(), so those tests wrote channels/fake/pairing.json and
// logs/brigade-*.log into the DEVELOPER'S real ~/.brigade. Caught 2026-06-12
// when a full suite run leaked into a freshly-reset operator state dir.
let __stateDirTmp: string;
let __prevStateDir: string | undefined;
beforeEach(() => {
	__stateDirTmp = mkdtempSync(join(tmpdir(), "brigade-mgr-statedir-"));
	__prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = __stateDirTmp;
});
afterEach(() => {
	if (__prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = __prevStateDir;
	rmSync(__stateDirTmp, { recursive: true, force: true });
});

import type { BrigadeConfig } from "../../config/io.js";
import type { ChannelAdapter, ChannelStartContext, InboundMessage, OutboundSendOptions } from "../extensions/types.js";
import { addAllowFrom, readPendingPairings } from "./access-control/index.js";
import { startChannels } from "./manager.js";

// Most non-ACL tests in this file don't care about the gate — they pre-date
// access control and just verify the inbound→turn→reply flow. We default the
// fake channel to `open` policy here so those tests keep working; ACL-specific
// tests below pass their own config (`pairing` / `disabled` / `allowlist`).
const CONFIG = { channels: { fake: { dmPolicy: "open" } } } as unknown as BrigadeConfig;

/**
 * A controllable fake channel that captures its start ctx + sent messages.
 *
 * `sent` records the bare `{conversationId,text}` shape that pre-existing
 * tests `deepEqual` against. `sentWithOpts` is a parallel log carrying the
 * outbound `opts` (threadId, etc.) — tests that care about thread routing
 * read from this second log to avoid changing the deep-equality shape every
 * legacy test relies on.
 */
function makeFakeChannel(overrides: Partial<ChannelAdapter> = {}): {
	adapter: ChannelAdapter;
	ctx: () => ChannelStartContext;
	sent: { conversationId: string; text: string }[];
	sentWithOpts: { conversationId: string; text: string; opts?: OutboundSendOptions }[];
	stopped: () => boolean;
} {
	let ctx: ChannelStartContext | undefined;
	const sent: { conversationId: string; text: string }[] = [];
	const sentWithOpts: { conversationId: string; text: string; opts?: OutboundSendOptions }[] = [];
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
		async sendText(conversationId, text, opts) {
			sent.push({ conversationId, text });
			sentWithOpts.push({ conversationId, text, opts });
		},
		...overrides,
	};
	return { adapter, ctx: () => ctx!, sent, sentWithOpts, stopped: () => stopped };
}

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
		// Wave E switched the manager from the legacy per-conversation
		// `channelSessionKey()` shape to the canonical resolver output.
		// `dmScope` defaults to "main" in resolve-route.ts, so a single-agent
		// install with no `session.dmScope` config lands every DM on
		// `agent:main:main` — a deliberate collapse that matches the route
		// resolver's contract.
		assert.equal(calls[0]?.sessionKey ?? "", "agent:main:main");
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
		// Current generic-fallback copy: "⚠️ Hit a snag replying to that. Give it another try …"
		assert.match(f.sent[0]?.text ?? "", /snag|another try|let the owner/i);
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

	/* ───────────────────── error-class-aware reply behavior ───────────────────── */

	it("recipient-facing reply on `billing` error names credits, not the model", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				// Throw a BrigadeRetryError so the classifier picks `billing` directly.
				const { BrigadeRetryError } = await import("../error-classifier.js");
				throw new BrigadeRetryError({
					message: "402 This request requires more credits, or fewer max_tokens",
					reason: "billing",
					status: 402,
				});
			},
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "hi" });
		assert.equal(f.sent.length, 1);
		const reply = f.sent[0]?.text ?? "";
		// Lion-mascot copy phrases billing as "tapped out — model provider account just ran dry"
		// + "owner needs to top it up". Neither mentions the literal word "credits" — match the
		// current shape via "tapped out" / "top it up" / "provider account" instead.
		assert.match(
			reply,
			/tapped out|top it up|provider account/i,
			"billing reply must use the out-of-funds wording",
		);
		assert.doesNotMatch(reply, /402|max_tokens|openrouter|claude|gpt/i, "must not leak status code or model id");
		await mgr.stop();
	});

	it("recipient-facing reply on `rate_limit` error tells the sender to retry in a moment", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				const { BrigadeRetryError } = await import("../error-classifier.js");
				throw new BrigadeRetryError({ message: "429 rate limited", reason: "rate_limit", status: 429 });
			},
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "hi" });
		assert.equal(f.sent.length, 1);
		const reply = f.sent[0]?.text ?? "";
		// Current copy: "⏳ Catching my breath — give me 30 seconds and send that again."
		assert.match(reply, /catching my breath|seconds|breath/i);
		assert.doesNotMatch(reply, /429/);
		await mgr.stop();
	});

	it("falls back to a polite generic reply on truly unclassifiable error", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				throw new Error("something opaque exploded");
			},
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "hi" });
		assert.equal(f.sent.length, 1);
		const reply = f.sent[0]?.text ?? "";
		// Current copy: "⚠️ Hit a snag replying to that. Give it another try …"
		assert.match(
			reply,
			/snag|another try|let the owner/i,
			"generic reply must read as a friendly recovery prompt",
		);
		assert.ok(reply.length < 300, "generic reply should stay short");
		await mgr.stop();
	});

	it("recipient-facing reply on RetryExhaustedError still surfaces the underlying class (billing)", async () => {
		// This is the user-reported regression: a 402 OpenRouter billing error
		// wrapped by the retry loop's exhaustion-shell used to fall through to
		// the generic apology because the classifier couldn't see past the
		// wrapper. The fix chains `cause` AND consults `.lastReason` directly.
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				const { RetryExhaustedError } = await import("../retry-policy.js");
				const { getRetryPolicy } = await import("../retry-policy.js");
				throw new RetryExhaustedError(
					[
						{
							attemptIndex: 0,
							reason: "billing",
							policy: getRetryPolicy("billing"),
							willRetry: false,
							backoffMs: 0,
							errorSummary: "402 insufficient credits",
							error: new Error("402 insufficient credits"),
						},
					],
					new Error("402 insufficient credits"),
				);
			},
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "hi" });
		assert.equal(f.sent.length, 1);
		const reply = f.sent[0]?.text ?? "";
		// Wrapped billing must still resolve to the billing-class copy — check the same
		// "tapped out / top it up / provider account" phrases as the direct billing case.
		assert.match(
			reply,
			/tapped out|top it up|provider account/i,
			"wrapped billing reason must surface as the billing-class reply",
		);
		assert.doesNotMatch(reply, /402|retry|exhausted/i, "must not leak the wrapper internals");
		await mgr.stop();
	});

	/* ───────────────────── reply sanitization (channel-side <think> strip) ───────────────────── */

	it("strips <think>…</think> from the agent's reply before sending to the channel", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => ({ reply: "<think>plan: greet them warmly</think>\nHey, what's up?" }),
		});
		await f.ctx().onInbound({ channel: "fake", conversationId: "c1", from: "u", text: "ping" });
		assert.equal(f.sent.length, 1);
		const reply = f.sent[0]?.text ?? "";
		assert.equal(reply, "Hey, what's up?");
		assert.doesNotMatch(reply, /<think>|<\/think>/);
		await mgr.stop();
	});

	/* ───────────────────── markRead / setComposing ordering ───────────────────── */

	it("calls adapter.markRead AFTER the access gate allows the inbound (not before)", async () => {
		const order: string[] = [];
		const f = makeFakeChannel({
			markRead: async () => {
				order.push("markRead");
			},
			setComposing: async (_c, state) => {
				order.push(`composing:${state}`);
			},
		});
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => {
				order.push("runTurn");
				return { reply: "ok" };
			},
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c1",
			messageId: "m1",
			from: "u",
			text: "ping",
		});
		// Expected order: markRead → composing:composing → runTurn → composing:paused
		assert.deepEqual(order, ["markRead", "composing:composing", "runTurn", "composing:paused"]);
		await mgr.stop();
	});

	it("does NOT call markRead / setComposing on a BLOCKED inbound (block-policy + unknown sender)", async () => {
		const blockedConfig = { channels: { fake: { dmPolicy: "disabled" } } } as unknown as BrigadeConfig;
		const calls: string[] = [];
		const f = makeFakeChannel({
			markRead: async () => {
				calls.push("markRead");
			},
			setComposing: async () => {
				calls.push("setComposing");
			},
		});
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: blockedConfig,
			agentId: "main",
			runTurn: async () => ({ reply: "should-not-run" }),
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c1",
			messageId: "m1",
			from: "stranger",
			text: "hi",
		});
		assert.deepEqual(calls, [], "blocked sender must not get a read receipt or typing indicator");
		await mgr.stop();
	});

	/* ───────────── pairing-reply history-grace window ───────────── */

	it("suppresses the pairing-CHALLENGE REPLY on a historical inbound (queued during downtime)", async () => {
		// Default `pairing` DM policy + a stranger + a message timestamped
		// well before the channel reported "connected". The pairing request
		// should be RECORDED (operator can approve later) but the stranger
		// should NOT get a code reply (avoids burst-spam on every restart).
		const f = makeFakeChannel({
			connectedAt: () => Date.now(),
		});
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
			agentId: "main",
			runTurn: async () => ({ reply: "should-not-run" }),
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c1",
			messageId: "m-old",
			from: "+15551234567",
			text: "hi from days ago",
			// Stamped 10 minutes BEFORE now → outside the 30s grace window.
			messageTimestampMs: Date.now() - 10 * 60 * 1_000,
		});
		assert.equal(f.sent.length, 0, "history inbound must NOT trigger a pairing-reply send");
		await mgr.stop();
	});

	it("sends the pairing CHALLENGE REPLY for a fresh inbound (live, post-connect)", async () => {
		// Isolate the pairing store so this test starts with an empty
		// pending list — otherwise prior tests' entries could leak in and
		// make this stranger's first message look like a re-challenge.
		const tmp = mkdtempSync(join(tmpdir(), "brigade-pair-fresh-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel({
				connectedAt: () => Date.now() - 5_000, // connected 5s ago
			});
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => ({ reply: "should-not-run" }),
			});
			await f.ctx().onInbound({
				channel: "fake",
				conversationId: "c1",
				messageId: "m-live",
				from: "+15557776666",
				text: "hi just now",
				messageTimestampMs: Date.now(), // live
			});
			assert.equal(f.sent.length, 1, "fresh stranger must receive a pairing code reply");
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("`allowlist` mode IGNORES the persisted pairing store — only config.allowFrom counts", async () => {
		// Reference behaviour: `allowlist` is the strict mode where the
		// operator hand-curates the list. A pairing-store entry (which is
		// written by `brigade pairing approve` OR `brigade channels allow
		// add`) must NOT auto-bypass it. Operators choose `allowlist` when
		// they want zero leakage; the persisted store is `pairing`-mode-only.
		const tmp = mkdtempSync(join(tmpdir(), "brigade-allowlist-store-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			// Seed the persisted store with an entry. In allowlist mode this
			// MUST NOT count.
			addAllowFrom("fake", "+15551112222");
			const f = makeFakeChannel();
			let turnRan = false;
			const mgr = await startChannels({
				adapters: [f.adapter],
				// Allowlist mode + EMPTY config.allowFrom → strictly nobody can DM.
				config: { channels: { fake: { dmPolicy: "allowlist", allowFrom: [] } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => {
					turnRan = true;
					return { reply: "x" };
				},
			});
			await f.ctx().onInbound({
				channel: "fake",
				conversationId: "c1",
				from: "+15551112222", // present in store, NOT in config.allowFrom
				text: "hi",
			});
			assert.equal(turnRan, false, "store entry must not auto-allow in allowlist mode");
			assert.equal(f.sent.length, 0);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("`pairing` mode DOES consult the persisted store (operator's `pairing approve` takes effect)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-pairing-store-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			addAllowFrom("fake", "+15551112222"); // simulate prior `pairing approve`
			const f = makeFakeChannel();
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => ({ reply: "hello back" }),
			});
			await f.ctx().onInbound({
				channel: "fake",
				conversationId: "c1",
				from: "+15551112222",
				text: "hi",
			});
			assert.deepEqual(f.sent, [{ conversationId: "c1", text: "hello back" }]);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("sends the pairing CHALLENGE only ONCE per stranger — subsequent messages do NOT re-send", async () => {
		// This is the bug from the user's WhatsApp screenshot: every reply
		// from an unapproved stranger triggered a new identical "your one-
		// time code" card, turning their normal chat into a wall of duplicate
		// challenge cards. Fix mirrors the upstream reference's `issuePairingChallenge` —
		// only emit the reply when the upsert reports a newly-created entry.
		// Isolate the pairing store to a tempdir so we don't see entries
		// left over from earlier tests in this file.
		const tmp = mkdtempSync(join(tmpdir(), "brigade-pair-once-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel({
				connectedAt: () => Date.now() - 1_000,
			});
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => ({ reply: "ignored — pairing should gate" }),
			});
			// 5 messages from the same stranger.
			for (let i = 0; i < 5; i += 1) {
				await f.ctx().onInbound({
					channel: "fake",
					conversationId: "c-stranger",
					messageId: `m-${i}`,
					from: "+15558889999", // distinct from other tests in this file
					text: `msg ${i}`,
					messageTimestampMs: Date.now(),
				});
			}
			assert.equal(f.sent.length, 1, "exactly ONE challenge reply across 5 messages");
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	/* ───────────────────── ChannelPairingAdapter consumption ───────────────────── */

	it("uses the adapter's pairing.idLabel='username' for the challenge card (not the phone heuristic)", async () => {
		// A sender id of pure digits would normally fall into the phone branch
		// (`📞 Your number: +X`). When the adapter's `pairing.idLabel` says
		// `"username"`, that explicit choice must win — the card should read
		// `@ Your username: <id>` instead.
		const tmp = mkdtempSync(join(tmpdir(), "brigade-pair-username-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel({
				connectedAt: () => Date.now() - 1_000,
				pairing: { idLabel: "username" },
			});
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => ({ reply: "x" }),
			});
			await f.ctx().onInbound({
				channel: "fake",
				conversationId: "c1",
				messageId: "m-1",
				from: "alice42",
				text: "hi",
				messageTimestampMs: Date.now(),
			});
			assert.equal(f.sent.length, 1, "stranger gets a challenge");
			const reply = f.sent[0]?.text ?? "";
			assert.match(reply, /Your username/i, "must render the username line");
			assert.match(reply, /alice42/, "must include the literal sender id");
			assert.doesNotMatch(reply, /Your number|Your account/i, "must not fall back to other labels");
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("falls back to the phone heuristic for digit-shaped senders when adapter declares no pairing slot", async () => {
		// No `adapter.pairing` → the legacy heuristic must still run, so a
		// `+1555…` stranger sees `📞 Your number: +1555…` (back-compat for
		// channels that haven't opted into the pairing-adapter slot yet).
		const tmp = mkdtempSync(join(tmpdir(), "brigade-pair-phone-fb-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		try {
			const f = makeFakeChannel({
				connectedAt: () => Date.now() - 1_000,
				// Deliberately no `pairing` slot — exercise the fallback.
			});
			const mgr = await startChannels({
				adapters: [f.adapter],
				config: { channels: { fake: { dmPolicy: "pairing" } } } as unknown as BrigadeConfig,
				agentId: "main",
				runTurn: async () => ({ reply: "x" }),
			});
			await f.ctx().onInbound({
				channel: "fake",
				conversationId: "c1",
				messageId: "m-1",
				from: "+15557776666",
				text: "hi",
				messageTimestampMs: Date.now(),
			});
			assert.equal(f.sent.length, 1);
			const reply = f.sent[0]?.text ?? "";
			assert.match(reply, /Your number/i, "digit sender + no pairing slot → phone label via heuristic");
			assert.match(reply, /\+15557776666/);
			await mgr.stop();
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("forwards inbound threadId as opts.threadId on adapter.sendText for the agent reply", async () => {
		// Slack/Discord-style threading: when the inbound carried a threadId,
		// the manager must pass it through to sendText so the reply lands in
		// the same thread instead of the channel root.
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => ({ reply: "in-thread reply" }),
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c-room",
			from: "u",
			text: "ping",
			threadId: "t-abc",
		});
		assert.equal(f.sentWithOpts.length, 1);
		assert.equal(f.sentWithOpts[0]?.opts?.threadId, "t-abc", "threadId must be forwarded as opts.threadId");
		// Sanity: when there's no threadId, opts is omitted (or undefined).
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c-room",
			from: "u",
			text: "again",
		});
		assert.equal(f.sentWithOpts.length, 2);
		assert.equal(f.sentWithOpts[1]?.opts, undefined, "no threadId → no opts passed");
		await mgr.stop();
	});

	it("forwards inbound accountId as opts.accountId on adapter.sendText for multi-account adapters", async () => {
		const f = makeFakeChannel();
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async () => ({ reply: "reply-from-acct-A" }),
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "peer-1",
			from: "u",
			text: "ping",
			accountId: "acct-A",
		});
		assert.equal(f.sentWithOpts.length, 1);
		assert.equal(
			f.sentWithOpts[0]?.opts?.accountId,
			"acct-A",
			"accountId must be forwarded as opts.accountId",
		);
		await mgr.stop();
	});

	it("two inbounds with same conversationId but different threadIds get distinct lanes (independent turns, no cross-thread bleed)", async () => {
		// Without per-thread lane keying, a second inbound on the same
		// conversation but in a sibling thread would either be queued behind
		// the first turn (gateway-level serialisation) or, worse, be aborted
		// by a "stop" answered in the sibling thread. The lane-key change in
		// Wave E lifts that constraint: distinct threadId → distinct lane →
		// distinct inflight controller + distinct dispatch.
		const f = makeFakeChannel();
		const turns: Array<{ text: string; sessionKey: string }> = [];
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: CONFIG,
			agentId: "main",
			runTurn: async (a) => {
				turns.push({ text: a.text, sessionKey: a.sessionKey });
				return { reply: `done:${a.text}` };
			},
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c-room",
			from: "u-1",
			text: "alpha",
			threadId: "t-1",
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "c-room",
			from: "u-2",
			text: "beta",
			threadId: "t-2",
		});
		assert.equal(turns.length, 2, "both threads must dispatch independently");
		assert.notEqual(
			turns[0]?.sessionKey,
			turns[1]?.sessionKey,
			"distinct threadId → distinct sessionKey",
		);
		// Replies must each carry their own threadId in opts.
		assert.equal(f.sentWithOpts.length, 2);
		assert.equal(f.sentWithOpts[0]?.opts?.threadId, "t-1");
		assert.equal(f.sentWithOpts[1]?.opts?.threadId, "t-2");
		await mgr.stop();
	});

	it("approval prompts in two different threads of the same conversation are tracked independently", async () => {
		// Without thread/account dimensions in peerKey, an approval raised in
		// thread A and another in thread B (same channel + conversation)
		// would collide: the second dispatch would deny-cancel the first.
		// With Wave E's expanded peerKey both prompts coexist; only the
		// matching thread's reply settles each.
		const { dispatchChannelApproval, registerChannelApprovalDispatcher, tryConsumeChannelApprovalReply, resetChannelApprovalRouterForTests } =
			await import("./approval-router.js");
		resetChannelApprovalRouterForTests();
		const sends: Array<{ conversationId: string; text: string; opts?: { threadId?: string; accountId?: string } }> = [];
		registerChannelApprovalDispatcher("fake", undefined, {
			sendText: async (conversationId, text, opts) => {
				sends.push({ conversationId, text, opts });
			},
			prettyName: "Fake",
		});
		const settled: Array<{ id: string; kind: string }> = [];
		const reqA = {
			id: "appr-A",
			command: "ls -la",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: ["allow-once", "allow-always", "deny"] as const,
		};
		const reqB = {
			id: "appr-B",
			command: "rm -rf /tmp/x",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: ["allow-once", "allow-always", "deny"] as const,
		};
		await dispatchChannelApproval({
			request: reqA,
			route: { channelId: "fake", conversationId: "c-room", threadId: "t-1", agentId: "main" },
			resolveOnBridge: (d) => settled.push({ id: "appr-A", kind: d.kind }),
		});
		await dispatchChannelApproval({
			request: reqB,
			route: { channelId: "fake", conversationId: "c-room", threadId: "t-2", agentId: "main" },
			resolveOnBridge: (d) => settled.push({ id: "appr-B", kind: d.kind }),
		});
		// Two distinct lanes → two prompts dispatched, NO deny-cancel of the
		// first. Pre-Wave-E this would have produced a deny on appr-A.
		assert.equal(sends.length, 2);
		assert.equal(settled.length, 0, "neither approval has resolved yet");
		// Reply "yes" in thread t-1 → settles ONLY appr-A.
		const r1 = tryConsumeChannelApprovalReply({
			channelId: "fake",
			conversationId: "c-room",
			threadId: "t-1",
			text: "yes",
		});
		assert.equal(r1.matched, true);
		if (r1.matched) {
			assert.equal(r1.approvalId, "appr-A");
			assert.equal(r1.decision, "allow-once");
		}
		assert.equal(settled.length, 1);
		assert.equal(settled[0]?.id, "appr-A");
		// Reply "no" in thread t-2 → settles ONLY appr-B.
		const r2 = tryConsumeChannelApprovalReply({
			channelId: "fake",
			conversationId: "c-room",
			threadId: "t-2",
			text: "no",
		});
		assert.equal(r2.matched, true);
		if (r2.matched) {
			assert.equal(r2.approvalId, "appr-B");
			assert.equal(r2.decision, "deny");
		}
		assert.equal(settled.length, 2);
		assert.equal(settled[1]?.id, "appr-B");
		resetChannelApprovalRouterForTests();
	});

	it("two inbounds with same conversationId but different accountIds use distinct sessionKeys + opts.accountId on the reply", async () => {
		// Per-account-channel-peer dmScope produces distinct session keys for
		// the same conversation on two different accounts; the manager must
		// also forward accountId on the outbound so the reply lands in the
		// account that received the inbound.
		const f = makeFakeChannel();
		const turns: Array<{ sessionKey: string }> = [];
		const cfg = {
			channels: { fake: { dmPolicy: "open" } },
			session: { dmScope: "per-account-channel-peer" },
		} as unknown as BrigadeConfig;
		const mgr = await startChannels({
			adapters: [f.adapter],
			config: cfg,
			agentId: "main",
			runTurn: async (a) => {
				turns.push({ sessionKey: a.sessionKey });
				return { reply: "ack" };
			},
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "+1555000",
			from: "+1555000",
			text: "from acct A",
			accountId: "acct-A",
		});
		await f.ctx().onInbound({
			channel: "fake",
			conversationId: "+1555000",
			from: "+1555000",
			text: "from acct B",
			accountId: "acct-B",
		});
		assert.equal(turns.length, 2);
		assert.notEqual(
			turns[0]?.sessionKey,
			turns[1]?.sessionKey,
			"distinct accountId → distinct sessionKey under per-account-channel-peer dmScope",
		);
		assert.equal(f.sentWithOpts[0]?.opts?.accountId, "acct-A");
		assert.equal(f.sentWithOpts[1]?.opts?.accountId, "acct-B");
		await mgr.stop();
	});
});
