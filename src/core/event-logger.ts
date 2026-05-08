/**
 * Brigade event logger — writes every Pi session event to a JSONL file
 * under `~/.brigade/logs/<YYYY-MM-DD>.jsonl`. One file per day, append-only.
 *
 * Why: Brigade has no other log sink. When something goes weird (model
 * hangs, hallucination, mid-turn switch confusion), the user can `cat`
 * today's log file and see the actual event sequence — including timestamps,
 * tool calls, errors, retries, all of it.
 *
 * Format: one JSON object per line, with these always-present fields:
 *   { ts: <ISO 8601>, type: <event.type>, ... event-specific fields ... }
 *
 * Failure mode: if the log file can't be opened or a write fails, the logger
 * silently degrades — log loss is preferable to crashing the user's chat.
 * Errors are surfaced to stderr at startup ONLY (not on every write).
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";

import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import { BRIGADE_DIR } from "./config.js";

/** Directory we append to. Created lazily on first write. */
const LOGS_DIR = path.join(BRIGADE_DIR, "logs");

/**
 * Per-file size cap. Once today's `.jsonl` exceeds this, we rotate to
 * `<day>.jsonl.1` (rotating any prior `.1` to `.2`, up to MAX_LOG_BACKUPS).
 * Mirrors openclaw's `MAX_LOG_FILE_BYTES = 500 * 1024 * 1024` from
 * `src/logging/logger.ts:50`. Brigade's surface is smaller so 100 MB is
 * plenty in normal use; runaway days (broken stream loops, attack-style
 * spam) are still bounded.
 */
const MAX_LOG_FILE_BYTES = 100 * 1024 * 1024;
const MAX_LOG_BACKUPS = 4;
/** Check size every N writes so the stat call doesn't dominate hot paths. */
const SIZE_CHECK_EVERY_N_WRITES = 32;

/** YYYY-MM-DD using UTC so log files don't roll over at confusing local times. */
function todayFile(): string {
	const now = new Date();
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return path.join(LOGS_DIR, `${y}-${m}-${d}.jsonl`);
}

/**
 * Subscribe to a session's events and write each one to today's log file.
 * Returns an unsubscribe function — call it when the session ends to detach.
 *
 * One unsub per session is sufficient; we don't deduplicate.
 */
