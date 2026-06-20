import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { exportMemoryGraph } from "./graph-export.js";
import { FactStore } from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-graphexport-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("exportMemoryGraph", () => {
	it("builds nodes/edges/clusters/stats; linked facts share a cluster; byType counts", () => {
		const store = new FactStore(dir, { now: () => 1000 });
		// Two linked groups + an unrelated singleton.
		const a1 = store.write({ content: "Deploy ships on Friday", segment: "project" }).memoryId;
		const a2 = store.write({ content: "Friday deploy needs a rollback plan", segment: "project" }).memoryId;
		const b1 = store.write({ content: "I prefer dark mode", segment: "preference" }).memoryId;
		const b2 = store.write({ content: "Dark mode in the editor too", segment: "preference" }).memoryId;
		store.write({ content: "Unrelated mountain weather note", segment: "knowledge" });
		store.linkRelated([{ a: a1, b: a2 }]); // group A
		store.linkRelated([{ a: b1, b: b2 }]); // group B

		const g = exportMemoryGraph(store.readAll(), { now: 1000 });
		assert.equal(g.stats.totalMemories, 5, "5 active facts");
		assert.equal(g.stats.connections, 2, "the relates edges are counted (deduped): exactly 2 unordered pairs");
		assert.equal(g.nodes.length, 5);

		const cl = (id: string): string | undefined => g.nodes.find((n) => n.id === id)?.clusterId;
		assert.equal(cl(a1), cl(a2), "group A clustered together");
		assert.equal(cl(b1), cl(b2), "group B clustered together");
		assert.notEqual(cl(a1), cl(b1), "the two groups are different clusters");

		assert.equal(g.stats.byType.project, 2, "segment breakdown counts project facts");
		assert.equal(g.stats.byType.preference, 2);
		assert.equal(g.stats.byType.knowledge, 1);
		assert.equal(g.stats.addedLast7d, 5, "all created at 'now' → within 7d");

		const relatesEdge = g.edges.find((e) => e.kind === "relates");
		assert.ok(relatesEdge, "a relates edge is present");
		assert.equal(relatesEdge!.strength, "weak", "a relates edge maps to the 'weak' line style");
		assert.equal(g.clusters.length, 3, "exactly 3 communities: group A (size 2), group B (size 2), singleton (size 1)");
		// Clusters are sorted descending by size: the two linked pairs (size 2) come before the singleton (size 1).
		assert.equal(g.clusters[0]!.size, 2, "first cluster has 2 members");
		assert.equal(g.clusters[1]!.size, 2, "second cluster has 2 members");
		assert.equal(g.clusters[2]!.size, 1, "third cluster is the singleton");
		assert.ok(g.clusters.every((c) => c.label.length > 0), "every cluster has a non-empty label");
	});

	it("maxNodes caps the viz node set but stats/clusters use the full set", () => {
		const store = new FactStore(dir, { now: () => 1000 });
		for (let i = 0; i < 10; i++) store.write({ content: `distinct fact ${i}`, segment: "knowledge", importance: i / 10 });
		const g = exportMemoryGraph(store.readAll(), { now: 1000, maxNodes: 3 });
		assert.equal(g.nodes.length, 3, "viz node set capped to maxNodes");
		assert.equal(g.stats.totalMemories, 10, "stats computed over the full active set");
	});

	it("excludes archived facts + dangling edges to them", () => {
		const store = new FactStore(dir, { now: () => 1000 });
		const x = store.write({ content: "I live in Lisbon", segment: "identity" }).memoryId;
		store.write({ content: "I live in Tokyo now", segment: "identity", supersedes: [x] }); // archives x
		const g = exportMemoryGraph(store.readAll(), { now: 1000 });
		assert.equal(g.nodes.length, 1, "exactly 1 active fact after archiving x");
		assert.ok(!g.nodes.some((n) => n.id === x), "the archived (superseded) fact is not a node");
		assert.equal(g.edges.length, 0, "no edges: the supersedes edge targets an archived fact and is excluded");
		assert.ok(!g.edges.some((e) => e.from === x || e.to === x), "no edge dangles to the archived fact");
	});
});
