import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveSessionsDir } from "../config/paths.js";
import { handleSessionsCleanup, parseDuration } from "./sessions-ops.js";

let prevStateDir: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-sessions-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
});

function seed(agentId: string, sessionId: string, ageDays: number): void {
	const dir = resolveSessionsDir(agentId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, "{}\n");
	const t = new Date(Date.now() - ageDays * 86_400_000);
	utimesSync(file, t, t);
}

test("parseDuration: units + invalid", () => {
	assert.equal(parseDuration("30d"), 30 * 86_400_000);
	assert.equal(parseDuration("12h"), 12 * 3_600_000);
	assert.equal(parseDuration("2w"), 2 * 604_800_000);
	assert.equal(parseDuration("nope"), null);
});

test("invalid olderThan → ok:false", () => {
	const r = handleSessionsCleanup({ olderThan: "soon" });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /olderThan/);
});

test("dry-run lists stale + deletes nothing; real run deletes stale, keeps fresh", () => {
	seed("main", "old-session", 40);
	seed("main", "fresh-session", 1);

	const dry = handleSessionsCleanup({ olderThan: "30d", dryRun: true });
	assert.equal(dry.ok, true);
	assert.equal(dry.deleted, 0);
	assert.deepEqual(dry.wouldDelete, ["old-session"]);

	const real = handleSessionsCleanup({ olderThan: "30d" });
	assert.equal(real.deleted, 1);
	assert.equal(real.candidates, 1);

	// fresh-session survives → a second pass finds nothing
	assert.equal(handleSessionsCleanup({ olderThan: "30d" }).candidates, 0);
});
