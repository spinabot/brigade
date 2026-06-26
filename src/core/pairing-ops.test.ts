import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { handlePairingApprove, handlePairingList, handlePairingRevoke } from "./pairing-ops.js";

let prevStateDir: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-pairing-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
});

test("list: missing channel → throws", () => {
	assert.throws(() => handlePairingList({}), /missing 'channel'/);
});

test("list: channel with no pending → empty", () => {
	assert.deepEqual(handlePairingList({ channel: "whatsapp" }).pending, []);
});

test("approve: missing channel or code → ok:false (no store touch)", async () => {
	assert.equal((await handlePairingApprove({ channel: "whatsapp" })).ok, false);
	assert.equal((await handlePairingApprove({ code: "ABC12345" })).ok, false);
});

test("approve: unknown code → ok:false (returns before adapter load)", async () => {
	const r = await handlePairingApprove({ channel: "whatsapp", code: "BOGUSXYZ" });
	assert.equal(r.ok, false);
	assert.match(r.reason ?? "", /unknown or expired/);
});

test("revoke: missing or unknown code → ok:false", () => {
	assert.equal(handlePairingRevoke({ channel: "whatsapp" }).ok, false);
	assert.equal(handlePairingRevoke({ channel: "whatsapp", code: "NOPE0000" }).ok, false);
});
