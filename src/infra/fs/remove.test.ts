/**
 * `removeFileSync` — the delete contract the vault prune counts against.
 *
 * The load-bearing case is the last one: a note whose path contains non-ASCII
 * characters. Vault note filenames are derived from fact CONTENT, so a fact with
 * an em dash or an accent in it produces exactly this kind of path — and on
 * Windows `fs.rmSync` returns without removing such a file, which is how a
 * shredded fact's plaintext survived a prune that reported success.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeFileSync } from "./remove.js";

describe("removeFileSync", () => {
	let dir: string;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-remove-"));
	});
	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("removes a regular file and reports true", () => {
		const file = path.join(dir, "plain.md");
		fs.writeFileSync(file, "note\n", "utf8");

		assert.equal(removeFileSync(file), true, "reports the removal");
		assert.equal(fs.existsSync(file), false, "and the file is actually gone");
	});

	it("reports true for a path that is already absent (a re-run stays successful)", () => {
		const file = path.join(dir, "never-existed.md");
		assert.equal(removeFileSync(file), true);
	});

	it("reports false rather than lying when the target is a directory", () => {
		// A delete that "succeeds" on a directory would turn a bug in a derived
		// filename into a whole subtree of data loss.
		const nested = path.join(dir, "a-directory");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "keep.md"), "keep me\n", "utf8");

		assert.equal(removeFileSync(nested), false, "a directory is not a file delete");
		assert.equal(fs.existsSync(nested), true, "the directory survives");
		assert.equal(fs.existsSync(path.join(nested, "keep.md")), true, "and so does its content");
	});

	it("removes a file whose BASENAME contains non-ASCII characters", () => {
		// The Unicode below is exactly the shape a fact-derived note name takes:
		// `topic — café 🗺️.md` mirrors `sanitizeForFilename("topic — café 🗺️")`.
		const file = path.join(dir, "topic — café 🗺️.md");
		fs.writeFileSync(file, "shredded plaintext\n", "utf8");

		assert.equal(removeFileSync(file), true, "reports the removal");
		assert.equal(fs.existsSync(file), false, "and the plaintext is really off the disk");
	});

	it("removes a file whose PARENT directory contains non-ASCII characters", () => {
		// A Windows operator whose home path carries an accent (e.g. the profile
		// directory Windows would name after an accented login) hits this for
		// EVERY delete, not just the oddly-named ones.
		const accented = path.join(dir, "données", ".brigade");
		fs.mkdirSync(accented, { recursive: true });
		const file = path.join(accented, "plain.md");
		fs.writeFileSync(file, "shredded plaintext\n", "utf8");

		assert.equal(removeFileSync(file), true, "reports the removal");
		assert.equal(fs.existsSync(file), false, "and the file is really gone");
	});
});
