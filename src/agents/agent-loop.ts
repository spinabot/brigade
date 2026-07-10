// Brigade's wrapper around the Pi SDK agent loop. Single-turn driver:
//   1. Resolve session (key → id → JSONL transcript path).
//   2. Build a Pi AuthStorage from the on-disk auth-profiles store (api_key
//      profiles only; oauth/token shapes are queued for the next layer).
//   3. Construct a ModelRegistry over auth + models.json. Pi merges in its
//      built-in catalog so an empty models.json still resolves known
//      Anthropic / OpenAI / Google / Ollama models.
//   4. Open a SessionManager at <agentDir>/sessions/<sessionId>.jsonl —
//      Pi creates the file lazily on first append.
//   5. createAgentSession with the resolved model + persona-aware
//      DefaultResourceLoader.
//   6. Assemble the persona prompt and pin it via the three-write hack
//      (state.systemPrompt + _baseSystemPrompt + _rebuildSystemPrompt) so
//      Pi's tool-list rebuild can't clobber the persona on turn 2+.
//   7. session.prompt(userMessage). Defensive settle wait with a 30s
//      budget guards against runaway compactions.
//   8. Return the last assistant message text + raw message array.
//
// Pi 0.50+ removed the `discover*` convenience helpers, so brigade builds
// AuthStorage directly via the class's `inMemory` factory and ModelRegistry
// via its `create` static (with a `new` fallback for older minors).

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

import {
  DEFAULT_AGENT_ID,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAuthProfilesPath,
  resolveModelsPath,
} from "../config/paths.js";
import {
  defaultSessionKey,
  resolveOrCreateSession,
} from "../sessions/session-store.js";
import {
  awaitTranscriptFlush,
  openSessionManagerForAgent,
} from "../sessions/session-manager-factory.js";
import { readConfigOrInit, type BrigadeConfig } from "../config/io.js";
import { discoverEligibleSkills } from "./skills/index.js";
import { BUNDLED_MODULES } from "./extensions/index.js";
import { getActiveChannelManager } from "./channels/active-manager.js";
import type { GroupToolPolicyConfig } from "./channels/access-control/index.js";
import { getOrLoadExtensionRegistry } from "./extensions/registry-cache.js";
import { assembleSystemPrompt } from "../system-prompt/assembler.js";
import {
  loadHeartbeatFile,
  loadWorkspaceContextFiles,
} from "../system-prompt/workspace-loader.js";
import { resolveSystemPromptOverride } from "../system-prompt/override.js";
import { resolveRuntimeParams } from "../system-prompt/runtime-params.js";
import { applyPersonaOverrideToSession } from "../system-prompt/pi-injection.js";
import { deriveOrgDisplayGraph } from "./org/derive-graph.js";
import { renderSubAgentAnchor } from "../system-prompt/org/sub-agent-anchor.js";
import { bootstrapWorkspace } from "../workspace/bootstrap.js";
import {
  evaluateBootstrapPhase,
  markSetupCompleted,
  type BootstrapPhase,
} from "../workspace/state.js";
import {
  hasDeliveredBootstrapToSession,
  markBootstrapDeliveredToSession,
} from "../sessions/bootstrap-marker.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { runWithRetry } from "./retry-policy.js";
import { scrubAnthropicRefusalSentinel } from "./error-classifier.js";
import { cleanProviderError } from "../core/model-caps.js";
import { adoptNewerClaudeCliLogin, healDeadSubscriptionLogin } from "../auth/auth-health.js";
import { persistentAuthBackend } from "../core/auth-bridge.js";
import { billingSafeContextWindow, resolveModelNeverMiss } from "./model-resolution.js";
import { buildAutoRecallBlock, resolveAutoRecallOrigin } from "./memory/auto-recall.js";
import { runPreCompactionExtraction } from "./memory/extract.js";
import type { MemoryRecordOrigin } from "./memory/records.js";
import { resolveActiveMemoryCapability } from "./memory/plugin-runtime.js";
import { buildBrigadeTransformContext } from "./payload-mutators.js";
import {
  drainPendingSystemEvents,
  formatPendingEventsPrefix,
} from "./pending-system-events.js";
import {
  drainFormattedSessionEvents,
  inspectPendingSessionEvents,
} from "./session-event-prompt.js";
// Per-turn session-tool access policy resolution. The flatten + org-graph-
// vs-flat-allow logic lives in `resolve-access.ts` so `sessions_send` can
// re-resolve it live (honouring a mid-run manage_access change) with the
// exact same derivation this build uses.
import { resolveSessionAccessPolicy } from "./tools/sessions/resolve-access.js";
import { wrapStreamFnWithPayloadMutations } from "./payload-mutators.js";
import { CLAUDE_CLI_PROVIDER, CLAUDE_CLI_SENTINEL_KEY } from "./claude-cli/catalog.js";
import { ensureClaudeCliApiRegistered } from "./claude-cli/register.js";
import { stampClaudeCliToolPlane } from "./claude-cli/tool-plane.js";
import { makeTransportDispatch } from "./transport-dispatch.js";
import { claudeCliHarnessBackend } from "./claude-cli/harness-backend.js";
import { NOOP_HARNESS_HANDLE, type HarnessTurnHandle } from "./harness/types.js";
import { ensureOllamaNativeApiRegistered } from "./ollama-native/register.js";
import { migrateOllamaProviderToNative } from "../integrations/ollama.js";
import { describeModelProbe, probeModelReachable } from "../integrations/provider-discovery.js";
import { repairSessionFileIfNeeded } from "../sessions/session-file-repair.js";
import { acquireSessionWriteLock } from "../sessions/session-write-lock.js";
import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";
import { runWithContentQualityRetry, type ContentQualityIssue } from "./content-quality-retry.js";
import { runWithThinkingFallback } from "./thinking-fallback.js";
import {
  assembleBrigadeToolset,
  composeBrigadeBeforeToolCall,
  type GuardContextRef,
} from "./session-wiring.js";
import { buildSessionContext } from "./session-context.js";
import { getSubagentDepthFromSessionKey } from "./subagent-policy.js";
import { getSpawnedKeysForSession } from "./subagent-registry.js";
import { emitAgentEvent } from "./agent-event-bus.js";
import { randomUUID } from "node:crypto";
import { evaluateCompactionDecision } from "./smart-compaction.js";
import { resolveToolSummary } from "./tool-summaries.js";
import {
  runWithModelFallback,
  type ModelCandidate,
  type FallbackAttempt,
} from "./model-fallback.js";
import {
  loadProfileStateLocked,
  recordProfileFailureLocked,
  recordProfileSuccessLocked,
} from "../auth/profile-cooldown.js";
import { PROVIDERS } from "../providers/catalog.js";
import { orderProfilesForSelection } from "../auth/profile-cooldown.js";
import { readProfiles } from "../auth/profiles.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import {
  wrapStreamFnWithIdleTimeout,
  wrapStreamFnWithStopReasonRecovery,
  wrapStreamFnWithToolCallRepair,
} from "./stream-wrappers.js";

const log = createSubsystemLogger("loop/turn");

// Default idle-timeout for a streaming provider response. Bypassed by setting
// `BRIGADE_LLM_IDLE_TIMEOUT_SECONDS=0`. Tuned to 90s — comfortably above the
// slowest Anthropic Opus reasoning warmup, well below the limit at which a
// hung connection wastes a session's worth of tokens of headroom.
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 90_000;

// Local Ollama cold-starts a model (VRAM/RAM load + full-context prompt-eval)
// BEFORE emitting the first token, which on modest hardware can far exceed the
// cloud-tuned 90s — the idle window races time-to-first-token. Give local models
// a much larger default so a slow first token isn't mistaken for a hung stream.
// The explicit env override still wins for both.
const DEFAULT_LOCAL_LLM_IDLE_TIMEOUT_MS = 300_000;

function resolveIdleTimeoutMs(provider?: string): number {
  const raw = process.env.BRIGADE_LLM_IDLE_TIMEOUT_SECONDS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000);
  }
  return provider === "ollama" ? DEFAULT_LOCAL_LLM_IDLE_TIMEOUT_MS : DEFAULT_LLM_IDLE_TIMEOUT_MS;
}

/**
 * Compute the effective bootstrap phase for one agent turn, given:
 *   - the workspace-level phase (whether `setupCompletedAt` is stamped),
 *   - whether THIS session has already received the bootstrap context,
 *   - whether the sender is the operator (owner).
 *
 * Truth table (the only one that matters for the user-visible behaviour):
 *
 *   workspacePhase    sessionHasBootstrap  senderIsOwner  → effective
 *   ----------------  -------------------  -------------  ----------
 *   "first-turn"       false                true          → "first-turn"   (operator's first conversation; do the BOOTSTRAP intro)
 *   "first-turn"       true                 true          → "in-progress"  (operator continuing; no re-nudge)
 *   "first-turn"       any                  false         → "in-progress"  (NON-OWNER never sees BOOTSTRAP — fixes the "friend gets identity onboarding" bug)
 *   "in-progress"      any                  any           → "in-progress"
 *   "complete"         any                  any           → "complete"
 *
 * Pure — no I/O — so the gate is unit-testable. Lifted out of the runSingleTurn
 * body specifically so the regression "approved peer triggers the operator's
 * onboarding ritual" can be locked at the helper level.
 */
export function resolveEffectiveBootstrapPhase(args: {
  workspacePhase: BootstrapPhase;
  sessionAlreadyHasBootstrap: boolean;
  senderIsOwner: boolean;
}): BootstrapPhase {
  // BOOTSTRAP is an operator-onboarding flow (see templates/workspace/BOOTSTRAP.md
  // — "You just woke up. Who am I? Who are you?"). Approved peers must NEVER
  // see the FIRST-TURN nudge — collapse to in-progress for non-owners only
  // when the workspace is still in first-turn. `in-progress` and `complete`
  // are already peer-safe so they pass through unchanged.
  if (!args.senderIsOwner && args.workspacePhase === "first-turn") {
    return "in-progress";
  }
  // Operator path (or peer on a non-first-turn workspace) — apply the existing
  // session-marker gate so the synthetic nudge fires only on the operator's
  // first session-turn, not on every continuing-session turn just because
  // BOOTSTRAP.md is still on disk.
  if (args.workspacePhase === "first-turn" && args.sessionAlreadyHasBootstrap) {
    return "in-progress";
  }
  return args.workspacePhase;
}

export interface RunSingleTurnArgs {
  agentId: string;
  provider: string;
  modelId: string;
  message: string;
  /**
   * OPTIONAL inbound IMAGE blocks to send INLINE with this turn's user message
   * (A3 — "auto-see inbound images"). Each is a Pi `ImageContent` minus the
   * literal tag: `{ data: <raw base64>, mimeType }`. The channel inbound
   * pipeline decodes inbound image attachments into these (capped) and threads
   * them here via `runGatewayTurn` → `runResilientTurn`.
   *
   * They are attached to `session.prompt(...)` as a multimodal user message
   * ONLY when the RESOLVED turn model is vision-capable
   * (`modelSupportsImageInput(model) === true`). When absent, empty, or the
   * model is text-only, the turn builds the EXACT same string-prompt as before
   * — so TUI / cron / sub-agent / RPC turns (which never set this) and
   * text-only models are byte-identical to today. The `[attached image →
   * <path>]` note stays in `message` regardless, so a text-only model still
   * sees the path and can call `analyze_media`.
   */
  images?: ReadonlyArray<{ data: string; mimeType: string }>;
  sessionKey?: string;
  // Override the agent's workspace dir — where persona/SOUL/USER files live
  // AND the cwd Pi resolves relative tool paths against. Defaults to
  // <agentDir>/workspace via paths.ts.
  workspaceDir?: string;
  // Explicit override for Pi's session cwd. Defaults to `workspaceDir` so
  // the agent has a stable home regardless of where the operator invoked
  // brigade from. The agent is NOT a project-rooted coding agent — it
  // operates in its own workspace and reaches project files via ABSOLUTE
  // paths (taught by the system prompt). The session cwd resolves to the
  // AGENT'S workspace, not process.cwd().
  cwd?: string;
  // Pi accepts "off" | "low" | "medium" | "high". Some providers (e.g. Gemini
  // 2.5 Pro) reject "off" — derive from model.reasoning when wiring tools.
  thinkingLevel?: "off" | "low" | "medium" | "high";
  // Caller-provided cancellation. Wired into the retry loop so a Ctrl-C from
  // the CLI / a WS disconnect from the gateway aborts cleanly. Pi 0.70.x's
  // session.prompt does not accept a signal, so the abort takes effect at
  // the *next* retry boundary; callers wanting hard mid-stream cancellation
  // should call session.abort() directly in the signal listener.
  signal?: AbortSignal;
  /**
   * Called once with the fully-wired Pi session AS SOON as it's constructed
   * and its guards/stream-wrappers/persona are installed — BEFORE the turn
   * runs. This is the per-turn mirror's seam: the gateway / TUI driver holds
   * the returned session for the DURATION of this turn so it can `steer()`,
   * `abort()`, or `switchModelMidTurn()` mid-stream, then drops the reference
   * when the turn settles. Each turn builds a fresh session and the
   * surface interacts with it only for that turn's lifetime — there is no
   * long-lived session between turns.
   */
  onSessionReady?: (session: AgentSession) => void;
  /**
   * Whether the message originated from the operator themselves (TUI, self-chat
   * DM, or an approved owner-equivalent peer). Defaults to `true` — the TUI is
   * always the operator, and bash callers are too. Channel-driven turns set
   * this to `false` when the sender is NOT `adapter.selfId()`.
   *
   * Used to gate the BOOTSTRAP "who am I / who are you" introduction — that
   * ritual is an OPERATOR onboarding flow (see `templates/workspace/BOOTSTRAP.md`)
   * and must NOT fire for arbitrary approved peers. When `false`, the
   * bootstrap phase is collapsed to `in-progress` so non-owners see normal
   * agent behaviour from their very first message, not a "let's figure out
   * who we are together" identity script.
   *
   * (Distinct from `wrapOwnerOnlyToolExecution`'s `ownerOnly` tool gate —
   * that one denies tool calls; this one suppresses a prompt nudge.)
   */
  senderIsOwner?: boolean;
  /**
   * Sub-agent attribution (Primitive #6). When the parent's spawn-agent tool
   * launches THIS turn as a child run, it threads the human label + parent
   * runId here so exec-gate / approval-bridge / TUI can attribute approval
   * prompts to the right sub-agent. Both fields are unset for top-level
   * (operator-driven) turns; their absence is what the approval prompt's
   * `deriveTitle()` checks to fall back to the default "Brigade wants to
   * run" attribution.
   */
  subagentLabel?: string;
  parentRunId?: string;
  /**
   * Sub-agent metadata to persist on the session-store entry (Primitive #6).
   * Written once at session creation so post-crash forensics + `brigade
   * sessions list` can identify children + walk the ancestry chain. Top-level
   * turns leave this unset.
   */
  subagentMetadata?: import("../sessions/session-store.js").SubagentSessionMetadata;
  /**
   * Cron-driven turn flags (Primitive: cron). Set by `src/cron/isolated-
   * agent/run-executor.ts` when the cron service fires a scheduled run.
   *   - `cronMode` — assembler swaps the identity opener for the cron
   *     banner + gates operator-only sections (same shape as subagentMode).
   *   - `lightContext` — drops EVERY workspace bootstrap file so the cron
   *     turn runs with the minimal possible system prompt (cheap automation).
   *   - `toolsAllow` — pre-filters the tool surface to this allowlist of
   *     names; stacks AFTER the senderIsOwner ownerOnly filter.
   */
  cronMode?: boolean;
  lightContext?: boolean;
  toolsAllow?: string[];
  /**
   * Per-group / per-sender tool policy for THIS turn (group messages only).
   * Resolved by the channel inbound pipeline via
   * `resolveChannelGroupToolsPolicy(...)` and threaded `runGatewayTurn` →
   * `runResilientTurn` → `runSingleTurn` → `assembleBrigadeToolset`, where it
   * applies as a pure NAME filter (allow ∪ alsoAllow, then deny wins) layered
   * ON TOP of the `ownerOnly` wrapping. It can only REMOVE tools for the turn,
   * never add or un-gate one. Undefined for TUI / cron / sub-agent / RPC / DM
   * turns and any group without a configured policy — they keep today's exact
   * toolset (the filter never runs when this is absent).
   */
  toolPolicy?: GroupToolPolicyConfig;
  /**
   * Channel routing for approval prompts. When set, the exec-gate sends the
   * "want to run <command>?" prompt INTO the originating channel
   * conversation (via the per-channel approval-router dispatcher) instead
   * of only the gateway WS — so a WhatsApp / Slack / Discord-initiated
   * turn that hits a gated tool asks the operator IN that chat, and the
   * next inbound from the same peer ("yes" / "always" / "no") resolves
   * the approval. TUI / cron / sub-agent turns leave this undefined and
   * fall back to the WS-only broadcast (legacy behaviour).
   */
  channelApprovalRoute?: import("./channels/approval-router.js").ChannelApprovalRoute;
}

