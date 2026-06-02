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

import { ensureDir, resolveLogsDir } from "../config/paths.js";

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

function writeFileLine(line: string): void {
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
