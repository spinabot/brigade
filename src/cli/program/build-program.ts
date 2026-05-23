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
        "  Example: brigade channels link --channel whatsapp",
    )
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--timeout <ms>", "max time to wait for pairing (default 180000)", (v) => parseInt(v, 10))
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; timeout?: number; json?: boolean }) => {
      const { runChannelsLink } = await import("../commands/channels.js");
      process.exit(
        await runChannelsLink({ channel: opts.channel, timeoutMs: opts.timeout }, { json: opts.json }),
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
    .description("Set channels.<id>.enabled=true in brigade.json (no link)")
    .option("--channel <id>", "channel id (auto-picked when only one is available)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel?: string; json?: boolean }) => {
      const { runChannelsEnable } = await import("../commands/channels.js");
      process.exit(await runChannelsEnable({ channel: opts.channel }, { json: opts.json }));
    });

  channels
    .command("disable")
    .description("Set channels.<id>.enabled=false in brigade.json (creds untouched)")
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

  // `channels add` — non-interactive provisioning for token-based channels.
  channels
    .command("add")
    .description("Provision a token-based channel non-interactively (Slack/Telegram/Discord shape)")
    .requiredOption("--channel <id>", "channel id (e.g. slack)")
    .option("--token <secret>", "auth token / api key")
    .option("--account <id>", "account id (multi-account channels)")
    .option("--set <kv...>", "extra key=value pairs (parsed JSON, falls back to string)")
    .option("--json", "emit JSON instead of human-readable text", false)
    .action(async (opts: { channel: string; token?: string; account?: string; set?: string[]; json?: boolean }) => {
      const { runChannelsAdd } = await import("../commands/channels.js");
      process.exit(
        await runChannelsAdd(
          { channel: opts.channel, token: opts.token, account: opts.account, set: opts.set },
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
    .description("Find suspected leaked credentials inside ~/.brigade");
  secrets
    .command("audit")
    .description("Scan ~/.brigade for plaintext-key shapes (sk-…, Bearer …, …)")
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
    .description("Snapshot, verify, and restore ~/.brigade as a single .tar.gz");

  backup
    .command("create")
    .description("Write a sha256-manifest'd .tar.gz snapshot of ~/.brigade")
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
    .description("Extract an archive into ~/.brigade (or --target). Refuses if target exists without --force")
    .option("--target <path>", "where to extract (default: ~/.brigade)")
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
