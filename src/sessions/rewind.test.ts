/**
 * Rewinding a conversation.
 *
 * The design decision under test is that rewind is CONVERSATION-ONLY. Every
 * reported failure in this space across the field is a file-restore failure;
 * moving a pointer in an append-only tree cannot lose data, and `git` already
 * solves files better.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	abandonedByRewind,
	findOrphanedCompaction,
	filesTouchedAfter,
	pathToRoot,
	rewindTargets,
	type RewindEntry,
} from "./rewind.js";

const user = (id: string, parentId: string | null, text: string): RewindEntry => ({
	id,
	parentId,
	role: "user",
	content: [{ type: "text", text }],
});
const asst = (id: string, parentId: string, content: unknown[]): RewindEntry => ({
	id,
	parentId,
	role: "assistant",
	content,
});
const write = (path: string) => ({ type: "toolCall", name: "write", arguments: { path } });

/** u1 → a1 → u2 → a2 → u3 */
function linear(): RewindEntry[] {
	return [
		user("u1", null, "first ask"),
		asst("a1", "u1", [{ type: "text", text: "ok" }]),
		user("u2", "a1", "second ask"),
		asst("a2", "u2", [{ type: "text", text: "done" }]),
		user("u3", "a2", "third ask"),
	];
}

test("the rewind picker lists only the operator's own messages", () => {
	// "Go back to what I asked" is the question people have. A list of every
	// assistant and tool entry would be unreadable.
	const t = rewindTargets(linear());
	assert.deepEqual(t.map((x) => x.entryId), ["u1", "u2", "u3"]);
	assert.deepEqual(t.map((x) => x.ordinal), [1, 2, 3]);
	assert.equal(t[1]!.preview, "second ask");
});

test("previews are single-line and clipped", () => {
	const long = "a".repeat(500);
	const t = rewindTargets([user("u1", null, `line one\nline two ${long}`)]);
	assert.equal(t[0]!.preview.includes("\n"), false);
	assert.ok(t[0]!.preview.length <= 80);
	assert.ok(t[0]!.preview.endsWith("…"));
});

test("an empty message still gets a usable label", () => {
	assert.equal(rewindTargets([user("u1", null, "   ")])[0]!.preview, "(no text)");
});

test("the path to root is newest-first and complete", () => {
	assert.deepEqual(pathToRoot(linear(), "u3").map((e) => e.id), ["u3", "a2", "u2", "a1", "u1"]);
});

test("a corrupt parent cycle cannot hang the gateway", () => {
	// The transcript is a file an operator can hand-edit.
	const cyclic: RewindEntry[] = [
		{ id: "a", parentId: "b", role: "user" },
		{ id: "b", parentId: "a", role: "user" },
	];
	assert.ok(pathToRoot(cyclic, "a").length <= 2);
});

test("a missing parent stops the walk instead of throwing", () => {
	const orphan: RewindEntry[] = [{ id: "x", parentId: "gone", role: "user" }];
	assert.deepEqual(pathToRoot(orphan, "x").map((e) => e.id), ["x"]);
});

test("rewinding names what is being stepped away from, oldest first", () => {
	// Nothing is deleted — the abandoned branch stays in the file. Naming it is
	// what lets us summarise or report it rather than dropping it silently.
	const abandoned = abandonedByRewind(linear(), "u3", "u2");
	assert.deepEqual(abandoned.map((e) => e.id), ["a2", "u3"]);
});

test("rewinding to the current leaf abandons nothing", () => {
	assert.deepEqual(abandonedByRewind(linear(), "u3", "u3"), []);
});

/* ─────────── the compaction interaction — the part that matters ─────────── */

test("rewinding PAST a compaction drops the compaction from the path", () => {
	// This is the property that makes rewind safe here and unsafe in Claude
	// Code, whose summary root has no parent link and orphans the tree
	// (anthropics/claude-code#24471 — a multi-day session rewound to ~2
	// messages, with the real history intact but unreachable).
	//
	// Because compaction is an ordinary entry with a parent, a path that
	// predates it simply does not contain it: the summary disappears and the
	// full history returns, with no invalidation logic anywhere.
	const entries: RewindEntry[] = [
		user("u1", null, "first"),
		asst("a1", "u1", [{ type: "text", text: "ok" }]),
		{ id: "c1", parentId: "a1", type: "compaction", content: [{ type: "text", text: "SUMMARY" }] },
		user("u2", "c1", "after compaction"),
	];

	const beforeRewind = pathToRoot(entries, "u2").map((e) => e.type);
	assert.ok(beforeRewind.includes("compaction"), "the summary is on the live path");

	const afterRewind = pathToRoot(entries, "a1");
	assert.equal(
		afterRewind.some((e) => e.type === "compaction"),
		false,
		"rewinding past it takes a path that never included it",
	);
	assert.deepEqual(afterRewind.map((e) => e.id), ["a1", "u1"], "and the full history is back");
});

