import { Command } from "commander";

import { formatVersion } from "../../version.js";

// ─────────────────────────── exit drain ───────────────────────────
// Every command action terminates with `await exitAfterFlush(code)` instead
// of a bare `process.exit(code)`. In convex mode the storage adapters batch
// mutations onto write-behind chains; a short-lived CLI command that mutates
// then exits immediately would terminate the process before the enqueued
// write reached the backend (a silent lost write — `brigade exec allow`,
// `brigade config set`, `brigade channels allow`, …). Draining first closes
// that window. Filesystem mode + read-only commands drain already-settled
// chains, so this is free there.
async function exitAfterFlush(code: number): Promise<never> {
  try {
    const { flushAllPendingWrites } = await import("../../storage/flush.js");
    await flushAllPendingWrites();
  } catch {
    // Never let a drain failure block process termination.
  }
  process.exit(code);
}

// ─────────────────────────── storage boot hook ───────────────────────────
// One preAction hook initialises the RuntimeContext (mode sentinel → store →
// `store.init()`) before ANY command action runs. Subsystems then reach
// storage via `getRuntimeContext().store` without re-resolving mode.
//
// Three tiers:
//   • BOOT_SKIP     — commands that must run BEFORE a context exists.
//                     `onboard` creates the mode sentinel; it builds its own
//                     store after the wizard picks a mode.
//   • BOOT_OPTIONAL — diagnostic / repair / reconfigure commands. They boot
//                     when the backend is healthy but keep working when it
//                     isn't — a broken convex deployment must never brick
//                     the tools an operator uses to fix it (`doctor`,
//                     `status`, `gateway stop`, `store mode set`, `migrate`).
//   • everything else — workloads (tui, agent, gateway run, connect, config,
//                     channels, cron, agents, org, exec). Boot failure is
//                     fatal with the storage layer's operator-facing error.

const BOOT_SKIP = new Set(["onboard"]);

const BOOT_OPTIONAL_PREFIXES = [
  "doctor",
  "status",
  "gateway status",
  "gateway stop",
  "gateway install",
  "gateway uninstall",
  "gateway restart",
  "gateway supervise",
  // `expose status/stop` just read the tunnel state file + a pid — they must
  // work even when the storage backend is down (e.g. to tear down a tunnel).
  "expose status",
  "expose stop",
  "bloody benchmark status",
  "bloody benchmark stop",
  "store",
  "encrypt",
  "migrate",
  "backup",
  // `extensions list/doctor/init` inspect the filesystem extensions dir +
  // scaffold a starter module — they never touch the storage backend, so a
  // down backend must not block an author diagnosing why a plugin won't load.
  "extensions",
  // The `convex` command MANAGES the backend that convex mode depends on, so
  // it must run even when that backend is down — booting the storage layer
  // here would be circular (you can't reach a backend you're trying to start).
  "convex",
];

/** "gateway status"-style path for the action command (root name elided). */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur && cur.name() !== "brigade") {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return parts.join(" ");
}

function isBootOptional(path: string): boolean {
  return BOOT_OPTIONAL_PREFIXES.some((p) => path === p || path.startsWith(`${p} `));
}

