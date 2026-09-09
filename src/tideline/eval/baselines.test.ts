import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../store/records.js";
import { linearScanCapability, oracleCapability } from "./capabilities.js";
import { SYNTHETIC_GOLD } from "./gold-synthetic.js";
import { seedGold } from "./gold.js";
import { runRecallEval } from "./harness.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-baselines-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("baselines over the synthetic gold", () => {
	it("the linear-scan floor produces real metrics and isn't trivially zero", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const floor = await runRecallEval(linearScanCapability(store), cases, { k: 10, clock: () => 0 });
		assert.equal(floor.nScored, 10, "scored the non-abstention cases (gold-set/bucketing drift fails loudly)");
		assert.ok(floor.recallAtK > 0, "the substring floor matches the distinct synthetic facts");
		assert.ok(floor.recallAtK <= 1);
	});

	it("the oracle is the recall ceiling — recall@k ≥ the linear floor", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const k = 10;
		const floor = await runRecallEval(linearScanCapability(store), cases, { k, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k, clock: () => 0 });
		// Precondition: the oracle returns ALL active (non-superseded) facts but is
		// capped at `k`. The ceiling (oracle recall ≥ floor) only holds while that
		// cap doesn't drop anything — i.e. the active fact count is ≤ k. Guard it
		// explicitly so a future gold-set that overflows `k` fails HERE (loudly,
		// with a clear reason) instead of silently making the ceiling assertion
		// brittle. `list()` defaults to lifecycle "active"; mirror the oracle's
		// OWN valid-time gate, which uses Date.now() (capabilities.ts) — the
		// injected `clock: () => 0` only affects harness latency timing, not the
		// search/oracle filter.
		const now = Date.now();
		const activeCount = store.list().filter((r) => r.validTo === undefined || r.validTo > now).length;
		assert.ok(
			activeCount <= k,
			`active (non-superseded) fact count ${activeCount} must be ≤ k=${k} for the oracle ceiling to hold`,
		);
		assert.ok(
			oracle.recallAtK >= floor.recallAtK - 1e-9,
			`oracle recall ${oracle.recallAtK} should be ≥ floor ${floor.recallAtK}`,
		);
	});

	it("honesty check: the oracle answers abstention queries WRONGLY; the floor abstains", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const floor = await runRecallEval(linearScanCapability(store), cases, { k: 10, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k: 10, clock: () => 0 });
		// the oracle returns everything → it violates EVERY abstention case (3 of them).
		assert.equal(oracle.abstentionViolations, 3, "oracle surfaces hits on every no-answer query (perfect recall, zero abstention)");
		// the floor matches only on query terms → it must abstain CLEANLY on the
		// no-answer queries. Assert the absolute (0), not floor ≤ oracle: with oracle
		// pinned at the max (3), `floor ≤ 3` is vacuously true for ANY floor — it
		// can't catch a floor that over-matches.
		assert.equal(floor.abstentionViolations, 0, "the substring floor surfaces no hit on the no-answer queries");
	});
});
