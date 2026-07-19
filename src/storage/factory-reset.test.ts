import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { computePreservedEntries, wipeLocalBrigadeState } from "./factory-reset.js";

/**
 * The factory-reset primitive — the one destructive op behind "Start fresh" /
 * `store reset`. Tested in isolation so the dangerous part is pinned: it clears
 * the local state (so a re-onboard is virgin), is idempotent, NEVER reaches
 * outside the state dir (the encryption key lives there), and PRESERVES the two
 * things under the state dir that aren't disposable state: the running install
 * (bundled Node + `brigade` binary — wiping it uninstalls the CLI mid-reset,
 * "command not found" afterward; detected NAME-AGNOSTICALLY so the Windows
 * `node`-named dir is caught as well as the Unix `runtime` one) and `convex/`
 * (the local backend's binary + its authoritative database — wiping it is
 * irreversible data loss). Both must survive.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-freset-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("wipeLocalBrigadeState", () => {
	it("clears local state — workspace, skills, sessions, facts, sentinel", () => {
		fs.mkdirSync(path.join(dir, "workspace", "memory"), { recursive: true });
		fs.writeFileSync(path.join(dir, "workspace", "AGENTS.md"), "persona edits");
		fs.writeFileSync(path.join(dir, "workspace", "memory", "facts.jsonl"), '{"memoryId":"x"}\n');
		fs.mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
		fs.writeFileSync(path.join(dir, "skills", "demo", "SKILL.md"), "a skill");
		fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(dir, "mode.sentinel"), '{"mode":"filesystem"}');

		const cleared = wipeLocalBrigadeState(dir);
		assert.equal(cleared, dir);
		for (const entry of ["workspace", "skills", "sessions", "mode.sentinel"]) {
			assert.equal(fs.existsSync(path.join(dir, entry)), false, `${entry} cleared — next onboard starts virgin`);
		}
	});

	it("PRESERVES runtime/ — the bundled Node + brigade binary are not uninstalled by a reset", () => {
		// Simulate the packaging/install/install.sh layout: a private Node runtime
		// AND the brigade launcher live under <stateDir>/runtime, with
		// <stateDir>/runtime/bin on PATH. A blind rm -rf here is the "command not
		// found: brigade" bug — so runtime/ must survive alongside cleared state.
		fs.mkdirSync(path.join(dir, "runtime", "bin"), { recursive: true });
		fs.writeFileSync(path.join(dir, "runtime", "bin", "node"), "#!/bin/sh\n");
		fs.writeFileSync(path.join(dir, "runtime", "bin", "brigade"), "#!/usr/bin/env node\n");
		fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
		fs.writeFileSync(path.join(dir, "mode.sentinel"), '{"mode":"filesystem"}');

		wipeLocalBrigadeState(dir);

		assert.equal(fs.existsSync(path.join(dir, "workspace")), false, "state still cleared");
		assert.equal(fs.existsSync(path.join(dir, "mode.sentinel")), false, "sentinel still cleared");
		assert.equal(
			fs.existsSync(path.join(dir, "runtime", "bin", "brigade")),
			true,
			"the brigade binary survives — the CLI is not uninstalled by a reset",
		);
		assert.equal(fs.existsSync(path.join(dir, "runtime", "bin", "node")), true, "the bundled node survives");
	});

	it("PRESERVES convex/ — the local self-hosted backend binary + database are not erased by a reset", () => {
		// Global installs run the local Convex backend from <stateDir>/convex:
		// its binary under convex/bin and — critically — its sqlite DATABASE under
		// convex/data. In convex mode that db IS the authoritative store, so a
		// blind rm -rf here is irreversible user-data loss. It must survive.
		fs.mkdirSync(path.join(dir, "convex", "bin"), { recursive: true });
		fs.writeFileSync(path.join(dir, "convex", "bin", "convex-local-backend"), "ELF");
		fs.mkdirSync(path.join(dir, "convex", "data"), { recursive: true });
		fs.writeFileSync(path.join(dir, "convex", "data", "convex_local_backend.sqlite3"), "SQLite format 3\0");
		fs.writeFileSync(path.join(dir, "convex", "data", "identity.json"), '{"name":"brigade-local"}');
		fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });

		wipeLocalBrigadeState(dir);

		assert.equal(fs.existsSync(path.join(dir, "workspace")), false, "filesystem-mode state still cleared");
		assert.equal(
			fs.existsSync(path.join(dir, "convex", "data", "convex_local_backend.sqlite3")),
			true,
			"the convex database survives — a reset is not data loss",
		);
		assert.equal(fs.existsSync(path.join(dir, "convex", "data", "identity.json")), true, "backend identity survives");
		assert.equal(fs.existsSync(path.join(dir, "convex", "bin", "convex-local-backend")), true, "backend binary survives");
	});

	it("is idempotent — wiping a missing dir does not throw", () => {
		assert.doesNotThrow(() => wipeLocalBrigadeState(path.join(dir, "does-not-exist")));
	});

	it("does NOT touch anything OUTSIDE the state dir (the OS-config encryption key survives)", () => {
		const osConfig = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-oscfg-"));
		const keyPath = path.join(osConfig, "encryption.key");
		fs.writeFileSync(keyPath, "deadbeef");
		try {
			fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
			wipeLocalBrigadeState(dir);
			assert.equal(fs.existsSync(keyPath), true, "a key outside the state dir is not destroyed by the wipe");
		} finally {
			fs.rmSync(osConfig, { recursive: true, force: true });
		}
	});
});

describe("computePreservedEntries — name-agnostic self-preservation", () => {
	// Detection uses the host's path separator; on this POSIX test host we build
	// paths with that same separator, so a dir literally named "node" under the
	// state dir faithfully stands in for the Windows install layout.
	const state = path.join(path.sep, "home", "u", ".brigade");

	it("preserves the dir holding the running node — Unix `runtime` layout", () => {
		const set = computePreservedEntries(state, path.join(state, "runtime", "bin", "node"), null);
		assert.equal(set.has("runtime"), true);
	});

	it("preserves the running node's dir even when it's named `node` — Windows layout", () => {
		// THE regression guard for the Windows report: a static ["runtime"]
		// allowlist would miss the Windows-installer name and the wipe would delete
		// the interpreter → "command not found". Detection catches it by content.
		const set = computePreservedEntries(state, path.join(state, "node", "node.exe"), null);
		assert.equal(set.has("node"), true, "the interpreter's dir is preserved regardless of its name");
	});

	it("preserves the dir holding the installed brigade package", () => {
		const pkg = path.join(state, "runtime", "lib", "node_modules", "@spinabot", "brigade");
		const set = computePreservedEntries(state, path.join(path.sep, "usr", "bin", "node"), pkg);
		assert.equal(set.has("runtime"), true);
	});

	it("adds NOTHING extra when the runtime lives OUTSIDE the state dir (system / Windows %LOCALAPPDATA% node)", () => {
		const set = computePreservedEntries(
			state,
			path.join(path.sep, "Users", "u", "AppData", "Local", "Brigade", "node", "node.exe"),
			path.join(path.sep, "Users", "u", "AppData", "Local", "Brigade", "node", "node_modules", "brigade"),
		);
		assert.deepEqual([...set].sort(), ["convex", "runtime"], "only the static names — no false preserve");
	});

	it("keeps convex/ (static), tolerates a null package root, and never preserves the state dir or a sibling", () => {
		const base = computePreservedEntries(state, path.join(path.sep, "usr", "bin", "node"), null);
		assert.equal(base.has("convex"), true);
		// execPath == stateDir (degenerate) and a sibling dir must both add nothing.
		assert.deepEqual([...computePreservedEntries(state, state, null)].sort(), ["convex", "runtime"]);
		const sibling = path.join(path.dirname(state), "other", "node");
		assert.deepEqual([...computePreservedEntries(state, sibling, null)].sort(), ["convex", "runtime"]);
	});
});
