/**
 * The deferral must be a ONE-SHOT. A request that survived its turn would
 * compact every turn afterwards — expensive, and destructive, because each
 * pass summarises a summary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	consumeForcedCompaction,
	hasForcedCompaction,
	requestForcedCompaction,
	resetForcedCompactionForTest,
} from "./force-request.js";

test("a request is honoured exactly once", () => {
	resetForcedCompactionForTest();
	requestForcedCompaction("agent:main:t-1");
	assert.equal(consumeForcedCompaction("agent:main:t-1"), true, "the next turn compacts");
	assert.equal(consumeForcedCompaction("agent:main:t-1"), false, "and no turn after it does");
});

test("an unasked session never compacts", () => {
	resetForcedCompactionForTest();
	assert.equal(consumeForcedCompaction("agent:main:t-1"), false);
});

test("requests are per session, not global", () => {
	// The operator compacted ONE thread; the others must be untouched.
	resetForcedCompactionForTest();
	requestForcedCompaction("agent:main:t-1");
	assert.equal(consumeForcedCompaction("agent:main:t-2"), false);
	assert.equal(consumeForcedCompaction("agent:main:t-1"), true);
});

test("asking twice still compacts once", () => {
	resetForcedCompactionForTest();
	requestForcedCompaction("agent:main:t-1");
	requestForcedCompaction("agent:main:t-1");
	assert.equal(consumeForcedCompaction("agent:main:t-1"), true);
	assert.equal(consumeForcedCompaction("agent:main:t-1"), false);
});

test("hasForcedCompaction does not consume", () => {
	resetForcedCompactionForTest();
	requestForcedCompaction("agent:main:t-1");
	assert.equal(hasForcedCompaction("agent:main:t-1"), true);
	assert.equal(hasForcedCompaction("agent:main:t-1"), true);
	assert.equal(consumeForcedCompaction("agent:main:t-1"), true);
});

test("outstanding requests are bounded, newest kept", () => {
	// An unconsumed request is the normal outcome for an abandoned thread, so a
	// long-lived gateway must not accumulate them without limit.
	resetForcedCompactionForTest();
	for (let i = 0; i < 300; i += 1) requestForcedCompaction(`agent:main:t-${i}`);
	assert.equal(consumeForcedCompaction("agent:main:t-299"), true, "the most recent ask survives");
	assert.equal(consumeForcedCompaction("agent:main:t-0"), false, "the oldest was evicted");
});

test("a missing session key is ignored, never stored", () => {
	resetForcedCompactionForTest();
	assert.doesNotThrow(() => requestForcedCompaction(undefined));
	assert.equal(consumeForcedCompaction(undefined), false);
});
