import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../memory/records.js";
import { makeManageMemoryTool } from "./manage-memory-tool.js";

/** The live operator surface for Tideline Phase-3 maintenance/governance.
 *  Proves the tool drives the underlying dream/governance correctly + is owner-gated. */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mm-tool-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const details = async (action: string, extra: Record<string, unknown> = {}) => {
	const tool = makeManageMemoryTool(dir);
	const res = await tool.execute("call-1", { action, ...extra } as never);
	return (res as { details: Record<string, unknown> }).details;
};

describe("manage_memory tool", () => {
	it("is owner-gated", () => {
		assert.equal(makeManageMemoryTool(dir).ownerOnly, true);
	});

	it("action=dream confirms a repeatedly-asserted belief", async () => {
		const store = new FactStore(dir);
		for (let i = 0; i < 3; i++) store.write({ content: "I prefer spaces", segment: "preference", subjectKey: "indent" });
		const d = await details("dream");
		assert.equal(d.ok, true);
		assert.equal(d.confirmed, 1, "the 3×-asserted belief was confirmed");
		assert.equal(new FactStore(dir).list()[0]?.status, "confirmed");
	});

	it("action=purge crypto-shreds the fact AND its derived citations", async () => {
		const store = new FactStore(dir);
		const src = store.write({ content: "met Dana", segment: "context" });
		store.write({ content: "Dana does robotics", segment: "knowledge", sourcePointers: [src.memoryId] });
		const d = await details("purge", { memory_id: src.memoryId });
		assert.equal(d.ok, true);
		assert.equal((d.purged as string[]).length, 2, "source + derived both shredded");
		assert.equal(new FactStore(dir).readAll().length, 0, "hard-removed, not archived");
	});

	it("action=inspect returns provenance; action=export dumps facts", async () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "Atlas launched", segment: "knowledge" });
		store.write({ content: "Atlas uses Rust", segment: "knowledge", sourcePointers: [a.memoryId] });
		const ins = await details("inspect", { memory_id: a.memoryId });
		assert.equal(ins.ok, true);
		assert.equal((ins.derives as string[]).length, 1, "one fact derives from it");
		const exp = await details("export");
		assert.equal(exp.count, 2);
	});

	it("purge/inspect/retract/restore without memory_id, and retention without ttl_days, return ok:false (not a throw)", async () => {
		assert.equal((await details("purge")).ok, false);
		assert.equal((await details("inspect")).ok, false);
		assert.equal((await details("retention")).ok, false);
		assert.equal((await details("retract")).ok, false);
		assert.equal((await details("restore")).ok, false);
	});

	it("action=vault writes notes AND preserves a human-pinned edit on re-render (the 3-way merge)", async () => {
		const store = new FactStore(dir);
		store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy" });
		const v1 = await details("vault");
		assert.equal(v1.ok, true);
		// 3 notes written: the fact note + 1 topic-hub note for the "deploy" subject (the hubs
		// cluster the graph) + 1 root "Memory Map" note (the graph's centre that links the hub).
		// A Map is written whenever ≥1 subject exists, and this fact carries subjectKey "deploy".
		assert.equal(v1.written, 3);

		// hand-edit the pinned region, then re-render — the edit MUST survive verbatim.
		const vaultDir = v1.dir as string;
		// Target the FACT note (not the topic-hub) — the hub also carries a pinned region, so select
		// by the fact sentinel to stay deterministic regardless of readdir order.
		const noteFile = fs.readdirSync(vaultDir).find((f) => f.endsWith(".md") && fs.readFileSync(path.join(vaultDir, f), "utf8").includes("%% tideline:fact %%"));
		assert.ok(noteFile, "a fact note was written");
		const full = path.join(vaultDir, noteFile as string);
		fs.writeFileSync(
			full,
			fs.readFileSync(full, "utf8").replace("%% pinned %%\n\n%% /pinned %%", "%% pinned %%\nMY HAND NOTE\n%% /pinned %%"),
		);
		const v2 = await details("vault");
		assert.equal(v2.mergedPinned, 1, "the hand edit was detected + preserved");
		assert.match(fs.readFileSync(full, "utf8"), /MY HAND NOTE/, "the pinned edit survived the re-render");
	});

	it("Lane B: propose surfaces a down-voted fact; retract archives it reversibly; restore brings it back", async () => {
		const store = new FactStore(dir);
		const f = store.write({ content: "always deploy straight to prod", segment: "preference", subjectKey: "deploy-policy" });
		for (let i = 0; i < 3; i++) store.applyFeedback(f.memoryId, "down"); // 3 down-votes ⇒ proposed

		const prop = await details("propose");
		assert.equal(prop.ok, true);
		assert.equal(prop.count, 1, "the 3×-down-voted fact is proposed for retraction");
		assert.equal((prop.proposals as Array<{ target: string }>)[0]?.target, f.memoryId);

		const ret = await details("retract", { memory_id: f.memoryId });
		assert.equal(ret.ok, true);
		assert.equal(new FactStore(dir).list().length, 0, "retracted ⇒ no longer active in recall");

		const res = await details("restore", { memory_id: f.memoryId });
		assert.equal(res.ok, true);
		assert.equal(new FactStore(dir).list()[0]?.memoryId, f.memoryId, "restored ⇒ active again (reversible)");
	});

	it("Lane B: propose returns nothing when no fact crosses the down-vote threshold", async () => {
		const store = new FactStore(dir);
		const f = store.write({ content: "use 2-space indent", segment: "preference" });
		store.applyFeedback(f.memoryId, "down"); // only 1 — below the threshold of 3
		const prop = await details("propose");
		assert.equal(prop.ok, true);
		assert.equal(prop.count, 0, "one down-vote is not enough to propose a change");
	});
});
