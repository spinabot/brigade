/**
 * Gateway probe helpers — small utilities for `brigade status`, `brigade doctor`,
 * and `brigade gateway status|stop` to find out whether the gateway is up and,
 * if so, where its process lives so we can ask it to shut down.
 *
 * Two facets here:
 *
 *   1. **WS probe** (`probeGateway`): connect to ws://host:port, wait for
 *      the server's automatic `state` event on connect, return a friendly
 *      snapshot. Uses Brigade's state-on-connect event instead of an RPC
 *      method.
 *
 *   2. **PID file** (`readPidFile`, `writePidFile`, `clearPidFile`): the
 *      gateway writes `~/.brigade/gateway.pid` on boot and unlinks it on
 *      clean shutdown. `brigade gateway stop` reads that file, sends SIGTERM,
 *      and waits for the file to disappear (or times out). Brigade v1 has no
 *      service installer, so no OS-service-manager + netstat-pid-discovery
 *      stack is needed — this PID-file flow is the entire mechanism.
 */

import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";

import { WebSocket } from "ws";

import { BRIGADE_DIR } from "./config.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import type { SessionStateSnapshot } from "../protocol.js";

export const GATEWAY_PID_PATH = path.join(BRIGADE_DIR, "gateway.pid");

/**
 * Out-of-process supervisor heartbeat. The gateway writes the file every
 * tick (atomic via write-tempfile + rename) and an external supervisor
 * (`brigade supervisor`) reads its mtime to detect a wedged process — one
 * where the OS thinks the gateway is alive (PID file still present) but
 * the Node event loop is starved or deadlocked and can't update the file.
 *
 * The PID file proves the process EXISTS; the heartbeat proves it's
 * ALIVE and SERVICING. Both together let an external watcher distinguish
 * "crashed clean" from "hung process".
 */
export const GATEWAY_HEARTBEAT_PATH = path.join(BRIGADE_DIR, "gateway.heartbeat");

/**
 * Maximum age (ms) the heartbeat file can have before the supervisor
 * considers the gateway wedged. Default 90s gives the gateway up to two
 * missed tick intervals (TICK_INTERVAL_MS is 30s) before triggering a
 * restart — generous enough to absorb GC pauses + disk hiccups, tight
 * enough to recover within ~1.5 min of a real hang.
 */
export const GATEWAY_HEARTBEAT_STALE_MS = 90_000;

/** Payload shape written to GATEWAY_HEARTBEAT_PATH on every tick. */
export interface GatewayHeartbeat {
  /** Epoch ms when the gateway last wrote the file. */
  ts: number;
  /** Gateway's process PID; cross-check against gateway.pid. */
  pid: number;
  /** Process uptime in ms (process.uptime() * 1000) when written. */
  uptimeMs: number;
}

/**
 * Atomically write the heartbeat file. Tempfile + rename so a partial
 * write on a crashed process can never leave a half-parsed file behind.
 */
export async function writeHeartbeatFile(): Promise<void> {
  const payload: GatewayHeartbeat = {
    ts: Date.now(),
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
  };

  // Convex mode — the heartbeat is a gatewayCoord row, never a file.
  // (The supervisor + doctor read it back through the same store.)
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    try {
      await rctx.store.instance.writeHeartbeat(payload);
    } catch {
      // Heartbeat write failures degrade to "stale heartbeat" on the
      // supervisor side — same posture as a failed file write.
    }
    return;
  }

  await fsAsync.mkdir(path.dirname(GATEWAY_HEARTBEAT_PATH), { recursive: true });
  const tmp = `${GATEWAY_HEARTBEAT_PATH}.tmp`;
  await fsAsync.writeFile(tmp, JSON.stringify(payload), "utf8");
  await fsAsync.rename(tmp, GATEWAY_HEARTBEAT_PATH);
}

/**
 * Synchronously read the heartbeat file. Returns `undefined` when missing
 * or unparseable — callers (supervisor + doctor) treat both as "no heartbeat".
 * `pathOverride` is for tests; production callers leave it omitted so the
 * canonical `~/.brigade/gateway.heartbeat` is consulted.
 */
/** Mode-aware heartbeat read — convex consults the gatewayCoord row,
 *  filesystem reads the file. `pathOverride` (tests) forces the file. */
export async function readHeartbeat(pathOverride?: string): Promise<GatewayHeartbeat | undefined> {
  if (pathOverride === undefined) {
    const rctx = tryGetRuntimeContext();
    if (rctx?.mode === "convex") {
      try {
        return (await rctx.store.instance.readHeartbeat()) as GatewayHeartbeat | undefined;
      } catch {
        return undefined;
      }
    }
  }
  return readHeartbeatFile(pathOverride);
}

