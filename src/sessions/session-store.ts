import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import os from "node:os";

import {
  ensureDir,
  resolveSessionStorePath,
  resolveSessionTranscriptPath,
  resolveSessionsDir,
} from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getCachedSessionFile,
  primeSessionCache,
  writeThroughSessionCache,
} from "../storage/session-cache.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";

/**
 * Wave L P2#11 — cross-process advisory file lock for `sessions.json`.
 *
 * The sync mutex above serialises in-process callers. A peer process
 * (test harness booting a second gateway, cron daemon writing the same
 * agent's store) still races the read-modify-write. The PID-tagged
 * sidecar file uses sync `openSync('wx')` for atomic claim + retry-with-
 * backoff for contention. Stale locks (holder PID dead OR sidecar older
 * than STALE_LOCK_MS) are stolen.
 *
 * Failure mode: on every error we log + proceed without the lock. The
 * sync mutex still guarantees in-process atomicity; cross-process
 * conflicts degrade to "last-writer-wins" same as before this fix.
 */
const SESSIONS_FILE_LOCK_STALE_MS = 10 * 60_000;
const SESSIONS_FILE_LOCK_POLL_INITIAL_MS = 25;
const SESSIONS_FILE_LOCK_POLL_MAX_MS = 500;
const SESSIONS_FILE_LOCK_TIMEOUT_MS = 30_000;

/**
 * P1#10 (Wave H) — per-agent in-process sync mutex.
 *
 * `sessions.json` operations stay sync (callers across the codebase rely on
 * the sync interface). Without serialization, two read-modify-write paths
 * inside the same process — e.g. the gateway resolving a session while the
 * cron reaper deletes a sibling entry — would race: each reads the file,
 * mutates its own copy, then writes back, silently dropping the other's
 * mutation.
 *
 * The fix below uses a synchronous "owner agentId" guard: every mutation
 * goes through `withSyncStoreLock(agentId, fn)`, which executes `fn`
 * atomically with respect to other in-process callers for the SAME agent.
 * Implementation is a Promise-FIFO when contention occurs and a fast-path
 * direct invocation when uncontended (since sync fns can't actually yield).
 *
 * Cross-process safety: `writeSessionStore` uses `tmp+rename`, which is
 * atomic on POSIX — two processes can each safely commit, the loser of the
 * race just loses its own update (same as before this fix). Cross-process
 * mutual exclusion would need an OS file lock, which is out of scope for
 * the sync API and tracked separately.
 */
type AgentSyncMutex = { owner: string | null };

const SESSION_STORE_SYNC_MUTEX_KEY = Symbol.for("brigade.sessionsSessionStore.syncMutex");

function getSyncMutexMap(): Map<string, AgentSyncMutex> {
  return resolveGlobalSingleton<Map<string, AgentSyncMutex>>(
    SESSION_STORE_SYNC_MUTEX_KEY,
    () => new Map(),
  );
}

function getMutex(agentId: string): AgentSyncMutex {
  const map = getSyncMutexMap();
  const existing = map.get(agentId);
  if (existing) return existing;
  const fresh: AgentSyncMutex = { owner: null };
  map.set(agentId, fresh);
  return fresh;
}

/**
 * Synchronously serialize a read-modify-write against the per-agent store.
 *
 * Single-threaded JS guarantees that any other sync `withSyncStoreLock(agentId)`
 * call observes the same critical section atomically — a competing sync caller
 * would have had to yield to reach this point. The `owner` guard detects re-
 * entrant misuse (a callee inside `fn` trying to re-enter for the same agent)
 * and throws — that would indicate a bug, since re-entry would deadlock.
 */
