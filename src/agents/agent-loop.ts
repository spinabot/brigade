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
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";

import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAuthProfilesPath,
  resolveModelsPath,
} from "../config/paths.js";
import {
  defaultSessionKey,
  resolveOrCreateSession,
} from "../sessions/session-store.js";
import { readConfigOrInit } from "../config/io.js";
import { assembleSystemPrompt } from "../system-prompt/assembler.js";
import {
  loadHeartbeatFile,
  loadWorkspaceContextFiles,
} from "../system-prompt/workspace-loader.js";
import { resolveSystemPromptOverride } from "../system-prompt/override.js";
import { resolveRuntimeParams } from "../system-prompt/runtime-params.js";
import { applyPersonaOverrideToSession } from "../system-prompt/pi-injection.js";
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
import { buildBrigadeTransformContext } from "./payload-mutators.js";
import { repairSessionFileIfNeeded } from "../sessions/session-file-repair.js";
import { acquireSessionWriteLock } from "../sessions/session-write-lock.js";
import { type BrigadeBeforeToolCallHook, makeUnknownToolGuard } from "./tool-guard.js";
import { makeWorkspaceJailGuard } from "./workspace-jail.js";
import { runWithContentQualityRetry, type ContentQualityIssue } from "./content-quality-retry.js";
import { runWithThinkingFallback } from "./thinking-fallback.js";
import { evaluateCompactionDecision } from "./smart-compaction.js";
import { resolveToolSummary } from "./tool-summaries.js";
import {
  runWithModelFallback,
  type ModelCandidate,
  type FallbackAttempt,
} from "./model-fallback.js";
import {
  clearExpiredCooldowns,
  loadProfileState,
  markProfileFailure,
  markProfileSuccess,
} from "../auth/profile-cooldown.js";
import { orderProfilesForSelection } from "../auth/profile-cooldown.js";
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

function resolveIdleTimeoutMs(): number {
  const raw = process.env.BRIGADE_LLM_IDLE_TIMEOUT_SECONDS?.trim();
  if (!raw) return DEFAULT_LLM_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LLM_IDLE_TIMEOUT_MS;
  return Math.floor(n * 1000);
}

export interface RunSingleTurnArgs {
  agentId: string;
  provider: string;
  modelId: string;
  message: string;
  sessionKey?: string;
  // Override the agent's workspace dir (where persona/SOUL/USER files live).
  // Defaults to <agentDir>/workspace via paths.ts.
  workspaceDir?: string;
  // The cwd Pi tools (read/bash/write/etc.) operate in. Defaults to the
  // current process cwd so `brigade agent -m "…"` from any directory does
  // what the user expects. Distinct from workspaceDir, which scopes
  // *persona files* — those live with the agent, not with the project.
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
  const cwd = args.cwd ?? process.cwd();
  const modelsFile = resolveModelsPath(agentId);
  const authProfilesPath = resolveAuthProfilesPath(agentId);

  const resolved = resolveOrCreateSession({
    agentId,
    sessionKey,
    overrides: { provider: args.provider, modelId: args.modelId },
  });

  // Profile cooldown gate. The on-disk profile-state.json tracks per-profile
  // failure history, cooldown windows, and disabled-until timestamps. We
  // sweep expired windows up-front so a profile that was rate-limited an
  // hour ago is eligible again now, then pass the eligibility filter to
  // the credential-map builder so cooled profiles don't get handed to Pi.
  let cooldownState = loadProfileState(agentId);
  cooldownState = clearExpiredCooldowns(cooldownState);
  const authBuild = buildAuthStorage(authProfilesPath, {
    cooldownState,
    provider: args.provider,
    modelId: args.modelId,
  });
  const authStorage = authBuild.storage;
  const selectedProfileId = authBuild.selectedProfileId;
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
        "Pin `@mariozechner/pi-coding-agent` to a known-compatible version, or " +
        "update brigade's agent-loop to match the new Pi API.",
    );
  }
  const model = registryAsFinder.find(args.provider, args.modelId);
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
      model,
    });
  } finally {
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
  model: unknown;
}

