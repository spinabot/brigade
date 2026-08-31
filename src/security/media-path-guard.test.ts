import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { rootSpellings, validateOutboundMediaPath } from "./media-path-guard.js";

describe("validateOutboundMediaPath", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-media-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("allows a normal media file under temp", () => {
		const f = path.join(dir, "photo.jpg");
		fs.writeFileSync(f, "x");
		assert.equal(validateOutboundMediaPath(f).ok, true);
	});

	it("allows remote URLs and data URIs (not local-file reads)", () => {
		assert.equal(validateOutboundMediaPath("https://example.com/a.png").ok, true);
		assert.equal(validateOutboundMediaPath("http://example.com/a.png").ok, true);
		assert.equal(validateOutboundMediaPath("data:image/png;base64,iVBOR").ok, true);
	});

	it("blocks sensitive basenames", () => {
		for (const name of [".env", ".env.local", ".env.production", "id_rsa", "brigade.json", "auth.json", "auth-profiles.json", "credentials", ".git-credentials", "encryption.key", "admin-key.txt"]) {
			const f = path.join(dir, name);
			fs.writeFileSync(f, "secret");
			assert.equal(validateOutboundMediaPath(f).ok, false, `${name} should be blocked`);
		}
	});

	it("blocks any file under a credentials directory (.ssh)", () => {
		const sshDir = path.join(dir, ".ssh");
		fs.mkdirSync(sshDir);
		const f = path.join(sshDir, "mykey"); // innocuous name, still under .ssh
		fs.writeFileSync(f, "x");
		assert.equal(validateOutboundMediaPath(f).ok, false);
	});

	it("blocks files under .convex-data directory", () => {
		const convexDir = path.join(dir, ".convex-data");
		fs.mkdirSync(convexDir);
		const f = path.join(convexDir, "db.sqlite");
		fs.writeFileSync(f, "x");
		assert.equal(validateOutboundMediaPath(f).ok, false);
	});

	it("blocks the sealed per-agent auth subtree", () => {
		const authDir = path.join(dir, "agents", "main", "agent");
		fs.mkdirSync(authDir, { recursive: true });
		const f = path.join(authDir, "blob.bin");
		fs.writeFileSync(f, "x");
		assert.equal(validateOutboundMediaPath(f).ok, false);
	});

	it("blocks a system file", () => {
		const target =
			process.platform === "win32"
				? path.join(process.env.SystemRoot ?? "C:\\Windows", "system32", "drivers", "etc", "hosts")
				: "/etc/passwd";
		assert.equal(validateOutboundMediaPath(target).ok, false);
	});

	it("blocks a system file through the platform's own symlinked root", () => {
		// macOS symlinks /etc -> /private/etc, so realpathSync turns /etc/passwd
		// into /private/etc/passwd and the literal "/etc" prefix never matched.
		// Both spellings must be refused, whichever one the caller hands us.
		//
		// The resolved spelling is read from the platform rather than hardcoded:
		// on Linux /etc resolves to itself, on macOS to /private/etc. Naming
		// /private/etc literally would assert a path that is nothing special on
		// Linux — and would fail there for the right reason.
		if (process.platform === "win32") return;
		assert.equal(validateOutboundMediaPath("/etc/passwd").ok, false);
		assert.equal(validateOutboundMediaPath("/etc/ssh/sshd_config").ok, false);
		const resolvedEtc = fs.realpathSync("/etc");
		assert.equal(validateOutboundMediaPath(path.join(resolvedEtc, "passwd")).ok, false);
	});

	it("resolves symlinks before checking (innocent name → denied target)", () => {
		const secret = path.join(dir, "brigade.json");
		fs.writeFileSync(secret, "secret");
		const link = path.join(dir, "innocent.jpg");
		try {
			fs.symlinkSync(secret, link);
		} catch {
			return; // symlink not permitted on this platform — skip
		}
		assert.equal(validateOutboundMediaPath(link).ok, false);
	});

	it("rejects an empty path", () => {
		assert.equal(validateOutboundMediaPath("").ok, false);
	});
});

/* ─────────────────────── allowed-root spelling ─────────────────────── */

