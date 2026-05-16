import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetAgentBusForTests, onAgentEvent } from "./agent-event-bus.js";
import {
	__resetToolLoopStateForTests,
	__toolLoopSessionCount,
	DEFAULT_TOOL_LOOP_CONFIG,
	dropToolLoopSession,
	makeToolLoopDetector,
} from "./tool-loop-detector.js";

beforeEach(() => {
	__resetToolLoopStateForTests();
	__resetAgentBusForTests();
});

afterEach(() => {
	__resetToolLoopStateForTests();
	__resetAgentBusForTests();
});

const READ_CALL = { toolCall: { name: "read", arguments: { path: "src/foo.ts" } } } as never;

describe("makeToolLoopDetector — pass-through behavior", () => {
	it("passes through a single call", async () => {
		const detector = makeToolLoopDetector();
		const r = await detector(READ_CALL);
		assert.equal(r, undefined);
	});

	it("passes through calls below warnAfter threshold", async () => {
		const detector = makeToolLoopDetector();
		for (let i = 0; i < DEFAULT_TOOL_LOOP_CONFIG.warnAfter - 1; i++) {
			const r = await detector(READ_CALL);
			assert.equal(r, undefined, `call ${i + 1} should pass through`);
		}
	});

	it("passes through DIFFERENT calls regardless of count", async () => {
		const detector = makeToolLoopDetector();
		for (let i = 0; i < 30; i++) {
			const r = await detector({
				toolCall: { name: "read", arguments: { path: `src/file-${i}.ts` } },
			} as never);
			assert.equal(r, undefined, `call ${i} (different path) should pass through`);
		}
	});

	it("different tool names break the streak", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 3, blockAfter: 5 } });
		// 4 reads, then a write, then 4 more reads — neither should hit block.
		for (let i = 0; i < 4; i++) await detector(READ_CALL);
		await detector({
			toolCall: { name: "write", arguments: { path: "x", content: "y" } },
		} as never);
		for (let i = 0; i < 4; i++) {
			const r = await detector(READ_CALL);
			assert.equal(r, undefined);
		}
	});
});

describe("makeToolLoopDetector — warning emission", () => {
	it("emits a tool-blocked warning event at warnAfter (but still passes through)", async () => {
		const events: Array<{ reason: string; toolName: string }> = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push({ reason: e.reason, toolName: e.toolName });
		});
		const detector = makeToolLoopDetector({ config: { warnAfter: 3, blockAfter: 100 } });
		await detector(READ_CALL);
		await detector(READ_CALL);
		assert.equal(events.length, 0, "no warning before threshold");
		const r = await detector(READ_CALL); // 3rd identical call
		assert.equal(r, undefined, "warning level still passes through");
		assert.equal(events.length, 1);
		assert.match(events[0]?.reason ?? "", /loop warning/i);
		assert.match(events[0]?.reason ?? "", /3rd identical/);
	});

	it("rate-limits warnings (one per 10-call bucket past warnAfter)", async () => {
		const events: string[] = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push(e.reason);
		});
		const detector = makeToolLoopDetector({ config: { warnAfter: 3, blockAfter: 1000 } });
		// First 3 calls — no warning yet at 1, 2; warning at 3.
		for (let i = 0; i < 15; i++) await detector(READ_CALL);
		// 15 identical calls. Expected warnings: at 3 and at 13 (3 + 10).
		assert.ok(events.length <= 2, `expected <=2 warnings for 15 calls, got ${events.length}`);
		assert.ok(events.length >= 1);
	});
});

describe("makeToolLoopDetector — block at critical threshold", () => {
	it("blocks at blockAfter with a clear refusal", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 3, blockAfter: 5 } });
		// 4 identical calls pass through (warnings emitted along the way)
		for (let i = 0; i < 4; i++) {
			const r = await detector(READ_CALL);
			assert.equal(r, undefined, `call ${i + 1} should pass through`);
		}
		// 5th identical call BLOCKS
		const r = await detector(READ_CALL);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /tool-call loop/i);
		assert.match(r?.reason ?? "", /5th identical call/);
		assert.match(r?.reason ?? "", /DIFFERENT tool/);
	});

	it("block reason instructs the model how to recover", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 1, blockAfter: 2 } });
		await detector(READ_CALL);
		const r = await detector(READ_CALL);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /Stop calling/);
		assert.match(r?.reason ?? "", /different/i);
		assert.match(r?.reason ?? "", /synthesise|inspect.*result/i);
	});

	it("emits tool-blocked bus event at critical block", async () => {
		const events: Array<{ reason: string }> = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push({ reason: e.reason });
		});
		const detector = makeToolLoopDetector({ config: { warnAfter: 100, blockAfter: 2 } });
		await detector(READ_CALL);
		await detector(READ_CALL);
		assert.ok(events.length >= 1);
		const blockEvent = events.find((e) => /tool-call loop/i.test(e.reason));
		assert.ok(blockEvent, "must have emitted a block-level event");
	});

	it("a different call AFTER block resets the streak", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 1, blockAfter: 3 } });
		await detector(READ_CALL);
		await detector(READ_CALL);
		const blocked = await detector(READ_CALL);
		assert.equal(blocked?.block, true);
		// Different call breaks the streak
		await detector({
			toolCall: { name: "write", arguments: { path: "USER.md", content: "x" } },
		} as never);
		// Back to read — count starts fresh
		for (let i = 0; i < 2; i++) {
			const r = await detector(READ_CALL);
			assert.equal(r, undefined, `post-reset call ${i + 1} should pass through`);
		}
	});
});