async function runSingleTurnLocked(p: RunSingleTurnLockedArgs): Promise<RunSingleTurnResult> {
  const { args, agentId, agentDir, cwd, workspaceDir, resolved, model, authStorage, modelRegistry } = p;
  let cooldownState = p.cooldownState;
  const selectedProfileId = p.selectedProfileId;

  // SessionManager.open creates the JSONL on first write; passing the
  // canonical transcript path keeps Pi and brigade aligned on filenames.
  const sessionManager = SessionManager.open(resolved.transcriptPath);

  // Anthropic models are the only family today that enforce a hard
  // cache_control breakpoint cap (Anthropic accepts ≤4). Run the sweep
  // unconditionally — it's a safe no-op for non-Anthropic providers because
  // their messages don't carry cache_control blocks. The scrubber pass
  // (refusal sentinel) always runs.
  const transformContext = buildBrigadeTransformContext(
    {
      applyAnthropicSweep:
        args.provider === "anthropic" || args.provider.startsWith("anthropic"),
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

  // Pi's `tools` field is an ALLOWLIST OF NAMES (string[]), not Tool
  // objects — `customTools` is the slot for Tool objects. The earlier
  // smoke run hit exactly this bug: we passed Tool objects into `tools`,
  // Pi treated each Tool object as a tool-name string, none matched any
  // real tool, and the model correctly said "I have no file access."
  //
  // Naming the seven coding tools explicitly (vs omitting `tools` entirely
  // and letting Pi default to its 4 base tools) gives us the full surface
  // including grep / find / ls — closer to what OpenClaw exposes. The cwd
  // is the agent run's cwd, NOT the agent state dir, so tools operate on
  // the user's actual workspace.
  const enabledToolNames: string[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: model as never,
    thinkingLevel: args.thinkingLevel ?? "off",
    tools: enabledToolNames,
    customTools: [],
    sessionManager,
    resourceLoader: new DefaultResourceLoader({ cwd, agentDir }),
    transformContext,
  } as never);

  if (!session) {
    throw new Error("Pi createAgentSession returned no session.");
  }

  // Install the composed beforeToolCall guard. Two layers run in order:
  //
  //   1. UNKNOWN-TOOL GUARD (`makeUnknownToolGuard`) — name validation:
  //      tool not in `enabledToolNames`, whitespace-wrapped names, empty
  //      args for a tool that needs them. If this blocks, we stop here.
  //
  //   2. WORKSPACE-JAIL GUARD (`makeWorkspaceJailGuard`) — argument
  //      validation for path-mutating tools (`write`, `edit`) plus a
  //      blanket refusal for `bash` until Primitive #3 ships exec policy.
  //      Resolves relative paths against the agent's WORKSPACE root (not
  //      process cwd), so `write({path: "USER.md"})` lands at
  //      `<workspace>/USER.md` — what BOOTSTRAP.md tells the model to do.
  //      Without this, gpt-5.4 wrote USER.md to the cwd (the Brigade
  //      source tree), creating an orphan file that never feeds back into
  //      the persona loop.
  //
  // Pi turns either guard's `block: true` return into a synthetic
  // tool_result the model sees inline, so the next turn can self-correct.
  const sessionWithBeforeHook = session as AgentSession & {
    agent?: {
      beforeToolCall?: BrigadeBeforeToolCallHook;
    };
  };
  if (sessionWithBeforeHook.agent) {
    const nameGuard = makeUnknownToolGuard(enabledToolNames);
    // Pass cwd so the jail validates the path Pi will ACTUALLY resolve
    // to (Pi resolves relative paths against this cwd, not the workspace).
    const jailGuard = makeWorkspaceJailGuard(workspaceDir, cwd);
    sessionWithBeforeHook.agent.beforeToolCall = async (ctx, signal) => {
      const named = await nameGuard(ctx, signal);
      if (named?.block) return named;
      return jailGuard(ctx, signal);
    };
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
    const idleTimeoutMs = resolveIdleTimeoutMs();
    sessionAgent.streamFn = wrapStreamFnWithIdleTimeout(
      wrapStreamFnWithStopReasonRecovery(
        wrapStreamFnWithToolCallRepair(baseStreamFn),
      ),
      { timeoutMs: idleTimeoutMs },
    );
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
  const sessionAlreadyHasBootstrap = await hasDeliveredBootstrapToSession(
    resolved.transcriptPath,
  );
  // The assembler should only emit the synthetic first-turn nudge when
  // BOTH conditions hold: workspace says first-turn AND this session
  // hasn't received the bootstrap context yet. This is what stops the
  // nudge from re-firing on every continuing-session turn just because
  // BOOTSTRAP.md still happens to be on disk.
  const effectivePhase: BootstrapPhase =
    phaseBefore === "first-turn" && sessionAlreadyHasBootstrap
      ? "in-progress"
      : phaseBefore;

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
      : enabledToolNames
  ).slice();
  const toolDescriptions = activeToolNames.map((name) => ({
    name,
    summary: resolveToolSummary(name) ?? "",
  }));

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
  });
  if (personaPrompt) {
    applyPersonaOverrideToSession(session as AgentSession, personaPrompt);
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
  const scrubbedMessage = scrubAnthropicRefusalSentinel(args.message);
  log.info("turn starting", {
    agentId,
    sessionId: resolved.sessionId,
    isNewSession: resolved.isNew,
    provider: args.provider,
    model: args.modelId,
    bootstrapPhase: effectivePhase,
  });

  // Pre-emptive compaction. When estimated context usage crosses the
  // 85% threshold, ask Pi to compact NOW rather than rolling into the
  // turn and discovering mid-flight that we've blown the window. The
  // estimator is rough (chars/4) but conservative — better to compact
  // a turn early than fail mid-stream.
  await maybeTriggerCompaction({
    session: session as AgentSession,
    model: model as { contextWindow?: number } | unknown,
    agentId,
    sessionId: resolved.sessionId,
  });

  await runWithRetry({
    ctx: { provider: args.provider, model: args.modelId },
    signal: args.signal,
    onAttemptFailed: (info) => {
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
      if (info.willRetry) log.warn("turn attempt failed, retrying", fields);
      else log.error("turn attempt failed, surfacing", fields);
      // Update the on-disk cooldown state so this profile rotates out on
      // the next run if its failure category warrants a cooldown. Skipped
      // when no profile id was tracked (single-profile fallback path).
      if (selectedProfileId) {
        cooldownState = markProfileFailure({
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
              await (session as AgentSession).prompt(scrubbedMessage);
              // Defensive settle wait. prompt() should already have settled
              // the run, but if Pi adds queued steers or background
              // compactions in a future minor, this catches the late activity.
              await waitForStreamSettled(session as AgentSession);
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
              },
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
    await runWithRetry({
      ctx: { provider: args.provider, model: args.modelId },
      signal: args.signal,
      attempt: async () => {
        await (session as AgentSession).prompt(
          "Please continue your previous response from where you left off. Don't repeat what you've already said.",
        );
        await waitForStreamSettled(session as AgentSession);
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
  // next run prefers it again under the round-robin order.
  if (selectedProfileId) {
    cooldownState = markProfileSuccess({
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

  const reply = extractLastAssistantText(session as AgentSession);

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
  capabilities?: { memory?: boolean; skills?: boolean; subAgents?: boolean };
  /**
   * Per-turn-only suffix pinned BELOW the cache boundary so it never busts
   * the cached prefix. Used by sub-agent task framing in Primitive #6.
   */
  ephemeralSuffix?: string;
}): Promise<string> {
  const config = readConfigOrInit();
  const override = resolveSystemPromptOverride({ config, agentId: args.agentId });
  if (override) return override;

  const personaFiles = await loadWorkspaceContextFiles(args.workspaceDir);
  const heartbeatFile = await loadHeartbeatFile(args.workspaceDir);
  if (personaFiles.length === 0 && !heartbeatFile) return "";

  const runtime = resolveRuntimeParams({
    agentId: args.agentId,
    workspaceDir: args.workspaceDir,
    cwd: args.cwd,
    modelLabel: args.modelLabel,
    thinkingLevel: args.thinkingLevel,
  });

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
    ephemeralSuffix: args.ephemeralSuffix,
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
}

function buildAuthStorage(
  authProfilesPath: string,
  cooldownFilter?: AuthStorageCooldownFilter,
): AuthStorageBuildResult {
  const { credentials, selectedProfileId } = readAuthProfilesAsCredentialMap(
    authProfilesPath,
    cooldownFilter,
  );
  const Storage = AuthStorage as unknown as {
    inMemory?: (data?: unknown) => unknown;
    fromStorage?: (storage: unknown) => unknown;
  };
  let storage: unknown;
  if (typeof Storage.inMemory === "function") {
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
  return { storage, selectedProfileId };
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

function readAuthProfilesAsCredentialMap(
  authProfilesPath: string,
  cooldownFilter?: AuthStorageCooldownFilter,
): ReadCredentialsResult {
  if (!fs.existsSync(authProfilesPath)) return { credentials: {} };
  let parsed: {
    profiles?: Record<
      string,
      { provider?: string; type?: string; key?: string; keyRef?: string; alias?: string }
    >;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(authProfilesPath, "utf8"));
  } catch {
    return { credentials: {} };
  }
  const out: Record<string, unknown> = {};
  let selectedProfileId: string | undefined;
  // Bucket profiles by provider so we can apply the cooldown ordering before
  // collapsing to "first wins" per provider.
  const byProvider = new Map<
    string,
    { profileId: string; provider: string; resolvedKey: string }[]
  >();
  for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
    if (!profile?.provider || profile.type !== "api_key") continue;
    const literal = profile.key ?? profile.keyRef ?? "";
    const resolvedKey = expandEnvRef(literal, profile.provider);
    if (!resolvedKey) continue;
    const list = byProvider.get(profile.provider) ?? [];
    list.push({ profileId, provider: profile.provider, resolvedKey });
    byProvider.set(profile.provider, list);
  }

  for (const [provider, list] of byProvider) {
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
  return { credentials: out, selectedProfileId };
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

function extractLastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    return flattenAssistantContent(m.content);
  }
  return "";
}

function flattenAssistantContent(content: unknown): string {
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
}): Promise<void> {
  const contextWindow = (args.model as { contextWindow?: number })?.contextWindow;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    // No context window metadata — skip; Pi's auto-compaction is the
    // fallback if usage actually overflows.
    return;
  }
  const estimatedTokens = estimateUsageTokens(args.session.messages);
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
    return reason === "max_tokens";
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