describe("rootSpellings", () => {


	// The bug this pins: allowed roots were built with `path.resolve` only, while
	// containment compared a `fs.realpathSync`'d candidate. On macOS
	// `os.tmpdir()` is `/var/folders/…` symlinked to `/private/var/folders/…`,
	// so a realpathed candidate under the temp dir was compared against the
	// `/var/…` spelling and never matched — refusing every document-tool write
	// into a temp dir with "outside the allowed roots". 40 tests failed on every
	// macOS checkout while Linux CI stayed green.
	//
	// …and the first version of this test had exactly the same blind spot. It
	// called `rootSpellings(os.tmpdir())` and asserted the result contained
	// `fs.realpathSync(tmpdir)` — on Linux that is the SAME STRING as the
	// resolved spelling, so the assertion held by identity and deleting the
	// realpath branch from `rootSpellings` would not have failed it. It could
	// only ever fail on the platform that already had the bug.
	//
	// So build the symlinked root ourselves, and assert it really is one.

	/** A physical dir plus a symlink to it, or `null` where symlinks are barred. */
	function symlinkedRoot(): { base: string; link: string; physical: string } | null {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-rootspelling-"));
		const physical = path.join(base, "physical");
		fs.mkdirSync(physical);
		const link = path.join(base, "via-symlink");
		try {
			fs.symlinkSync(physical, link, "dir");
		} catch {
			fs.rmSync(base, { recursive: true, force: true });
			return null; // unprivileged Windows — nothing to test
		}
		return { base, link, physical };
	}

	it("returns BOTH spellings of a symlinked root, on every platform", () => {
		const fixture = symlinkedRoot();
		if (!fixture) return;
		try {
			const resolved = path.resolve(fixture.link);
			const real = fs.realpathSync(fixture.link);
			assert.notEqual(real, resolved, "the fixture must genuinely be a symlink");

			const spellings = rootSpellings(fixture.link);
			assert.ok(spellings.includes(resolved), "keeps the resolved spelling");
			assert.ok(spellings.includes(real), "adds the realpathed spelling");
		} finally {
			fs.rmSync(fixture.base, { recursive: true, force: true });
		}
	});

	it("a candidate realpathed the way the guards do lands inside a root", () => {
		// The actual failure mode: the guards realpath the CANDIDATE, so a root
		// kept only in its symlinked spelling can never contain anything.
		const fixture = symlinkedRoot();
		if (!fixture) return;
		try {
			const target = path.join(fixture.link, "out.docx");
			fs.writeFileSync(target, "x");
			const realCandidate = fs.realpathSync(target);
			assert.notEqual(realCandidate, path.resolve(target), "the candidate really moves");
			const contained = rootSpellings(fixture.link).some((root) => {
				const rel = path.relative(root, realCandidate);
				return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
			});
			assert.ok(contained, "a realpathed candidate must be contained by one of the spellings");
		} finally {
			fs.rmSync(fixture.base, { recursive: true, force: true });
		}
	});

	it("keeps the host temp dir usable whichever way the platform spells it", () => {
		// The concrete regression: every document-tool write goes under
		// `os.tmpdir()`. On macOS that is the symlinked spelling.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-tmproot-"));
		try {
			const spellings = rootSpellings(dir);
			const real = fs.realpathSync(dir);
			const contained = spellings.some((root) => {
				const rel = path.relative(root, path.join(real, "out.docx"));
				return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
			});
			assert.ok(contained, "a write into the temp dir must be allowed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rootSpellings deduplicates when a root is not symlinked", () => {
		const spellings = rootSpellings(process.cwd());
		assert.equal(new Set(spellings).size, spellings.length, "no duplicate spellings");
		assert.ok(spellings.length >= 1);
	});

	it("rootSpellings tolerates a root that does not exist yet", () => {
		// State subtrees are created on first use; a missing root must still yield
		// its resolved spelling rather than dropping out of the allow-list.
		const missing = path.join(os.tmpdir(), "brigade-does-not-exist-", String(Date.now()));
		const spellings = rootSpellings(missing);
		assert.deepEqual(spellings, [path.resolve(missing)]);
	});

	it("rootSpellings ignores an empty path", () => {
		assert.deepEqual(rootSpellings(""), []);
	});
});