export function attachEventLogger(session: AgentSession): () => void {
	let warnedOnce = false;
	let writeCount = 0;

	const ensureDir = (): boolean => {
		try {
			if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
			return true;
		} catch (err) {
			if (!warnedOnce) {
				warnedOnce = true;
				// Print once at first failure — never on every write
				process.stderr.write(
					`brigade: could not create log directory ${LOGS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
			return false;
		}
	};

	const writeEvent = (event: AgentSessionEvent): void => {
		if (!ensureDir()) return;
		// Build the row. Strip massive fields (full message contents repeated on
		// every delta) — we want the log to be greppable, not a token-by-token
		// replay. Tool calls, errors, retries, state changes are kept full.
		const row = serializeForLog(event);
		const filePath = todayFile();
		// Periodically check file size and rotate before write to keep log
		// files bounded. Cheap stat every N writes — checking on every write
		// would dominate hot paths during streaming. Mirrors openclaw's
		// size-cap pattern (`src/logging/logger.ts:183-197`).
		if (writeCount % SIZE_CHECK_EVERY_N_WRITES === 0) {
			rotateIfTooLarge(filePath);
		}
		writeCount++;
		try {
			appendFileSync(filePath, JSON.stringify(row) + "\n", "utf8");
		} catch {
			/* drop the line — never crash the chat for a log write */
		}
	};

	return session.subscribe(writeEvent);
}

/**
 * Rotate the file if it's over MAX_LOG_FILE_BYTES. Series:
 *   <path>.jsonl     → <path>.jsonl.1   (most recent backup)
 *   <path>.jsonl.1   → <path>.jsonl.2
 *   ...
 *   <path>.jsonl.<MAX_LOG_BACKUPS-1>   → unlinked (oldest dropped)
 *
 * All operations are best-effort; rotation failures fall through silently
 * so the next append still has a chance to succeed (worst case: no rotation
 * happened, file keeps growing, next check tries again).
 */
function rotateIfTooLarge(filePath: string): void {
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		// File doesn't exist yet — nothing to rotate.
		return;
	}
	if (size < MAX_LOG_FILE_BYTES) return;
	// Drop the oldest backup, then shift the rest down.
	const oldest = `${filePath}.${MAX_LOG_BACKUPS}`;
	try {
		unlinkSync(oldest);
	} catch {
		/* may not exist — fine */
	}
	for (let n = MAX_LOG_BACKUPS - 1; n >= 1; n--) {
		const src = `${filePath}.${n}`;
		const dst = `${filePath}.${n + 1}`;
		try {
			renameSync(src, dst);
		} catch {
			/* may not exist — fine */
		}
	}
	try {
		renameSync(filePath, `${filePath}.1`);
	} catch {
		// If we can't rotate, leave the file alone. Caller will append on
		// top and the next size-check tries again — better than throwing.
	}
}

/**
 * Convert a Pi event into a log-friendly row. The full event payload often
 * includes the cumulative assistant message on every delta — that turns a
 * 500-token reply into 500 copies of itself in the log. We keep just what's
 * useful for debugging:
 *
 *   - All event types kept (so the timeline is complete)
 *   - For message_update: just the type + delta (not the full cumulative content)
 *   - For message_end: full final content (so we can replay the assistant reply)
 *   - For tool_execution_*: full args/result (this is what we want to debug)
 *   - For agent_*, turn_*, compaction_*, auto_retry_*: keep all fields
 */
function serializeForLog(event: AgentSessionEvent): Record<string, unknown> {
	const ts = new Date().toISOString();
	const ev = event as any;

	const base = { ts, type: ev.type };

	switch (ev.type) {
		case "message_update": {
			// Keep just the inner event type + delta if present; skip the
			// cumulative `message` payload (logged at message_end).
			const inner = ev.assistantMessageEvent;
			return {
				...base,
				inner: inner?.type,
				delta: inner?.delta,
			};
		}
		case "message_end":
			// Final message — full content kept for replay/debugging.
			return { ...base, role: ev.message?.role, content: ev.message?.content, stopReason: ev.message?.stopReason };
		case "tool_execution_start":
			return { ...base, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args };
		case "tool_execution_end":
			return { ...base, toolCallId: ev.toolCallId, toolName: ev.toolName, isError: ev.isError, result: ev.result };
		case "auto_retry_start":
			return { ...base, attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, errorMessage: ev.errorMessage };
		case "auto_retry_end":
			return { ...base, success: ev.success, attempt: ev.attempt, finalError: ev.finalError };
		case "compaction_end":
			return { ...base, aborted: ev.aborted, willRetry: ev.willRetry, errorMessage: ev.errorMessage };
		case "agent_end":
			// Don't dump every message — just count.
			return { ...base, messageCount: Array.isArray(ev.messages) ? ev.messages.length : 0 };
		default:
			// agent_start, turn_start, turn_end, message_start, compaction_start,
			// session_info_changed, queue_update — keep base fields only.
			return base;
	}
}

/** Path of today's log file — useful for `/log` slash command later. */
export function getTodayLogPath(): string {
	return todayFile();
}

/**
 * Pull the most recent error-shaped event out of today's JSONL log. Used by
 * `brigade gateway status` (and friends) to surface a "last error" hint when
 * the gateway is stopped — operator gets a breadcrumb pointing at the cause
 * without having to grep the file themselves.
 *
 * Returns `undefined` when:
 *   - The log file doesn't exist yet (first-run).
 *   - No event in the last `lookbackBytes` slice looks like an error.
 *   - File is unreadable.
 *
 * Mirrors openclaw's "Last gateway error: ..." line in
 * `src/cli/daemon-cli/status.print.ts:172-193`.
 */
export interface LastErrorSnapshot {
  ts: string;
  message: string;
  type?: string;
}

export function getLastLoggedError(opts: { lookbackBytes?: number } = {}): LastErrorSnapshot | undefined {
  const filePath = todayFile();
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  const lookback = opts.lookbackBytes ?? 64 * 1024;
  const start = Math.max(0, stat.size - lookback);
  let chunk: Buffer;
  try {
    // Read a tail slice synchronously — this runs from the status command,
    // never on a hot path. Reading the whole file would be wasteful on big
    // logs (size-cap is 100 MB).
    const fs = require("node:fs") as typeof import("node:fs");
    const fd = fs.openSync(filePath, "r");
    try {
      const len = stat.size - start;
      chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = chunk.toString("utf8").split("\n");
  // Scan tail-to-head for the most recent error-shaped row.
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof row.type === "string" ? row.type : undefined;
    // Brigade's serializer surfaces the following error-shaped events:
    //   tool_execution_end (isError === true)
    //   auto_retry_start (errorMessage)
    //   compaction_end (aborted, errorMessage)
    //   agent_end with stopReason === "error" — but that's not directly logged
    if (type === "tool_execution_end" && row.isError === true) {
      const result = typeof row.result === "string" ? row.result : JSON.stringify(row.result);
      return { ts: String(row.ts ?? ""), type, message: `tool ${row.toolName} failed: ${result}` };
    }
    if (type === "auto_retry_start" && typeof row.errorMessage === "string") {
      return { ts: String(row.ts ?? ""), type, message: `auto retry: ${row.errorMessage}` };
    }
    if (type === "compaction_end" && row.aborted === true && typeof row.errorMessage === "string") {
      return { ts: String(row.ts ?? ""), type, message: `compaction aborted: ${row.errorMessage}` };
    }
  }
  return undefined;
}
