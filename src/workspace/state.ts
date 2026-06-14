import fs from "node:fs/promises";
import path from "node:path";

import { workspaceIdFromDir } from "../storage/facts-cache.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import { enqueueWorkspaceMirrorOp } from "../storage/workspace-live-mirror.js";

import { fileExists } from "./fs-utils.js";

// Lifecycle markers for the agent's workspace.
//
// On a fresh onboard, brigade writes BOOTSTRAP.md as a one-shot greeting
// hook. Without a marker file we'd have no way to tell whether the user is
// running brigade for the first time (BOOTSTRAP.md should drive the
// introduction) or the hundredth (BOOTSTRAP.md is leftover from onboard
// and shouldn't keep rerunning the greeting).
//
// `<workspaceDir>/.brigade/workspace-state.json` carries two ISO-8601
// timestamps that trace the bootstrap arc:
//
//   bootstrapSeededAt  — set when BOOTSTRAP.md was written (or on the
//                        first onboard pass that *found* BOOTSTRAP.md
//                        already present).
//   setupCompletedAt   — set when the agent has consumed BOOTSTRAP.md
//                        (file no longer exists) AND we previously saw
//                        bootstrapSeededAt. Once set, further runs treat
//                        the workspace as fully configured.

const STATE_DIR = ".brigade";
const STATE_FILE = "workspace-state.json";
const STATE_VERSION = 1;
const BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

export interface WorkspaceState {
  version: number;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
}

export type BootstrapPhase =
  | "unseeded"          // Fresh workspace, no marker, no BOOTSTRAP.md.
  | "first-turn"        // BOOTSTRAP.md is present and the user has not
                        // yet driven a turn that consumed it. The agent
                        // should follow BOOTSTRAP.md guidance verbatim.
  | "in-progress"       // Marker says we've started but BOOTSTRAP.md is
                        // still around — user has talked once or twice
                        // but the agent hasn't been instructed to remove
                        // BOOTSTRAP.md yet.
  | "complete";         // setupCompletedAt set. Treat workspace as
                        // long-lived, no first-run hints injected.

export function resolveWorkspaceStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, STATE_DIR, STATE_FILE);
}

export async function readWorkspaceState(workspaceDir: string): Promise<WorkspaceState> {
  const statePath = resolveWorkspaceStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (typeof parsed?.version !== "number") return { version: STATE_VERSION };
    return parsed;
  } catch {
    return { version: STATE_VERSION };
  }
}

export async function writeWorkspaceState(
  workspaceDir: string,
  state: WorkspaceState,
): Promise<void> {
  const statePath = resolveWorkspaceStatePath(workspaceDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  // PID + base36 timestamp in the tmp filename so two concurrent
  // brigade processes (e.g. an interactive turn and a heartbeat tick)
  // don't trip on each other's `.tmp` while one is mid-write. Without
  // the suffix, both would write to `state.tmp` and the second renamer
  // could rename a partial file written by the first.
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmp, statePath);
  } catch (err) {
    // Best-effort cleanup of the orphan tmp on any error before the
    // rename — leaving stale `.tmp-…` files in the workspace would be
    // visible noise on subsequent `ls` / git status.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Decide which lifecycle bucket a workspace is in. Reads the state file +
// probes BOOTSTRAP.md presence so a single call answers the assembler's
// "should I inject first-run guidance?" question.
export async function evaluateBootstrapPhase(workspaceDir: string): Promise<BootstrapPhase> {
  const state = await readWorkspaceState(workspaceDir);
  const bootstrapPath = path.join(workspaceDir, BOOTSTRAP_FILENAME);
  const bootstrapExists = await fileExists(bootstrapPath);

  if (state.setupCompletedAt) return "complete";
  if (state.bootstrapSeededAt && bootstrapExists) return "first-turn";
  if (state.bootstrapSeededAt && !bootstrapExists) return "complete";
  if (!state.bootstrapSeededAt && bootstrapExists) return "first-turn";
  return "unseeded";
}

// Stamp `bootstrapSeededAt` if it isn't already set. Idempotent — safe to
// call from bootstrap and from the agent kernel; whichever lands first
// wins.
export async function markBootstrapSeeded(workspaceDir: string): Promise<void> {
  const state = await readWorkspaceState(workspaceDir);
  if (state.bootstrapSeededAt) return;
  await writeWorkspaceState(workspaceDir, {
    ...state,
    bootstrapSeededAt: new Date().toISOString(),
  });
  mirrorLifecycleStamp(workspaceDir, "bootstrapSeeded");
}

// Stamp `setupCompletedAt` once BOOTSTRAP.md has been consumed. The agent
// kernel calls this after a turn whose reply suggests the agent followed
// the bootstrap script (typically the agent itself deletes BOOTSTRAP.md
// at the end of its first reply, per the file's own instructions).
// Idempotent.
export async function markSetupCompleted(workspaceDir: string): Promise<void> {
  const state = await readWorkspaceState(workspaceDir);
  if (state.setupCompletedAt) return;
  await writeWorkspaceState(workspaceDir, {
    ...state,
    setupCompletedAt: new Date().toISOString(),
  });
  mirrorLifecycleStamp(workspaceDir, "setupCompleted");
}

// Convex mode: the lifecycle stamps used to reach the workspaceState table
// only at the NEXT gateway boot (boot.ts mirror reconcile) — so a wipe in
// between forgot that setup had completed and resurrected the first-run
// flow. Dual-write the stamp onto the live-mirror flush chain immediately;
// the disk file stays the local source of truth (workspace stays local by
// design), Convex is the durable copy.
function mirrorLifecycleStamp(
  workspaceDir: string,
  kind: "bootstrapSeeded" | "setupCompleted",
): void {
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode !== "convex") return;
  const store = rctx.store;
  const agentId = workspaceIdFromDir(workspaceDir);
  enqueueWorkspaceMirrorOp(() =>
    kind === "bootstrapSeeded"
      ? store.workspace.markBootstrapSeeded(agentId)
      : store.workspace.markSetupCompleted(agentId),
  );
}

