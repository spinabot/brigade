import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCostSegment, formatUsd } from "./format.js";

test("amounts show two decimals, not four", () => {
	// `$0.0342` implies a precision the pricing tables do not have.
	assert.equal(formatUsd(0.4231), "$0.42");
	assert.equal(formatUsd(16.239), "$16.24");
	assert.equal(formatUsd(0), "$0.00");
});

test("a tiny non-zero amount does not round away to nothing", () => {
	// `$0.00` on a turn that DID cost something reads as free.
	assert.equal(formatUsd(0.0004), "<$0.01");
});

test("the four zero-cost situations are distinguishable", () => {
	// All of these used to render as an identical `$0.0000`.
	assert.equal(formatCostSegment({ billing: "local", costUsd: 0 }), "local");
	assert.equal(formatCostSegment({ billing: "subscription", costUsd: 0 }), "on your plan");
	assert.equal(formatCostSegment({ billing: "unknown", costUsd: 0 }), "cost n/a");
	assert.equal(formatCostSegment({ billing: "metered", costUsd: 0 }), "$0.00");
});

test("an unpriced model never renders a confident zero", () => {
	// The dangerous case: the turn IS costing money and we cannot say how much.
	const seg = formatCostSegment({ billing: "unknown", costUsd: 0 });
	assert.doesNotMatch(seg!, /\$/);
});

test("an incomplete total is marked as a floor", () => {
	// Silently presenting a partial sum as the whole is how a $16 session reads
	// as $4 — sub-agents, compaction and memory sweeps were all unmetered.
	assert.equal(formatCostSegment({ billing: "metered", costUsd: 4, costComplete: false }), "≥$4.00");
	assert.equal(formatCostSegment({ billing: "metered", costUsd: 4, costComplete: true }), "$4.00");
});

test("an older gateway with no billing field keeps the previous behaviour", () => {
	assert.equal(formatCostSegment({ billing: undefined, costUsd: 0.42 }), "$0.42");
	assert.equal(formatCostSegment({ billing: undefined, costUsd: 0 }), undefined, "omitted rather than a bare zero");
});

test("an incomplete total NEVER renders as a confident zero", () => {
	// The exact bug this module exists to refuse. A metered session whose every
	// contribution arrived unpriced — a compaction Pi reports no usage for, a
	// sweep that timed out — has costUsd 0 AND costComplete false. Rendering
	// "$0.00" there is the "unmeasured reads as free" claim, stated confidently.
	//
	// Reachable on the first render of any session restored from a transcript
	// with no cost recorded, because `seedFromStats` sets `costComplete: cost > 0`.
	assert.equal(
		formatCostSegment({ costUsd: 0, billing: "metered", costComplete: false }),
		"cost n/a",
	);
});

test("an incomplete total with real spend renders as a floor", () => {
	assert.equal(
		formatCostSegment({ costUsd: 4.2, billing: "metered", costComplete: false }),
		"≥$4.20",
	);
});

test("a COMPLETE zero still renders as zero — genuinely free is not unknown", () => {
	// A local model really does cost nothing. Collapsing that into "cost n/a"
	// would be the opposite error.
	assert.equal(
		formatCostSegment({ costUsd: 0, billing: "metered", costComplete: true }),
		"$0.00",
	);
});
