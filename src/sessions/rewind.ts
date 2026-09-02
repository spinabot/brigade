/**
 * Rewinding a conversation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONVERSATION ONLY. NEVER FILES.
 * ─────────────────────────────────────────────────────────────────────────
 * This is the decision the whole design turns on, and the evidence is
 * one-sided: every reported failure in this space is a FILE failure. Files not
 * reverted, files reverted that could not be, symlinks skipped, `/redo`
 * committing a working tree, nested git repos disabling the feature or deleting
 * the task outright. Anthropic ships the most-resourced version of file
 * checkpointing and still documents that bash changes, subagent edits,
 * symlinks, hard links, directory operations and external edits are all
 * uncovered.
 *
 * A restore that silently covers most of what an agent did is worse than none,
 * because people stop checking. And Brigade runs agents over channels and cron,
 * on a gateway that may not share a filesystem with the client, in workspaces
 * that may not be git repos at all.
 *
 * `git` already solves files, better, with a tool the operator already trusts.
 * So rewind moves the conversation pointer and REPORTS which files were touched
 * after that point, without pretending to undo them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SAFE
 * ─────────────────────────────────────────────────────────────────────────
 * Pi's transcript is an append-only TREE: every entry carries `id` and
 * `parentId`, `branch(id)` only moves a leaf pointer, and nothing is ever
 * deleted. Rewinding is therefore not destructive — the abandoned branch stays
 * in the file and can be returned to.
 *
 * Compaction rides the same tree. A compaction is an ENTRY with a parent, and
 * `buildSessionContext` looks for the last one on the root→leaf path. So
 * rewinding to a point before a compaction simply takes a path that does not
 * include it: the summary disappears and the full history comes back, with no
 * invalidation logic anywhere. That property is why Claude Code's rewind lost
 * history (its summary root has no parent link, orphaning the tree) and
 * Brigade's does not.
 */

import { isToolCall, toolCallArguments, toolCallName } from "../agents/pi-dialect.js";

/** The shape this needs from a transcript entry. Deliberately minimal. */
export interface RewindEntry {
	id: string;
	parentId?: string | null;
	type?: string;
	role?: string;
	/** Message content, for showing the operator what they are rewinding to. */
	content?: unknown;
	/**
	 * Per-message usage, when the transcript recorded it. Present so a caller
	 * can total a session's spend along the ACTIVE branch — the same path this
	 * module already computes — rather than over the whole file, which still
	 * holds every abandoned branch by design.
	 */
	usage?: unknown;
	timestamp?: number;
}

export interface RewindTarget {
	/** The entry to branch from — the new leaf. */
	entryId: string;
	/** Position in the list of user messages, newest last. */
	ordinal: number;
	/** First line of the message, for the picker. */
	preview: string;
	timestamp?: number;
}

/** Flatten an entry's content to a single line for a picker. */
function previewOf(entry: RewindEntry, max = 80): string {
	const c = entry.content;
	let text = "";
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) {
		for (const block of c) {
			const b = block as { text?: unknown };
			if (typeof b?.text === "string") {
				text += (text ? " " : "") + b.text;
			}
		}
	}
	// STRIP C0 CONTROL BYTES AT THE SOURCE.
	//
	// `\s` does NOT match ESC (0x1B), so collapsing whitespace leaves ANSI/OSC
	// sequences intact. This preview is written back into the live editor after
	// a rewind, where pi-tui re-emits the buffer verbatim on every frame — so a
	// hostile sequence from a channel sender would repaint continuously.
	//
	// Cleaned here rather than at each render site: the picker already scrubs,
	// the editor path did not, and terminal safety should not depend on every
	// future caller remembering.
	const oneLine = text
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!oneLine) return "(no text)";
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * The points an operator can rewind to: their own messages.
 *
 * Only user messages, because "go back to what I asked" is the question people
 * actually have — every harness that ships a picker (Claude Code's `/rewind`,
 * pi's `/fork`, opencode's timeline) lists user turns and nothing else. A list
 * of every assistant and tool entry would be unreadable and unmemorable.
 *
 * Ordered oldest-first with a 1-based ordinal, so `#1` is the start of the
 * conversation and the numbering does not shift as the session grows.
 */
