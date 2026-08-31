import assert from "node:assert/strict";
import { test } from "node:test";

import { addTotals, emptyTotals, toTotals, UsageLedger } from "./ledger.js";

const A = "main";
const S = "agent:main:main";

test("totals are keyed per (agent, session) — no cross-agent bleed", () => {
	// The bug this replaces: three process-global scalars meant an idle agent's
	// header showed another agent's spend.
	const l = new UsageLedger();
	l.commitTurn("main", "agent:main:main", { input: 100, output: 10, cost: { total: 0.5 }, costKnown: true });
	l.commitTurn("ops", "agent:ops:main", { input: 7, output: 1, cost: { total: 0.01 }, costKnown: true });

	assert.equal(l.displayTotals("main", "agent:main:main").input, 100);
	assert.equal(l.displayTotals("ops", "agent:ops:main").input, 7);
	assert.equal(l.displayTotals("main", "agent:main:main").costUsd, 0.5);
});

test("two sessions of ONE agent are tracked separately and roll up", () => {
	const l = new UsageLedger();
	l.commitTurn(A, "agent:main:main", { input: 100, output: 10, cost: { total: 1 }, costKnown: true });
	l.commitTurn(A, "agent:main:thread:x", { input: 50, output: 5, cost: { total: 2 }, costKnown: true });

	assert.equal(l.displayTotals(A, "agent:main:main").input, 100);
	assert.equal(l.displayTotals(A, "agent:main:thread:x").input, 50);
	assert.equal(l.agentTotals(A).input, 150, "agent rollup sums its sessions");
	assert.equal(l.agentTotals(A).costUsd, 3);
	assert.equal(l.forAgent(A).length, 2);
});

test("in-flight usage REPLACES rather than accumulates", () => {
	// `partial.usage` is absolute for the streaming message — Pi mutates it in
	// place. Adding each observation would compound every delta into nonsense.
	const l = new UsageLedger();
	l.beginTurn(A, S);
	l.observePartial(A, S, { input: 1000, output: 5 });
	l.observePartial(A, S, { input: 1000, output: 40 });
	l.observePartial(A, S, { input: 1000, output: 120 });

	const d = l.displayTotals(A, S);
	assert.equal(d.output, 120, "the latest observation, not 5+40+120");
	assert.equal(d.input, 1000, "not 3000");
});

test("committing a turn clears in-flight so nothing is double counted", () => {
	const l = new UsageLedger();
	l.beginTurn(A, S);
	l.observePartial(A, S, { input: 1000, output: 120 });
	l.commitTurn(A, S, { input: 1000, output: 130, cost: { total: 0.02 }, costKnown: true });

	const d = l.displayTotals(A, S);
	assert.equal(d.output, 130, "final value only — the partial must not linger");
	assert.equal(d.input, 1000);
	assert.equal(l.peek(A, S)?.inFlight, null);
	assert.equal(l.peek(A, S)?.turns, 1);
});

test("usage is live DURING a turn, not only at the end", () => {
	// The user-visible complaint: a 90-second turn showed the previous turn's
	// number for 89 seconds, then jumped.
	const l = new UsageLedger();
	l.commitTurn(A, S, { input: 500, output: 50, cost: { total: 0.01 }, costKnown: true });
	const beforeTurn = l.displayTotals(A, S).totalTokens;

	l.beginTurn(A, S);
	l.observePartial(A, S, { input: 4700, output: 12 });
	const midTurn = l.displayTotals(A, S).totalTokens;

	assert.ok(midTurn > beforeTurn, "the number must move before turn_end");
	assert.equal(midTurn, 550 + 4712);
});

test("a turn aborted mid-stream drops its in-flight tokens on the next begin", () => {
	const l = new UsageLedger();
	l.beginTurn(A, S);
	l.observePartial(A, S, { input: 900, output: 30 });
	l.beginTurn(A, S); // aborted, new turn starts
	assert.equal(l.displayTotals(A, S).totalTokens, 0, "stale in-flight must not persist");
});

test("out-of-band spend is attributed, with a per-source breakdown", () => {
	// Sub-agents, compaction and memory sweeps were free by construction: the
	// meter only watched the top-level turn's events.
	const l = new UsageLedger();
	l.commitTurn(A, S, { input: 1000, output: 100, cost: { total: 4 }, costKnown: true });
	l.recordOutOfBand(A, S, "subagent", { input: 50_000, output: 2000, cost: { total: 9 }, costKnown: true });
	l.recordOutOfBand(A, S, "compaction", { input: 170_000, output: 8000, cost: { total: 1.89 }, costKnown: true });
	l.recordOutOfBand(A, S, "memory", { input: 9000, output: 400, cost: { total: 1.35 }, costKnown: true });

	const d = l.displayTotals(A, S);
	assert.equal(Number(d.costUsd.toFixed(2)), 16.24, "the real bill, not just the parent turn");
	const e = l.peek(A, S)!;
	assert.equal(e.outOfBandByKind.subagent?.costUsd, 9);
	assert.equal(e.outOfBandByKind.compaction?.costUsd, 1.89);
	assert.equal(e.outOfBandByKind.memory?.costUsd, 1.35);
	assert.equal(e.committed.costUsd, 4, "the parent turn alone would have shown $4.00");
});