export function readHeartbeatFile(pathOverride?: string): GatewayHeartbeat | undefined {
  try {
    const raw = fs.readFileSync(pathOverride ?? GATEWAY_HEARTBEAT_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayHeartbeat>;
    if (
      typeof parsed.ts === "number" &&
      typeof parsed.pid === "number" &&
      typeof parsed.uptimeMs === "number" &&
      Number.isFinite(parsed.ts) &&
      Number.isFinite(parsed.pid) &&
      Number.isFinite(parsed.uptimeMs)
    ) {
      return parsed as GatewayHeartbeat;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Delete the heartbeat file. Called on graceful shutdown. */
export async function clearHeartbeatFile(): Promise<void> {
  try {
    await fsAsync.unlink(GATEWAY_HEARTBEAT_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Categorised reason a probe failed — callers (status, doctor, error
 * formatters) can surface specific recovery hints instead of dumping a
 * raw error string.
 */
export type GatewayProbeFailureKind =
  /** Connection refused — nothing listening on host:port. */
  | "refused"
  /** TCP/WS handshake didn't complete in time. */
  | "timeout"
  /** Hostname couldn't be resolved (bad --host). */
  | "dns"
  /** Server replied to the upgrade with a 4xx/5xx (auth or routing failure). */
  | "auth"
  /** TLS / certificate errors. */
  | "tls"
  /** Network unreachable / route missing. */
  | "network"
  /** Anything else — the message field carries the raw text. */
  | "other";

export interface GatewayProbeResult {
  reachable: boolean;
  url: string;
  /** Initial state snapshot from the server (only set when reachable). */
  state?: SessionStateSnapshot;
  /** Human-readable error when unreachable. */
  error?: string;
  /** Categorised failure reason, set when `reachable === false`. */
  errorKind?: GatewayProbeFailureKind;
  /** Round-trip ms from connect-attempt to first frame, when reachable. */
  rttMs?: number;
}

/**
 * Best-effort categorisation of an Error/string into a probe-failure kind.
 * The match list reflects the actual messages Node + `ws` produce on each
 * platform — verified against the real failure modes that surface in
 * `brigade gateway status`.
 */
export function classifyProbeFailure(err: unknown): GatewayProbeFailureKind {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  // Order matters: more-specific patterns first so e.g. "ENOTFOUND … timeout"
  // doesn't classify as a generic timeout.
  if (msg.includes("econnrefused")) return "refused";
  if (msg.includes("enotfound") || msg.includes("eai_again") || msg.includes("getaddrinfo")) return "dns";
  if (msg.includes("ehostunreach") || msg.includes("enetunreach")) return "network";
  if (msg.includes("certificate") || msg.includes("self signed") || msg.includes("ssl") || msg.includes("tls")) {
    return "tls";
  }
  if (msg.includes("unexpected server response")) return "auth";
  if (msg.includes("timed out") || msg.includes("etimedout") || msg.includes("handshake")) return "timeout";
  return "other";
}

export interface GatewayProbeOptions {
  host?: string;
  port?: number;
  /** Total wallclock budget. Default 1500ms — enough for a local boot, fast enough to keep `brigade status` snappy. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;

/**
 * Open a WebSocket to the gateway and read its state-on-connect frame.
 * Resolves whether the gateway is up; never throws on connection refused
 * (returns `{ reachable: false, error }`). Throws only on programmer errors.
 */
export async function probeGateway(opts: GatewayProbeOptions = {}): Promise<GatewayProbeResult> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `ws://${host}:${port}`;
  const start = Date.now();
  return await new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const finish = (result: GatewayProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // Best-effort; the listener cleanup runs anyway.
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ reachable: false, url, error: `timed out after ${timeoutMs}ms`, errorKind: "timeout" });
    }, timeoutMs);
    ws.on("error", (err) => {
      clearTimeout(timer);
      finish({ reachable: false, url, error: err.message, errorKind: classifyProbeFailure(err) });
    });
    ws.on("message", (data) => {
      // Server pushes a state event on connect (server.ts broadcast). Read
      // that, return, and close. We don't validate frame schema strictly —
      // any structured message proves the WS handshake completed and the
      // server responded.
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(typeof data === "string" ? data : data.toString());
        if (parsed?.type === "event" && parsed?.event === "state" && parsed?.payload) {
          finish({
            reachable: true,
            url,
            state: parsed.payload as SessionStateSnapshot,
            rttMs: Date.now() - start,
          });
          return;
        }
      } catch {
        // Non-JSON frame — still treat as reachable since the WS is up.
      }
      finish({ reachable: true, url, rttMs: Date.now() - start });
    });
  });
}

/**
 * Write the current process's PID to `~/.brigade/gateway.pid`. Called by
 * the gateway on boot. The directory is assumed to exist (the brigade dir
 * is created by `loadBrigadeConfig` on first read).
 */
export async function writePidFile(): Promise<void> {
  // Convex mode — the pid is a gatewayCoord row, never a file.
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    try {
      await rctx.store.instance.writePid(process.pid);
    } catch {
      // Degrades to "no pid visible" — same posture as a failed file write.
    }
    return;
  }

  await fsAsync.mkdir(path.dirname(GATEWAY_PID_PATH), { recursive: true });
  await fsAsync.writeFile(GATEWAY_PID_PATH, String(process.pid), "utf8");
}

/**
 * Remove the PID file. Called by the gateway on clean shutdown so the
 * next `brigade gateway status` doesn't report a dead PID. Silent on
 * missing file.
 */
export async function clearPidFile(): Promise<void> {
  try {
    await fsAsync.unlink(GATEWAY_PID_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Read the PID file. Returns `undefined` when the file is missing or
 * unparseable — callers fall back to "no gateway running" without
 * surfacing an error. `pathOverride` is for tests; production leaves it
 * omitted so the canonical `~/.brigade/gateway.pid` is consulted.
 */
export function readPidFile(pathOverride?: string): number | undefined {
  try {
    const raw = fs.readFileSync(pathOverride ?? GATEWAY_PID_PATH, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Mode-aware pid read — convex consults the gatewayCoord row, filesystem
 *  reads the file. `pathOverride` (tests) forces the file. */
export async function readPid(pathOverride?: string): Promise<number | undefined> {
  if (pathOverride === undefined) {
    const rctx = tryGetRuntimeContext();
    if (rctx?.mode === "convex") {
      try {
        return await rctx.store.instance.readPid();
      } catch {
        return undefined;
      }
    }
  }
  return readPidFile(pathOverride);
}

/**
 * Best-effort check whether `pid` is alive. Sends signal 0, which Node uses
 * for liveness probes (no actual signal delivered). On success the process
 * is alive; ESRCH means it's dead. EPERM (signal allowed but caller can't
 * deliver) still means the process exists, so we treat that as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