export function rewindTargets(entries: readonly RewindEntry[]): RewindTarget[] {
	const out: RewindTarget[] = [];
	for (const e of entries) {
		if (!e || typeof e.id !== "string") continue;
		// `type` is the transcript record's discriminator; `role` is the message
		// inside it. Different Pi versions surface one or the other.
		const isUser = e.role === "user" || e.type === "user";
		if (!isUser) continue;
		out.push({
			entryId: e.id,
			ordinal: out.length + 1,
			preview: previewOf(e),
			...(typeof e.timestamp === "number" ? { timestamp: e.timestamp } : {}),
		});
	}
	return out;
}

/**
 * Walk the tree from `leafId` to the root, newest first.
 *
 * Cycle-guarded: the transcript is a file an operator can hand-edit, and a
 * malformed `parentId` loop would otherwise hang the gateway.
 */
export function pathToRoot(
	entries: readonly RewindEntry[],
	leafId: string | null | undefined,
): RewindEntry[] {
	const byId = new Map<string, RewindEntry>();
	for (const e of entries) if (e && typeof e.id === "string") byId.set(e.id, e);

	const path: RewindEntry[] = [];
	const seen = new Set<string>();
	let cur = leafId ?? undefined;
	while (cur) {
		if (seen.has(cur)) break;
		seen.add(cur);
		const entry = byId.get(cur);
		if (!entry) break;
		path.push(entry);
		cur = entry.parentId ?? undefined;
	}
	return path;
}

/**
 * Detect an ORPHANED compaction — a summary entry with no parent link.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS CHECK EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * This is the single highest-impact defect in this problem space, and it is
 * one field. Claude Code's compaction boundary is written with
 * `parentUuid: null`, which severs the tree: a walker following parent links
 * from the leaf can no longer reach anything before the compaction. Measured
 * across 91 real sessions, a naive walk reached 21.4% of the conversation;
 * with a fallback link, 96.4%. One session reached 0.5%. The user-visible
 * symptom is a rewind picker showing two messages for a multi-day session
 * whose full history is intact on disk but unreachable.
 *
 * Pi does not have this bug — `appendCompaction` sets `parentId: this.leafId`
 * (`session-manager.js:717-722`), which is why rewinding past a compaction
 * works here for free. But Brigade reads transcripts it did not necessarily
 * write: an older file, an imported one, or a future Pi that regresses.
 *
 * So rather than trusting it, we look. A rewind that silently shows the
 * operator a truncated history is exactly the failure this guards against —
 * better to refuse and say why than to quietly lose their conversation.
 */
export function findOrphanedCompaction(
	entries: readonly RewindEntry[],
): RewindEntry | undefined {
	for (const e of entries) {
		if (!e || e.type !== "compaction") continue;
		// The FIRST entry legitimately has no parent. Anything later that claims
		// none has severed the chain.
		const isFirst = entries[0] === e;
		if (!isFirst && (e.parentId === null || e.parentId === undefined)) return e;
	}
	return undefined;
}

/**
 * Entries that would be left off the path by rewinding to `entryId`.
 *
 * Nothing is deleted — this is what the operator is stepping AWAY from, so it
 * can be summarised or reported rather than silently dropped.
 */
export function abandonedByRewind(
	entries: readonly RewindEntry[],
	currentLeafId: string | null | undefined,
	entryId: string,
): RewindEntry[] {
	const keep = new Set(pathToRoot(entries, entryId).map((e) => e.id));
	// Oldest-first, so a summary of the abandoned work reads in order.
	return pathToRoot(entries, currentLeafId)
		.filter((e) => !keep.has(e.id))
		.reverse();
}

/**
 * Files touched by the entries a rewind would abandon.
 *
 * Rewind does not revert these — it names them, so the operator can decide
 * with `git`. Reporting honestly is the whole reason this is safe to ship:
 * the alternative is a restore that quietly covers 60% of what happened.
 */
export function filesTouchedAfter(
	entries: readonly RewindEntry[],
	currentLeafId: string | null | undefined,
	entryId: string,
): string[] {
	const files = new Set<string>();
	for (const e of abandonedByRewind(entries, currentLeafId, entryId)) {
		const content = e.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isToolCall(block)) continue;
			const name = toolCallName(block);
			// Only tools that WRITE. A `read` touching a file is not a change the
			// operator needs to reconcile.
			if (!/^(write|edit|multi_edit|notebook_edit|apply_patch)$/i.test(name)) continue;
			const args = toolCallArguments(block);
			const p = typeof args.path === "string" ? args.path : args.file_path;
			if (typeof p === "string" && p.trim()) files.add(p.trim());
		}
	}
	return [...files].sort();
}
