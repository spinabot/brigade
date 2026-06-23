/**
 * Tests for `brigade extensions list / doctor / init`.
 *
 * State isolation: every test uses a tempdir for the extensions folder and
 * cleans it up. The `init` tests point `BRIGADE_STATE_DIR` at a tempdir so the
 * scaffold lands there — never the operator's real `~/.brigade`.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { clearDiscoveryCache } from "../../agents/extensions/discovery.js";
import { diagnoseExtensions } from "../../agents/extensions/diagnose.js";
import type { BrigadeModule } from "../../agents/extensions/types.js";

const VALID = `export default { id: "valid-mod", register() {} };`;
const NO_DEFAULT = `export const notAModule = { id: "x", register() {} };`;

const BUNDLED: BrigadeModule[] = [
	{ id: "alpha-bundled", register() {} },
	{ id: "beta-bundled", register() {} },
];

function freshDir(prefix: string): string {
	clearDiscoveryCache();
	return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("diagnoseExtensions — list/doctor logic", () => {
	afterEach(() => clearDiscoveryCache());

	it("always reports bundled modules as loaded, id-sorted", async () => {
		const dir = freshDir("brigade-ext-bundled-");
		try {
			const { extensions } = await diagnoseExtensions(BUNDLED, dir);
			const bundled = extensions.filter((e) => e.origin === "bundled");
			assert.deepEqual(
				bundled.map((e) => e.id),
				["alpha-bundled", "beta-bundled"],
			);
			assert.ok(bundled.every((e) => e.status === "loaded"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks a valid user module as loaded with all checks passing", async () => {
		const dir = freshDir("brigade-ext-valid-");
		try {
			writeFileSync(path.join(dir, "good.mjs"), VALID);
			const { extensions } = await diagnoseExtensions(BUNDLED, dir);
			const entry = extensions.find((e) => e.origin === "user");
			assert.ok(entry, "expected a user entry");
			assert.equal(entry!.id, "valid-mod");
			assert.equal(entry!.status, "loaded");
			assert.deepEqual(entry!.checks, { safe: true, imported: true, exportedModule: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips a file that exports no default module, with an actionable reason", async () => {
		const dir = freshDir("brigade-ext-nodefault-");
		try {
			writeFileSync(path.join(dir, "bad.mjs"), NO_DEFAULT);
			const { extensions } = await diagnoseExtensions(BUNDLED, dir);
			const entry = extensions.find((e) => e.origin === "user");
			assert.ok(entry, "expected a user entry");
			assert.equal(entry!.status, "skipped");
			assert.equal(entry!.checks?.imported, true);
			assert.equal(entry!.checks?.exportedModule, false);
			assert.match(entry!.reason ?? "", /does not export a Brigade module/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips a file that fails to load (e.g. a syntax error), reported as not-loaded", async () => {
		const dir = freshDir("brigade-ext-broken-");
		try {
			// A hard parse error — imports but throws.
			writeFileSync(path.join(dir, "broken.mjs"), `export default { id: "x", register() { } ;;; this is not valid`);
			const { extensions } = await diagnoseExtensions(BUNDLED, dir);
			const entry = extensions.find((e) => e.origin === "user");
			assert.ok(entry, "expected a user entry");
			assert.equal(entry!.status, "skipped");
			assert.equal(entry!.checks?.imported, false);
			assert.match(entry!.reason ?? "", /could not be loaded/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips a world-writable candidate as a safety failure (POSIX only)", async () => {
		if (process.platform === "win32") return;
		const dir = freshDir("brigade-ext-ww-");
		try {
			const file = path.join(dir, "unsafe.mjs");
			writeFileSync(file, VALID);
			chmodSync(file, 0o646); // world-writable
			const { extensions } = await diagnoseExtensions(BUNDLED, dir);
			const entry = extensions.find((e) => e.origin === "user");
			assert.ok(entry, "expected a user entry");
			assert.equal(entry!.status, "skipped");
			assert.equal(entry!.checks?.safe, false);
			assert.match(entry!.reason ?? "", /safety check/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("diagnoses a valid + an invalid candidate together", async () => {
		const dir = freshDir("brigade-ext-mixed-");
		try {
			writeFileSync(path.join(dir, "good.mjs"), VALID);
			writeFileSync(path.join(dir, "bad.mjs"), NO_DEFAULT);
			const { extensions } = await diagnoseExtensions(BUNDLED, dir);
			const user = extensions.filter((e) => e.origin === "user");
			assert.equal(user.length, 2);
			assert.equal(user.filter((e) => e.status === "loaded").length, 1);
			assert.equal(user.filter((e) => e.status === "skipped").length, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runExtensionsInit — scaffold", () => {
	const originalStateDir = process.env.BRIGADE_STATE_DIR;
	let stateDir: string | undefined;

	afterEach(() => {
		if (originalStateDir !== undefined) process.env.BRIGADE_STATE_DIR = originalStateDir;
		else delete process.env.BRIGADE_STATE_DIR;
		if (stateDir) {
			try {
				rmSync(stateDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			stateDir = undefined;
		}
	});

	async function init(args: { id: string; kind?: string }): Promise<{ code: number; dir: string }> {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-ext-init-"));
		process.env.BRIGADE_STATE_DIR = stateDir;
		const { runExtensionsInit } = await import("./extensions.js");
		const code = await runExtensionsInit(args, { json: true });
		return { code, dir: path.join(stateDir, "extensions", args.id) };
	}

	it("writes index.ts + README.md for a channel (default kind)", async () => {
		const { code, dir } = await init({ id: "my-channel" });
		assert.equal(code, 0);
		assert.ok(existsSync(path.join(dir, "index.ts")), "index.ts written");
		assert.ok(existsSync(path.join(dir, "README.md")), "README.md written");
		const body = readFileSync(path.join(dir, "index.ts"), "utf8");
		assert.match(body, /from "brigade\/channel-sdk"/);
		assert.match(body, /id: "my-channel"/);
	});

	it("uses the extension-sdk import for a tool", async () => {
		const { code, dir } = await init({ id: "my-tool", kind: "tool" });
		assert.equal(code, 0);
		const body = readFileSync(path.join(dir, "index.ts"), "utf8");
		assert.match(body, /from "brigade\/extension-sdk"/);
		assert.match(body, /b\.tool\(/);
	});

	it("uses the extension-sdk import for a provider", async () => {
		const { code, dir } = await init({ id: "my-provider", kind: "provider" });
		assert.equal(code, 0);
		const body = readFileSync(path.join(dir, "index.ts"), "utf8");
		assert.match(body, /from "brigade\/extension-sdk"/);
		assert.match(body, /b\.webSearch\(/);
	});

	it("refuses cleanly when the extension folder already exists", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-ext-init-dup-"));
		process.env.BRIGADE_STATE_DIR = stateDir;
		const existing = path.join(stateDir, "extensions", "dupe");
		mkdirSync(existing, { recursive: true });
		const { runExtensionsInit } = await import("./extensions.js");
		const code = await runExtensionsInit({ id: "dupe", kind: "channel" }, { json: true });
		assert.equal(code, 1, "should refuse with a non-zero exit");
		// The pre-existing dir must be untouched (no index.ts overwritten in).
		assert.ok(!existsSync(path.join(existing, "index.ts")), "must not scaffold into an existing folder");
	});

	it("rejects an invalid id", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-ext-init-badid-"));
		process.env.BRIGADE_STATE_DIR = stateDir;
		const { runExtensionsInit } = await import("./extensions.js");
		const code = await runExtensionsInit({ id: "Bad Id!", kind: "channel" }, { json: true });
		assert.equal(code, 1);
	});

	it("rejects an unknown kind", async () => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-ext-init-badkind-"));
		process.env.BRIGADE_STATE_DIR = stateDir;
		const { runExtensionsInit } = await import("./extensions.js");
		const code = await runExtensionsInit({ id: "ok-id", kind: "banana" }, { json: true });
		assert.equal(code, 1);
	});
});

// Keep mkdirSync referenced for hosts that tree-shake unused fs imports.
void mkdirSync;