export interface RunSingleTurnResult {
  sessionId: string;
  sessionKey: string;
  isNewSession: boolean;
  reply: string;
  messages: unknown[];
  // Filled when this turn was actually served by a fallback candidate
  // (resilient-turn path) — left undefined for the primary-only path.
  servedBy?: { provider: string; modelId: string };
  // Fallback attempts the resilient runner walked through before this
  // result, including the primary if it failed. Empty when the primary
  // succeeded on first try.
  fallbackAttempts?: Array<{ provider: string; modelId: string; reason: string; error: string }>;
}

export async function runSingleTurn(args: RunSingleTurnArgs): Promise<RunSingleTurnResult> {
  const agentId = args.agentId;
  const sessionKey = args.sessionKey ?? defaultSessionKey(agentId);
  const agentDir = resolveAgentDir(agentId);
  const workspaceDir = resolveAgentWorkspaceDir(agentId, args.workspaceDir);
  // Default Pi's cwd to the agent's workspace dir. Relative tool paths
  // now resolve into the persona directory naturally — `write({path:
  // "USER.md"})` lands at `<workspace>/USER.md` without any path-jail
  // guard. Absolute paths are passed through unchanged so the agent can
  // still reach project files when the operator gives it one.
  const cwd = args.cwd ?? workspaceDir;
  const modelsFile = resolveModelsPath(agentId);
  const authProfilesPath = resolveAuthProfilesPath(agentId);

  const resolved = resolveOrCreateSession({
    agentId,
    sessionKey,
    overrides: {
      provider: args.provider,
      modelId: args.modelId,
      // Primitive #6 — persist sub-agent metadata on the entry so post-crash
      // forensics can identify children + walk the ancestry chain. Only set
      // when this turn IS a sub-agent run (top-level turns leave it unset
      // and the open index signature on SessionEntry tolerates `undefined`).
      ...(args.subagentMetadata !== undefined ? { subagent: args.subagentMetadata } : {}),
    },
  });

  // Profile cooldown gate. The on-disk profile-state.json tracks per-profile
  // failure history, cooldown windows, and disabled-until timestamps. We
  // sweep expired windows up-front so a profile that was rate-limited an
  // hour ago is eligible again now, then pass the eligibility filter to
  // the credential-map builder so cooled profiles don't get handed to Pi.
  //
  // Locked variant: serialises the load+sweep against concurrent
  // markProfileFailure/Success writes for the SAME agent. Two `brigade
  // agent` runs hitting the same agentId from the same process can no
  // longer interleave their snapshots — each waits for the previous
  // mark to land on disk before reading.
  let cooldownState = await loadProfileStateLocked(agentId);
  // Dead-grant heal before the credential map builds: an EXPIRED anthropic
  // OAuth profile whose refresh token no longer works (rotated out by the
  // Claude Code CLI while this process was idle/down) would otherwise turn
  // into "No API key for provider: anthropic" mid-turn. Refresh-probe first
  // (an independent `brigade login` grant is refreshed in place, never
  // clobbered); only a DEAD grant adopts the machine's CLI login. No-op in the
  // common case (unexpired profile) — one cheap read, no network.
  if (args.provider === "anthropic") {
    await healDeadSubscriptionLogin(agentId).catch(() => "none");
  }
  const authBuild = buildAuthStorage(
    authProfilesPath,
    {
      cooldownState,
      provider: args.provider,
      modelId: args.modelId,
    },
    agentId,
  );
  const authStorage = authBuild.storage;
  const selectedProfileId = authBuild.selectedProfileId;
  const subscriptionProviders = authBuild.subscriptionProviders;
  // Register the native Ollama transport (api:"ollama" → /api/chat) before the
  // registry/session resolve, so any Ollama model dispatches to it via Pi's
  // api-registry (getApiProvider). Idempotent + process-global; no-op for every
  // other provider. This is what makes Ollama tool-calling first-class.
  ensureOllamaNativeApiRegistered();
  // Register the claude-cli subprocess transport (api:"claude-cli" → drives the
  // installed `claude` binary on the operator's subscription). Same idempotent,
  // process-global seam as Ollama; no-op for every other provider.
  ensureClaudeCliApiRegistered();
  // Migrate any pre-existing OpenAI-compat Ollama entry (api:"openai-completions"
  // + /v1) to the native shape so upgraders don't stay silently on the degraded
  // /v1 path. Idempotent + best-effort; a no-op read once migrated.
  await migrateOllamaProviderToNative(modelsFile).catch(() => {});
  const modelRegistry = buildModelRegistry(authStorage, modelsFile);

  // ModelRegistry.find returns undefined when the provider+modelId pair isn't
  // registered. Surface a clear error so the user knows to seed models.json
  // (or wire `brigade auth login` once that command lands).
  //
  // Pi version drift guard: if a future Pi minor renames or removes `find`,
  // throw a curated error rather than letting a raw `TypeError: undefined
  // is not a function` surface from inside Pi.
  const registryAsFinder = modelRegistry as { find?: (p: string, m: string) => unknown };
  if (typeof registryAsFinder.find !== "function") {
    throw new Error(
      "Pi ModelRegistry.find is not a function — likely a Pi SDK version drift. " +
        "Brigade was built against the 0.70.x ModelRegistry surface. " +
        "Pin `@earendil-works/pi-coding-agent` to a known-compatible version, or " +
        "update brigade's agent-loop to match the new Pi API.",
    );
  }
  let model = registryAsFinder.find(args.provider, args.modelId);
  // Never-miss resolution. On a static miss, discover or synthesize a
  // usable Model: Ollama re-queries /api/tags; cloud providers hit their
  // /models endpoint for accurate metadata and synthesize from a
  // catalogued template (inheriting api/baseUrl/auth). See
  // model-resolution.ts.
  if (!model) {
    model = await resolveModelNeverMiss({
      modelRegistry,
      provider: args.provider,
      modelId: args.modelId,
      modelsFile,
      authStorage,
    });
  }
  if (!model) {
    throw new Error(
      `Model not registered: provider=${args.provider} model=${args.modelId}.\n` +
        `  • Pi's built-in catalog covers known Anthropic/OpenAI/Google/Ollama models;\n` +
        `    if yours isn't listed, append an entry to ${modelsFile}\n` +
        `    (one object under .providers.<provider>.models[]).\n` +
        `  • For local Ollama: run \`ollama pull <model>\` first.\n` +
        `  • Verify your auth profile is configured: ` +
        `\`cat ${resolveAuthProfilesPath(args.agentId)}\``,
    );
  }

  // Cross-process lock to prevent two `brigade agent` runs from interleaving
  // appends to the same JSONL. The lock is PID-tagged with a 10-min stale
  // window, so a crashed peer doesn't block us forever; the timeout below
  // surfaces an honest error if a real peer is genuinely active.
  const sessionLock = await acquireSessionWriteLock({
    sessionFile: resolved.transcriptPath,
    signal: args.signal,
    timeoutMs: 30_000,
  });

  let result: RunSingleTurnResult;
  try {
    // Repair any malformed JSONL lines in the transcript before Pi opens it.
    // A power-loss / SIGKILL during a previous append can leave a partial
    // last line that throws on JSON.parse — without this pass the next run
    // would crash on session open with no obvious cause. The repair is
    // idempotent + atomic (writes a `.bak-<pid>-<ts>` snapshot first), so a
    // failed repair leaves the original file intact.
    const repairReport = await repairSessionFileIfNeeded({
      sessionFile: resolved.transcriptPath,
    });
    if (repairReport.repaired) {
      log.warn("session file repaired before open", {
        sessionId: resolved.sessionId,
        droppedLines: repairReport.droppedLines,
        backupPath: repairReport.backupPath,
      });
    }

    result = await runSingleTurnLocked({
      args,
      agentId,
      agentDir,
      cwd,
      workspaceDir,
      modelsFile,
      authProfilesPath,
      resolved,
      cooldownState,
      authStorage,
      modelRegistry,
      selectedProfileId,
      subscriptionProviders,
      model,
    });
  } finally {
    // Convex mode: drain the transcript write-behind queue before the lock
    // releases — the next turn's readTranscript must see this turn's rows.
    // Filesystem mode resolves immediately (Pi appended inline). Bounded so
    // a wedged backend can't hold the session lock hostage.
    try {
      await Promise.race([
        awaitTranscriptFlush(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
      ]);
    } catch {
      /* flush failures already logged by the factory */
    }
    await sessionLock.release();
  }

  return result;
}

interface RunSingleTurnLockedArgs {
  args: RunSingleTurnArgs;
  agentId: string;
  agentDir: string;
  cwd: string;
  workspaceDir: string;
  modelsFile: string;
  authProfilesPath: string;
  resolved: ReturnType<typeof resolveOrCreateSession>;
  cooldownState: import("../auth/profile-cooldown.js").ProfileStateFile;
  authStorage: unknown;
  modelRegistry: unknown;
  selectedProfileId: string | undefined;
  subscriptionProviders: Set<string>;
  model: unknown;
}

async function runSingleTurnLocked(p: RunSingleTurnLockedArgs): Promise<RunSingleTurnResult> {
  const { args, agentId, agentDir, cwd, workspaceDir, resolved, model, authStorage, modelRegistry } = p;
  let cooldownState = p.cooldownState;
  const selectedProfileId = p.selectedProfileId;
  const subscriptionProviders = p.subscriptionProviders;

  // Filesystem mode: SessionManager.open creates the JSONL on first write;
  // passing the canonical transcript path keeps Pi and brigade aligned on
  // filenames. Convex mode: an inMemory() manager pre-seeded from the
  // sessionTranscriptRecords table whose appends flush to Convex — the
  // factory owns that dispatch (src/sessions/session-manager-factory.ts).
  const sessionManager = await openSessionManagerForAgent({
    agentId,
    sessionId: resolved.sessionId,
    transcriptPath: resolved.transcriptPath,
  });

  // Anthropic models are the only family today that enforce a hard
  // cache_control breakpoint cap (Anthropic accepts ≤4). Run the sweep
  // unconditionally — it's a safe no-op for non-Anthropic providers because
  // their messages don't carry cache_control blocks. The scrubber pass
  // (refusal sentinel) always runs.
  const transformContext = buildBrigadeTransformContext(
    {
      applyAnthropicSweep:
        args.provider === "anthropic" || args.provider.startsWith("anthropic"),
      // H5 — pass the active model so the message-level provider quirks
      // (Mistral tool-id, OpenAI-Responses reasoning-pair, Anthropic
      // thinking-strip) gate on the active provider. `model` is the resolved
      // model object from `resolveModelNeverMiss` — falsy here means the
      // quirks run in strip-everything defensive mode (safe for the wrap
      // chain but more aggressive).
      ...(model ? { activeModel: model as never } : {}),
    },
    {
      onTranscriptRepaired: (info) => {
        log.warn("transcript paired-repair fired", {
          sessionId: resolved.sessionId,
          syntheticAdded: info.syntheticToolResultsAdded,
          orphansDropped: info.orphanedToolResultsDropped,
        });
      },
    },
  );

  // Primitive #5 (Skills): discover the skills eligible for this turn — a
  // cheap synchronous scan of the bundled + workspace roots, OS/binary/env
  // filtered. The rendered <available_skills> block (if any) is injected into
  // the assembled persona prompt below; the model loads a skill's body on
  // demand via the existing `read` tool. `capabilities.skills` gates the
  // `## Skills` guidance section so it only appears when a skill is available.
  // Read the config ONCE per turn and thread it to both skill discovery and
  // the persona assembler — avoids a duplicate brigade.json read and any
  // chance the two reads disagree if the file is rewritten mid-turn.
  const turnConfig = readConfigOrInit();
  const skillDiscovery = discoverEligibleSkills({ workspaceDir, config: turnConfig, agentId });

  // Extension layer: load Brigade modules (bundled now; user `~/.brigade/extensions`
  // later) into a registry. Agent-level registrations (tools/hooks/commands) are
  // replayed into THIS Pi session via an ExtensionFactory; product-level ones
  // (channels/voice/…) are consumed by the gateway. We pass our own resource
  // loader, so createAgentSession won't reload it — we MUST reload() ourselves or
  // getExtensions() stays empty. The loader runs ONLY our factory: every other
  // resource type is opted out because Brigade owns skills/prompts/themes/context
  // itself and the persona pin owns the system prompt.
  //
  // Loaded BEFORE the toolset assembly because the memory capability resolver
  // (`extensions.slots.memory` slot pin) consults the registry — a plugin-
  // registered backend has to be in `registry.memoryCapabilities` before we
  // build the memory tools so `recall_memory` / `write_memory` route through
  // it on this very turn.
  const extensionRegistry = await getOrLoadExtensionRegistry({
    modules: BUNDLED_MODULES,
    meta: { agentId, workspaceDir, cwd, config: turnConfig },
  });

  // Resolve the active memory backend — plugin if `extensions.slots.memory`
  // pins one, otherwise the built-in file-based default. Threaded into the
  // tool registry AND the auto-recall helper so memory routes through one
  // capability per turn (no per-call-site branching).
  const memoryCapability = resolveActiveMemoryCapability({
    config: turnConfig,
    registry: extensionRegistry,
    workspaceDir,
    agentId,
  });

  // Assemble Brigade's full tool surface via the SHARED helper — the SAME
  // one `buildAgent` (TUI + gateway) uses, so every surface exposes an
  // identical set (7 built-ins + memory tools). Pi's `tools` field is an
  // allowlist of NAMES; `customTools` is the slot for the Brigade-native
  // Tool objects. The unknown-tool guard's allowlist must include the
  // custom names too (else `recall_memory` is refused as unknown), which
  // `enabledToolNames` already covers.
  // Primitive #6: derive sub-agent depth from the session key. Top-level turns
  // (e.g. `agent:main:main`) yield depth 0 — spawn_agent registers. Sub-agent
  // turns (e.g. `agent:main:subagent:<uuid>`) yield depth 1 — spawn_agent is
  // automatically filtered out at the leaf so recursion is impossible.
  const callerSubagentDepth = getSubagentDepthFromSessionKey(resolved.sessionKey);

  // H2 + H3 — derive the EFFECTIVE owner flag for this turn's toolset.
  // The caller's `args.senderIsOwner` (defaults to true for TUI/CLI) is the
  // base; any UNTRUSTED pending event flips it to false so a model running
  // with a poisoned third-party context cannot reach ownerOnly tools.
  const senderIsOwnerArg = args.senderIsOwner !== false;
  const pendingEventsInspection = inspectPendingSessionEvents(resolved.sessionKey);
  const effectiveSenderIsOwner =
    senderIsOwnerArg && !pendingEventsInspection.hasUntrusted;

  // O0 — resolve the per-turn session-tool access policy from config so the
  // four sessions tools fail-closed when the caller is not allowed to read /
  // send to the target session. Defaults stay backward-compatible:
  // visibility="self" (tool only sees the caller's own session) + A2A disabled.
  // Resolve the per-turn session-tool access policy. Extracted to
  // `resolveSessionAccessPolicy` (2026-06-11) so the SAME derivation backs
  // both this build AND the `sessions_send` live re-check that honours a
  // mid-run `manage_access` change — identical flatten + org-graph-vs-flat
  // logic in one place. Behaviour is bit-for-bit the legacy block.
  const { visibility, a2aPolicy } = resolveSessionAccessPolicy(turnConfig);

  // Wave O0.5 (fix #3): populate spawnedKeys so visibility="tree" actually
  // permits the caller to reach its own sub-agents. The registry walk
  // returns the transitive set of children for `resolved.sessionKey`; an
  // empty set is the right answer when no children exist (the same-key
  // fast path handles the parent's own session).
  const spawnedKeys = getSpawnedKeysForSession(resolved.sessionKey);

  const toolset = assembleBrigadeToolset({
    workspaceDir,
    agentId,
    cwd,
    memoryCapability,
    senderIsOwner: effectiveSenderIsOwner,
    sessionToolAccess: {
      visibility,
      a2aPolicy,
      spawnedKeys,
    },
    // Resolved turn-model context so `analyze_media` knows whether the active
    // model can consume an IMAGE block (text-only model → it understands the
    // image via a provider, or returns a clear "switch to a vision model" note
    // instead of an unviewable block). `imageInput` is the AUTHORITATIVE
    // capability flag read straight off the resolved Pi `Model.input`
    // (`("text"|"image")[]`) — `analyze_media`'s `modelLikelySeesImages` honours
    // it first, so the text-only-vs-vision routing is trustworthy instead of
    // regex-guessing the model id.
    ...((args.provider !== undefined || args.modelId !== undefined)
      ? {
          modelContext: {
            ...(args.provider !== undefined ? { provider: args.provider } : {}),
            ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
            ...(modelSupportsImageInput(model) !== undefined
              ? { imageInput: modelSupportsImageInput(model) }
              : {}),
          },
        }
      : {}),
    subagentContext: {
      parentSessionKey: resolved.sessionKey,
      callerDepth: callerSubagentDepth,
      ...(args.signal ? { parentSignal: args.signal } : {}),
      // Inherit the parent's RESOLVED provider+modelId so the child uses
      // whatever the operator is actually running (Anthropic, Ollama, ...)
      // instead of the runner's hardcoded fallback. The `spawn_agent` tool's
      // `model` param can still override per-call.
      parentProvider: args.provider,
      parentModelId: args.modelId,
    },
    // Cron primitive: per-job toolsAllow filter — stacks AFTER ownerOnly.
    // Undefined for non-cron turns, an array for cron-fired turns whose
    // payload sets a tool allowlist.
    ...(args.toolsAllow !== undefined ? { toolsAllow: args.toolsAllow } : {}),
    // Per-group / per-sender tool policy — set ONLY for group-message turns
    // that resolved one. Applied as a pure NAME filter on top of ownerOnly
    // (allow ∪ alsoAllow, then deny wins). Undefined everywhere else, so the
    // toolset is byte-identical to today when absent.
    ...(args.toolPolicy !== undefined ? { toolPolicy: args.toolPolicy } : {}),
    // Channel context — set when the inbound came from a channel adapter.
    // The cron tool reads it to auto-fill `delivery.channel/to/threadId` so
    // a `cron add` mid-chat replies back to the same chat by default. The
    // model can still override by passing explicit delivery params.
    ...(args.channelApprovalRoute !== undefined
      ? { channelContext: args.channelApprovalRoute }
      : {}),
    // Per-turn session context — bind the cron tool (and sessions tools)
    // to THIS session's key so `sessionTarget: "current"` resolves to
    // `session:<resolved.sessionKey>` instead of falling back to
    // `"isolated"`. Built from the RESOLVED key (not args.sessionKey)
    // because the agent loop may have minted a default key when the
    // caller omitted one — the cron must bind to the live session, not
    // the missing-input alias.
    ...(() => {
      const ctx = buildSessionContext({
        sessionKey: resolved.sessionKey,
        agentId,
      });
      return ctx ? { sessionContext: ctx } : {};
    })(),
  });
  const brigadeCustomTools = toolset.customTools;
  const enabledToolNames = toolset.enabledToolNames;

  const promptCapabilities = {
    ...toolset.capabilities,
    // Gate on the RENDERED block, not the eligible count: a skill set that's
    // entirely model-invocation-disabled yields an empty block, and emitting
    // the "scan the skills listed below" guidance with no list beneath it is
    // misleading. promptBlock is undefined exactly when there's nothing to show.
    skills: skillDiscovery.promptBlock !== undefined,
    // Wired below — flipped to `true` once the web-tool resolver decides at
    // least one of `fetch_url` / `web_search` lands in `customTools`. The
    // ## Web section in the prompt is gated on this flag.
    web: false as boolean,
    // Primitive #6 — flip the assembler into sub-agent mode when this turn's
    // session key indicates we ARE a sub-agent (depth > 0). The assembler
    // swaps the identity opener for the SUB-AGENT banner and gates off
    // operator-only sections; the workspace loader drops BOOTSTRAP.md +
    // MEMORY.md from the persona set; the heartbeat file is skipped.
    subagentMode: callerSubagentDepth > 0,
    // Cron primitive — when the cron service fires a scheduled run, the
    // executor passes `cronMode: true`. Assembler swaps the opener for the
    // cron banner + gates operator-only sections (same shape as
    // subagentMode). `lightContext` (passed downstream into the workspace
    // loader) decides whether to also drop the persona files for the
    // cheapest possible system prompt.
    cronMode: args.cronMode === true,
  };
  // `agents.defaults.toolset` (when set in `brigade.json`) narrows the active
  // tool profile — e.g. `"minimal" | "coding" | "messaging"`. The registry
  // filters extension-registered tools whose own `toolset` doesn't match (and
  // isn't `"*"` / unset). Unset / `"full"` means "no filter" (full surface).
  // The same value must reach BOTH the Pi factory (so excluded tools aren't
  // registered) AND `toolNames()` (so the unknown-tool guard's allowlist
  // agrees with what Pi sees).
  const toolsetProfile = (turnConfig.agents?.defaults as { toolset?: string } | undefined)?.toolset;
  const brigadeResourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noSkills: true, // Brigade discovers + renders skills itself (see skills/)
    noExtensions: true, // skip FILE extension discovery (cwd/.pi/extensions); our factory still runs
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      extensionRegistry.toPiExtensionFactory({
        toolset: toolsetProfile,
        // Wave K — surface per-turn agent + session ctx so `b.tool({ create })`
        // factories can scope state to THIS turn instead of closing over boot
        // metadata.
        agentId,
        sessionKey: resolved.sessionKey,
      }),
    ],
  } as never);
  await (brigadeResourceLoader as unknown as { reload: () => Promise<void> }).reload();

  // ── Web tools (fetch_url + web_search) ────────────────────────────────────
  // Build the canonical `fetch_url` tool with the configured WebFetchProvider
  // as fallback (Firecrawl when keyed; built-in raw stays primary always).
  // Build `web_search` only when an active WebSearchProvider resolved
  // (DuckDuckGo is keyless and ships bundled, so it's always available
  // unless explicitly opted out). Both join the customTools slot + the
  // unknown-tool allowlist below.
  const webProviderCtx = {
    config: turnConfig as never,
    env: process.env,
    workspaceDir,
  };
  const activeFetchProvider = extensionRegistry.resolveActiveWebFetchProvider(
    turnConfig as never,
    process.env,
  );
  // Operator-configurable cache TTLs. `tools.web.{fetch,search}.cacheTtlMinutes`
  // — unset/garbage → defaults (15min). Number conversion is permissive
  // because TypeBox-validated config may flow through unknown shapes.
  const webConfigShape = (turnConfig as {
    tools?: {
      web?: {
        fetch?: { cacheTtlMinutes?: number };
        search?: { cacheTtlMinutes?: number };
      };
    };
  }).tools?.web;
  const fetchCacheTtlMinutes = typeof webConfigShape?.fetch?.cacheTtlMinutes === "number"
    ? webConfigShape.fetch.cacheTtlMinutes
    : undefined;
  const searchCacheTtlMinutes = typeof webConfigShape?.search?.cacheTtlMinutes === "number"
    ? webConfigShape.search.cacheTtlMinutes
    : undefined;
  const fetchUrlTool = (await import("./tools/web-fetch.js")).makeFetchUrlTool({
    provider: activeFetchProvider ?? null,
    providerCtx: activeFetchProvider ? webProviderCtx : undefined,
    cacheTtlMinutes: fetchCacheTtlMinutes,
  });
  const activeSearchProvider = extensionRegistry.resolveActiveWebSearchProvider(
    turnConfig as never,
    process.env,
  );
  const webSearchTool = activeSearchProvider
    ? (await import("./tools/web-search.js")).makeWebSearchTool({
        provider: activeSearchProvider,
        providerCtx: webProviderCtx,
        cacheTtlMinutes: searchCacheTtlMinutes,
        // Per-call provider override: the agent can pass `provider: "<id>"`
        // in a single web_search call to route through a different backend
        // without changing operator config. The lookup respects the same
        // allow/deny config the default resolver does.
        lookupProviderById: (id) =>
          extensionRegistry.lookupWebSearchProviderById(id, turnConfig as never),
        // Error-time fallback: when the active provider THROWS (429 /
        // anti-bot / network), the tool walks this chain instead of losing
        // search outright. Empty when the operator pinned a provider.
        fallbackProviders: () =>
          extensionRegistry.listWebSearchFallbackChain(turnConfig as never, process.env),
      })
    : null;
  // Diagnostic toggle — when BRIGADE_DEBUG_WEB=1 the gateway log gets one
  // line per turn telling you WHICH web-search provider got resolved, whether
  // it supports filters, and whether the tool was actually built. Hard to
  // debug a "3ms ✗ web_search" failure without this — the model could be
  // hitting any of 5 distinct early-refusal branches (unknown tool, schema
  // rejection, unsupported filter, provider key gate, DDG anti-bot). Off by
  // default so it doesn't bloat the log for everyone.
  if (process.env.BRIGADE_DEBUG_WEB === "1") {
    const dbg = {
      activeSearchProviderId: activeSearchProvider?.id ?? null,
      supportsFilters: activeSearchProvider?.supportsFilters ?? null,
      webSearchToolBuilt: webSearchTool !== null,
    };
    // eslint-disable-next-line no-console
    console.error("[brigade.web]", JSON.stringify(dbg));
  }
  // Browser tool — ALWAYS registered (matches the upstream reference's
  // behaviour). `playwright-core` is a hard dependency that ships the
  // runtime engine WITHOUT a bundled Chromium binary (~30 MB). When the
  // model actually calls the tool, the execute path probes for a system
  // Chrome/Chromium/Edge/Brave and surfaces a clear "install Chrome or
  // configure browser.executablePath" error if none is found.
  //
  // Opt-out: set `BRIGADE_DISABLE_BROWSER_TOOL=1` in the gateway env.
  const browserTool = await (async () => {
    if (process.env.BRIGADE_DISABLE_BROWSER_TOOL === "1") return null;
    try {
      const { makeBrowserTool } = await import("./tools/browser.js");
      return makeBrowserTool({});
    } catch {
      // Fatal import error (browser.ts itself broken) — silently drop the
      // tool rather than crash the whole agent loop. Should never happen
      // in a healthy build.
      return null;
    }
  })();
  const webTools = [
    fetchUrlTool,
    ...(webSearchTool ? [webSearchTool] : []),
    ...(browserTool ? [browserTool] : []),
  ];
  const webToolNames = webTools.map((t) => t.name);
  brigadeCustomTools.push(...webTools);
  // Gate the system-prompt ## Web section on whether ANY web tool actually
  // landed in customTools. `fetch_url` is always available (built-in raw
  // fetch needs no provider), so this is effectively always true today;
  // becomes meaningful if a future flag disables web tools entirely.
  if (webTools.length > 0) promptCapabilities.web = true;

  // Extension tool names join the allowlist so the unknown-tool guard + Pi's
  // `tools` activation gate accept them alongside the built-ins + memory tools.
  const allEnabledToolNames = [
    ...new Set([
      ...enabledToolNames,
      ...extensionRegistry.toolNames({ toolset: toolsetProfile }),
      ...webToolNames,
    ]),
  ];

  // ── Lane J: agent-harness slot warning ────────────────────────────────────
  // Pi-coding-agent is the ONLY harness Brigade drives today. If an operator
  // pinned `extensions.slots.agentHarness` to a registered plugin, log a
  // warning that the slot won't activate yet — we don't swap the harness here
  // (Pi's session is sacred; replacing it would lose auth wrapping and break
  // every call silently). The slot becomes load-bearing the day a harness
  // plugin actually ships; until then this warning is the safety net so the
  // operator isn't silently ignored.
  const pinnedHarness = extensionRegistry.resolveSlot(
    "agentHarness",
    turnConfig,
    extensionRegistry.agentHarnesses,
  );
  if (pinnedHarness) {
    log.warn(
      "agentHarness slot pinned but Brigade uses Pi-coding-agent as the sole harness today — slot will activate when a harness plugin ships",
      { slot: pinnedHarness.id },
    );
  }

  // ── Lane J: context-engine systemPromptAddition merge ─────────────────────
  // When an operator pins `extensions.slots.contextEngine` to a registered
  // engine, call its `assemble()` and capture any `systemPromptAddition`
  // string. That string is merged into the assembled persona's ephemeral
  // (below-cache-boundary) slot so a future engine can layer extra context
  // without busting the prompt cache. Today no engine ships, so this is a
  // no-op; on plugin error we swallow rather than failing the turn (the
  // built-in path takes over).
  let contextEngineAddition: string | undefined;
  const pinnedContextEngine = extensionRegistry.resolveSlot(
    "contextEngine",
    turnConfig,
    extensionRegistry.contextEngines,
  );
  if (pinnedContextEngine?.assemble) {
    try {
      // Pi session isn't built yet — pass an empty array. The contract lets
      // an engine assemble before-turn; richer "live session messages" wiring
      // can land once a real engine ships and we know what it needs.
      const result = await pinnedContextEngine.assemble({ sessionMessages: [] });
      contextEngineAddition = result.systemPromptAddition;
    } catch (err) {
      log.warn("context-engine assemble() threw — falling back to built-in", {
        slot: pinnedContextEngine.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Re-assert the native Ollama api registration: model resolution above can call
  // ModelRegistry.refresh() (on a cold-model miss), which resets dynamically-
  // registered api providers. This (idempotent, self-healing) call re-registers
  // "ollama" so the session's streamFn dispatches to the native transport.
  ensureOllamaNativeApiRegistered();
  ensureClaudeCliApiRegistered();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: model as never,
    thinkingLevel: args.thinkingLevel ?? "off",
    tools: allEnabledToolNames,
    customTools: brigadeCustomTools,
    sessionManager,
    resourceLoader: brigadeResourceLoader,
    transformContext,
  } as never);

  if (!session) {
    throw new Error("Pi createAgentSession returned no session.");
  }

  // H4 — install the payload-level streamFn wrap so every outbound LLM
  // payload runs the four provider-payload mutators (Anthropic cache hints,
  // universal CACHE_BOUNDARY_MARKER strip, Gemini thinking-config reformat,
  // SiliconFlow `thinking: "off"` swap, Minimax disable). Wraps OVER Pi's
  // existing auth-aware streamFn so credentials still flow; never replaces
  // it. Safe to call once per session — guards on the original being a fn.
  wrapStreamFnWithPayloadMutations(session);

  // Install the composed beforeToolCall guard. Three layers run in order:
  //
  //   1. UNKNOWN-TOOL GUARD (`makeUnknownToolGuard`) — name validation:
  //      tool not in `enabledToolNames`, malformed args. Allowlist
  //      uses normalised names so `Read`/`READ`/`  read  ` all match.
  //      If this blocks, we stop here.
  //
  //   2. TOOL-LOOP DETECTOR (`makeToolLoopDetector`) — catches a model
  //      that's stuck repeating the same call. Warns at 10 identical
  //      consecutive calls (bus event), blocks at 20 with a synthetic
  //      refusal that teaches the model to try something different.
  //      Per-session ring buffer keyed by sessionKey via the shared
  //      gateCtxRef so loops persist across turn boundaries within a
  //      single session.
  //
  //   3. EXEC GATE (`makeExecGate`) — bash/exec/shell/sh routing
  //      through `decideApproval` (Primitive #3): allow / deny / prompt.
  //      Also refuses workdir/cwd/env overrides on shell tools and
  //      surfaces a typed message when the on-disk allowlist file
  //      has an unsupported schema version.
  //
  // Pi turns any guard's `block: true` return into a synthetic
  // tool_result the model sees inline, so the next turn can self-correct.
  //
  // Path-mutating tools (`write`, `edit`) are intentionally NOT gated
  // here — Pi resolves their relative paths against the session cwd
  // (the agent's workspace dir), and absolute paths pass through. This
  // matches the established `tools.fs.workspaceOnly = false` default.
  const sessionWithBeforeHook = session as AgentSession & {
    agent?: {
      beforeToolCall?: BrigadeBeforeToolCallHook;
    };
  };
  // Mutable closure-bag the shared guard chain reads for `tool-blocked`
  // bus-event correlation. The agent-loop sets
  // `gateCtxRef.value = {runId, agentId, sessionKey}` once it has those
  // (just before the prompt() call) and clears it in the finally block.
  const gateCtxRef: GuardContextRef = { value: {} };
  // Captured so the MCP tool-plane (claude-cli harness) can reuse the EXACT same
  // composed guard for its tool calls — approval/exec-gate/unknown-tool/
  // path-write/loop, closing over the same gateCtxRef so prompts route to the
  // right operator. Registered below once gateCtxRef is populated; disposed in
  // the finally. The harness backend (below) turns it into the guarded tool-plane
  // it serves to the external binary.
  let brigadeGuard: BrigadeBeforeToolCallHook | undefined;
  // A HARNESS backend (claude-cli) installs itself for the turn below. Every other
  // provider keeps the frozen no-op, so loop backends are byte-identical to before.
  let harnessHandle: HarnessTurnHandle = NOOP_HARNESS_HANDLE;
  if (sessionWithBeforeHook.agent) {
    // SHARED guard chain — identical to the one buildAgent installs:
    //   unknown-tool guard → loop detector → exec-gate.
    brigadeGuard = composeBrigadeBeforeToolCall({
      enabledToolNames: allEnabledToolNames,
      gateCtxRef,
      displayCwd: cwd,
    });
    sessionWithBeforeHook.agent.beforeToolCall = brigadeGuard;
  }

  // Compose stream-fn wrappers around Pi's auth-aware streamFn. Order
  // matters and is from-the-outside-in: the outermost wrapper sees events
  // last (closest to Pi's consumer), the innermost sees them first
  // (closest to the provider). We chain idle-timeout outermost so a hung
  // provider trips the timer regardless of inner repair work; tool-call
  // repair is innermost so even a malformed delta from the wire gets
  // cleaned before the stop-reason wrapper sees it.
  //
  // Crucially — never REPLACE Pi's streamFn (a brigade memory note locks
  // this in: replacement loses the auth wrapping and every call goes
  // silently keyless). Wrapping preserves Pi's wrapper at the bottom of
  // the call stack.
  const sessionAgent = (session as AgentSession & {
    agent?: { streamFn?: import("./stream-wrappers.js").BrigadeStreamFn };
  }).agent;
  if (sessionAgent && typeof sessionAgent.streamFn === "function") {
    const baseStreamFn = sessionAgent.streamFn;
    const idleTimeoutMs = resolveIdleTimeoutMs(args.provider);
    // Dispatch Brigade's OWN transports (claude-cli, native ollama) directly,
    // INNERMOST — beneath the wrappers so they still get idle-timeout /
    // stop-reason / tool-call-repair. Pi resolves a registered api via its
    // module-global registry, but a published/global install nests a SECOND
    // `pi-ai` under `pi-coding-agent` (whose `streamSimple` the Agent defaults
    // to), so our registration lands in one registry and the lookup reads the
    // other → "No API provider registered for api: claude-cli". Direct dispatch
    // removes that dependency entirely. Cloud providers still fall through to
    // `baseStreamFn` — Pi's auth wrapper — which must never be replaced.
    const dispatchStreamFn = makeTransportDispatch(baseStreamFn);
    const wrappedStreamFn = wrapStreamFnWithIdleTimeout(
      wrapStreamFnWithStopReasonRecovery(
        wrapStreamFnWithToolCallRepair(dispatchStreamFn),
      ),
      { timeoutMs: idleTimeoutMs },
    );
    // Re-assert the native Ollama api registration at the LAST possible moment —
    // immediately before Pi's streamSimple calls getApiProvider(model.api). Pi's
    // api-provider registry is a process-global that Pi resets from SEVERAL
    // internal points (AgentSession.reload(), ModelRegistry.refresh(), and
    // register/unregisterProvider() all call resetApiProviders()). Any of those can
    // fire AFTER the pre-session re-assert — createAgentSession's own resource
    // reload, a config hot-reload, a mid-turn model switch, or a same-session retry
    // (the retry loop re-prompts the SAME session, so a one-time pre-session
    // registration doesn't survive a wipe). Registering here is the only spot that
    // runs on EVERY dispatch and EVERY retry, so an "ollama" turn can never hit an
    // empty registry ("No API provider registered for api: ollama"). Gated to
    // ollama models so pure-cloud turns don't register an unused provider. Wrap,
    // never REPLACE — Pi's auth wrapper stays at the bottom of the stack.
    sessionAgent.streamFn = ((model: { api?: string }, context: unknown, options: unknown) => {
      if (model?.api === "ollama") ensureOllamaNativeApiRegistered();
      else if (model?.api === "claude-cli") {
        ensureClaudeCliApiRegistered();
        // Hand the transport this turn's harness context (owner flag + tool-plane
        // callback URL). Gated to claude-cli dispatches — raw-API providers never
        // see it, and on any other provider the handle is the frozen no-op.
        harnessHandle.stampContext(context);
      }
      return (wrappedStreamFn as (m: unknown, c: unknown, o: unknown) => unknown)(model, context, options);
    }) as typeof baseStreamFn;
    log.debug("stream wrappers installed", {
      idleTimeoutMs,
      provider: args.provider,
      model: args.modelId,
    });
  }

  // Seed the workspace before we read its state. Idempotent: only writes
  // files that don't exist yet, so an established workspace is a no-op.
  // Without this, a fresh `~/.brigade/` (e.g. after `rm -rf ~/.brigade`)
  // would have no BOOTSTRAP.md / IDENTITY.md / AGENTS.md / etc., the
  // assembler would have nothing to inject, and the model would default
  // to its baseline ("I'm your coding assistant") instead of the
  // BOOTSTRAP-driven greeting. Runtime A's `buildAgent` already does
  // this at boot — runSingleTurn was missing the equivalent step.
  await bootstrapWorkspace(workspaceDir);

  // Detect lifecycle phase BEFORE the turn. Two layers stack here:
  //   1. Workspace-level phase from workspace-state.json. Scopes to
  //      "has this workspace been onboarded? has BOOTSTRAP.md been
  //      consumed?" Persists across sessions.
  //   2. Per-session bootstrap-delivery marker in the JSONL transcript.
  //      Scopes to "has the full bootstrap context already been
  //      delivered to *this* session, and not invalidated by a
  //      compaction since?" Lets sub-agent forks and post-compaction
  //      recovery emit the first-turn nudge again when needed, while
  //      the workspace has long since completed setup.
  const phaseBefore = await evaluateBootstrapPhase(workspaceDir);
  // Per-session bootstrap-delivery marker. Convex mode has no JSONL on disk,
  // so the file-scan returns false every turn (→ wasteful re-delivery); read
  // the marker from the convex transcript records instead. The marker is
  // WRITTEN via markBootstrapDeliveredToSession (appendCustomEntry → the
  // convex-backed SessionManager persists it), so both sides agree on the
  // canonical customType.
  const rctxForBootstrap = tryGetRuntimeContext();
  const sessionAlreadyHasBootstrap =
    rctxForBootstrap?.mode === "convex"
      ? await rctxForBootstrap.store.messages
          .hasBootstrapDelivered(agentId, resolved.sessionId)
          .catch(() => false)
      : await hasDeliveredBootstrapToSession(resolved.transcriptPath);
  // `senderIsOwner` defaults to true — TUI, bash, and direct-RPC callers are
  // always the operator. Channel adapters set this to `false` when the
  // approved peer is NOT the operator's own linked-channel id, so a friend's
  // first DM doesn't trigger the operator's identity-onboarding ritual.
  const senderIsOwner = args.senderIsOwner !== false;
  const effectivePhase = resolveEffectiveBootstrapPhase({
    workspacePhase: phaseBefore,
    sessionAlreadyHasBootstrap,
    senderIsOwner,
  });

  // Query the actual tool names Pi wired to this session, then map each to
  // a one-line summary. We pass the resolved descriptions through to the
  // assembler so the system prompt enumerates the live tool surface (model
  // calls them by exact name + knows what each does). Pi 0.70.x exposes
  // `getActiveToolNames()`; older minors may not — fall back to our
  // configured allowlist so the prompt still has a useful list.
  const sessionWithTools = session as AgentSession & {
    getActiveToolNames?: () => string[];
  };
  const activeToolNames = (
    typeof sessionWithTools.getActiveToolNames === "function"
      ? sessionWithTools.getActiveToolNames()
      : allEnabledToolNames
  ).slice();
  const toolDescriptions = activeToolNames.map((name) => ({
    name,
    summary: resolveToolSummary(name) ?? "",
  }));

  // Resolve the SAFE auto-recall origin for this turn ONCE — fail-closed
  // `undefined` means SKIP auto-recall (no safe scope). Threads
  // `effectiveSenderIsOwner` (the injection-downgraded owner flag, not the raw
  // `senderIsOwner`) so a poisoned-inbox turn does not auto-recall owner memory.
  const recallOrigin = resolveAutoRecallOrigin({
    senderIsOwner: effectiveSenderIsOwner,
    sessionKey: resolved.sessionKey,
    ...(args.channelApprovalRoute ? { channelApprovalRoute: args.channelApprovalRoute } : {}),
  });

  // Pin the assembled persona before the first turn. Done after
  // createAgentSession (which has already set up Pi's stock prompt) but
  // before prompt() so the model sees the brigade-flavoured persona on
  // turn 1 and on every subsequent turn (the pi-injection helper patches
  // the rebuild hook so tool-list changes don't clobber it).
  const personaPrompt = await buildPersonaPrompt({
    agentId,
    workspaceDir,
    cwd,
    modelLabel: `${args.provider}/${args.modelId}`,
    // Raw model id (no provider prefix) so the assembler's
    // `pickModelFamilyGuidance` can match `gpt-*` / `o[13]-*` / `gemini-*`
    // / `claude-*` / `codex-*` and inject the per-family identity-override
    // block (e.g. "your baseline says 'I'm ChatGPT' — OVERRIDDEN by the
    // persona configuration above"). Without this, smaller / cheaper models
    // happily reply with their training-data identity ("I'm your coding
    // assistant") instead of following IDENTITY.md.
    modelId: args.modelId,
    thinkingLevel: args.thinkingLevel ?? "off",
    bootstrapPhase: effectivePhase,
    toolDescriptions,
    capabilities: promptCapabilities,
    // Pre-rendered <available_skills> XML for the eligible skills (Primitive
    // #5). Lands in the cached prefix under `## Skills`; the model reads a
    // skill's body on demand via the read tool.
    skillsPromptBlock: skillDiscovery.promptBlock,
    // Channel surface for the `## Messaging` section. Reads from the
    // process-wide channel-manager singleton — when the gateway has
    // started adapters, the model sees the directory + (when this turn
    // came from a channel inbound) the in-place-reply hint. Skipped in
    // standalone CLI runs where no manager is mounted.
    channels: (() => {
      const manager = getActiveChannelManager();
      const started = manager ? manager.started : [];
      const startedSet = new Set(started);
      // AVAILABLE-but-not-connected channels (channel-foundation awareness):
      // every REGISTERED channel adapter that isn't currently started is one
      // the operator could wire up via `connect_channel`. Reflects real state
      // — the model can OFFER to connect e.g. Telegram instead of claiming it
      // can't message there. Sourced from the same per-agent extension registry
      // the gateway uses (already loaded for this turn). Skipped entirely when
      // no registry is mounted (standalone CLI runs).
      const available: Array<{ channelId: string; label: string; connectable: boolean }> = [];
      try {
        for (const adapter of extensionRegistry.channels) {
          if (startedSet.has(adapter.id)) continue;
          available.push({ channelId: adapter.id, label: adapter.label, connectable: true });
        }
      } catch {
        // Registry read failures must never break a turn — just skip awareness.
      }
      // Nothing started AND nothing to connect → omit the channels arg entirely
      // (keeps the prompt byte-identical to the no-channels shape).
      if (started.length === 0 && available.length === 0) return undefined;
      const route = args.channelApprovalRoute;
      // Probe each started adapter's health (sync, cheap — reads a cached
      // bool) so the assembler can surface a `⚠️ degraded` block when any
      // adapter is logged-out / disconnected / starting. Without this the
      // model recommends a channel that will refuse the send.
      const degraded: Array<{
        channelId: string;
        reason: string;
        remediation?: string;
      }> = [];
      // Linked self-account per adapter (sync, cheap — reads the cached
      // connection id). The assembler surfaces it in `## Messaging` so the
      // model knows the operator's own number instead of asking for it.
      const linked: Array<{ channelId: string; selfId: string }> = [];
      for (const id of started) {
        const adapter = manager?.adapter(id);
        if (!adapter) continue;
        const selfId = typeof adapter.selfId === "function" ? adapter.selfId() : undefined;
        if (selfId) linked.push({ channelId: id, selfId });
        if (typeof adapter.health !== "function") continue;
        const status = adapter.health();
        if (!status.ok) {
          degraded.push({
            channelId: id,
            reason: status.reason,
            ...(status.remediation !== undefined ? { remediation: status.remediation } : {}),
          });
        }
      }
      return {
        started,
        ...(available.length > 0 ? { available } : {}),
        ...(linked.length > 0 ? { linked } : {}),
        ...(degraded.length > 0 ? { degraded } : {}),
        ...(route
          ? {
              currentChannel: {
                channelId: route.channelId,
                ...(route.conversationId !== undefined
                  ? { conversationId: route.conversationId }
                  : {}),
                ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
              },
            }
          : {}),
      };
    })(),
    config: turnConfig,
    // Auto-recall: lexically surface the top relevant structured facts for THIS
    // user message as an ephemeral (per-turn, below-cache-boundary) suffix, so
    // the model has them without calling recall_memory. Sync + free. This is a
    // PASSIVE injection — it does NOT bump accessCount (only the explicit
    // recall_memory tool reinforces decay). Only present when memory is enabled.
    //
    // Lane J: when a `contextEngine` slot plugin returned a
    // `systemPromptAddition`, append it AFTER the auto-recall block so it
    // also lands below the cache boundary. Both are per-turn dynamic so they
    // share the ephemeral slot; the assembler's sanitiser handles either as
    // plain text.
    // Auto-recall is for the OPERATOR-facing turn: surface what the parent
    // remembers about THIS user message so the model can use it without an
    // explicit recall_memory call. Sub-agents (Primitive #6) get a focused,
    // parent-injected task — auto-recalling parent-scoped memory facts there
    // would pollute the bounded context with content the task didn't ask for.
    // Gate on `!subagentMode` so the suffix stays clean for delegated runs.
    //
    // Origin filter: owner turns recall only owner-origin facts; channel-
    // routed peers recall only their own session's facts. Without this
    // filter, an approved peer's auto-recall would surface the operator's
    // private memory (and vice versa). A non-owner turn missing a
    // channelContext or sessionKey falls back to `undefined` — auto-recall
    // sees no records (consistent with the recall_memory tool's behaviour).
    ephemeralSuffix: mergeEphemeralSuffix(
      promptCapabilities?.memory &&
      !promptCapabilities.subagentMode &&
      !promptCapabilities.cronMode &&
      // Fail CLOSED: only auto-recall when there is a SAFE origin (owner turn, or
      // a channel-routed peer). A non-owner turn with no channel route is skipped
      // entirely — never the operator's facts. (Defends the isolation invariant
      // at THIS sink, not via a caller-enforced precondition.)
      //
      // Use `effectiveSenderIsOwner` (NOT the raw `senderIsOwner`): an untrusted
      // pending event downgrades this turn to non-owner, so a poisoned-inbox turn
      // must NOT auto-recall owner-scope memory. Resolve the origin ONCE and reuse
      // it for the block — a single source of truth for the recall scope.
      recallOrigin
        ? await buildAutoRecallBlock(memoryCapability, args.message, { origin: recallOrigin })
        : undefined,
      contextEngineAddition,
    ),
    // Cron primitive: thread the `lightContext` flag down to the persona
    // builder. When set, the entire workspace bootstrap surface is dropped
    // for a minimal prompt (cron's task message carries the context).
    ...(args.lightContext === true ? { lightContext: true } : {}),
  });
  if (personaPrompt) {
    applyPersonaOverrideToSession(session as AgentSession, personaPrompt);
  }

  // Hand the fully-wired session to the per-turn driver (gateway / TUI) so it
  // can steer / abort / switch-model mid-stream for the duration of THIS turn.
  // The driver drops the reference when the turn settles — no session lives
  // between turns (the per-turn mirror). Guarded so a throwing callback can't
  // abort the turn.
  if (args.onSessionReady) {
    try {
      args.onSessionReady(session as AgentSession);
    } catch (err) {
      log.warn("onSessionReady callback threw", {
        sessionId: resolved.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // prompt() runs a full user turn — Pi enqueues the message, drives the
  // agent loop, and resolves once the turn is complete (assistant reply
  // committed to messages, isStreaming/isCompacting cleared).
  //
  // Do NOT use steer() here: steer is for *mid-turn* injection. With no
  // active run it just enqueues into the steering buffer and returns
  // immediately — the assistant never speaks and brigade prints nothing.
  //
  // Wrapped in runWithRetry so a transient provider failure (rate limit,
  // overload, timeout) is automatically retried with backoff + jitter
  // instead of surfacing as a hard turn error to the caller. Same-model
  // retries only — multi-model fallback is one layer up (see
  // model-fallback.ts), which is wired in by the resilient agent runner.
  //
  // The user message is scrubbed of the Anthropic refusal-trigger magic
  // string before Pi sees it; otherwise a paste-through of that literal
  // would coerce Claude into refusing the next turn.
  // Drain any pending system events queued for THIS session. Cron's
  // fire-time announces now land in the SESSION INBOX (drained below as
  // `inboxBlock`) so the heartbeat runner can consume them for synthetic
  // turns; this legacy pending queue still carries cron DELIVERY-FAILURE
  // notices ("couldn't deliver via whatsapp — …", see the announce
  // dispatcher in `src/core/server.ts`). Each pending event becomes a
  // `<system_event>` block prepended to the user's text so the model sees
  // the failure BEFORE it answers the new message instead of bullshitting
  // "should be landing any moment now".
  const pendingEvents = drainPendingSystemEvents(resolved.sessionKey);
  const pendingPrefix = formatPendingEventsPrefix(pendingEvents);
  // SessionInbox drain (Step 12). A2A messages (`sessions_send`), sub-agent
  // completion announces, heartbeat-fired wakes, exec-event surfaces all
  // land in the broader SessionInbox queue (`session-inbox.ts`). Drain +
  // format them here so they prefix the user message alongside the cron-
  // specific Track-2 events drained above. Returns `undefined` when no
  // surface-able events are pending; the prompt body stays unchanged.
  // Stage D additive-gate: PEEK the inbox BEFORE draining so the org
  // layer can render receiver-side hints (per-event framing) and the
  // top-of-org escalation inbox summary. Both helpers return `undefined`
  // unless cfg.org is present AND an event in the batch carries
  // `brigade-org-kind:` metadata on its contextKey — when cfg.org is
  // absent, this block emits ZERO new bytes and the legacy combinedPrefix
  // assembly is preserved bit-for-bit.
  let orgEphemeralBlock: string | undefined;
  try {
    const orgConfig = turnConfig as { org?: unknown };
    if (orgConfig.org) {
      const inspected = inspectPendingSessionEvents(resolved.sessionKey);
      if (inspected.events.length > 0) {
        const orgBlocks: string[] = [];
        // Per-event hint render (delegation / escalation / review framing).
        const { renderReceiverHints } = await import(
          "../system-prompt/org/receiver-hint.js"
        );
        const hints = renderReceiverHints(inspected.events);
        if (hints) orgBlocks.push(hints);
        // Top-of-org escalation inbox summary (only when caller is topOrder).
        const orgGraph = deriveOrgDisplayGraph(turnConfig as never);
        if (orgGraph) {
          const { renderEscalationInbox } = await import(
            "../system-prompt/org/escalation-inbox.js"
          );
          const inboxSummary = renderEscalationInbox({
            callerAgentId: agentId,
            graph: orgGraph,
            events: inspected.events,
          });
          if (inboxSummary) orgBlocks.push(inboxSummary);
        }
        if (orgBlocks.length > 0) orgEphemeralBlock = orgBlocks.join("\n\n");
      }
    }
  } catch (err) {
    // Org peek failures are non-fatal: skip the block and keep the
    // legacy combinedPrefix shape rather than crashing turn assembly.
    log.warn("Stage D receiver-hint peek failed", {
      sessionId: resolved.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const inboxBlock = drainFormattedSessionEvents({ sessionKey: resolved.sessionKey });
  const combinedPrefix = [orgEphemeralBlock, inboxBlock, pendingPrefix]
    .filter(Boolean)
    .join("\n\n");
  const scrubbedMessage = scrubAnthropicRefusalSentinel(
    combinedPrefix ? `${combinedPrefix}\n${args.message}` : args.message,
  );
  // Process-level event bus wiring. A short-lived run id correlates
  // every event from this turn so multi-consumer subscribers (TUI,
  // gateway WebSocket broadcast, debug logs) can group them. The
  // forwarder pipes Pi's per-event stream into the global bus and
  // is detached at the end of the function so listeners don't pile
  // up across the gateway's long-running process. This is the standard
  // global agent-events registry pattern.
  const runId = randomUUID();
  // Wave L P2#10 — per-turn bound logger. Every log emitted via
  // `turnLog` automatically carries `agentId / sessionId / runId`
  // so observability tooling can correlate without each call-site
  // threading the trio by hand. Existing `log.*` callsites still
  // work unchanged.
  const turnLog = log.bind({
    agentId,
    sessionId: resolved.sessionId,
    runId,
  });
  void turnLog;
  // Publish runId+agentId+sessionKey to the closure-bag so any
  // `tool-blocked` events emitted during this turn carry accurate
  // correlation ids AND the loop detector keys its ring buffer to
  // this session's transcript (so loops persist across turn
  // boundaries but stay scoped per-session). Cleared in finally
  // so a subsequent turn (which reuses the same session) doesn't
  // leak stale ids.
  gateCtxRef.value = {
    runId,
    agentId,
    sessionKey: resolved.sessionKey,
    // Primitive #6: when this turn IS a sub-agent run, propagate depth + label
    // + parent runId to every guard event (exec-gate routes them into the
    // approval prompt so the operator sees "Sub-agent 'audit auth flow' wants
    // to run …" instead of the default "Brigade wants to run …" attribution).
    // Top-level turns leave all three unset.
    ...(callerSubagentDepth > 0 ? { subagentDepth: callerSubagentDepth } : {}),
    ...(args.subagentLabel !== undefined ? { subagentLabel: args.subagentLabel } : {}),
    ...(args.parentRunId !== undefined ? { parentRunId: args.parentRunId } : {}),
    // Channel routing — exec-gate uses this to send approval prompts into
    // the originating chat instead of (only) the gateway WS. Channel-routed
    // inbounds populate it via runGatewayTurn; TUI / sub-agent / cron turns
    // leave it unset and fall back to the legacy WS-only broadcast.
    ...(args.channelApprovalRoute !== undefined
      ? { channelRoute: args.channelApprovalRoute }
      : {}),
  };
  // Duck-typed Pi session subscription. We assert the SHAPE we want
  // rather than coupling to a specific Pi version's exported type. If
  // a future Pi changes `subscribe` to return `Promise<() => void>` or
  // an object with `.unsubscribe()`, calling `rawDetach()` may throw —
  // that throw is caught by `detachPiForwarder`'s internal try/catch
  // (see below), so the bus listener still gets cleared and the worst
  // case is a stale per-event log line, not a leak.
  const subscribableSession = session as unknown as {
    subscribe?: (cb: (piEvent: unknown) => void) => () => void;
  };
  const rawDetach =
    typeof subscribableSession.subscribe === "function"
      ? subscribableSession.subscribe((piEvent) =>
          emitAgentEvent({
            type: "pi",
            runId,
            agentId,
            sessionId: resolved.sessionId,
            piEvent,
            // Primitive #6: tag sub-agent depth so the gateway can indent
            // child events in the connect-mode TUI without re-deriving from
            // the session key on every event.
            ...(callerSubagentDepth > 0 ? { subagentDepth: callerSubagentDepth } : {}),
          }),
        )
      : () => {};
  // Idempotent detach. Called in two places: the success path emits
  // turn-settled then detaches; the error path's finally block detaches
  // unconditionally. Both routes converge here without double-detaching.
  let piForwarderDetached = false;
  const detachPiForwarder = (): void => {
    if (piForwarderDetached) return;
    piForwarderDetached = true;
    try {
      rawDetach();
    } catch {
      // session may already be torn down; nothing useful to do
    }
  };

  try {
  // Install the HARNESS backend for this turn, if one owns it.
  //
  // MUST live INSIDE this try: its `finally` is what disposes the handle. A throw
  // between install and the try would otherwise strand the tool-plane token in the
  // process-global registry for the gateway lifetime, retaining the whole turn
  // context (tools + guard + signal).
  //
  // The backend registers the guarded tool-plane, threads runId (TUI tool events)
  // and the transcript sink, and hands back a disposable handle. It fails open: a
  // peer turn, or the cold `brigade agent` path (no gateway host), registers
  // nothing and the turn proceeds exactly as before.
  if (claudeCliHarnessBackend.owns({ provider: args.provider })) {
    harnessHandle = claudeCliHarnessBackend.installTurn({
      agentId,
      provider: args.provider,
      modelId: args.modelId,
      cwd,
      sessionKey: resolved.sessionKey,
      runId,
      session,
      senderIsOwner: effectiveSenderIsOwner,
      customTools: brigadeCustomTools,
      builtinToolNames: toolset.builtinToolNames,
      ...(brigadeGuard ? { guard: brigadeGuard } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  }

  log.info("turn starting", {
    agentId,
    sessionId: resolved.sessionId,
    isNewSession: resolved.isNew,
    provider: args.provider,
    model: args.modelId,
    bootstrapPhase: effectivePhase,
  });
  emitAgentEvent({
    type: "turn-start",
    runId,
    agentId,
    sessionId: resolved.sessionId,
    isNewSession: resolved.isNew,
    provider: args.provider,
    modelId: args.modelId,
    bootstrapPhase: String(effectivePhase),
  });

  // Pre-emptive compaction. When estimated context usage crosses the
  // 85% threshold, ask Pi to compact NOW rather than rolling into the
  // turn and discovering mid-flight that we've blown the window. The
  // estimator is rough (chars/4) but conservative — better to compact
  // a turn early than fail mid-stream.
  //
  // The estimate must reflect the FULL request, not just the transcript:
  // the pinned persona prompt (state.systemPrompt — a SEPARATE field Pi
  // reads at request time, NOT in session.messages) and the about-to-be-
  // sent user message both consume window on every request. Omitting them
  // biases the estimate low by the fixed persona cost present on each
  // request, so the 85% trigger fires LATE and the turn is likelier to
  // fall through to Pi's mid-stream auto-compaction. Thread both in so the
  // decision sees the true pre-prompt fill.
  // Size compaction against the BILLING-SAFE window. On an Anthropic
  // subscription the included tier is 200K; a request over that uses
  // long-context and bills the pay-as-you-go "extra usage" bucket even while
  // the plan's session/weekly quota is untouched. Clamping the window here makes
  // the 85% trigger fire before 200K, so a subscription never draws extra-usage
  // credits. API-key auth (pay-per-token, no extra-usage concept) keeps the
  // model's real window unchanged.
  const rawContextWindow = (model as { contextWindow?: number })?.contextWindow;
  const effectiveContextWindow = billingSafeContextWindow(
    args.provider,
    rawContextWindow,
    subscriptionProviders.has(args.provider),
  );
  await maybeTriggerCompaction({
    session: session as AgentSession,
    model: { contextWindow: effectiveContextWindow },
    agentId,
    sessionId: resolved.sessionId,
    // The pinned persona prompt — empty string when the workspace is empty
    // (the assembler returns "" and applyPersonaOverrideToSession is skipped),
    // which contributes 0 to the estimate.
    systemPrompt: personaPrompt,
    // The incoming user message (with any drained prefixes) that prompt()
    // will send below; maybeTriggerCompaction runs BEFORE that send.
    incomingMessage: scrubbedMessage,
    ...(recallOrigin ? { origin: recallOrigin } : {}),
  });

  // Snapshot the transcript length immediately before the FIRST prompt of
  // this turn. Used by the max_tokens continuation path below: every settled
  // run (initial + each continuation) pushes a NEW assistant message into
  // session.messages, so a capped answer split across N continuations lands
  // as N distinct segments — NOT restatements. extractLastAssistantText
  // returns only the most-recent segment, which would silently drop the
  // truncated head + every middle segment. We instead concatenate every
  // assistant message produced from this index forward (see `reply` below).
  // Captured once here — before runWithRetry, which may re-invoke the
  // attempt closure on transient failures — so retries don't move it.
  const messageCountBeforeTurn = (session as AgentSession).messages.length;

  // A3 — inbound IMAGE blocks as a multimodal user message.
  //
  // The channel inbound pipeline may have decoded inbound image attachments
  // into `args.images` (`{ data: base64, mimeType }[]`). `resolveInboundImagePrompt`
  // attaches them to `prompt(...)` as Pi `ImageContent` ONLY when the resolved
  // turn model is vision-capable — it reads the authoritative `Model.input`
  // (`("text"|"image")[]`) via `modelSupportsImageInput`. On a text-only model
  // (or when no images were threaded) it returns `undefined`, so the call below
  // is byte-identical to the historical string-only prompt and the `[attached
  // image → <path>]` note in `scrubbedMessage` is the model's signal to call
  // `analyze_media` instead. TUI / cron / sub-agent / RPC turns never set
  // `args.images`, so they always take the string path too.
  const promptImageOptions = resolveInboundImagePrompt(model, args.images);
  if (promptImageOptions) {
    log.debug("inbound images attached to turn", {
      agentId,
      sessionId: resolved.sessionId,
      count: promptImageOptions.images.length,
      provider: args.provider,
      model: args.modelId,
    });
  }

  await runWithRetry({
    ctx: { provider: args.provider, model: args.modelId },
    signal: args.signal,
    onAttemptFailed: async (info) => {
      const fields = {
        agentId,
        sessionId: resolved.sessionId,
        provider: args.provider,
        model: args.modelId,
        attempt: info.attemptIndex,
        reason: info.reason,
        willRetry: info.willRetry,
        backoffMs: info.backoffMs,
        error: info.errorSummary,
        profileId: selectedProfileId,
      };
      if (info.willRetry) {
        log.warn("turn attempt failed, retrying", fields);
      } else {
        log.error("turn attempt failed, surfacing", fields);
        // Terminal failure on a live-catalog OpenAI-compatible endpoint (NVIDIA NIM
        // etc.): a timeout usually means the picked model is advertised-but-not-
        // served. Verify with a bounded probe and surface an actionable hint
        // ("‹model› isn't responding — /model to switch") instead of a bare
        // "timeout". Best-effort; never blocks or throws into the retry orchestrator.
        const reason = String(info.reason ?? "");
        const failed = model as { api?: string; baseUrl?: string } | undefined;
        if (
          /timeout|connect|econn|network|socket/i.test(reason) &&
          failed?.api === "openai-completions" &&
          failed.baseUrl
        ) {
          try {
            const probeKey = await (authStorage as { getApiKey(p: string): Promise<string> })
              .getApiKey(args.provider)
              .catch(() => undefined);
            if (probeKey) {
              const hint = describeModelProbe(
                await probeModelReachable(failed.baseUrl, probeKey, args.modelId),
                args.provider,
                args.modelId,
              );
              if (hint) log.warn(hint);
            }
          } catch {
            /* best-effort hint — never disturb the terminal-failure path */
          }
        }
      }
      // Narrate the retry on the bus so connect-mode clients see "retrying…"
      // (the gateway translates this into a `log` frame). Only on actual
      // retries — a terminal failure surfaces as the turn's error, not a retry.
      if (info.willRetry) {
        emitAgentEvent({
          type: "turn-retry-attempt",
          runId,
          agentId,
          sessionKey: resolved.sessionKey,
          errorClass: String((info as { class?: string }).class ?? "unknown"),
          reason: String(info.reason ?? info.errorSummary ?? "transient error"),
        });
      }
      // Update the on-disk cooldown state so this profile rotates out on
      // the next run if its failure category warrants a cooldown. Skipped
      // when no profile id was tracked (single-profile fallback path).
      //
      // Locked variant: re-loads fresh state under the per-agent cooldown
      // lock, merges THIS failure against THAT snapshot, then saves. The
      // surrounding retry orchestrator awaits the returned Promise so the
      // next attempt's `loadProfileStateLocked` sees this write.
      if (selectedProfileId) {
        cooldownState = await recordProfileFailureLocked({
          agentId,
          state: cooldownState,
          profileId: selectedProfileId,
          reason: info.reason,
          modelId: args.modelId,
        });
      }
    },
    attempt: async (_attemptIndex, _signal) => {
      // Compose order (outer → inner):
      //   thinkingFallback → contentQualityRetry → prompt(scrubbedMessage)
      //
      // thinkingFallback OUTER: if the very first prompt fails with
      // "thinking not supported", downgrade thinkingLevel and retry the
      // SAME user message before contentQualityRetry ever sees it. The
      // retry body inside thinkingFallback re-runs everything — including
      // contentQualityRetry — so the second attempt still gets the
      // "did the model actually act?" check.
      //
      // contentQualityRetry INNER: only fires after a successful prompt
      // settles. If the model returned "I'll do X" without doing X, OR
      // reasoning-only, OR empty, queue one steering re-prompt.
      //
      // Both wrappers are hard-capped at one retry. Combined ceiling is
      // 4 prompts in the worst case (initial → thinking-downgrade →
      // initial-of-retry → content-quality-steer-of-retry) — bounded.
      await runWithThinkingFallback(
        session as AgentSession,
        async () => {
          await runWithContentQualityRetry(
            session as AgentSession,
            async () => {
              // Multimodal user message when inbound vision images are present
              // + the model supports them (A3); otherwise the historical
              // string-only prompt (byte-identical) — `promptImageOptions` is
              // `undefined` in that case and Pi receives just the text.
              if (promptImageOptions) {
                await (session as AgentSession).prompt(scrubbedMessage, promptImageOptions);
              } else {
                await (session as AgentSession).prompt(scrubbedMessage);
              }
              // Defensive settle wait. prompt() should already have settled
              // the run, but if Pi adds queued steers or background
              // compactions in a future minor, this catches the late activity.
              await waitForStreamSettled(session as AgentSession);
              // Surface a provider-error stop BEFORE content-quality inspects
              // the (empty) content — otherwise it's mistaken for an "empty"
              // reply and we re-prompt a model that's hard-erroring.
              assertNoProviderErrorStop(session as AgentSession);
            },
            {
              onRetry: (reason: NonNullable<ContentQualityIssue>) => {
                log.warn("content-quality retry triggered", {
                  agentId,
                  sessionId: resolved.sessionId,
                  reason,
                  provider: args.provider,
                  model: args.modelId,
                });
                // Connect-mode narration: "<reason> — re-prompting for a
                // usable answer". The gateway maps this to a `log` frame.
                emitAgentEvent({
                  type: "turn-content-retry",
                  runId,
                  agentId,
                  sessionKey: resolved.sessionKey,
                  reason,
                });
              },
              // A HARNESS backend runs tools out-of-band, so the assistant message
              // can never carry toolCall blocks and the recovery heuristics would
              // read "never acted" on a turn that just ran a deploy. Re-prompting
              // respawns the binary and repeats every side effect. No-op (false)
              // for every loop backend.
              toolActivity: () => harnessHandle.hadToolActivity(),
            },
          );
        },
        {
          onDowngrade: (originalLevel: string, errorMessage: string) => {
            log.warn("thinking level downgraded due to capability error", {
              agentId,
              sessionId: resolved.sessionId,
              originalLevel,
              errorMessage,
              provider: args.provider,
              model: args.modelId,
            });
            // Connect-mode narration: "model doesn't support thinking —
            // switching from <level> to off and retrying".
            emitAgentEvent({
              type: "turn-thinking-downgrade",
              runId,
              agentId,
              sessionKey: resolved.sessionKey,
              from: String(originalLevel),
            });
          },
        },
      );
    },
  });

  // max_tokens auto-continuation. If the model hit its output cap rather
  // than ending naturally, drive a follow-up turn that asks it to continue
  // the previous response. Bounded to 3 continuations per user message so
  // a runaway response can't spin forever; each continuation runs through
  // the same retry loop so transient failures during continuation are
  // handled identically.
  let continuations = 0;
  const MAX_CONTINUATIONS = 3;
  while (
    continuations < MAX_CONTINUATIONS &&
    detectMaxTokensStop(session as AgentSession)
  ) {
    continuations++;
    log.info("max_tokens stop detected — auto-continuing", {
      agentId,
      sessionId: resolved.sessionId,
      continuationIndex: continuations,
    });
    // A harness re-prompt RESPAWNS the external binary, which replays the context
    // and would re-run any tool it can't see it already ran. Flush this attempt's
    // records into the context first, so the continuation reads `[called tool: X]`
    // and its result. Idempotent + a no-op for every loop backend.
    harnessHandle.afterTurn();
    await runWithRetry({
      ctx: { provider: args.provider, model: args.modelId },
      signal: args.signal,
      attempt: async () => {
        await (session as AgentSession).prompt(
          "Please continue your previous response from where you left off. Don't repeat what you've already said.",
        );
        await waitForStreamSettled(session as AgentSession);
        assertNoProviderErrorStop(session as AgentSession);
      },
    });
  }
  if (continuations >= MAX_CONTINUATIONS && detectMaxTokensStop(session as AgentSession)) {
    log.warn("max_tokens continuation limit reached", {
      agentId,
      sessionId: resolved.sessionId,
      attempted: continuations,
    });
  }

  // Successful turn — clear any prior failure state on the profile so the
  // next run prefers it again under the round-robin order. Locked variant:
  // re-loads fresh state under the per-agent cooldown lock, applies the
  // mark against THAT snapshot, then saves — so a sibling turn's recent
  // failure-write isn't silently clobbered by our pre-failure snapshot.
  if (selectedProfileId) {
    cooldownState = await recordProfileSuccessLocked({
      agentId,
      state: cooldownState,
      profileId: selectedProfileId,
      provider: args.provider,
    });
  }

  log.info("turn settled", {
    agentId,
    sessionId: resolved.sessionId,
    provider: args.provider,
    model: args.modelId,
  });
  emitAgentEvent({
    type: "turn-settled",
    runId,
    agentId,
    sessionId: resolved.sessionId,
    provider: args.provider,
    modelId: args.modelId,
  });
  // Release the Pi listener now rather than waiting for GC. On error
  // paths the function exits without reaching here, but the session
  // goes out of scope so the listener is collected eventually — no
  // long-lived leak in the gateway's process.
  detachPiForwarder();

  // Build the user-facing reply. Zero-continuation fast path: the whole
  // answer is the single last assistant message. When the model hit its
  // output cap and we drove one or more continuations, the answer is split
  // across the assistant messages produced THIS turn (the truncated head +
  // each continuation segment) — concatenate them so callers (channels,
  // dispatcher, server) receive the COMPLETE response, not just the last
  // segment. messageCountBeforeTurn is the transcript length captured before
  // the first prompt, so the join starts at this turn's first new message.
  const reply =
    continuations > 0
      ? joinAssistantTextFrom(session as AgentSession, messageCountBeforeTurn)
      : extractLastAssistantText(session as AgentSession);

  // Reconcile whatever the harness recorded out-of-band into the in-memory
  // context. AFTER `reply` so the synthetic messages (which carry no text) cannot
  // affect what the operator sees, and after streaming has stopped — mutating
  // `agent.state.messages` mid-stream would race Pi's own loop. No-op for every
  // loop backend.
  harnessHandle.afterTurn();

  // After-turn lifecycle:
  //
  // 1. If we just delivered the full bootstrap context to this session
  //    (workspace was first-turn AND session hadn't received it before),
  //    emit the per-session marker into the JSONL transcript. Subsequent
  //    turns short-circuit the nudge because the model already has the
  //    context cached.
  if (phaseBefore === "first-turn" && !sessionAlreadyHasBootstrap) {
    markBootstrapDeliveredToSession(sessionManager);
  }

  // 2. Stamp setupCompletedAt the first time we observe BOOTSTRAP.md is
  //    gone after seeding. The check fires on EVERY turn (not just on a
  //    within-turn first-turn → complete transition) because BOOTSTRAP.md
  //    can be deleted out of band — by the user from another shell, or
  //    by the previous turn's reply. markSetupCompleted is idempotent.
  const phaseAfter = await evaluateBootstrapPhase(workspaceDir);
  if (phaseAfter === "complete") {
    await markSetupCompleted(workspaceDir);
  }

  return {
    sessionId: resolved.sessionId,
    sessionKey: resolved.sessionKey,
    isNewSession: resolved.isNew,
    reply,
    messages: (session as AgentSession).messages.slice(),
  };
  } finally {
    // Safety net: if anything between subscribe-time and the success-
    // path detach throws (runWithRetry rejects, AbortError mid-stream,
    // an exception in the cooldown bookkeeping), the listener still
    // gets cleaned up here. Idempotent — the success path's explicit
    // detach above is a no-op once this fires.
    detachPiForwarder();
    // Clear the gate context bag so the NEXT turn (which reuses the
    // session) doesn't see this turn's runId on a refusal that fired
    // outside a prompt() call (e.g. a steer-triggered tool retry that
    // races the turn boundary).
    gateCtxRef.value = {};
    // Tear down whatever the harness installed (the tool-plane token), so it can
    // never outlive the turn — the binary's endpoint 404s the instant we return.
    harnessHandle.dispose();
    harnessHandle = NOOP_HARNESS_HANDLE;
  }
}

// Merge two optional ephemeral-suffix strings into one. Auto-recall (Memory
// Primitive #4) and the context-engine slot's `systemPromptAddition` (Lane J)
// both target the same below-cache-boundary slot; when both are present, we
// concatenate with a blank line between so each block reads as its own
// section. Either-undefined / both-empty collapses to `undefined` so the
// assembler skips the `# Per-turn Notes` block entirely.
function mergeEphemeralSuffix(
  ...parts: ReadonlyArray<string | undefined>
): string | undefined {
  const kept = parts
    .map((p) => p?.trim())
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  if (kept.length === 0) return undefined;
  return kept.join("\n\n");
}

// Build the per-turn system prompt. Three steps:
//   1. Honour an explicit override in brigade.json (escape hatch — replaces
//      the assembled prompt entirely).
//   2. Otherwise load workspace persona files + heartbeat + runtime, run
//      them through the assembler.
//   3. Empty workspace → return empty so Pi keeps its stock prompt rather
//      than getting an empty system message it might balk at.
async function buildPersonaPrompt(args: {
  agentId: string;
  workspaceDir: string;
  cwd: string;
  modelLabel: string;
  /** Raw model id (without provider prefix). Drives per-family guidance. */
  modelId: string;
  thinkingLevel: string;
  bootstrapPhase: BootstrapPhase;
  // Tool surface to advertise in the system prompt. Caller resolves these
  // from the live Pi session (`getActiveToolNames`) so the model gets the
  // real list, not a guess.
  toolDescriptions?: Array<{ name: string; summary: string }>;
  /**
   * Capability gates for conditional guidance blocks. Off-by-default until
   * the matching primitives ship (Memory=#4, Skills=#5, Sub-agents=#6).
   * Pre-plumbed so flipping them on later is a one-line change here.
   */
  capabilities?: {
    memory?: boolean;
    skills?: boolean;
    subAgents?: boolean;
    subagentMode?: boolean;
    cronMode?: boolean;
  };
  /**
   * Pre-rendered `<available_skills>` block (Primitive #5). Emitted in the
   * cached prefix under `## Skills` when `capabilities.skills` is true.
   */
  skillsPromptBlock?: string;
  /**
   * Per-turn-only suffix pinned BELOW the cache boundary so it never busts
   * the cached prefix. Used by sub-agent task framing in Primitive #6.
   */
  ephemeralSuffix?: string;
  /** The turn's config (read once upstream). Falls back to a read when omitted. */
  config?: BrigadeConfig;
  /**
   * Cron primitive: drop EVERY workspace bootstrap file from the persona
   * set. Token-cheap automation runs (the cron knows what it needs from
   * its task message; persona context is overhead).
   */
  lightContext?: boolean;
  /**
   * Channel surface for the `## Messaging` section. Patterned on the
   * reference implementation's messaging-block — lists every started
   * channel so the model can pick the right `channel` value AND, when
   * `currentChannel` is set, knows the in-place-reply path. Undefined
   * (or empty `started`) skips the section.
   */
  channels?: {
    started: readonly string[];
    /** Registered-but-not-connected channels the operator could wire up via
     *  `connect_channel`. Surfaced in `## Messaging` so the model can offer
     *  to connect e.g. Telegram. */
    available?: ReadonlyArray<{
      channelId: string;
      label: string;
      connectable: boolean;
    }>;
    linked?: ReadonlyArray<{
      channelId: string;
      selfId: string;
    }>;
    degraded?: ReadonlyArray<{
      channelId: string;
      reason: string;
      remediation?: string;
    }>;
    currentChannel?: {
      channelId: string;
      conversationId?: string;
      threadId?: string;
    };
  };
}): Promise<string> {
  const config = args.config ?? readConfigOrInit();
  const override = resolveSystemPromptOverride({ config, agentId: args.agentId });
  if (override) return override;

  // Primitive #6 — sub-agent mode flips three things in the assembled prompt:
  //   1. The persona loader drops BOOTSTRAP.md + MEMORY.md (operator-only).
  //   2. The heartbeat file is skipped entirely (parent's cycle state).
  //   3. The assembler swaps the identity opener for the SUB-AGENT banner and
  //      gates off operator-only sections (CLI quick ref, execution bias,
  //      output formatting, per-family identity override, memory wrapper).
  const subagentMode = args.capabilities?.subagentMode === true;
  const cronMode = args.capabilities?.cronMode === true;
  const lightContext = args.lightContext === true;

  // Cron-mode + lightContext drops the entire persona set; cron-mode alone
  // still loads persona files (operator wants the agent to behave with its
  // configured voice, just without the operator-onboarding ritual).
  const personaFiles = lightContext
    ? []
    : await loadWorkspaceContextFiles(args.workspaceDir, { subagentMode: subagentMode || cronMode });
  const heartbeatFile = (subagentMode || cronMode || lightContext)
    ? undefined
    : await loadHeartbeatFile(args.workspaceDir);
  if (personaFiles.length === 0 && !heartbeatFile) return "";

  const runtime = resolveRuntimeParams({
    agentId: args.agentId,
    workspaceDir: args.workspaceDir,
    cwd: args.cwd,
    modelLabel: args.modelLabel,
    thinkingLevel: args.thinkingLevel,
  });

  // Stage-B virtual-office layer. ADDITIVE-CONDITIONAL: when
  // `config.org` is absent (the default for every existing install),
  // `deriveOrgGraph` returns `undefined` and the assembler's `## Org`
  // block emits ZERO bytes. Sub-agent runs get a one-line anchor merged
  // into `ephemeralSuffix` instead of the full block. Existing callers
  // see no behavioural change when `cfg.org` is absent.
  const orgGraph = config.org ? deriveOrgDisplayGraph(config) : undefined;

  // Sub-agent anchor: when this turn IS a sub-agent run AND we have an
  // org graph, append a one-line "Spawned by <id>, inheriting <dept>"
  // anchor to the ephemeral suffix (below the cache boundary, so the
  // sub-agent's cached prefix stays identical to the legacy shape).
  let effectiveEphemeralSuffix = args.ephemeralSuffix;
  if (subagentMode && orgGraph) {
    const anchor = renderSubAgentAnchor(orgGraph, args.agentId);
    if (anchor) {
      effectiveEphemeralSuffix =
        effectiveEphemeralSuffix && effectiveEphemeralSuffix.trim().length > 0
          ? `${anchor}\n\n${effectiveEphemeralSuffix}`
          : anchor;
    }
  }

  // OC mirror: the system prompt does NOT enumerate peers. The model
  // learns the agent catalog exclusively by calling `agents_list`
  // (allowlist-scoped) + the Runtime line's `agent=<id>` field. This is
  // the deliberate anti-hallucination contract — no inline catalog means
  // no stale-roster drift.
  const assembled = assembleSystemPrompt({
    runtime,
    personaFiles,
    heartbeatFile,
    toolDescriptions: args.toolDescriptions ?? [],
    bootstrapPhase: args.bootstrapPhase,
    // Pass the raw model id + thinking level so the assembler's
    // `pickModelFamilyGuidance` (OpenAI / Google identity-override blocks)
    // and conditional-capability gates fire on the right matches.
    modelId: args.modelId,
    thinkingLevel: args.thinkingLevel,
    capabilities: args.capabilities,
    skillsPromptBlock: args.skillsPromptBlock,
    ephemeralSuffix: effectiveEphemeralSuffix,
    ...(args.channels !== undefined ? { channels: args.channels } : {}),
    // Stage-B: when `cfg.org` is present, hand the derived graph to the
    // assembler so its conditional `## Org` block can render. Undefined
    // in legacy mode → assembler skips the block (zero-cost no-op).
    ...(orgGraph !== undefined ? { orgGraph } : {}),
  });
  return assembled.text;
}

// AuthStorage in Pi 0.70.x exposes multiple factories across versions
// (inMemory, fromStorage). We prefer inMemory with the parsed profile blob
// because brigade's auth-profiles.json is small enough to load eagerly.
//
// `cooldownFilter` (optional) is the profile-cooldown gate: profiles that
// are currently cooled or disabled are skipped during credential-map build,
// and within an eligible bucket the most-recently-successful profiles are
// preferred. Falls back to the original "first matching wins" behaviour
// when the filter is omitted (back-compat for tests + bootstrap callsites).
interface AuthStorageCooldownFilter {
  cooldownState: import("../auth/profile-cooldown.js").ProfileStateFile;
  provider: string;
  modelId?: string;
}

interface AuthStorageBuildResult {
  storage: unknown;
  // The profileId that was selected for the active provider, if any. Used
  // by the run lifecycle to update cooldown state on success/failure.
  selectedProfileId?: string;
  // Providers whose active credential is a SUBSCRIPTION login (OAuth, or a
  // setup-token Bearer-authed via its `sk-ant-oat…` value) rather than a
  // pay-per-token API key. Drives the included-tier context clamp so a
  // subscription never spills into pay-as-you-go "extra usage" credits.
  subscriptionProviders: Set<string>;
}

/** True when a resolved credential is a Claude/Codex-style SUBSCRIPTION login
 *  (OAuth, or a setup-token Pi Bearer-auths via its `sk-ant-oat…` value) rather
 *  than a pay-per-token API key. Subscriptions have an included-usage ceiling
 *  plus a separate pay-as-you-go "extra usage" bucket; we must stay inside the
 *  included tier (see `billingSafeContextWindow`). */
function isSubscriptionCredential(cred: unknown): boolean {
  if (!cred || typeof cred !== "object") return false;
  const type = (cred as { type?: unknown }).type;
  if (type === "oauth" || type === "token") return true;
  if (type === "api_key") {
    const key = (cred as { key?: unknown }).key;
    return typeof key === "string" && key.includes("sk-ant-oat");
  }
  return false;
}

function buildAuthStorage(
  authProfilesPath: string,
  cooldownFilter?: AuthStorageCooldownFilter,
  agentId?: string,
): AuthStorageBuildResult {
  const { credentials, selectedProfileId } = readAuthProfilesAsCredentialMap(
    authProfilesPath,
    cooldownFilter,
    agentId,
  );
  const Storage = AuthStorage as unknown as {
    inMemory?: (data?: unknown) => unknown;
    fromStorage?: (storage: unknown) => unknown;
  };
  // If a selected credential is an OAuth/subscription cred, route through the
  // PERSISTENT write-back backend. Anthropic/Codex/Google ROTATE the refresh
  // token on every refresh; `inMemory` keeps the rotated token only for THIS
  // turn, so the next turn re-reads the now-dead on-disk token and 401s (the
  // recurring "login keeps dropping" bug). The persistent backend writes the
  // rotation back to auth-profiles.json mid-turn. Seeded with the cooldown-
  // filtered `credentials` so profile selection is preserved. api_key-only
  // agents keep `inMemory` (unchanged) for cooldown round-robin.
  const hasOAuth = Object.values(credentials).some(
    (c) => !!c && typeof c === "object" && (c as { type?: unknown }).type === "oauth",
  );
  // Which providers are on a subscription login this turn — used to clamp the
  // request size to the included tier so we never draw extra-usage credits.
  const subscriptionProviders = new Set<string>();
  for (const [prov, cred] of Object.entries(credentials)) {
    if (isSubscriptionCredential(cred)) subscriptionProviders.add(prov);
  }
  let storage: unknown;
  if (hasOAuth && agentId && typeof Storage.fromStorage === "function") {
    storage = Storage.fromStorage(persistentAuthBackend(agentId, credentials));
  } else if (typeof Storage.inMemory === "function") {
    storage = Storage.inMemory(credentials);
  } else if (typeof Storage.fromStorage === "function") {
    // Fallback path for Pi minors that removed inMemory.
    storage = Storage.fromStorage({
      withLock<T>(
        update: (current: string) => { result: T; next?: string },
      ): T {
        const { result } = update(JSON.stringify(credentials, null, 2));
        return result;
      },
    });
  } else {
    throw new Error(
      "Pi AuthStorage exposes neither inMemory nor fromStorage; pin to 0.70.x or update brigade.",
    );
  }
  return { storage, selectedProfileId, subscriptionProviders };
}

// Brigade's auth-profiles.json shape matches the Pi SDK contract: profiles
// are keyed by `<provider>:<alias>` and discriminated on `type`. Pi's
// in-memory storage expects the credential map keyed by provider id with
// `{type: "api_key", key}`.
//
// When a `cooldownFilter` is supplied we apply two extra passes:
//
//   1. Eligibility — drop profiles whose entry in profile-state.json is in
//      cooldown / disabled for the active provider+model. If every profile
//      for a provider is cooled, fall back to the soonest-expiry one as a
//      probe (so the run still has a chance to recover instead of hard-
//      failing on "no eligible auth").
//
//   2. Ordering — within the eligible bucket, prefer profiles by
//      `lastUsed`-asc round-robin so we don't keep hitting the same key
//      turn after turn. The first eligible profile per provider wins.
interface ReadCredentialsResult {
  credentials: Record<string, unknown>;
  // Profile id selected for the active provider (if cooldownFilter was
  // supplied). Used downstream to mark cooldown success/failure on the
  // exact profile that ran.
  selectedProfileId?: string;
}

export function readAuthProfilesAsCredentialMap(
  authProfilesPath: string,
  cooldownFilter?: AuthStorageCooldownFilter,
  agentId?: string,
): ReadCredentialsResult {
  // Sync a credential borrowed from the Claude Code CLI before reading: the
  // CLI rotates the shared grant as the operator uses it, so refreshing our
  // stale copy would race the CLI's rotation and kill one of the two logins.
  // Mode-aware + best-effort; no-op without an agentId or for own grants.
  if (agentId) adoptNewerClaudeCliLogin(agentId);
  const out: Record<string, unknown> = {};
  let selectedProfileId: string | undefined;
  let parsed: {
    profiles?: Record<
      string,
      {
        provider?: string;
        type?: string;
        key?: string;
        keyRef?: string | { source?: string; provider?: string; id?: string };
        // oauth / token profiles (subscription login). access/refresh/token may
        // be literal or a secret-ref, mirroring the key/keyRef pair.
        access?: string;
        accessRef?: string | { source?: string; provider?: string; id?: string };
        refresh?: string;
        refreshRef?: string | { source?: string; provider?: string; id?: string };
        expires?: number;
        token?: string;
        tokenRef?: string | { source?: string; provider?: string; id?: string };
        alias?: string;
      }
    >;
  } = {};
  // Convex mode — no auth-profiles.json on disk; the secrets live as sealed
  // columns mirrored into the in-process cache at boot. Route through the
  // mode-aware `readProfiles` choke point so the credential map is populated
  // identically to filesystem mode. Requires the agentId (the path can't be
  // reverse-mapped reliably); falls back to the fs read when it's absent.
  if (agentId && tryGetRuntimeContext()?.mode === "convex") {
    try {
      parsed = readProfiles(agentId) as unknown as typeof parsed;
    } catch {
      parsed = {};
    }
  } else if (fs.existsSync(authProfilesPath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(authProfilesPath, "utf8"));
    } catch {
      // Treat a corrupt profile file the same as a missing one — env fallback
      // below still gets a chance to surface a working key.
      parsed = {};
    }
  }
  // Bucket profiles by provider so we can apply the cooldown ordering before
  // collapsing to "first wins" per provider.
  const byProvider = new Map<
    string,
    { profileId: string; provider: string; resolvedKey: string }[]
  >();
  for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
    if (!profile?.provider) continue;
    // Subscription credentials (OAuth login / setup-token). Pi's AuthStorage
    // handles {type:"oauth"} natively (auto-refresh) and detects an
    // `sk-ant-oat…` value to switch to Bearer auth — so pass these straight
    // through. Single credential per provider (no cooldown pool); first wins
    // and it takes precedence over a stored api key.
    if (profile.type === "oauth" || profile.type === "token") {
      if (out[profile.provider] !== undefined) continue;
      const cred = subscriptionProfileToCredential(profile);
      if (cred) out[profile.provider] = cred;
      continue;
    }
    if (profile.type !== "api_key") continue;
    const resolvedKey = resolveCredentialSecret(
      profile.key,
      profile.keyRef,
      profile.provider,
    );
    if (!resolvedKey) continue;
    const list = byProvider.get(profile.provider) ?? [];
    list.push({ profileId, provider: profile.provider, resolvedKey });
    byProvider.set(profile.provider, list);
  }

  for (const [provider, list] of byProvider) {
    if (out[provider] !== undefined) continue; // a subscription credential won
    if (cooldownFilter && provider === cooldownFilter.provider) {
      const ordered = orderProfilesForSelection({
        state: cooldownFilter.cooldownState,
        provider,
        profileIds: list.map((p) => p.profileId),
        forModel: cooldownFilter.modelId,
      });
      // Pick the first eligible profile (orderProfilesForSelection puts
      // eligibles first, then cooled by soonest-expiry as probes).
      let selected = list.find((p) => p.profileId === ordered[0]);
      // If the cooldown filter excluded everyone, fall back to the first
      // available so the run gets at least one attempt.
      if (!selected) selected = list[0];
      if (selected) {
        out[provider] = { type: "api_key", key: selected.resolvedKey };
        selectedProfileId = selected.profileId;
      }
    } else {
      const first = list[0];
      if (first) out[provider] = { type: "api_key", key: first.resolvedKey };
    }
  }

  // C5: env-fallback. If no profile-stored credential surfaced for a known
  // provider but the user has e.g. `ANTHROPIC_API_KEY` (or the OAuth-token
  // fallback `ANTHROPIC_OAUTH_TOKEN`) exported, surface it so a fresh agent
  // with no auth-profiles.json entry still boots instead of failing with a
  // 401. An OAuth token flows through as an api-key entry — Pi detects the
  // `sk-ant-oat…` shape and switches to Bearer auth itself.
  for (const provider of PROVIDERS) {
    if (provider.noAuth) continue;
    if (out[provider.id] !== undefined) continue;
    const envNames = [provider.envVar, ...(provider.envVarFallbacks ?? [])];
    for (const name of envNames) {
      if (!name) continue;
      const value = process.env[name];
      if (!value) continue;
      out[provider.id] = { type: "api_key", key: value };
      break;
    }
  }

  // Main-agent credential fallback. Org agents (eng-intern-1, ceo, …) have no
  // auth profile of their own and the env fallback is dead in convex mode — so
  // a non-`main` agent would otherwise boot with an empty credential map and
  // fail with "No API key found for <provider>". For any provider STILL missing
  // after its own profiles + env, merge in `main`'s credential. Precedence is
  // preserved: per-agent profile → env → main fallback, so a non-main agent
  // with its OWN explicit key for a provider keeps it (override wins). Mode-
  // agnostic — `readProfilesAsCredentialMapForAgent` routes through the same
  // mode-aware `readProfiles` choke point as the per-agent build above.
  if (agentId && agentId !== DEFAULT_AGENT_ID) {
    const mainCreds = readProfilesAsCredentialMap(DEFAULT_AGENT_ID);
    for (const [provider, cred] of Object.entries(mainCreds)) {
      if (out[provider] !== undefined) continue;
      out[provider] = cred;
    }
  }

  // claude-cli sentinel — the subprocess backend authenticates via the `claude`
  // binary's OWN login, but Pi still demands SOME key for the provider or it
  // throws "No API key for provider: claude-cli" before the transport runs.
  // Seed a non-secret sentinel (never sent on the wire). See auth-bridge for
  // the parallel seam on the gateway boot path.
  if (out[CLAUDE_CLI_PROVIDER] === undefined) {
    out[CLAUDE_CLI_PROVIDER] = { type: "api_key", key: CLAUDE_CLI_SENTINEL_KEY };
  }

  return { credentials: out, selectedProfileId };
}

// Build the resolved provider→credential map for a single agent's stored
// profiles (api_key / oauth / token), WITHOUT cooldown ordering or env / main
// fallback. Used by the non-main credential fallback above to surface `main`'s
// keys for org agents. Routes through the mode-aware `readProfiles` choke point
// so it works identically in filesystem and convex mode.
function readProfilesAsCredentialMap(agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let parsed: {
    profiles?: Record<
      string,
      {
        provider?: string;
        type?: string;
        key?: string;
        keyRef?: string | { source?: string; provider?: string; id?: string };
        access?: string;
        accessRef?: string | { source?: string; provider?: string; id?: string };
        refresh?: string;
        refreshRef?: string | { source?: string; provider?: string; id?: string };
        expires?: number;
        token?: string;
        tokenRef?: string | { source?: string; provider?: string; id?: string };
        alias?: string;
      }
    >;
  } = {};
  try {
    parsed = readProfiles(agentId) as unknown as typeof parsed;
  } catch {
    parsed = {};
  }
  for (const profile of Object.values(parsed.profiles ?? {})) {
    if (!profile?.provider) continue;
    if (out[profile.provider] !== undefined) continue; // first-wins per provider
    if (profile.type === "oauth" || profile.type === "token") {
      const cred = subscriptionProfileToCredential(profile);
      if (cred) out[profile.provider] = cred;
      continue;
    }
    if (profile.type !== "api_key") continue;
    const resolvedKey = resolveCredentialSecret(
      profile.key,
      profile.keyRef,
      profile.provider,
    );
    if (resolvedKey) out[profile.provider] = { type: "api_key", key: resolvedKey };
  }
  return out;
}

// Resolve a profile's api-key secret across both persisted shapes:
//   • literal `key`                       → returned verbatim
//   • string `keyRef` (legacy `${VAR}`)   → env-expanded
//   • object `keyRef` (BrigadeSecretRef)  → env-source resolved by `id`
// File/exec backends need an async resolver and are out of scope for this
// synchronous credential-map build (they surface "no key" → env fallback).
function resolveCredentialSecret(
  key: string | undefined,
  keyRef: string | { source?: string; provider?: string; id?: string } | undefined,
  provider: string,
): string {
  if (key && key.length > 0) return key;
  if (!keyRef) return "";
  if (typeof keyRef === "string") return expandEnvRef(keyRef, provider);
  if (keyRef.source === "env" && keyRef.id) return process.env[keyRef.id] ?? "";
  return "";
}

// Map an OAuth-login / setup-token profile to a Pi credential. OAuth →
// {type:"oauth", access, refresh, expires} (Pi auto-refreshes); token →
// {type:"api_key", key} so Pi's value-based `sk-ant-oat` Bearer detection
// fires. Returns null when no secret resolves.
function subscriptionProfileToCredential(profile: {
  provider?: string;
  type?: string;
  access?: string;
  accessRef?: string | { source?: string; provider?: string; id?: string };
  refresh?: string;
  refreshRef?: string | { source?: string; provider?: string; id?: string };
  expires?: number;
  token?: string;
  tokenRef?: string | { source?: string; provider?: string; id?: string };
  metadata?: Record<string, unknown>;
}): Record<string, unknown> | null {
  const provider = profile.provider ?? "";
  if (profile.type === "oauth") {
    const access = resolveCredentialSecret(profile.access, profile.accessRef, provider);
    if (!access) return null;
    const refresh = resolveCredentialSecret(profile.refresh, profile.refreshRef, provider);
    // A durable oauth profile CAN lack `expires` (the Claude/Codex CLI-login
    // path). Coerce a missing/garbage value to 0 so Pi treats the access token
    // as expired and refreshes via the refresh token immediately. Spread
    // `metadata` FIRST so the known oauth fields always win — it carries the
    // extras (Copilot enterprise refresh + availableModelIds) Pi needs.
    const expires =
      typeof profile.expires === "number" && Number.isFinite(profile.expires)
        ? profile.expires
        : 0;
    return {
      ...(profile.metadata && typeof profile.metadata === "object" ? profile.metadata : {}),
      type: "oauth",
      access,
      refresh: refresh || undefined,
      expires,
    };
  }
  if (profile.type === "token") {
    const token = resolveCredentialSecret(profile.token, profile.tokenRef, provider);
    if (!token) return null;
    return { type: "api_key", key: token };
  }
  return null;
}

const ENV_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

// Resolve a literal-or-${VAR} secret. If the value is a `${VAR}` reference
// and the env var isn't set, log a warning to stderr so the user gets a
// breadcrumb pointing at the missing env var instead of a downstream
// "no API key found" from Pi with no context about *why*.
function expandEnvRef(value: string, provider: string): string {
  const m = ENV_REF_PATTERN.exec(value);
  if (!m || !m[1]) return value;
  const resolved = process.env[m[1]] ?? "";
  if (!resolved) {
    console.error(
      `brigade: auth profile for ${provider} references ${value} ` +
        `but the env var isn't set; the profile will be skipped.`,
    );
  }
  return resolved;
}

function buildModelRegistry(authStorage: unknown, modelsFile: string): unknown {
  const Registry = ModelRegistry as unknown as {
    create?: (authStorage: unknown, modelsFile: string) => unknown;
    new (authStorage: unknown, modelsFile: string): unknown;
  };
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelsFile);
  }
  return new Registry(authStorage, modelsFile);
}

/**
 * Read the resolved Pi `Model.input` (`("text"|"image")[]`) to decide whether
 * the active turn model can consume an IMAGE content block. Returns `true` /
 * `false` when the model object carries an `input` array, or `undefined` when
 * the shape is unknown (so `analyze_media` falls back to its id heuristic
 * instead of asserting a wrong answer). Defensive: `model` is typed `unknown`
 * here because the never-miss resolver returns a loose object. Exported for a
 * focused unit test.
 */
export function modelSupportsImageInput(model: unknown): boolean | undefined {
  const input = (model as { input?: unknown } | null | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  return input.includes("image");
}

/**
 * A3 gate — decide whether inbound IMAGE blocks ride this turn's `prompt(...)`
 * as a multimodal user message. Returns the `{ images }` options object for
 * `session.prompt(text, opts)` ONLY when BOTH:
 *   1. the resolved model is vision-capable (`modelSupportsImageInput === true`
 *      — an authoritative `Model.input` read; `undefined`/`false` → text-only),
 *   2. at least one inbound image block was threaded in.
 * Otherwise returns `undefined`, so the caller sends the plain string prompt —
 * byte-identical to the historical path (no-image turns, text-only models, and
 * every TUI / cron / sub-agent / RPC turn, which never set `images`).
 *
 * Maps the wire shape (`{ data, mimeType }`) to Pi's `ImageContent`
 * (`{ type:"image", data, mimeType }`) — the SAME block `analyze_media` returns
 * and `payload-mutators.ts` prunes from history. Pure + exported for unit tests.
 */
export function resolveInboundImagePrompt(
  model: unknown,
  images: ReadonlyArray<{ data: string; mimeType: string }> | undefined,
): { images: Array<{ type: "image"; data: string; mimeType: string }> } | undefined {
  if (!images || images.length === 0) return undefined;
  if (modelSupportsImageInput(model) !== true) return undefined;
  return {
    images: images.map((b) => ({ type: "image" as const, data: b.data, mimeType: b.mimeType })),
  };
}

// Both flags must clear for the turn to be considered done. prompt() is
// supposed to resolve only after settle, so this loop almost always exits
// on the first iteration. The 30s budget guards against the pathological
// case where Pi enters an unbounded compaction or a streaming hang we'd
// otherwise wait on forever.
const STREAM_SETTLE_BUDGET_MS = 30_000;
const STREAM_SETTLE_POLL_MS = 50;

async function waitForStreamSettled(session: AgentSession): Promise<void> {
  const deadline = Date.now() + STREAM_SETTLE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!session.isStreaming && !session.isCompacting) return;
    await sleep(STREAM_SETTLE_POLL_MS);
  }
  throw new Error(
    `Turn did not settle within ${STREAM_SETTLE_BUDGET_MS / 1000}s ` +
      `(isStreaming=${session.isStreaming} isCompacting=${session.isCompacting}). ` +
      `Likely a hung provider connection — abort the run and retry.`,
  );
}

// Surface a provider/transport failure that Pi reports as DATA rather than a
// thrown exception.
//
// Pi emits provider/transport failures as a SETTLED assistant message
// with `stopReason: "error"` and an `errorMessage` — not an exception,
// and not an intentionally-empty reply. A failover layer can inspect
// `stopReason`/`errorMessage` to decide retry → rotate → fallback-model
// → surface.
//
// Brigade reaches the same outcome through its existing throw-based machinery:
// we convert that error-as-data into a thrown error carrying the cleaned
// provider message, so it flows into `error-classifier` → `runWithRetry`
// (transient like rate_limit/overloaded/timeout → retried) and, in the
// resilient path, `runWithModelFallback` (→ failover to the next model);
// a permanent failure (model_not_found / auth) is surfaced to the caller
// instead of being mistaken for a content-quality "empty" and returning blank.
// `"aborted"` is user-initiated (Ctrl-C / disconnect) and is left alone.
function assertNoProviderErrorStop(session: AgentSession): void {
  const messages = session.messages as Array<{
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (m.stopReason === "error") {
      const raw = m.errorMessage?.trim();
      // cleanProviderError peels the provider's JSON error blob down to
      // its human-readable message so the classifier matches on real
      // text and the user sees a readable line, not a raw payload.
      throw new Error(
        raw
          ? cleanProviderError(raw)
          : "the model returned an error with no detail (the provider request failed before producing any output)",
      );
    }
    // Most recent assistant message settled normally — nothing to surface.
    return;
  }
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    return flattenAssistantContent(m.content);
  }
  return "";
}

// Concatenate the text of every assistant message from `fromIndex` forward.
// Used by the max_tokens continuation path: a capped reply driven across N
// continuations lands as N separate assistant messages (each prompt() runs a
// fresh agent loop that pushes a new message), so the complete answer is the
// JOIN of those segments — not the last one. flattenAssistantContent already
// keeps only text blocks, so interleaved tool_use blocks don't pollute the
// concatenation. Segments are joined with a blank line so a hard wrap between
// two segments doesn't fuse the last word of one onto the first of the next.
function joinAssistantTextFrom(session: AgentSession, fromIndex: number): string {
  const messages = session.messages;
  const start = Math.max(0, fromIndex);
  const parts: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    const text = flattenAssistantContent(m.content);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n\n");
}

export function flattenAssistantContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resilient turn — runSingleTurn with multi-model fallback.
//
// Public path callers (gateway, future TUI streaming layer) opt into this
// when they have a configured fallback chain. If the primary candidate
// fails for any non-format / non-session_expired reason, the next candidate
// is tried with a fresh session+auth set. Same-model retries still happen
// inside runSingleTurn's runWithRetry; this layer rotates ACROSS models.
//
// The CLI's `brigade agent` command keeps using runSingleTurn directly
// because most users don't have multiple-model setups. Callers that want
// fallback declare it explicitly via this entry.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunResilientTurnArgs extends RunSingleTurnArgs {
  // Ordered fallback candidates. If the primary fails non-fatally, each
  // is tried in turn. Empty array → behaves identically to runSingleTurn.
  fallbacks?: Array<{ provider: string; modelId: string }>;
}

export async function runResilientTurn(args: RunResilientTurnArgs): Promise<RunSingleTurnResult> {
  const fallbacks = args.fallbacks ?? [];
  if (fallbacks.length === 0) {
    return runSingleTurn(args);
  }

  // Lift the run inside runWithModelFallback's `attempt` callback. Each
  // candidate gets its own runSingleTurn invocation — fresh session, fresh
  // credential map, fresh stream wrappers. The cost is one extra session
  // open per failed candidate, which is fine since fallbacks are rare.
  const fallbackResult = await runWithModelFallback({
    primary: { provider: args.provider, model: args.modelId, isPrimary: true },
    fallbacks: fallbacks.map((f) => ({
      provider: f.provider,
      model: f.modelId,
      isPrimary: false,
    })),
    signal: args.signal,
    attempt: async (candidate: ModelCandidate, signal?: AbortSignal) => {
      const r = await runSingleTurn({
        ...args,
        provider: candidate.provider,
        modelId: candidate.model,
        signal,
      });
      return r;
    },
  });

  return {
    ...fallbackResult.result,
    servedBy: {
      provider: fallbackResult.candidate.provider,
      modelId: fallbackResult.candidate.model,
    },
    fallbackAttempts: fallbackResult.attempts.map((a: FallbackAttempt) => ({
      provider: a.provider,
      modelId: a.model,
      reason: a.reason,
      error: a.errorSummary,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction trigger.
//
// Estimate whether context usage has crossed the 85% trigger threshold and,
// if so, ask Pi to compact NOW rather than discovering mid-turn that we've
// blown the window. The estimator walks the session messages and divides
// total stringified char-count by 4 (rough chars-per-token across modern
// tokenizers). Imprecise but conservative — over-compacting is cheaper
// than running out of context.
//
// Pi's auto-compaction handles the actual fallback if the request exceeds
// the window despite this pre-emptive check; this module's value is in
// avoiding the "we're streaming and it failed" failure mode by compacting
// at a calm boundary instead.
// ─────────────────────────────────────────────────────────────────────────────

const APPROX_CHARS_PER_TOKEN = 4;

async function maybeTriggerCompaction(args: {
  session: AgentSession;
  model: { contextWindow?: number } | unknown;
  agentId: string;
  sessionId: string;
  /** Turn's memory origin — when set, the about-to-be-compacted history is distilled
   *  first (pre-compaction extraction). Undefined for an unidentified peer → skip. */
  origin?: MemoryRecordOrigin;
  /** The pinned persona/system prompt. It lives in state.systemPrompt (a field
   *  Pi reads at request time), NOT in session.messages, yet it consumes window
   *  on every request — so it MUST be in the estimate or the trigger fires late.
   *  Empty/undefined contributes nothing. */
  systemPrompt?: string;
  /** The user message about to be sent this turn (prompt() runs AFTER this
   *  check), folded in so the estimate reflects the true pre-prompt fill. */
  incomingMessage?: string;
}): Promise<void> {
  const contextWindow = (args.model as { contextWindow?: number })?.contextWindow;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    // No context window metadata — skip; Pi's auto-compaction is the
    // fallback if usage actually overflows.
    return;
  }
  // Estimate the FULL request: the transcript PLUS the pinned system prompt
  // PLUS the about-to-be-sent user message. The latter two are absent from
  // session.messages but present on every request, so folding them in keeps
  // the 0.85 trigger from firing systematically late (and falling through to
  // Pi's mid-stream auto-compaction). Same chars/APPROX_CHARS_PER_TOKEN
  // heuristic estimateUsageTokens uses, so the units line up.
  const prePromptChars =
    (args.systemPrompt?.length ?? 0) + (args.incomingMessage?.length ?? 0);
  const estimatedTokens =
    estimateUsageTokens(args.session.messages) +
    Math.ceil(prePromptChars / APPROX_CHARS_PER_TOKEN);
  const decision = evaluateCompactionDecision({
    contextWindowTokens: contextWindow,
    estimatedUsageTokens: estimatedTokens,
  });
  if (!decision.shouldRecommendCompaction) {
    log.debug("compaction not needed", {
      agentId: args.agentId,
      sessionId: args.sessionId,
      estimatedTokens,
      contextWindow,
      reason: decision.reason,
    });
    return;
  }
  log.info("triggering pre-emptive compaction", {
    agentId: args.agentId,
    sessionId: args.sessionId,
    estimatedTokens,
    contextWindow,
    promptBudgetTokens: decision.promptBudgetTokens,
    reason: decision.reason,
  });
  try {
    const compactor = (args.session as AgentSession & {
      compact?: (instructions?: string) => Promise<unknown>;
    }).compact;
    if (typeof compactor !== "function") {
      log.warn("session has no compact() method — skipping", {
        sessionId: args.sessionId,
      });
      return;
    }
    // PRE-COMPACTION extraction — distil the about-to-be-replaced history NOW so a
    // fact living ONLY in these turns isn't lost when compact() swaps them for a
    // summary. Fire-and-forget over a SNAPSHOT (no turn latency, no race with the
    // replace). Skipped when origin is undefined (unidentified peer → fail closed).
    if (args.origin) {
      runPreCompactionExtraction({
        agentId: args.agentId,
        sessionId: args.sessionId,
        messages: [...args.session.messages],
        origin: args.origin,
      });
    }
    await compactor.call(args.session);
    log.info("pre-emptive compaction completed", {
      agentId: args.agentId,
      sessionId: args.sessionId,
    });
  } catch (err) {
    // Compaction failure isn't fatal — Pi's auto-compaction gets a chance
    // to run during the prompt, and worst case the request fails with a
    // context-window error that the retry policy classifies as transient.
    log.warn("pre-emptive compaction failed; proceeding anyway", {
      agentId: args.agentId,
      sessionId: args.sessionId,
      error: (err as Error).message,
    });
  }
}

function estimateUsageTokens(messages: unknown[]): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (!m) continue;
    chars += approxMessageChars(m);
  }
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

// Detect whether the most-recent assistant message ended on a max_tokens
// stop reason. We check both the assistant message's `stopReason` field
// (Pi's normalised key) and the raw `stop_reason` (provider passthrough)
// because not all Pi minors normalise consistently.
function detectMaxTokensStop(session: AgentSession): boolean {
  const messages = session.messages as unknown as Array<{
    role?: string;
    stopReason?: string;
    stop_reason?: string;
  }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const reason = (m.stopReason ?? m.stop_reason ?? "").toLowerCase();
    // Pi normalises an output-cap stop to "length" (its canonical StopReason);
    // "max_tokens" is the raw provider passthrough some minors leave unnormalised.
    // Checking only "max_tokens" meant this NEVER fired (Pi always emits "length"),
    // so the continuation loop was dead for every provider — including Ollama's
    // num_predict cap (done_reason:"length"). Accept both.
    return reason === "length" || reason === "max_tokens";
  }
  return false;
}

function approxMessageChars(message: unknown): number {
  if (typeof message === "string") return message.length;
  if (!message || typeof message !== "object") return 0;
  const m = message as { content?: unknown };
  const content = m.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (typeof block === "string") {
      total += block.length;
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as { text?: unknown; content?: unknown; input?: unknown };
    if (typeof b.text === "string") total += b.text.length;
    if (typeof b.content === "string") total += b.content.length;
    if (b.input !== undefined) {
      try {
        total += JSON.stringify(b.input).length;
      } catch {
        // ignore unserialisable
      }
    }
  }
  return total;
}
