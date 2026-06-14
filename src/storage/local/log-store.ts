// src/storage/local/log-store.ts
//
// LocalLogStore — filesystem-mode wrapper around the new public helpers
// landed in PR4 across `core/event-logger.ts` + `logging/subsystem-logger.ts`
// + `config/io.ts`. Implements `LogStore`.
//
// The existing in-process writers keep firing unchanged — the
// `attachEventLogger` subscription still writes session events from Pi,
// `createSubsystemLogger` still emits .info/.warn/.error records, and
// `writeConfigSafe` still calls its internal `writeConfigHealth` +
// `appendConfigAudit` helpers. This adapter is the typed seam through which
// the storage layer reaches the same files.

import * as fs from "node:fs";
import * as path from "node:path";

import {
	appendSessionEvent,
	getLastLoggedError,
	readSessionEventTail,
} from "../../core/event-logger.js";
import {
	appendSubsystemRecord,
	pruneSubsystemLogs,
	readSubsystemRecords,
	type LogLevel,
} from "../../logging/subsystem-logger.js";
import {
	appendConfigAuditLine,
	type ConfigAuditInput as InternalConfigAuditInput,
	type ConfigAuditRecord as InternalConfigAuditRecord,
	type ConfigHealthRecord as InternalConfigHealthRecord,
	readConfigHealthSnapshot,
	verifyConfigAuditChain,
	writeConfigHealthSnapshot,
} from "../../config/io.js";
import { resolveLogsDir } from "../../config/paths.js";

import { watchFile } from "./file-watcher.js";

import type {
	ConfigAuditInput,
	ConfigAuditRecord,
	ConfigHealthRecord,
	LastErrorSnapshot,
	LogFilter,
	LogStore,
	SessionEventRecord,
	SubsystemLogFilter,
	SubsystemLogRecord,
	Unsub,
} from "../store.js";

export class LocalLogStore implements LogStore {
	constructor(private readonly _stateDir: string) {}

	// ---------------------------------------------------------------------
	// Pi session events (today's `~/.brigade/logs/<YYYY-MM-DD>.jsonl`)
	// ---------------------------------------------------------------------

	async appendSessionEvent(record: SessionEventRecord): Promise<void> {
		appendSessionEvent(record as unknown as Record<string, unknown>);
	}

	async readSessionEventTail(
		opts: { day?: string; maxBytes?: number },
	): Promise<SessionEventRecord[]> {
		const rows = readSessionEventTail({
			...(opts.day !== undefined ? { day: opts.day } : {}),
			...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
		});
		return rows as unknown as SessionEventRecord[];
	}

	async findLastSessionError(
		opts?: { lookbackBytes?: number },
	): Promise<LastErrorSnapshot | undefined> {
		const snapshot = getLastLoggedError(opts ?? {});
		return snapshot as unknown as LastErrorSnapshot | undefined;
	}

	// ---------------------------------------------------------------------
	// Structured subsystem log (`~/.brigade/logs/brigade-<YYYY-MM-DD>.log`)
	// ---------------------------------------------------------------------

	async appendSubsystemRecord(record: SubsystemLogRecord): Promise<void> {
		const r = record as unknown as {
			time?: string;
			level?: string;
			subsystem?: string;
			message?: string;
			fields?: Record<string, unknown>;
		};
		if (!r.level || !r.subsystem || r.message === undefined) {
			throw new Error(
				"LocalLogStore.appendSubsystemRecord: record requires level + subsystem + message",
			);
		}
		appendSubsystemRecord({
			level: r.level as LogLevel,
			subsystem: r.subsystem,
			message: r.message,
			...(r.time !== undefined ? { time: r.time } : {}),
			...(r.fields !== undefined ? { fields: r.fields } : {}),
		});
	}

	async readSubsystemRecords(filter: SubsystemLogFilter): Promise<SubsystemLogRecord[]> {
		const f = filter as unknown as {
			level?: LogLevel;
			subsystem?: string;
			day?: string;
			tailBytes?: number;
		};
		const rows = readSubsystemRecords({
			...(f.level !== undefined ? { level: f.level } : {}),
			...(f.subsystem !== undefined ? { subsystem: f.subsystem } : {}),
			...(f.day !== undefined ? { day: f.day } : {}),
			...(f.tailBytes !== undefined ? { tailBytes: f.tailBytes } : {}),
		});
		return rows as unknown as SubsystemLogRecord[];
	}

