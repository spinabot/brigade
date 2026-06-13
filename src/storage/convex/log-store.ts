// src/storage/convex/log-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";
import { openJson, sealJson } from "../encryption.js";

import { NotImplementedYet } from "../store.js";
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

interface Deps { client: ConvexHttpClient; ownerId: string; instanceId: string }

/** Convex subsystemLog row → disk-shaped record: spread the `fields` column
 *  back to top-level (the disk JSONL stores extras flat) and strip Convex
 *  bookkeeping (_id/_creationTime/ownerId/day). */
function subsystemRowToRecord(row: Record<string, unknown>): Record<string, unknown> {
	const { _id, _creationTime, ownerId, day, fields, ...rest } = row as Record<
		string,
		unknown
	> & { _id?: unknown; _creationTime?: unknown; ownerId?: unknown; day?: unknown };
	void _id;
	void _creationTime;
	void ownerId;
	void day;
	const flat: Record<string, unknown> = { ...rest };
	if (fields && typeof fields === "object") {
		for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
			if (flat[k] === undefined) flat[k] = v;
		}
	}
	return flat;
}

/** Convex sessionEvents row → disk-shaped log record. Opens the sealed
 *  args/result/content byte columns back into their original JSON and strips
 *  Convex bookkeeping so readers (migrate, status) see the same shape the
 *  disk JSONL serializer produced. */
function sessionEventRowToRecord(row: Record<string, unknown>): Record<string, unknown> {
	const { _id, _creationTime, args, result, content, ...rest } = row as Record<
		string,
		unknown
	> & { _id?: unknown; _creationTime?: unknown };
	void _id;
	void _creationTime;
	return {
		...rest,
		...(args !== undefined ? { args: openJson(args as ArrayBuffer) } : {}),
		...(result !== undefined ? { result: openJson(result as ArrayBuffer) } : {}),
		...(content !== undefined ? { content: openJson(content as ArrayBuffer) } : {}),
	};
}

export class ConvexLogStore implements LogStore {
	constructor(private readonly deps: Deps) {}

	async appendSessionEvent(record: SessionEventRecord): Promise<void> {
		const r = record as unknown as Record<string, unknown>;
		const ts = (r.ts as string) ?? new Date().toISOString();
		const day = (r.day as string) ?? ts.slice(0, 10);
		// Forward EVERY field the disk serializer (event-logger.serializeForLog)
		// emits — dropping them turns the convex session log into bare
		// {ts,type} rows, useless for the debugging the log exists for and
		// blinding `findLastError`. args/result/content are operator-sensitive
		// (tool I/O, full assistant content) so they ride sealed byte columns.
		await this.deps.client.mutation(api.logs.appendSessionEvent, {
			ts,
			day,
			ownerId: this.deps.ownerId,
			agentId: (r.agentId as string) ?? "main",
			sessionKey: (r.sessionKey as string) ?? "main",
			type: (r.type as string) ?? "unknown",
			...(r.inner !== undefined ? { inner: String(r.inner) } : {}),
			...(r.delta !== undefined ? { delta: String(r.delta) } : {}),
			...(r.toolCallId !== undefined ? { toolCallId: String(r.toolCallId) } : {}),
			...(r.toolName !== undefined ? { toolName: String(r.toolName) } : {}),
			...(r.args !== undefined ? { args: sealJson(r.args) } : {}),
			...(r.result !== undefined ? { result: sealJson(r.result) } : {}),
			...(r.isError !== undefined ? { isError: Boolean(r.isError) } : {}),
			...(r.role !== undefined ? { role: String(r.role) } : {}),
			...(r.content !== undefined ? { content: sealJson(r.content) } : {}),
			...(r.stopReason !== undefined ? { stopReason: String(r.stopReason) } : {}),
			...(r.errorMessage !== undefined ? { errorMessage: String(r.errorMessage) } : {}),
			...(r.attempt !== undefined ? { attempt: r.attempt as number } : {}),
			...(r.maxAttempts !== undefined ? { maxAttempts: r.maxAttempts as number } : {}),
			...(r.delayMs !== undefined ? { delayMs: r.delayMs as number } : {}),
			...(r.aborted !== undefined ? { aborted: Boolean(r.aborted) } : {}),
			...(r.willRetry !== undefined ? { willRetry: Boolean(r.willRetry) } : {}),
			...(r.messageCount !== undefined ? { messageCount: r.messageCount as number } : {}),
			...(r.success !== undefined ? { success: Boolean(r.success) } : {}),
			...(r.finalError !== undefined ? { finalError: String(r.finalError) } : {}),
		} as never);
	}

	async readSessionEventTail(
		opts: { day?: string; maxBytes?: number },
	): Promise<SessionEventRecord[]> {
		const rows = (await this.deps.client.query(api.logs.readSessionEventTail, {
			ownerId: this.deps.ownerId,
			...(opts.day !== undefined ? { day: opts.day } : {}),
		})) as Array<Record<string, unknown>>;
		return rows.map(sessionEventRowToRecord) as unknown as SessionEventRecord[];
	}

