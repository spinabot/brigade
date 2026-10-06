// Cross-process advisory lock for session JSONL files.
//
// Two `brigade agent` invocations targeting the same session would otherwise
// race the JSONL append path. Pi's SessionManager doesn't lock; if process A
// writes a partial line and process B writes its own line in the middle, the
// transcript ends up with interleaved bytes that the next reader can't parse
// (and our session-file-repair would have to drop). Worse, both processes
// believe their writes succeeded.
//
// Strategy: PID-tagged lockfile next to the session JSONL. Acquire by
// creating the file atomically WITH its payload (write a private temp file,
// then `fs.link` it into place — exclusive by construction; see the
// creation-window race note below). If creation fails because the lock
// already exists, read the holder PID and decide:
//   • holder is alive → wait, retry with backoff
//   • holder is dead → steal the lock (unlink it and retry)
//   • holder is older than STALE_LOCK_MS → steal regardless
//
// On release we unlink the lockfile. On crash, the lockfile gets stale-stolen
// by the next acquirer rather than blocking the user forever.
//
// Creation-window race: with a plain `open("wx")` + follow-up payload write,
// the lockfile exists for a window with NO owner in it, and a competing
// acquirer would read an empty/unparseable file — indistinguishable from
// "holder is dead" — and steal the lock while the true holder is still
// writing. Two mitigations, belt and braces:
//   1. The payload is created atomically with the file (temp + fs.link), so
//      the owner is readable from the instant the lockfile exists.
//   2. Every lock carries a random token: an acquirer never steals a file
//      carrying its own token (that is a peer acquire in this same process
//      mid-creation), and a release whose lockfile now holds a different
//      token is a no-op (our lock was stolen; the new holder owns it).
//   3. A fresh-but-unparseable lockfile is given a short grace before it can
//      be declared dead — on filesystems without hard links the fallback
//      path reintroduces a payload window, and "unparseable" must mean
//      "possibly mid-creation", not "holder is dead". After the grace it
//      is corrupt leftovers and is stolen as before.
//
// Why not `proper-lockfile`/`fs-ext`/etc.: zero-dep is the rule for the
// runtime kernel. The file is small, the algorithm is fifteen lines, and
// the failure mode (waiting up to STALE_LOCK_MS for a stale lock to be
// stolen) is acceptable for a CLI agent service.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("sessions/lock");

// Lockfile age past which we steal regardless of whether the holder PID is
// pingable. Generous because a long-running compaction can hold the session
// for several minutes legitimately.
const STALE_LOCK_MS = 10 * 60_000; // 10 minutes
// How long a fresh lockfile with an unparseable payload is presumed to be a
// peer mid-creation (fallback filesystems) rather than corrupt leftovers.
const UNPARSEABLE_GRACE_MS = 5_000;
const POLL_INITIAL_MS = 50;
const POLL_MAX_MS = 1_000;

export interface SessionWriteLock {
  release: () => Promise<void>;
  // Matches the token written into the lockfile payload. Lets release detect
  // that the lock was stolen by a peer (different token on disk now).
  token: string;
}

export interface AcquireSessionWriteLockArgs {
  sessionFile: string;
  // Caller-provided abort signal — wakes the waiter if the user Ctrl-Cs
  // while we're waiting for a busy lock.
  signal?: AbortSignal;
  // Cap on how long we'll wait before giving up. Default 30s; at the
  // threshold we throw rather than silently stealing, so the operator
  // sees a real error if a peer process is genuinely stuck.
  timeoutMs?: number;
}

interface LockfileContents {
  pid: number;
  hostname?: string;
  acquiredAt: number;
  // Random per-acquisition id; see the header comment on the
  // creation-window race. Optional because lockfiles written by older
  // brigade versions carry no token.
  token?: string;
}

