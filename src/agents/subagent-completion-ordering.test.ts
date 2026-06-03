/**
 * Wave O0.8 GAP 12 — multi-child completion ordering deterministic via
 * per-parent serialization queue.
 *
 * Pre-O0.8 the completion bridge fired notifyListeners synchronously, but
 * wrapped delivery in `void (async () => ...)`. Two siblings finishing in
 * the same microtask scheduled async closures concurrently; final inbox
 * order depended on microtask scheduler.
 *
 * Fix: each parentSessionKey has its own Promise chain. Announces append
 * to the chain instead of forking parallel closures. Each enqueued
 * announce also carries a monotonic `completionSeq` so consumers that
 * need stable re-sorting can do so.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	emitAgentEvent,
	resetAgentEventsForTests,
	wireAgentEventsBridge,
} from "./agent-events.js";
import { drainSystemEvents, resetSessionInboxForTest } from "./session-inbox.js";
import {
	registerSubagentRun,
	resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import { resetSubagentCompletionBridgeForTests } from "./subagent-completion-bridge.js";

test("two children of same parent: inbox order matches lifecycle event order", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:gap12-order-parent";

	for (let i = 0; i < 2; i++) {
		const childSessionKey = `agent:default:subagent:gap12-order-child-${i}`;
		const runId = `run-gap12-order-${i}`;
		registerSubagentRun({
			runId,
			childSessionKey,
			controllerSessionKey: parentSessionKey,
			requesterSessionKey: parentSessionKey,
			requesterDisplayKey: parentSessionKey,
			task: `task ${i}`,
			cleanup: "keep",
			label: `child-${i}`,
			createdAt: Date.now() - 100 + i,
		});
	}

	// Emit phase:end for child-0 FIRST, then child-1, in the same tick.
	// Pre-fix the void-async closures could interleave; with the per-
	// parent chain the inbox order matches emission order.
	emitAgentEvent({
		runId: "run-gap12-order-0",
		stream: "lifecycle",
		sessionKey: "agent:default:subagent:gap12-order-child-0",
		data: { phase: "end", ok: true, reply: "first reply" },
	});
	emitAgentEvent({
		runId: "run-gap12-order-1",
		stream: "lifecycle",
		sessionKey: "agent:default:subagent:gap12-order-child-1",
		data: { phase: "end", ok: true, reply: "second reply" },
	});

	// Wait for the per-parent chain to flush both deliveries.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 30));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, 2, `expected 2 announces, got ${events.length}`);
	// First-in-first-out — child-0 announce comes before child-1's.
	assert.match(events[0]!, /child-0/, `first announce should be child-0; got: ${events[0]}`);
	assert.match(events[1]!, /child-1/, `second announce should be child-1; got: ${events[1]}`);
	// And the inner reply text matches the emission order too.
	assert.match(events[0]!, /first reply/);
	assert.match(events[1]!, /second reply/);

	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});

test("five concurrent sibling completions land in inbox in emission order", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:gap12-five-parent";
	const N = 5;

	for (let i = 0; i < N; i++) {
		const childSessionKey = `agent:default:subagent:gap12-five-child-${i}`;
		const runId = `run-gap12-five-${i}`;
		registerSubagentRun({
			runId,
			childSessionKey,
			controllerSessionKey: parentSessionKey,
			requesterSessionKey: parentSessionKey,
			requesterDisplayKey: parentSessionKey,
			task: `task ${i}`,
			cleanup: "keep",
			label: `five-${i}`,
			createdAt: Date.now() - 200 + i,
		});
	}

	// All five finish in the same synchronous burst.
	for (let i = 0; i < N; i++) {
		emitAgentEvent({
			runId: `run-gap12-five-${i}`,
			stream: "lifecycle",
			sessionKey: `agent:default:subagent:gap12-five-child-${i}`,
			data: { phase: "end", ok: true, reply: `payload-${i}` },
		});
	}

	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 50));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, N, `expected ${N} announces, got ${events.length}`);
	for (let i = 0; i < N; i++) {
		assert.match(
			events[i]!,
			new RegExp(`five-${i}`),
			`announce[${i}] must be five-${i}; got: ${events[i]}`,
		);
		assert.match(events[i]!, new RegExp(`payload-${i}`));
	}

	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});