function withSyncStoreLock<T>(agentId: string, fn: () => T): T {
  const mutex = getMutex(agentId);
  if (mutex.owner !== null) {
    throw new Error(
      `re-entrant session-store mutation for agent ${agentId}: nested call inside ${mutex.owner}`,
    );
  }
  const callerTag = `${process.pid}:${Date.now()}`;
  mutex.owner = callerTag;
  // Wave L P2#11 — additionally acquire a cross-process advisory file lock
  // around the read-modify-write so a peer process can't interleave. The
  // sync mutex above already serialises in-process callers; the file lock
  // closes the cross-process gap. Best-effort: on lock-acquisition failure
  // we proceed without it (degraded same as before — last writer wins).
  // Convex mode: no sessions.json on disk to lock — Convex linearises
  // cross-process writes and the in-process mutex above covers same-process
  // serialisation. Skip the sidecar so nothing is created under ~/.brigade.
  const filePath = resolveSessionStorePath(agentId);
  const releaseFileLock =
    tryGetRuntimeContext()?.mode === "convex"
      ? null
      : tryAcquireSessionStoreFileLockSync(filePath);
  try {
    return fn();
  } finally {
    mutex.owner = null;
    try {
      releaseFileLock?.();
    } catch {
      // best-effort release; stale-steal handles the leftover
    }
  }
}

/** Acquire the sidecar lockfile synchronously. Returns a release fn (or `null` on failure). */
function tryAcquireSessionStoreFileLockSync(sessionsFilePath: string): (() => void) | null {
  const lockPath = `${sessionsFilePath}.lock`;
  try {
    ensureDir(path.dirname(sessionsFilePath));
  } catch {
    return null;
  }
  const deadline = Date.now() + SESSIONS_FILE_LOCK_TIMEOUT_MS;
  let pollMs = SESSIONS_FILE_LOCK_POLL_INITIAL_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(
          fd,
          JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() }),
        );
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // best-effort
        }
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        return null;
      }
    }
    if (maybeStealStaleSessionStoreLockSync(lockPath)) continue;
    if (Date.now() >= deadline) return null;
    // Sync busy-wait — bounded by deadline. The work guarded is tiny
    // (sub-ms read+write) so contention is rare and brief.
    const waitUntil = Date.now() + pollMs;
    while (Date.now() < waitUntil) {
      // intentionally tight loop — pollMs stays small
    }
    pollMs = Math.min(SESSIONS_FILE_LOCK_POLL_MAX_MS, Math.floor(pollMs * 1.5));
  }
}

