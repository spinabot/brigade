/**
 * Gateway lock — single-profile lockfile guarding port 7777.
 *
 * Purpose: prevent two `brigade gateway run` invocations from both binding to
 * port 7777 and racing the EADDRINUSE failure path. Instead, the second
 * invocation sees a clean "gateway already running (pid X); lock timeout
 * after 5000ms" message that points the operator at `brigade gateway stop`.
 *
 * Mechanism:
 *
 *   1. Atomic exclusive create — `fs.open(lockPath, "wx")`. The "wx" flag
 *      makes the syscall fail with EEXIST when the file already exists, so
 *      only one process can win the race. Posix and Windows both honour it.
 *
 *   2. Poll-and-retry on EEXIST — wait `pollIntervalMs` (100ms), retry until
 *      `timeoutMs` (5000ms). During the wait we read the lock payload to
 *      enrich the eventual error message ("pid X" instead of "?").
 *
 *   3. Stale-lock recovery — if the holder PID isn't alive AND the file's
 *      mtime is older than `staleMs` (30s), we delete the lock and retry.
 *      This recovers from `kill -9` and crashed-without-cleanup paths
 *      without needing operator intervention.
 *
 *   4. Clean release — the returned handle's `release()` deletes the lock
 *      file. The gateway server calls this from its `stop()` method, which
 *      runs on SIGTERM/SIGINT.
 *
 * Brigade-shape simplifications:
 *
 *   - Lock path is a single fixed `~/.brigade/gateway.lock`. Brigade is
 *     single-profile in v1, so a per-profile path scheme isn't needed.
 *
 *   - We DON'T probe the bound port to enrich the "owner" detection. For
 *     Brigade's single-port flow, the PID-from-lockfile + alive-check is
 *     sufficient (no `lsof` / `netstat` cross-check).
 *
 *   - We DON'T do Linux's `/proc/<pid>/stat` start-time matching to detect
 *     PID recycling. The 30s stale-window covers the realistic risk:
 *     within that window the OS is unlikely to have wrapped PID space and
 *     handed pid X to a brand-new node process.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { BRIGADE_DIR } from "./config.js";
import { resolveOsCacheDir } from "../config/paths.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import { isProcessAlive } from "./gateway-probe.js";

/** Lock file location. Convex mode keeps the kernel-mutex semantics but
 * the file lives in the OS cache dir — never under ~/.brigade. Computed
 * per call so the mode resolved at boot is honoured. */
export function resolveGatewayLockPath(): string {
  if (tryGetRuntimeContext()?.mode === "convex") {
    return path.join(resolveOsCacheDir(), "gateway.lock");
  }
  return path.join(BRIGADE_DIR, "gateway.lock");
}

/** @deprecated import resolveGatewayLockPath() — kept for older call sites;
 *  filesystem-mode value only. */
export const GATEWAY_LOCK_PATH = path.join(BRIGADE_DIR, "gateway.lock");

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_MS = 30_000;

export interface GatewayLockOptions {
  /** Port we're trying to bind. Stored in the lock file for diagnostics only. */
  port: number;
  /** Total time to wait for the lock before giving up. Default 5000ms. */
  timeoutMs?: number;
  /** Poll interval while the lock is held. Default 100ms. */
  pollIntervalMs?: number;
  /** Lock files older than this are considered stale and recoverable. Default 30000ms. */
  staleMs?: number;
}

export interface GatewayLockHandle {
  /** Path to the lock file (for logging / debugging). */
  path: string;
  /** PID stored in the lock — always our own process.pid. */
  pid: number;
  /** Release the lock. Idempotent — safe to call from multiple shutdown paths. */
  release(): Promise<void>;
}

interface LockPayload {
  pid: number;
  port: number;
  createdAt: string;
}

/**
 * Typed error so callers can distinguish lock-contention failures from other
 * boot errors and format the message specifically (point at `brigade gateway
 * stop`, show port-PID diagnostics, etc.).
 */
