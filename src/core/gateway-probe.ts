/**
 * Gateway probe helpers — small utilities for `brigade status`, `brigade doctor`,
 * and `brigade gateway status|stop` to find out whether the gateway is up and,
 * if so, where its process lives so we can ask it to shut down.
 *
 * Two facets here:
 *
 *   1. **WS probe** (`probeGateway`): connect to ws://host:port, wait for the
 *      server's automatic `state` event on connect, return a friendly snapshot.
 *      Mirrors openclaw's `probeGatewayStatus` (`src/cli/daemon-cli/probe.ts:17`)
 *      but uses Brigade's own state-on-connect event instead of an RPC method.
 *
 *   2. **PID file** (`readPidFile`, `writePidFile`, `clearPidFile`): the
 *      gateway writes `~/.brigade/gateway.pid` on boot and unlinks it on
 *      clean shutdown. `brigade gateway stop` reads that file, sends SIGTERM,
 *      and waits for the file to disappear (or times out). Brigade-native
 *      replacement for openclaw's OS-service-manager + netstat-pid-discovery
 *      stack (`src/infra/gateway-processes.ts`) — way simpler because brigade
 *      v1 has no service installer.
 */

import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";

import { WebSocket } from "ws";

import { BRIGADE_DIR } from "./config.js";
import type { SessionStateSnapshot } from "../protocol.js";

export const GATEWAY_PID_PATH = path.join(BRIGADE_DIR, "gateway.pid");

/**
 * Categorised reason a probe failed. Mirrors openclaw's
 * `resolveProbeFailureMessage` distinction (`src/cli/daemon-cli/probe.ts:8-11`)
 * so callers (status, doctor, error formatters) can surface specific
 * recovery hints instead of dumping a raw error string.
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
 * surfacing an error.
 */
export function readPidFile(): number | undefined {
  try {
    const raw = fs.readFileSync(GATEWAY_PID_PATH, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
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
