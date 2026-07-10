// The engine install must land somewhere Brigade resolves from.
//
// The bug this file exists for: `resolveProducerEntry()` looked only in Brigade's own
// node_modules, and the "not installed" hint said `npm i @hyperframes/producer`. Run
// from a global install, that command walks UP from the cwd to the first package.json
// it finds — the operator's HOME — and installs there. The package is on disk and
// Brigade never sees it. An agent followed that hint and polluted a home directory.
//
// npm is injected here; these tests never install anything.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { installRenderEngine, type InstallRunner } from "./install.js";

/** Any real file works as a `BRIGADE_HYPERFRAMES_PATH` stand-in; use this one. */
const THIS_FILE = fileURLToPath(import.meta.url);

function tempEnginesDir(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "brigade-engines-")), "engines");
}

/** Records what npm would have been asked to do. */
function recordingRunner(code = 0): { run: InstallRunner; calls: { args: string[]; cwd: string }[] } {
	const calls: { args: string[]; cwd: string }[] = [];
	const run: InstallRunner = (_cmd, args, opts) => {
		calls.push({ args, cwd: opts.cwd });
		return { code, stdout: "", stderr: code === 0 ? "" : "npm ERR! 404 Not Found" };
	};
	return { run, calls };
}

test("npm is pointed AT the engines dir, and that dir gets its own package.json", () => {
	const dir = tempEnginesDir();
	const { run, calls } = recordingRunner();

	// force: skip the already-installed short-circuit; resolution will still fail
	// (nothing was really installed), which is asserted below.
	installRenderEngine({ run, enginesDir: dir, force: true });

	assert.equal(calls.length, 1, "npm invoked exactly once");
	assert.equal(calls[0]?.cwd, dir, "npm runs INSIDE the engines dir, not the operator's cwd");
	assert.deepEqual(calls[0]?.args, ["install", "@hyperframes/producer", "--omit=dev"]);

	// The manifest is the whole fix: without it npm walks up and installs in $HOME.
	const manifest = path.join(dir, "package.json");
	assert.ok(existsSync(manifest), "engines dir must carry a package.json so npm cannot walk up");
	const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { private?: boolean; name?: string };
	assert.equal(parsed.private, true, "never publishable by accident");
	assert.equal(parsed.name, "brigade-engines");
});

test("a failed npm install reports npm's own words, and never throws", () => {
	const dir = tempEnginesDir();
	const { run } = recordingRunner(1);
	const res = installRenderEngine({ run, enginesDir: dir, force: true });
	assert.equal(res.ok, false);
	assert.match(res.message, /npm install failed/);
	assert.match(res.message, /404 Not Found/, "the operator sees why, not a stack trace");
});

test("npm succeeding is not the same as the engine resolving", () => {
	// npm can exit 0 while installing into a parent directory — the exact failure that
	// made this whole feature necessary. A success we cannot verify is not a success.
	const dir = tempEnginesDir();
	const { run } = recordingRunner(0);
	const res = installRenderEngine({ run, enginesDir: dir, force: true });
	assert.equal(res.ok, false, "nothing was really installed, so resolution must fail");
	assert.match(res.message, /still does not resolve/);
	assert.match(res.message, /not a parent/, "and it names the failure mode");
});

test("an existing engine is reported, not reinstalled", () => {
	const dir = tempEnginesDir();
	const { run, calls } = recordingRunner();
	// `@hyperframes/producer` is absent here, so simulate "already present" by pointing
	// the override at a real file — resolveProducerEntry() honours it first.
	const prev = process.env.BRIGADE_HYPERFRAMES_PATH;
	process.env.BRIGADE_HYPERFRAMES_PATH = THIS_FILE;
	try {
		const res = installRenderEngine({ run, enginesDir: dir });
		assert.equal(res.ok, true);
		assert.match(res.message, /already installed/);
		assert.deepEqual(calls, [], "npm is never invoked when the engine already resolves");
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
		else process.env.BRIGADE_HYPERFRAMES_PATH = prev;
	}
});

test("--force reinstalls even when the engine already resolves", () => {
	const dir = tempEnginesDir();
	const { run, calls } = recordingRunner();
	const prev = process.env.BRIGADE_HYPERFRAMES_PATH;
	process.env.BRIGADE_HYPERFRAMES_PATH = THIS_FILE;
	try {
		installRenderEngine({ run, enginesDir: dir, force: true });
		assert.equal(calls.length, 1, "force bypasses the short-circuit");
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
		else process.env.BRIGADE_HYPERFRAMES_PATH = prev;
	}
});
