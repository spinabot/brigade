import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { MemoryLink, MemoryLinkKind } from "./links.js";
import type { MemoryRecord } from "./records.js";
import { extractPinned, renderNote, writeVault } from "./vault.js";

/**
 * Tideline Step 21 — the Obsidian vault. Done-when: opens cleanly (valid
 * frontmatter + body) AND a human-edited pinned region survives a dream pass
 * (the 3-way merge) AND it renders a CONNECTED, CLUSTERED graph — readable
 * content-derived filenames, `## Related` `[[wikilinks]]`, `topic/<subject>`
 * tags, and per-subject topic-hub notes (what Obsidian's graph draws edges
 * from; YAML string links are ignored by the graph view).
 */

/** The single fact note in `d` (the `.md` whose body carries the fact sentinel
 *  but NOT the hub sentinel) — filenames are content-derived now, so tests
 *  locate notes by scanning rather than by a hard-coded memoryId name. */
function factNotes(d: string): string[] {
	return fs
		.readdirSync(d)
		.filter((f) => f.endsWith(".md"))
		.filter((f) => {
			const md = fs.readFileSync(path.join(d, f), "utf8");
			return md.includes("%% tideline:fact %%");
		});
}

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
	it("renders valid frontmatter with the machine-readable typed links + body", () => {
		// NOTE: the machine-readable YAML `links:` array is PRESERVED (Bases/queries
		// read it) — the graph view ignores it, so the `## Related` wikilinks below
		// are what actually draw edges. `b2` is absent from the (omitted) name map,
		// so no `## Related` section renders here; that is covered by the next test.
		const note = renderNote(rec("a1", "I prefer dark mode", { status: "confirmed" }, [{ kind: "relates", target: "b2" }]));
		assert.match(note, /^---\n/, "starts with frontmatter");
		assert.match(note, /\nid: a1\n/);
		assert.match(note, /\nsegment: preference\n/);
		assert.match(note, /\nstatus: confirmed\n/);
		assert.match(note, /\ntags: \[preference\]\n/, "segment tag present");
		assert.match(note, /links:\n {2}- "relates:b2"\n/, "typed link as a (quoted) frontmatter array item PRESERVED");
		assert.match(note, /\nI prefer dark mode\n/, "body present");
		assert.doesNotMatch(note, /## Related/, "no Related section when the link target is out of the name map");
	});

	it("renders REAL [[wikilinks]] in a `## Related` section when targets resolve", () => {
		// A name map resolving the targets → readable filenames is what lets the
		// graph draw edges (Obsidian only edges off body wikilinks).
		const names = new Map<string, string>([
			["b2", "I deploy on Fridays"],
			["c3", "the API base url is example dot com"],
		]);
		const note = renderNote(
			rec("a1", "I prefer dark mode", { subjectKey: "ui_theme" }, [
				{ kind: "relates", target: "b2" },
				{ kind: "supersedes", target: "c3" },
				{ kind: "relates", target: "missing9" }, // not in the map → skipped (no phantom node)
			]),
			names,
		);
		assert.match(note, /## Related/, "Related section present");
		assert.match(note, /- supersedes: \[\[the API base url is example dot com\]\]/, "supersedes wikilink (ordered first)");
		assert.match(note, /- relates: \[\[I deploy on Fridays\]\]/, "relates wikilink resolved to the readable filename");
		// `missing9` is dropped from the graph-drawing WIKILINKS (no dangling [[…]]
		// phantom node), though it stays in the machine-readable YAML `links:` array.
		const related = note.slice(note.indexOf("## Related"));
		assert.doesNotMatch(related, /missing9/, "an out-of-scope link target is skipped from the wikilinks");
		assert.match(note, /\ntags: \[topic\/ui_theme, preference\]\n/, "topic + segment tags");
	});

	it("tags an archived fact #archived and keeps it renderable (graph shows history)", () => {
		const note = renderNote(rec("h1", "I used to deploy on Mondays", { lifecycle: "archived" }));
		assert.match(note, /\nlifecycle: archived\n/);
		assert.match(note, /\ntags: \[preference, archived\]\n/, "#archived tag present for non-active facts");
	});
});