	async findLastSessionError(
		_opts?: { lookbackBytes?: number },
	): Promise<LastErrorSnapshot | undefined> {
		const raw = (await this.deps.client.query(api.logs.findLastError, {
			ownerId: this.deps.ownerId,
		})) as Record<string, unknown> | null;
		if (!raw) return undefined;
		// Build the same human snapshot the disk path (getLastLoggedError)
		// produces — the row carries event-shaped fields, not a `message`.
		const r = sessionEventRowToRecord(raw);
		const type = typeof r.type === "string" ? r.type : undefined;
		const ts = String(r.ts ?? "");
		if (type === "tool_execution_end" && r.isError === true) {
			const result = typeof r.result === "string" ? r.result : JSON.stringify(r.result);
			return { ts, type, message: `tool ${r.toolName} failed: ${result}` };
		}
		if (type === "auto_retry_start" && typeof r.errorMessage === "string") {
			return { ts, type, message: `auto retry: ${r.errorMessage}` };
		}
		if (type === "compaction_end" && r.aborted === true && typeof r.errorMessage === "string") {
			return { ts, type, message: `compaction aborted: ${r.errorMessage}` };
		}
		return {
			ts,
			...(type ? { type } : {}),
			message: typeof r.errorMessage === "string" ? r.errorMessage : "error",
		};
	}

	async appendSubsystemRecord(record: SubsystemLogRecord): Promise<void> {
		const r = record as unknown as Record<string, unknown>;
		const level = (r.level as string) ?? "info";
		if (
			level !== "trace" && level !== "debug" && level !== "info" &&
			level !== "warn" && level !== "error" && level !== "fatal"
		) {
			throw new Error(`logs.appendSubsystemRecord: invalid level "${level}"`);
		}
		const ts = (r.time as string) ?? new Date().toISOString();
		await this.deps.client.mutation(api.logs.appendSubsystemRecord, {
			time: ts,
			day: ts.slice(0, 10),
			ownerId: this.deps.ownerId,
			level,
			subsystem: (r.subsystem as string) ?? "unknown",
			message: (r.message as string) ?? "",
			...(r.fields !== undefined ? { fields: r.fields } : {}),
		});
	}

	async readSubsystemRecords(filter: SubsystemLogFilter): Promise<SubsystemLogRecord[]> {
		const f = filter as unknown as Record<string, unknown>;
		const rows = (await this.deps.client.query(api.logs.readSubsystemRecords, {
			ownerId: this.deps.ownerId,
			...(f.day !== undefined ? { day: f.day as string } : {}),
			...(f.level !== undefined ? { level: f.level as never } : {}),
			...(f.subsystem !== undefined ? { subsystem: f.subsystem as string } : {}),
			...(f.limit !== undefined ? { limit: f.limit as number } : {}),
		})) as Array<Record<string, unknown>>;
		// Re-spread the `fields` column back to top-level + strip Convex
		// bookkeeping so the shape matches the disk reader (extras live flat
		// alongside time/level/subsystem/message).
		return rows.map(subsystemRowToRecord) as unknown as SubsystemLogRecord[];
	}

	async pruneSubsystemLogs(olderThanMs: number): Promise<{ removed: number }> {
		// Server prunes one bounded page of expired rows per call; loop until a
		// page removes nothing. A single delete-all `.collect()` would blow the
		// 16 MiB read + 8k-delete caps on the (high-volume, unbounded) log table.
		// Lossless — all expired rows are removed across the loop; the count
		// matches the disk reader's return shape.
		let removed = 0;
		for (;;) {
			const r = (await this.deps.client.mutation(api.logs.pruneSubsystemLogs, {
				ownerId: this.deps.ownerId,
				olderThanMs,
			})) as { removed: number };
			removed += r.removed;
			if (r.removed <= 0) break;
		}
		return { removed };
	}

	async appendConfigAudit(entry: ConfigAuditInput): Promise<ConfigAuditRecord> {
		const e = entry as unknown as { sha256?: string; bytes?: number; ts?: string; pid?: number };
		if (typeof e.sha256 !== "string" || e.sha256.length === 0) {
			throw new Error("logs.appendConfigAudit: entry.sha256 is required");
		}
		const record = (await this.deps.client.mutation(api.logs.appendConfigAudit, {
			instanceId: this.deps.instanceId,
			ts: e.ts ?? new Date().toISOString(),
			sha256: e.sha256,
			bytes: e.bytes ?? 0,
			...(e.pid !== undefined ? { pid: e.pid } : {}),
		})) as Record<string, unknown>;
		return record as unknown as ConfigAuditRecord;
	}

	async verifyConfigAuditChain(): Promise<{ ok: boolean; brokenAt?: number }> {
		const rows = (await this.deps.client.query(api.logs.listConfigAudit, {
			instanceId: this.deps.instanceId,
		})) as Array<{ seq: number; lineHash: string; prevHash?: string }>;
		let previousHash: string | undefined;
		for (const row of rows) {
			if (previousHash !== undefined && row.prevHash !== previousHash) {
				return { ok: false, brokenAt: row.seq };
			}
			previousHash = row.lineHash;
		}
		return { ok: true };
	}

	async writeConfigHealth(snapshot: ConfigHealthRecord): Promise<void> {
		const s = snapshot as unknown as Record<string, unknown>;
		await this.deps.client.mutation(api.logs.writeConfigHealth, {
			ownerId: this.deps.ownerId,
			ts: (s.ts as string) ?? new Date().toISOString(),
			configPath: (s.configPath as string) ?? "convex://config",
			bytes: (s.bytes as number) ?? 0,
			sha256: (s.sha256 as string) ?? "",
			mtimeMs: (s.mtimeMs as number) ?? Date.now(),
			pid: (s.pid as number) ?? process.pid,
		});
	}

	async readConfigHealth(): Promise<ConfigHealthRecord | undefined> {
		const row = (await this.deps.client.query(api.logs.readConfigHealth, {
			ownerId: this.deps.ownerId,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as ConfigHealthRecord) : undefined;
	}

	subscribe(_filter: LogFilter, _cb: (e: SubsystemLogRecord) => void): Unsub {
		return () => undefined;
	}

	__unused = NotImplementedYet;
}