describe("makeToolLoopDetector — bus events carry runId/agentId from ctxRef", () => {
	it("emits with the live ctxRef ids", async () => {
		const events: Array<{ runId: string; agentId: string }> = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push({ runId: e.runId, agentId: e.agentId });
		});
		const ctxRef = { value: { runId: "turn-99", agentId: "main", sessionKey: "k1" } };
		const detector = makeToolLoopDetector({ ctxRef, config: { warnAfter: 1, blockAfter: 2 } });
		await detector(READ_CALL);
		await detector(READ_CALL);
		const blockEvent = events.find((e) => e.runId === "turn-99");
		assert.ok(blockEvent, "block event should carry runId from ctxRef");
		assert.equal(blockEvent?.agentId, "main");
	});

	it("uses empty-string ids when ctxRef is unset", async () => {
		const events: Array<{ runId: string; agentId: string }> = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push({ runId: e.runId, agentId: e.agentId });
		});
		const detector = makeToolLoopDetector({ config: { warnAfter: 1, blockAfter: 2 } });
		await detector(READ_CALL);
		await detector(READ_CALL);
		assert.ok(events.length >= 1);
		assert.equal(events[0]?.runId, "");
		assert.equal(events[0]?.agentId, "");
	});
});

describe("makeToolLoopDetector — per-session state isolation", () => {
	it("loop state is scoped by sessionKey (one session looping doesn't affect another)", async () => {
		const ctxA = { value: { sessionKey: "session-A" } };
		const ctxB = { value: { sessionKey: "session-B" } };
		const dA = makeToolLoopDetector({ ctxRef: ctxA, config: { warnAfter: 1, blockAfter: 3 } });
		const dB = makeToolLoopDetector({ ctxRef: ctxB, config: { warnAfter: 1, blockAfter: 3 } });
		// Session A: 3 identical → blocks
		await dA(READ_CALL);
		await dA(READ_CALL);
		const aBlocked = await dA(READ_CALL);
		assert.equal(aBlocked?.block, true);
		// Session B: 1 identical → still passes
		const bOk = await dB(READ_CALL);
		assert.equal(bOk, undefined);
	});

	it("__toolLoopSessionCount reports the number of sessions with state", async () => {
		const dA = makeToolLoopDetector({ ctxRef: { value: { sessionKey: "A" } } });
		const dB = makeToolLoopDetector({ ctxRef: { value: { sessionKey: "B" } } });
		assert.equal(__toolLoopSessionCount(), 0);
		await dA(READ_CALL);
		assert.equal(__toolLoopSessionCount(), 1);
		await dB(READ_CALL);
		assert.equal(__toolLoopSessionCount(), 2);
	});
});

describe("makeToolLoopDetector — edge cases", () => {
	it("empty / whitespace tool name routes to undefined (pass through)", async () => {
		const detector = makeToolLoopDetector();
		const r1 = await detector({ toolCall: { name: "", arguments: {} } } as never);
		const r2 = await detector({ toolCall: { name: "   ", arguments: {} } } as never);
		assert.equal(r1, undefined);
		assert.equal(r2, undefined);
	});

	it("non-serializable params (circular) don't crash the detector", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 100, blockAfter: 2 } });
		const circular: { self?: unknown } = {};
		circular.self = circular;
		const call = { toolCall: { name: "read", arguments: circular } } as never;
		await detector(call);
		const r = await detector(call);
		assert.equal(r?.block, true, "two identical circular calls should still trigger the detector");
	});

	it("ring buffer caps memory — old entries are evicted", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 100, blockAfter: 1000, windowSize: 3 } });
		// Push 10 distinct calls; only the last 3 should remain in state.
		// We can't read state directly, but we can verify that an 11th
		// call that matches an evicted entry doesn't see a stale streak.
		for (let i = 0; i < 10; i++) {
			await detector({
				toolCall: { name: "read", arguments: { path: `f-${i}.ts` } },
			} as never);
		}
		// Now re-call f-0.ts — it was evicted, so count = 1 (not 2).
		const r = await detector({
			toolCall: { name: "read", arguments: { path: "f-0.ts" } },
		} as never);
		assert.equal(r, undefined);
	});

	it("DEFAULT_TOOL_LOOP_CONFIG is exported with sane values", () => {
		assert.ok(DEFAULT_TOOL_LOOP_CONFIG.warnAfter > 0);
		assert.ok(DEFAULT_TOOL_LOOP_CONFIG.blockAfter > DEFAULT_TOOL_LOOP_CONFIG.warnAfter);
		assert.ok(DEFAULT_TOOL_LOOP_CONFIG.windowSize >= DEFAULT_TOOL_LOOP_CONFIG.blockAfter);
	});
});

