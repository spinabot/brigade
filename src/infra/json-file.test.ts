/**
 * Guard suite for `atomicTempPath` + `saveJsonFile`.
 *
 * Pins the invariants the shared helper exists for: temp paths for one
 * target never collide (pid + timestamp + sequence), every path is rooted at
 * its target with the `.tmp-` marker nothing reads, and `saveJsonFile`
 * renames every temp away — no strays, last writer wins.
 *
 * Assertions read directories instead of probing single paths, so nothing
 * here is a check-then-act pair on a file it later touches.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { atomicTempPath, loadJsonFile, saveJsonFile } from "./json-file.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "brigade-json-file-"));
});

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe("atomicTempPath", () => {
	it("never collides across a same-process burst against one target", () => {
		const target = join(dir, "store.json");
		const paths = new Set(Array.from({ length: 5_000 }, () => atomicTempPath(target)));
		assert.equal(paths.size, 5_000, "5000 rapid temp paths for one target must all be distinct");
	});

	it("roots every temp path at its target, marks it .tmp-, and embeds the pid", () => {
		const target = join(dir, "store.json");
		const tmp = atomicTempPath(target);
		assert.ok(
			tmp.startsWith(`${target}.tmp-${process.pid}-`),
			`expected ${tmp} to start with ${target}.tmp-${process.pid}-`,
		);
	});

	it("keeps different targets apart", () => {
		assert.notEqual(atomicTempPath(join(dir, "a.json")), atomicTempPath(join(dir, "b.json")));
	});
});

describe("saveJsonFile", () => {
	it("round-trips JSON and leaves no temp files behind", () => {
		const p = join(dir, "nested", "state.json");
		saveJsonFile(p, { hello: "world", n: 42 });
		assert.deepEqual(loadJsonFile(p), { hello: "world", n: 42 });
		assert.deepEqual(
			readdirSync(join(dir, "nested")).filter((n) => n.includes(".tmp-")),
			[],
		);
	});

	it("last writer wins cleanly when the same file is saved repeatedly", () => {
		const p = join(dir, "state.json");
		for (let i = 0; i < 25; i += 1) saveJsonFile(p, { i });
		assert.deepEqual(loadJsonFile(p), { i: 24 });
		assert.deepEqual(
			readdirSync(dir).filter((n) => n.includes(".tmp-")),
			[],
		);
	});

	it("missing → null, empty → null, malformed JSON throws", () => {
		const p = join(dir, "x.json");
		assert.equal(loadJsonFile(p), null);
		writeFileSync(p, "  \n", "utf8");
		assert.equal(loadJsonFile(p), null);
		writeFileSync(p, "{ not json", "utf8");
		assert.throws(() => loadJsonFile(p));
		// The malformed content is still exactly what we wrote — the loader
		// never rewrites what it failed to parse.
		assert.equal(readFileSync(p, "utf8"), "{ not json");
	});
});
