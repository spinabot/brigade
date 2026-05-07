import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import {
  DEFAULT_AGENT_ID,
  ensureDir,
  resolveAllPaths,
  resolveConfigPath,
  resolveLogsDir,
  resolveTasksDir,
} from "../../config/paths.js";
import { writeConfigSafe, readConfigOrInit } from "../../config/io.js";
import { initAuthProfiles } from "../../auth/profiles.js";
import { bootstrapWorkspace } from "../../workspace/bootstrap.js";
import { ensureDeviceIdentity } from "../../identity/device.js";
import {
  applyConfigMeta,
  applyWizardMetadata,
  type BrigadeOnboardMode,
} from "../wizard/helpers.js";
import {
  type BrigadeNonInteractiveSetupResult,
  runNonInteractiveSetup,
} from "../wizard/non-interactive.js";
import {
  BrigadeWizardCancelledError,
  runInteractiveSetup,
} from "../wizard/setup.js";

interface OnboardOptions {
  agentId: string;
  workspace?: string;
  installDaemon?: boolean;
  // Wizard inputs — when any of these are set we run the non-interactive
  // path and skip prompts entirely. The interactive path fills the same
  // fields and feeds them through the same writer, so the brigade.json
  // shape is identical regardless of input mode.
  provider?: string;
  apiKey?: string;
  model?: string;
  fallbackModel?: string;
  gatewayPort?: string;
  gatewayToken?: string;
  secretInputMode?: "plaintext" | "ref";
  nonInteractive?: boolean;
  mode?: BrigadeOnboardMode;
  skipWizard?: boolean;
}

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Set up ~/.brigade/ — workspace, auth scaffolding, default config")
    .option("--agent-id <id>", "agent id to provision", DEFAULT_AGENT_ID)
    .option("--workspace <dir>", "override workspace directory")
    .option("--install-daemon", "also install the gateway daemon")
    .option(
      "--provider <id>",
      "provider id (openrouter|anthropic|openai|ollama). Triggers non-interactive setup when set.",
    )
    .option("--api-key <key>", "API key for the picked provider (literal or empty for ref mode)")
    .option("--model <id>", "primary model id (must belong to --provider)")
    .option("--fallback-model <id>", "secondary model id within the same provider")
    .option("--gateway-port <port>", "gateway port (default: 18789)")
    .option("--gateway-token <token>", "gateway auth token (default: random 48-hex)")
    .option(
      "--secret-input-mode <mode>",
      "plaintext (literal in auth-profiles.json) | ref (read from env var at runtime)",
      "plaintext",
    )
    .option("--non-interactive", "skip all prompts; require flags for any choice")
    .option("--mode <mode>", "local|remote (default: local)", "local")
    .option(
      "--skip-wizard",
      "scaffold dirs/workspace only — do not run the provider/model wizard",
    )
    .action(async (raw: OnboardOptions) => {
      await runOnboard(raw);
    });
}