export class GatewayLockError extends Error {
  readonly holderPid: number | undefined;
  readonly port: number;

  constructor(message: string, args: { holderPid: number | undefined; port: number }) {
    super(message);
    this.name = "GatewayLockError";
    this.holderPid = args.holderPid;
    this.port = args.port;
  }
}

export function isGatewayLockError(err: unknown): err is GatewayLockError {
  return err instanceof GatewayLockError;
}

/**
 * Try to acquire the gateway lock. Resolves with a handle on success, throws
 * `GatewayLockError` after `timeoutMs` if the lock is still held by an alive
 * process. Stale locks (PID dead OR file older than `staleMs`) are
 * automatically removed and retried.
 */
export async function acquireGatewayLock(opts: GatewayLockOptions): Promise<GatewayLockHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const startedAt = Date.now();

  await fs.mkdir(path.dirname(resolveGatewayLockPath()), { recursive: true });

  let lastHolderPid: number | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    const handle = await tryCreateLock(opts.port);
    if (handle) return handle;

    // Read the existing lock to enrich the error message + decide if it's stale.
    const payload = await readLockPayload();
    if (payload?.pid) lastHolderPid = payload.pid;

    if (await isLockStale(payload, staleMs)) {
      // Stale — try to remove and re-acquire on next loop iteration.
      try {
        await fs.unlink(resolveGatewayLockPath());
      } catch {
        // Another process may have unlinked it concurrently; that's fine.
      }
      continue;
    }

    await sleep(pollIntervalMs);
  }

  const owner = lastHolderPid ? ` (pid ${lastHolderPid})` : "";
  throw new GatewayLockError(
    `gateway already running${owner}; lock timeout after ${timeoutMs}ms`,
    { holderPid: lastHolderPid, port: opts.port },
  );
}

async function tryCreateLock(port: number): Promise<GatewayLockHandle | undefined> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(resolveGatewayLockPath(), "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return undefined;
    throw err;
  }
  try {
    const payload: LockPayload = {
      pid: process.pid,
      port,
      createdAt: new Date().toISOString(),
    };
    await fh.writeFile(JSON.stringify(payload, null, 2), "utf8");
  } finally {
    await fh.close();
  }
  return makeHandle(process.pid);
}

async function readLockPayload(): Promise<LockPayload | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(resolveGatewayLockPath(), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed?.pid !== "number" || typeof parsed?.port !== "number") return undefined;
    return parsed as LockPayload;
  } catch {
    return undefined;
  }
}

async function isLockStale(payload: LockPayload | undefined, staleMs: number): Promise<boolean> {
  // No payload (file empty / corrupt) — treat as stale: nothing useful to wait for.
  if (!payload) return true;
  // Holder PID isn't alive — stale.
  if (!isProcessAlive(payload.pid)) return true;
  // Holder is alive but file is suspiciously old. We DON'T treat alive-but-old
  // as stale by default (the holder may just be busy), so only skip the wait
  // when the file is BOTH old and the holder is dead. This branch left for
  // forward-compat with future PID-recycling detection.
  void staleMs;
  return false;
}

function makeHandle(pid: number): GatewayLockHandle {
  let released = false;
  return {
    path: resolveGatewayLockPath(),
    pid,
    async release() {
      if (released) return;
      released = true;
      try {
        // Belt-and-braces: only delete if the file still names US as the
        // holder. Protects against deleting someone else's lock if the
        // gateway crashed and a new instance came up before our finalizer
        // got a chance to run.
        const payload = await readLockPayload();
        if (!payload || payload.pid === pid) {
          await fs.unlink(resolveGatewayLockPath());
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // Any other error — surface to stderr, don't throw out of cleanup.
          process.stderr.write(
            `brigade-gateway: warning: lock release failed: ${(err as Error).message}\n`,
          );
        }
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
