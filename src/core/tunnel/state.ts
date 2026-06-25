/**
 * Tunnel runtime state — lets `brigade expose status` / `stop` (separate
 * short-lived processes) find a tunnel started by a long-running
 * `brigade expose`.
 *
 * Stored in the OS cache dir (NOT under ~/.brigade) because it is ephemeral
 * machine-local coordination — the same reasoning `resolveOsCacheDir` uses for
 * the gateway lock in convex mode, and it keeps `~/.brigade` clean under the
 * strict-zero guard. The file is unlinked on clean shutdown; a stale file is
 * reconciled by the pid liveness check in `readTunnelState`.
 */

import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";

import { resolveOsCacheDir } from "../../config/paths.js";

export interface TunnelState {
  /** Public URL without the token. */
  url: string;
  /** Public URL with `?token=` appended (when token-gated). */
  urlWithToken: string;
  /** Provider name. */
  provider: string;
  /** PID of the owning `brigade expose` process. */
  pid: number;
  /** Local auth-proxy port. */
  proxyPort: number;
  /** Gateway port being exposed. */
  gatewayPort: number;
  /** Whether a token gate is active. */
  secured: boolean;
  /** Epoch ms when the tunnel came up. */
  startedAt: number;
}

function tunnelStatePath(): string {
  return path.join(resolveOsCacheDir(), "gateway-tunnel.json");
}

/** Atomically persist tunnel state (tempfile + rename). */
export async function writeTunnelState(state: TunnelState): Promise<void> {
  const file = tunnelStatePath();
  await fsAsync.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsAsync.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsAsync.rename(tmp, file);
}

/**
 * Read tunnel state. Returns `undefined` when missing/unparseable. Does NOT
 * verify liveness — callers that care use `isProcessAlive(state.pid)`.
 */
export function readTunnelState(): TunnelState | undefined {
  try {
    const raw = fs.readFileSync(tunnelStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TunnelState>;
    if (
      typeof parsed.url === "string" &&
      typeof parsed.provider === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.proxyPort === "number"
    ) {
      return parsed as TunnelState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Remove the state file. Silent on missing file. */
export async function clearTunnelState(): Promise<void> {
  try {
    await fsAsync.unlink(tunnelStatePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
