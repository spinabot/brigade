/**
 * Wave O0.8 GAP 8 — async abort/timeout outcomes classified correctly.
 *
 * Pre-O0.8 the adapters in `core/server.ts` returned only `{ok, reply, error}`.
 * The `aborted`/`timedOut` flags from the subagent runner were dropped, so
 * `deriveOutcomes` classified every non-ok return as ERROR — an operator
 * Ctrl+C surfaced to the parent's inbox as "Sub-agent X failed: …" instead
 * of "Sub-agent X was aborted".
 *
 * This test threads a synthetic abort + a synthetic timeout through the
 * dispatchAgentRun → bridge → drainSystemEvents flow and asserts the
 * announce text contains "aborted" / "timed out", NOT "failed".
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

test("spawn lifecycle: abort outcome surfaces as 'aborted', not 'failed'", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:gap8-abort-parent";
	const childSessionKey = "agent:default:subagent:gap8-abort-child";
	const runId = "run-gap8-abort-1";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "synthetic abort path",
		cleanup: "keep",
		label: "gap8-abort",
		createdAt: Date.now() - 200,
	});

	// Synthesise the lifecycle event the dispatcher would emit when the
	// adapter returns { ok:false, aborted:true } (or rejects with an
	// AbortError that the dispatcher catches).
	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: {
			phase: "end",
			ok: false,
			aborted: true,
			error: "parent-aborted",
			reply: "got partway then was cancelled",
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 10));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, 1, `expected 1 announce, got ${events.length}`);
	const text = events[0]!;
	assert.match(text, /Sub-agent "gap8-abort" was aborted/);
	assert.match(text, /status=aborted/);
	// Importantly, the announce must NOT say "failed".
	assert.doesNotMatch(text, /failed/, "abort outcome must not classify as 'failed'");

	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});

test("spawn lifecycle: timeout outcome surfaces as 'timed out', not 'failed'", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:gap8-timeout-parent";
	const childSessionKey = "agent:default:subagent:gap8-timeout-child";
	const runId = "run-gap8-timeout-1";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "synthetic timeout path",
		cleanup: "keep",
		label: "gap8-timeout",
		createdAt: Date.now() - 500,
	});

	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: {
			phase: "end",
			ok: false,
			timedOut: true,
			error: "child exceeded run-timeout",
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 10));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, 1);
	const text = events[0]!;
	assert.match(text, /Sub-agent "gap8-timeout" timed out/);
	assert.match(text, /status=timed-out/);
	assert.doesNotMatch(text, /failed/, "timeout outcome must not classify as 'failed'");

	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});

test("spawn lifecycle: reason='abort' string discriminator also classifies as ABORT", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:gap8-reason-abort";
	const childSessionKey = "agent:default:subagent:gap8-reason-abort-c";
	const runId = "run-gap8-reason-abort-1";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "string-discriminator abort",
		cleanup: "keep",
		label: "gap8-reason",
		createdAt: Date.now() - 100,
	});

	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: {
			phase: "end",
			ok: false,
			reason: "aborted",
			error: "ctrl+c during stream",
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 10));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, 1);
	const text = events[0]!;
	assert.match(text, /was aborted/);
	assert.match(text, /status=aborted/);

	disposeBridge();
	resetSubagentCompletionBridgeForTests();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});
