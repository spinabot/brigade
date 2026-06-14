/**
 * Heartbeat runner ↔ cron wake-chain regression tests.
 *
 * Production failure (2026-06-11, operator field report): a `sessionTarget:
 * "main"` cron reminder fired, the TUI showed the 🦁 announce line, the run
 * logged `status: ok` — and then NOTHING happened. The WhatsApp message went
 * out only when the operator happened to type their next message. Root
 * cause: the gateway's cron `enqueueSystemEvent` dep wrote the event into
 * `pending-system-events.ts` (the legacy cron-only catch-up queue) while the
 * heartbeat runner peeks `session-inbox.ts` — two queues that were never
 * bridged, so every cron wake intent skipped `no-pending-events` and no
 * synthetic turn ever dispatched.
 *
 * These tests pin the FIXED contract at the runner boundary:
 *
 *   1. an inbox-enqueued cron event + a cron-wake intent → `ran`, the fired
 *      hook receives the event text (in the gateway this hook dispatches the
 *      synthetic turn that actually acts on the reminder);
 *   2. an event parked ONLY in the legacy pending queue does NOT satisfy a
 *      wake (documents the queue split: pending is next-real-turn catch-up
 *      for delivery-failure notices, not the wake path);
 *   3. a live mid-stream turn DEFERS a wake that has queued events (the
 *      retryable `requests-in-flight`, which the wake layer re-fires on its
 *      1s cooldown) instead of silently DROPPING it, and leaves the inbox
 *      intact; with nothing queued it stays a plain `session-busy` skip.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// Keep the inbox purely in-memory — this file tests queue/wake semantics,
// not the disk mirror (covered by session-inbox-persistence.test.ts).
process.env.BRIGADE_DISABLE_INBOX_PERSIST = "1";

import {
	addHeartbeatFiredHook,
	processHeartbeatWakeIntent,
	resetHeartbeatRunnerStateForTests,
} from "./heartbeat-runner.js";
import {
	resetHeartbeatWakeStateForTests,
	setHeartbeatsEnabled,
} from "./heartbeat-wake.js";
import {
	enqueueSystemEvent,
	hasSystemEvents,
	resetSessionInboxForTest,
} from "./session-inbox.js";
import {
	enqueuePendingSystemEvent,
	resetPendingSystemEventsForTests,
} from "./pending-system-events.js";
import {
	registerLiveSession,
	resetSessionRegistryForTests,
	unregisterLiveSession,
} from "./session-registry.js";

const SESSION_KEY = "agent:main:main";

beforeEach(() => {
	resetSessionInboxForTest();
	resetPendingSystemEventsForTests();
	resetHeartbeatRunnerStateForTests();
	resetHeartbeatWakeStateForTests();
	resetSessionRegistryForTests();
	setHeartbeatsEnabled(true);
});

test("cron-shaped inbox event + cron-wake → runner consumes it and fires the hook", async () => {
	const text =
		'[cron "reminder-5min-wa"] Send a WhatsApp reminder saying: Hey! Your 5-minute reminder!';
	const accepted = enqueueSystemEvent(text, {
		sessionKey: SESSION_KEY,
		contextKey: "cron:job-1",
		trusted: true,
	});
	assert.equal(accepted, true);

	const fired: Array<{ reason: string; agentId: string; sessionKey: string; texts: string[] }> = [];
	const dispose = addHeartbeatFiredHook((params) => {
		fired.push({
			reason: params.reason,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			texts: params.consumedEvents.map((e) => e.text),
		});
	});
	try {
		const res = await processHeartbeatWakeIntent({
			reason: "cron-wake",
			agentId: "main",
			sessionKey: SESSION_KEY,
		});
		assert.equal(res.status, "ran");
		assert.equal(fired.length, 1);
		assert.equal(fired[0]?.reason, "cron-wake");
		assert.equal(fired[0]?.agentId, "main");
		assert.equal(fired[0]?.sessionKey, SESSION_KEY);
		assert.deepEqual(fired[0]?.texts, [text]);
		// Consumed — a follow-up real turn must not double-surface it.
		assert.equal(hasSystemEvents(SESSION_KEY), false);
	} finally {
		dispose();
	}
});

test("an event parked only in the legacy pending queue does NOT satisfy a wake (the original bug)", async () => {
	enqueuePendingSystemEvent(SESSION_KEY, {
		text: "Send a WhatsApp reminder to the operator",
		queuedAtMs: Date.now(),
		jobId: "job-2",
		jobName: "reminder",
	});
	const res = await processHeartbeatWakeIntent({
		reason: "cron-wake",
		agentId: "main",
		sessionKey: SESSION_KEY,
	});
	assert.deepEqual(res, { status: "skipped", reason: "no-pending-events" });
});

test("live mid-stream turn defers (retryable) a wake with queued events instead of dropping it", async () => {
	registerLiveSession({
		sessionKey: SESSION_KEY,
		sessionId: "sess-1",
		agentId: "main",
		runId: "run-1",
		lane: "session:agent:main:main",
		abortController: new AbortController(),
	});

	// Nothing queued → plain busy skip (NOT retried; the interval wake or a
	// later cron fire covers it).
	let res = await processHeartbeatWakeIntent({
		reason: "cron-wake",
		agentId: "main",
		sessionKey: SESSION_KEY,
	});
	assert.deepEqual(res, { status: "skipped", reason: "session-busy" });

	// Events queued → the RETRYABLE reason, and the inbox is left intact so
	// the retry (or the next real turn) can still surface the reminder.
	enqueueSystemEvent('[cron "x"] fire the reminder', {
		sessionKey: SESSION_KEY,
		contextKey: "cron:job-3",
		trusted: true,
	});
	res = await processHeartbeatWakeIntent({
		reason: "cron-wake",
		agentId: "main",
		sessionKey: SESSION_KEY,
	});
	assert.deepEqual(res, { status: "skipped", reason: "requests-in-flight" });
	assert.equal(hasSystemEvents(SESSION_KEY), true);

	// Turn ends → the retried wake consumes the event and fires the hook.
	unregisterLiveSession(SESSION_KEY);
	const fired: string[][] = [];
	const dispose = addHeartbeatFiredHook((params) => {
		fired.push(params.consumedEvents.map((e) => e.text));
	});
	try {
		res = await processHeartbeatWakeIntent({
			reason: "cron-wake",
			agentId: "main",
			sessionKey: SESSION_KEY,
		});
		assert.equal(res.status, "ran");
		assert.deepEqual(fired, [['[cron "x"] fire the reminder']]);
		assert.equal(hasSystemEvents(SESSION_KEY), false);
	} finally {
		dispose();
	}
});