test("the compaction entry itself is never offered as a rewind target", () => {
	const entries: RewindEntry[] = [
		user("u1", null, "first"),
		{ id: "c1", parentId: "u1", type: "compaction", content: [{ type: "text", text: "S" }] },
	];
	assert.deepEqual(rewindTargets(entries).map((t) => t.entryId), ["u1"]);
});

/* ─────────── files are reported, never reverted ─────────── */

test("files written after the rewind point are NAMED, not restored", () => {
	// The honest half of the contract. Reverting them is what every other
	// harness gets wrong; naming them costs nothing and never destroys work.
	const entries: RewindEntry[] = [
		user("u1", null, "start"),
		asst("a1", "u1", [write("src/a.ts"), write("src/b.ts")]),
		user("u2", "a1", "more"),
		asst("a2", "u2", [write("src/c.ts")]),
	];
	assert.deepEqual(filesTouchedAfter(entries, "a2", "u1"), [
		"src/a.ts",
		"src/b.ts",
		"src/c.ts",
	]);
});

test("only WRITING tools count — a read is not a change to reconcile", () => {
	const entries: RewindEntry[] = [
		user("u1", null, "start"),
		asst("a1", "u1", [
			{ type: "toolCall", name: "read", arguments: { path: "src/only-read.ts" } },
			{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			write("src/written.ts"),
		]),
	];
	assert.deepEqual(filesTouchedAfter(entries, "a1", "u1"), ["src/written.ts"]);
});

test("duplicate writes to one file are reported once", () => {
	const entries: RewindEntry[] = [
		user("u1", null, "s"),
		asst("a1", "u1", [write("src/x.ts"), write("src/x.ts")]),
	];
	assert.deepEqual(filesTouchedAfter(entries, "a1", "u1"), ["src/x.ts"]);
});

test("malformed entries never throw", () => {
	const junk = [null, undefined, 42, { parentId: "x" }, { id: "a", content: 7 }] as unknown as RewindEntry[];
	assert.doesNotThrow(() => rewindTargets(junk));
	assert.doesNotThrow(() => pathToRoot(junk, "a"));
	assert.doesNotThrow(() => filesTouchedAfter(junk, "a", "a"));
});

/* ───────── the one-field bug that breaks everyone else ───────── */

test("an orphaned compaction is DETECTED, not silently obeyed", () => {
	// Claude Code writes its compaction boundary with `parentUuid: null`, which
	// severs the tree: measured across 91 real sessions, a naive parent walk
	// reached 21.4% of the conversation instead of 96.4%, and one session
	// reached 0.5%. The symptom is a rewind picker showing two messages for a
	// multi-day session whose history is intact on disk but unreachable.
	//
	// Pi sets `parentId: this.leafId`, so Brigade is structurally safe — but it
	// reads transcripts it did not write, so it checks rather than trusts.
	const severed: RewindEntry[] = [
		user("u1", null, "first"),
		asst("a1", "u1", [{ type: "text", text: "ok" }]),
		{ id: "c1", parentId: null, type: "compaction", content: [{ type: "text", text: "S" }] },
		user("u2", "c1", "after"),
	];
	const orphan = findOrphanedCompaction(severed);
	assert.ok(orphan, "a severed compaction must be reported");
	assert.equal(orphan!.id, "c1");

	// And the damage it would do is real: the walk cannot reach the history.
	assert.deepEqual(pathToRoot(severed, "u2").map((e) => e.id), ["u2", "c1"]);
});

test("a properly-linked compaction is not flagged", () => {
	// Pi's shape. `appendCompaction` sets `parentId: this.leafId`.
	const healthy: RewindEntry[] = [
		user("u1", null, "first"),
		{ id: "c1", parentId: "u1", type: "compaction", content: [{ type: "text", text: "S" }] },
		user("u2", "c1", "after"),
	];
	assert.equal(findOrphanedCompaction(healthy), undefined);
	// The whole history stays reachable.
	assert.deepEqual(pathToRoot(healthy, "u2").map((e) => e.id), ["u2", "c1", "u1"]);
});

test("a compaction as the very first entry is legitimate", () => {
	// A session resumed from a summary starts with one; it has no parent by
	// construction and must not be reported as damage.
	const first: RewindEntry[] = [
		{ id: "c1", parentId: null, type: "compaction", content: [{ type: "text", text: "S" }] },
		user("u1", "c1", "after"),
	];
	assert.equal(findOrphanedCompaction(first), undefined);
});
