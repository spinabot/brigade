import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runDream } from "./dream.js";
import { applyRetention, exportMemory, inspect, purge } from "./governance.js";
import { FactStore } from "./records.js";

/**
 * Tideline Step 24 — governance. The done-when: "purging a fact also removes its
 * derived citations (no resurrection in the next dream)." Plus retention TTL,
 * inspect provenance, and export.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-gov-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("governance — purge cascades along source_pointers", () => {
	it("purging a source hard-removes it AND every fact derived from it (no zombie)", () => {
		const store = new FactStore(dir);
		const src = store.write({ content: "I met Dana at the conference", segment: "context" });
		// A dream-derived fact that CITES the source.
		const derived = store.write({
			content: "Dana works in robotics",
			segment: "knowledge",
			sourcePointers: [src.memoryId],
		});
		// A second-order derivation (derived FROM the derived).
		const derived2 = store.write({
			content: "Dana is a robotics contact",
			segment: "knowledge",
			sourcePointers: [derived.memoryId],
		});
		const unrelated = store.write({ content: "I like green tea", segment: "preference" });

		const result = purge(store, src.memoryId);

		assert.equal(result.purged.length, 3, "exactly the three related facts are purged — not the unrelated one");
		assert.ok(result.purged.includes(src.memoryId), "the source is purged");
		assert.ok(result.purged.includes(derived.memoryId), "the derived citation is cascade-purged");
		assert.ok(result.purged.includes(derived2.memoryId), "the second-order derivation too");
		assert.ok(!result.purged.includes(unrelated.memoryId), "an unrelated fact is untouched");

		// HARD removed — not in readAll at all (crypto-shred, not archive).
		const remaining = store.readAll().map((r) => r.memoryId);
		assert.deepEqual(remaining, [unrelated.memoryId], "only the unrelated fact remains, by id");

		// And the next dream cannot resurrect the purged content — it's gone.
		runDream(store, { evictMinAgeMs: Number.POSITIVE_INFINITY });
		assert.equal(
			store.readAll().some((r) => /Dana/.test(r.content)),
			false,
			"no Dana fact resurrected by the dream",
		);
	});
});

describe("governance — retention TTL", () => {
	it("purges facts older than the TTL but retains confirmed beliefs", () => {
		const store = new FactStore(dir);
		// Confirm a belief (asserted 3×).
		store.write({ content: "I prefer dark roast", segment: "preference", subjectKey: "coffee" });
		store.write({ content: "I prefer dark roast", segment: "preference", subjectKey: "coffee" });
		store.write({ content: "I prefer dark roast", segment: "preference", subjectKey: "coffee" });
		store.write({ content: "transient note", segment: "context" });
		runDream(store, { now: Date.now(), evictMinAgeMs: Number.POSITIVE_INFINITY });

		// ttl 0 ⇒ everything is "expired", but the confirmed belief is retained.
		const result = applyRetention(store, { ttlMs: 0, now: Date.now() + 10_000 });
		assert.equal(result.purged.length, 1, "exactly the transient note is purged — the confirmed belief is retained");
		const survivors = store.readAll();
		assert.ok(
			survivors.some((r) => r.subjectKey === "coffee" && r.status === "confirmed"),
			"the confirmed belief is retained past TTL",
		);
		assert.ok(!survivors.some((r) => r.content === "transient note"), "the transient note purged");
	});

	it("scopes to `origin` — an owner-invoked retention NEVER purges a channel peer's facts", () => {
		const store = new FactStore(dir);
		const owner = { kind: "owner" } as const;
		const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
		store.write({ content: "owner old note", segment: "context", createdBy: owner });
		store.write({ content: "peer old note", segment: "context", createdBy: peer });

		// ttl 0 with a future `now` ⇒ both are "expired", BUT scoped to the owner.
		const result = applyRetention(store, { ttlMs: 0, now: Date.now() + 10_000, origin: owner });
		assert.equal(result.purged.length, 1, "only the owner fact was eligible");
		const survivors = store.readAll();
		assert.ok(survivors.some((r) => r.content === "peer old note"), "the channel peer's fact is untouched");
		assert.ok(!survivors.some((r) => r.content === "owner old note"), "the owner's old fact was purged");
	});

	it("the retention CASCADE stays in-origin — a peer fact DERIVED from an expired owner fact is NOT purged", () => {
		// The subtle breach: retention's source_pointers cascade must not reach
		// across principals (the direct purge() is global by design; retention is not).
		const store = new FactStore(dir);
		const owner = { kind: "owner" } as const;
		const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
		const ownerFact = store.write({ content: "owner source fact", segment: "context", createdBy: owner });
		// A PEER fact that cites the owner fact (cross-origin derivation).
		store.write({ content: "peer derived fact", segment: "knowledge", createdBy: peer, sourcePointers: [ownerFact.memoryId] });

		const result = applyRetention(store, { ttlMs: 0, now: Date.now() + 10_000, origin: owner });
		const survivors = store.readAll();
		assert.ok(!survivors.some((r) => r.content === "owner source fact"), "the expired owner seed was purged");
		assert.ok(
			survivors.some((r) => r.content === "peer derived fact"),
			"the PEER fact deriving from it SURVIVES — the cascade did not cross principals",
		);
		assert.equal(result.purged.length, 1, "exactly the owner seed was purged, nothing cross-origin");
	});
});

describe("governance — inspect + export", () => {
	it("inspect returns links, backlinks, and the citation graph", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "Project Atlas launched", segment: "knowledge" });
		const b = store.write({ content: "Atlas uses Rust", segment: "knowledge", sourcePointers: [a.memoryId] });
		const info = inspect(store, a.memoryId);
		assert.ok(info, "found");
		assert.deepEqual(info!.derives, [b.memoryId], "b derives from a");
		assert.equal(info!.derivedFrom.length, 0, "a derives from nothing");
		const infoB = inspect(store, b.memoryId);
		assert.deepEqual(infoB!.derivedFrom, [a.memoryId], "b cites a");
	});

	it("export dumps all records", () => {
		const store = new FactStore(dir);
		store.write({ content: "one", segment: "context" });
		store.write({ content: "two", segment: "context" });
		assert.equal(exportMemory(store).length, 2);
	});
});
