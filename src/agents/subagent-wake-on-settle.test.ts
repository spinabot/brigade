/**
 * Wave O0.8 GAP 10 — synthetic wake on child completion.
 *
 * Pre-O0.8 `wakeOnDescendantSettle` was a declared field on
 * `SubagentRunRecord` that nothing read. An operator who called
 * `sessions_spawn` and then waited silently never got a turn to drain the
 * inbox — the announce sat there until they typed another message.
 *
 * Fix: when a spawned-run's `wakeOnDescendantSettle` is true and the bridge
 * successfully enqueues the announce, it calls
 * `requestHeartbeatNow({sessionKey: parentKey})` so the parent's next
 * heartbeat turn picks up the announce. Debounced per-parent so a burst of
 * sibling completions collapses to ONE wake.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	emitAgentEvent,
	resetAgentEventsForTests,
	wireAgentEventsBridge,
} from "./agent-events.js";
import {
	registerSubagentRun,
	resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import {
	resetHeartbeatWakeStateForTests,
	setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import { resetSessionInboxForTest } from "./session-inbox.js";
import { resetSubagentCompletionBridgeForTests } from "./subagent-completion-bridge.js";

test("wakeOnDescendantSettle fires requestHeartbeatNow for the parent", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetHeartbeatWakeStateForTests();
	resetSubagentCompletionBridgeForTests();

	const disposeBridge = wireAgentEventsBridge();

	// Capture wake calls via the heartbeat handler.
	const wakeCalls: Array<{ sessionKey?: string; reason?: string }> = [];
	const disposeHandler = setHeartbeatWakeHandler(async (opts) => {
		wakeCalls.push({
			...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
			...(opts.reason ? { reason: opts.reason } : {}),
		});
		return { status: "ran", durationMs: 0 };
	});

	const parentSessionKey = "agent:default:gap10-wake-parent";
	const childSessionKey = "agent:default:subagent:gap10-wake-child";
	const runId = "run-gap10-1";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "wake parent on completion",
		cleanup: "keep",
		label: "gap10",
		wakeOnDescendantSettle: true,
		createdAt: Date.now() - 50,
	});

	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: {
			phase: "end",
			ok: true,
			reply: "wake me up before you go go",
		},
	});

	// Wait for delivery task + debounced wake timer (25ms) + heartbeat
	// coalesce window (default 250ms in heartbeat-wake.ts).
	await new Promise((resolve) => setTimeout(resolve, 400));

	assert.ok(wakeCalls.length >= 1, `expected ≥1 wake, got ${wakeCalls.length}`);
	assert.ok(
		wakeCalls.some((c) => c.sessionKey === parentSessionKey),
		"wake must target the parent session",
	);

	disposeHandler();
	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
	resetHeartbeatWakeStateForTests();
});

test("wakeOnDescendantSettle=false does NOT wake the parent", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetHeartbeatWakeStateForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const wakeCalls: Array<{ sessionKey?: string }> = [];
	const disposeHandler = setHeartbeatWakeHandler(async (opts) => {
		wakeCalls.push({ ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}) });
		return { status: "ran", durationMs: 0 };
	});

	const parentSessionKey = "agent:default:gap10-nowake-parent";
	const childSessionKey = "agent:default:subagent:gap10-nowake-child";
	const runId = "run-gap10-2";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "do not wake parent",
		cleanup: "keep",
		label: "gap10-quiet",
		// Explicit opt-out — sub-of-sub or cron parents get this.
		wakeOnDescendantSettle: false,
		createdAt: Date.now() - 50,
	});

	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: { phase: "end", ok: true, reply: "quiet completion" },
	});

	await new Promise((resolve) => setTimeout(resolve, 400));

	const parentWakes = wakeCalls.filter((c) => c.sessionKey === parentSessionKey);
	assert.equal(parentWakes.length, 0, "parent must NOT receive a wake when opted out");

	disposeHandler();
	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
	resetHeartbeatWakeStateForTests();
});

test("multi-sibling completion debounces to a single parent wake", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetHeartbeatWakeStateForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const wakeCalls: Array<{ sessionKey?: string }> = [];
	const disposeHandler = setHeartbeatWakeHandler(async (opts) => {
		wakeCalls.push({ ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}) });
		return { status: "ran", durationMs: 0 };
	});

	const parentSessionKey = "agent:default:gap10-debounce-parent";

	for (let i = 0; i < 3; i++) {
		const childSessionKey = `agent:default:subagent:gap10-debounce-child-${i}`;
		const runId = `run-gap10-debounce-${i}`;
		registerSubagentRun({
			runId,
			childSessionKey,
			controllerSessionKey: parentSessionKey,
			requesterSessionKey: parentSessionKey,
			requesterDisplayKey: parentSessionKey,
			task: `sibling ${i}`,
			cleanup: "keep",
			label: `sib-${i}`,
			wakeOnDescendantSettle: true,
			createdAt: Date.now() - 100 + i,
		});
		emitAgentEvent({
			runId,
			stream: "lifecycle",
			sessionKey: childSessionKey,
			data: { phase: "end", ok: true, reply: `reply ${i}` },
		});
	}

	// Wait past the debounce window + heartbeat coalesce.
	await new Promise((resolve) => setTimeout(resolve, 400));

	const parentWakes = wakeCalls.filter((c) => c.sessionKey === parentSessionKey);
	assert.equal(
		parentWakes.length,
		1,
		`debounce must collapse 3 sibling completions to 1 wake; got ${parentWakes.length}`,
	);

	disposeHandler();
	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
	resetHeartbeatWakeStateForTests();
});
