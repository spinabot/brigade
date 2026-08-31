/**
 * The envelope decides whether the operator ever sees a mid-turn compaction.
 *
 * These assert the tag SHAPE and then feed it through the REAL gateway
 * subscription filter, because the two halves failed independently: the frame
 * carried a `randomUUID` where the routing key belonged, and every existing
 * test either checked the filter with hand-written tags or checked the
 * compactor without ever building a frame. Neither noticed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldDeliverFrame } from "../../core/ws-subscription-filter.js";
import { buildMidTurnEnvelope } from "./mid-turn-envelope.js";

const SESSION_KEY = "agent:main:main";
const UUID = "3f8c1e2a-0b44-4c9e-9a11-77d2f0e5b6c3";

const base = {
	runId: "run-1",
	agentId: "main",
	sessionKey: SESSION_KEY,
	piEvent: { type: "mid_turn_compaction_start", messagesBefore: 40, tokensBefore: 90_000 },
};

test("the frame is tagged with the ROUTING key, not the transcript UUID", () => {
	const env = buildMidTurnEnvelope(base);
	assert.equal(env.sessionId, SESSION_KEY);
	assert.notEqual(env.sessionId, UUID);
});

test("a depth-0 frame reaches the operator watching that session", () => {
	// The failure this locks down: with a UUID here the gateway dropped the
	// frame (rule 4 made the false session match authoritative) and, with no
	// parentSessionKey at depth 0, nothing rescued it. The operator got the
	// silent two-minute stall the feature exists to prevent.
	const env = buildMidTurnEnvelope(base);
	assert.equal(
		shouldDeliverFrame(new Set(["main"]), new Set([SESSION_KEY]), {
			agentId: env.agentId,
			sessionId: env.sessionId,
			...(env.parentSessionKey ? { parentSessionKey: env.parentSessionKey } : {}),
		}),
		true,
	);
});

test("a sub-agent's frame reaches the PARENT thread's watcher", () => {
	// A child compacting its own context is still the operator's stall and the
	// operator's spend.
	const env = buildMidTurnEnvelope({
		...base,
		agentId: "helper",
		sessionKey: "agent:helper:subagent:abc",
		parentSessionKey: SESSION_KEY,
		subagentDepth: 1,
	});
	assert.equal(env.subagentDepth, 1);
	assert.equal(
		shouldDeliverFrame(new Set(["main"]), new Set([SESSION_KEY]), {
			agentId: env.agentId,
			sessionId: env.sessionId,
			parentSessionKey: env.parentSessionKey,
		}),
		true,
	);
});

test("it is marked synthetic, so the bus forwards it and replay does not", () => {
	// Depth-0 Pi frames go out via `attachTurnSession`'s direct subscribe, which
	// by definition never sees an event Pi did not emit. The bus forwarder skips
	// depth-0 frames to avoid duplicating that path — except synthetic ones. Drop
	// this flag and a top-level compaction falls between the two and vanishes.
	assert.equal(buildMidTurnEnvelope(base).synthetic, true);
});

test("depth and parent are omitted rather than sent as zero/undefined", () => {
	// `subagentDepth: 0` reads as "a sub-agent at depth 0" to the TUI's indent
	// logic; absence is the correct signal for a top-level turn.
	const env = buildMidTurnEnvelope({ ...base, subagentDepth: 0 });
	assert.equal("subagentDepth" in env, false);
	assert.equal("parentSessionKey" in env, false);
});

test("the pi event rides through untouched", () => {
	const piEvent = { type: "mid_turn_compaction_end", applied: true, freedTokens: 91_000 };
	assert.deepEqual(buildMidTurnEnvelope({ ...base, piEvent }).piEvent, piEvent);
	assert.equal(buildMidTurnEnvelope(base).type, "pi");
});
