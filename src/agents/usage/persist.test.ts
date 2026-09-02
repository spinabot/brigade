import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { upsertSessionEntry } from "../../sessions/session-store.js";
import { UsageLedger } from "./ledger.js";
import { persistSessionUsage, readPersistedSessionUsage } from "./persist.js";

const realHome = process.env.HOME;
const realState = process.env.BRIGADE_STATE_DIR;
function isolate(...sessionKeys: string[]): void {
	const d = mkdtempSync(path.join(os.tmpdir(), "brigade-usage-"));
	process.env.HOME = d;
	process.env.BRIGADE_STATE_DIR = d;
	// `updateSessionEntry` deliberately refuses to CREATE an entry — persisting
	// usage for a session the store has never heard of would invent a row. In
	// production the entry exists long before the first `turn_end`, so the test
	// has to establish it too.
	for (const k of sessionKeys) upsertSessionEntry("main", k, { sessionId: `sid-${k}` });
}
afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = realState;
});

describe("persisted session usage", () => {
	it("round-trips the totals a restart would otherwise lose", () => {
		isolate("agent:main:main");
		persistSessionUsage(
			"main",
			"agent:main:main",
			{ input: 22, output: 673, cacheRead: 98560, cacheWrite: 457294, costUsd: 4.6392, costComplete: true },
			11,
		);
		const back = readPersistedSessionUsage("main", "agent:main:main");
		assert.ok(back);
		assert.equal(back.output, 673);
		assert.equal(back.cacheRead + back.cacheWrite, 555854);
		assert.ok(Math.abs(back.costUsd - 4.6392) < 1e-9);
		assert.equal(back.turns, 11);
	});

	it("preserves costComplete=false — a floor must not become a fact", () => {
		// The failure this guards: a session whose turns came back unpriced
		// rendered `≥$12.00`, and inferring completeness from `cost > 0` turned
		// it into a confident `$12.00`. Measured on a real transcript: 169 of 207
		// assistant turns unpriced.
		isolate("s1");
		persistSessionUsage(
			"main",
			"s1",
			{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 12, costComplete: false },
			3,
		);
		assert.equal(readPersistedSessionUsage("main", "s1")?.costComplete, false);
	});

	it("reports absent rather than zero when nothing was ever written", () => {
		// THE DISTINCTION THAT MATTERS. Seeding a session with zeros marks it
		// seeded, which permanently suppresses the turn-attach seed that has the
		// real history — so "never written" must never look like "genuinely zero".
		isolate();
		assert.equal(readPersistedSessionUsage("main", "never-seen"), undefined);
	});

	it("treats an all-zero record as absent for the same reason", () => {
		isolate("s2");
		persistSessionUsage(
			"main",
			"s2",
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costComplete: true },
			0,
		);
		assert.equal(readPersistedSessionUsage("main", "s2"), undefined);
	});

	it("keeps sessions separate", () => {
		isolate("a", "b");
		persistSessionUsage("main", "a", { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 1, costComplete: true }, 1);
		persistSessionUsage("main", "b", { input: 0, output: 9, cacheRead: 0, cacheWrite: 0, costUsd: 2, costComplete: true }, 1);
		assert.equal(readPersistedSessionUsage("main", "a")?.output, 5);
		assert.equal(readPersistedSessionUsage("main", "b")?.output, 9);
	});
});