// Lazy command-registration pattern. Each subcommand's real body (action
// handler) lives in a separate module under `src/cli/commands/`. Commander
// still needs each command DECLARED at the program level so `brigade
// --help` lists all of them, BUT the heavy import chain (Pi SDK init,
// model registry, TUI widgets, gateway server, ws stack, etc.) only loads
// when the user actually picks that command.
//
// In practice: `brigade onboard` doesn't pay for chat/gateway/connect's
// import time, and `brigade tui` doesn't pay for gateway's. The savings
// matter most on a cold `brigade --help` (now sub-100ms) and on
// short-lived invocations like `brigade --version` (handled by the
// fast-path in entry.ts before we even reach this builder).
//
// Primitive #1/#2 surface (onboard + agent + tui) is unchanged in shape;
// gateway + connect were lifted from the published v0.1.3 codebase. The
// status / doctor / config / gateway-subcommands surfaces give Brigade
// the canonical `brigade <status|doctor|config|gateway run|gateway
// status|gateway stop>` shape — Brigade-sized ports, no plugin/daemon-
// installer scope creep.

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("brigade")
    .description("🦁 Brigade — your personal AI crew")
    .version(formatVersion(), "-v, --version", "show brigade version");

  // exitOverride lets runMain decide how to surface help/no-args, instead of
  // Commander killing the process directly with exit(1).
  program.exitOverride();

  // On a parse error (unknown option, bad arg) point the user at help instead
  // of leaving them with a bare error. Unknown COMMANDS are handled separately:
  // because `tui` is the default command, an unknown word becomes its [agent]
  // positional — the tui action validates it and prints full help (see below).
  program.showHelpAfterError("(run 'brigade --help' to see all commands)");

  // Storage boot — fires for every action in the command tree (Commander
  // propagates program-level hooks to subcommands). Help/version never reach
  // an action, so they stay storage-free. The import is dynamic to keep the
  // `brigade --help` fast-path from paying for the storage layer.
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    const path = commandPath(actionCommand);
    if (BOOT_SKIP.has(path)) return;
    const { bootRuntimeContext } = await import("../../storage/boot.js");
    try {
      await bootRuntimeContext();
    } catch (err) {
      if (isBootOptional(path)) {
        process.stderr.write(
          `brigade: storage backend unavailable — continuing without it (${(err as Error).message})\n`,
        );
        return;
      }
      throw err;
    }
  });

  // Each command does the same dance:
  //   1. Declare the subcommand + its options (synchronous; cheap).
  //   2. Inside .action(), dynamic-import the command's runner.
  //   3. Call the runner with the parsed options.
  //
  // The dynamic import is what makes this lazy — Node only resolves +
  // executes the runner module when the user actually picks the command.

  program
    .command("onboard")
    .description("Pick a provider and model — interactive Pi-TUI wizard")
    // Commander's `--no-X` pattern: with no third arg the option defaults to
    // `true`, and passing `--no-env-detect` flips it to `false`. Passing an
    // explicit `false` default broke the inverted semantics — it pinned the
    // value to `false` regardless of what the user typed, so env-detection
    // was silently OFF on every `brigade onboard` run. Drop the default.
    .option("--no-env-detect", "ignore API keys from the shell environment")
    .option(
      "--secret-input-mode <mode>",
      "how accepted env-keys persist: 'plaintext' (default, copies value into Brigade's local config) or 'ref' (stores a keyRef; literal value never lands on disk)",
      "plaintext",
    )
    .action(async (opts: { envDetect?: boolean; secretInputMode?: string }) => {
      const { runOnboardCommand } = await import("../commands/onboard.js");
      const mode = opts.secretInputMode === "ref" ? "ref" : "plaintext";
      const code = await runOnboardCommand({
        noEnvDetect: opts.envDetect === false,
        secretInputMode: mode,
      });
      await exitAfterFlush(code);
    });

  program
    .command("login [provider]")
    .description("Log in to a subscription provider (Claude Pro/Max, ChatGPT, Copilot) — browser OAuth")
    .action(async (provider: string | undefined) => {
      const { runLoginCommand } = await import("../commands/login.js");
      const code = await runLoginCommand(provider ? { provider } : {});
      await exitAfterFlush(code);
    });

  // `brigade auth` — unified login surface (status / login / fix / logout).
  // `status` is the default subcommand so a bare `brigade auth` reports health.
  const auth = program
    .command("auth")
    .description("Manage provider logins — status, sign in, fix expiring logins, sign out");
  auth
    .command("status", { isDefault: true })
    .description("Show which logins are healthy vs will expire")
    .action(async () => {
      const { runAuthCommand } = await import("../commands/auth.js");
      await exitAfterFlush(await runAuthCommand({ action: "status" }));
    });
  auth
    .command("login [provider]")
    .description("Sign in / re-auth a provider (browser OAuth for subscriptions, API key for others)")
    .action(async (provider: string | undefined) => {
      const { runAuthCommand } = await import("../commands/auth.js");
      await exitAfterFlush(await runAuthCommand({ action: "login", ...(provider ? { provider } : {}) }));
    });
  auth
    .command("fix")
    .description("Re-login every provider whose credential can't auto-refresh")
    .action(async () => {
      const { runAuthCommand } = await import("../commands/auth.js");
      await exitAfterFlush(await runAuthCommand({ action: "fix" }));
    });
  auth
    .command("logout <provider>")
    .description("Remove a provider's stored login")
    .action(async (provider: string) => {
      const { runAuthCommand } = await import("../commands/auth.js");
      await exitAfterFlush(await runAuthCommand({ action: "logout", provider }));
    });
  auth
    .command("use <provider> [model]")
    .description("Set the default provider (+ model) the crew runs on")
    .action(async (provider: string, model: string | undefined) => {
      const { runAuthCommand } = await import("../commands/auth.js");
      await exitAfterFlush(await runAuthCommand({ action: "use", provider, ...(model ? { model } : {}) }));
    });

  program
    .command("agent")
    .description("Drive a single turn through the agent pipeline")
    .allowUnknownOption()
    .helpOption(false)
    .action(async () => {
      const { registerAgentCommand } = await import("../commands/agent.js");
      const sub = new Command();
      registerAgentCommand(sub);
      await sub.parseAsync(process.argv);
    });

  program
    .command("exec-node")
    .description("Run a Node script with Brigade's bundled libraries (docx, exceljs, pdf-lib, pptxgenjs, fflate, jimp) requireable — powers the document skills")
    .allowUnknownOption()
    .helpOption(false)
    .action(async () => {
      const { runExecNodeCommand } = await import("../commands/exec-node.js");
      const idx = process.argv.indexOf("exec-node");
      const rest = idx >= 0 ? process.argv.slice(idx + 1) : [];
      const code = await runExecNodeCommand(rest);
      process.exit(code);
    });

  program
    .command("tui", { isDefault: true })
    .description("Launch the Brigade chat TUI (auto-starts the gateway if needed)")
    // Positional agent id — the npm-friendly spelling. `npm run tui <agent>`
    // passes the bare word straight through (no `--` dance), and even
    // `npm run tui --agent <agent>` works because npm strips its own
    // `--agent` config flag and forwards just `<agent>` as this positional.
    // The `--agent <id>` flag below is the equivalent for `brigade tui`.
    .argument("[agent]", "agent id to bind at startup (positional alias for --agent)")
    // Same Commander `--no-X` pattern as `onboard` above — no third arg.
    .option("--no-env-detect", "ignore API keys from the shell environment")
    .option("-h, --host <host>", "gateway host to connect to / spawn on (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port (default: 7777)", (v) => parseInt(v, 10))
    .option("--agent <id>", "bind the TUI to this agent at startup (skips the /agent step)")
    .action(async (agentArg: string | undefined, opts: { envDetect?: boolean; host?: string; port?: number; agent?: string }) => {
      // FOOTGUN GUARD. `tui` is the DEFAULT command, so a mistyped or unknown
      // command (`brigade upgarde`, `brigade foo`) doesn't error — Commander
      // routes the unknown word here as the positional [agent]. Without this
      // check it would silently START THE GATEWAY bound to a bogus agent. So:
      // a BARE positional that isn't a real agent id is treated as an unknown
      // command — print help and exit, never launch. (The explicit `--agent`
      // flag is deliberate intent and is left to resolve downstream.)
      if (agentArg && !opts.agent) {
        const known = new Set<string>();
        try {
          const { loadConfig } = await import("../../core/config.js");
          const { listAgentEntries } = await import("../commands/agents-config.js");
          const { DEFAULT_AGENT_ID } = await import("../../agents/routing/session-key.js");
          known.add(DEFAULT_AGENT_ID);
          for (const a of listAgentEntries(loadConfig())) known.add(a.id);
        } catch {
          known.add("main"); // config unreadable → only the default agent is known
        }
        if (!known.has(agentArg)) {
          process.stderr.write(`error: unknown command '${agentArg}'\n\n`);
          program.outputHelp();
          await exitAfterFlush(1);
          return;
        }
      }
      const { runChatCommand } = await import("../commands/chat.js");
      // Flag wins over positional when both are given; otherwise the
      // positional (npm path) supplies the binding.
      const agentId = opts.agent ?? agentArg;
      await runChatCommand({
        noEnvDetect: opts.envDetect === false,
        host: opts.host,
        port: opts.port,
        ...(agentId ? { agentId } : {}),
      });
      // Hold the action handler open — `runChatCommand` resolves once the
      // editor is wired; without this pin, the entry-point exit hook
      // would kill the chat before the user could type. The chat itself
      // terminates on /exit / Ctrl+D / two-Ctrl+C.
      await new Promise<void>(() => {});
    });

  /* ────────────────────── gateway parent + subcommands ────────────────────── */
  // `brigade gateway <run|status|stop|...>`. The bare `brigade gateway`
  // invocation stays back-compat — it dispatches to `run`. status/stop
  // are quick reads of port 7777 + the PID file, so they don't need the
  // Pi SDK or the gateway server module to load.
  const gw = program.command("gateway").description("Run or manage the Brigade gateway (WebSocket daemon)");

  gw.option("-p, --port <port>", "TCP port to bind", (v) => parseInt(v, 10))
    .option("-h, --host <host>", "host/interface to bind")
    .option("-V, --verbose", "raise log level to debug")
    .option("-q, --quiet", "disable the console stream entirely")
    .option("--log-level <level>", "trace|debug|info|warn|error|fatal")
    .action(async (opts: { port?: number; host?: string; verbose?: boolean; quiet?: boolean; logLevel?: string }) => {
      // Bare `brigade gateway` = `brigade gateway run` (back-compat).
      const { runGatewayCommand } = await import("../commands/gateway.js");
      await runGatewayCommand({
        port: opts.port,
        host: opts.host,
        verbose: opts.verbose,
        quiet: opts.quiet,
        logLevel: opts.logLevel as never,
      });
      await new Promise<void>(() => {});
    });

  gw.command("run")
    .description("Run the gateway in the foreground (alias for bare `gateway`)")
    .option("-p, --port <port>", "TCP port to bind", (v) => parseInt(v, 10))
    .option("-h, --host <host>", "host/interface to bind")
    .option("-V, --verbose", "raise log level to debug")
    .option("-q, --quiet", "disable the console stream entirely")
    .option("--log-level <level>", "trace|debug|info|warn|error|fatal")
    .action(async (opts: { port?: number; host?: string; verbose?: boolean; quiet?: boolean; logLevel?: string }) => {
      const { runGatewayCommand } = await import("../commands/gateway.js");
      await runGatewayCommand({
        port: opts.port,
        host: opts.host,
        verbose: opts.verbose,
        quiet: opts.quiet,
        logLevel: opts.logLevel as never,
      });
      await new Promise<void>(() => {});
    });

  gw.command("status")
    .description("Probe the running gateway and print its state")
    .option("-h, --host <host>", "gateway host (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port (default: 7777)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { host?: string; port?: number; json?: boolean }) => {
      const { runGatewayStatusCommand } = await import("../commands/gateway.js");
      await exitAfterFlush(await runGatewayStatusCommand(opts));
    });

  gw.command("stop")
    .description("Send SIGTERM to the running gateway and wait for it to exit")
    .option("--timeout <ms>", "max ms to wait for shutdown (default: 5000)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { timeout?: number; json?: boolean }) => {
      const { runGatewayStopCommand } = await import("../commands/gateway.js");
      await exitAfterFlush(await runGatewayStopCommand(opts));
    });

  // Optional gateway authentication — multiple tokens supported. Pure config
  // edits: these NEVER boot the gateway. With no tokens the gateway stays
  // unauthenticated + localhost-only.
  const tokenCmd = gw.command("token").description("Manage optional gateway access tokens (multiple supported)");
  tokenCmd
    .command("list")
    .description("List configured tokens (masked) and whether auth is enforced")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayTokenListCommand } = await import("../commands/gateway.js");
      await exitAfterFlush(await runGatewayTokenListCommand(opts));
    });
  tokenCmd
    .command("new")
    .description("Generate a new token, store it, and print it once")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayTokenNewCommand } = await import("../commands/gateway.js");
      await exitAfterFlush(await runGatewayTokenNewCommand(opts));
    });
  tokenCmd
    .command("add <token>")
    .description("Add an existing token to the accepted list")
    .action(async (token: string) => {
      const { runGatewayTokenAddCommand } = await import("../commands/gateway.js");
      await exitAfterFlush(await runGatewayTokenAddCommand(token));
    });
  tokenCmd
    .command("revoke <tokenOrIndex>")
    .description("Remove a token by value, or by its number from `token list`")
    .action(async (arg: string) => {
      const { runGatewayTokenRevokeCommand } = await import("../commands/gateway.js");
      await exitAfterFlush(await runGatewayTokenRevokeCommand(arg));
    });

  // OS-service installer: macOS launchd / Linux systemd-user / Windows Task
  // Scheduler. The supervisor IS the restart loop; the gateway survives reboots
  // and crashes via the OS-native mechanism.
  gw.command("install")
    .description("Install Brigade as an OS service (launchd / systemd / Task Scheduler)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayInstall } = await import("../commands/gateway-install.js");
      await exitAfterFlush(await runGatewayInstall({ json: opts.json }));
    });

  gw.command("uninstall")
    .description("Remove the OS-service registration (the unit file and the supervisor entry)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayUninstall } = await import("../commands/gateway-install.js");
      await exitAfterFlush(await runGatewayUninstall({ json: opts.json }));
    });

  gw.command("restart")
    .description("Restart the installed Brigade service (stop + start)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayRestart } = await import("../commands/gateway-install.js");
      await exitAfterFlush(await runGatewayRestart({ json: opts.json }));
    });

  // Out-of-process watchdog. Reads the gateway's heartbeat file every N
  // seconds; if the gateway's event loop is wedged (alive process, stale
  // heartbeat), kills + respawns it. Use `--once` for a single check; use
  // the looping form under `nohup` / systemd / launchd for continuous
  // supervision.
  gw.command("supervise")
    .description(
      "Watch the gateway heartbeat and respawn on wedge (use --once for a single check)",
    )
    .option(
      "--interval <ms>",
      "polling interval (default: 30000ms)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--max-stale <ms>",
      "max heartbeat age before treating gateway as wedged (default: 90000ms)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--max-respawns <n>",
      "respawn cap inside --respawn-window (default: 12)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--respawn-window <ms>",
      "rolling window for the respawn cap (default: 3600000ms / 1h)",
      (v) => parseInt(v, 10),
    )
    .option("--once", "run a single check then exit (default: loop forever)", false)
    .option("--json", "emit JSON lines instead of human-readable text", false)
    .action(
      async (opts: {
        interval?: number;
        maxStale?: number;
        maxRespawns?: number;
        respawnWindow?: number;
        once?: boolean;
        json?: boolean;
      }) => {
        const { runGatewaySupervise } = await import("../commands/gateway-supervise.js");
        await exitAfterFlush(
          await runGatewaySupervise({
            intervalMs: opts.interval,
            maxStaleMs: opts.maxStale,
            maxRespawnsPerWindow: opts.maxRespawns,
            respawnWindowMs: opts.respawnWindow,
            once: opts.once,
            json: opts.json,
          }),
        );
      },
    );

  /* ───────────────────────── expose (public tunnel) ───────────────────────── */
  // `brigade expose` publishes the gateway to the public internet through a
  // token-checking auth-proxy + a tunnel provider (cloudflare default). The
  // raw gateway stays loopback-only; only the authed proxy is tunnelled.
  // `brigade bloody benchmark` is an alias for the same thing.
  type ExposeOpts = {
    provider?: string;
    token?: string;
    insecure?: boolean;
    open?: boolean;
    relay?: string;
    command?: string;
    port?: number;
    verbose?: boolean;
    json?: boolean;
  };

  // Shared option set so `expose` and `bloody benchmark` stay identical.
  const addExposeOptions = (cmd: Command): Command =>
    cmd
      .option("--provider <name>", "tunnel provider: cloudflare | bore | custom (default: cloudflare)")
      .option("--token <token>", "bearer token required on the public URL (auto-generated + saved if omitted)")
      .option("--open", "expose with NO token — anyone with the URL gets in (simplest, least safe)", false)
      .option("--insecure", "alias for --open (NO token gate)", false)
      .option("--relay <addr>", "self-hosted relay address (bore/custom providers)")
      .option("--command <cmd>", "custom provider command template; {port} is replaced with the proxy port")
      .option("-p, --port <port>", "gateway port to expose (default: config gateway.port or 7777)", (v) => parseInt(v, 10))
      .option("-V, --verbose", "stream tunnel provider logs", false);

  const runExpose = async (opts: ExposeOpts): Promise<void> => {
    const { runExposeCommand } = await import("../commands/expose.js");
    await runExposeCommand(opts);
    await new Promise<void>(() => {}); // hold the tunnel open until Ctrl-C
  };

  const expose = addExposeOptions(
    program.command("expose").description("Expose the gateway to the public internet via a secure tunnel"),
  ).action(runExpose);

  expose
    .command("status")
    .description("Show the active tunnel (URL, provider, uptime)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .option("--show-link", "reveal the full access link (includes the private key)", false)
    .option("--show-qr", "render the full access link as a scannable QR code (for the app)", false)
    .action(async (opts: { json?: boolean; showLink?: boolean; showQr?: boolean }) => {
      const { runExposeStatusCommand } = await import("../commands/expose.js");
      await exitAfterFlush(await runExposeStatusCommand(opts));
    });

  expose
    .command("stop")
    .description("Tear down the active tunnel")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runExposeStopCommand } = await import("../commands/expose.js");
      await exitAfterFlush(await runExposeStopCommand(opts));
    });

  // Easter-egg alias: `brigade bloody benchmark [status|stop]` ≡ `brigade expose …`.
  const bloody = program
    .command("bloody")
    .description("Alias group — `brigade bloody benchmark` opens a public tunnel (= `brigade expose`)");
  const benchmark = addExposeOptions(
    bloody.command("benchmark").description("Expose the gateway to the public internet (alias for `brigade expose`)"),
  ).action(runExpose);
  benchmark
    .command("status")
    .description("Show the active tunnel")
    .option("--json", "emit JSON instead of human-readable text", false)
    .option("--show-link", "reveal the full access link (includes the private key)", false)
    .option("--show-qr", "render the full access link as a scannable QR code (for the app)", false)
    .action(async (opts: { json?: boolean; showLink?: boolean; showQr?: boolean }) => {
      const { runExposeStatusCommand } = await import("../commands/expose.js");
      await exitAfterFlush(await runExposeStatusCommand(opts));
    });
  benchmark
    .command("stop")
    .description("Tear down the active tunnel")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runExposeStopCommand } = await import("../commands/expose.js");
      await exitAfterFlush(await runExposeStopCommand(opts));
    });

  /* ─────────────────────────────── connect ─────────────────────────────── */

  program
    .command("connect")
    .description(
      "Connect to a running Brigade gateway from a thin TUI client.\n" +
        "  Examples:\n" +
        "    brigade connect                          # default 127.0.0.1:7777\n" +
        "    brigade connect marketing-lead           # open bound to that agent\n" +
        "    brigade connect --agent marketing-lead   # same, flag form\n" +
        "    brigade connect --host 192.168.1.5 -p 7777\n" +
        "    brigade connect --timeout 120000",
    )
    .argument("[agent]", "agent id to bind at startup (positional alias for --agent)")
    .option("-h, --host <host>", "gateway host (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port", (v) => parseInt(v, 10))
    .option("--timeout <ms>", "request timeout in ms", (v) => parseInt(v, 10))
    .option("--agent <id>", "bind the TUI to this agent at startup (skips the /agent step)")
    .option("--token <token>", "access token for an authenticated gateway (else read from config / BRIGADE_GATEWAY_TOKEN)")
    .action(async (agentArg: string | undefined, opts: { host?: string; port?: number; timeout?: number; agent?: string; token?: string }) => {
      const { runConnectCommand } = await import("../commands/connect.js");
      const agentId = opts.agent ?? agentArg;
      await runConnectCommand({
        host: opts.host,
        port: opts.port,
        requestTimeoutMs: opts.timeout,
        ...(opts.token ? { token: opts.token } : {}),
        ...(agentId ? { agentId } : {}),
      });
      await new Promise<void>(() => {});
    });

  /* ─────────────────────────────── status ─────────────────────────────── */

  program
    .command("status")
    .description("Print a snapshot of Brigade configuration, sessions, and gateway state")
    .option("-h, --host <host>", "gateway host to probe (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port to probe (default: 7777)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { host?: string; port?: number; json?: boolean }) => {
      const { runStatusCommand } = await import("../commands/status.js");
      await runStatusCommand({ host: opts.host, port: opts.port, json: opts.json });
    });

  /* ─────────────────────────────── doctor ─────────────────────────────── */

  program
    .command("doctor")
    .description(
      "Run health checks against your Brigade install, providers, workspace, and the gateway.\n" +
        "  Examples:\n" +
        "    brigade doctor                  # human-readable output\n" +
        "    brigade doctor --json           # machine-readable\n" +
        "    brigade doctor --strict         # exit 1 on warnings (CI mode)",
    )
    .option("-h, --host <host>", "gateway host to probe (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port to probe (default: 7777)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .option("--strict", "exit non-zero on warnings (CI mode)", false)
    .action(async (opts: { host?: string; port?: number; json?: boolean; strict?: boolean }) => {
      const { runDoctorCommand } = await import("../commands/doctor.js");
      await exitAfterFlush(
        await runDoctorCommand({ host: opts.host, port: opts.port, json: opts.json, strict: opts.strict }),
      );
    });

  /* ─────────────────────────────── update ─────────────────────────────── */

  program
    .command("update", { isDefault: false })
    .aliases(["upgrade"])
    .description(
      "Update Brigade to the latest code + restart the gateway.\n" +
        "  Auto-detects how Brigade is installed:\n" +
        "    • npm global   → npm i -g @spinabot/brigade@latest, then restart\n" +
        "    • source clone → git pull (when clean) + npm install + build, then restart\n" +
        "  Examples:\n" +
        "    brigade update               # update + restart the gateway\n" +
        "    brigade update --check       # just report if newer code is available\n" +
        "    brigade update --no-restart  # update but leave the gateway for a manual restart",
    )
    .option("--check", "report current vs latest without changing anything", false)
    .option("--no-restart", "update but don't restart the gateway")
    .action(async (opts: { check?: boolean; restart?: boolean }) => {
      const { runUpdateCommand } = await import("../commands/update.js");
      // Commander maps `--no-restart` to `restart: false`.
      await exitAfterFlush(await runUpdateCommand({ check: opts.check, noRestart: opts.restart === false }));
    });

  /* ─────────────────────────────── config ─────────────────────────────── */
  // `brigade config <list|get|set|unset|file>`. No schema/validate
  // subcommands — Brigade's TypeBox schema is private and validation
  // runs automatically on every write.
  const cfg = program.command("config").description("Read or modify your Brigade configuration");

  cfg
    .command("list")
    .description("Print the full config (secrets redacted)")
    .option("--json", "emit JSON only (no header)", false)
    .option("--no-redact", "show raw values including secrets (use carefully)", false)
    .action(async (opts: { json?: boolean; redact?: boolean }) => {
      const { runConfigList } = await import("../commands/config-cmd.js");
      await exitAfterFlush(await runConfigList({ json: opts.json, noRedact: opts.redact === false }));
    });

  cfg
    .command("get <path>")
    .description(
      "Read a value by dot-notation key.\n" +
        "  Examples:\n" +
        "    brigade config get agents.defaults.provider\n" +
        "    brigade config get agents.defaults.model.fallbacks[0]\n" +
        '    brigade config get \'secrets.providers["my.vault"]\'',
    )
    .option("--json", "emit JSON instead of bare-string output", false)
    .action(async (rawPath: string, opts: { json?: boolean }) => {
      const { runConfigGet } = await import("../commands/config-cmd.js");
      await exitAfterFlush(await runConfigGet(rawPath, { json: opts.json }));
    });

  cfg
    .command("set <path> <value>")
    .description(
      "Write a value (JSON5-parsed by default; falls back to string).\n" +
        "  Examples:\n" +
        "    brigade config set agents.defaults.provider openai\n" +
        "    brigade config set agents.defaults.thinking medium\n" +
        '    brigade config set agents.defaults.model.fallbacks \'["claude-sonnet-4-6", "gpt-5"]\'\n' +
        "    brigade config set gateway.port 7777 --strict-json",
    )
    .option("--strict-json", "require strict JSON syntax for the value", false)
    .option("--dry-run", "show what would be written without persisting", false)
    .option("--json", "emit JSON status instead of human text", false)
    .action(async (rawPath: string, rawValue: string, opts: { strictJson?: boolean; dryRun?: boolean; json?: boolean }) => {
      const { runConfigSet } = await import("../commands/config-cmd.js");
      await exitAfterFlush(
        await runConfigSet(rawPath, rawValue, {
          strictJson: opts.strictJson,
          dryRun: opts.dryRun,
          json: opts.json,
        }),
      );
    });

  cfg
    .command("unset <path>")
    .description(
      "Remove a key by dot-notation path.\n" +
        "  Example: brigade config unset agents.defaults.thinking",
    )
    .option("--json", "emit JSON status instead of human text", false)
    .action(async (rawPath: string, opts: { json?: boolean }) => {
      const { runConfigUnset } = await import("../commands/config-cmd.js");
      await exitAfterFlush(await runConfigUnset(rawPath, { json: opts.json }));
    });

  cfg
    .command("file")
    .description("Print the absolute path to your Brigade config file")
    .option("--json", "emit JSON instead of bare-path output", false)
    .action(async (opts: { json?: boolean }) => {
      const { runConfigFile } = await import("../commands/config-cmd.js");
      await exitAfterFlush(await runConfigFile({ json: opts.json }));
    });

  cfg
    .command("schema")
    .description("Print the Brigade config TypeBox schema as JSON")
    .action(async () => {
      const { runConfigSchema } = await import("../commands/config-cmd.js");
      await exitAfterFlush(await runConfigSchema());
    });

  cfg
    .command("validate")
    .description("Validate your Brigade config against the schema; exit non-zero on issues")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runConfigValidate } = await import("../commands/config-cmd.js");
      await exitAfterFlush(await runConfigValidate({ json: opts.json }));
    });

  /* ───────────────────────────── channels ───────────────────────────── */
  // Manage messaging channels (WhatsApp today, more later). `link` runs the
  // adapter directly to pair a device — the gateway must be stopped first so
  // the two don't fight over the same socket. `enable`/`disable` only touch
  // brigade.json (cheap; the gateway picks up the flag on next boot/reload).
  const channels = program
    .command("channels")
    .description("Manage messaging channels (link, status, enable/disable)");

  channels
    .command("list")
    .description("List every available channel with its enabled/linked status")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runChannelsList } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsList({ json: opts.json }));
    });

  channels
    .command("status")
    .description("Show one channel's enabled / linked / configured / authDir / gateway state")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsStatus } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsStatus({ channel: opts.channel }, { json: opts.json }));
    });

  channels
    .command("link")
    .description(
      "Pair a device with a channel (e.g. scan a WhatsApp QR).\n" +
        "  Requires the gateway to be stopped so the channel socket isn't shared.\n" +
        "  Use --force to overwrite an existing link or recover from an interrupted previous link.\n" +
        "  Example: brigade channels link --channel whatsapp",
    )
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--timeout <ms>", "max time to wait for pairing (default 180000)", (v) => parseInt(v, 10))
    .option("--force", "clear any previous link state and start a fresh pair", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; timeout?: number; force?: boolean; json?: boolean }) => {
      const { runChannelsLink } = await import("../commands/channels.js");
      await exitAfterFlush(
        await runChannelsLink(
          { channel: opts.channel, timeoutMs: opts.timeout, force: opts.force },
          { json: opts.json },
        ),
      );
    });

  channels
    .command("unlink")
    .description(
      "Disable a channel and erase its on-disk auth state.\n" +
        "  Requires the gateway to be stopped.",
    )
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("-y, --yes", "skip the confirmation prompt", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; yes?: boolean; json?: boolean }) => {
      const { runChannelsUnlink } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsUnlink({ channel: opts.channel, yes: opts.yes }, { json: opts.json }));
    });

  channels
    .command("enable")
    .description("Enable this channel in your Brigade config (no link)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsEnable } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsEnable({ channel: opts.channel }, { json: opts.json }));
    });

  channels
    .command("disable")
    .description("Disable this channel in your Brigade config (credentials untouched)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsDisable } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsDisable({ channel: opts.channel }, { json: opts.json }));
    });

  // `channels allow <list|add|remove>` — manage the per-channel allow-from list.
  // Pairs with `brigade pairing approve <CODE>` (which adds approved senders).
  const channelsAllow = channels
    .command("allow")
    .description("Manage the per-channel allow-from list (senders permitted to DM the agent)");

  channelsAllow
    .command("list")
    .description("Print the channel's allow-from list")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsAllowList } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsAllowList({ channel: opts.channel }, { json: opts.json }));
    });

  channelsAllow
    .command("add <id>")
    .description("Add a sender to the allow-from list (e.g. an E.164 phone number)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { channel?: string; json?: boolean }) => {
      const { runChannelsAllowAdd } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsAllowAdd({ id, channel: opts.channel }, { json: opts.json }));
    });

  channelsAllow
    .command("remove <id>")
    .description("Remove a sender from the allow-from list")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { channel?: string; json?: boolean }) => {
      const { runChannelsAllowRemove } = await import("../commands/channels.js");
      await exitAfterFlush(await runChannelsAllowRemove({ id, channel: opts.channel }, { json: opts.json }));
    });

  // `channels add` — credential-prompt wizard for token-based channels
  // (Slack/Telegram/Discord shape). Each adapter declares its credential
  // keys via `setup.credentialKeys`; the wizard prompts for each in turn,
  // honours env-var pre-fills, and persists into brigade.json. WhatsApp
  // and other QR/OAuth channels redirect operators to `channels link`.
  channels
    .command("add")
    .description(
      "Walk the channel's setup wizard and save credentials to your Brigade config.\n" +
        "  QR/OAuth channels (e.g. WhatsApp) use `channels link` instead.\n" +
        "  Examples:\n" +
        "    brigade channels add --channel slack\n" +
        "    brigade channels add --channel slack --non-interactive   # env-vars only",
    )
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option(
      "--non-interactive",
      "fail unless every credential is provided via its declared env var (CI mode)",
      false,
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; nonInteractive?: boolean; json?: boolean }) => {
      const { runChannelsAdd } = await import("../commands/channels.js");
      await exitAfterFlush(
        await runChannelsAdd(
          { channel: opts.channel, nonInteractive: opts.nonInteractive },
          { json: opts.json },
        ),
      );
    });

  /* ───────────────────────────── sessions ───────────────────────────── */
  // Inspect + GC the JSONL transcripts under ~/.brigade/agents/<id>/sessions/.
  const sessions = program
    .command("sessions")
    .description("List + clean up agent session transcripts");

  sessions
    .command("list")
    .description("Show every session for an agent (newest first)")
    .option("--agent <id>", "agent id (default: main)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { agent?: string; json?: boolean }) => {
      const { runSessionsList } = await import("../commands/sessions.js");
      await exitAfterFlush(await runSessionsList({ agent: opts.agent }, { json: opts.json }));
    });

  sessions
    .command("cleanup")
    .description("Delete session transcripts older than --older-than (e.g. 30d / 12h)")
    .requiredOption("--older-than <duration>", "max age before a session is deleted (e.g. 30d)")
    .option("--agent <id>", "agent id (default: main)")
    .option("--dry-run", "show what would be deleted without removing anything", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { agent?: string; olderThan: string; dryRun?: boolean; json?: boolean }) => {
      const { runSessionsCleanup } = await import("../commands/sessions.js");
      await exitAfterFlush(
        await runSessionsCleanup(
          { agent: opts.agent, olderThan: opts.olderThan, dryRun: opts.dryRun },
          { json: opts.json },
        ),
      );
    });

  /* ───────────────────────────── skills ───────────────────────────── */
  const skills = program.command("skills").description("Inspect installed Brigade skills");
  skills
    .command("list")
    .description("Show every discovered skill (bundled + workspace)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runSkillsList } = await import("../commands/skills.js");
      await exitAfterFlush(await runSkillsList({ json: opts.json }));
    });
  skills
    .command("info <name>")
    .description("Print a skill's full body (SKILL.md)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      const { runSkillsInfo } = await import("../commands/skills.js");
      await exitAfterFlush(await runSkillsInfo({ name }, { json: opts.json }));
    });

  /* ───────────────────────────── video ───────────────────────────── */
  // `brigade video <install|status>` — the OPTIONAL motion-graphics render engine.
  // NOT an extension: no manifest, nothing to load, just a plain npm library Brigade
  // drives programmatically. It installs into `~/.brigade/engines`, a directory
  // Brigade owns and gives its own package.json, because `npm i @hyperframes/producer`
  // run from the operator's shell walks UP to the first package.json it finds — their
  // home directory — and leaves the engine where Brigade will never resolve it.
  const video = program
    .command("video")
    .description("Manage the optional motion-graphics render engine (`render_video`)");

  video
    .command("install")
    .description(
      "Install the render engine so the `render_video` tool becomes available.\n" +
        "  Examples:\n" +
        "    brigade video install           # install into ~/.brigade/engines\n" +
        "    brigade video install --force   # reinstall even if already present\n" +
        "    brigade video install --json    # machine-readable",
    )
    .option("--force", "reinstall even when the engine already resolves", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { force?: boolean; json?: boolean }) => {
      const { runVideoInstallCommand } = await import("../commands/video.js");
      await exitAfterFlush(await runVideoInstallCommand({ force: opts.force, json: opts.json }));
    });

  video
    .command("status")
    .description("Report whether `render_video` is available, and what is missing")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runVideoStatusCommand } = await import("../commands/video.js");
      await exitAfterFlush(await runVideoStatusCommand({ json: opts.json }));
    });

  /* ───────────────────────────── extensions ───────────────────────────── */
  // `brigade extensions <list|doctor|init>` — author + operator surface over
  // the extension engine. `list`/`doctor` only read the filesystem extensions
  // dir; `init` scaffolds a starter module into it. None touch the gateway or
  // the storage backend.
  const extensions = program
    .command("extensions")
    .description("Inspect and scaffold Brigade extensions (add-on plugins)");

  extensions
    .command("list")
    .description("List every extension (built-in + your own) with whether it loaded")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runExtensionsList } = await import("../commands/extensions.js");
      await exitAfterFlush(await runExtensionsList({ json: opts.json }));
    });

  extensions
    .command("doctor")
    .description("Diagnose why one of your extensions did or didn't load")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runExtensionsDoctor } = await import("../commands/extensions.js");
      await exitAfterFlush(await runExtensionsDoctor({ json: opts.json }));
    });

  extensions
    .command("init <id>")
    .description(
      "Scaffold a starter extension into your extensions folder.\n" +
        "  Examples:\n" +
        "    brigade extensions init my-channel\n" +
        "    brigade extensions init my-tool --kind tool\n" +
        "    brigade extensions init my-search --kind provider",
    )
    .option("--kind <kind>", "channel | tool | provider (default: channel)", "channel")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { kind?: string; json?: boolean }) => {
      const { runExtensionsInit } = await import("../commands/extensions.js");
      await exitAfterFlush(await runExtensionsInit({ id, kind: opts.kind }, { json: opts.json }));
    });

  extensions
    .command("add <source>")
    .description(
      "Install an extension from a folder, an npm package, or a git URL.\n" +
        "  Runs a compatibility check + a security scan; you confirm before it's kept.\n" +
        "  Examples:\n" +
        "    brigade extensions add ./my-plugin\n" +
        "    brigade extensions add brigade-plugin-weather@1.2.0\n" +
        "    brigade extensions add https://github.com/acme/brigade-plugin.git\n" +
        "    brigade extensions add ./my-plugin --force   # replace an existing one\n" +
        "    brigade extensions add ./my-plugin --yes     # accept the scan non-interactively",
    )
    .option("--force", "replace an extension of the same name if one is already installed", false)
    .option("-y, --yes", "accept the security-scan findings without prompting (non-interactive)", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (source: string, opts: { force?: boolean; yes?: boolean; json?: boolean }) => {
      const { runExtensionsAdd } = await import("../commands/extensions.js");
      await exitAfterFlush(
        await runExtensionsAdd({ source, force: opts.force, yes: opts.yes }, { json: opts.json }),
      );
    });

  extensions
    .command("remove <id>")
    .alias("rm")
    .description(
      "Delete an installed extension from your extensions folder.\n" +
        "  Example: brigade extensions remove my-plugin",
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const { runExtensionsRemove } = await import("../commands/extensions.js");
      await exitAfterFlush(await runExtensionsRemove({ id }, { json: opts.json }));
    });

  /* ───────────────────────────── logs ───────────────────────────── */
  program
    .command("logs")
    .description("Tail today's gateway log file (--follow streams new lines)")
    .option("--follow", "follow appended lines (Ctrl+C to stop)", false)
    .option("--limit <n>", "how many trailing lines to print first (default 50)", (v) => parseInt(v, 10))
    .option("--json", "emit raw JSON lines instead of one-line formatted output", false)
    .action(async (opts: { follow?: boolean; limit?: number; json?: boolean }) => {
      const { runLogsCommand } = await import("../commands/logs.js");
      await exitAfterFlush(await runLogsCommand({ follow: opts.follow, limit: opts.limit }, { json: opts.json }));
    });

  /* ───────────────────────────── secrets ───────────────────────────── */
  const secrets = program
    .command("secrets")
    .description("Find suspected leaked credentials inside your Brigade install");
  secrets
    .command("audit")
    .description("Scan your Brigade install for plaintext-key shapes (sk-…, Bearer …, …)")
    .option("--strict", "exit non-zero on findings (CI mode)", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { strict?: boolean; json?: boolean }) => {
      const { runSecretsAudit } = await import("../commands/secrets-audit.js");
      await exitAfterFlush(await runSecretsAudit({ strict: opts.strict }, { json: opts.json }));
    });

  /* ───────────────────────────── pairing ───────────────────────────── */
  // `brigade pairing <list|approve|revoke>` — operator-side review of the
  // pending-code list. Strangers' DMs to a `pairing`-policy channel get an
  // 8-char code; the operator approves it here to add them to the allow-from
  // list, or revokes to drop without granting access.
  const pairing = program
    .command("pairing")
    .description("Review and approve/revoke pending channel pairing codes");

  pairing
    .command("list")
    .description("Show pending pairing codes for a channel")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runPairingList } = await import("../commands/pairing.js");
      await exitAfterFlush(await runPairingList({ channel: opts.channel }, { json: opts.json }));
    });

  pairing
    .command("approve <code>")
    .description("Approve a pending code (moves the sender into the allow-from list)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (code: string, opts: { channel?: string; json?: boolean }) => {
      const { runPairingApprove } = await import("../commands/pairing.js");
      await exitAfterFlush(await runPairingApprove({ code, channel: opts.channel }, { json: opts.json }));
    });

  pairing
    .command("revoke <code>")
    .description("Drop a pending code without approving it")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (code: string, opts: { channel?: string; json?: boolean }) => {
      const { runPairingRevoke } = await import("../commands/pairing.js");
      await exitAfterFlush(await runPairingRevoke({ code, channel: opts.channel }, { json: opts.json }));
    });

  /* ───────────────────────────── backup ───────────────────────────── */
  // Snapshot / verify / restore the entire ~/.brigade directory so an operator
  // can migrate hosts or disaster-recover. Refuses to run while the gateway is
  // alive (locks would fight) unless --force is passed.
  const backup = program
    .command("backup")
    .description("Snapshot, verify, and restore your Brigade install as a single .tar.gz");

  backup
    .command("create")
    .description("Write a sha256-manifest'd .tar.gz snapshot of your Brigade install")
    .option("--output <path>", "where to write the archive (default: ./brigade-backup-<ts>.tar.gz)")
    .option("--force", "back up even if the gateway is running (risk: torn writes)", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { output?: string; force?: boolean; json?: boolean }) => {
      const { runBackupCreate } = await import("../commands/backup.js");
      await exitAfterFlush(await runBackupCreate({ output: opts.output, force: opts.force }, { json: opts.json }));
    });

  backup
    .command("verify <archive>")
    .description("Re-hash every entry in an archive against its manifest; exit non-zero on mismatch")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (archive: string, opts: { json?: boolean }) => {
      const { runBackupVerify } = await import("../commands/backup.js");
      await exitAfterFlush(await runBackupVerify({ archive }, { json: opts.json }));
    });

  backup
    .command("restore <archive>")
    .description("Extract an archive into your Brigade install (or --target). Refuses if target exists without --force")
    .option("--target <path>", "where to extract (default: your Brigade install directory)")
    .option("--force", "overwrite an existing target / restore while gateway is running", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (archive: string, opts: { target?: string; force?: boolean; json?: boolean }) => {
      const { runBackupRestore } = await import("../commands/backup.js");
      await exitAfterFlush(
        await runBackupRestore({ archive, target: opts.target, force: opts.force }, { json: opts.json }),
      );
    });

  /* ───────────────────────────── exec ───────────────────────────── */
  // CRUD over the bash-tool approval allowlist at
  // ~/.brigade/exec-approvals.json. Brigade gates every bash command
  // through this list — agents cannot run shell commands until the
  // operator explicitly approves them with `brigade exec allow`.
  const exec = program
    .command("exec")
    .description("Manage the bash-tool approval allowlist used by Brigade");

  exec
    .command("list")
    .description("Print all approved commands + patterns")
    .option("--json", "emit JSON instead of human-readable text", false)
    .option("--agent <id>", "agent id whose allowlist to inspect", "main")
    .action(async (opts: { json?: boolean; agent?: string }) => {
      const { runExecList } = await import("../commands/exec-cmd.js");
      await exitAfterFlush(await runExecList({ json: opts.json, agentId: opts.agent }));
    });

  exec
    .command("allow <command...>")
    .description(
      "Approve an exact bash command.\n" +
        "  Example: brigade exec allow ls -la\n" +
        "  Tip: quote complex commands so the shell doesn't reinterpret them.",
    )
    .option("--json", "emit JSON status instead of human text", false)
    .option("--agent <id>", "agent id whose allowlist to mutate", "main")
    .action(async (parts: string[], opts: { json?: boolean; agent?: string }) => {
      const { runExecAllow } = await import("../commands/exec-cmd.js");
      await exitAfterFlush(await runExecAllow(parts.join(" "), { json: opts.json, agentId: opts.agent }));
    });

  exec
    .command("allow-pattern <regex>")
    .description(
      'Approve a regex pattern of bash commands.\n' +
        "  Examples:\n" +
        "    brigade exec allow-pattern '^git (status|diff|log)( |$)'\n" +
        "    brigade exec allow-pattern '^cat package\\.json$'",
    )
    .option("--json", "emit JSON status instead of human text", false)
    .option("--agent <id>", "agent id whose allowlist to mutate", "main")
    .action(async (regex: string, opts: { json?: boolean; agent?: string }) => {
      const { runExecAllowPattern } = await import("../commands/exec-cmd.js");
      await exitAfterFlush(await runExecAllowPattern(regex, { json: opts.json, agentId: opts.agent }));
    });

  exec
    .command("remove <value...>")
    .description(
      "Remove an exact command OR a pattern from the allowlist.\n" +
        "  Brigade looks in both commands AND patterns; if the value is in either, it's dropped.",
    )
    .option("--json", "emit JSON status instead of human text", false)
    .option("--agent <id>", "agent id whose allowlist to mutate", "main")
    .action(async (parts: string[], opts: { json?: boolean; agent?: string }) => {
      const { runExecRemove } = await import("../commands/exec-cmd.js");
      await exitAfterFlush(await runExecRemove(parts.join(" "), { json: opts.json, agentId: opts.agent }));
    });

  exec
    .command("deny-test <command...>")
    .description(
      "Show how the gate would classify a command (allow / prompt / deny).\n" +
        "  Useful for sanity-checking before approving.",
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .option("--agent <id>", "agent id whose allowlist to consult", "main")
    .action(async (parts: string[], opts: { json?: boolean; agent?: string }) => {
      const { runExecDenyTest } = await import("../commands/exec-cmd.js");
      await exitAfterFlush(await runExecDenyTest(parts.join(" "), { json: opts.json, agentId: opts.agent }));
    });

  exec
    .command("file")
    .description("Print the absolute path to exec-approvals.json")
    .option("--json", "emit JSON instead of bare-path output", false)
    .option("--agent <id>", "agent id whose allowlist path to print", "main")
    .action(async (opts: { json?: boolean; agent?: string }) => {
      const { runExecFile } = await import("../commands/exec-cmd.js");
      await exitAfterFlush(await runExecFile({ json: opts.json, agentId: opts.agent }));
    });

  // ──────────────── cron ────────────────
  // Scheduled jobs: list / add / edit / remove / enable / disable / run / runs / status.
  // All subcommands talk DIRECTLY to ~/.brigade/cron.json — the per-storePath
  // lock in cron/service/locked.ts serialises against a running gateway, so
  // there's no double-write race even with both processes touching the file.
  const cron = program.command("cron").description("Manage scheduled cron jobs");

  cron
    .command("status")
    .description("Show cron service status (job count, next wake time)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runCronStatus } = await import("../commands/cron.js");
      await exitAfterFlush(await runCronStatus({ json: opts.json }));
    });

  cron
    .command("list")
    .description("List cron jobs (enabled only by default)")
    .option("--all", "include disabled jobs", false)
    .option("--query <text>", "filter by name / description / id substring")
    .option("--limit <n>", "max rows (default 50, max 200)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { all?: boolean; query?: string; limit?: number; json?: boolean }) => {
      const { runCronList } = await import("../commands/cron.js");
      await exitAfterFlush(
        await runCronList({
          ...(opts.all !== undefined ? { all: opts.all } : {}),
          ...(opts.query !== undefined ? { query: opts.query } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  cron
    .command("add")
    .description("Add a cron job (one of --at / --every / --cron required, plus --message or --system-event)")
    .requiredOption("--name <name>", "human-readable label for this job")
    .option("--description <text>", "longer description shown by `cron list`")
    .option("--disabled", "create the job in disabled state", false)
    .option("--at <iso-or-ms>", "one-shot fire time (ISO 8601 or ms-epoch)")
    .option("--every <duration>", 'recurring interval, e.g. "5m" / "1h" / "30s"')
    .option("--cron <expr>", 'cron expression (5/6/7-field), e.g. "0 9 * * *"')
    .option("--tz <iana>", "timezone for --cron (default: host timezone)")
    .option("--target <target>", '"main" | "isolated" | "session:<id>" (default: by payload)')
    .option("--message <text>", "agent-turn payload — the prompt the cron sends to the model")
    .option("--system-event <text>", "system-event payload — text injected into the main session")
    .option("--model <id>", "model override for agent-turn payloads")
    .option("--thinking <level>", '"off" | "low" | "medium" | "high"')
    .option("--timeout-seconds <n>", "per-run timeout", (v) => parseInt(v, 10))
    .option("--tools <csv>", "comma-separated tool allowlist (agent-turn only)")
    .option("--light-context", "drop ALL workspace bootstrap files for a minimal prompt", false)
    .option("--deliver", "set delivery.mode to announce (default: by payload)", false)
    .option("--no-deliver", "set delivery.mode to none (silence)", false)
    .option("--channel <id>", "delivery channel id")
    .option("--to <recipient>", "delivery recipient (channel-specific)")
    .option("--account <id>", "delivery account id")
    .option("--best-effort-deliver", "tolerate delivery failures", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: CronAddCliOpts) => {
      const { runCronAdd } = await import("../commands/cron.js");
      const job = buildCronJobCreateFromCliOpts(opts);
      if (typeof job === "string") {
        process.stderr.write(`cron add: ${job}\n`);
        await exitAfterFlush(1);
        return; // unreachable at runtime; restores `job` narrowing for tsc
      }
      await exitAfterFlush(
        await runCronAdd({
          job,
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  cron
    .command("edit <jobId>")
    .description("Patch fields of an existing cron job")
    .option("--name <name>", "rename the job")
    .option("--description <text>", "set the description")
    .option("--enable", "enable the job", false)
    .option("--disable", "disable the job", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: CronEditCliOpts) => {
      const { runCronEdit } = await import("../commands/cron.js");
      const patch: CronJobPatchInput = {};
      if (opts.name !== undefined) patch.name = opts.name;
      if (opts.description !== undefined) patch.description = opts.description;
      if (opts.enable && opts.disable) {
        process.stderr.write("cron edit: --enable and --disable are mutually exclusive\n");
        await exitAfterFlush(1);
      }
      if (opts.enable) patch.enabled = true;
      if (opts.disable) patch.enabled = false;
      await exitAfterFlush(
        await runCronEdit({
          jobId,
          patch,
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  cron
    .command("rm <jobId>")
    .alias("remove")
    .alias("delete")
    .description("Delete a cron job")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const { runCronRemove } = await import("../commands/cron.js");
      await exitAfterFlush(
        await runCronRemove({ jobId, ...(opts.json !== undefined ? { json: opts.json } : {}) }),
      );
    });

  cron
    .command("enable <jobId>")
    .description("Enable a disabled cron job")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const { runCronEnable } = await import("../commands/cron.js");
      await exitAfterFlush(
        await runCronEnable({ jobId, ...(opts.json !== undefined ? { json: opts.json } : {}) }),
      );
    });

  cron
    .command("disable <jobId>")
    .description("Disable an enabled cron job")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const { runCronDisable } = await import("../commands/cron.js");
      await exitAfterFlush(
        await runCronDisable({ jobId, ...(opts.json !== undefined ? { json: opts.json } : {}) }),
      );
    });

  cron
    .command("run <jobId>")
    .description("Fire a cron job now (enqueues for the next gateway tick)")
    .option("--due", "only run if the job is past its next-fire time", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { due?: boolean; json?: boolean }) => {
      const { runCronRunCmd } = await import("../commands/cron.js");
      await exitAfterFlush(
        await runCronRunCmd({
          jobId,
          mode: opts.due ? "due" : "force",
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  cron
    .command("runs <jobId>")
    .description("Show cron run history (most-recent first)")
    .option("--limit <n>", "max entries (default 50)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { limit?: number; json?: boolean }) => {
      const { runCronRuns } = await import("../commands/cron.js");
      await exitAfterFlush(
        await runCronRuns({
          jobId,
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  /* ──────────────────────────── agents ──────────────────────────── */
  // CRUD over the isolated-agent surface: each agent has its own workspace,
  // auth profiles, exec allowlist, sessions, and optional channel/account
  // routing bindings. `brigade.json` stores agents as a keyed map under
  // `cfg.agents.<id>` and bindings under `cfg.bindings.entries[]`.
  //
  // Bare `brigade agents` defaults to `list` so a no-arg invocation shows
  // every configured agent (parity with the reference codebase shape).
  // `--bind` is repeatable: Commander collects every occurrence into an
  // array via the collectStrings accumulator below.
  const collectStrings = (value: string, previous: string[] = []): string[] => [...previous, value];
  const agents = program
    .command("agents")
    .description("Manage isolated agents (workspace + auth + routing)")
    .action(async () => {
      const { runAgentsList } = await import("../commands/agents-cmd.js");
      await exitAfterFlush(await runAgentsList({}));
    });

  agents
    .command("list")
    .description("List every configured agent (default subcommand)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .option("--bindings", "include routing bindings per agent", false)
    .action(async (opts: { json?: boolean; bindings?: boolean }) => {
      const { runAgentsList } = await import("../commands/agents-cmd.js");
      await exitAfterFlush(await runAgentsList({ json: opts.json, bindings: opts.bindings }));
    });

  agents
    .command("bindings")
    .description("List routing bindings (optionally filtered by --agent)")
    .option("--agent <id>", "show bindings owned by this agent only")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { agent?: string; json?: boolean }) => {
      const { runAgentsBindings } = await import("../commands/agents-cmd.js");
      await exitAfterFlush(
        await runAgentsBindings({
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  agents
    .command("bind")
    .description("Claim channel/account routing slots for an agent")
    .requiredOption("--agent <id>", "agent id to bind slots to")
    .option(
      "--bind <spec>",
      'binding spec — "<channel>" or "<channel>:<accountId>" (repeatable)',
      collectStrings,
      [],
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { agent: string; bind: string[]; json?: boolean }) => {
      const { runAgentsBind } = await import("../commands/agents-cmd.js");
      await exitAfterFlush(
        await runAgentsBind({
          agent: opts.agent,
          bind: opts.bind,
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  agents
    .command("unbind")
    .description("Release channel/account routing slots from an agent")
    .requiredOption("--agent <id>", "agent id to unbind slots from")
    .option(
      "--bind <spec>",
      'binding spec — "<channel>" or "<channel>:<accountId>" (repeatable)',
      collectStrings,
      [],
    )
    .option("--all", "remove every binding owned by --agent", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { agent: string; bind: string[]; all?: boolean; json?: boolean }) => {
      const { runAgentsUnbind } = await import("../commands/agents-cmd.js");
      await exitAfterFlush(
        await runAgentsUnbind({
          agent: opts.agent,
          bind: opts.bind,
          ...(opts.all !== undefined ? { all: opts.all } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  agents
    .command("add [name]")
    .description("Create a new isolated agent (defaults workspace to ~/.brigade/agents/<id>/workspace/)")
    .option(
      "--workspace <dir>",
      "workspace directory for this agent (default: ~/.brigade/agents/<id>/workspace/)",
    )
    .option("--model <id>", "default model for this agent")
    .option("--provider <id>", "default provider for this agent")
    .option("--agent-dir <dir>", "override the on-disk agent directory")
    .option(
      "--bind <spec>",
      'attach a channel/account binding at create time (repeatable)',
      collectStrings,
      [],
    )
    .option("--non-interactive", "explicit flag for the CI/automation path", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(
      async (
        name: string | undefined,
        opts: {
          workspace?: string;
          model?: string;
          provider?: string;
          agentDir?: string;
          bind: string[];
          nonInteractive?: boolean;
          json?: boolean;
        },
      ) => {
        const { runAgentsAdd } = await import("../commands/agents-cmd.js");
        await exitAfterFlush(
          await runAgentsAdd({
            ...(name !== undefined ? { name } : {}),
            ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
            ...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
            bind: opts.bind,
            ...(opts.nonInteractive !== undefined ? { nonInteractive: opts.nonInteractive } : {}),
            ...(opts.json !== undefined ? { json: opts.json } : {}),
          }),
        );
      },
    );

  agents
    .command("set-identity")
    .description("Set or refresh an agent's identity (name / theme / emoji / avatar)")
    .requiredOption("--agent <id>", "agent id to update")
    .option("--workspace <dir>", "workspace directory whose IDENTITY.md to consult")
    .option("--identity-file <path>", "explicit IDENTITY.md path to read")
    .option("--from-identity", "load identity fields from IDENTITY.md in the workspace", false)
    .option("--name <name>", "display name override")
    .option("--theme <theme>", "theme override")
    .option("--emoji <emoji>", "emoji override")
    .option("--avatar <path>", "avatar path override")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(
      async (opts: {
        agent: string;
        workspace?: string;
        identityFile?: string;
        fromIdentity?: boolean;
        name?: string;
        theme?: string;
        emoji?: string;
        avatar?: string;
        json?: boolean;
      }) => {
        const { runAgentsSetIdentity } = await import("../commands/agents-cmd.js");
        await exitAfterFlush(
          await runAgentsSetIdentity({
            agent: opts.agent,
            ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
            ...(opts.identityFile !== undefined ? { identityFile: opts.identityFile } : {}),
            ...(opts.fromIdentity !== undefined ? { fromIdentity: opts.fromIdentity } : {}),
            ...(opts.name !== undefined ? { name: opts.name } : {}),
            ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
            ...(opts.emoji !== undefined ? { emoji: opts.emoji } : {}),
            ...(opts.avatar !== undefined ? { avatar: opts.avatar } : {}),
            ...(opts.json !== undefined ? { json: opts.json } : {}),
          }),
        );
      },
    );

  agents
    .command("delete <id>")
    .description("Delete an agent + its workspace/sessions (requires --force)")
    .option("--force", "skip the safety prompt and actually delete", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { force?: boolean; json?: boolean }) => {
      const { runAgentsDelete } = await import("../commands/agents-cmd.js");
      await exitAfterFlush(
        await runAgentsDelete({
          id,
          ...(opts.force !== undefined ? { force: opts.force } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  /* ─────────────────────────────── org ─────────────────────────────── */
  // Stage C — `brigade org <init|show|explain|doctor>`. ADDITIVE: when
  // cfg.org is absent these commands either print a friendly "no org"
  // banner (show/explain/doctor) or seed a starter file (init). The
  // existing CLI surface is untouched; the four subcommands sit beside
  // `brigade agents` rather than replacing any field.
  const org = program
    .command("org")
    .description(
      "Manage the optional virtual-office layer (cfg.org). When unset, Brigade behaves exactly as before.",
    );

  org
    .command("init")
    .description("Write a starter cfg.org block + open $EDITOR on brigade.json")
    .option(
      "--template <id>",
      "starter template: solo | family | company | custom (default: solo)",
      "solo",
    )
    .option("--skip-editor", "do not spawn $EDITOR after writing", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { template: string; skipEditor?: boolean; json?: boolean }) => {
      const { runOrgInit } = await import("../commands/org-cmd.js");
      await exitAfterFlush(
        await runOrgInit({
          template: opts.template,
          ...(opts.skipEditor !== undefined ? { skipEditor: opts.skipEditor } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  org
    .command("show")
    .description("Print an ASCII tree of the current org (cfg.org)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runOrgShow } = await import("../commands/org-cmd.js");
      await exitAfterFlush(await runOrgShow({ ...(opts.json !== undefined ? { json: opts.json } : {}) }));
    });

  org
    .command("explain <from> <to>")
    .description(
      "Show whether `from` can talk to `to` and why (derivation chain or denial reason)",
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (from: string, to: string, opts: { json?: boolean }) => {
      const { runOrgExplain } = await import("../commands/org-cmd.js");
      await exitAfterFlush(
        await runOrgExplain({ from, to, ...(opts.json !== undefined ? { json: opts.json } : {}) }),
      );
    });

  org
    .command("doctor")
    .description("Run the org lints (single-member dept, dangling overrides, depth > 5, …)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runOrgDoctor } = await import("../commands/org-cmd.js");
      await exitAfterFlush(await runOrgDoctor({ ...(opts.json !== undefined ? { json: opts.json } : {}) }));
    });

  /* ─────────────────────────────── store ─────────────────────────────── */
  // Phase 2 storage toggle — inspect or flip the mode.sentinel that pins
  // Brigade to filesystem vs convex. `brigade store mode show` reports the
  // active mode (and probes the URL on convex mode in `brigade doctor`).
  // `brigade store mode set <mode>` rewrites the sentinel. Data migration
  // between modes lands as `brigade store migrate` in a later PR.
  const store = program
    .command("store")
    .description("Inspect or flip Brigade's storage backend (filesystem / convex)");

  const storeMode = store.command("mode").description("Manage the storage-mode sentinel");

  storeMode
    .command("show")
    .description("Print the active storage mode (and Convex URL if applicable)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runStoreModeShow } = await import("../commands/store-cmd.js");
      await exitAfterFlush(await runStoreModeShow({ ...(opts.json !== undefined ? { json: opts.json } : {}) }));
    });

  storeMode
    .command("set <mode>")
    .description(
      "Pin the storage mode for this machine.\n" +
        "  Examples:\n" +
        "    brigade store mode set filesystem\n" +
        "    brigade store mode set convex --convex-url http://127.0.0.1:3210",
    )
    .option("--convex-url <url>", "deployment URL (required when <mode> is convex)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (mode: string, opts: { convexUrl?: string; json?: boolean }) => {
      const { runStoreModeSet } = await import("../commands/store-cmd.js");
      await exitAfterFlush(
        await runStoreModeSet({
          mode,
          ...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  store
    .command("reset")
    .description(
      "Factory-reset the convex backend: permanently erase every stored record,\n" +
        "remove the mode pin, and set the encryption key aside so the next onboard\n" +
        "starts truly fresh. (Wiping ~/.brigade alone RESTORES — this erases.)",
    )
    .option("--convex-url <url>", "deployment URL (defaults to the pinned sentinel URL)")
    .option("--yes", "skip the interactive confirmation", false)
    .option("--purge-local", "also delete the local Brigade folder", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { convexUrl?: string; yes?: boolean; purgeLocal?: boolean; json?: boolean }) => {
      const { runStoreReset } = await import("../commands/store-cmd.js");
      await exitAfterFlush(
        await runStoreReset({
          ...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
          ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
          ...(opts.purgeLocal !== undefined ? { purgeLocal: opts.purgeLocal } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
    });

  /* ───────────────────────────── encrypt ───────────────────────────── */
  // At-rest encryption for Convex byte columns. Operator-supplied master
  // key via `BRIGADE_ENCRYPTION_KEY` (hex). When unset, payloads pass
  // through unencrypted; when set, every credential / persona / memory
  // fact / cron payload / transcript record is sealed before it hits the
  // backend. See src/storage/encryption.ts.
  const encrypt = program
    .command("encrypt")
    .description("Manage Brigade's at-rest encryption key (AES-256-GCM)");

  encrypt
    .command("status")
    .description("Report whether the encryption key is configured + run a self-check")
    .option("--json", "emit JSON instead of human text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runEncryptStatus } = await import("../commands/encrypt-cmd.js");
      await exitAfterFlush(await runEncryptStatus(opts));
    });

  encrypt
    .command("init")
    .description("Generate a fresh 32-byte master key")
    .option("--json", "emit JSON instead of human text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runEncryptInit } = await import("../commands/encrypt-cmd.js");
      await exitAfterFlush(await runEncryptInit(opts));
    });

  encrypt
    .command("test")
    .description("Round-trip a sample string through seal/open to verify the key")
    .option("--json", "emit JSON instead of human text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runEncryptTest } = await import("../commands/encrypt-cmd.js");
      await exitAfterFlush(await runEncryptTest(opts));
    });

  store
    .command("migrate")
    .description(
      "Copy your Brigade data between storage backends.\n" +
        "  Examples:\n" +
        "    brigade store migrate --to convex --convex-url http://127.0.0.1:3210\n" +
        "    brigade store migrate --to filesystem\n" +
        "    brigade store migrate --to convex --dry-run",
    )
    .requiredOption("--to <mode>", "destination mode: filesystem | convex")
    .option("--convex-url <url>", "deployment URL")
    .option("--dry-run", "report what would be copied without writing", false)
    .option("--skip-verify", "skip sha256 verification (faster)", false)
    .option(
      "--keep-source",
      "after --to convex, keep the local filesystem copy (default: wipe it once the copy is verified)",
      false,
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(
      async (opts: {
        to: string;
        convexUrl?: string;
        dryRun?: boolean;
        skipVerify?: boolean;
        keepSource?: boolean;
        json?: boolean;
      }) => {
        const { runStoreMigrateCmd } = await import("../commands/store-cmd.js");
        await exitAfterFlush(
          await runStoreMigrateCmd({
            to: opts.to,
            ...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
            ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
            ...(opts.skipVerify !== undefined ? { skipVerify: opts.skipVerify } : {}),
            ...(opts.keepSource !== undefined ? { keepSource: opts.keepSource } : {}),
            ...(opts.json !== undefined ? { json: opts.json } : {}),
          }),
        );
      },
    );

  // `brigade mcp` — serve this agent's long-term memory as an MCP server over
  // stdio (add / search / context), owner-bound. Point an MCP client at
  // `brigade mcp` as the command.
  program
    .command("mcp")
    .description(
      "Serve your long-term memory as an MCP server over stdio (add / search / context).\n" +
        "  Point an MCP client at:  brigade mcp",
    )
    .option("--agent <id>", "agent whose memory to serve (default: main)")
    .action(async (opts: { agent?: string }) => {
      const { runMemoryMcpServerCli } = await import("../commands/mcp-cmd.js");
      await exitAfterFlush(await runMemoryMcpServerCli({ ...(opts.agent ? { agentId: opts.agent } : {}) }));
    });

  /* ─────────────────────────────── convex ─────────────────────────────── */
  // `brigade convex <dev|start|status|stop|push|codegen>` — drive the bundled
  // self-hosted Convex backend that powers convex storage mode. The binaries +
  // orchestrator scripts ship inside the package, so these work both in a repo
  // checkout and from a global install (any cwd). `dev` runs in the foreground
  // (Ctrl-C to stop); it does NOT start the chat TUI.
  const convex = program
    .command("convex")
    .description("Run or manage the bundled self-hosted Convex backend (dev, status, push, …)");

  convex
    .command("dev")
    .description("Download the backend if needed, then run it + the dashboard in the foreground")
    .option("-h, --host <host>", "backend host (default: 127.0.0.1)")
    .option("-p, --port <port>", "backend port (default: 3210)", (v) => parseInt(v, 10))
    .action(async (opts: { host?: string; port?: number }) => {
      const { runConvexCommand } = await import("../commands/convex-cmd.js");
      await exitAfterFlush(await runConvexCommand({ action: "dev", host: opts.host, port: opts.port }));
    });

  convex
    .command("start")
    .description("Alias for `convex dev` — run the backend + dashboard in the foreground")
    .option("-h, --host <host>", "backend host (default: 127.0.0.1)")
    .option("-p, --port <port>", "backend port (default: 3210)", (v) => parseInt(v, 10))
    .action(async (opts: { host?: string; port?: number }) => {
      const { runConvexCommand } = await import("../commands/convex-cmd.js");
      await exitAfterFlush(await runConvexCommand({ action: "start", host: opts.host, port: opts.port }));
    });

  convex
    .command("status")
    .description("Probe the backend and report whether it is running")
    .option("-h, --host <host>", "backend host (default: 127.0.0.1)")
    .option("-p, --port <port>", "backend port (default: 3210)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { host?: string; port?: number; json?: boolean }) => {
      const { runConvexCommand } = await import("../commands/convex-cmd.js");
      await exitAfterFlush(
        await runConvexCommand({ action: "status", host: opts.host, port: opts.port, json: opts.json }),
      );
    });

  convex
    .command("stop")
    .description("Stop the backend + dashboard started by a previous `dev`/`start`")
    .option("-h, --host <host>", "backend host (default: 127.0.0.1)")
    .option("-p, --port <port>", "backend port (default: 3210)", (v) => parseInt(v, 10))
    .action(async (opts: { host?: string; port?: number }) => {
      const { runConvexCommand } = await import("../commands/convex-cmd.js");
      await exitAfterFlush(await runConvexCommand({ action: "stop", host: opts.host, port: opts.port }));
    });

  convex
    .command("push")
    .description("Deploy the bundled Convex functions to the running backend")
    .action(async () => {
      const { runConvexCommand } = await import("../commands/convex-cmd.js");
      await exitAfterFlush(await runConvexCommand({ action: "push" }));
    });

  convex
    .command("codegen")
    .description("Regenerate the Convex client (convex/_generated) against the running backend")
    .action(async () => {
      const { runConvexCommand } = await import("../commands/convex-cmd.js");
      await exitAfterFlush(await runConvexCommand({ action: "codegen" }));
    });

  return program;
}

/* ────────────────── cron CLI flag → CronJobCreate translation ─────────── */

interface CronAddCliOpts {
  name: string;
  description?: string;
  disabled?: boolean;
  at?: string;
  every?: string;
  cron?: string;
  tz?: string;
  target?: string;
  message?: string;
  systemEvent?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  tools?: string;
  lightContext?: boolean;
  deliver?: boolean;
  channel?: string;
  to?: string;
  account?: string;
  bestEffortDeliver?: boolean;
  json?: boolean;
}

interface CronEditCliOpts {
  name?: string;
  description?: string;
  enable?: boolean;
  disable?: boolean;
  json?: boolean;
}

interface CronJobPatchInput {
  name?: string;
  description?: string;
  enabled?: boolean;
}

/**
 * Translate the flat CLI flag set into a `CronJobCreate`. Returns the
 * structured object on success, or a string error message that the caller
 * prints to stderr before exiting non-zero. Validation of the schedule /
 * payload pairing happens server-side in `assertSupportedJobSpec`; this
 * helper just owns the flag-shape conversion.
 */
function buildCronJobCreateFromCliOpts(
  opts: CronAddCliOpts,
): import("../../cron/types.js").CronJobCreate | string {
  // Schedule resolution — exactly one of --at / --every / --cron.
  const scheduleKindsSpecified = [opts.at, opts.every, opts.cron].filter((v) => v !== undefined).length;
  if (scheduleKindsSpecified === 0) {
    return "one of --at, --every, or --cron must be provided";
  }
  if (scheduleKindsSpecified > 1) {
    return "only one of --at, --every, --cron may be provided";
  }
  let schedule: import("../../cron/types.js").CronSchedule;
  if (opts.at !== undefined) {
    const ms = parseAtSpec(opts.at);
    if (ms === null) return `invalid --at value: ${opts.at}`;
    schedule = { kind: "at", at: ms };
  } else if (opts.every !== undefined) {
    const ms = parseDurationToMs(opts.every);
    if (ms === null) return `invalid --every value: ${opts.every}`;
    schedule = { kind: "every", everyMs: ms };
  } else {
    schedule = {
      kind: "cron",
      expr: opts.cron!,
      ...(opts.tz !== undefined ? { tz: opts.tz } : {}),
    };
  }

  // Payload resolution — exactly one of --message / --system-event.
  if ((opts.message === undefined) === (opts.systemEvent === undefined)) {
    return "exactly one of --message or --system-event must be provided";
  }
  let payload: import("../../cron/types.js").CronPayload;
  if (opts.systemEvent !== undefined) {
    payload = { kind: "systemEvent", text: opts.systemEvent };
  } else {
    const thinking = (
      opts.thinking === "off" || opts.thinking === "low" ||
      opts.thinking === "medium" || opts.thinking === "high"
    ) ? opts.thinking : undefined;
    const toolsAllow = opts.tools
      ? opts.tools.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    payload = {
      kind: "agentTurn",
      message: opts.message!,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
      ...(toolsAllow !== undefined ? { toolsAllow } : {}),
      ...(opts.lightContext === true ? { lightContext: true } : {}),
    };
  }

  // sessionTarget — explicit override or fall back to the payload-driven default.
  let sessionTarget: import("../../cron/types.js").CronSessionTarget;
  if (opts.target !== undefined) {
    if (opts.target === "main" || opts.target === "isolated") {
      sessionTarget = opts.target;
    } else if (opts.target.startsWith("session:")) {
      sessionTarget = opts.target as `session:${string}`;
    } else {
      return `invalid --target value: ${opts.target} (expected "main" | "isolated" | "session:<id>")`;
    }
  } else {
    sessionTarget = payload.kind === "systemEvent" ? "main" : "isolated";
  }

  // Optional delivery block — only built when one of the flags was supplied.
  const hasDeliveryFlag = opts.deliver || opts.channel || opts.to || opts.account || opts.bestEffortDeliver;
  const delivery = hasDeliveryFlag
    ? {
        mode: (opts.deliver ? "announce" : "none") as "announce" | "none",
        ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(opts.account !== undefined ? { accountId: opts.account } : {}),
        ...(opts.bestEffortDeliver === true ? { bestEffort: true } : {}),
      }
    : undefined;

  return {
    name: opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    enabled: opts.disabled !== true,
    schedule,
    sessionTarget,
    payload,
    ...(delivery !== undefined ? { delivery } : {}),
  };
}

/**
 * Parse `--at` — accepts ISO 8601 (`2026-06-15T09:00:00Z`) OR raw ms-epoch.
 * Returns ms-since-epoch, or null on parse failure.
 */
function parseAtSpec(input: string): number | null {
  const trimmed = input.trim();
  // Try numeric first — operators frequently pipe `date +%s000` or similar.
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && trimmed.match(/^\d+$/)) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** Parse `--every 5m / 1h / 30s / 2w` → ms. Returns null on parse failure. */
function parseDurationToMs(input: string): number | null {
  const m = input.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const multiplier: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const mul = multiplier[unit];
  if (mul === undefined) return null;
  return n * mul;
}