export async function runOnboard(opts: OnboardOptions): Promise<void> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const paths = resolveAllPaths(agentId, opts.workspace);
  const mode: BrigadeOnboardMode = opts.mode === "remote" ? "remote" : "local";

  // Eagerly create only the dirs the runtime actively uses. Other dirs
  // (cache/, oauth/, credentials/, completions/) are created lazily by
  // their own subsystems on first write — that matches the reference's
  // pattern and avoids leaving empty-looking dirs behind that suggest
  // brigade is provisioning more than it actually is.
  ensureDir(paths.stateDir);
  ensureDir(paths.agentDir);
  ensureDir(paths.authDir);
  ensureDir(paths.sessionsDir);
  ensureDir(resolveTasksDir());
  ensureDir(resolveLogsDir());

  // Snapshot whether brigade.json existed BEFORE this onboard. The wizard
  // uses this to gate first-onboard-only seeds (controlUi.allowInsecureAuth
  // + nodes.denyCommands) so re-running onboard against a customised
  // config doesn't clobber prior choices. Mirrors the reference's
  // `quickstartGateway.hasExisting` flag.
  const hasExistingConfig = fs.existsSync(resolveConfigPath());

  // brigade.json — load or initialise, but do not write yet. The wizard
  // step below builds the full object before the single write at the end.
  let config = readConfigOrInit();
  if (!config.agents) config.agents = {};
  // Forward-compat slot for per-agent overrides — only materialised when
  // the user passes an explicit --workspace or --default-route. Until then
  // the agent inherits agents.defaults entirely, which matches the
  // reference: a single-agent install has no per-id keys, just defaults.
  if (opts.workspace) {
    const existing = config.agents[agentId];
    const isDefaults = isAgentDefaultsBlock(existing);
    if (!existing || isDefaults) {
      config.agents[agentId] = {
        workspace: opts.workspace,
        defaultRoute: null,
      };
    }
  }

  // auth-profiles.json — empty scaffold at mode 0600, never overwrite.
  initAuthProfiles(agentId);

  // Empty session-key index so the runtime has something to read on first turn.
  if (!fs.existsSync(paths.sessionStorePath)) {
    fs.writeFileSync(
      paths.sessionStorePath,
      JSON.stringify({ version: 1, sessions: {} }, null, 2),
      "utf8",
    );
  }

  // 7 workspace files (AGENTS, BOOTSTRAP, IDENTITY, SOUL, TOOLS, HEARTBEAT, USER).
  // Content is loaded from templates/workspace/ on disk via the loader.
  // bootstrapWorkspace is also responsible for git-init on truly fresh
  // workspaces and for honouring the brand-new-workspace probe so
  // re-onboard against a customised workspace doesn't resurrect BOOTSTRAP.md.
  const ws = await bootstrapWorkspace(paths.workspaceDir);

  // Ed25519 device identity. Written once on first onboard; subsequent
  // calls are a no-op. Required for any future device-pairing primitive.
  const identity = await ensureDeviceIdentity();

  // Wizard step — provider pick + key entry + model pick. Skipped only
  // when --skip-wizard is passed (test-mode scaffold) or when a non-TTY
  // is detected without provider flags (CI calling onboard purely to
  // create dirs).
  let wizardResult: BrigadeNonInteractiveSetupResult | undefined;
  let wizardSkipped = false;
  if (opts.skipWizard) {
    wizardSkipped = true;
  } else if (shouldRunNonInteractive(opts)) {
    if (!opts.provider) {
      // No flags + non-interactive flag → caller wanted to scaffold only.
      wizardSkipped = true;
    } else {
      wizardResult = runNonInteractiveSetup({
        config,
        workspace: paths.workspaceDir,
        agentId,
        provider: opts.provider,
        apiKey: opts.apiKey,
        secretInputMode: opts.secretInputMode ?? "plaintext",
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
        ...(opts.gatewayPort ? { gatewayPort: parseGatewayPort(opts.gatewayPort) } : {}),
        ...(opts.gatewayToken ? { gatewayToken: opts.gatewayToken } : {}),
        mode,
        hasExistingConfig,
      });
    }
  } else {
    // Interactive — prompt the user. Cancellation aborts cleanly without
    // writing the wizard sections (dirs + workspace + identity stay).
    try {
      wizardResult = await runInteractiveSetup({
        config,
        workspace: paths.workspaceDir,
        agentId,
        hasExistingConfig,
      });
    } catch (err) {
      if (err instanceof BrigadeWizardCancelledError) {
        wizardSkipped = true;
        console.log("");
        console.log("[note] wizard cancelled — workspace + auth scaffolding kept.");
      } else {
        throw err;
      }
    }
  }

  // Single write at the end — wizard output (if any) + meta/version stamps.
  if (wizardResult) {
    config = wizardResult.config;
  }
  config = applyWizardMetadata(config, { command: "onboard", mode });
  config = applyConfigMeta(config);
  writeConfigSafe(config);

  printOnboardSummary({
    agentId,
    paths,
    createdWorkspaceFiles: ws.created.length,
    missingTemplates: ws.missingTemplates,
    workspaceGitInitialised: ws.gitInitialised,
    deviceIdCreated: identity.created,
    deviceId: identity.identity.deviceId,
    wizardResult,
    wizardSkipped,
  });

  if (opts.installDaemon) {
    console.log("");
    console.log("[note] --install-daemon is not yet implemented in this scaffold.");
    console.log("       Once the gateway module lands, this flag will install");
    console.log("       the per-OS service: launchd / systemd / Task Scheduler.");
  }
}

