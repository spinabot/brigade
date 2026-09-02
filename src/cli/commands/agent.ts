import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Command } from "commander";

import { runSingleTurn } from "../../agents/agent-loop.js";
import type { SlopFile } from "../../agents/quality/slop-index.js";
import {
  parseSlashCommand,
  SLASH_COMMAND_HELP,
} from "../../agents/slash-commands.js";
import { readConfigOrInit } from "../../config/io.js";
import { DEFAULT_AGENT_ID, resolveAllPaths } from "../../config/paths.js";
import {
  defaultSessionKey,
  pinSessionModel,
  readSessionModelPin,
  readSessionStore,
  writeSessionStore,
} from "../../sessions/session-store.js";

interface AgentOptions {
  agentId: string;
  message?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspace?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Drive the message as an AUTONOMOUS task across multiple turns until the
   *  agent emits the completion marker or a guard fires. */
  autonomous?: boolean;
  /** Autonomous turn cap (the runaway bound). Default 25. */
  maxIterations?: number;
}

export function registerAgentCommand(program: Command): void {
  program
    .command("agent")
    .description("Drive a single turn through the agent pipeline")
    .option("--agent-id <id>", "agent id", DEFAULT_AGENT_ID)
    .option("-m, --message <text>", "user message to send")
    .option("--session-key <key>", "session key (default: agent:<id>:main)")
    .option("--provider <name>", "provider id (e.g. anthropic, openrouter, ollama)")
    .option("--model <id>", "model id (e.g. claude-sonnet-4-6)")
    .option("--workspace <dir>", "override workspace directory")
    .option(
      "--thinking-level <level>",
      "off | low | medium | high (model-dependent)",
      "off",
    )
    .option("--autonomous", "drive the message as a task across multiple turns until done or a limit")
    .option("--max-iterations <n>", "autonomous turn cap (default 25)", (v) => Number.parseInt(v, 10))
    .action(async (raw: AgentOptions) => {
      await runAgentTurn(raw);
    });
}

