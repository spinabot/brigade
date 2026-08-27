/**
 * Allowed-root scoping when a root is itself a SYMLINK.
 *
 * The guard realpaths the target (`nearestExistingAncestorReal` on a write,
 * `fs.realpathSync` on a read) but used to keep the roots un-realpathed, so a
 * symlinked root matched nothing. That is not a hypothetical: on macOS
 * `os.tmpdir()` is `/var/folders/…` whose realpath is `/private/var/folders/…`,
 * which made every doc/media tool refuse every file in temp — 41 test failures,
 * invisible on Linux CI where `/tmp` is a real directory.
 *
 * This test builds the symlink explicitly so it fails on any platform.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { allowedDocRoots, resolveOutputPath } from "./doc-shared.js";

describe("allowed-root scoping — symlinked root", { skip: process.platform === "win32" }, () => {
	it("accepts a write under a workspace reached through a symlink", () => {
		const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "brigade-doc-real-"));
		const link = path.join(fs.realpathSync(os.tmpdir()), `brigade-doc-link-${Date.now()}`);
		fs.symlinkSync(real, link);
		try {
			const out = resolveOutputPath("out.docx", { workspaceDir: link, cwd: link });
			assert.equal(out, path.join(link, "out.docx"));
		} finally {
			fs.rmSync(link, { force: true });
			fs.rmSync(real, { recursive: true, force: true });
		}
	});

	it("lists both the resolved and the realpath form of a root", () => {
		const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "brigade-doc-real-"));
		const link = path.join(fs.realpathSync(os.tmpdir()), `brigade-doc-link-${Date.now()}`);
		fs.symlinkSync(real, link);
		try {
			const roots = allowedDocRoots({ workspaceDir: link });
			assert.ok(roots.includes(link), "the path as given");
			assert.ok(roots.includes(real), "and what it points at");
		} finally {
			fs.rmSync(link, { force: true });
			fs.rmSync(real, { recursive: true, force: true });
		}
	});
});
