import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { handleMemoryManage, handleMemoryWrite } from "./memory-ops.js";

let prevStateDir: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-memory-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
});

test("memory.write persists a fact; memory.manage export shows it", async () => {
	const w = await handleMemoryWrite({ content: "the operator prefers tea", segment: "preference" });
	const memoryId = (w as { memoryId?: string }).memoryId;
	assert.ok(memoryId && memoryId.length > 0, `expected a memoryId, got ${JSON.stringify(w)}`);
	const ex = await handleMemoryManage({ action: "export" });
	assert.equal((ex as { ok?: boolean }).ok, true);
	assert.match(JSON.stringify(ex), /prefers tea/);
});

test("memory.manage inspect + purge round-trip a fact", async () => {
	const w = await handleMemoryWrite({ content: "deploy day is Tuesday", segment: "fact" });
	const id = (w as { memoryId: string }).memoryId;
	const ins = await handleMemoryManage({ action: "inspect", memory_id: id });
	assert.equal((ins as { ok?: boolean }).ok, true);
	const purged = await handleMemoryManage({ action: "purge", memory_id: id });
	assert.equal((purged as { ok?: boolean }).ok, true);
});

test("memory.manage dream runs without error", async () => {
	await handleMemoryWrite({ content: "the operator ships on Fridays", segment: "preference" });
	const d = await handleMemoryManage({ action: "dream" });
	assert.equal((d as { ok?: boolean }).ok, true);
});