export async function runAgentTurn(opts: AgentOptions): Promise<void> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const sessionKey = opts.sessionKey ?? defaultSessionKey(agentId);
  const paths = resolveAllPaths(agentId, opts.workspace);

  // Validation errors throw rather than `process.exitCode = 1; return`.
  // entry.ts unconditionally calls process.exit(returnedCode) and would
  // mask exitCode=1 set on the global object — throwing routes through
  // run-main's mapErrorToExitCode and produces the right non-zero exit.
  if (!opts.message || opts.message.length === 0) {
    throw new Error("agent: --message is required.");
  }

  // Slash-command intercept. Runs BEFORE provider/model resolution because a
  // `/model X` invocation can REPLACE the resolved provider/model for THIS
  // turn, and a `/reset` simply forgets the session and exits.
  //
  // Slash commands fire locally — they don't reach the model. The user gets
  // a one-line confirmation on stderr and (for `/model`) we also persist
  // the new override to sessions.json so the NEXT user message goes to the
  // requested model without needing the flag.
  const slash = parseSlashCommand(opts.message);
  let messageForAgent = opts.message;
  let thinkingOverride: "off" | "low" | "medium" | "high" | undefined;
  switch (slash.type) {
    case "passthrough":
      messageForAgent = slash.message;
      break;
    case "model":
      // Persist the switch to sessions.json so the NEXT `brigade agent` turn
      // picks it up automatically. We do NOT also drive a model call this
      // turn — that would burn tokens on a confirmation message no one asked
      // for. A local stdout note + exit is the honest UX.
      persistSessionModel({
        agentId,
        sessionKey,
        provider: slash.provider,
        modelId: slash.modelId,
      });
      console.error(
        `[brigade] /model: session ${sessionKey} switched to ${slash.provider}/${slash.modelId} — active on the next turn`,
      );
      return;
    case "thinking":
      thinkingOverride = slash.level;
      // /thinking on its own line just sets the level for this run. If the
      // user wanted to combine it with a real prompt, they'd have multi-line
      // input — we treat that as not-yet-supported and require an explicit
      // message. Print a note and exit cleanly.
      console.error(`[brigade] /thinking: level set to '${slash.level}' for the next turn`);
      return;
    case "reset":
      console.error(
        `[brigade] /reset: forgetting session ${sessionKey} — the next turn will start fresh`,
      );
      resetSession({ agentId, sessionKey });
      return;
    case "help":
      console.error(`[brigade] available slash commands:`);
      for (const entry of SLASH_COMMAND_HELP) {
        console.error(`  ${entry.command.padEnd(34)} ${entry.description}`);
      }
      return;
    case "error":
      throw new Error(`agent: ${slash.message}`);
  }

  // Provider/model resolution order:
  //   1. CLI flag (`--provider` / `--model`) — explicit user intent for this run.
  //   2. Persisted session PIN — set by a prior `/model X` command. Read from
  //      `pinnedProvider`/`pinnedModelId`, never from `provider`/`modelId`:
  //      the latter are stamped with the serving model on EVERY turn, so
  //      reading them here froze each session to its first turn's model and
  //      made a later change to the agent default a silent no-op.
  //   3. Per-agent legacy slot (`agents.<id>.defaultProvider/defaultModel`)
  //      — kept for back-compat with pre-wizard configs.
  //   4. Onboard-wizard defaults (`agents.defaults.{provider, model.primary}`)
  //      — the canonical onboarding output post-2026-05.
  // The /model command short-circuits the run before reaching here, so by
  // this point the persisted override applies to the user's NEXT real
  // message, not the one carrying the slash command.
  const cfg = readConfigOrInit();
  const agentCfg = cfg.agents?.[agentId] as
    | { defaultProvider?: string; defaultModel?: string }
    | undefined;
  const wizardDefaults = cfg.agents?.defaults as
    | { provider?: string; model?: { primary?: string } }
    | undefined;
  const sessionPin = readSessionModelPin(agentId, sessionKey);
  const provider =
    opts.provider ??
    sessionPin?.provider ??
    agentCfg?.defaultProvider ??
    wizardDefaults?.provider;
  const modelId =
    opts.model ??
    sessionPin?.modelId ??
    agentCfg?.defaultModel ??
    wizardDefaults?.model?.primary;

  if (!provider || !modelId) {
    throw new Error(
      "agent: --provider and --model are required " +
        "(or run `brigade onboard --provider X --api-key Y --model Z` to persist defaults).",
    );
  }

  console.error(
    `[brigade] agent=${agentId} provider=${provider} model=${modelId} ` +
      `sessionKey=${sessionKey} state=${paths.stateDir}`,
  );

  // Ctrl-C / kill propagates as an AbortSignal into the agent loop. The
  // first SIGINT requests a graceful abort (drains in-flight retries);
  // a second SIGINT within the same process tears the run down hard
  // by exiting with 130 (the conventional shell signal-code).
  const abortController = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      console.error("\n[brigade] interrupt received — aborting run gracefully (Ctrl-C again to force exit)");
      abortController.abort(new Error("Interrupted by user"));
      return;
    }
    console.error("\n[brigade] forced exit on second interrupt");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  // ── Autonomous mode: drive the task across MULTIPLE turns under the loop
  // guards until the agent emits the completion marker (or doneChecks/guards
  // fire). The SAME sessionKey each turn carries the conversation + tool
  // results forward; the done-model is the loop-runner's (marker / objective
  // checks / max-iterations). Ctrl-C aborts via the shared signal.
  if (opts.autonomous) {
    const { DEFAULT_COMPLETION_MARKER, autonomousModePrompt, runAutonomousAgent } = await import(
      "../../agents/loop/autonomous-agent.js"
    );
    const marker = DEFAULT_COMPLETION_MARKER;
    // Code Slop-Index gate (Step 33): won't let the run "finish" on a high-slop
    // diff. Self-disabling outside a git repo / for non-code tasks.
    const slopGate = buildSlopGate(process.cwd());
    let turns = 0;
    try {
      const auto = await runAutonomousAgent({
        task: `${autonomousModePrompt(marker)}\n\nYour task:\n${messageForAgent}`,
        completionMarker: marker,
        maxIterations: opts.maxIterations && opts.maxIterations > 0 ? opts.maxIterations : 25,
        ...(slopGate ? { slopGate } : {}),
        runTurn: async (prompt) => {
          turns++;
          const r = await runSingleTurn({
            agentId,
            provider,
            modelId,
            message: prompt,
            sessionKey,
            workspaceDir: opts.workspace,
            thinkingLevel: opts.thinkingLevel ?? "off",
            signal: abortController.signal,
          });
          process.stdout.write(`\n[turn ${turns}] ${r.reply}\n`);
          return r.reply;
        },
      });
      console.error(
        `[brigade] autonomous run ${auto.done ? "✓ completed" : "stopped"} — ` +
          `reason=${auto.stopReason}, turns=${auto.outputs.length}` +
          (auto.slopRepairs > 0 ? `, slop-rewrites=${auto.slopRepairs}` : "") +
          (auto.completionVetoes > 0 ? `, slop-gate-vetoes=${auto.completionVetoes}` : ""),
      );
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigint);
    }
    return;
  }

  let result: Awaited<ReturnType<typeof runSingleTurn>>;
  try {
    // No try/catch around runSingleTurn for the *non-abort* path — runtime
    // errors propagate to run-main's mapErrorToExitCode, which prefixes
    // with `brigade:` and returns the right exit code for entry.ts to
    // surface. The try/finally exists only to clean up the signal
    // listeners regardless of outcome.
    //
    // NOTE: this headless CLI turn deliberately does NOT schedule background
    // memory extraction/decay/consolidation — that debounced sweep is owned by
    // the long-lived gateway (see core/server.ts runExtractionNow), since a
    // one-shot CLI process exits before any 45s debounce could fire. Auto-recall
    // still injects facts here (it's synchronous), and `brigade chat` routes
    // through the gateway, so interactive use is fully covered.
    result = await runSingleTurn({
      agentId,
      provider,
      modelId,
      message: messageForAgent,
      sessionKey,
      workspaceDir: opts.workspace,
      thinkingLevel: thinkingOverride ?? opts.thinkingLevel ?? "off",
      signal: abortController.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }

  if (result.isNewSession) {
    console.error(`[brigade] new session: ${result.sessionId}`);
  } else {
    console.error(`[brigade] continuing session: ${result.sessionId}`);
  }

  // Reply goes to stdout so it composes cleanly with shell pipes;
  // diagnostics go to stderr above.
  process.stdout.write(result.reply);
  if (!result.reply.endsWith("\n")) process.stdout.write("\n");
}

// Persist the session's model PIN so the NEXT `brigade agent` invocation
// against this session uses the new model without the user having to repeat
// `/model X` or pass --model.
//
// Writes the dedicated pin fields, not `provider`/`modelId` — those are
// overwritten on every turn with whatever model served it, so a pin stored
// there would survive only until the next message.
function persistSessionModel(args: {
  agentId: string;
  sessionKey: string;
  provider: string;
  modelId: string;
}): void {
  // Creates the entry when the session has not taken its first turn yet, so
  // `/model` on a brand-new session key persists instead of silently no-opping.
  pinSessionModel(args.agentId, args.sessionKey, args.provider, args.modelId);
}

// Forget the session entirely. Next `brigade agent` against the same
// sessionKey will create a fresh session id + a fresh transcript file.
// We deliberately don't delete the old JSONL — operators can recover it
// from the transcripts dir if they want; we just stop pointing at it.
function resetSession(args: { agentId: string; sessionKey: string }): void {
  const store = readSessionStore(args.agentId);
  if (store.sessions[args.sessionKey]) {
    delete store.sessions[args.sessionKey];
    writeSessionStore(args.agentId, store);
  }
}

// Source files the code Slop-Index scores (Step 33). Non-code edits (docs,
// config) are not graded — the gate is about code quality.
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|cs|swift|kt)$/i;

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

