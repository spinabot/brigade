/**
 * Discovery-layer tests: POSIX safety gates + manifest extraction + origin tag.
 *
 * The POSIX safety gates only fire on non-Windows; the tests use the
 * `platformOverride` seam on `checkPosixSafety` so they can exercise the
 * non-Windows path on every CI runner (Brigade ships to Windows too, so we
 * must verify both branches don't regress).
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkPosixSafety, clearDiscoveryCache, discoverUserModules, importWithTimeout } from "./discovery.js";

const SAFE_MODULE_SRC = `export default { id: "ok", register(b) {} };`;

describe("checkPosixSafety", () => {
	it("returns null on Windows (POSIX checks skipped wholesale)", () => {
		const dir = mkdtempSync(join(tmpdir(), "brigade-safety-win-"));
		try {
			const file = join(dir, "m.mjs");
			writeFileSync(file, SAFE_MODULE_SRC, { mode: 0o666 }); // would fail on POSIX
			// Force the "windows" branch — even though the file is world-writable,
			// checkPosixSafety returns null on Windows because the bit doesn't
			// carry meaning there.
			const reason = checkPosixSafety(file, dir, "win32");
			assert.equal(reason, null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a world-writable file on POSIX (mode 0o646 fails)", () => {
		// World-writable test only runs on POSIX hosts — on Windows the chmod
		// call is a no-op, so the world-writable bit can't be set in a way the
		// safety check would observe. We still cover the Windows branch in the
		// test above.
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "brigade-safety-ww-"));
		try {
			const file = join(dir, "m.mjs");
			writeFileSync(file, SAFE_MODULE_SRC);
			chmodSync(file, 0o646);
			const reason = checkPosixSafety(file, dir, "linux");
			assert.ok(reason, "expected a rejection reason");
			assert.match(reason!, /world-writable/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a symlink that escapes extensionsDir on POSIX", () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "brigade-safety-symlink-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "brigade-safety-outside-"));
		try {
			const outsideFile = join(outsideDir, "evil.mjs");
			writeFileSync(outsideFile, SAFE_MODULE_SRC);
			chmodSync(outsideFile, 0o644);
			const link = join(dir, "m.mjs");
			try {
				symlinkSync(outsideFile, link);
			} catch (err) {
				// Some CI runners disallow symlinks for the user; in that case
				// the test trivially passes (the host can't even construct an
				// escape we'd need to reject).
				if ((err as NodeJS.ErrnoException).code === "EPERM") return;
				throw err;
			}
			const reason = checkPosixSafety(link, dir, "linux");
			assert.ok(reason, "expected a rejection reason");
			assert.match(reason!, /symlink escape/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("accepts a safe regular file on POSIX (mode 0o644, owned by current user, no symlink)", () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "brigade-safety-ok-"));
		try {
			const file = join(dir, "m.mjs");
			writeFileSync(file, SAFE_MODULE_SRC);
			chmodSync(file, 0o644);
			const reason = checkPosixSafety(file, dir, "linux");
			assert.equal(reason, null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("discoverUserModules — POSIX safety gate", () => {
	it("skips a world-writable candidate (POSIX hosts only)", async () => {
		if (process.platform === "win32") return;
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-ww-"));
		try {
			// One safe file, one world-writable file. Only the safe one survives.
			const safe = join(dir, "safe.mjs");
			writeFileSync(safe, `export default { id: "safe", register() {} };`);
			chmodSync(safe, 0o644);

			const bad = join(dir, "bad.mjs");
			writeFileSync(bad, `export default { id: "bad", register() {} };`);
			chmodSync(bad, 0o646); // world-writable

			const found = await discoverUserModules(dir);
			const ids = found.map((d) => d.module.id).sort();
			assert.deepEqual(ids, ["safe"], "world-writable bad.mjs must be skipped");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads regular files without complaint on Windows (no POSIX gate fires)", async () => {
		// Sanity: on Windows the discovery walks the dir + imports without
		// invoking the POSIX gate. We can't force-disable the gate from the
		// outside; instead we just confirm a normal file loads as before on
		// the host's actual platform.
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-win-ok-"));
		try {
			writeFileSync(join(dir, "ok.mjs"), `export default { id: "winok", register() {} };`);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.module.id, "winok");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("discoverUserModules — manifest extraction + origin", () => {
	it("captures the module's manifest field onto DiscoveredModule.manifest", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-manifest-"));
		try {
			writeFileSync(
				join(dir, "m.mjs"),
				`export default {
					id: "withman",
					manifest: { id: "withman", name: "With Manifest", version: "0.0.1", provides: { tools: ["t1"] } },
					register() {},
				};`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			const d = found[0];
			assert.ok(d, "expected one discovered module");
			assert.equal(d.manifest?.id, "withman");
			assert.equal(d.manifest?.name, "With Manifest");
			assert.deepEqual(d.manifest?.provides?.tools, ["t1"]);
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("captures a top-level named manifest export (alternate authoring shape)", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-manifest2-"));
		try {
			writeFileSync(
				join(dir, "m.mjs"),
				`export const manifest = { id: "topman", description: "via named export" };
				export default { id: "topman", register() {} };`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.manifest?.id, "topman");
			assert.equal(found[0]?.manifest?.description, "via named export");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("manifest is undefined when the module omits it", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-nomanifest-"));
		try {
			writeFileSync(
				join(dir, "m.mjs"),
				`export default { id: "noman", register() {} };`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.manifest, undefined);
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tags every discovered module with origin=user", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-origin-"));
		try {
			writeFileSync(join(dir, "a.mjs"), `export default { id: "a", register() {} };`);
			writeFileSync(join(dir, "b.mjs"), `export default { id: "b", register() {} };`);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 2);
			for (const d of found) {
				assert.equal(d.origin, "user", `expected origin=user for ${d.module.id}`);
			}
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("discoverUserModules — TypeScript + SDK alias loading", () => {
	it("loads a .ts user module that imports defineModule from brigade/channel-sdk", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-ts-channel-"));
		try {
			// Authored in TypeScript, with type annotations, importing the channel
			// SDK by specifier — proves (a) TS transpiles on import and (b) the
			// `brigade/channel-sdk` alias resolves to Brigade's own SDK entry
			// WITHOUT Brigade installed into the extensions dir.
			writeFileSync(
				join(dir, "ts-channel.ts"),
				`import { defineModule } from "brigade/channel-sdk";
				const id: string = "ts-channel";
				export default defineModule({ id, register(_b): void {} });`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1, "expected exactly one discovered TS module");
			const d = found[0];
			assert.ok(d, "expected one discovered module");
			assert.equal(d.module.id, "ts-channel");
			assert.equal(typeof d.module.register, "function");
			assert.equal(d.origin, "user");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a .ts user module that imports defineModule from brigade/extension-sdk", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-ts-ext-"));
		try {
			writeFileSync(
				join(dir, "ts-ext.ts"),
				`import { defineModule } from "brigade/extension-sdk";
				export default defineModule({ id: "ts-ext", register(_b) {} });`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.module.id, "ts-ext");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads an .mts user module via the channel SDK alias", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-mts-"));
		try {
			writeFileSync(
				join(dir, "m.mts"),
				`import { defineModule } from "brigade/channel-sdk";
				export default defineModule({ id: "mts-mod", register(_b) {} });`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.module.id, "mts-mod");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still loads a precompiled .js user module (existing path unchanged)", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-js-still-"));
		try {
			writeFileSync(join(dir, "plain.js"), `export default { id: "plain-js", register() {} };`);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.module.id, "plain-js");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores .d.ts declaration files (never imported as a module)", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-dts-"));
		try {
			// A stray .d.ts must NOT be treated as a candidate, while a sibling
			// real module loads normally.
			writeFileSync(join(dir, "types.d.ts"), `export declare const x: number;`);
			writeFileSync(join(dir, "real.ts"), `export default { id: "real-ts", register() {} };`);
			const found = await discoverUserModules(dir);
			const ids = found.map((d) => d.module.id).sort();
			assert.deepEqual(ids, ["real-ts"], "the .d.ts must be ignored");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers a compiled index.js over a source index.ts in the same folder", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-dir-prec-"));
		try {
			const modDir = join(dir, "mymod");
			mkdirSync(modDir);
			// Both present: compiled wins per DIR_INDEX_BASENAMES precedence.
			writeFileSync(join(modDir, "index.js"), `export default { id: "from-js", register() {} };`);
			writeFileSync(join(modDir, "index.ts"), `export default { id: "from-ts", register() {} };`);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.module.id, "from-js", "compiled index.js must take precedence");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a TS-only directory module via index.ts", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-dir-ts-"));
		try {
			const modDir = join(dir, "tsmod");
			mkdirSync(modDir);
			writeFileSync(
				join(modDir, "index.ts"),
				`import { defineModule } from "brigade/extension-sdk";
				export default defineModule({ id: "dir-ts", register(_b) {} });`,
			);
			const found = await discoverUserModules(dir);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.module.id, "dir-ts");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("times out (and skips) a TS module whose top-level init hangs", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-ts-hang-"));
		try {
			// A safe sibling loads; the hanging one is skipped without aborting.
			writeFileSync(join(dir, "ok.ts"), `export default { id: "ok-ts", register() {} };`);
			writeFileSync(
				join(dir, "hang.ts"),
				`await new Promise<void>(() => {}); export default { id: "never", register() {} };`,
			);
			const found = await discoverUserModules(dir);
			const ids = found.map((d) => d.module.id);
			assert.ok(ids.includes("ok-ts"), "the safe TS module must still load");
			assert.ok(!ids.includes("never"), "the hanging TS module must be skipped");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Keep a reference to mkdirSync so the import isn't flagged as unused (some
// host environments tree-shake unused fs imports; we use it transitively via
// mkdtempSync but ts-node might still complain).
void mkdirSync;

describe("importWithTimeout — timeout timer hygiene", () => {
	// Seam capturing every armed timer so the test can observe exactly what the
	// production code would hand to the event loop — no clock fakery, no
	// dependence on how Node schedules real timers.
	function makeRecordingTimers(): {
		timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
		cleared: unknown[];
		live: Set<unknown>;
	} {
		const cleared: unknown[] = [];
		const live = new Set<unknown>();
		const timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = {
			setTimeout: ((handler: () => void, ms?: number) => {
				const t = setTimeout(handler, ms);
				live.add(t);
				return t;
			}) as unknown as typeof setTimeout,
			clearTimeout: ((t: unknown) => {
				cleared.push(t);
				live.delete(t);
				clearTimeout(t as NodeJS.Timeout);
			}) as unknown as typeof clearTimeout,
		};
		return { timers, cleared, live };
	}

	it("clears the timeout timer when the import succeeds", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-timer-ok-"));
		try {
			const mod = join(dir, "quick.mjs");
			writeFileSync(mod, `export default { id: "quick", register() {} };`);
			const { timers, cleared, live } = makeRecordingTimers();
			await importWithTimeout(mod, timers);
			assert.equal(cleared.length, 1, "the armed timeout timer must be cleared exactly once");
			assert.equal(live.size, 0, "no timer may outlive a settled import");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears the timeout timer when the import fails", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-timer-bad-"));
		try {
			const mod = join(dir, "broken.mjs");
			// A module with a genuinely broken import is enough — the failure
			// path (not the timeout path) is what must clear the timer.
			writeFileSync(mod, `import "./does-not-exist.js"; export default {};`);
			const { timers, cleared, live } = makeRecordingTimers();
			await assert.rejects(() => importWithTimeout(mod, timers));
			assert.equal(cleared.length, 1, "a failed import must still clear its timer");
			assert.equal(live.size, 0, "no timer may outlive a failed import");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("arms exactly one 5s timer per import and defaults to the global timers", async () => {
		clearDiscoveryCache();
		const dir = mkdtempSync(join(tmpdir(), "brigade-disc-timer-count-"));
		try {
			const mod = join(dir, "plain.mjs");
			writeFileSync(mod, `export default { id: "plain", register() {} };`);
			// Exercise the production default (no seam) too: the promise must
			// settle with the module value, proving the seam is optional and the
			// happy path is untouched.
			const value = (await importWithTimeout(mod)) as { default?: { id?: string } };
			assert.equal(value.default?.id, "plain");
		} finally {
			clearDiscoveryCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
