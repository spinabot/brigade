/**
 * Pricing a Brigade-owned model call.
 *
 * Memory sweeps, skill distillations and compaction summarizations all run on
 * their own isolated session, invisible to the main session's usage stream. Pi
 * meters that session all along; the numbers were simply never read, so every
 * one of those calls was recorded as spend that could not be priced — which
 * degrades the operator's whole session total to `≥$X`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveIsolatedUsage } from "./extract.js";

test("a priced call is reported as known", () => {
	const u = deriveIsolatedUsage({
		tokens: { input: 170_000, output: 8_000, cacheRead: 12, cacheWrite: 3 },
		cost: 1.89,
	});
	assert.equal(u?.costKnown, true);
	assert.equal(u?.cost, 1.89);
	assert.equal(u?.input, 170_000);
	assert.equal(u?.cacheRead, 12);
});

test("zero cost on a real call is UNKNOWN, not free", () => {
	// The distinction the whole ledger rests on. A provider that returned no
	// pricing and a genuinely free call both arrive as `cost: 0`; reporting the
	// first as free is how a total ends up confidently short.
	const u = deriveIsolatedUsage({ tokens: { input: 90_000, output: 4_000 }, cost: 0 });
	assert.equal(u?.costKnown, false, "tokens were spent, so zero cannot be believed");
});

test("a call that spent nothing is genuinely free", () => {
	const u = deriveIsolatedUsage({ tokens: { input: 0, output: 0 }, cost: 0 });
	assert.equal(u?.costKnown, true);
});

test("a missing or non-finite cost is treated as unknown, never as free", () => {
	for (const cost of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		const u = deriveIsolatedUsage({ tokens: { input: 100, output: 10 }, cost: cost as number });
		assert.equal(u?.costKnown, false, `cost ${String(cost)}`);
		assert.equal(u?.cost, 0, "and never propagates a NaN into a dollar total");
	}
});

test("absent token accounting yields nothing rather than a zeroed record", () => {
	// Recording zeros would silently claim the call was free.
	assert.equal(deriveIsolatedUsage({}), undefined);
	assert.equal(deriveIsolatedUsage({ cost: 5 }), undefined);
});

test("missing sub-fields default to zero without breaking the record", () => {
	const u = deriveIsolatedUsage({ tokens: { input: 10 }, cost: 0.5 });
	assert.equal(u?.output, 0);
	assert.equal(u?.cacheWrite, 0);
	assert.equal(u?.costKnown, true);
});
