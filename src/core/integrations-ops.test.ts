import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { handleComposio, handleOauth } from "./integrations-ops.js";

let prevStateDir: string | undefined;
let prevComposioKey: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-integrations-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	prevComposioKey = process.env.COMPOSIO_API_KEY;
	process.env.BRIGADE_STATE_DIR = dir;
	delete process.env.COMPOSIO_API_KEY;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	if (prevComposioKey === undefined) delete process.env.COMPOSIO_API_KEY;
	else process.env.COMPOSIO_API_KEY = prevComposioKey;
});

test("composio apps without a key → ok:false (not configured), no crash", async () => {
	const r = (await handleComposio({ action: "apps" })) as { action: string; ok: boolean; message?: string };
	assert.equal(r.action, "apps");
	assert.equal(r.ok, false);
	assert.match(r.message ?? "", /not configured|key/i);
});

test("oauth status → returns a result without opening a listener", async () => {
	const r = await handleOauth({ action: "status" });
	assert.ok(r && typeof r === "object");
});
