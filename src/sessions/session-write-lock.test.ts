import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireSessionWriteLock } from "./session-write-lock.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-lock-test-"));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function tmp(name: string): string {
  return path.join(tmpRoot, name);
}

test("acquireSessionWriteLock: acquires + releases cleanly", async () => {
  const sessionFile = tmp("a.jsonl");
  const lock = await acquireSessionWriteLock({ sessionFile });
  // Lockfile should exist while held.
  await assert.doesNotReject(fs.stat(`${sessionFile}.lock`));
  await lock.release();
  // Released — file removed.
  await assert.rejects(fs.stat(`${sessionFile}.lock`));
});

test("acquireSessionWriteLock: contention surfaces as timeout", async () => {
  const sessionFile = tmp("b.jsonl");
  const first = await acquireSessionWriteLock({ sessionFile });
  // Second acquisition with a tight timeout should give up rather than block.
  await assert.rejects(
    () => acquireSessionWriteLock({ sessionFile, timeoutMs: 200 }),
    /Timed out waiting for session write lock/,
  );
  await first.release();
});

test("acquireSessionWriteLock: aborted signal short-circuits the wait", async () => {
  const sessionFile = tmp("c.jsonl");
  const holder = await acquireSessionWriteLock({ sessionFile });

  const ac = new AbortController();
  const acquirePromise = acquireSessionWriteLock({
    sessionFile,
    signal: ac.signal,
    timeoutMs: 60_000,
  });
  // Fire the abort after a tick — we want the wait loop to be running when
  // the signal trips.
  setTimeout(() => ac.abort(new Error("user cancelled")), 50);
  await assert.rejects(acquirePromise);
  await holder.release();
});

test("acquireSessionWriteLock: steals a lock whose holder PID is dead", async () => {
  const sessionFile = tmp("d.jsonl");
  const lockPath = `${sessionFile}.lock`;
  // Plant a lock file whose pid is implausible (PIDs in the millions are
  // unlikely to be alive on a test box, and process.kill(pid, 0) will
  // throw ESRCH).
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() }),
    "utf8",
  );
  const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 5_000 });
  // We should now hold the lock.
  const contents = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(contents) as { pid: number; token?: string };
  assert.equal(parsed.pid, process.pid);
  assert.ok(typeof parsed.token === "string" && parsed.token.length > 0, "lockfile payload must carry a token");
  await lock.release();
});

test("acquireSessionWriteLock: lockfile payload is readable the moment the lock exists", async () => {
  const sessionFile = tmp("e.jsonl");
  const lock = await acquireSessionWriteLock({ sessionFile });
  // The atomic create path must leave a fully-formed payload on disk —
  // a competing acquirer must never see an ownerless lockfile.
  const raw = await fs.readFile(`${sessionFile}.lock`, "utf8");
  const parsed = JSON.parse(raw) as { pid: number; acquiredAt: number; token?: string };
  assert.equal(parsed.pid, process.pid);
  assert.ok(typeof parsed.acquiredAt === "number");
  assert.ok(typeof parsed.token === "string" && parsed.token.length > 0);
  await lock.release();
});

test("acquireSessionWriteLock: release never unlinks a lock stolen and re-created by a peer", async () => {
  const sessionFile = tmp("f.jsonl");
  const lockPath = `${sessionFile}.lock`;
  const lock = await acquireSessionWriteLock({ sessionFile });

  // Simulate the steal + re-create: a peer replaces the lockfile with its
  // own payload while we still hold the (now stale) handle object.
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999_998, acquiredAt: Date.now(), token: "peer-token" }),
    "utf8",
  );
  await lock.release();

  // The peer's lock must still be on disk — releasing must not have
  // unlinked someone else's lock.
  const after = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: string };
  assert.equal(after.token, "peer-token", "release must not delete a peer's lock");
});

test("acquireSessionWriteLock: fresh unparseable lockfile is treated as a peer mid-creation", async () => {
  const sessionFile = tmp("g.jsonl");
  const lockPath = `${sessionFile}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  // Fresh + unparseable: exactly what a fallback-filesystem creation window
  // looks like. Must NOT be stolen within the grace window.
  await fs.writeFile(lockPath, "", "utf8");
  await assert.rejects(
    () => acquireSessionWriteLock({ sessionFile, timeoutMs: 300 }),
    /Timed out waiting for session write lock/,
  );
  // Still on disk — nothing stole it (directory listing, not a stat of the
  // same path we touch below, avoiding a check-then-act pattern).
  assert.ok((await fs.readdir(path.dirname(lockPath))).includes(path.basename(lockPath)), "a fresh unparseable lock must survive the grace window");

  // Old + unparseable = corrupt leftovers → stealable as before. The lock
  // was created inside the grace window seconds ago; backdate it past
  // STALE_LOCK_MS so the steal triggers on age.
  const lockFile = path.join(path.dirname(lockPath), path.basename(lockPath));
  const ancient = new Date(Date.now() - 11 * 60_000);
  const handle = await fs.open(lockFile, "r+");
  try {
    await handle.utimes(ancient, ancient);
  } finally {
    await handle.close();
  }
  const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 5_000 });
  const stolen = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
  assert.equal(stolen.pid, process.pid, "an ancient unparseable lock must still be stealable");
  await lock.release();
});