describe("makeToolLoopDetector — block streak reset (round-7 audit BUG-1 fix)", () => {
	it("after a critical block, the streak resets — NEXT call doesn't fire 21st/22nd/… events", async () => {
		const events: string[] = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push(e.reason);
		});
		const detector = makeToolLoopDetector({ config: { warnAfter: 100, blockAfter: 2 } });
		await detector(READ_CALL); // 1st
		const r1 = await detector(READ_CALL); // 2nd — blocks
		assert.equal(r1?.block, true);
		assert.match(r1?.reason ?? "", /2nd identical call/);
		// Next identical call must start the streak over, NOT say "3rd
		// identical call" or "4th identical call". The model already saw
		// one block — re-emitting "21st" / "22nd" / etc. is bus spam and
		// the operator/dashboard sees nonsense numbers.
		const r2 = await detector(READ_CALL); // post-block call → fresh streak
		assert.equal(r2, undefined, "post-block identical call should NOT immediately block again");
		const r3 = await detector(READ_CALL); // 2nd in fresh streak → blocks AGAIN with same threshold
		assert.equal(r3?.block, true);
		assert.match(r3?.reason ?? "", /2nd identical call/, "block reason should restart count, not say '4th'");
	});

	it("post-block events don't contain misleading counter values past the threshold", async () => {
		const events: string[] = [];
		onAgentEvent((e) => {
			if (e.type === "tool-blocked") events.push(e.reason);
		});
		const detector = makeToolLoopDetector({ config: { warnAfter: 100, blockAfter: 3 } });
		// 3 calls → block
		await detector(READ_CALL);
		await detector(READ_CALL);
		await detector(READ_CALL);
		// 3 more identical calls — should produce ONE more block at count=3
		// (after the fresh-streak reset), not 4/5/6.
		await detector(READ_CALL);
		await detector(READ_CALL);
		await detector(READ_CALL);
		// Find any event that mentions a count >= 4 — there should be NONE.
		const dirtyCount = events.find((r) => /[4-9]\dth|[4-9]th|10th identical call/.test(r));
		assert.equal(dirtyCount, undefined, `no event should reference count >= 4: got ${dirtyCount}`);
	});
});

describe("dropToolLoopSession — memory hygiene", () => {
	it("removes a single session's ring buffer", async () => {
		const ctxA = { value: { sessionKey: "session-A" } };
		const detector = makeToolLoopDetector({ ctxRef: ctxA });
		await detector(READ_CALL);
		assert.equal(__toolLoopSessionCount(), 1);
		dropToolLoopSession("session-A");
		assert.equal(__toolLoopSessionCount(), 0);
	});

	it("is a no-op when the sessionKey isn't tracked", async () => {
		dropToolLoopSession("never-existed");
		assert.equal(__toolLoopSessionCount(), 0);
	});

	it("after drop, the next call from that session starts a fresh streak", async () => {
		const ctxA = { value: { sessionKey: "session-A" } };
		const detector = makeToolLoopDetector({
			ctxRef: ctxA,
			config: { warnAfter: 100, blockAfter: 3 },
		});
		await detector(READ_CALL);
		await detector(READ_CALL);
		dropToolLoopSession("session-A");
		// Stream was at count=2 before drop. After drop, the next call is
		// count=1, NOT count=3, so it doesn't block.
		const r = await detector(READ_CALL);
		assert.equal(r, undefined);
	});
});

describe("makeToolLoopDetector — composition with other guards", () => {
	it("can be composed in a beforeToolCall chain (returns block from chain)", async () => {
		const detector = makeToolLoopDetector({ config: { warnAfter: 1, blockAfter: 2 } });
		// Mimic the agent-loop composition pattern: detector → exec-gate.
		const composed = async (ctx: never) => {
			const loop = await detector(ctx);
			if (loop?.block) return loop;
			return undefined; // fake "exec-gate passes"
		};
		await composed(READ_CALL);
		const r = await composed(READ_CALL);
		assert.equal(r?.block, true);
	});
});
