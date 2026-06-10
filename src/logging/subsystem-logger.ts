// Structured subsystem logger for Brigade.
//
// Every callsite gets a small, named logger that emits JSON to a daily-rolling
// file under `<stateDir>/logs/` and (when stderr is a TTY or BRIGADE_LOG_CONSOLE
// is truthy) a colourised mirror to stderr. Callers pass a free-text message
// plus a structured field bag; the bag is merged into the JSON record and
// abbreviated on the console mirror.
//
// Why a custom logger instead of pulling in pino/winston/tslog:
//   • Brigade's runtime must boot in milliseconds. Three deps and a setup
//     routine for a logger we'd reskin anyway is bad return-on-bytes.
//   • Subsystem tags ("loop/retry", "auth/profiles", "fallback/decision") are
//     a Brigade convention; we want to control the truncation + colouring
//     rules without paying a config-tax to do it.
//   • The on-disk JSONL shape stays stable so a future `brigade logs` viewer
//     can ship without renegotiating the schema.
//
// Failure mode: the logger swallows file-write errors. Logging must never
// crash a turn; if the disk is full, the structured record still went to
// stderr (when enabled) and the run continues.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ensureDir, resolveLogsDir, resolveStateDir } from "../config/paths.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
};

export interface SubsystemLogger {
  readonly subsystem: string;
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  fatal(message: string, fields?: Record<string, unknown>): void;
  /** Append `name` to the subsystem tag. */
  child(name: string): SubsystemLogger;
  /** Return a logger that auto-merges `boundFields` into every emit's field bag. */
  bind(boundFields: Record<string, unknown>): SubsystemLogger;
}

// Process-level mutable state — single-process expectation; the logger is a
// host-level service, not per-agent or per-session.
let activeLevel: LogLevel = resolveInitialLevel();
let consoleEnabled = resolveInitialConsole();
let logFilePath: string | null = null;
let suppressFileWrites = false;
// One-shot init guard — Node's event loop is single-threaded so a "race"
// between two synchronous emits is impossible; this latch documents the
// invariant and protects against a future move to worker threads where
// two `emit` callers could re-enter `writeFileLine` before the first
// completed its setup. Cheap, no perf cost on the steady-state path.
let logFilePathInitialised = false;

const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000;            // 24h prune window

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

export function setConsoleLogging(enabled: boolean): void {
  consoleEnabled = enabled;
}

export function getActiveLogLevel(): LogLevel {
  return activeLevel;
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  return buildLoggerForTag(sanitiseSubsystem(subsystem), undefined);
}

/** Internal: build a logger for a (tag, optional bound-fields) pair. */
function buildLoggerForTag(
  tag: string,
  boundFields: Record<string, unknown> | undefined,
): SubsystemLogger {
  const merge = (f?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!boundFields) return f;
    if (!f) return boundFields;
    return { ...boundFields, ...f };
  };
  return {
    subsystem: tag,
    trace: (m, f) => emit("trace", tag, m, merge(f)),
    debug: (m, f) => emit("debug", tag, m, merge(f)),
    info: (m, f) => emit("info", tag, m, merge(f)),
    warn: (m, f) => emit("warn", tag, m, merge(f)),
    error: (m, f) => emit("error", tag, m, merge(f)),
    fatal: (m, f) => emit("fatal", tag, m, merge(f)),
    child(name: string): SubsystemLogger {
      return buildLoggerForTag(`${tag}/${sanitiseSubsystem(name)}`, boundFields);
    },
    bind(extraFields: Record<string, unknown>): SubsystemLogger {
      const next = { ...(boundFields ?? {}), ...extraFields };
      return buildLoggerForTag(tag, next);
    },
  };
}

function emit(
  level: LogLevel,
  subsystem: string,
  message: string,
  fields: Record<string, unknown> | undefined,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;

  const record = {
    time: new Date().toISOString(),
    level,
    subsystem,
    message,
    ...(fields ? sanitiseFields(fields) : {}),
  };

  const line = safeStringify(record);
  writeFileLine(line);
  if (consoleEnabled) writeConsoleLine(level, subsystem, message, fields);
}

// ─────────────────────────────────────────────────────────────────────────────
// File output. We open a fresh file path for every write rather than caching a
// FileHandle so a midnight rollover or `rm` from another process doesn't
// silently strand the writer.
// ─────────────────────────────────────────────────────────────────────────────