// Working-tree-dirty paths (relative to the repo root), NUL-separated so paths
// with spaces are safe. Empty when not a git repo / git missing.
function gitDirtyPaths(repoRoot: string): string[] {
  const out = gitOutput(repoRoot, ["status", "--porcelain", "-z"]);
  if (out === undefined) return [];
  return out
    .split("\0")
    .map((entry) => entry.slice(3)) // strip the 2-char XY status + space
    .filter((p) => p.length > 0);
}

/**
 * Build the code Slop-Index completion gate for the LIVE autonomous run. Snapshots
 * the already-dirty files at run start, then scores only the code files the agent
 * NEWLY changed — so pre-existing uncommitted work isn't blamed for the agent's
 * slop. Returns undefined (no gate) when the cwd isn't a git repo or git is absent,
 * so the gate can never wrongly block a non-git or non-code run.
 */
function buildSlopGate(cwd: string): { getChangedFiles: () => SlopFile[] } | undefined {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return undefined;
  const baseline = new Set(gitDirtyPaths(root));
  return {
    getChangedFiles: () => {
      const fresh = gitDirtyPaths(root).filter((p) => !baseline.has(p) && CODE_FILE.test(p));
      const files: SlopFile[] = [];
      for (const rel of fresh) {
        try {
          files.push({ path: rel, content: fs.readFileSync(path.join(root, rel), "utf8") });
        } catch {
          /* deleted / unreadable since the diff — skip */
        }
      }
      return files;
    },
  };
}
