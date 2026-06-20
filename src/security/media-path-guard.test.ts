import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { validateOutboundMediaPath } from "./media-path-guard.js";

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
		for (const name of [".env", ".env.local", ".env.production", "id_rsa", "brigade.json", "auth.json", "auth-profiles.json", "credentials", ".git-credentials"]) {
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