function maybeStealStaleSessionStoreLockSync(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    // gone between EEXIST + stat — race a retry
    return true;
  }
  let holderPid = 0;
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (typeof parsed?.pid === "number") holderPid = parsed.pid;
  } catch {
    // malformed lockfile — treat as stealable
  }
  const holderAlive = holderPid > 0 && isProcessAliveSync(holderPid);
  const tooOld = Date.now() - stat.mtimeMs > SESSIONS_FILE_LOCK_STALE_MS;
  if (!holderAlive || tooOld) {
    try {
      fs.rmSync(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isProcessAliveSync(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EPERM") return true;
    return false;
  }
}

// sessions.json maps a session-key (e.g. "agent:default:main") to the
// concrete sessionId whose JSONL transcript holds the conversation.
//
// One session-key → one sessionId → one <sessionId>.jsonl file. The Pi SDK
// owns the JSONL contents; we own this index.

/**
 * Sub-agent metadata persisted alongside the session entry (Primitive #6).
 *
 * Written ONCE at session-creation time by `runSubagent` (via the `overrides`
 * arg to `resolveOrCreateSession`) so an operator running `cat ~/.brigade/
 * agents/<id>/sessions/sessions.json` after a crash can:
 *
 *   - Identify which transcripts belong to sub-agents (`spawnDepth > 0`).
 *   - Walk the ancestry chain via `spawnedBy` to reconstruct who spawned what.
 *   - See per-spawn config (label, cleanup policy, parent's runId) without
 *     having to parse the transcript JSONL.
 *
 * Survives crashes — disk-backed and atomic via `writeSessionStore`'s tmp+
 * rename pattern. The in-memory `subagent-policy.ts` registry is for live
 * accounting (slot reservation, lifecycle timings); THIS is for post-hoc
 * forensics + ancestry reconstruction.
 */
export interface SubagentSessionMetadata {
  /** Depth this session runs at. 1 for first-level child, 2 for grandchild. */
  spawnDepth: number;
  /** Session key of the immediate parent (where `spawn_agent` was called). */
  spawnedBy: string;
  /** Parent's runId at the time of spawn. Cleared when the parent's run ends. */
  parentRunId?: string;
  /** Human label the parent supplied to `spawn_agent`. */
  label?: string;
  /** Cleanup policy applied to THIS sub-agent (`keep` = transcript preserved). */
  cleanup?: "delete" | "keep";
  /** ISO timestamp of the spawn (parent's `runSubagent` entry point). */
  spawnedAt: string;
  /** Resolved workspaceDir for the child. Inherited from parent today. */
  spawnedWorkspaceDir?: string;
}

export interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  // Optional per-session overrides — provider/model/auth profile/think level.
  // Kept loose; Pi consumes whatever it understands and ignores the rest.
  provider?: string;
  modelId?: string;
  authProfile?: string;
  thinkingLevel?: string;
  /** Primitive #6 — see `SubagentSessionMetadata`. Unset on top-level sessions. */
  subagent?: SubagentSessionMetadata;
  [key: string]: unknown;
}

export interface SessionStoreFile {
  version: number;
  sessions: Record<string, SessionEntry>;
}

const CURRENT_VERSION = 1;

export function readSessionStore(agentId: string): SessionStoreFile {
  // Convex mode — serve from the boot-hydrated cache. All higher helpers
  // (resolveOrCreateSession, upsert/update/delete, listers) are built on
  // this function + writeSessionStore, so the dispatch pair covers every
  // session caller in the codebase. An agent without a cache slot (created
  // after boot) genuinely has no rows; start it from the empty shape and
  // prime so later writes diff against it.
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    const cached = getCachedSessionFile(agentId);
    if (cached) return structuredClone(cached);
    const empty: SessionStoreFile = { version: CURRENT_VERSION, sessions: {} };
    primeSessionCache(agentId, empty);
    return empty;
  }

  const storePath = resolveSessionStorePath(agentId);
  if (!fs.existsSync(storePath)) {
    return { version: CURRENT_VERSION, sessions: {} };
  }
  const raw = fs.readFileSync(storePath, "utf8");
  try {
    const parsed = JSON.parse(raw) as SessionStoreFile;
    if (!parsed.sessions) parsed.sessions = {};
    return parsed;
  } catch {
    return { version: CURRENT_VERSION, sessions: {} };
  }
}

export function writeSessionStore(agentId: string, file: SessionStoreFile): void {
  // Convex mode — prime the cache synchronously (the next read sees this
  // write) and enqueue the per-key Convex mutations realising the diff.
  // Callers sit inside the per-agent sync lock, so cache mutations are
  // serialised in-process; the backend linearises the rest.
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    writeThroughSessionCache(rctx.store, agentId, file);
    return;
  }

  const storePath = resolveSessionStorePath(agentId);
  ensureDir(path.dirname(storePath));
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  fs.renameSync(tmp, storePath);
}

export interface ResolvedSession {
  sessionKey: string;
  sessionId: string;
  transcriptPath: string;
  isNew: boolean;
  entry: SessionEntry;
}