// Convex-mode batched sink. Pre-context emits (the boot window before
// bootRuntimeContext resolves) buffer in memory; the mode is peeked from
// the sentinel/env DIRECTLY so a convex-mode boot never writes the log
// file even before the context exists. Filesystem mode stays byte-
// identical (immediate sync appendFileSync — today's behaviour).
let modePeek: "filesystem" | "convex" | undefined;
const convexRowBuffer: Array<Record<string, unknown>> = [];
let convexLogFlushChain: Promise<void> = Promise.resolve();
let convexLogFlushTimer: ReturnType<typeof setTimeout> | undefined;
const CONVEX_LOG_FLUSH_MS = 1_000;
const CONVEX_LOG_BUFFER_CAP = 5_000;

function peekStorageMode(): "filesystem" | "convex" {
  if (modePeek) return modePeek;
  try {
    const explicit = process.env.BRIGADE_MODE?.trim();
    if (explicit === "convex" || explicit === "filesystem") {
      modePeek = explicit;
      return modePeek;
    }
    const sentinelPath = path.join(resolveStateDir(), "mode.sentinel");
    if (fs.existsSync(sentinelPath)) {
      const parsed = JSON.parse(fs.readFileSync(sentinelPath, "utf8")) as { mode?: string };
      modePeek = parsed.mode === "convex" ? "convex" : "filesystem";
      return modePeek;
    }
    if (process.env.BRIGADE_CONVEX_URL?.trim()) {
      modePeek = "convex";
      return modePeek;
    }
  } catch {
    // Unreadable sentinel etc. — boot will throw a proper error; logs
    // default to filesystem behaviour meanwhile.
  }
  modePeek = "filesystem";
  return modePeek;
}

function scheduleConvexLogFlush(): void {
  if (convexLogFlushTimer) return;
  convexLogFlushTimer = setTimeout(() => {
    convexLogFlushTimer = undefined;
    void flushConvexLogRows();
  }, CONVEX_LOG_FLUSH_MS);
  convexLogFlushTimer.unref?.();
}

function flushConvexLogRows(): Promise<void> {
  const ctx = tryGetRuntimeContext();
  if (!ctx) {
    // Store not ready yet — keep buffering (bounded); drain on next tick.
    scheduleConvexLogFlush();
    return convexLogFlushChain;
  }
  const rows = convexRowBuffer.splice(0, convexRowBuffer.length);
  if (rows.length === 0) return convexLogFlushChain;
  const store = ctx.store;
  convexLogFlushChain = convexLogFlushChain
    .then(async () => {
      for (const row of rows) {
        await store.logs.appendSubsystemRecord(row as never);
      }
    })
    .catch(() => {
      /* observability rows — never crash a turn for a log write */
    });
  return convexLogFlushChain;
}

/** Drained by the gateway on shutdown. */
export async function awaitSubsystemLogFlush(): Promise<void> {
  await flushConvexLogRows();
  await convexLogFlushChain;
}

/** Test-only. */
export function __resetSubsystemConvexSinkForTests(): void {
  modePeek = undefined;
  convexRowBuffer.length = 0;
  convexLogFlushChain = Promise.resolve();
  if (convexLogFlushTimer) {
    clearTimeout(convexLogFlushTimer);
    convexLogFlushTimer = undefined;
  }
}

function writeFileLine(line: string): void {
  if (peekStorageMode() === "convex") {
    // Rows are structured JSON already (emit serialises before calling us).
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (convexRowBuffer.length < CONVEX_LOG_BUFFER_CAP) convexRowBuffer.push(row);
      scheduleConvexLogFlush();
    } catch {
      /* non-JSON line — drop; the stderr mirror already carried it */
    }
    return;
  }

  if (suppressFileWrites) return;
  try {
    if (!logFilePathInitialised) {
      // Set the latch BEFORE the disk work so a re-entrant emit on the
      // same tick (or a future worker-thread caller) sees the latch and
      // skips the prune/dir setup, avoiding double-prune and racing
      // path-resolution.
      logFilePathInitialised = true;
      const dir = resolveLogsDir();
      ensureDir(dir);
      logFilePath = resolveLogFilePath(dir);
      pruneOldRollingLogs(dir);
    }
    if (!logFilePath) {
      // Latch was set but path resolution failed; bail rather than crash.
      return;
    }

    // Honour the size cap — once exceeded, suppress further writes for this
    // process's lifetime rather than rolling over mid-day. A future operator
    // can rotate the file out manually; the stderr mirror still works.
    let bytes = 0;
    try {
      bytes = fs.statSync(logFilePath).size;
    } catch {
      // first write — no file yet
    }
    if (bytes >= DEFAULT_MAX_LOG_FILE_BYTES) {
      suppressFileWrites = true;
      try {
        process.stderr.write(
          `brigade: log file size cap reached (${bytes} bytes); suppressing further writes ` +
            `to ${logFilePath}\n`,
        );
      } catch {
        // best-effort
      }
      return;
    }

    fs.appendFileSync(logFilePath, line + "\n", "utf8");
  } catch {
    // swallowed by design — see header
  }
}