describe("ledger seeding from a persisted record", () => {
	const rec = {
		input: 22, output: 673, cacheRead: 98560, cacheWrite: 457294,
		costUsd: 4.6392, costComplete: false, turns: 11,
	};

	it("restores spend before any turn runs", () => {
		const l = new UsageLedger();
		assert.equal(l.displayTotals("main", "s1").output, 0);
		l.seedFromPersisted("main", "s1", rec);
		const t = l.displayTotals("main", "s1");
		assert.equal(t.output, 673);
		assert.equal(t.cacheRead + t.cacheWrite, 555854);
		assert.equal(l.hasSeeded("main", "s1"), true);
	});

	it("restores costComplete as recorded, never inferred from cost > 0", () => {
		const l = new UsageLedger();
		l.seedFromPersisted("main", "s1", rec);
		assert.equal(l.displayTotals("main", "s1").costComplete, false, "a floor stays a floor");
	});

	it("a later seed cannot erase turns recorded since", () => {
		const l = new UsageLedger();
		l.seedFromPersisted("main", "s1", rec);
		l.beginTurn("main", "s1");
		l.commitTurn("main", "s1", { output: 50 } as never);
		assert.equal(l.displayTotals("main", "s1").output, 723);
		l.seedFromPersisted("main", "s1", rec);
		assert.equal(l.displayTotals("main", "s1").output, 723, "the turn survives");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// `outOfBandByKind` was populated from the day it was introduced and read by
// nothing, so the question its own doc comment poses — "where did the spend
// go" — had no answer on any surface. A turn that fanned out to sub-agents and
// triggered a compaction showed one total, with no way to see that most of it
// was not the conversation.
// ─────────────────────────────────────────────────────────────────────────
describe("usage breakdown", () => {
	it("separates the conversation from the work done on its behalf", () => {
		const l = new UsageLedger();
		l.beginTurn("main", "s");
		l.commitTurn("main", "s", { output: 100, cost: { total: 1 } } as never);
		l.recordOutOfBand("main", "s", "subagent", { output: 900, cost: { total: 9 } } as never);
		l.recordOutOfBand("main", "s", "compaction", { output: 50, cost: { total: 0.5 } } as never);

		const { own, byKind } = l.breakdown("main", "s");
		assert.equal(own.costUsd, 1, "the conversation itself");
		assert.equal(byKind.subagent?.costUsd, 9);
		assert.equal(byKind.compaction?.costUsd, 0.5);
	});

	it("reconciles: own + every kind equals the displayed total", () => {
		// If these ever disagree, one of the two surfaces is lying.
		const l = new UsageLedger();
		l.beginTurn("main", "s");
		l.commitTurn("main", "s", { output: 10, cost: { total: 2 } } as never);
		l.recordOutOfBand("main", "s", "memory", { output: 5, cost: { total: 3 } } as never);
		l.recordOutOfBand("main", "s", "skills", { output: 1, cost: { total: 4 } } as never);

		const { own, byKind } = l.breakdown("main", "s");
		const summed =
			own.costUsd + Object.values(byKind).reduce((a, t) => a + (t?.costUsd ?? 0), 0);
		assert.ok(Math.abs(summed - l.displayTotals("main", "s").costUsd) < 1e-9);
	});

	it("omits kinds that spent nothing, so a plain thread stays plain", () => {
		const l = new UsageLedger();
		l.beginTurn("main", "s");
		l.commitTurn("main", "s", { output: 10, cost: { total: 1 } } as never);
		assert.deepEqual(l.breakdown("main", "s").byKind, {});
	});

	it("reports empty for a session it has never seen", () => {
		const l = new UsageLedger();
		const { own, byKind } = l.breakdown("main", "never");
		assert.equal(own.costUsd, 0);
		assert.deepEqual(byKind, {});
	});

	it("rolls up across an agent's sessions — the only place cron spend shows", () => {
		// Cron bills to a fresh `cron:<job>:run:<uuid>` key per fire and
		// maintenance to `<agent>:__maintenance`; neither is a row any list
		// renders, so the agent rollup is where they become visible.
		const l = new UsageLedger();
		l.recordOutOfBand("main", "agent:main:main", "subagent", { cost: { total: 1 } } as never);
		l.recordOutOfBand("main", "cron:nightly:run:abc", "other", { cost: { total: 18 } } as never);
		const total = l.agentTotals("main");
		assert.ok(Math.abs(total.costUsd - 19) < 1e-9, "cron spend is in the agent total");
		assert.equal(l.forAgent("main").length, 2);
	});
});
