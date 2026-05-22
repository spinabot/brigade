import { Command } from "commander";

import { runSingleTurn } from "../../agents/agent-loop.js";
import {
  parseSlashCommand,
  SLASH_COMMAND_HELP,
} from "../../agents/slash-commands.js";
import { readConfigOrInit } from "../../config/io.js";
import { DEFAULT_AGENT_ID, resolveAllPaths } from "../../config/paths.js";
import {
  defaultSessionKey,
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
  //   2. Persisted session override — set by a prior `/model X` command.
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
  const sessionEntry = readSessionStore(agentId).sessions[sessionKey];
  const provider =
    opts.provider ??
    sessionEntry?.provider ??
    agentCfg?.defaultProvider ??
    wizardDefaults?.provider;
  const modelId =
    opts.model ??
    sessionEntry?.modelId ??
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

// Persist the session's model override to sessions.json so the NEXT
// `brigade agent` invocation against this session uses the new model
// without the user having to repeat `/model X` or pass --model.
function persistSessionModel(args: {
  agentId: string;
  sessionKey: string;
  provider: string;
  modelId: string;
}): void {
  const store = readSessionStore(args.agentId);
  const entry = store.sessions[args.sessionKey];
  if (!entry) {
    // No session yet (first turn) — the model override will land in the
    // entry that resolveOrCreateSession creates on this turn. Nothing to
    // persist here ahead of time. The active turn already uses the
    // override via the runSingleTurn call.
    return;
  }
  entry.provider = args.provider;
  entry.modelId = args.modelId;
  entry.lastUsedAt = new Date().toISOString();
  writeSessionStore(args.agentId, store);
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
