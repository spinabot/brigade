import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { runUpdateCommand, type CommandRunner } from "./update.js";

// A source checkout = a dir with .git + src. We materialise a temp one so
// isSourceCheckout() (real fs) takes the source branch.
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "brigade-update-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "src"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PKG = () => ({ name: "@spinabot/brigade", version: "1.9.0", root });

/** Build a recording runner whose git/npm/restart results are configurable. */
function makeRunner(cfg: {
	upstream?: boolean; // @{u} resolves
	dirty?: boolean; // status --porcelain non-empty
	behind?: number; // rev-list count
	pullCode?: number;
	installCode?: number;
	buildCode?: number;
	restartCode?: number;
}): { run: CommandRunner; calls: string[] } {
	const calls: string[] = [];
	const run: CommandRunner = (cmd, args) => {
		const line = `${cmd} ${args.join(" ")}`;
		calls.push(line);
		const ok = { code: 0, stdout: "", stderr: "" };
		if (args.includes("--symbolic-full-name")) return { ...ok, code: cfg.upstream === false ? 1 : 0 };
		if (args.includes("fetch")) return ok;
		if (args.includes("status")) return { ...ok, stdout: cfg.dirty ? " M src/x.ts" : "" };
		if (args.includes("rev-list")) return { ...ok, stdout: String(cfg.behind ?? 0) };
		if (args.includes("pull")) return { ...ok, code: cfg.pullCode ?? 0 };
		if (line.includes("npm install")) return { ...ok, code: cfg.installCode ?? 0 };
		if (line.includes("npm run build")) return { ...ok, code: cfg.buildCode ?? 0 };
		if (args.includes("restart")) return { ...ok, code: cfg.restartCode ?? 0 };
		if (args.includes("--version")) return ok;
		return ok;
	};
	return { run, calls };
}

const ran = (calls: string[], needle: string): boolean => calls.some((c) => c.includes(needle));

test("source checkout, clean + behind → pulls (ff-only), installs, builds, restarts in order", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 2 });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.equal(code, 0);
	assert.ok(ran(calls, "pull --ff-only"), "should git pull");
	assert.ok(ran(calls, "npm install"));
	assert.ok(ran(calls, "npm run build"));
	assert.ok(ran(calls, "gateway restart"));
	// order: pull < install < build < restart
	const idx = (n: string) => calls.findIndex((c) => c.includes(n));
	assert.ok(idx("pull") < idx("npm install"));
	assert.ok(idx("npm install") < idx("npm run build"));
	assert.ok(idx("npm run build") < idx("gateway restart"));
});

test("source checkout, DIRTY tree → skips git pull but still installs/builds/restarts (never clobbers local work)", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: true, behind: 3 });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.equal(code, 0);
	assert.ok(!ran(calls, "pull --ff-only"), "must NOT pull over uncommitted changes");
	assert.ok(ran(calls, "npm run build"));
	assert.ok(ran(calls, "gateway restart"));
});

test("source checkout, clean + up-to-date + dist already current → skips reinstall/rebuild/restart", async () => {
	// A dist/ newer than the (empty) src means the build already matches the tree.
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist", "index.js"), "// built");
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 0 });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.equal(code, 0);
	assert.ok(!ran(calls, "npm install"), "should NOT reinstall when the build is current");
	assert.ok(!ran(calls, "npm run build"), "should NOT rebuild when the build is current");
	assert.ok(!ran(calls, "gateway restart"), "nothing rebuilt → nothing to restart");
});

test("source checkout, --force → rebuilds + restarts even when the build is current", async () => {
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist", "index.js"), "// built");
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 0 });
	const code = await runUpdateCommand({ pkg: PKG(), run, force: true });
	assert.equal(code, 0);
	assert.ok(ran(calls, "npm run build"), "--force should rebuild regardless");
	assert.ok(ran(calls, "gateway restart"));
});

