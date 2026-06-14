// src/storage/local/session-store.ts
//
// LocalSessionStore — filesystem-mode wrapper around `src/sessions/session-store.ts`.
// Implements `SessionStore` from `../store.ts`.
//
// The hot path is the sessions.json read-modify-write, which is already
// protected by today's dual lock:
//   - `withSyncStoreLock(agentId, fn)` — in-process per-agent FIFO mutex
//   - `tryAcquireSessionStoreFileLockSync` — cross-process `.lock` sidecar
// Both fire inside the existing helpers; the adapter just delegates, so
// every property of the lock contract (re-entrancy throw, stale-steal,
// timeout) survives byte-for-byte.
//
// The `subscribe(agentId, cb)` listener watches the per-agent sessions.json
// via [file-watcher.ts](file-watcher.ts), same pattern as `LocalConfigStore`.

import {
	deleteSessionEntry,
	listSessionEntries,
	listSubagentSessionEntries,
	readSessionStore,
	readSubagentMetadata,
	resolveOrCreateSession,
	type SessionEntry as InternalSessionEntry,
	type SubagentSessionMetadata as InternalSubagentMetadata,
	updateSessionEntry,
	upsertSessionEntry,
} from "../../sessions/session-store.js";
import { resolveSessionStorePath } from "../../config/paths.js";

import { watchFile } from "./file-watcher.js";

import type {
	ResolvedSession,
	SessionEntry,
	SessionStore,
	SubagentSessionMetadata,
	Unsub,
} from "../store.js";

export class LocalSessionStore implements SessionStore {
	constructor(private readonly _stateDir: string) {}

	async resolveOrCreate(args: {
		agentId: string;
		sessionKey: string;
		overrides?: Partial<SessionEntry>;
		freshnessMs?: number;
	}): Promise<ResolvedSession> {
		const r = resolveOrCreateSession({
			agentId: args.agentId,
			sessionKey: args.sessionKey,
			...(args.overrides !== undefined
				? { overrides: args.overrides as Partial<InternalSessionEntry> }
				: {}),
			...(args.freshnessMs !== undefined ? { freshnessMs: args.freshnessMs } : {}),
		});
		// Public shape uses `{entry, created}`; internal uses `{entry, isNew, ...}`.
		return {
			entry: r.entry as unknown as SessionEntry,
			created: r.isNew,
		};
	}

	async getEntry(agentId: string, sessionKey: string): Promise<SessionEntry | undefined> {
		const store = readSessionStore(agentId);
		const entry = store.sessions?.[sessionKey];
		return entry ? (entry as unknown as SessionEntry) : undefined;
	}

	async upsertEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry> {
		const result = upsertSessionEntry(
			agentId,
			sessionKey,
			patch as Partial<InternalSessionEntry>,
		);
		return result as unknown as SessionEntry;
	}

	async updateEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry | null> {
		const result = updateSessionEntry(
			agentId,
			sessionKey,
			patch as Partial<InternalSessionEntry>,
		);
		return result ? (result as unknown as SessionEntry) : null;
	}

	async deleteEntry(agentId: string, sessionKey: string): Promise<boolean> {
		return deleteSessionEntry(agentId, sessionKey);
	}

	async listEntries(
		agentId: string,
		filter?: { isolatedCronRunOlderThanMs?: number; subagentOnly?: boolean },
	): Promise<Array<{ sessionKey: string; entry: SessionEntry }>> {
		const rows = listSessionEntries(agentId, filter ?? {});
		return rows as unknown as Array<{ sessionKey: string; entry: SessionEntry }>;
	}

	async readSubagentMetadata(
		agentId: string,
		sessionKey: string,
	): Promise<SubagentSessionMetadata | undefined> {
		const meta: InternalSubagentMetadata | undefined = readSubagentMetadata(
			agentId,
			sessionKey,
		);
		return meta ? (meta as unknown as SubagentSessionMetadata) : undefined;
	}

	async listSubagentEntries(
		agentId: string,
	): Promise<
		Array<{ sessionKey: string; entry: SessionEntry; subagent: SubagentSessionMetadata }>
	> {
		const rows = listSubagentSessionEntries(agentId);
		return rows as unknown as Array<{
			sessionKey: string;
			entry: SessionEntry;
			subagent: SubagentSessionMetadata;
		}>;
	}

	subscribe(agentId: string, cb: (entries: SessionEntry[]) => void): Unsub {
		// fs.watch on the per-agent sessions.json with the standard 500 ms
		// debounce. On change we re-read and emit the fresh entries array.
		return watchFile(resolveSessionStorePath(agentId), () => {
			try {
				const store = readSessionStore(agentId);
				const list = Object.values(store.sessions ?? {});
				cb(list as unknown as SessionEntry[]);
			} catch {
				// Mid-write — skip; the next stable write will fire again.
			}
		});
	}
}
