import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readAllowFrom, readPendingPairings, upsertPairingRequest } from "../../agents/channels/access-control/index.js";
import { __resetConfigParseCacheForTests } from "../../config/io.js";
import { runChannelsAllowAdd, runChannelsAllowList, runChannelsAllowRemove } from "./channels.js";
import { runPairingApprove, runPairingList, runPairingRevoke } from "./pairing.js";

let tmpRoot: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "brigade-cli-pair-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	__resetConfigParseCacheForTests();
});
afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	__resetConfigParseCacheForTests();
	rmSync(tmpRoot, { recursive: true, force: true });
});

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const chunks: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	(process.stdout.write as unknown as (s: string) => boolean) = (s) => {
		chunks.push(typeof s === "string" ? s : String(s));
		return true;
	};
	return fn()
		.then((result) => ({ result, out: chunks.join("") }))
		.finally(() => {
			process.stdout.write = orig;
		});
}

describe("brigade pairing list/approve/revoke", () => {
	it("approve moves the sender into allow-from + drops the pending code", async () => {
		const { code } = upsertPairingRequest({ channelId: "whatsapp", senderId: "alice", senderName: "Alice" });
		const exit = await runPairingApprove({ code, channel: "whatsapp" }, { json: true });
		assert.equal(exit, 0);
		assert.deepEqual(readAllowFrom("whatsapp"), ["alice"]);
		assert.deepEqual(readPendingPairings("whatsapp"), []);
	});

	it("approve returns exit 1 on an unknown code", async () => {
		const exit = await runPairingApprove({ code: "BOGUSXYZ", channel: "whatsapp" }, { json: true });
		assert.equal(exit, 1);
	});

	it("revoke drops a pending code without granting access", async () => {
		const { code } = upsertPairingRequest({ channelId: "whatsapp", senderId: "alice" });
		const exit = await runPairingRevoke({ code, channel: "whatsapp" }, { json: true });
		assert.equal(exit, 0);
		assert.deepEqual(readAllowFrom("whatsapp"), []); // NOT allowlisted
		assert.deepEqual(readPendingPairings("whatsapp"), []);
	});

	it("list emits the pending codes in JSON", async () => {
		upsertPairingRequest({ channelId: "whatsapp", senderId: "alice" });
		const { result, out } = await captureStdout(() => runPairingList({ channel: "whatsapp" }, { json: true }));
		assert.equal(result, 0);
		const parsed = JSON.parse(out) as { channel: string; pending: { senderId: string }[] };
		assert.equal(parsed.channel, "whatsapp");
		assert.equal(parsed.pending[0]?.senderId, "alice");
	});

	it("auto-picks the only available channel when --channel is omitted", async () => {
		const { code } = upsertPairingRequest({ channelId: "whatsapp", senderId: "alice" });
		const exit = await runPairingApprove({ code }, { json: true });
		assert.equal(exit, 0);
		assert.deepEqual(readAllowFrom("whatsapp"), ["alice"]);
	});
});

describe("brigade channels allow list/add/remove", () => {
	it("add → list round-trip", async () => {
		assert.equal(await runChannelsAllowAdd({ id: "+15551234567", channel: "whatsapp" }, { json: true }), 0);
		const { result, out } = await captureStdout(() =>
			runChannelsAllowList({ channel: "whatsapp" }, { json: true }),
		);
		assert.equal(result, 0);
		const parsed = JSON.parse(out) as { allowFrom: string[] };
		assert.deepEqual(parsed.allowFrom, ["+15551234567"]);
	});

	it("remove drops the sender (exit 0); removing a non-member exits 1", async () => {
		await runChannelsAllowAdd({ id: "alice", channel: "whatsapp" }, { json: true });
		assert.equal(await runChannelsAllowRemove({ id: "alice", channel: "whatsapp" }, { json: true }), 0);
		assert.equal(await runChannelsAllowRemove({ id: "alice", channel: "whatsapp" }, { json: true }), 1);
		assert.deepEqual(readAllowFrom("whatsapp"), []);
	});
});
