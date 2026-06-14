import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetBootForTests, bootRuntimeContext } from "./boot.js";
import { __resetRuntimeContextForTests, tryGetRuntimeContext } from "./runtime-context.js";

// bootRuntimeContext resolves mode via the real sentinel/env chain, so each
// test pins BRIGADE_STATE_DIR to a fresh tempdir (no sentinel → filesystem
// mode → LocalBrigadeStore against the tempdir).

describe("storage boot", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let savedMode: string | undefined;
	let savedConvexUrl: string | undefined;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-boot-test-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		savedMode = process.env.BRIGADE_MODE;
		savedConvexUrl = process.env.BRIGADE_CONVEX_URL;
		process.env.BRIGADE_STATE_DIR = stateDir;
		delete process.env.BRIGADE_MODE;
		delete process.env.BRIGADE_CONVEX_URL;
	});

	afterEach(() => {
		__resetRuntimeContextForTests();
		__resetBootForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		if (savedMode === undefined) delete process.env.BRIGADE_MODE;
		else process.env.BRIGADE_MODE = savedMode;
		if (savedConvexUrl === undefined) delete process.env.BRIGADE_CONVEX_URL;
		else process.env.BRIGADE_CONVEX_URL = savedConvexUrl;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("boots filesystem mode by default and installs the singleton", async () => {
		assert.equal(tryGetRuntimeContext(), undefined);
		const ctx = await bootRuntimeContext();
		assert.equal(ctx.mode, "filesystem");
		assert.equal(ctx.stateDir, stateDir);
		assert.equal(tryGetRuntimeContext(), ctx);
	});

	it("is idempotent — second call returns the same frozen context", async () => {
		const first = await bootRuntimeContext();
		const second = await bootRuntimeContext();
		assert.equal(first, second);
	});

	it("dedupes concurrent callers onto one in-flight boot", async () => {
		const [a, b, c] = await Promise.all([
			bootRuntimeContext(),
			bootRuntimeContext(),
			bootRuntimeContext(),
		]);
		assert.equal(a, b);
		assert.equal(b, c);
	});

	it("a failed boot is retryable, not cached forever", async () => {
		// Force a failure: convex mode with an unreachable deployment URL.
		process.env.BRIGADE_MODE = "convex";
		process.env.BRIGADE_CONVEX_URL = "http://127.0.0.1:1"; // nothing listens on port 1
		await assert.rejects(bootRuntimeContext());
		assert.equal(tryGetRuntimeContext(), undefined);

		// Flip back to a healthy mode — the retry must succeed.
		delete process.env.BRIGADE_MODE;
		delete process.env.BRIGADE_CONVEX_URL;
		const ctx = await bootRuntimeContext();
		assert.equal(ctx.mode, "filesystem");
	});
});
