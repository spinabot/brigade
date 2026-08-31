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


	it("rootSpellings returns the realpathed spelling of a symlinked root", () => {
		// The bug this pins: allowed roots were built with `path.resolve` only, while
		// containment compared a `fs.realpathSync`'d candidate. On macOS
		// `os.tmpdir()` is `/var/folders/…` symlinked to `/private/var/folders/…`,
		// so a realpathed candidate under the temp dir was compared against the
		// `/var/…` spelling and never matched — refusing every document-tool write
		// into a temp dir with "outside the allowed roots". 40 tests failed on every
		// macOS checkout while Linux CI stayed green, because `/tmp` is not a symlink
		// there.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-rootspelling-"));
		try {
			const spellings = rootSpellings(dir);
			const real = fs.realpathSync(dir);
			assert.ok(spellings.includes(path.resolve(dir)), "keeps the resolved spelling");
			assert.ok(spellings.includes(real), "adds the realpathed spelling");
			// A candidate realpathed the way the guards do must land inside a root.
			assert.ok(
				spellings.some((root) => {
					const rel = path.relative(root, path.join(real, "out.docx"));
					return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
				}),
				"a realpathed candidate is contained by one of the spellings",
			);
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
