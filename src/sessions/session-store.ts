import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  ensureDir,
  resolveSessionStorePath,
  resolveSessionTranscriptPath,
  resolveSessionsDir,
} from "../config/paths.js";

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
export function resolveOrCreateSession(args: {
  agentId: string;
  sessionKey: string;
  overrides?: Partial<SessionEntry>;
}): ResolvedSession {
  const { agentId, sessionKey } = args;
  const store = readSessionStore(agentId);
  const now = new Date().toISOString();
  let entry = store.sessions[sessionKey];
  let isNew = false;

  if (!entry) {
    entry = {
      sessionId: randomUUID(),
      createdAt: now,
      lastUsedAt: now,
      ...(args.overrides ?? {}),
    };
    store.sessions[sessionKey] = entry;
    isNew = true;
  } else {
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
  ensureDir(resolveSessionsDir(agentId));

  return {
    sessionKey,
    sessionId: entry.sessionId,
    transcriptPath: resolveSessionTranscriptPath(agentId, entry.sessionId),
    isNew,
    entry,
  };
}

export function defaultSessionKey(agentId: string): string {
  return `agent:${agentId}:main`;
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
  const store = readSessionStore(agentId);
  if (!(sessionKey in store.sessions)) return false;
  delete store.sessions[sessionKey];
  writeSessionStore(agentId, store);
  return true;
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
