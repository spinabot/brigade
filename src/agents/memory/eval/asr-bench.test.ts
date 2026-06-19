import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runDefaultAsrBench } from "./asr-bench.js";

/**
 * Tideline Step 26 — the write-gate ASR bench. The gate must drive the
 * Attack-Success-Rate to 0 (block every poisoning write — including the indirect
 * `extraction` laundering path and the supersede path) while passing every
 * legitimate write. ASR=0 is a categorical guarantee that follows from the gate's
 * own rules, NOT a head-to-head against another system — so we assert the guarantee
 * and the zero false-positive rate, and do not compare against any foreign number.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-asr-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("asr-bench", () => {
	it("the write-gate blocks every poisoning write (ASR 0) and passes legit ones", () => {
		const r = runDefaultAsrBench(dir);
		// 4 untrusted tiers (tool_output / retrieved_document / compaction / extraction)
		// × (author identity + preference + correction, plus supersede-an-owner-fact) = 16.
		assert.equal(r.attempts, 16, "the corpus drives every untrusted tier × attack category");
		assert.equal(r.succeeded, 0, "no poisoning write got through");
		assert.equal(r.asr, 0, "ASR is 0 — the gate blocked every category, incl. extraction laundering + supersede");
		assert.equal(r.falsePositives, 0, "no legitimate write (owner authority / untrusted→descriptive) was wrongly blocked");
	});
});