function resolveLogFilePath(dir: string): string {
  const today = new Date();
  const yyyy = today.getFullYear().toString().padStart(4, "0");
  const mm = (today.getMonth() + 1).toString().padStart(2, "0");
  const dd = today.getDate().toString().padStart(2, "0");
  return path.join(dir, `brigade-${yyyy}-${mm}-${dd}.log`);
}

function pruneOldRollingLogs(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_LOG_AGE_MS;
  for (const name of entries) {
    if (!name.startsWith("brigade-") || !name.endsWith(".log")) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      // best-effort
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console mirror. Subsystems get a deterministic colour from a small palette
// so the eye can latch onto a tag while scanning. Errors and warns get level
// colour overrides regardless of subsystem.
// ─────────────────────────────────────────────────────────────────────────────

const SUBSYSTEM_COLOURS = ["\x1b[36m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[31m"];
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_GREY = "\x1b[90m";

function writeConsoleLine(
  level: LogLevel,
  subsystem: string,
  message: string,
  fields: Record<string, unknown> | undefined,
): void {
  const useColour = process.stderr.isTTY === true;
  const tagColour = useColour ? colourForSubsystem(subsystem) : "";
  const levelColour = useColour ? colourForLevel(level) : "";
  const reset = useColour ? ANSI_RESET : "";
  const dim = useColour ? ANSI_DIM : "";

  const time = new Date().toISOString().slice(11, 19);
  const tag = `[${subsystem}]`;
  const fieldText = formatFieldsForConsole(fields, useColour);
  const levelToken = level.toUpperCase().padEnd(5, " ");

  const line =
    `${dim}${time}${reset} ${levelColour}${levelToken}${reset} ` +
    `${tagColour}${tag}${reset} ${message}${fieldText}\n`;

  try {
    process.stderr.write(line);
  } catch {
    // best-effort
  }
}

function colourForSubsystem(subsystem: string): string {
  let hash = 0;
  for (let i = 0; i < subsystem.length; i++) hash = (hash * 31 + subsystem.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % SUBSYSTEM_COLOURS.length;
  return SUBSYSTEM_COLOURS[idx] ?? "";
}

function colourForLevel(level: LogLevel): string {
  if (level === "error" || level === "fatal") return ANSI_RED;
  if (level === "warn") return ANSI_YELLOW;
  if (level === "trace" || level === "debug") return ANSI_GREY;
  return "";
}

function formatFieldsForConsole(
  fields: Record<string, unknown> | undefined,
  useColour: boolean,
): string {
  if (!fields) return "";
  const keys = Object.keys(fields);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  const dim = useColour ? ANSI_DIM : "";
  const reset = useColour ? ANSI_RESET : "";
  for (const k of keys) {
    const v = fields[k];
    if (v === undefined) continue;
    parts.push(`${dim}${k}=${reset}${formatFieldValueForConsole(v)}`);
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function formatFieldValueForConsole(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 80 ? value.slice(0, 77) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const json = JSON.stringify(value);
    return json.length > 120 ? json.slice(0, 117) + "…" : json;
  } catch {
    return String(value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

function resolveInitialLevel(): LogLevel {
  const raw = process.env.BRIGADE_LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return "info";
  if (raw === "trace" || raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "fatal") {
    return raw;
  }
  return "info";
}

function resolveInitialConsole(): boolean {
  const raw = process.env.BRIGADE_LOG_CONSOLE?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  // Default: mirror to stderr only when it's a TTY. CI / piped output stays
  // clean unless explicitly opted-in.
  return process.stderr.isTTY === true;
}

function sanitiseSubsystem(name: string): string {
  // Subsystem tags appear in JSON, on the console, and in file names. Strip
  // anything that would break a CLI grep or a JSON parser.
  return name.trim().replace(/[\s"'\\]/g, "-").replace(/-+/g, "-").slice(0, 64) || "unknown";
}

function sanitiseFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message };
      continue;
    }
    out[k] = v;
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Fallback for circular / BigInt-bearing objects.
    return JSON.stringify({
      time: new Date().toISOString(),
      level: "warn",
      subsystem: "logger",
      message: "log record was not serialisable",
    });
  }
}

// Small public probe — useful for CLI commands that want to print the
// resolved log destination without forcing an emit.
export function describeLogState(): { level: LogLevel; consoleEnabled: boolean; logFile: string | null; host: string } {
  return {
    level: activeLevel,
    consoleEnabled,
    logFile: logFilePath,
    host: os.hostname(),
  };
}

// Test-support: reset the process-level state so a test suite can run
// against a known clean logger. NOT a public API — production callers
// should never invoke this. Worker-thread support, when it lands, will
// move this state into a per-thread store rather than relying on reset.
export function __resetLoggerStateForTests(): void {
  activeLevel = resolveInitialLevel();
  consoleEnabled = resolveInitialConsole();
  logFilePath = null;
  logFilePathInitialised = false;
  suppressFileWrites = false;
}

// ============================================================================
// Public append + read + prune helpers (added in Phase 2 PR4 so the
// BrigadeStore `LogStore` adapter can read+write subsystem records through
// a typed seam. The existing per-callsite logger API
// (`createSubsystemLogger().info(...)`) keeps working unchanged.
// ============================================================================

/**
 * Append a structured record directly to the daily log file. Same write
 * path as the standard logger emit — honours the size cap, no-ops if the
 * level filter would drop it.
 *
 * Record MUST contain `level` + `subsystem`; everything else is structured
 * metadata that gets serialised verbatim.
 */
export function appendSubsystemRecord(record: {
  level: LogLevel;
  subsystem: string;
  message: string;
  time?: string;
  fields?: Record<string, unknown>;
}): void {
  if (LEVEL_ORDER[record.level] < LEVEL_ORDER[activeLevel]) return;
  const out = {
    time: record.time ?? new Date().toISOString(),
    level: record.level,
    subsystem: sanitiseSubsystem(record.subsystem),
    message: record.message,
    ...(record.fields ? sanitiseFields(record.fields) : {}),
  };
  writeFileLine(safeStringify(out));
  if (consoleEnabled) writeConsoleLine(record.level, record.subsystem, record.message, record.fields);
}

/**
 * Read records from today's subsystem log file, optionally filtered by
 * `level` / `subsystem` / `tail` byte budget. Malformed lines are skipped.
 *
 *   filter.level     — minimum LogLevel (records below the threshold are dropped)
 *   filter.subsystem — exact-match string OR a prefix (when ending in "/")
 *   filter.day       — YYYY-MM-DD; default today
 *   filter.tailBytes — only parse the last N bytes (default 256 KiB)
 *
 * Returns records in file order (oldest-first within the tail slice).
 */
export function readSubsystemRecords(
  filter: {
    level?: LogLevel;
    subsystem?: string;
    day?: string;
    tailBytes?: number;
  } = {},
): Array<{
  time: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  [field: string]: unknown;
}> {
  const dir = resolveLogsDir();
  const file = filter.day && /^\d{4}-\d{2}-\d{2}$/.test(filter.day)
    ? path.join(dir, `brigade-${filter.day}.log`)
    : resolveLogFilePath(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const tailBytes = Math.max(1, filter.tailBytes ?? 256 * 1024);
  const start = Math.max(0, stat.size - tailBytes);
  let chunk: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const len = stat.size - start;
      chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const minRank = filter.level ? LEVEL_ORDER[filter.level] : 0;
  const subFilter = filter.subsystem;
  const wantPrefix = subFilter !== undefined && subFilter.endsWith("/");

  const out: ReturnType<typeof readSubsystemRecords> = [];
  for (const line of chunk.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { level?: LogLevel; subsystem?: string; time?: string; message?: string; [k: string]: unknown };
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row.level || !row.subsystem || !row.time || row.message === undefined) continue;
    if (filter.level && LEVEL_ORDER[row.level] < minRank) continue;
    if (subFilter !== undefined) {
      if (wantPrefix) {
        if (!row.subsystem.startsWith(subFilter)) continue;
      } else if (row.subsystem !== subFilter) continue;
    }
    out.push(row as ReturnType<typeof readSubsystemRecords>[number]);
  }
  return out;
}

/**
 * Drop log files older than `olderThanMs`. Returns the count actually
 * removed. The standard daily-roll prune already runs on the first emit
 * of each process; this exposes the same logic for explicit cleanup
 * (`brigade doctor --prune-logs`, store-level maintenance, tests).
 */
export function pruneSubsystemLogs(olderThanMs: number): { removed: number } {
  const dir = resolveLogsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith("brigade-") || !name.endsWith(".log")) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return { removed };
}
