import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ConvexConfigStore } from "./config-store.js";

// Final-audit fix: brigadeConfigBackups was schema-only (listBackups returned
// [] and restoreBackup hard-threw). The `write` mutation now captures a backup
// ring server-side; these tests lock the adapter read side (listBackups
// passthrough + restoreBackup parse / error paths). Server-side rotation is
// exercised by the live smoke.

function makeStore(queryResult: unknown) {
	const client = {
		async query(_ref: unknown, _args: Record<string, unknown>) {
			return queryResult;
		},
		async mutation() {
			return undefined;
		},
	};
	return new ConvexConfigStore({ client: client as never, instanceId: "inst-1" });
}

describe("ConvexConfigStore backups", () => {
	it("listBackups passes the ring through (slot 0 = newest)", async () => {
		const store = makeStore([
			{ slot: 0, sha256: "aaa", mtimeMs: 200, bytes: 12 },
			{ slot: 1, sha256: "bbb", mtimeMs: 100, bytes: 11 },
		]);
		const rows = await store.listBackups();
		assert.equal(rows.length, 2);
		assert.equal(rows[0]?.slot, 0);
		assert.equal(rows[0]?.sha256, "aaa");
		assert.equal(rows[1]?.slot, 1);
	});

	it("restoreBackup parses the snapshot payload into a config", async () => {
		const snapshot = { agents: { main: { defaultProvider: "anthropic" } }, version: 1 };
		const store = makeStore({ payload: JSON.stringify(snapshot), sha256: "aaa" });
		const cfg = await store.restoreBackup(0);
		assert.deepEqual(cfg, snapshot);
	});

	it("restoreBackup throws when the slot is empty", async () => {
		const store = makeStore(null);
		await assert.rejects(() => store.restoreBackup(3), /no backup at slot 3/);
	});

	it("restoreBackup throws on an unparseable payload", async () => {
		const store = makeStore({ payload: "{not json", sha256: "aaa" });
		await assert.rejects(() => store.restoreBackup(0), /unparseable/);
	});
});