test("seeding from transcript stats survives a restart, and only applies once", () => {
	const l = new UsageLedger();
	const stats = { tokens: { input: 900, output: 90, cacheRead: 10, cacheWrite: 0 }, cost: 12, assistantMessages: 23 };
	l.seedFromStats(A, S, stats);
	l.seedFromStats(A, S, stats); // a re-attach must not double history

	const d = l.displayTotals(A, S);
	assert.equal(d.input, 900);
	assert.equal(d.costUsd, 12);
	assert.equal(d.totalTokens, 1000);
	assert.equal(l.peek(A, S)?.turns, 23);
});

test("seeding after activity does not clobber it", () => {
	const l = new UsageLedger();
	l.seedFromStats(A, S, { tokens: { input: 100 }, cost: 1 });
	l.commitTurn(A, S, { input: 10, output: 1, cost: { total: 0.5 }, costKnown: true });
	l.seedFromStats(A, S, { tokens: { input: 999_999 }, cost: 999 });
	assert.equal(l.displayTotals(A, S).input, 110, "the second seed is ignored");
});

test("an unpriced contribution marks the total incomplete rather than free", () => {
	// A silent zero must never masquerade as a measured $0. Otherwise an
	// unmeasured turn reads as a free one.
	const l = new UsageLedger();
	l.commitTurn(A, S, { input: 10, output: 1, cost: { total: 0.5 }, costKnown: true });
	assert.equal(l.displayTotals(A, S).costComplete, true);

	l.commitTurn(A, S, { input: 10, output: 1 }); // no cost signal at all
	const d = l.displayTotals(A, S);
	assert.equal(d.costComplete, false, "the total is now a floor, not the truth");
	assert.equal(d.costUsd, 0.5, "and it is still the floor we do know");
});

test("costKnown:true with a genuine zero stays complete", () => {
	// A subscription turn really is $0 at the margin — that is measured, not
	// missing, and must not taint the session's completeness.
	const l = new UsageLedger();
	l.commitTurn(A, S, { input: 10, output: 1, cost: { total: 0 }, costKnown: true });
	assert.equal(l.displayTotals(A, S).costComplete, true);
});

test("totalTokens is recomputed from the legs, never inherited", () => {
	// Transports populate `totalTokens` with different conventions; inheriting
	// them would make the ledger unauditable.
	const t = toTotals({ input: 5, output: 2, cacheRead: 3, cacheWrite: 1 });
	assert.equal(t.totalTokens, 11);
});

test("negative and non-finite values are floored to zero", () => {
	// Guards pi-ai's `-1` price sentinels and any NaN leaking from a transport.
	const t = toTotals({ input: -1_000_000, output: Number.NaN, cacheRead: Infinity, cost: { total: -5 } });
	assert.deepEqual([t.input, t.output, t.cacheRead, t.costUsd], [0, 0, 0, 0]);
});

test("eviction removes the least recently USED session, not the oldest created", () => {
	// The gateway's seq counters evict in creation order because Map.set does not
	// reorder an existing key — which evicts the busiest session first. This
	// ledger must not repeat that.
	const l = new UsageLedger(2);
	l.commitTurn(A, "s1", { input: 1 });
	l.commitTurn(A, "s2", { input: 1 });
	l.commitTurn(A, "s1", { input: 1 }); // s1 is now the most recently used
	l.commitTurn(A, "s3", { input: 1 }); // forces an eviction

	assert.equal(l.size, 2);
	assert.ok(l.peek(A, "s1"), "the busy session survives");
	assert.ok(l.peek(A, "s3"));
	assert.equal(l.peek(A, "s2"), undefined, "the coldest session is the one evicted");
});

test("unknown sessions read as zero rather than undefined", () => {
	const l = new UsageLedger();
	assert.deepEqual(l.displayTotals("nobody", "nothing"), emptyTotals());
});

test("addTotals treats completeness conjunctively", () => {
	const known = { ...emptyTotals(), costUsd: 1, costComplete: true };
	const unknown = { ...emptyTotals(), costComplete: false };
	assert.equal(addTotals(known, unknown).costComplete, false);
	assert.equal(addTotals(known, known).costComplete, true);
});

test("sub-agent spend billed to the ROOT thread reaches the operator's header", () => {
	// The header reads displayTotals(parentAgent, parentSession). Billing a child
	// to its OWN session put the spend on a ledger entry nobody looks at, so a
	// parent turn that fanned out five children was still free on screen.
	const l = new UsageLedger();
	l.commitTurn("main", "agent:main:main", { input: 1000, output: 100, cost: { total: 4 }, costKnown: true });
	// Two children and a grandchild, all resolved to the operator's thread.
	l.recordOutOfBand("main", "agent:main:main", "subagent", { input: 20_000, cost: { total: 3 }, costKnown: true });
	l.recordOutOfBand("main", "agent:main:main", "subagent", { input: 20_000, cost: { total: 3 }, costKnown: true });
	l.recordOutOfBand("main", "agent:main:main", "subagent", { input: 20_000, cost: { total: 3 }, costKnown: true });

	const shown = l.displayTotals("main", "agent:main:main");
	assert.equal(shown.costUsd, 13, "the operator sees the real bill, not just the parent turn");
	assert.equal(l.peek("main", "agent:main:main")!.committed.costUsd, 4, "the parent turn alone was $4");
	assert.equal(l.peek("main", "agent:main:main")!.outOfBandByKind.subagent?.costUsd, 9);
});
