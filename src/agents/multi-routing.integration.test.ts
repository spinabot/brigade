/**
 * End-to-end integration test for the multi-routing spine (Step 27).
 *
 * Exercises the Step 9-18 substrate as one unit:
 *
 *   1. Register a live session (Step 11's `registerLiveSession`).
 *   2. Enqueue a system event into its inbox (Step 11's `enqueueSystemEvent`).
 *   3. Drain + format the event into a prompt block (Step 12).
 *   4. Subscribe to the agent-events bus + verify the lifecycle stream
 *      fires when the session transitions (Step 18 wiring).
 *   5. Unregister the session + verify the registry's count drops.
 *
 * The integration test is HERMETIC — every singleton state container is
 * reset before each case so test order doesn't matter.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	emitAgentEvent,
	onAgentEvent,
	resetAgentEventsForTests,
	wireAgentEventsBridge,
} from "./agent-events.js";
import type { AgentEventPayload } from "./agent-events.types.js";
import {
	drainFormattedSessionEvents,
	inspectPendingSessionEvents,
} from "./session-event-prompt.js";
import {
	abortAllSessions,
	countActiveLiveSessions,
	countActiveLiveSessionsForAgent,
	getLiveSession,
	listLiveSessions,
	registerLiveSession,
	resetSessionRegistryForTests,
	unregisterLiveSession,
} from "./session-registry.js";
import { enqueueSystemEvent, resetSessionInboxForTest } from "./session-inbox.js";

const TEST_SESSION_KEY = "agent:test:integration-spine";

describe("multi-routing spine (Steps 9-18)", () => {
	beforeEach(() => {
		resetAgentEventsForTests();
		resetSessionRegistryForTests();
		resetSessionInboxForTest();
	});

	afterEach(() => {
		resetAgentEventsForTests();
		resetSessionRegistryForTests();
		resetSessionInboxForTest();
	});

	it("registers, lists, and unregisters live sessions", () => {
		const abort = new AbortController();
		registerLiveSession({
			sessionKey: TEST_SESSION_KEY,
			sessionId: "run-1",
			agentId: "test",
			runId: "run-1",
			lane: `session:${TEST_SESSION_KEY}`,
			abortController: abort,
		});
		assert.equal(countActiveLiveSessions(), 1, "one session should be running");
		const entry = getLiveSession(TEST_SESSION_KEY);
		assert.equal(entry?.agentId, "test");
		assert.equal(entry?.state, "running");

		const removed = unregisterLiveSession(TEST_SESSION_KEY);
		assert.ok(removed, "unregister returns true on hit");
		assert.equal(listLiveSessions().length, 0, "registry empty after unregister");
	});

	it("drains inbox events into a formatted prompt block", () => {
		enqueueSystemEvent("Build #42 complete", {
			sessionKey: TEST_SESSION_KEY,
			trusted: true,
			contextKey: "build:42",
		});
		enqueueSystemEvent("alert: CPU > 90%", {
			sessionKey: TEST_SESSION_KEY,
			trusted: false,
			contextKey: "alert:cpu",
		});

		const inspection = inspectPendingSessionEvents(TEST_SESSION_KEY);
		assert.ok(inspection.hasSurfaceable, "events should be surfaceable");
		assert.ok(inspection.hasUntrusted, "untrusted event flagged");

		const block = drainFormattedSessionEvents({ sessionKey: TEST_SESSION_KEY });
		assert.ok(block, "block should be present");
		assert.match(block ?? "", /^System: \[\d{4}-/, "first line has timestamp");
		assert.match(block ?? "", /System \(untrusted\): /, "untrusted variant present");
	});

	it("filters heartbeat-scheduler noise out of the formatted block", () => {
		enqueueSystemEvent("heartbeat poll: pending", { sessionKey: TEST_SESSION_KEY });
		enqueueSystemEvent("reason periodic: 5m", { sessionKey: TEST_SESSION_KEY });
		enqueueSystemEvent("Read HEARTBEAT.md before continuing", {
			sessionKey: TEST_SESSION_KEY,
		});

		const block = drainFormattedSessionEvents({ sessionKey: TEST_SESSION_KEY });
		assert.equal(block, undefined, "every line is filter-eligible noise");
	});

	it("delivers emitted events to registered listeners with monotonic seq", () => {
		const received: AgentEventPayload[] = [];
		const dispose = onAgentEvent((event) => {
			received.push(event);
		});
		try {
			emitAgentEvent({
				runId: "run-1",
				stream: "lifecycle",
				sessionKey: TEST_SESSION_KEY,
				data: { phase: "start" },
			});
			emitAgentEvent({
				runId: "run-1",
				stream: "lifecycle",
				sessionKey: TEST_SESSION_KEY,
				data: { phase: "end", ok: true },
			});
			emitAgentEvent({
				runId: "run-2",
				stream: "heartbeat",
				data: { kind: "heartbeat_fired", reason: "interval" },
			});

			assert.equal(received.length, 3, "all three events delivered");
			const run1Events = received.filter((event) => event.runId === "run-1");
			assert.equal(run1Events.length, 2);
			assert.equal(run1Events[0]?.seq, 1, "first event in run is seq=1");
			assert.equal(run1Events[1]?.seq, 2, "second event in run is seq=2");
			const run2Events = received.filter((event) => event.runId === "run-2");
			assert.equal(run2Events[0]?.seq, 1, "fresh runId starts at seq=1");
		} finally {
			dispose();
		}
	});

	it("wiring bridge installs without throwing + can be disposed", () => {
		const dispose = wireAgentEventsBridge();
		try {
			assert.equal(typeof dispose, "function", "dispose handle returned");
			// Idempotent: calling twice returns the same disposer.
			const second = wireAgentEventsBridge();
			assert.equal(second, dispose, "second wire returns existing disposer");
		} finally {
			dispose();
		}
	});

	it("countActiveLiveSessionsForAgent scopes the running count per agent (Wave K)", () => {
		registerLiveSession({
			sessionKey: "agent:main:main",
			sessionId: "run-main",
			agentId: "main",
			runId: "run-main",
			lane: "session:agent:main:main",
			abortController: new AbortController(),
		});
		registerLiveSession({
			sessionKey: "agent:ops:main",
			sessionId: "run-ops",
			agentId: "ops",
			runId: "run-ops",
			lane: "session:agent:ops:main",
			abortController: new AbortController(),
		});
		assert.equal(countActiveLiveSessions(), 2);
		assert.equal(countActiveLiveSessionsForAgent("main"), 1);
		assert.equal(countActiveLiveSessionsForAgent("ops"), 1);
		assert.equal(
			countActiveLiveSessionsForAgent("nobody"),
			0,
			"unknown agent → 0 (no false positive)",
		);
		assert.equal(countActiveLiveSessionsForAgent(""), 0, "empty id → 0");
	});

	it("abortAllSessions terminates every registered session", () => {
		const abortA = new AbortController();
		const abortB = new AbortController();
		registerLiveSession({
			sessionKey: "agent:test:a",
			sessionId: "run-a",
			agentId: "test",
			runId: "run-a",
			lane: "session:agent:test:a",
			abortController: abortA,
		});
		registerLiveSession({
			sessionKey: "agent:test:b",
			sessionId: "run-b",
			agentId: "test",
			runId: "run-b",
			lane: "session:agent:test:b",
			abortController: abortB,
		});
		const aborted = abortAllSessions("shutdown");
		assert.equal(aborted, 2, "both sessions aborted");
		assert.ok(abortA.signal.aborted, "controller A aborted");
		assert.ok(abortB.signal.aborted, "controller B aborted");
	});
});
