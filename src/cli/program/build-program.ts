import { Command } from "commander";

import { formatVersion } from "../../version.js";

// Mirrors OpenClaw's lazy command-registration pattern. Each subcommand's
// real body (action handler) lives in a separate module under
// `src/cli/commands/`. Commander still needs each command DECLARED at the
// program level so `brigade --help` lists all of them, BUT the heavy import
// chain (Pi SDK init, model registry, TUI widgets, gateway server, ws
// stack, etc.) only loads when the user actually picks that command.
//
// In practice: `brigade onboard` doesn't pay for chat/gateway/connect's
// import time, and `brigade tui` doesn't pay for gateway's. The savings
// matter most on a cold `brigade --help` (now sub-100ms) and on
// short-lived invocations like `brigade --version` (handled by the
// fast-path in entry.ts before we even reach this builder).
//
// Primitive #1/#2 surface (onboard + agent + tui) is unchanged in shape;
// gateway + connect were lifted from the published v0.1.3 codebase. The
// status / doctor / config / gateway-subcommands surfaces match openclaw's
// `openclaw <status|doctor|config|gateway run|gateway status|gateway stop>`
// shape — Brigade-sized ports, no plugin/daemon-installer scope creep.

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("brigade")
    .description("Brigade — your personal AI crew")
    .version(formatVersion(), "-v, --version", "show brigade version");

  // exitOverride lets runMain decide how to surface help/no-args, instead of
  // Commander killing the process directly with exit(1).
  program.exitOverride();

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
      "how accepted env-keys persist: 'plaintext' (default, copies value into ~/.brigade/) or 'ref' (stores a keyRef; literal value never lands on disk)",
      "plaintext",
    )
    .action(async (opts: { envDetect?: boolean; secretInputMode?: string }) => {
      const { runOnboardCommand } = await import("../commands/onboard.js");
      const mode = opts.secretInputMode === "ref" ? "ref" : "plaintext";
      const code = await runOnboardCommand({
        noEnvDetect: opts.envDetect === false,
        secretInputMode: mode,
      });
      process.exit(code);
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
    .command("tui", { isDefault: true })
    .description("Launch the Brigade chat TUI (auto-starts the gateway if needed)")
    // Same Commander `--no-X` pattern as `onboard` above — no third arg.
    .option("--no-env-detect", "ignore API keys from the shell environment")
    .option("-h, --host <host>", "gateway host to connect to / spawn on (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port (default: 7777)", (v) => parseInt(v, 10))
    .action(async (opts: { envDetect?: boolean; host?: string; port?: number }) => {
      const { runChatCommand } = await import("../commands/chat.js");
      await runChatCommand({ noEnvDetect: opts.envDetect === false, host: opts.host, port: opts.port });
      // Hold the action handler open — `runChatCommand` resolves once the
      // editor is wired; without this pin, entry.ts's `process.exit(0)`
      // would kill the chat before the user could type. The chat itself
      // exits via process.exit() on /exit / Ctrl+D / two-Ctrl+C.
      await new Promise<void>(() => {});
    });

  /* ────────────────────── gateway parent + subcommands ────────────────────── */
  // Mirror of openclaw `openclaw gateway <run|status|stop|...>`. The bare
  // `brigade gateway` invocation stays back-compat — it dispatches to `run`.
  // status/stop are quick reads of port 7777 + the PID file, so they don't
  // need the Pi SDK or the gateway server module to load.
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
      process.exit(await runGatewayStatusCommand(opts));
    });

  gw.command("stop")
    .description("Send SIGTERM to the running gateway and wait for it to exit")
    .option("--timeout <ms>", "max ms to wait for shutdown (default: 5000)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { timeout?: number; json?: boolean }) => {
      const { runGatewayStopCommand } = await import("../commands/gateway.js");
      process.exit(await runGatewayStopCommand(opts));
    });

  /* ─────────────────────────────── connect ─────────────────────────────── */

  program
    .command("connect")
    .description(
      "Connect to a running Brigade gateway from a thin TUI client.\n" +
        "  Examples:\n" +
        "    brigade connect                          # default 127.0.0.1:7777\n" +
        "    brigade connect --host 192.168.1.5 -p 7777\n" +
        "    brigade connect --timeout 120000",
    )
    .option("-h, --host <host>", "gateway host (default: 127.0.0.1)")
    .option("-p, --port <port>", "gateway port", (v) => parseInt(v, 10))
    .option("--timeout <ms>", "request timeout in ms", (v) => parseInt(v, 10))
    .action(async (opts: { host?: string; port?: number; timeout?: number }) => {
      const { runConnectCommand } = await import("../commands/connect.js");
      await runConnectCommand({
        host: opts.host,
        port: opts.port,
        requestTimeoutMs: opts.timeout,
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
      "Run health checks against ~/.brigade/, providers, workspace, and the gateway.\n" +
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
      process.exit(
        await runDoctorCommand({ host: opts.host, port: opts.port, json: opts.json, strict: opts.strict }),
      );
    });

  /* ─────────────────────────────── config ─────────────────────────────── */
  // Mirror of openclaw `openclaw config <list|get|set|unset|file>`.
  // Brigade-shape: no schema/validate subcommands (Brigade's TypeBox
  // schema is private and validation runs automatically on every write).
  const cfg = program.command("config").description("Read or modify brigade.json");

  cfg
    .command("list")
    .description("Print the full config (secrets redacted)")
    .option("--json", "emit JSON only (no header)", false)
    .option("--no-redact", "show raw values including secrets (use carefully)", false)
    .action(async (opts: { json?: boolean; redact?: boolean }) => {
      const { runConfigList } = await import("../commands/config-cmd.js");
      process.exit(await runConfigList({ json: opts.json, noRedact: opts.redact === false }));
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
      process.exit(await runConfigGet(rawPath, { json: opts.json }));
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
      process.exit(
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
      process.exit(await runConfigUnset(rawPath, { json: opts.json }));
    });

  cfg
    .command("file")
    .description("Print the absolute path to brigade.json")
    .option("--json", "emit JSON instead of bare-path output", false)
    .action(async (opts: { json?: boolean }) => {
      const { runConfigFile } = await import("../commands/config-cmd.js");
      process.exit(await runConfigFile({ json: opts.json }));
    });

  cfg
    .command("schema")
    .description("Print the brigade.json TypeBox schema as JSON")
    .action(async () => {
      const { runConfigSchema } = await import("../commands/config-cmd.js");
      process.exit(await runConfigSchema());
    });

  cfg
    .command("validate")
    .description("Validate brigade.json against the schema; exit non-zero on issues")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runConfigValidate } = await import("../commands/config-cmd.js");
      process.exit(await runConfigValidate({ json: opts.json }));
    });

  /* ───────────────────────────── exec ───────────────────────────── */
  // CRUD over the bash-tool approval allowlist at
  // ~/.brigade/exec-approvals.json. Brigade gates every bash command
  // through this list — agents cannot run shell commands until the
  // operator explicitly approves them with `brigade exec allow`.
  const exec = program
    .command("exec")
    .description("Manage the bash-tool approval allowlist (~/.brigade/exec-approvals.json)");

  exec
    .command("list")
    .description("Print all approved commands + patterns")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runExecList } = await import("../commands/exec-cmd.js");
      process.exit(await runExecList({ json: opts.json }));
    });

  exec
    .command("allow <command...>")
    .description(
      "Approve an exact bash command.\n" +
        "  Example: brigade exec allow ls -la\n" +
        "  Tip: quote complex commands so the shell doesn't reinterpret them.",
    )
    .option("--json", "emit JSON status instead of human text", false)
    .action(async (parts: string[], opts: { json?: boolean }) => {
      const { runExecAllow } = await import("../commands/exec-cmd.js");
      process.exit(await runExecAllow(parts.join(" "), { json: opts.json }));
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
    .action(async (regex: string, opts: { json?: boolean }) => {
      const { runExecAllowPattern } = await import("../commands/exec-cmd.js");
      process.exit(await runExecAllowPattern(regex, { json: opts.json }));
    });

  exec
    .command("remove <value...>")
    .description(
      "Remove an exact command OR a pattern from the allowlist.\n" +
        "  Brigade looks in both commands AND patterns; if the value is in either, it's dropped.",
    )
    .option("--json", "emit JSON status instead of human text", false)
    .action(async (parts: string[], opts: { json?: boolean }) => {
      const { runExecRemove } = await import("../commands/exec-cmd.js");
      process.exit(await runExecRemove(parts.join(" "), { json: opts.json }));
    });

  exec
    .command("deny-test <command...>")
    .description(
      "Show how the gate would classify a command (allow / prompt / deny).\n" +
        "  Useful for sanity-checking before approving.",
    )
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (parts: string[], opts: { json?: boolean }) => {
      const { runExecDenyTest } = await import("../commands/exec-cmd.js");
      process.exit(await runExecDenyTest(parts.join(" "), { json: opts.json }));
    });

  exec
    .command("file")
    .description("Print the absolute path to exec-approvals.json")
    .option("--json", "emit JSON instead of bare-path output", false)
    .action(async (opts: { json?: boolean }) => {
      const { runExecFile } = await import("../commands/exec-cmd.js");
      process.exit(await runExecFile({ json: opts.json }));
    });

  return program;
}
