import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runMemoryMaintenance } from "./maintenance.js";
import { FactStore } from "./records.js";

/**
 * The idle-gateway driver calls this per workspace on a wall-clock cadence. It must run the
 * cheap decay-GC + curator sweep without throwing and without destroying fresh facts — the
 * decay/curator EFFECTS themselves are covered by decay.test.ts / dream.test.ts; this proves
 * the composition + the per-stage error isolation the driver relies on.
 */
describe("runMemoryMaintenance — idle-gateway cheap sweep", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-maint-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("runs decay-GC + curator on a populated workspace, no throw, no stage error", () => {
		const store = new FactStore(dir);
		store.write({ content: "I keep a strict vegetarian diet.", segment: "preference" });
		store.write({ content: "I live in Hyderabad, India.", segment: "identity" });

		const stageErrors: string[] = [];
		let contradictionCalls = 0;
		assert.doesNotThrow(() =>
			runMemoryMaintenance(
				dir,
				(stage) => stageErrors.push(stage),
				() => {
					contradictionCalls += 1;
				},
			),
		);
		assert.deepEqual(stageErrors, [], "no stage (decay-gc / curator / contradictions) errored");
		assert.equal(contradictionCalls, 0, "two unrelated facts produce no contradiction to surface");

		// Fresh facts survive the sweep (decay archives only decayed facts; nothing here is stale).
		const active = new FactStore(dir).list();
		assert.equal(active.length, 2, "both fresh facts remain active after the sweep");
	});

	it("is a safe no-op on an empty workspace (no facts file yet)", () => {
		const stageErrors: string[] = [];
		assert.doesNotThrow(() => runMemoryMaintenance(dir, (stage) => stageErrors.push(stage)));
		assert.deepEqual(stageErrors, [], "empty workspace sweep is clean");
	});
});