describe("vault — 3-way merge (human edits survive a dream pass)", () => {
	it("a hand-edited pinned region is preserved when the system re-renders", () => {
		const r1 = rec("a1", "I prefer dark mode");
		writeVault(dir, [r1]);
		// Filenames are content-derived now — locate the fact note by scan rather
		// than by the old `<memoryId>.md` convention.
		const names = factNotes(dir);
		assert.equal(names.length, 1, "exactly one fact note written");
		const file = path.join(dir, names[0]!);

		// Human edits the pinned region in Obsidian.
		const edited = fs.readFileSync(file, "utf8").replace(
			"%% pinned %%\n\n%% /pinned %%",
			"%% pinned %%\nNOTE: confirmed verbally on 2026-06-17\n%% /pinned %%",
		);
		fs.writeFileSync(file, edited);

		// A dream pass PROMOTES the fact (status + confidence) and re-renders. The
		// content is stable, so the content-derived filename is stable too — the
		// merge re-finds the SAME note and splices the pin back in. (A reworded fact
		// is a SUPERSEDE = a new memoryId/new note, not an in-place content rewrite.)
		const r2 = rec("a1", "I prefer dark mode", { status: "confirmed", confidence: 0.9 });
		const result = writeVault(dir, [r2]);

		const after = fs.readFileSync(file, "utf8");
		assert.match(after, /NOTE: confirmed verbally on 2026-06-17/, "pinned hand-edit SURVIVED");
		assert.match(after, /I prefer dark mode/, "body present after re-render");
		assert.match(after, /\nstatus: confirmed\n/, "frontmatter updated by the system");
		assert.match(after, /\nconfidence: 0.9\n/, "confidence updated by the system");
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
	it("prune removes a stale SYSTEM note (detected by sentinel, not filename) but NEVER a human-authored note", () => {
		// Filenames are content-derived now; prune recognises a system note by its
		// embedded sentinel, so a readable name like `secret to be shredded.md` is
		// still removable while a human's own (sentinel-less) note is not.
		const keepFile = path.join(dir, "I deploy on Fridays.md");
		const goneFile = path.join(dir, "secret to be shredded.md");
		writeVault(dir, [rec("mem_keep1_a1b2c3", "I deploy on Fridays"), rec("mem_gone2_d4e5f6", "secret to be shredded")], { prune: true });
		assert.ok(fs.existsSync(keepFile) && fs.existsSync(goneFile), "both rendered with readable, content-derived filenames");
		// A human's OWN vault note (a Map-of-Content / index) must survive the prune.
		fs.writeFileSync(path.join(dir, "Index.md"), "# My memory map\n", "utf8");

		const result = writeVault(dir, [rec("mem_keep1_a1b2c3", "I deploy on Fridays")], { prune: true });
		assert.equal(result.written, 1, "exactly one note written in the second pass");
		assert.equal(result.mergedPinned, 0, "no pinned edits to preserve");
		assert.equal(result.pruned, 1, "the purged fact's system note was pruned");
		assert.ok(fs.existsSync(keepFile), "the surviving fact's note stays");
		assert.ok(!fs.existsSync(goneFile), "the purged fact's PLAINTEXT note is gone");
		assert.ok(fs.existsSync(path.join(dir, "Index.md")), "a human-authored note (no sentinel) is never pruned");
	});

	it("WITHOUT prune (the default) a stale note is left untouched — preserving prior behaviour", () => {
		writeVault(dir, [rec("keep1", "alpha fact"), rec("gone2", "beta fact")]);
		const result = writeVault(dir, [rec("keep1", "alpha fact")]); // no prune
		assert.equal(result.written, 1, "exactly one note written");
		assert.equal(result.mergedPinned, 0, "no pinned edits to preserve");
		assert.equal(result.pruned, undefined);
		assert.ok(fs.existsSync(path.join(dir, "beta fact.md")), "stale note still present (default is non-destructive)");
	});

	it("prune never touches non-note files in the directory", () => {
		fs.writeFileSync(path.join(dir, "README.txt"), "hello");
		const result = writeVault(dir, [rec("keep1", "a")], { prune: true });
		assert.equal(result.pruned, 0, "no system notes were pruned — README.txt is not a system fact note");
		assert.ok(fs.existsSync(path.join(dir, "README.txt")), "a non-.md file is left alone");
	});
});

describe("vault — clusters (topic hubs make the graph cluster)", () => {
	it("writes one topic-hub note per subject that wikilinks every fact sharing it", () => {
		// Two facts share subject `ui_theme`; one has a different subject `deploy_day`.
		const result = writeVault(
			dir,
			[
				rec("m1", "I prefer dark mode", { subjectKey: "ui_theme" }),
				rec("m2", "editor uses the dark theme", { subjectKey: "ui_theme" }),
				rec("m3", "I deploy on Fridays", { subjectKey: "deploy_day" }),
			],
			{ prune: true },
		);
		assert.equal(result.hubs, 2, "one hub per distinct subject");

		// The ui_theme hub exists and links BOTH its member facts (cluster anchor).
		const hub = fs.readFileSync(path.join(dir, "topic — ui_theme.md"), "utf8");
		assert.match(hub, /%% tideline:hub %%/, "hub carries the hub sentinel (prunable, distinct from a human note)");
		assert.match(hub, /tags: \[topic\/ui_theme, hub\]/, "hub is tagged with its topic");
		assert.match(hub, /- \[\[I prefer dark mode\]\]/, "hub wikilinks member 1");
		assert.match(hub, /- \[\[editor uses the dark theme\]\]/, "hub wikilinks member 2");

		// Each member fact tags its topic AND backlinks the hub (two-way edge).
		const fact = fs.readFileSync(path.join(dir, "I prefer dark mode.md"), "utf8");
		assert.match(fact, /tags: \[topic\/ui_theme, preference\]/, "fact carries the topic tag");
		assert.match(fact, /Topic: \[\[topic — ui_theme\]\]/, "fact backlinks its topic hub");
	});

	it("prunes a topic hub whose subject no longer has any facts", () => {
		writeVault(dir, [rec("m1", "I prefer dark mode", { subjectKey: "ui_theme" })], { prune: true });
		assert.ok(fs.existsSync(path.join(dir, "topic — ui_theme.md")), "hub created");
		// Re-render with the only ui_theme fact replaced by a different-subject fact.
		const result = writeVault(dir, [rec("m2", "I deploy on Fridays", { subjectKey: "deploy_day" })], { prune: true });
		assert.ok(!fs.existsSync(path.join(dir, "topic — ui_theme.md")), "the now-empty topic hub was pruned");
		assert.ok(fs.existsSync(path.join(dir, "topic — deploy_day.md")), "the new topic hub exists");
		assert.equal(result.hubs, 1);
	});

	it("a supersede pair both render and stay linked (graph shows history)", () => {
		// m_new supersedes m_old; m_old is archived but still rendered (#archived).
		writeVault(
			dir,
			[
				rec("m_new", "I deploy on Mondays", { subjectKey: "deploy_day", supersedes: ["m_old"] }),
				rec("m_old", "I deploy on Fridays", { subjectKey: "deploy_day", lifecycle: "archived" }),
			],
			{ prune: true },
		);
		const newer = fs.readFileSync(path.join(dir, "I deploy on Mondays.md"), "utf8");
		const older = fs.readFileSync(path.join(dir, "I deploy on Fridays.md"), "utf8");
		assert.match(newer, /## Related\n- supersedes: \[\[I deploy on Fridays\]\]/, "the supersede edge is a real wikilink");
		// topic + segment + archived — the segment tag always renders; #archived marks the history.
		assert.match(older, /tags: \[topic\/deploy_day, preference, archived\]/, "the superseded fact is tagged #archived but still present");
	});
});

describe("vault — Related renders ALL typed edge kinds as wikilinks", () => {
	it("supersedes / corrects / transition / contradicts / derived_from / supports / relates ALL become [[wikilinks]]", () => {
		// Every NON-derived kind is set explicitly via `links`; `supersedes` is the
		// derived kind (mirrored from the record's `supersedes[]` by linksFrom), so it
		// is supplied via the supersedes ARRAY, not links. All seven must wikilink.
		const explicit: MemoryLinkKind[] = ["corrects", "transition", "contradicts", "derived_from", "supports", "relates"];
		const links: MemoryLink[] = explicit.map((kind, i) => ({ kind, target: `t_${kind}_${i}` }));
		const names = new Map<string, string>([["t_sup", "the superseded belief"]]);
		for (const l of links) names.set(l.target, `note for ${l.kind}`);
		const note = renderNote(rec("hub_all", "a fact that links every which way", { supersedes: ["t_sup"] }, links), names);
		assert.match(note, /## Related/, "Related section present");
		// supersedes (the derived kind) renders first per LINK_KIND_ORDER.
		assert.match(note, /- supersedes: \[\[the superseded belief\]\]/, "supersedes (derived) wikilink");
		for (const kind of explicit) {
			assert.match(note, new RegExp(`- ${kind}: \\[\\[note for ${kind}\\]\\]`), `${kind} wikilink`);
		}
		// Sanity: exactly 7 edge lines (the 6 explicit + 1 derived supersede).
		const relatedLines = note.slice(note.indexOf("## Related")).split("\n").filter((l) => l.startsWith("- "));
		assert.equal(relatedLines.length, 7, "all seven typed kinds rendered, none dropped");
	});
});

describe("vault — Map (root MOC connects the hubs into one web)", () => {
	// A unit vector along axis `i` (width 4) — lets a test PIN cosine deterministically
	// (two equal vectors → cos 1; orthogonal axes → cos 0) without depending on the
	// bundled embedder's exact output. buildBridges prefers a record's stored embedding.
	const axis = (i: number): number[] => [0, 1, 2, 3].map((k) => (k === i ? 1 : 0));

	it("writes a Memory Map note that carries the map sentinel and links every hub grouped by segment", () => {
		const result = writeVault(
			dir,
			[
				rec("i1", "my name is Kartheek", { segment: "identity", subjectKey: "owner_name" }),
				rec("i2", "I live in Hyderabad", { segment: "identity", subjectKey: "home_city" }),
				rec("p1", "I prefer dark mode", { segment: "preference", subjectKey: "ui_theme" }),
			],
			{ prune: true },
		);
		// fact notes (3) + hubs (3) + Map (1) = 7.
		assert.equal(result.written, 7, "3 facts + 3 hubs + 1 Map");
		assert.equal(result.hubs, 3);

		const mapFile = path.join(dir, "Memory Map.md");
		assert.ok(fs.existsSync(mapFile), "the root Map note (ASCII-safe filename) was written");
		const map = fs.readFileSync(mapFile, "utf8");
		assert.match(map, /%% tideline:map %%/, "Map carries the map sentinel (so a stale Map is prunable)");
		assert.match(map, /^# 🗺️ Memory Map$/m, "emoji lives in the H1, never the filename");
		// Grouped under per-segment headings — identity sorts before preference.
		assert.match(map, /## identity/, "identity cluster heading");
		assert.match(map, /## preference/, "preference cluster heading");
		assert.ok(map.indexOf("## identity") < map.indexOf("## preference"), "identity cluster precedes preference");
		// Links EVERY hub, with the active-fact count.
		assert.match(map, /- \[\[topic — owner_name\]\] \(1 active fact\)/, "links the owner_name hub w/ count");
		assert.match(map, /- \[\[topic — home_city\]\] \(1 active fact\)/, "links the home_city hub w/ count");
		assert.match(map, /- \[\[topic — ui_theme\]\] \(1 active fact\)/, "links the ui_theme hub w/ count");
	});

	it("each hub backlinks UP to the Map and ACROSS to its same-segment siblings", () => {
		writeVault(
			dir,
			[
				rec("i1", "my name is Kartheek", { segment: "identity", subjectKey: "owner_name" }),
				rec("i2", "I live in Hyderabad", { segment: "identity", subjectKey: "home_city" }),
				rec("p1", "I prefer dark mode", { segment: "preference", subjectKey: "ui_theme" }),
			],
			{ prune: true },
		);
		const ownerNameHub = fs.readFileSync(path.join(dir, "topic — owner_name.md"), "utf8");
		assert.match(ownerNameHub, /Part of: \[\[Memory Map\]\]/, "hub links UP to the Map");
		// owner_name + home_city share the identity segment → they interlink ACROSS.
		assert.match(ownerNameHub, /Related topics:/, "hub has a Related topics section");
		assert.match(ownerNameHub, /- \[\[topic — home_city\]\]/, "hub links its same-segment sibling");
		assert.doesNotMatch(ownerNameHub, /- \[\[topic — ui_theme\]\]/, "hub does NOT link a DIFFERENT-segment hub");
		// The lone preference hub has no sibling → no across-links, but still links UP.
		const uiHub = fs.readFileSync(path.join(dir, "topic — ui_theme.md"), "utf8");
		assert.match(uiHub, /Part of: \[\[Memory Map\]\]/, "the lone hub still links UP to the Map");
		assert.doesNotMatch(uiHub, /Related topics:/, "a segment with one topic has no sibling links");
	});

	it("prune recognises + removes a STALE Map note when every subject is gone", () => {
		// First pass: a subject exists → a Map is written.
		writeVault(dir, [rec("m1", "I prefer dark mode", { subjectKey: "ui_theme" })], { prune: true });
		const mapFile = path.join(dir, "Memory Map.md");
		assert.ok(fs.existsSync(mapFile), "Map written while a subject exists");
		// Second pass: the only fact now has NO subject → no hubs, no Map to centre.
		const result = writeVault(dir, [rec("m2", "a subjectless note", {})], { prune: true });
		assert.ok(!fs.existsSync(mapFile), "the now-stale Map note was pruned (recognised by its sentinel)");
		assert.ok(!fs.existsSync(path.join(dir, "topic — ui_theme.md")), "the now-empty hub was pruned too");
		assert.equal(result.hubs, undefined, "no hubs in the second pass");
	});

	it("a human's OWN map-of-content note (no sentinel) is NEVER pruned even when named like the Map", () => {
		// A human keeps their own MOC. It carries no system sentinel, so the prune leaves it.
		fs.writeFileSync(path.join(dir, "My Index.md"), "# My hand-built map\n[[whatever]]\n", "utf8");
		writeVault(dir, [rec("m1", "I prefer dark mode", { subjectKey: "ui_theme" })], { prune: true });
		assert.ok(fs.existsSync(path.join(dir, "My Index.md")), "a human MOC (no sentinel) survives the prune");
	});

	it("a Map's human-pinned region survives a re-render (the 3-way merge applies to the Map too)", () => {
		writeVault(dir, [rec("m1", "I prefer dark mode", { subjectKey: "ui_theme" })], { prune: true });
		const mapFile = path.join(dir, "Memory Map.md");
		const edited = fs
			.readFileSync(mapFile, "utf8")
			.replace("%% pinned %%\n\n%% /pinned %%", "%% pinned %%\nMAP NOTE: my mental model\n%% /pinned %%");
		fs.writeFileSync(mapFile, edited);
		writeVault(dir, [rec("m1", "I prefer dark mode", { subjectKey: "ui_theme" })], { prune: true });
		assert.match(fs.readFileSync(mapFile, "utf8"), /MAP NOTE: my mental model/, "the Map's pinned edit survived");
	});

	it("a subjectless-only store writes NO Map (nothing to centre) — count unchanged", () => {
		const result = writeVault(dir, [rec("a", "one"), rec("b", "two")], { prune: true });
		assert.equal(result.written, 2, "2 fact notes, no hubs, no Map");
		assert.ok(!fs.existsSync(path.join(dir, "Memory Map.md")), "no Map when there are no subjects");
	});

	describe("semantic bridges (conservative, embedder-guarded)", () => {
		it("links two genuinely-near same-origin facts with a relates (bridge) edge", () => {
			// Two facts with IDENTICAL pinned embeddings (cos 1.0 ≥ the 0.6 bar) + a third
			// orthogonal one. No typed edge between any. The near pair bridges; the far one doesn't.
			writeVault(
				dir,
				[
					rec("a", "the deploy pipeline runs nightly", { embedding: axis(0) }),
					rec("b", "nightly the pipeline deploys", { embedding: axis(0) }),
					rec("c", "the office cat is named Mochi", { embedding: axis(1) }),
				],
				{ prune: true },
			);
			const a = fs.readFileSync(path.join(dir, "the deploy pipeline runs nightly.md"), "utf8");
			const b = fs.readFileSync(path.join(dir, "nightly the pipeline deploys.md"), "utf8");
			const c = fs.readFileSync(path.join(dir, "the office cat is named Mochi.md"), "utf8");
			// SYMMETRIC: the bridge renders from BOTH near notes.
			assert.match(a, /## Related\n- relates \(bridge\): \[\[nightly the pipeline deploys\]\]/, "a→b bridge");
			assert.match(b, /## Related\n- relates \(bridge\): \[\[the deploy pipeline runs nightly\]\]/, "b→a bridge");
			// The orthogonal fact gets NO bridge (below the high cosine bar).
			assert.doesNotMatch(c, /relates \(bridge\)/, "an unrelated fact forms no bridge");
		});

		it("never bridges across origins (owner vs channel peer) even at cosine 1.0", () => {
			const owner = { kind: "owner" } as const;
			const peer = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" } as const;
			writeVault(
				dir,
				[
					rec("o", "identical text here", { embedding: axis(0), createdBy: owner }),
					rec("p", "identical text here too", { embedding: axis(0), createdBy: peer }),
				],
				{ prune: true },
			);
			const o = fs.readFileSync(path.join(dir, "identical text here.md"), "utf8");
			assert.doesNotMatch(o, /relates \(bridge\)/, "cross-origin facts are never bridged (isolation preserved)");
		});

		it("a bridge never duplicates an existing typed edge between the same pair", () => {
			// a already `relates` b via a typed link AND they share an embedding — no second
			// (bridge) edge should appear; the typed `relates` stands alone.
			writeVault(
				dir,
				[
					rec("a", "first related fact", { embedding: axis(0) }, [{ kind: "relates", target: "b" }]),
					rec("b", "second related fact", { embedding: axis(0) }),
				],
				{ prune: true },
			);
			const a = fs.readFileSync(path.join(dir, "first related fact.md"), "utf8");
			assert.match(a, /- relates: \[\[second related fact\]\]/, "the typed relates edge renders");
			assert.doesNotMatch(a, /relates \(bridge\)/, "no duplicate bridge edge for an already-typed pair");
		});
	});
});
