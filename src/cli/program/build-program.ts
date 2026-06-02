import { Command } from "commander";

import { formatVersion } from "../../version.js";

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

  // OS-service installer: macOS launchd / Linux systemd-user / Windows Task
  // Scheduler. The supervisor IS the restart loop; the gateway survives reboots
  // and crashes via the OS-native mechanism.
  gw.command("install")
    .description("Install Brigade as an OS service (launchd / systemd / Task Scheduler)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayInstall } = await import("../commands/gateway-install.js");
      process.exit(await runGatewayInstall({ json: opts.json }));
    });

  gw.command("uninstall")
    .description("Remove the OS-service registration (the unit file and the supervisor entry)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayUninstall } = await import("../commands/gateway-install.js");
      process.exit(await runGatewayUninstall({ json: opts.json }));
    });

  gw.command("restart")
    .description("Restart the installed Brigade service (stop + start)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runGatewayRestart } = await import("../commands/gateway-install.js");
      process.exit(await runGatewayRestart({ json: opts.json }));
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
      process.exit(
        await runDoctorCommand({ host: opts.host, port: opts.port, json: opts.json, strict: opts.strict }),
      );
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
    .description("Print the absolute path to your Brigade config file")
    .option("--json", "emit JSON instead of bare-path output", false)
    .action(async (opts: { json?: boolean }) => {
      const { runConfigFile } = await import("../commands/config-cmd.js");
      process.exit(await runConfigFile({ json: opts.json }));
    });

  cfg
    .command("schema")
    .description("Print the Brigade config TypeBox schema as JSON")
    .action(async () => {
      const { runConfigSchema } = await import("../commands/config-cmd.js");
      process.exit(await runConfigSchema());
    });

  cfg
    .command("validate")
    .description("Validate your Brigade config against the schema; exit non-zero on issues")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { json?: boolean }) => {
      const { runConfigValidate } = await import("../commands/config-cmd.js");
      process.exit(await runConfigValidate({ json: opts.json }));
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
      process.exit(await runChannelsList({ json: opts.json }));
    });

  channels
    .command("status")
    .description("Show one channel's enabled / linked / configured / authDir / gateway state")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsStatus } = await import("../commands/channels.js");
      process.exit(await runChannelsStatus({ channel: opts.channel }, { json: opts.json }));
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
      process.exit(
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
      process.exit(await runChannelsUnlink({ channel: opts.channel, yes: opts.yes }, { json: opts.json }));
    });

  channels
    .command("enable")
    .description("Enable this channel in your Brigade config (no link)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsEnable } = await import("../commands/channels.js");
      process.exit(await runChannelsEnable({ channel: opts.channel }, { json: opts.json }));
    });

  channels
    .command("disable")
    .description("Disable this channel in your Brigade config (credentials untouched)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsDisable } = await import("../commands/channels.js");
      process.exit(await runChannelsDisable({ channel: opts.channel }, { json: opts.json }));
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
      process.exit(await runChannelsAllowList({ channel: opts.channel }, { json: opts.json }));
    });

  channelsAllow
    .command("add <id>")
    .description("Add a sender to the allow-from list (e.g. an E.164 phone number)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { channel?: string; json?: boolean }) => {
      const { runChannelsAllowAdd } = await import("../commands/channels.js");
      process.exit(await runChannelsAllowAdd({ id, channel: opts.channel }, { json: opts.json }));
    });

  channelsAllow
    .command("remove <id>")
    .description("Remove a sender from the allow-from list")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (id: string, opts: { channel?: string; json?: boolean }) => {
      const { runChannelsAllowRemove } = await import("../commands/channels.js");
      process.exit(await runChannelsAllowRemove({ id, channel: opts.channel }, { json: opts.json }));
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
      process.exit(
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
      process.exit(await runSessionsList({ agent: opts.agent }, { json: opts.json }));
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
      process.exit(
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
      process.exit(await runSkillsList({ json: opts.json }));
    });
  skills
    .command("info <name>")
    .description("Print a skill's full body (SKILL.md)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      const { runSkillsInfo } = await import("../commands/skills.js");
      process.exit(await runSkillsInfo({ name }, { json: opts.json }));
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
      process.exit(await runLogsCommand({ follow: opts.follow, limit: opts.limit }, { json: opts.json }));
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
      process.exit(await runSecretsAudit({ strict: opts.strict }, { json: opts.json }));
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
      process.exit(await runPairingList({ channel: opts.channel }, { json: opts.json }));
    });

  pairing
    .command("approve <code>")
    .description("Approve a pending code (moves the sender into the allow-from list)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (code: string, opts: { channel?: string; json?: boolean }) => {
      const { runPairingApprove } = await import("../commands/pairing.js");
      process.exit(await runPairingApprove({ code, channel: opts.channel }, { json: opts.json }));
    });

  pairing
    .command("revoke <code>")
    .description("Drop a pending code without approving it")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (code: string, opts: { channel?: string; json?: boolean }) => {
      const { runPairingRevoke } = await import("../commands/pairing.js");
      process.exit(await runPairingRevoke({ code, channel: opts.channel }, { json: opts.json }));
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
      process.exit(await runBackupCreate({ output: opts.output, force: opts.force }, { json: opts.json }));
    });

  backup
    .command("verify <archive>")
    .description("Re-hash every entry in an archive against its manifest; exit non-zero on mismatch")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (archive: string, opts: { json?: boolean }) => {
      const { runBackupVerify } = await import("../commands/backup.js");
      process.exit(await runBackupVerify({ archive }, { json: opts.json }));
    });

  backup
    .command("restore <archive>")
    .description("Extract an archive into your Brigade install (or --target). Refuses if target exists without --force")
    .option("--target <path>", "where to extract (default: your Brigade install directory)")
    .option("--force", "overwrite an existing target / restore while gateway is running", false)
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (archive: string, opts: { target?: string; force?: boolean; json?: boolean }) => {
      const { runBackupRestore } = await import("../commands/backup.js");
      process.exit(
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
      process.exit(await runExecList({ json: opts.json, agentId: opts.agent }));
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
      process.exit(await runExecAllow(parts.join(" "), { json: opts.json, agentId: opts.agent }));
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
      process.exit(await runExecAllowPattern(regex, { json: opts.json, agentId: opts.agent }));
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
      process.exit(await runExecRemove(parts.join(" "), { json: opts.json, agentId: opts.agent }));
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
      process.exit(await runExecDenyTest(parts.join(" "), { json: opts.json, agentId: opts.agent }));
    });

  exec
    .command("file")
    .description("Print the absolute path to exec-approvals.json")
    .option("--json", "emit JSON instead of bare-path output", false)
    .option("--agent <id>", "agent id whose allowlist path to print", "main")
    .action(async (opts: { json?: boolean; agent?: string }) => {
      const { runExecFile } = await import("../commands/exec-cmd.js");
      process.exit(await runExecFile({ json: opts.json, agentId: opts.agent }));
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
      process.exit(await runCronStatus({ json: opts.json }));
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
      process.exit(
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
        process.exit(1);
      }
      process.exit(
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
        process.exit(1);
      }
      if (opts.enable) patch.enabled = true;
      if (opts.disable) patch.enabled = false;
      process.exit(
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
      process.exit(
        await runCronRemove({ jobId, ...(opts.json !== undefined ? { json: opts.json } : {}) }),
      );
    });

  cron
    .command("enable <jobId>")
    .description("Enable a disabled cron job")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const { runCronEnable } = await import("../commands/cron.js");
      process.exit(
        await runCronEnable({ jobId, ...(opts.json !== undefined ? { json: opts.json } : {}) }),
      );
    });

  cron
    .command("disable <jobId>")
    .description("Disable an enabled cron job")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const { runCronDisable } = await import("../commands/cron.js");
      process.exit(
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
      process.exit(
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
      process.exit(
        await runCronRuns({
          jobId,
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        }),
      );
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