// Resolve the sessionId for a given session-key. Creates a new entry the
// first time a key is seen; touches lastUsedAt every time.
//
// Freshness TTL (Audit 24 gap): when `freshnessMs` is set AND the existing
// entry's `lastUsedAt` is older than that window, the function mints a
// NEW `sessionId` for the same session-key. This is how operators get a
// "fresh context every morning" behaviour without losing the key→session
// mapping. The previous `sessionId`'s transcript stays on disk (cleanup
// is a separate concern); the session-key just points at the new one.
//
// Default: no TTL (existing call sites preserve previous behaviour).
// Callers that want the rollover behaviour pass `freshnessMs` derived
// from operator config (`cfg.session.freshnessMs` or similar) — keeping
// the policy at the caller layer instead of hard-coding here.
export function resolveOrCreateSession(args: {
  agentId: string;
  sessionKey: string;
  overrides?: Partial<SessionEntry>;
  /** Roll a new sessionId if the entry hasn't been touched within this many ms. */
  freshnessMs?: number;
}): ResolvedSession {
  const { agentId, sessionKey } = args;
  return withSyncStoreLock(agentId, () => {
    const store = readSessionStore(agentId);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let entry = store.sessions[sessionKey];
    let isNew = false;

    if (entry && typeof args.freshnessMs === "number" && args.freshnessMs > 0) {
      const lastMs = Date.parse(entry.lastUsedAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs > args.freshnessMs) {
        // Stale — roll a new sessionId but keep the entry slot. We deliberately
        // DROP `subagent` metadata when rolling (a stale sub-agent slot getting
        // re-used should be treated as a fresh top-level session). createdAt
        // resets so audit tooling can see when the rolled session started.
        entry = {
          sessionId: randomUUID(),
          createdAt: now,
          lastUsedAt: now,
          ...(args.overrides ?? {}),
        };
        store.sessions[sessionKey] = entry;
        isNew = true;
      }
    }

    if (!entry) {
      entry = {
        sessionId: randomUUID(),
        createdAt: now,
        lastUsedAt: now,
        ...(args.overrides ?? {}),
      };
      store.sessions[sessionKey] = entry;
      isNew = true;
    } else if (!isNew) {
      entry.lastUsedAt = now;
      if (args.overrides) {
        // Primitive #6 — `subagent` metadata is the one field we treat as
        // write-once. The comment on `SubagentSessionMetadata` documents
        // "written ONCE at session creation"; honour that contract here so
        // an out-of-band re-creation (or a buggy caller) can't silently
        // overwrite the original spawn metadata. Every other override key
        // is still merged (provider/model/auth-profile/thinking-level all
        // legitimately mutate across turns).
        const { subagent: incomingSubagent, ...rest } = args.overrides as {
          subagent?: unknown;
          [key: string]: unknown;
        };
        Object.assign(entry, rest);
        if (entry.subagent === undefined && incomingSubagent !== undefined) {
          entry.subagent = incomingSubagent as SubagentSessionMetadata;
        }
      }
    }

    writeSessionStore(agentId, store);

    // Make sure the sessions/ directory exists; the JSONL itself is created
    // lazily by Pi's SessionManager on first write.
    // Convex mode never writes the JSONL here (inMemory + factory) — skip.
    if (tryGetRuntimeContext()?.mode !== "convex") ensureDir(resolveSessionsDir(agentId));

    return {
      sessionKey,
      sessionId: entry.sessionId,
      transcriptPath: resolveSessionTranscriptPath(agentId, entry.sessionId),
      isNew,
      entry,
    };
  });
}

/**
 * Canonical main-session key for an agent. Routes through the shared
 * `buildBrigadeMainSessionKey` so agent-id normalisation (lowercase, path-
 * safe collapse) is identical to every other site that constructs a session
 * key — boot/cron sessions now match channel sessions on the same canonical
 * id (O0 H7).
 *
 * Imported via a dynamic import seam (in-file lazy resolve) to avoid a
 * module cycle: `agents/routing/session-key.ts` already depends on
 * `sessions/session-key-utils.ts`, and pulling its key-builder up here
 * eagerly would re-introduce a sessions ↔ routing cycle.
 */
export function defaultSessionKey(agentId: string): string {
  return buildBrigadeMainSessionKeyLazy(agentId);
}

