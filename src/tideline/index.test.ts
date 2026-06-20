import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Import THROUGH the package barrels (not the in-tree modules) — this asserts the
// public `brigade-tideline` surface is wired + resolves, the extraction's contract.
import { FactStore, Tideline, WriteGateError, type StorageAdapter, type ThreatScanAdapter } from "./index.js";
import { buildGraph, MemoryEventLog, proposeFromTelemetry, runDream } from "./advanced.js";
import { hybridRecallCapability, RICH_GOLD, runRecallEval, seedGold } from "./eval.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-tideline-pkg-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("brigade-tideline package surface", () => {
	it("facade: open → add → recall → context → inspect → feedback → export", () => {
		const memory = Tideline.open(dir);
		const rec = memory.add({ content: "I keep a strict vegetarian diet.", segment: "preference" });
		assert.ok(rec.memoryId, "add returns a persisted record");

		// Query shares lexical terms with the fact (model-free recall is BM25-primary;
		// this smoke test checks package WIRING, not synonymy bridging).
		const hits = memory.recall("vegetarian diet");
		assert.equal(hits.length, 1, "recall surfaces exactly the one seeded fact");
		assert.equal(hits[0]?.content, "I keep a strict vegetarian diet.", "recalled content matches seeded text exactly");

		const block = memory.context("vegetarian diet", { maxChars: 400 });
		assert.equal(block, "- [preference] I keep a strict vegetarian diet.", "context renders the exact segment-prefixed prompt line");

		const inspected = memory.inspect(rec.memoryId);
		assert.equal(inspected?.record.memoryId, rec.memoryId, "inspect returns the record + its graph neighbourhood");

		memory.feedback(rec.memoryId, "up");
		assert.equal(memory.export().length, 1, "export dumps the store");
		assert.equal(memory.list().length, 1, "list returns active facts");
	});

	it("SPI: a wired ThreatScanAdapter replaces a flagged fact in context() with [BLOCKED]", () => {
		// The scan adapter (not the content) decides — a unique benign marker keeps the
		// fact writable, so this isolates the recall-time SPI wiring from any write path.
		const scan: ThreatScanAdapter = { scan: (c) => (c.includes("alpha-zulu") ? ["test-marker"] : []) };
		const memory = Tideline.open(dir, { threatScan: scan });
		memory.add({ content: "Project Apollo ships on Friday.", segment: "project" });
		memory.add({ content: "Project Apollo memo alpha-zulu detail.", segment: "project" });
		const block = memory.context("Project Apollo") ?? "";
		assert.equal(
			block,
			"- [project] Project Apollo ships on Friday.\n- [project] [BLOCKED] this project fact matched threat pattern(s): test-marker — omitted from context",
			"clean fact surfaces verbatim; flagged fact is substituted with the exact [BLOCKED] placeholder line",
		);
	});

	it("SPI: Tideline.over wraps an injected StorageAdapter", () => {
		const store: StorageAdapter = new FactStore(dir);
		const memory = Tideline.over(store);
		memory.add({ content: "I live in Lisbon.", segment: "identity" });
		assert.equal(memory.recall("where do I live").length, 1, "recall returns exactly the one seeded fact over an injected store");
	});

	it("eval entry: seed a gold set + score the production hybrid capability", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, RICH_GOLD);
		const result = await runRecallEval(hybridRecallCapability(store), cases, { k: 3, clock: () => 0 });
		assert.equal(result.recallAtK, 1, "hybrid recall@3 on lexically-matched RICH_GOLD cases is 1.0");
		assert.equal(result.mrr, 1, "hybrid MRR on lexically-matched RICH_GOLD cases is 1.0");
		assert.equal(result.abstentionViolations, 0, "hybrid abstains on the no-answer cases");
	});

	it("advanced entry: lifecycle pass + graph + event-log + self-improve resolve and run", () => {
		const store = new FactStore(dir);
		store.write({ content: "I deploy on Friday.", segment: "preference" });
		store.write({ content: "I deploy on Friday afternoons.", segment: "preference" });
		// runDream (lifecycle pass) runs through the sub-entry and returns the result shape.
		const dreamed = runDream(store, { now: 0 });
		assert.equal(dreamed.reflected, 2, "runDream examines exactly the two seeded active facts");
		assert.equal(dreamed.related, 0, "no synonymy relates-edges written for these two facts at the default HRR threshold");
		// buildGraph composes over the records.
		const graph = buildGraph(store.list());
		assert.equal(graph.byId.size, 2, "buildGraph indexes all two active records by id");
		// the transparency log + the self-improve proposer are constructable/callable.
		assert.ok(typeof MemoryEventLog === "function", "MemoryEventLog is exported");
		assert.equal(proposeFromTelemetry([]).length, 0, "proposeFromTelemetry returns an empty array for empty telemetry");
		// WriteGateError (main entry) is the error a blocked write throws.
		assert.ok(WriteGateError.prototype instanceof Error, "WriteGateError is an Error subclass on the main entry");
	});
});
