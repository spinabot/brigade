/**
 * What the JSONL audit trail keeps.
 *
 * This log is what an operator reconciles a bill against, and what gets read
 * back to explain a stall. Compaction events were falling through to the
 * base-fields default: a summarization that freed 90k tokens and cost real
 * money was recorded as nothing but its own name.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeForLog } from "./event-logger.js";

test("a mid-turn compaction records what it did, cost and freed", () => {
	const row = serializeForLog({
		type: "mid_turn_compaction_end",
		applied: true,
		reason: "applied",
		tokensBefore: 180_000,
		tokensAfter: 90_000,
		freedTokens: 90_000,
		messagesBefore: 300,
		messagesAfter: 40,
		durationMs: 107_000,
		usage: { input: 170_000, output: 8_000, cacheRead: 0, cacheWrite: 0, cost: 1.89, costKnown: true },
	} as never);

	assert.equal(row.applied, true);
	assert.equal(row.reason, "applied");
	assert.equal(row.freedTokens, 90_000);
	assert.equal(row.durationMs, 107_000);
	assert.deepEqual((row.usage as { cost?: number })?.cost, 1.89);
});

test("a FAILED mid-turn compaction records why", () => {
	// Without the reason, a turn that silently continued at full size is
	// indistinguishable in the log from one that compacted cleanly.
	const row = serializeForLog({
		type: "mid_turn_compaction_end",
		applied: false,
		reason: "timeout",
		tokensBefore: 180_000,
		tokensAfter: 180_000,
		freedTokens: 0,
		messagesBefore: 300,
		messagesAfter: 300,
		errorMessage: "provider stalled",
	} as never);
	assert.equal(row.applied, false);
	assert.equal(row.reason, "timeout");
	assert.equal(row.errorMessage, "provider stalled");
});

test("a mid-turn compaction START records the pressure that triggered it", () => {
	const row = serializeForLog({
		type: "mid_turn_compaction_start",
		messagesBefore: 300,
		tokensBefore: 180_000,
	} as never);
	assert.equal(row.messagesBefore, 300);
	assert.equal(row.tokensBefore, 180_000);
});

test("a between-turn compaction records its measured outcome", () => {
	// `outcome` is Brigade's own before/after measurement. Dropping it is how a
	// compaction that reclaimed nothing looked identical to one that worked.
	const row = serializeForLog({
		type: "compaction_end",
		aborted: false,
		result: { tokensBefore: 100 },
		outcome: { tokensBefore: 100, tokensAfter: 20, freedTokens: 80, messagesBefore: 50, messagesAfter: 5, madeProgress: true },
	} as never);
	assert.equal((row.outcome as { freedTokens?: number })?.freedTokens, 80);
	assert.equal((row.outcome as { madeProgress?: boolean })?.madeProgress, true);
});

test("every row carries the event type", () => {
	for (const type of ["turn_start", "mid_turn_compaction_end", "compaction_end"]) {
		assert.equal(serializeForLog({ type } as never).type, type);
	}
});