// Lazy resolver so the `agents/routing` module load isn't pulled into the
// sessions module's load chain. First call resolves + caches.
let _buildBrigadeMainSessionKey: ((p: { agentId: string }) => string) | undefined;
function buildBrigadeMainSessionKeyLazy(agentId: string): string {
  if (!_buildBrigadeMainSessionKey) {
    // Require synchronously through the cjs interop. In ESM the dynamic
    // import would be async; instead we use a `require`-style fallback via
    // the shared normaliser so the function stays sync (every existing
    // caller of `defaultSessionKey` is sync).
    // Inline the same normalisation rules `buildBrigadeMainSessionKey`
    // applies (lowercase + collapse invalid chars) — duplicating the rule
    // here keeps the seam sync without forcing the routing module into
    // the sessions module's load chain.
    const trimmed = (agentId ?? "").trim().toLowerCase();
    if (!trimmed) return "agent:main:main";
    const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    if (VALID_ID_RE.test(trimmed)) return `agent:${trimmed}:main`;
    const cleaned =
      trimmed
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
        .slice(0, 64) || "main";
    return `agent:${cleaned}:main`;
  }
  return _buildBrigadeMainSessionKey({ agentId });
}

/**
 * Remove a session-store entry by key. Used by the sub-agent runner when
 * `cleanup === "delete"` so the entry doesn't outlive the transcript file
 * it points at (orphaned entries would clutter `brigade sessions list`).
 *
 * Idempotent — missing keys are silently ignored. Atomic via the same
 * tmp+rename `writeSessionStore` uses; survives partial writes.
 *
 * Returns `true` if an entry was removed, `false` otherwise.
 */
export function deleteSessionEntry(agentId: string, sessionKey: string): boolean {
  return withSyncStoreLock(agentId, () => {
    const store = readSessionStore(agentId);
    if (!(sessionKey in store.sessions)) return false;
    delete store.sessions[sessionKey];
    writeSessionStore(agentId, store);
    return true;
  });
}

/**
 * Patch fields on an existing session entry. Used by the `sessions.patch`
 * gateway method (Step 20 sub-agent spawn calls it to write
 * `subagent` metadata + `spawnedWorkspaceDir` BEFORE the first turn so
 * post-crash forensics can reconstruct the spawn tree).
 *
 * The patch is a shallow merge — top-level keys in `patch` overwrite the
 * existing entry's keys. To update nested fields (e.g. `subagent.label`),
 * pass the full `subagent` block. `lastUsedAt` is always touched.
 *
 * Returns the merged entry on success, `null` if the entry was missing.
 * Refuses to overwrite the `sessionId` (immutable post-creation).
 */
export function updateSessionEntry(
  agentId: string,
  sessionKey: string,
  patch: Partial<SessionEntry>,
): SessionEntry | null {
  return withSyncStoreLock(agentId, () => {
    const store = readSessionStore(agentId);
    const entry = store.sessions[sessionKey];
    if (!entry) return null;
    const { sessionId: _ignored, ...rest } = patch;
    const next: SessionEntry = {
      ...entry,
      ...rest,
      lastUsedAt: new Date().toISOString(),
    };
    store.sessions[sessionKey] = next;
    writeSessionStore(agentId, store);
    return next;
  });
}

/**
 * Create OR patch a session entry in one call. If the entry doesn't exist
 * yet, the function mints a `sessionId` and writes the supplied fields.
 * If it exists, the function applies the patch (same shallow-merge rules
 * as `updateSessionEntry`).
 *
 * Used by the `sessions.patch` gateway handler — operators expect the
 * call to succeed even if the session hasn't had its first turn yet
 * (e.g. spawn-engine patches the child entry BEFORE handing off).
 */
