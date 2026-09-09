import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";

import { buildGraph, neighbors, purge } from "../advanced.js";
import { FactStore, Tideline, recallWithGraph, type MemoryRecordOrigin } from "../index.js";

it("persists origin-scoped deduplication, typed links, recall and cascading deletion across reopens", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tideline-lifecycle-e2e-"));
	try {
		const now = 1_000_000;
		const owner: MemoryRecordOrigin = { kind: "owner" };
		const peer: MemoryRecordOrigin = {
			kind: "channel", channelId: "test", conversationId: "room", sessionKey: "session",
		};
		const store = new FactStore(dir, { now: () => now });
		const memory = Tideline.over(store);
		const source = memory.add({
			content: "Atlas releases require staging verification.", segment: "project", createdBy: owner,
		});
		const repeated = memory.remember({
			content: source.content, segment: "project", createdBy: owner,
		});
		const peerCopy = memory.add({
			content: source.content, segment: "project", createdBy: peer,
		});
		assert.equal(repeated.memoryId, source.memoryId, "an owner restatement reinforces the existing fact");
		assert.notEqual(peerCopy.memoryId, source.memoryId, "identical peer content retains a separate fact");

		const derived = memory.add({
			content: "A successful rehearsal enables production approval.",
			segment: "knowledge", createdBy: owner, sourcePointers: [source.memoryId],
		});
		const unrelated = memory.add({
			content: "Editor theme is charcoal.", segment: "preference", createdBy: owner,
		});
		const relation = { a: source.memoryId, b: derived.memoryId, kind: "causes" as const };
		assert.equal(store.linkRelated([relation]), 2, "the relation writes forward and inverse edges");
		assert.equal(store.linkRelated([relation]), 0, "repeating the relation is idempotent");

		const reopened = new FactStore(dir, { now: () => now });
		const reopenedMemory = Tideline.over(reopened);
		assert.equal(reopened.readAll().length, 4);
		assert.equal(reopenedMemory.inspect(source.memoryId)?.record.accessCount, 1, "dedup reinforcement persisted");
		assert.deepEqual(reopenedMemory.inspect(derived.memoryId)?.record.sourcePointers, [source.memoryId]);
		const ownerGraph = buildGraph(reopened.list({ origin: owner }));
		assert.deepEqual(neighbors(ownerGraph, source.memoryId, { direction: "out", kinds: ["causes"] }), [derived.memoryId]);
		assert.deepEqual(neighbors(ownerGraph, derived.memoryId, { direction: "out", kinds: ["caused_by"] }), [source.memoryId]);
		assert.equal(ownerGraph.byId.has(peerCopy.memoryId), false);

		const query = "what is connected to staging";
		// Disable vector recovery so the nonmatching fact must arrive through its
		// persisted typed edge. The relational query still exercises the route gate.
		const graphOptions = { limit: 5, seedCount: 1, minSim: 1.01 };
		const hits = recallWithGraph(reopened.list({ origin: owner }), query, graphOptions, now);
		assert.deepEqual(hits.map(({ record }) => record.memoryId).sort(), [source.memoryId, derived.memoryId].sort());
		assert.equal(hits.find(({ record }) => record.memoryId === derived.memoryId)?.viaGraph, true);
		assert.deepEqual(
			reopenedMemory.recall("staging", { origin: peer, markAccessed: false }).map(({ memoryId }) => memoryId),
			[peerCopy.memoryId],
		);
		assert.deepEqual(
			reopenedMemory.recall("staging", { origin: { ...peer, sessionKey: "another-session" }, markAccessed: false }),
			[],
		);

		// Governance removes the source and its cited derivation from the active
		// store. The unrelated peer copy has no citation and remains independent.
		assert.deepEqual(purge(reopened, source.memoryId).purged.sort(), [source.memoryId, derived.memoryId].sort());
		const afterPurge = new FactStore(dir, { now: () => now });
		const afterPurgeMemory = Tideline.over(afterPurge);
		assert.deepEqual(afterPurge.readAll().map(({ memoryId }) => memoryId).sort(), [peerCopy.memoryId, unrelated.memoryId].sort());
		assert.equal(afterPurgeMemory.inspect(source.memoryId), undefined);
		assert.equal(afterPurgeMemory.inspect(derived.memoryId), undefined);
		assert.deepEqual(recallWithGraph(afterPurge.list({ origin: owner }), query, graphOptions, now), []);
		assert.deepEqual(afterPurgeMemory.search("staging", { origin: owner, markAccessed: false }), []);
		assert.deepEqual(
			afterPurgeMemory.recall("staging", { origin: peer, markAccessed: false }).map(({ memoryId }) => memoryId),
			[peerCopy.memoryId],
		);
		assert.deepEqual(purge(afterPurge, source.memoryId).purged, [], "repeating deletion cannot remove a survivor");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
