// src/agents/memory/vault.ts
//
// Tideline Step 21 — the Obsidian markdown vault.
//
// Renders each fact as a markdown note: YAML frontmatter (id / segment / tier /
// status + typed `links` as a Bases-friendly array) over the content body,
// followed by a PINNED region the human owns.
//
// 3-WAY MERGE (the load-bearing property): the dream/system PROPOSES a fresh
// render, but a human-edited PINNED region (between the `%% pinned %%` markers)
// is spliced back in verbatim — the system never clobbers hand edits. So
// re-rendering after a dream pass updates the frontmatter + body while the
// human's notes survive untouched. In convex mode the vault is a read-only
// render (filesystem is the source of truth); only `writeVault` mutates disk.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { linksFrom } from "./links.js";
import type { MemoryRecord } from "./records.js";

const PIN_OPEN = "%% pinned %%";
const PIN_CLOSE = "%% /pinned %%";

function yamlValue(v: string): string {
	// Bare when unambiguous; otherwise a JSON string IS a valid YAML double-quoted
	// scalar — it escapes backslash, quote, AND control chars (newline/tab/…),
	// which a hand-rolled quote-only escape would corrupt into invalid frontmatter.
	return /^[A-Za-z0-9 _./-]+$/.test(v) ? v : JSON.stringify(v);
}

