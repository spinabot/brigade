import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { MemoryLink } from "./links.js";
import type { MemoryRecord } from "./records.js";
import { extractPinned, renderNote, writeVault } from "./vault.js";

/**
 * Tideline Step 21 — the Obsidian vault. Done-when: opens cleanly (valid
 * frontmatter + body) AND a human-edited pinned region survives a dream pass
 * (the 3-way merge).
 */

function rec(id: string, content: string, extra: Partial<MemoryRecord> = {}, links: MemoryLink[] = []): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment: "preference",
		tier: "long",
		importance: 0.7,
		decayRate: 0.02,
		accessCount: 0,
		createdAt: 1,
		lastAccessedAt: 1,
		lifecycle: "active",
		links,
		...extra,
	} as MemoryRecord;
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-vault-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("vault — render", () => {
	it("renders valid frontmatter with typed links + body", () => {
		const note = renderNote(rec("a1", "I prefer dark mode", { status: "confirmed" }, [{ kind: "relates", target: "b2" }]));
		assert.match(note, /^---\n/, "starts with frontmatter");
		assert.match(note, /\nid: a1\n/);
		assert.match(note, /\nsegment: preference\n/);
		assert.match(note, /\nstatus: confirmed\n/);
		assert.match(note, /links:\n {2}- "relates:b2"\n/, "typed link as a (quoted) frontmatter array item");
		assert.match(note, /\nI prefer dark mode\n/, "body present");
	});
});

describe("vault — 3-way merge (human edits survive a dream pass)", () => {
	it("a hand-edited pinned region is preserved when the system re-renders", () => {
		const r1 = rec("a1", "I prefer dark mode");
		writeVault(dir, [r1]);
		const file = path.join(dir, "a1.md");

		// Human edits the pinned region in Obsidian.
		const edited = fs.readFileSync(file, "utf8").replace(
			"%% pinned %%\n\n%% /pinned %%",
			"%% pinned %%\nNOTE: confirmed verbally on 2026-06-17\n%% /pinned %%",
		);
		fs.writeFileSync(file, edited);

		// A dream pass changes the fact (content + status) and re-renders.
		const r2 = rec("a1", "I prefer LIGHT mode now", { status: "confirmed", confidence: 0.9 });
		const result = writeVault(dir, [r2]);

		const after = fs.readFileSync(file, "utf8");
		assert.match(after, /NOTE: confirmed verbally on 2026-06-17/, "pinned hand-edit SURVIVED");
		assert.match(after, /I prefer LIGHT mode now/, "body updated by the system");
		assert.match(after, /\nstatus: confirmed\n/, "frontmatter updated by the system");
		assert.equal(result.mergedPinned, 1, "the merge reported preserving a pinned edit");
		// and the pinned content is exactly what the human wrote
		assert.equal(extractPinned(after)?.trim(), "NOTE: confirmed verbally on 2026-06-17");
	});

	it("a fresh note (no prior file) just renders the proposed note", () => {
		const result = writeVault(dir, [rec("z9", "new fact")]);
		assert.equal(result.written, 1);
		assert.equal(result.mergedPinned, 0);
	});
});

describe("vault — prune (no plaintext lingers after a crypto-shred)", () => {
	it("prune removes a stale SYSTEM note but NEVER a human-authored note", () => {
		// Production memoryIds are always `mem_<base36>_<rand>`; prune only touches that shape.
		const keep = "mem_keep1_a1b2c3";
		const gone = "mem_gone2_d4e5f6";
		writeVault(dir, [rec(keep, "I deploy on Fridays"), rec(gone, "secret to be shredded")], { prune: true });
		assert.ok(fs.existsSync(path.join(dir, `${keep}.md`)) && fs.existsSync(path.join(dir, `${gone}.md`)), "both rendered");
		// A human's OWN vault note (a Map-of-Content / index) must survive the prune.
		fs.writeFileSync(path.join(dir, "Index.md"), "# My memory map\n", "utf8");

		const result = writeVault(dir, [rec(keep, "I deploy on Fridays")], { prune: true });
		assert.equal(result.pruned, 1, "the purged fact's system note was pruned");
		assert.ok(fs.existsSync(path.join(dir, `${keep}.md`)), "the surviving fact's note stays");
		assert.ok(!fs.existsSync(path.join(dir, `${gone}.md`)), "the purged fact's PLAINTEXT note is gone");
		assert.ok(fs.existsSync(path.join(dir, "Index.md")), "a human-authored note is never pruned");
	});

	it("WITHOUT prune (the default) a stale note is left untouched — preserving prior behaviour", () => {
		writeVault(dir, [rec("keep1", "a"), rec("gone2", "b")]);
		const result = writeVault(dir, [rec("keep1", "a")]); // no prune
		assert.equal(result.pruned, undefined);
		assert.ok(fs.existsSync(path.join(dir, "gone2.md")), "stale note still present (default is non-destructive)");
	});

	it("prune never touches non-note files in the directory", () => {
		fs.writeFileSync(path.join(dir, "README.txt"), "hello");
		writeVault(dir, [rec("keep1", "a")], { prune: true });
		assert.ok(fs.existsSync(path.join(dir, "README.txt")), "a non-.md file is left alone");
	});
});