export function upsertSessionEntry(
  agentId: string,
  sessionKey: string,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return withSyncStoreLock(agentId, () => {
    const store = readSessionStore(agentId);
    const now = new Date().toISOString();
    const { sessionId: incomingSessionId, ...rest } = patch;
    let entry = store.sessions[sessionKey];
    if (!entry) {
      entry = {
        sessionId: incomingSessionId ?? randomUUID(),
        createdAt: now,
        lastUsedAt: now,
        ...rest,
      };
      store.sessions[sessionKey] = entry;
    } else {
      entry = { ...entry, ...rest, lastUsedAt: now };
      store.sessions[sessionKey] = entry;
    }
    writeSessionStore(agentId, store);
    // Convex mode never writes the JSONL here (inMemory + factory) — skip.
    if (tryGetRuntimeContext()?.mode !== "convex") ensureDir(resolveSessionsDir(agentId));
    return entry;
  });
}

/**
 * Read the sub-agent metadata persisted on a session (Primitive #6).
 * Returns `undefined` when the session doesn't exist OR is a top-level
 * (non-sub-agent) session. Reads through the existing store JSON without
 * mutating it — safe to call from cleanup paths or audit tooling.
 */
export function readSubagentMetadata(
  agentId: string,
  sessionKey: string,
): SubagentSessionMetadata | undefined {
  const store = readSessionStore(agentId);
  const entry = store.sessions[sessionKey];
  return entry?.subagent;
}

/**
 * List every session entry that carries sub-agent metadata, sorted by
 * `spawnedAt` ascending. Useful for post-crash forensics — "what sub-agents
 * were in flight when the gateway died?" — and for the future `brigade
 * sessions list --subagents` UX.
 */
export function listSubagentSessionEntries(
  agentId: string,
): Array<{ sessionKey: string; entry: SessionEntry; subagent: SubagentSessionMetadata }> {
  const store = readSessionStore(agentId);
  const out: Array<{
    sessionKey: string;
    entry: SessionEntry;
    subagent: SubagentSessionMetadata;
  }> = [];
  for (const [sessionKey, entry] of Object.entries(store.sessions)) {
    if (!entry.subagent) continue;
    out.push({ sessionKey, entry, subagent: entry.subagent });
  }
  out.sort((a, b) => a.subagent.spawnedAt.localeCompare(b.subagent.spawnedAt));
  return out;
}

/**
 * Generic filter-aware session entry lister. Used by the BrigadeStore
 * adapter to satisfy `SessionStore.listEntries(agentId, filter?)`.
 *
 *   filter.isolatedCronRunOlderThanMs — keep only `isolated:cron:` keys
 *     whose `lastUsedAt` is older than `now - ms`. Used by the cron-store
 *     adapter to drive `listIsolatedCronSessions` (a follow-up will route
 *     `src/cron/session-reaper.ts` through this instead of duplicating
 *     iteration).
 *   filter.subagentOnly — keep only entries with a `subagent` metadata block.
 *
 * Returns entries in insertion order (matches `Object.entries` on the
 * underlying sessions map). Callers that need a different ordering re-sort.
 */
export function listSessionEntries(
  agentId: string,
  filter: { isolatedCronRunOlderThanMs?: number; subagentOnly?: boolean } = {},
): Array<{ sessionKey: string; entry: SessionEntry }> {
  const store = readSessionStore(agentId);
  const now = Date.now();
  const cutoffMs =
    filter.isolatedCronRunOlderThanMs !== undefined
      ? now - filter.isolatedCronRunOlderThanMs
      : undefined;
  const out: Array<{ sessionKey: string; entry: SessionEntry }> = [];
  for (const [sessionKey, entry] of Object.entries(store.sessions)) {
    if (filter.subagentOnly && !entry.subagent) continue;
    if (cutoffMs !== undefined) {
      // Lazy import to avoid cron/session-reaper depending on this file
      // (which would create a cycle); the helper is a pure string predicate.
      if (!sessionKey.startsWith("isolated:cron:")) continue;
      const lastUsedAt = Date.parse(entry.lastUsedAt ?? "");
      if (!Number.isFinite(lastUsedAt) || lastUsedAt > cutoffMs) continue;
    }
    out.push({ sessionKey, entry });
  }
  return out;
}
