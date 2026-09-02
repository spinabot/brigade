import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { UsageLedger } from "./ledger.js";
import { sessionStatsFromMessages } from "./transcript-stats.js";

const assistant = (u: Record<string, unknown>) => ({ role: "assistant", usage: u });

describe("sessionStatsFromMessages", () => {
	it("folds assistant usage into totals, cost included", () => {
		const s = sessionStatsFromMessages([
			{ role: "user", content: "hi" },
			assistant({ input: 2, output: 144, cacheRead: 8960, cacheWrite: 42037, cost: { total: 0.42846 } }),
			assistant({ input: 2, output: 232, cacheRead: 8960, cacheWrite: 42197, cost: { total: 0.43226 } }),
		]);
		assert.equal(s.assistantMessages, 2);
		assert.deepEqual(s.tokens, { input: 4, output: 376, cacheRead: 17920, cacheWrite: 84234 });
		assert.ok(Math.abs(s.cost - 0.86072) < 1e-9);
	});

	it("counts cache tokens — they are most of a real thread's spend", () => {
		// A fold that only summed input+output would report ~0.1% of the truth on
		// a cached conversation, which is the number an operator would then see.
		const s = sessionStatsFromMessages([
			assistant({ input: 2, output: 10, cacheRead: 98560, cacheWrite: 457294 }),
		]);
		assert.equal(s.tokens.cacheRead + s.tokens.cacheWrite, 555854);
	});

	it("accepts a bare numeric cost from older transcripts", () => {
		assert.equal(sessionStatsFromMessages([assistant({ cost: 1.5 })]).cost, 1.5);
	});

	it("ignores everything that is not assistant usage", () => {
		const s = sessionStatsFromMessages([
			null,
			"nonsense",
			{ role: "user", usage: { output: 999 } },
			{ role: "assistant" },
			{ role: "assistant", usage: "not-an-object" },
			assistant({ output: 5 }),
		]);
		assert.equal(s.assistantMessages, 1);
		assert.equal(s.tokens.output, 5);
	});

	it("treats negative and non-finite values as zero", () => {
		// A malformed row must not be able to drive a total backwards.
		const s = sessionStatsFromMessages([
			assistant({ input: -50, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cost: { total: -3 } }),
		]);
		assert.deepEqual(s.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(s.cost, 0);
	});
});

describe("ledger seeding from a transcript", () => {
	it("restores a session's spend after a restart, before any turn runs", () => {
		const ledger = new UsageLedger();
		assert.equal(ledger.hasSeeded("main", "s1"), false);
		// What the gateway sees on a cold start: totals are zero.
		assert.equal(ledger.displayTotals("main", "s1").output, 0);

		ledger.seedFromStats(
			"main",
			"s1",
			sessionStatsFromMessages([
				assistant({ input: 2, output: 673, cacheRead: 98560, cacheWrite: 457294, cost: { total: 4.6392 } }),
			]),
		);

		const t = ledger.displayTotals("main", "s1");
		assert.equal(t.output, 673);
		assert.equal(t.cacheRead + t.cacheWrite, 555854);
		assert.ok(Math.abs(t.costUsd - 4.6392) < 1e-9);
		assert.equal(ledger.hasSeeded("main", "s1"), true);
	});

	it("a later seed cannot erase turns recorded since the first one", () => {
		// THE INVARIANT THAT ACTUALLY MATTERS.
		//
		// `resume` and turn-attach both seed, and `seedFromStats` ASSIGNS the
		// committed bucket rather than adding to it. So a second seed landing
		// after live turns have been recorded would reset the session's spend
		// back to its on-disk history and silently discard everything since —
		// on a long-running gateway, that is an operator watching the bill go
		// DOWN mid-session. Re-seeding with identical stats proves nothing here,
		// because assignment is naturally idempotent; the guard only earns its
		// keep once the bucket has moved on.
		const ledger = new UsageLedger();
		const stats = sessionStatsFromMessages([assistant({ output: 100, cost: { total: 1 } })]);
		ledger.seedFromStats("main", "s1", stats);

		ledger.beginTurn("main", "s1");
		ledger.commitTurn("main", "s1", { output: 50, cost: { total: 0.5 } } as never);
		assert.equal(ledger.displayTotals("main", "s1").output, 150, "turn recorded on top of history");

		// A reconnect seeds again — the transcript has not caught up yet.
		ledger.seedFromStats("main", "s1", stats);
		assert.equal(ledger.displayTotals("main", "s1").output, 150, "the turn survives the re-seed");
	});

	it("hasSeeded is per session, so one thread does not mask another", () => {
		const ledger = new UsageLedger();
		ledger.seedFromStats("main", "s1", sessionStatsFromMessages([assistant({ output: 1 })]));
		assert.equal(ledger.hasSeeded("main", "s1"), true);
		assert.equal(ledger.hasSeeded("main", "s2"), false);
		assert.equal(ledger.hasSeeded("other", "s1"), false);
	});
});
