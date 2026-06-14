// src/sessions/transcript-reader.ts
//
// Public JSONL transcript reader. Lifted + generalised from `core/server.ts`'s
// internal `readSessionTranscriptMessages` (which projected just the
// `message` field of `type:"message"` rows) so the BrigadeStore adapter can
// expose the FULL row shape that `MessageStore.readTranscript` promises.
//
// The reader is intentionally lenient — malformed JSONL lines are dropped
// individually rather than failing the whole read. This matches today's
// repair-then-resume contract: `session-file-repair.ts` patches the file on
// next agent-loop entry; in-between, callers see the valid tail.

import { existsSync, openSync, closeSync, readSync, readFileSync, statSync } from "node:fs";

/** Raw JSONL row as it lives on disk. Mirrors Pi's `SessionEntryBase` plus
 *  the `parseSessionEntries` lenient defaults. */
export interface TranscriptRow {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[field: string]: unknown;
}

export interface ReadTranscriptOptions {
	/** Cap the returned slice to the LAST `limit` rows. Defaults to no cap. */
	limit?: number;
	/** Only parse the last `tailBytes` of the file. Useful for large
	 *  transcripts where a full read would be wasteful. The first partial
	 *  line in the slice is dropped (it's almost certainly truncated mid-row). */
	tailBytes?: number;
}

/**
 * Parse the transcript JSONL at `transcriptPath`. Returns rows in file order
 * (oldest-first within the read window). Missing / unreadable / empty file
 * returns `[]`. Mid-file JSON-parse errors drop the offending row only.
 */
export function readTranscriptRecords(
	transcriptPath: string,
	opts: ReadTranscriptOptions = {},
): TranscriptRow[] {
	if (!existsSync(transcriptPath)) return [];

	let text: string;
	if (opts.tailBytes !== undefined && opts.tailBytes > 0) {
		let stat;
		try {
			stat = statSync(transcriptPath);
		} catch {
			return [];
		}
		const start = Math.max(0, stat.size - opts.tailBytes);
		let chunk: Buffer;
		try {
			const fd = openSync(transcriptPath, "r");
			try {
				const len = stat.size - start;
				chunk = Buffer.alloc(len);
				readSync(fd, chunk, 0, len, start);
			} finally {
				closeSync(fd);
			}
		} catch {
			return [];
		}
		text = chunk.toString("utf8");
		// Drop the first partial line when we didn't start at the file head —
		// it's almost certainly truncated by the tail boundary.
		if (start > 0) {
			const newlineIdx = text.indexOf("\n");
			text = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : "";
		}
	} else {
		try {
			text = readFileSync(transcriptPath, "utf8");
		} catch {
			return [];
		}
	}

	const rows: TranscriptRow[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as TranscriptRow;
			if (parsed && typeof parsed.type === "string") {
				rows.push(parsed);
			}
		} catch {
			// Corrupt row — drop, keep reading.
		}
	}

	const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
	if (limit !== undefined && rows.length > limit) {
		return rows.slice(rows.length - limit);
	}
	return rows;
}

/**
 * Read NEW rows since a byte cursor. Used by `LocalMessageStore.subscribe`
 * to emit per-record updates. Returns the rows plus the new cursor.
 *
 * Truncation handling: when the file shrinks since `lastCursor`, the
 * cursor is reset to 0 and the whole file is re-parsed — Pi rewrites
 * the transcript on V1→V2 migration and on `createBranchedSession`, and
 * a subscriber that ignored truncation would miss the new contents.
 */
export function tailTranscriptSince(
	transcriptPath: string,
	lastCursor: number,
): { records: TranscriptRow[]; newCursor: number } {
	let stat;
	try {
		stat = statSync(transcriptPath);
	} catch {
		return { records: [], newCursor: lastCursor };
	}

	// Truncation / rotation — resync from the head.
	const start = stat.size < lastCursor ? 0 : lastCursor;
	const len = stat.size - start;
	if (len <= 0) return { records: [], newCursor: stat.size };

	let chunk: Buffer;
	try {
		const fd = openSync(transcriptPath, "r");
		try {
			chunk = Buffer.alloc(len);
			readSync(fd, chunk, 0, len, start);
		} finally {
			closeSync(fd);
		}
	} catch {
		return { records: [], newCursor: lastCursor };
	}

	const rows: TranscriptRow[] = [];
	for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as TranscriptRow;
			if (parsed && typeof parsed.type === "string") {
				rows.push(parsed);
			}
		} catch {
			// Mid-write truncated row — skip; the next tick picks up the full version.
		}
	}
	return { records: rows, newCursor: stat.size };
}
