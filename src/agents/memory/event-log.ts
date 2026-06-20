/**
 * The append-only event log — the immutable track of the dual-track spine
 * (Tideline build Step 7).
 *
 * The ACTIVE store (`FactStore`) holds current belief and is mutated in place
 * (supersede archives, dedup reinforces). The LOG is an ordered, append-only
 * record of WHAT HAPPENED, never rewritten. Together they are the dual track:
 * the store answers "what do I believe now?", the log answers "how did it get
 * this way?" — provenance, audit (every blocked poisoning attempt is recorded),
 * and a basis for rebuilding the store.
 *
 * FILESYSTEM mode appends to `<workspace>/memory/events.jsonl`. CONVEX mode
 * appends to the `memoryEvents` Convex table via `MemoryStore.appendMemoryEvent`
 * (called from `FactStore.emit`), which is best-effort and fire-and-forget so
 * that a failed audit-log write never fails an active-store write. The log is
 * additive provenance: its absence never affects recall in either mode.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MemorySegment, MemorySourceType, MemoryStatus } from "./records.js";

export type MemoryEventKind =
	| "created" // a new fact was persisted (carries `targets` if it superseded any)
	| "reinforced" // a near-duplicate write merged into an existing fact (decay bump)
	| "blocked" // the write-gate rejected a poisoning write (carries `reason`)
	| "feedback" // recall feedback adjusted a fact's importance/confidence (carries `signal`)
	| "invalidated" // a fact was bi-temporally invalidated (validTo closed; carries the superseder in `targets`)
	| "confirmed" // the dream promoted a repeatedly-corrected belief to a confirmed preference (carries `prior` for reversal)
	| "evicted"; // the dream archived a low-value decayed fact

export interface MemoryEvent {
	/** Event time (ms). Stamped by the caller so it matches the record's time. */
	at: number;
	kind: MemoryEventKind;
	/** Subject record: the new/merged/attempted fact's id. */
	memoryId: string;
	segment?: MemorySegment;
	sourceType?: MemorySourceType;
	/** On "created": the ids this write superseded (archived). */
	targets?: string[];
	/** On "blocked": the write-gate reason. */
	reason?: string;
	/** On "feedback": the relevance signal that drove the importance/confidence update. */
	signal?: "up" | "down";
	/** On "confirmed": the pre-promotion cognition fields, so a dream pass is
	 *  REVERSIBLE (Lane A is reversible by design). */
	prior?: { confidence?: number; status?: MemoryStatus; importance?: number };
}

/** Append-only JSONL event log. Best-effort: a log failure NEVER fails a write
 *  (provenance must not be able to take down the active store). */
export class MemoryEventLog {
	constructor(private readonly file: string) {}

	get filePath(): string {
		return this.file;
	}

	append(event: MemoryEvent): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
		} catch {
			// Best-effort provenance — swallow (the active store already succeeded).
		}
	}

	/** Read the full ordered history. Malformed lines are skipped (never throws). */
	readAll(): MemoryEvent[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: MemoryEvent[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const e = JSON.parse(trimmed) as MemoryEvent;
				if (e && typeof e.memoryId === "string" && typeof e.kind === "string") out.push(e);
			} catch {
				// Skip a corrupt line rather than failing the whole read.
			}
		}
		return out;
	}
}
