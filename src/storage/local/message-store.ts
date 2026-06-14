// src/storage/local/message-store.ts
//
// LocalMessageStore — filesystem-mode wrapper around Pi SDK's
// `SessionManager` (transcript JSONL) + `src/sessions/{bootstrap-marker,
// session-file-repair, session-write-lock, transcript-reader}.ts` + the
// in-process `src/agents/session-inbox.ts` queue. Implements `MessageStore`.
//
// PR14 design notes (judged across two parallel proposals + adversarial
// review — see `project_brigade_phase_2_user_flow` memory):
//
//   • `appendRecord` dispatches by `record.type`:
//     - "custom"  → SessionManager.open(path).appendCustomEntry(...) so
//                   Pi mints a valid `id` via generateId(byId) and the
//                   parentId tree stays intact.
//     - anything else → throws NotImplementedYet. Today the ONLY caller
//                       of `MessageStore.appendRecord` is the bootstrap-
//                       marker path (custom records); broader writes
//                       still go through agent-loop's own SessionManager
//                       handle. Convex mode (PR16) gets the full surface.
//
//   • `withWriteLock` uses the CROSS-PROCESS file lock from session-write-
//     lock.ts (`acquireSessionWriteLock`) — NOT the sessions.json sync
//     mutex. Two locks, two domains. The sync mutex covers sessions.json
//     read-modify-write; this one covers the per-session JSONL transcript.
//
//   • `readTranscript` goes through the new shared
//     `src/sessions/transcript-reader.ts` helper so callers never have to
//     re-open a SessionManager just to read history (re-open re-parses
//     the whole JSONL — see judge risk #2).
//
//   • `subscribe(sessionId, cb)` watches the per-session JSONL with a
//     byte cursor + truncation-resync (Pi rewrites the file on V1→V2
//     migration + createBranchedSession — judge risk #3). The agentId
//     needed to resolve the on-disk path is recovered by walking
//     `<stateDir>/agents/*/sessions/<sessionId>.jsonl` lazily on first
//     fire.
//
//   • Inbox methods delegate verbatim to `agents/session-inbox.ts` — the
//     in-process Map is THE source of truth + the env-gated disk mirror
//     handles persistence. We must NOT bypass it (cross-process consumers
//     in agent-loop expect the same Map).

import { existsSync, readdirSync, statSync } from "node:fs";
import * as fsAsync from "node:fs/promises";
import path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import {
	consumeSystemEventEntries,
	drainSystemEventEntries,
	enqueueSystemEvent,
	hasSystemEvents,
	peekSystemEventEntries,
} from "../../agents/session-inbox.js";
import {
	hasDeliveredBootstrapToSession,
	markBootstrapDeliveredToSession,
} from "../../sessions/bootstrap-marker.js";
import { repairSessionFileIfNeeded } from "../../sessions/session-file-repair.js";
import { acquireSessionWriteLock } from "../../sessions/session-write-lock.js";
import {
	readTranscriptRecords,
	tailTranscriptSince,
} from "../../sessions/transcript-reader.js";
import {
	resolveAgentDir,
	resolveSessionTranscriptPath,
	resolveStateDir,
} from "../../config/paths.js";

import { NotImplementedYet } from "../store.js";
import { watchFile } from "./file-watcher.js";

import type {
	MessageStore,
	PiTranscriptRecord,
	RepairReport,
	SystemEvent,
	Unsub,
} from "../store.js";

/** Lazy walker for `<stateDir>/agents/<id>/sessions/<sessionId>.jsonl`. Used
 *  by `subscribe(sessionId, cb)` which doesn't get an agentId. Process-
 *  scoped cache so repeat lookups are O(1). */
const SESSION_AGENT_CACHE = new Map<string, string>();

function findAgentIdForSessionId(sessionId: string): string | undefined {
	const cached = SESSION_AGENT_CACHE.get(sessionId);
	if (cached) return cached;
	const agentsRoot = path.join(resolveStateDir(), "agents");
	let agentNames: string[];
	try {
		agentNames = readdirSync(agentsRoot);
	} catch {
		return undefined;
	}
	for (const agentId of agentNames) {
		const transcript = path.join(
			resolveAgentDir(agentId),
			"sessions",
			`${sessionId}.jsonl`,
		);
		try {
			if (statSync(transcript).isFile()) {
				SESSION_AGENT_CACHE.set(sessionId, agentId);
				return agentId;
			}
		} catch {
			// Skip — not the right agent.
		}
	}
	return undefined;
}

export class LocalMessageStore implements MessageStore {
	constructor(private readonly _stateDir: string) {}

	async appendRecord(
		agentId: string,
		sessionId: string,
		record: PiTranscriptRecord,
	): Promise<void> {
		// PR14 supports ONLY the `custom` record type. The interface signature
		// invites future caller shapes (full Pi entries from cron / channel
		// inbound paths) — those land when their PRs need them. Pi's
		// `SessionManager.open` mints a valid id/parentId pair which a raw
		// fs.appendFile cannot fabricate without re-parsing the file.
		if (record.type !== "custom") {
			throw new NotImplementedYet(
				`messages.appendRecord type=${String(record.type)} ` +
					"(only 'custom' is wired in PR14 — see message-store.ts header)",
			);
		}
		const customType = (record as { customType?: unknown }).customType;
		if (typeof customType !== "string" || customType.length === 0) {
			throw new Error("messages.appendRecord: custom record requires `customType`");
		}
		const data = (record as { data?: unknown }).data;
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const sm = SessionManager.open(transcriptPath) as unknown as {
			appendCustomEntry?: (customType: string, data: unknown) => void;
		};
		if (typeof sm.appendCustomEntry !== "function") {
			throw new Error(
				"messages.appendRecord: Pi SessionManager.appendCustomEntry is unavailable — pin pi-coding-agent to 0.73.x or compatible",
			);
		}
		sm.appendCustomEntry(customType, data);
	}

