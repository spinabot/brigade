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
