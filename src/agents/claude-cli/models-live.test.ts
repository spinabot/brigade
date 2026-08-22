import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { __resetClaudeCliModelsCache, fetchClaudeCliModelIds } from "./models-live.js";

/**
 * A model Anthropic shipped after this release. It is deliberately NOT in
 * `CLAUDE_CLI_MODELS` — that is the whole point: the picker must surface models
 * the catalog has never heard of.
 */
const POST_RELEASE_MODEL = "claude-opus-99";

test("fetchClaudeCliModelIds: serves the DISCOVERED list when no token is available", async () => {
	const cacheDir = mkdtempSync(path.join(tmpdir(), "brigade-mcache-"));
	const credDir = mkdtempSync(path.join(tmpdir(), "brigade-nocred-"));
	const prevCache = process.env.BRIGADE_CACHE_DIR;
	const prevCred = process.env.BRIGADE_CLAUDE_CONFIG_DIR;
	process.env.BRIGADE_CACHE_DIR = cacheDir;
	process.env.BRIGADE_CLAUDE_CONFIG_DIR = credDir; // empty → no credential at all
	__resetClaudeCliModelsCache();
	try {
		fs.writeFileSync(
			path.join(cacheDir, "claude-cli-models.json"),
			JSON.stringify({ atMs: Date.now(), ids: [POST_RELEASE_MODEL, "claude-sonnet-5"] }),
		);
		const ids = await fetchClaudeCliModelIds({ force: true });
		// Without persistence this collapsed to the frozen catalog on every restart,
		// silently dropping any model newer than the release.
		assert.ok(ids.includes(POST_RELEASE_MODEL), `expected ${POST_RELEASE_MODEL} in ${ids.join(",")}`);
	} finally {
		if (prevCache === undefined) delete process.env.BRIGADE_CACHE_DIR;
		else process.env.BRIGADE_CACHE_DIR = prevCache;
		if (prevCred === undefined) delete process.env.BRIGADE_CLAUDE_CONFIG_DIR;
		else process.env.BRIGADE_CLAUDE_CONFIG_DIR = prevCred;
		__resetClaudeCliModelsCache();
		rmSync(cacheDir, { recursive: true, force: true });
		rmSync(credDir, { recursive: true, force: true });
	}
});

test("fetchClaudeCliModelIds: a tampered cache file cannot inject malformed ids", async () => {
	const cacheDir = mkdtempSync(path.join(tmpdir(), "brigade-mcache-"));
	const credDir = mkdtempSync(path.join(tmpdir(), "brigade-nocred-"));
	const prevCache = process.env.BRIGADE_CACHE_DIR;
	const prevCred = process.env.BRIGADE_CLAUDE_CONFIG_DIR;
	process.env.BRIGADE_CACHE_DIR = cacheDir;
	process.env.BRIGADE_CLAUDE_CONFIG_DIR = credDir;
	__resetClaudeCliModelsCache();
	try {
		// These ids reach the picker, `brigade.json`, and the binary's `--model`
		// argv, so the cache is a trust boundary even though it is local.
		fs.writeFileSync(
			path.join(cacheDir, "claude-cli-models.json"),
			JSON.stringify({
				atMs: Date.now(),
				ids: [
					"../../etc/passwd",
					"claude- rm -rf /",
					"claude-a\nb",
					"gpt-4",
					`claude-${"x".repeat(200)}`,
					POST_RELEASE_MODEL, // the one legitimate entry
				],
			}),
		);
		const ids = await fetchClaudeCliModelIds({ force: true });
		assert.ok(ids.includes(POST_RELEASE_MODEL), "the well-formed id must survive");
		for (const bad of ["../../etc/passwd", "claude- rm -rf /", "claude-a\nb", "gpt-4"]) {
			assert.ok(!ids.includes(bad), `malformed id leaked: ${bad}`);
		}
		assert.ok(
			ids.every((id) => id.length <= 128),
			"an oversized id leaked",
		);
	} finally {
		if (prevCache === undefined) delete process.env.BRIGADE_CACHE_DIR;
		else process.env.BRIGADE_CACHE_DIR = prevCache;
		if (prevCred === undefined) delete process.env.BRIGADE_CLAUDE_CONFIG_DIR;
		else process.env.BRIGADE_CLAUDE_CONFIG_DIR = prevCred;
		__resetClaudeCliModelsCache();
		rmSync(cacheDir, { recursive: true, force: true });
		rmSync(credDir, { recursive: true, force: true });
	}
});
