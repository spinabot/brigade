import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetFactsCacheForTests, awaitFactsFlush } from "../../storage/facts-cache.js";
import {
	__resetRuntimeContextForTests,
	createRuntimeContext,
	setRuntimeContext,
} from "../../storage/runtime-context.js";
import type { BrigadeStore } from "../../storage/store.js";
import { FactStore, type MemoryRecordOrigin } from "./records.js";

/**
 * Dual-mode RUNTIME proof — "nothing broken in both modes" sweep.
 *
 * SCOPE: this proves the convex-mode `FactStore` mode-branch is recall-NEUTRAL
 * over the LIVE in-process cache — i.e. serving reads from the boot-hydrated
 * cache and writing through (cache + row mutations) yields the SAME recall
 * ranking + the SAME origin isolation as the filesystem JSONL path. It does NOT
 * exercise the backend round-trip (hydrate-from-rows / flatten→reconstruct
 * MARSHALLING) — that is covered by the cross-mode parity gate
 * (storage/convex/memory-parity.test.ts). No live convex backend needed here —
 * a fake store records the write-through; the live cache IS the seam under test.
 */

const owner: MemoryRecordOrigin = { kind: "owner" };
const chan: MemoryRecordOrigin = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" };

/** Minimal convex-mode store: `mode` + the two memory write-through sinks the
 *  facts-cache calls. Records upserts so we can assert the write reached the backend. */
function makeConvexStore() {
	const upserts: Array<{ ws: string; rec: unknown }> = [];
	const deletes: Array<{ ws: string; id: string }> = [];
	const store = {
		mode: "convex",
		init: async () => {},
		memory: {
			upsertFactRecordRaw: async (ws: string, rec: unknown) => {
				upserts.push({ ws, rec });
			},
			deleteFactRecordRaw: async (ws: string, id: string) => {
				deletes.push({ ws, id });
			},
		},
	} as unknown as BrigadeStore;
	return { store, upserts, deletes };
}

/** Seed a fixed corpus + run a fixed recall battery. Returns observable recall
 *  behavior (rankings as content, isolation as counts) so two modes compare 1:1.
 *  NOTE: every search passes `markAccessed: false` — the markAccessed
 *  write-through (last-accessed bump → row mutation) is intentionally OUT OF
 *  SCOPE here; this sweep asserts only recall-neutrality of the read/write path. */
function seedAndRecall(store: FactStore) {
	store.write({ content: "I live in Hyderabad, India.", segment: "identity", createdBy: owner });
	store.write({ content: "I prefer tabs over spaces when coding.", segment: "preference", createdBy: owner });
	store.write({ content: "I now work at Beta Labs as a staff engineer.", segment: "project", createdBy: owner });
	store.write({ content: "this peer likes dark mode themes.", segment: "preference", createdBy: chan });
	return {
		liveRanking: store.search("where do I live", { origin: owner, markAccessed: false }).map((r) => r.content),
		tabsRanking: store.search("tabs or spaces", { origin: owner, markAccessed: false }).map((r) => r.content),
		ownerSeesPeer: store.search("dark mode themes", { origin: owner, markAccessed: false }).length,
		peerSeesOwner: store.search("Beta Labs staff engineer", { origin: chan, markAccessed: false }).length,
		peerSeesOwn: store.search("dark mode themes", { origin: chan, markAccessed: false }).length,
	};
}

let dir: string;
beforeEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-dualmode-"));
});
afterEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("dual-mode runtime — recall identical + isolated in BOTH modes", () => {
	it("filesystem mode: write → search works, origin-isolated", () => {
		const r = seedAndRecall(new FactStore(path.join(dir, "fsws"))); // no runtime ctx → fs mode
		assert.equal(r.liveRanking.length, 1);
		assert.equal(r.liveRanking[0], "I live in Hyderabad, India.");
		assert.equal(r.tabsRanking.length, 1);
		assert.equal(r.tabsRanking[0], "I prefer tabs over spaces when coding.");
		assert.equal(r.ownerSeesPeer, 0, "owner must NOT recall the peer's fact");
		assert.equal(r.peerSeesOwner, 0, "peer must NOT recall owner facts");
		assert.equal(r.peerSeesOwn, 1, "peer DOES recall its own fact");
	});

	it("convex mode: same flow over the hydrated cache → IDENTICAL recall + isolation", async () => {
		// fs baseline FIRST (no runtime context yet → filesystem mode)
		const fsResult = seedAndRecall(new FactStore(path.join(dir, "fsws")));

		// flip to convex mode with an injected fake store
		const { store: cxStore, upserts } = makeConvexStore();
		setRuntimeContext(await createRuntimeContext({ store: cxStore, stateDir: dir }));
		const cxResult = seedAndRecall(new FactStore(path.join(dir, "cxws"))); // convex mode → cache
		await awaitFactsFlush();

		// the convex storage path must change NEITHER recall ranking NOR isolation
		assert.deepEqual(cxResult, fsResult, "convex-mode recall must be identical to fs-mode");
		// and the write-through actually reached the backend — count AND payload
		// fidelity (catch a write-through field-drop): the seeded content must
		// arrive verbatim, and the channel fact must carry its channel origin in
		// `createdBy` (origin isolation depends on this surviving the write).
		assert.strictEqual(upserts.length, 4, `convex write-through enqueued the fact upserts (got ${upserts.length})`);
		const payloads = upserts.map((u) => u.rec as { content?: string; createdBy?: MemoryRecordOrigin });
		const contents = payloads.map((p) => p.content);
		assert.ok(
			contents.includes("I live in Hyderabad, India."),
			"owner-seeded content must reach the backend verbatim",
		);
		assert.ok(
			contents.includes("this peer likes dark mode themes."),
			"channel-seeded content must reach the backend verbatim",
		);
		const peerPayload = payloads.find((p) => /dark mode themes/.test(p.content ?? ""));
		assert.ok(peerPayload, "channel fact must be among the upserts");
		assert.deepEqual(peerPayload!.createdBy, chan, "channel-fact upsert must carry the channel origin in createdBy");
	});
});