test("source checkout, a git pull → forces a rebuild even if a prior dist exists", async () => {
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist", "index.js"), "// stale build");
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 2 });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.equal(code, 0);
	assert.ok(ran(calls, "pull --ff-only"), "should git pull");
	assert.ok(ran(calls, "npm run build"), "a pull must trigger a rebuild");
});

test("source checkout, build FAILS → does NOT restart the gateway", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 0, buildCode: 1 });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.notEqual(code, 0);
	assert.ok(ran(calls, "npm run build"));
	assert.ok(!ran(calls, "gateway restart"), "a broken build must not be restarted into");
});

test("source checkout, restart FAILS (foreground gateway / no service) → update still succeeds (0), restart attempted, no false claim", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 0, restartCode: 1 });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.equal(code, 0); // the build succeeded — a failed restart is non-fatal, not an error
	assert.ok(ran(calls, "npm run build"));
	assert.ok(ran(calls, "gateway restart"), "restart should still be attempted");
});

test("source checkout, --check → only inspects (fetch/status/rev-list), no pull/install/build/restart", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 1 });
	const code = await runUpdateCommand({ pkg: PKG(), run, check: true });
	assert.equal(code, 0);
	assert.ok(!ran(calls, "pull"));
	assert.ok(!ran(calls, "npm install"));
	assert.ok(!ran(calls, "npm run build"));
	assert.ok(!ran(calls, "gateway restart"));
});

test("source checkout, --no-restart → builds but leaves the gateway", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: false, behind: 0 });
	const code = await runUpdateCommand({ pkg: PKG(), run, noRestart: true });
	assert.equal(code, 0);
	assert.ok(ran(calls, "npm run build"));
	assert.ok(!ran(calls, "gateway restart"));
});

test("source checkout, no upstream → skips pull, still builds + restarts", async () => {
	const { run, calls } = makeRunner({ upstream: false });
	const code = await runUpdateCommand({ pkg: PKG(), run });
	assert.equal(code, 0);
	assert.ok(!ran(calls, "pull"));
	assert.ok(ran(calls, "npm run build"));
	assert.ok(ran(calls, "gateway restart"));
});

test("source checkout + --npm → forces the GLOBAL npm install (npm i -g @latest), not a git rebuild", async () => {
	const { run, calls } = makeRunner({ upstream: true, dirty: true, behind: 0 });
	// npm view returns a newer published version so it proceeds to install.
	const wrapped: CommandRunner = (cmd, args, o) => {
		if (args.includes("view")) return { code: 0, stdout: "9.9.9", stderr: "" };
		return run(cmd, args, o);
	};
	const code = await runUpdateCommand({ pkg: PKG(), run: wrapped, npm: true });
	assert.equal(code, 0);
	assert.ok(calls.some((c) => c.includes("i -g @spinabot/brigade@latest")), "should npm i -g @latest");
	assert.ok(!ran(calls, "pull --ff-only"), "must NOT git pull the source tree");
	assert.ok(!ran(calls, "npm run build"), "must NOT rebuild the source tree");
	assert.ok(ran(calls, "gateway restart"));
});

test("npm-global install (no .git/src) → npm i -g @latest + restart", async () => {
	const npmRoot = mkdtempSync(join(tmpdir(), "brigade-npm-"));
	try {
		const { run, calls } = makeRunner({});
		// npm view returns a newer version so it proceeds to install.
		const wrapped: CommandRunner = (cmd, args, o) => {
			if (args.includes("view")) return { code: 0, stdout: "2.0.0", stderr: "" };
			return run(cmd, args, o);
		};
		const code = await runUpdateCommand({ pkg: { name: "@spinabot/brigade", version: "1.9.0", root: npmRoot }, run: wrapped });
		assert.equal(code, 0);
		assert.ok(calls.some((c) => c.includes("i -g @spinabot/brigade@latest")), "should npm i -g @latest");
		assert.ok(calls.some((c) => c.includes("gateway restart")));
	} finally {
		rmSync(npmRoot, { recursive: true, force: true });
	}
});
