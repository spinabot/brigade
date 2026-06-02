import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	__agentBusListenerCount,
	__resetAgentBusForTests,
	emitAgentEvent,
	onAgentEvent,
	type AgentBusEvent,
} from "./agent-event-bus.js";

describe("agent-event-bus", () => {
	afterEach(() => {
		__resetAgentBusForTests();
	});

	it("starts with zero listeners", () => {
		assert.equal(__agentBusListenerCount(), 0);
	});

	it("onAgentEvent registers a listener and returns a disposer", () => {
		const events: AgentBusEvent[] = [];
		const dispose = onAgentEvent((e) => events.push(e));
		assert.equal(__agentBusListenerCount(), 1);

		emitAgentEvent({
			type: "tool-blocked",
			runId: "r1",
			agentId: "main",
			toolName: "bash",
			reason: "disabled in v1",
		});
		assert.equal(events.length, 1);
		assert.equal(events[0]?.type, "tool-blocked");

		dispose();
		assert.equal(__agentBusListenerCount(), 0);
	});

	it("disposer is idempotent (calling twice is a no-op)", () => {
		const dispose = onAgentEvent(() => {});
		dispose();
		dispose();
		assert.equal(__agentBusListenerCount(), 0);
	});

	it("multiple listeners all receive the same event", () => {
		const a: AgentBusEvent[] = [];
		const b: AgentBusEvent[] = [];
		const c: AgentBusEvent[] = [];
		onAgentEvent((e) => a.push(e));
		onAgentEvent((e) => b.push(e));
		onAgentEvent((e) => c.push(e));
		assert.equal(__agentBusListenerCount(), 3);

		emitAgentEvent({
			type: "turn-start",
			runId: "r1",
			agentId: "main",
			sessionId: "s1",
			isNewSession: true,
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
			bootstrapPhase: "first-turn",
		});

		assert.equal(a.length, 1);
		assert.equal(b.length, 1);
		assert.equal(c.length, 1);
	});

	it("disposed listeners do not receive subsequent events", () => {
		const a: AgentBusEvent[] = [];
		const b: AgentBusEvent[] = [];
		const disposeA = onAgentEvent((e) => a.push(e));
		onAgentEvent((e) => b.push(e));

		emitAgentEvent({
			type: "slash-handled",
			runId: "r1",
			agentId: "main",
			command: "model",
		});

		disposeA();

		emitAgentEvent({
			type: "slash-handled",
			runId: "r2",
			agentId: "main",
			command: "thinking",
		});

		assert.equal(a.length, 1, "A should only see turn 1");
		assert.equal(b.length, 2, "B should see both");
	});

	it("a throwing listener does NOT block other listeners", () => {
		// We mute process warnings during the assertion so emitAgentEvent's
		// internal `process.emitWarning` doesn't pollute test output. We
		// don't observe the warning here — the warning event fires on
		// nextTick and racing it from a sync test is unreliable. The real
		// contract being tested is: a throw in listener A does NOT prevent
		// listener B from running.
		const origWarning = process.listeners("warning").slice();
		process.removeAllListeners("warning");
		process.on("warning", () => {});

		try {
			const survivors: AgentBusEvent[] = [];
			onAgentEvent(() => {
				throw new Error("boom");
			});
			onAgentEvent((e) => survivors.push(e));

			emitAgentEvent({
				type: "turn-aborted",
				runId: "r1",
				agentId: "main",
				sessionId: "s1",
				reason: "user requested",
			});

			assert.equal(survivors.length, 1, "second listener must still fire");
		} finally {
			process.removeAllListeners("warning");
			for (const l of origWarning) process.on("warning", l);
		}
	});

	it("emit with zero listeners is a no-op (and cheap)", () => {
		// Just verify it doesn't throw or hang.
		emitAgentEvent({
			type: "tool-blocked",
			runId: "r1",
			agentId: "main",
			toolName: "edit",
			reason: "outside workspace",
		});
		assert.equal(__agentBusListenerCount(), 0);
	});

	it("a listener subscribing during emit does not see the in-flight event", () => {
		const a: AgentBusEvent[] = [];
		const b: AgentBusEvent[] = [];
		onAgentEvent((e) => {
			a.push(e);
			// subscribe a new listener WHILE the current emit is broadcasting
			onAgentEvent((next) => b.push(next));
		});

		emitAgentEvent({
			type: "model-switched",
			runId: "r1",
			agentId: "main",
			fromProvider: "openrouter",
			fromModelId: "openai/gpt-5.4",
			toProvider: "openrouter",
			toModelId: "anthropic/claude-opus-4-7",
		});

		assert.equal(a.length, 1, "first listener fired once");
		assert.equal(b.length, 0, "newly-subscribed listener should NOT see the in-flight event");

		// But it WILL see the next one.
		emitAgentEvent({
			type: "model-switched",
			runId: "r2",
			agentId: "main",
			fromProvider: "x",
			fromModelId: "y",
			toProvider: "z",
			toModelId: "w",
		});
		assert.equal(b.length, 1);
	});

	it("a listener disposing during emit still completes the current broadcast cleanly", () => {
		const events: AgentBusEvent[] = [];
		let dispose: (() => void) | null = null;
		dispose = onAgentEvent((e) => {
			events.push(e);
			dispose?.(); // remove self mid-broadcast
		});
		const tail: AgentBusEvent[] = [];
		onAgentEvent((e) => tail.push(e));

		emitAgentEvent({
			type: "tool-blocked",
			runId: "r1",
			agentId: "main",
			toolName: "write",
			reason: "outside workspace",
		});

		assert.equal(events.length, 1);
		assert.equal(tail.length, 1, "tail listener should still fire even though head disposed mid-broadcast");

		// Confirm the self-disposing listener really is gone.
		emitAgentEvent({
			type: "tool-blocked",
			runId: "r2",
			agentId: "main",
			toolName: "bash",
			reason: "disabled",
		});
		assert.equal(events.length, 1, "no new event for self-disposed listener");
		assert.equal(tail.length, 2, "tail keeps receiving");
	});

	// Wave I — every loop-lifecycle event variant now carries optional
	// `agentId` + `sessionKey` so the gateway's WS broadcaster can tag the
	// emitted `log` frame and the per-client subscription filter routes the
	// frame to the operator watching THIS agent only. The test mirrors the
	// gateway's "two operators on two agents" topology — two listeners each
	// filtering on their own agentId — and asserts each one only sees its
	// own agent's events.
	it("loop-lifecycle events route by agentId+sessionKey (Wave I)", () => {
		const opsEvents: AgentBusEvent[] = [];
		const mainEvents: AgentBusEvent[] = [];
		onAgentEvent((e) => {
			if ("agentId" in e && e.agentId === "ops") opsEvents.push(e);
		});
		onAgentEvent((e) => {
			if ("agentId" in e && e.agentId === "main") mainEvents.push(e);
		});

		emitAgentEvent({
			type: "turn-retry-attempt",
			runId: "r-ops-1",
			agentId: "ops",
			sessionKey: "agent:ops:main",
			errorClass: "rate_limit",
			reason: "retrying",
		});
		emitAgentEvent({
			type: "turn-content-retry",
			runId: "r-main-1",
			agentId: "main",
			sessionKey: "agent:main:main",
			reason: "empty",
		});
		emitAgentEvent({
			type: "turn-thinking-downgrade",
			runId: "r-ops-2",
			agentId: "ops",
			sessionKey: "agent:ops:main",
			from: "high",
		});
		// Untagged event (legacy callsite) — neither filter matches it.
		emitAgentEvent({
			type: "turn-heartbeat",
			runId: "r-legacy",
			elapsedMs: 5000,
		});

		assert.equal(opsEvents.length, 2, "ops listener sees only ops events");
		assert.equal(mainEvents.length, 1, "main listener sees only main events");
		assert.equal(opsEvents[0]?.type, "turn-retry-attempt");
		assert.equal(opsEvents[1]?.type, "turn-thinking-downgrade");
		assert.equal(mainEvents[0]?.type, "turn-content-retry");
	});

	// Wave I — tool-blocked events from exec-gate forward the live
	// `sessionKey` from the GuardContextRef bag (in addition to runId +
	// agentId). The gateway's lifecycle-bus subscriber lifts both fields onto
	// the broadcast `log` payload so connWantsFrame can route the refusal
	// only to the operator watching this session.
	it("tool-blocked events carry agentId+sessionKey (Wave I)", () => {
		const received: AgentBusEvent[] = [];
		onAgentEvent((e) => received.push(e));

		emitAgentEvent({
			type: "tool-blocked",
			runId: "r1",
			agentId: "ops",
			sessionKey: "agent:ops:main",
			toolName: "bash",
			reason: "requires approval",
		});

		assert.equal(received.length, 1);
		const event = received[0];
		assert.ok(event && event.type === "tool-blocked");
		assert.equal(event.agentId, "ops");
		assert.equal(event.sessionKey, "agent:ops:main");
		assert.equal(event.toolName, "bash");
	});
});
