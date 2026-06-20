import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runCurator } from "./curator.js";
import { FactStore } from "./records.js";

/** Tideline Step 34 — the curator runs the dream's maintenance and aggregates. */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-curator-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("curator", () => {
	it("confirms a repeated belief and reports the aggregate", () => {
		const store = new FactStore(dir);
		store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy" });
		store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy" });
		store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy" });

		const result = runCurator(store, { dream: { now: Date.now(), evictMinAgeMs: Number.POSITIVE_INFINITY } });
		assert.equal(result.origins, 1, "one pass (single owner origin in the store)");
		assert.equal(result.confirmed, 1, "the repeated belief confirmed");
		assert.equal(result.activeAfter, 1, "reports active count after the pass — exactly 1 fact (dedup collapsed the 3 identical writes into one)");
		assert.equal(store.list()[0]?.status, "confirmed");
	});

	it("default fans out PER ORIGIN and NEVER merges across principals", () => {
		const store = new FactStore(dir);
		const owner = { kind: "owner" } as const;
		const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
		// IDENTICAL belief under two origins, each asserted 3×.
		for (let i = 0; i < 3; i++) store.write({ content: "deploy on Monday", segment: "preference", subjectKey: "day", createdBy: owner });
		for (let i = 0; i < 3; i++) store.write({ content: "deploy on Monday", segment: "preference", subjectKey: "day", createdBy: peer });
		assert.equal(store.list().length, 2, "the two origins' beliefs coexist (slot-supersede is origin-scoped)");

		const result = runCurator(store, { dream: { now: Date.now(), evictMinAgeMs: Number.POSITIVE_INFINITY } });
		assert.equal(result.origins, 2, "fanned out over owner + the channel peer");
		assert.equal(result.confirmed, 2, "confirmed in BOTH origins independently");
		assert.equal(store.list().length, 2, "identical facts under different origins were NOT merged across principals");
	});

	it("explicit empty origins is a no-op (not a whole-store pass)", () => {
		const store = new FactStore(dir);
		store.write({ content: "x", segment: "context" });
		const result = runCurator(store, { origins: [] });
		assert.equal(result.origins, 0, "no passes run");
		assert.equal(result.confirmed, 0);
	});

	it("vaultDir re-renders the owner vault when the pass CHANGED facts — and skips an idle pass", () => {
		const vaultDir = path.join(dir, "memory-vault");

		// An idle pass (nothing to confirm/merge/evict) writes NO vault — no churn.
		const idle = new FactStore(dir);
		idle.write({ content: "a one-off note", segment: "context" });
		const r0 = runCurator(idle, { dream: { now: Date.now(), evictMinAgeMs: Number.POSITIVE_INFINITY }, vaultDir });
		assert.equal(r0.confirmed + r0.consolidated + r0.evicted, 0, "nothing changed this pass");
		assert.equal(r0.vaultWritten, undefined, "idle pass did NOT touch the vault");
		assert.ok(!fs.existsSync(vaultDir), "no vault dir created on an idle pass");

		// A changing pass (3× repeated belief ⇒ confirmed) re-renders the vault.
		const store = new FactStore(dir);
		for (let i = 0; i < 3; i++) store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy" });
		const r1 = runCurator(store, { dream: { now: Date.now(), evictMinAgeMs: Number.POSITIVE_INFINITY }, vaultDir });
		assert.equal(r1.confirmed, 1, "the belief was confirmed (a change)");
		// The graph renderer writes a note per active fact, one topic-hub note per distinct
		// subject (the hubs cluster the graph), AND one root MAP note (the graph's centre that
		// links every hub). Here: 2 fact notes (the no-subject one-off + the "deploy" confirmed
		// fact) + 1 hub note (the "deploy" subject) + 1 Map note = 4. (A Map is written whenever
		// at least one subject exists — the "deploy" fact carries subjectKey, so a hub + Map appear.)
		assert.equal(r1.vaultWritten, 4, "vault re-rendered after the change — 2 fact notes + 1 topic-hub (deploy) + 1 Memory Map");
		assert.ok(fs.existsSync(vaultDir), "vault dir created on a changing pass");
		assert.equal(fs.readdirSync(vaultDir).filter((f) => f.endsWith(".md")).length, 4, "4 .md notes on disk — 2 fact notes + 1 topic-hub (the 'deploy' subject) + 1 Memory Map");
	});
});
