import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetFactsCacheForTests, awaitFactsFlush } from "../../storage/facts-cache.js";
import { __resetRuntimeContextForTests, createRuntimeContext, setRuntimeContext } from "../../storage/runtime-context.js";
import type { BrigadeStore } from "../../storage/store.js";
import { FactStore, type MemoryRecordOrigin } from "./records.js";

/**
 * Convex HYBRID lane integration (Tideline v2). Proves the runtime path:
 * `FactStore.write` runs embed-on-write in BOTH modes (storing a 256-dim vector,
 * which Convex's `by_embedding` vectorIndex ANN-serves at scale), and
 * `searchHybrid` fuses BM25 ⊕ vector to recover a paraphrase BM25 misses —
 * IDENTICALLY in fs and convex mode (the cross-mode-parity guarantee; fs cosine-
 * scans the same vectors in-app). No live backend: the boot-hydrated cache is the
 * seam, same as dual-mode-recall.test.ts.
 */

const owner: MemoryRecordOrigin = { kind: "owner" };

function makeConvexStore() {
	// Capture every record handed to the convex write-through seam. This pins the
	// write-through FORWARD path (writeThroughFactsCache's by-memoryId diff +
	// field-forwarding into the enqueued upsertFactRecordRaw op), so a silent
	// field-drop (embedding / createdBy / segment) BEFORE the row marshaller shows
	// up HERE — not in the in-memory readAll mirror, which is the same object
	// write() just populated and would pass even with a broken marshaller. The
	// actual recordToRowArgs ↔ rowToRecord row marshalling + AAD/HKDF sealing is
	// covered separately by memory-parity.test.ts.
	const captured: Array<{ workspaceId: string; record: Record<string, unknown> }> = [];
	const store = {
		mode: "convex",
		init: async () => {},
		memory: {
			upsertFactRecordRaw: async (workspaceId: string, record: Record<string, unknown>) => {
				captured.push({ workspaceId, record });
			},
			deleteFactRecordRaw: async () => {},
		},
	} as unknown as BrigadeStore;
	return { store, captured };
}

let dir: string;
beforeEach(() => {
	__resetRuntimeContextForTests();
	__resetFactsCacheForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-hybridcx-"));
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

describe("convex hybrid lane — embed-on-write + searchHybrid", () => {
	it("convex mode: embed-on-write marshals 256-dim HRR vectors THROUGH the seam; hybrid ranks + isolates", async () => {
		const { store: cxStore, captured } = makeConvexStore();
		setRuntimeContext(await createRuntimeContext({ store: cxStore, stateDir: dir }));
		const store = new FactStore(path.join(dir, "cxws"));
		store.write({ content: "I reside in Hyderabad, India", segment: "identity", createdBy: owner });
		store.write({ content: "I prefer tabs over spaces when coding", segment: "preference", createdBy: owner });
		store.write({ content: "I drink black coffee with no sugar", segment: "preference", createdBy: owner });
		await awaitFactsFlush();

		// The write-through forward path actually RAN: each record enqueued for
		// upsertFactRecordRaw carries the 256-dim embedding + its origin + segment.
		// A field-drop in writeThroughFactsCache's forward path would fail here (the
		// in-memory readAll mirror could not catch it — same object as the write).
		assert.equal(captured.length, 3, "all three writes flushed through the convex seam");
		assert.ok(
			captured.every((c) => Array.isArray(c.record.embedding) && (c.record.embedding as number[]).length === 256),
			"each MARSHALLED payload carries a 256-dim HRR embedding",
		);
		assert.ok(
			captured.every((c) => (c.record.createdBy as { kind?: string } | undefined)?.kind === "owner"),
			"each marshalled payload carries the owner origin (isolation survives marshalling)",
		);
		assert.deepEqual(
			captured.map((c) => c.record.segment),
			["identity", "preference", "preference"],
			"segment marshalled with the exact segment values from the write calls",
		);

		// A content-token query ranks the coffee fact via BM25 (a bag-of-words
		// embedder does NOT beat BM25 on synonymy — that needs a learned model). This
		// asserts the live recall MECHANISM + origin isolation, not vector magic.
		const hyb = store.searchHybrid("black coffee", { origin: owner, markAccessed: false });
		assert.equal(hyb[0]?.content, "I drink black coffee with no sugar", "hybrid ranks the coffee fact first with its exact content");

		const peer = store.searchHybrid("black coffee", {
			origin: { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" },
			markAccessed: false,
		});
		assert.equal(peer.length, 0, "hybrid recall respects origin isolation");
	});

	it("filesystem mode ALSO embeds-on-write (both-modes hybrid → cross-mode parity)", () => {
		const store = new FactStore(path.join(dir, "fsws")); // no runtime ctx → fs mode
		store.write({ content: "I reside in Hyderabad, India", segment: "identity", createdBy: owner });
		store.write({ content: "I drink black coffee with no sugar", segment: "preference", createdBy: owner });
		assert.ok(
			store.readAll().every((r) => Array.isArray(r.embedding) && r.embedding.length === 256),
			"fs mode ALSO embeds (both-modes hybrid → identical recall fs ↔ convex)",
		);
		const hyb = store.searchHybrid("Hyderabad", { origin: owner, markAccessed: false });
		assert.equal(hyb[0]?.content, "I reside in Hyderabad, India", "fs hybrid ranks the matching fact with its exact content");
	});
});