function renderFrontmatter(r: MemoryRecord): string {
	const lines = ["---", `id: ${yamlValue(r.memoryId)}`, `segment: ${r.segment}`, `tier: ${r.tier}`];
	// Mark non-active (retracted/archived) notes so the vault distinguishes a live fact
	// from restorable history rather than rendering them identically.
	if (r.lifecycle && r.lifecycle !== "active") lines.push(`lifecycle: ${r.lifecycle}`);
	if (r.status) lines.push(`status: ${r.status}`);
	if (r.subjectKey) lines.push(`subject: ${yamlValue(r.subjectKey)}`);
	if (typeof r.confidence === "number") lines.push(`confidence: ${r.confidence}`);
	const links = linksFrom(r);
	if (links.length > 0) {
		lines.push("links:");
		for (const l of links) lines.push(`  - ${yamlValue(`${l.kind}:${l.target}`)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

/** Render a fact to a full markdown note (frontmatter + body + empty pin region). */
export function renderNote(r: MemoryRecord): string {
	return `${renderFrontmatter(r)}\n\n${r.content}\n\n${PIN_OPEN}\n\n${PIN_CLOSE}\n`;
}

/** Index of the LAST line that is EXACTLY `marker` (after trim), or -1. */
function lastMarkerLine(lines: string[], marker: string): number {
	for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() === marker) return i;
	return -1;
}

/**
 * Extract the pinned region's INNER text. LINE-ANCHORED: the open marker is the
 * LAST line that is exactly `%% pinned %%`, the close is the first subsequent line
 * exactly `%% /pinned %%` — so a marker token embedded MID-LINE in the human's own
 * prose (or in a fact body that discusses the `%%` comment syntax) is NOT treated as
 * a delimiter and cannot truncate/hijack the region. Missing close → captures
 * OPEN→EOF rather than discarding edits. `undefined` when there is no open-marker line.
 */
export function extractPinned(md: string): string | undefined {
	const lines = md.split("\n");
	const open = lastMarkerLine(lines, PIN_OPEN);
	if (open === -1) return undefined;
	let close = lines.length;
	for (let i = open + 1; i < lines.length; i++) {
		if (lines[i]!.trim() === PIN_CLOSE) {
			close = i;
			break;
		}
	}
	return lines.slice(open + 1, close).join("\n");
}

/**
 * 3-way merge: take the `proposed` render but splice the EXISTING note's pinned
 * region back in, so a human edit survives a re-render. Line-anchored (matches
 * extractPinned). No existing note / no pin region → `proposed` unchanged.
 */
export function mergeNote(existing: string | undefined, proposed: string): string {
	if (!existing) return proposed;
	const pinned = extractPinned(existing);
	if (pinned === undefined) return proposed;
	const lines = proposed.split("\n");
	const open = lastMarkerLine(lines, PIN_OPEN);
	if (open === -1) return proposed;
	let close = lines.length;
	for (let i = open + 1; i < lines.length; i++) {
		if (lines[i]!.trim() === PIN_CLOSE) {
			close = i;
			break;
		}
	}
	const tail = close < lines.length ? lines.slice(close) : [];
	return [...lines.slice(0, open + 1), ...pinned.split("\n"), ...tail].join("\n");
}

/** Shape of a SYSTEM-written fact note (`mem_<base36>_<rand>.md`, plus the optional
 *  sha1 disambiguation suffix). Prune only deletes files matching this — a human's
 *  own vault notes (Index/MOC/daily/links) are never the system's to remove. */
const SYSTEM_NOTE_RE = /^mem_[0-9a-z]+_[0-9a-z]+(-[0-9a-f]{8})?\.md$/;

function noteFileName(memoryId: string): string {
	const safe = memoryId.replace(/[^A-Za-z0-9_-]/g, "_");
	// If sanitisation changed the id, distinct ids could collapse to one file —
	// disambiguate with a short content hash so the on-disk name is a bijection.
	if (safe === memoryId) return `${safe}.md`;
	return `${safe}-${createHash("sha1").update(memoryId).digest("hex").slice(0, 8)}.md`;
}

export interface VaultWriteResult {
	written: number;
	/** Notes whose pinned region was preserved from a prior hand edit. */
	mergedPinned: number;
	/** Stale notes removed (only when `prune` is set). */
	pruned?: number;
}

/**
 * Write/refresh the vault for `records` under `dir`, preserving pinned edits.
 *
 * `prune` (default OFF) removes any `.md` note in `dir` NOT in the current record
 * set — so an evicted/PURGED fact's note can't linger as plaintext on disk after
 * a crypto-shred (the integrity counterpart to {@link FactStore.purge}). Callers
 * that pass the FULL set for a vault (e.g. the whole owner origin) should enable
 * it; callers passing a partial set must not.
 */
export function writeVault(
	dir: string,
	records: readonly MemoryRecord[],
	opts: { prune?: boolean } = {},
): VaultWriteResult {
	fs.mkdirSync(dir, { recursive: true });
	let written = 0;
	let mergedPinned = 0;
	const keep = new Set<string>();
	for (const r of records) {
		const name = noteFileName(r.memoryId);
		keep.add(name);
		const file = path.join(dir, name);
		const proposed = renderNote(r);
		let existing: string | undefined;
		try {
			existing = fs.readFileSync(file, "utf8");
		} catch {
			existing = undefined;
		}
		const pinned = existing ? extractPinned(existing) : undefined;
		const merged = mergeNote(existing, proposed);
		if (pinned !== undefined && pinned.trim().length > 0) mergedPinned++;
		fs.writeFileSync(file, merged, "utf8");
		written++;
	}
	if (!opts.prune) return { written, mergedPinned };

	// Remove stale notes (a purged/evicted fact must not survive as plaintext).
	let pruned = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		entries = [];
	}
	for (const f of entries) {
		// Only prune SYSTEM-named fact notes that are no longer current. A human's own
		// notes in the vault (an Index/Map-of-Content, a daily note) are NOT system fact
		// notes, so they're left alone — deleting them would contradict the whole
		// editable-Obsidian-vault premise (the prune exists to stop a shredded fact's
		// note lingering as plaintext, not to police the user's folder).
		if (SYSTEM_NOTE_RE.test(f) && !keep.has(f)) {
			try {
				fs.rmSync(path.join(dir, f));
				pruned++;
			} catch {
				/* concurrent removal / locked — best effort */
			}
		}
	}
	return { written, mergedPinned, pruned };
}