	async appendRecordsBatch(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		// Filesystem mode never uses the batch path — Pi's SessionManager owns
		// the JSONL and appends inline. Realise as raw line appends for the
		// migrate engine's benefit only.
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("");
		const { appendFileSync, mkdirSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		mkdirSync(dirname(transcriptPath), { recursive: true });
		appendFileSync(transcriptPath, lines, "utf8");
	}

	async replaceTranscript(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const body = records.map((r) => `${JSON.stringify(r)}\n`).join("");
		const { mkdirSync, renameSync, writeFileSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		mkdirSync(dirname(transcriptPath), { recursive: true });
		const tmp = `${transcriptPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
		writeFileSync(tmp, body, "utf8");
		renameSync(tmp, transcriptPath);
	}

	async readTranscript(
		agentId: string,
		sessionId: string,
		opts?: { limit?: number; tailBytes?: number },
	): Promise<PiTranscriptRecord[]> {
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const rows = readTranscriptRecords(transcriptPath, opts ?? {});
		return rows as unknown as PiTranscriptRecord[];
	}

	async hasBootstrapDelivered(agentId: string, sessionId: string): Promise<boolean> {
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		return hasDeliveredBootstrapToSession(transcriptPath);
	}

	async markBootstrapDelivered(agentId: string, sessionId: string): Promise<void> {
		// Bootstrap delivery happens at most once per session lifetime, so the
		// SessionManager re-open here is fine (judge risk #2 — once-per-session
		// cost is acceptable). Production callers inside agent-loop pass their
		// own SessionManager directly to `markBootstrapDeliveredToSession`; the
		// adapter exists for paths that DON'T already hold a handle (cron
		// follow-ups, channel re-entry flows).
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const sm = SessionManager.open(transcriptPath);
		markBootstrapDeliveredToSession(sm);
	}

	async deleteTranscript(agentId: string, sessionId: string): Promise<void> {
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		try {
			await fsAsync.rm(transcriptPath, { force: true });
		} catch {
			// Match existing call-site behaviour (`session-reaper.ts:111`,
			// `subagent-runner.ts:203`) — best-effort delete, missing file is
			// not an error.
		}
	}

	async repairIfNeeded(agentId: string, sessionId: string): Promise<RepairReport> {
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const report = await repairSessionFileIfNeeded({ sessionFile: transcriptPath });
		return report as unknown as RepairReport;
	}

	async withWriteLock<T>(
		agentId: string,
		sessionId: string,
		fn: () => Promise<T>,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		const lock = await acquireSessionWriteLock({
			sessionFile: transcriptPath,
			...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
		});
		try {
			return await fn();
		} finally {
			try {
				await lock.release();
			} catch {
				// Idempotent release; stale-steal cleans up if this errors.
			}
		}
	}

	subscribe(sessionId: string, cb: (msg: PiTranscriptRecord) => void): Unsub {
		const agentId = findAgentIdForSessionId(sessionId);
		if (!agentId) {
			// Transcript doesn't exist yet; nothing to watch. Return a no-op
			// unsub so callers stay compositional. (Re-subscribing after
			// SessionManager.open creates the file works on the next call.)
			return () => undefined;
		}
		const transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
		let cursor = 0;
		try {
			cursor = existsSync(transcriptPath) ? statSync(transcriptPath).size : 0;
		} catch {
			cursor = 0;
		}
		return watchFile(transcriptPath, () => {
			// `tailTranscriptSince` handles truncation by resetting the cursor
			// to 0 — Pi rewrites the JSONL on V1→V2 migration and on
			// `createBranchedSession`, so a naive lastSize-only tracker would
			// miss the new contents (judge risk #3).
			const { records, newCursor } = tailTranscriptSince(transcriptPath, cursor);
			cursor = newCursor;
			for (const row of records) {
				try {
					cb(row as unknown as PiTranscriptRecord);
				} catch {
					// One bad subscriber doesn't poison the rest of the batch.
				}
			}
		});
	}

	// ---------------------------------------------------------------------
	// Inbox (system-events JSONL via in-process queue + env-gated disk mirror)
	// ---------------------------------------------------------------------

	async inboxEnqueue(sessionKey: string, event: SystemEvent): Promise<boolean> {
		const e = event as unknown as {
			text?: string;
			contextKey?: string | null;
			deliveryContext?: unknown;
			trusted?: boolean;
		};
		const text = typeof e.text === "string" ? e.text : "";
		if (!text) return false;
		return enqueueSystemEvent(text, {
			sessionKey,
			...(e.contextKey !== undefined ? { contextKey: e.contextKey ?? undefined } : {}),
			...(e.deliveryContext !== undefined
				? { deliveryContext: e.deliveryContext as never }
				: {}),
			...(e.trusted !== undefined ? { trusted: e.trusted } : {}),
		});
	}

	async inboxDrain(sessionKey: string): Promise<SystemEvent[]> {
		const events = drainSystemEventEntries(sessionKey);
		return events as unknown as SystemEvent[];
	}

	async inboxConsumePrefix(
		sessionKey: string,
		prefix: readonly SystemEvent[],
	): Promise<SystemEvent[]> {
		const consumed = consumeSystemEventEntries(sessionKey, prefix as never);
		return consumed as unknown as SystemEvent[];
	}

	async inboxPeek(sessionKey: string): Promise<SystemEvent[]> {
		const events = peekSystemEventEntries(sessionKey);
		return events as unknown as SystemEvent[];
	}

	async inboxHasEvents(sessionKey: string): Promise<boolean> {
		return hasSystemEvents(sessionKey);
	}
}
