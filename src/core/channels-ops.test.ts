import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { handleChannelsAllowAdd, handleChannelsAllowList, handleChannelsAllowRemove } from "./channels-ops.js";

let prevStateDir: string | undefined;
beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "brigade-channels-ops-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
});

test("allow-add → allow-list shows it → allow-remove clears it", () => {
	assert.equal(handleChannelsAllowAdd({ channel: "whatsapp", senderId: "1234@s.whatsapp.net" }).ok, true);
	assert.deepEqual(handleChannelsAllowList({ channel: "whatsapp" }).senders, ["1234@s.whatsapp.net"]);
	const rm = handleChannelsAllowRemove({ channel: "whatsapp", senderId: "1234@s.whatsapp.net" });
	assert.equal(rm.ok, true);
	assert.equal(rm.changed, true);
	assert.deepEqual(handleChannelsAllowList({ channel: "whatsapp" }).senders, []);
});

test("allow-add missing senderId → ok:false", () => {
	assert.equal(handleChannelsAllowAdd({ channel: "whatsapp" }).ok, false);
});

test("allow-remove a non-member → ok:false", () => {
	assert.equal(handleChannelsAllowRemove({ channel: "whatsapp", senderId: "nobody" }).ok, false);
});

test("allow-list missing channel → throws", () => {
	assert.throws(() => handleChannelsAllowList({}), /missing 'channel'/);
});
