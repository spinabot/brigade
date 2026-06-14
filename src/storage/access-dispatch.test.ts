import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__resetAccessCacheForTests,
	addAllowFrom,
	approvePairingCode,
	awaitAccessFlush,
	isAllowed,
	primeAccessCacheFromRows,
	readAllowFrom,
	readPendingPairings,
	removeAllowFrom,
	upsertPairingRequest,
} from "../agents/channels/access-control/store.js";
import { __resetBootForTests } from "./boot.js";
import { __resetRuntimeContextForTests, setRuntimeContext } from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

// Convex-mode dispatch for channel access control: policy (normalisation,
// pruning, code generation) runs identically; persistence reconciles row
// sets through the store. Filesystem mode covered by access-control.test.ts.

interface ReconcileCall {
	channelId: string;
	accountId?: string | null;
	kind: string;
	rows: Array<{ senderId: string; code?: string }>;
}

class FakeChannelsApi {
	reconciles: ReconcileCall[] = [];
	async reconcileAccessRows(args: ReconcileCall): Promise<void> {
		this.reconciles.push(structuredClone(args));
	}
	async listAllAccessRows(): Promise<never[]> {
		return [];
	}
}

function installConvexContext(fake: FakeChannelsApi, stateDir: string): void {
	const store = { mode: "convex", channels: fake } as unknown as BrigadeStore;
	setRuntimeContext(
		Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
	);
}

describe("access-control dispatcher (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeChannelsApi;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-access-dispatch-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeChannelsApi();
	});

	afterEach(async () => {
		await awaitAccessFlush().catch(() => {});
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetAccessCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("addAllowFrom is visible immediately and reconciles the row set — zero files written", async () => {
		installConvexContext(fake, stateDir);
		const changed = addAllowFrom("whatsapp", "917702616808", null);
		assert.equal(changed, true);
		assert.equal(isAllowed("whatsapp", "917702616808", null), true);
		assert.deepEqual(readAllowFrom("whatsapp", null), ["917702616808"]);

		await awaitAccessFlush();
		assert.equal(fake.reconciles.length, 1);
		assert.equal(fake.reconciles[0]?.kind, "allow-from");
		assert.deepEqual(
			fake.reconciles[0]?.rows.map((r) => r.senderId),
			["917702616808"],
		);

		// THE strict-zero check: nothing under the state dir.
		assert.deepEqual(readdirSync(stateDir), []);
	});

	it("removeAllowFrom reconciles the shrunken set", async () => {
		installConvexContext(fake, stateDir);
		addAllowFrom("whatsapp", "111", null);
		addAllowFrom("whatsapp", "222", null);
		removeAllowFrom("whatsapp", "111", null);
		assert.deepEqual(readAllowFrom("whatsapp", null), ["222"]);

		await awaitAccessFlush();
		const last = fake.reconciles.at(-1);
		assert.deepEqual(last?.rows.map((r) => r.senderId), ["222"]);
	});

	it("pairing codes are minted locally, survive reconcile verbatim, and approve moves the sender", async () => {
		installConvexContext(fake, stateDir);
		const issued = upsertPairingRequest({ channelId: "whatsapp", senderId: "999" });
		assert.equal(issued.isNew, true);
		assert.equal(issued.code.length, 8);

		// Re-request returns the SAME stable code.
		const again = upsertPairingRequest({ channelId: "whatsapp", senderId: "999" });
		assert.equal(again.isNew, false);
		assert.equal(again.code, issued.code);

		const pending = readPendingPairings("whatsapp", null);
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.code, issued.code);

		const approved = approvePairingCode("whatsapp", issued.code, null);
		assert.equal(approved?.senderId, "999");
		assert.equal(isAllowed("whatsapp", "999", null), true);
		assert.equal(readPendingPairings("whatsapp", null).length, 0);

		await awaitAccessFlush();
		// The pairing reconciles carried the locally-minted code verbatim.
		const pairingReconciles = fake.reconciles.filter((r) => r.kind === "pairing");
		assert.ok(pairingReconciles.some((r) => r.rows.some((row) => row.code === issued.code)));
		// Nothing on disk.
		assert.deepEqual(readdirSync(stateDir), []);
	});

	it("boot hydration round-trips through primeAccessCacheFromRows", () => {
		installConvexContext(fake, stateDir);
		primeAccessCacheFromRows([
			{
				channelId: "whatsapp",
				accountId: "default",
				kind: "allow-from",
				senderId: "917702616808",
				createdAt: "2026-06-01T00:00:00.000Z",
				lastSeenAt: "2026-06-01T00:00:00.000Z",
			},
			{
				channelId: "whatsapp",
				accountId: "default",
				kind: "pairing",
				senderId: "555",
				code: "ABCDEFGH",
				createdAt: new Date().toISOString(),
				lastSeenAt: new Date().toISOString(),
			},
		]);
		assert.equal(isAllowed("whatsapp", "917702616808", null), true);
		const pending = readPendingPairings("whatsapp", null);
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.code, "ABCDEFGH");
	});

	it("filesystem mode untouched — files land on disk as today", () => {
		// No RuntimeContext installed: writes go to the tempdir state dir.
		addAllowFrom("fake", "abc", null);
		assert.equal(isAllowed("fake", "abc", null), true);
		assert.ok(readdirSync(stateDir).length > 0, "filesystem mode writes files");
		assert.equal(fake.reconciles.length, 0);
	});
});