export async function acquireSessionWriteLock(
  args: AcquireSessionWriteLockArgs,
): Promise<SessionWriteLock> {
  const lockPath = `${args.sessionFile}.lock`;
  const dir = path.dirname(args.sessionFile);
  await fs.mkdir(dir, { recursive: true });

  const deadline = Date.now() + (args.timeoutMs ?? 30_000);
  let pollMs = POLL_INITIAL_MS;
  // Fixed for this acquisition attempt: written into the lockfile payload,
  // used to recognize our own mid-creation file (steal guard) and our own
  // stolen-and-recreated file (release guard).
  const token = randomUUID();

  while (true) {
    if (args.signal?.aborted) {
      throw args.signal.reason ?? new Error("Lock acquisition aborted");
    }

    try {
      await createLockFileAtomic(lockPath, {
        pid: process.pid,
        acquiredAt: Date.now(),
        token,
      });
      log.debug("session lock acquired", { lockPath, pid: process.pid });
      return { release: () => releaseLock(lockPath, token), token };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }
    }

    // Lock held — inspect the holder.
    const stolen = await maybeStealStaleLock(lockPath, token);
    if (stolen) continue;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for session write lock (${lockPath}). ` +
          `Another brigade process is writing this session — wait for it to ` +
          `finish or remove the lockfile manually if the holder is dead.`,
      );
    }

    await waitWithSignal(pollMs, args.signal);
    pollMs = Math.min(POLL_MAX_MS, Math.floor(pollMs * 1.5));
  }
}

/**
 * Create the lockfile with its payload already in place: write a private
 * temp file, then hard-link it onto the lock path, then unlink the temp.
 * `fs.link` fails with EEXIST if the lock exists, so whichever process
 * links first holds the lock and its payload is readable from the instant
 * the lockfile exists — a competing acquirer never observes a lockfile
 * that exists but has no owner yet.
 *
 * On filesystems where hard links are unavailable (some Windows reparse
 * setups), falls back to the open("wx") + write sequence; the token guards
 * in the header comment still cover that path's payload window.
 */
async function createLockFileAtomic(
  lockPath: string,
  payload: LockfileContents,
): Promise<void> {
  const dir = path.dirname(lockPath);
  const tmp = path.join(dir, `${path.basename(lockPath)}.${process.pid}-${randomUUID()}.tmp`);
  const serialized = JSON.stringify(payload);
  try {
    await fs.writeFile(tmp, serialized, { encoding: "utf8" });
    try {
      await fs.link(tmp, lockPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EEXIST") throw err;
      // Fallback for filesystems without hard links: the classic
      // open("wx") + write. The token guards (header comment) still apply;
      // the payload gap this reintroduces is only hit where links don't
      // work at all, and it is the same window the token guard covers.
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(serialized, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  } catch (err) {
    // The tmp write itself failed (disk full, dir missing): nothing was
    // linked, nothing to clean up beyond the temp file itself.
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  // Only unlink the lockfile when it is still ours: it parses with our
  // token, or (legacy lockfiles from older brigade versions have no token)
  // it carries this same pid. A peer that stole + re-created the lock owns
  // the file now and must keep it. This check-then-unlink has a residual
  // microsecond window by nature of POSIX (no atomic compare-and-delete);
  // the steal side's token guard keeps that window benign in practice.
  let ours = false;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const payload = JSON.parse(raw) as LockfileContents;
    ours = payload?.token === token || (payload?.token === undefined && payload?.pid === process.pid);
  } catch {
    // Unreadable or already gone — either way there is nothing of ours to
    // release.
    ours = false;
  }
  if (!ours) {
    log.debug("release skipped — lock no longer ours", { lockPath });
    return;
  }
  try {
    await fs.unlink(lockPath);
    log.debug("session lock released", { lockPath });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      // Vanished between the ownership check and the unlink — a peer stole
      // it; our ownership ended with the steal.
      log.debug("release skipped — lock no longer ours", { lockPath });
      return;
    }
    log.warn("failed to release session lock", { lockPath, error: (err as Error).message });
  }
}

async function maybeStealStaleLock(lockPath: string, ourToken: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    // Disappeared between EEXIST and stat — race a retry.
    return true;
  }

  let payload: LockfileContents | null = null;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    payload = JSON.parse(raw) as LockfileContents;
  } catch {
    payload = null;
  }

  // An empty/unparseable payload can mean a peer acquire in this same process
  // is mid-creation (the file landed, the payload write hasn't). Never decide
  // on a payload we wrote ourselves — fall through to the ordinary wait.
  if (payload?.token === ourToken) return false;

  const holderAlive = payload && payload.pid > 0 && isProcessAlive(payload.pid);
  const tooOld = Date.now() - stat.mtimeMs > STALE_LOCK_MS;

  // Unparseable + young = possibly a peer acquire mid-creation (fallback
  // filesystems, or a crash between create and write on legacy versions).
  // Wait out the grace before treating it as dead-holder leftovers.
  if (payload === null && !tooOld && Date.now() - stat.mtimeMs < UNPARSEABLE_GRACE_MS) {
    return false;
  }

  if (!holderAlive || tooOld) {
    try {
      await fs.unlink(lockPath);
      log.warn("stole stale session lock", {
        lockPath,
        holderPid: payload?.pid,
        holderAlive,
        tooOld,
      });
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return true;
      log.warn("failed to steal stale lock", { lockPath, error: (err as Error).message });
    }
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 doesn't deliver a signal — it just reports whether the
    // process exists / we can address it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EPERM") return true; // exists, just not ours to signal
    return false;
  }
}

async function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("Aborted"));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