function shouldRunNonInteractive(opts: OnboardOptions): boolean {
  if (opts.nonInteractive) return true;
  if (opts.provider) return true;
  // No TTY + no flags = scaffold only (skipWizard implied).
  if (!process.stdin.isTTY) return true;
  return false;
}

function parseGatewayPort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(
      `--gateway-port must be a positive integer between 1 and 65535 (got: "${value}").`,
    );
  }
  return parsed;
}

// The agents map can hold either AgentConfig (per-id overrides) or the
// special `defaults` block. This guard tells them apart so re-runs of
// onboard don't overwrite the defaults block with a per-id stub.
function isAgentDefaultsBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return "model" in obj || "models" in obj;
}

function printOnboardSummary(args: {
  agentId: string;
  paths: ReturnType<typeof resolveAllPaths>;
  createdWorkspaceFiles: number;
  missingTemplates: readonly string[];
  workspaceGitInitialised: boolean;
  deviceIdCreated: boolean;
  deviceId: string;
  wizardResult: BrigadeNonInteractiveSetupResult | undefined;
  wizardSkipped: boolean;
}): void {
  const { agentId, paths, createdWorkspaceFiles, missingTemplates } = args;
  console.log("Brigade onboarded.");
  console.log("");
  console.log(`  Agent id          ${agentId}`);
  console.log(`  State dir         ${paths.stateDir}`);
  console.log(`  Config            ${paths.configPath}`);
  console.log(`  Auth dir          ${paths.authDir}`);
  console.log(`  Auth profiles     ${path.basename(paths.authProfilesPath)} (mode 0600)`);
  console.log(`  Sessions          ${paths.sessionsDir}`);
  console.log(`  Workspace         ${paths.workspaceDir}`);
  console.log(`  Workspace files   ${createdWorkspaceFiles} created`);
  console.log(
    `  Workspace git     ${args.workspaceGitInitialised ? "initialised" : "skipped (existing or git unavailable)"}`,
  );
  console.log(
    `  Device identity   ${args.deviceIdCreated ? "generated" : "existing"} (${args.deviceId.slice(0, 8)}…)`,
  );
  console.log(`  Tasks db          ${paths.tasksDbPath} (lazy)`);

  if (args.wizardResult) {
    const cfg = args.wizardResult.config;
    const provider = args.wizardResult.profileId.split(":")[0];
    const model = (cfg.agents?.defaults as { model?: { primary?: string } } | undefined)?.model
      ?.primary;
    const port = cfg.gateway?.port;
    console.log("");
    console.log(`  Provider          ${provider}`);
    if (model) console.log(`  Default model     ${model}`);
    if (typeof port === "number") console.log(`  Gateway port      ${port}`);
    console.log(`  Gateway token     ${cfg.gateway?.auth?.token ? "(stored, mode 0600 in brigade.json — rotate via /reset)" : "(not set)"}`);
    if (args.wizardResult.wroteSecret) {
      console.log(`  Auth profile      ${args.wizardResult.profileId} (key in auth-profiles.json)`);
    }
  } else if (args.wizardSkipped) {
    console.log("");
    console.log("  Wizard            skipped — re-run \`brigade onboard\` to pick a provider/model.");
  }

  if (missingTemplates.length > 0) {
    console.log("");
    console.log(
      `  [warn] templates missing for: ${missingTemplates.join(", ")}.`,
    );
    console.log(
      "         Drop the corresponding markdown into templates/workspace/ and re-run onboard.",
    );
  }
  console.log("");
  console.log("Next: `brigade agent --message \"hello\"` to drive a turn,");
  console.log("      or `brigade tui` for the interactive shell.");
}
