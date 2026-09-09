import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";

describe("FactStore — out-of-band drift guard", () => {
	let dir: string;
	let factsFile: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-drift-"));
		factsFile = path.join(dir, "memory", "facts.jsonl");
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	function baks(): string[] {
		try {
			return fs.readdirSync(path.join(dir, "memory")).filter((f) => f.startsWith("facts.jsonl.bak-"));
		} catch {
			return [];
		}
	}

	it("snapshots to .bak when a write would otherwise drop unparseable lines", () => {
		const store = new FactStore(dir);
		store.write({ content: "first fact", segment: "knowledge" });
		// Out-of-band corruption: a hand-edit / torn write appends a non-JSON line.
		fs.appendFileSync(factsFile, "this is not valid json at all\n");
		assert.equal(baks().length, 0, "no .bak before the next write");

		// The next write reads (skipping the corrupt line) then rewrites — it must
		// snapshot the on-disk file FIRST so the unparseable content isn't lost.
		store.write({ content: "second fact", segment: "knowledge" });

		const b = baks();
		assert.equal(b.length, 1, "exactly one .bak snapshot was created");
		const bakContent = fs.readFileSync(path.join(dir, "memory", b[0]!), "utf8");
		assert.match(bakContent, /not valid json/, "the corrupt content is preserved in the .bak");

		// The live file holds only valid records (both writes), corrupt line dropped.
		const live = fs.readFileSync(factsFile, "utf8");
		assert.ok(!live.includes("not valid json"), "corrupt line removed from the live file");
		assert.match(live, /first fact/);
		assert.match(live, /second fact/);
	});

	it("does NOT snapshot when the file is clean", () => {
		const store = new FactStore(dir);
		store.write({ content: "a", segment: "knowledge" });
		store.write({ content: "b", segment: "knowledge" });
		store.write({ content: "c", segment: "knowledge" });
		assert.equal(baks().length, 0, "no spurious .bak for clean writes");
	});
});