	async pruneSubsystemLogs(olderThanMs: number): Promise<{ removed: number }> {
		return pruneSubsystemLogs(olderThanMs);
	}

	// ---------------------------------------------------------------------
	// Config-audit chain + config-health snapshot
	// ---------------------------------------------------------------------

	async appendConfigAudit(entry: ConfigAuditInput): Promise<ConfigAuditRecord> {
		const e = entry as unknown as InternalConfigAuditInput;
		// The public ConfigAuditInput is loose (Record<string, unknown>) — we
		// enforce the minimum (sha256 required) at the boundary.
		if (typeof e.sha256 !== "string" || e.sha256.length === 0) {
			throw new Error(
				"LocalLogStore.appendConfigAudit: entry.sha256 is required (sha256 of the recorded payload)",
			);
		}
		const record: InternalConfigAuditRecord = appendConfigAuditLine(e);
		return record as unknown as ConfigAuditRecord;
	}

	async verifyConfigAuditChain(): Promise<{ ok: boolean; brokenAt?: number }> {
		return verifyConfigAuditChain();
	}

	async writeConfigHealth(snapshot: ConfigHealthRecord): Promise<void> {
		writeConfigHealthSnapshot(snapshot as unknown as InternalConfigHealthRecord);
	}

	async readConfigHealth(): Promise<ConfigHealthRecord | undefined> {
		const record = readConfigHealthSnapshot();
		return record as unknown as ConfigHealthRecord | undefined;
	}

	subscribe(filter: LogFilter, cb: (e: SubsystemLogRecord) => void): Unsub {
		// Watch today's subsystem log file (rolls daily — for a multi-day
		// subscribe we'd rewatch on rollover; filesystem mode is good enough
		// with today-only tracking). On each change we read the tail bytes
		// since our last-known size, parse new records, apply the caller's
		// filter, and emit one callback per matching record.
		const f = filter as unknown as {
			level?: LogLevel;
			subsystem?: string;
		};
		const dir = resolveLogsDir();
		const today = new Date();
		const yyyy = today.getFullYear().toString().padStart(4, "0");
		const mm = (today.getMonth() + 1).toString().padStart(2, "0");
		const dd = today.getDate().toString().padStart(2, "0");
		const filePath = path.join(dir, `brigade-${yyyy}-${mm}-${dd}.log`);

		// Seed lastSize at the current EOF so subscribers receive only NEW
		// records, not the historical tail. (Reading the whole file backlog
		// on every subscribe would surprise callers; if they want history
		// they call `readSubsystemRecords` directly.)
		let lastSize = 0;
		try {
			lastSize = fs.statSync(filePath).size;
		} catch {
			lastSize = 0;
		}

		return watchFile(filePath, () => {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(filePath);
			} catch {
				return; // File gone — skip.
			}
			// Truncation / log rotation? Reset and emit nothing this tick;
			// the next append starts a fresh window.
			if (stat.size < lastSize) {
				lastSize = stat.size;
				return;
			}
			const sliceLen = stat.size - lastSize;
			if (sliceLen <= 0) return;
			let chunk: Buffer;
			try {
				const fd = fs.openSync(filePath, "r");
				try {
					chunk = Buffer.alloc(sliceLen);
					fs.readSync(fd, chunk, 0, sliceLen, lastSize);
				} finally {
					fs.closeSync(fd);
				}
			} catch {
				return;
			}
			lastSize = stat.size;

			const subFilter = f.subsystem;
			const wantPrefix = subFilter !== undefined && subFilter.endsWith("/");
			for (const line of chunk.toString("utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				let row: { level?: string; subsystem?: string; [k: string]: unknown };
				try {
					row = JSON.parse(trimmed);
				} catch {
					continue;
				}
				if (!row.level || !row.subsystem) continue;
				if (f.level && row.level !== f.level) continue;
				if (subFilter !== undefined) {
					if (wantPrefix) {
						if (!row.subsystem.startsWith(subFilter)) continue;
					} else if (row.subsystem !== subFilter) continue;
				}
				try {
					cb(row as unknown as SubsystemLogRecord);
				} catch {
					// One bad subscriber doesn't kill the rest of this batch.
				}
			}
		});
	}
}
