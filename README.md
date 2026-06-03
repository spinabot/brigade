<p align="center">
  <img src="https://raw.githubusercontent.com/Bhasvanth-Dev9380/brigade/main/assets/brigade-banner-on-black.gif" alt="BRIGADE — your personal AI crew" width="900" />
</p>

<p>
  <a href="https://github.com/Bhasvanth-Dev9380/brigade/actions/workflows/ci.yml"><img src="https://github.com/Bhasvanth-Dev9380/brigade/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@spinabot/brigade"><img src="https://img.shields.io/npm/v/@spinabot/brigade" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@spinabot/brigade"><img src="https://img.shields.io/npm/l/@spinabot/brigade" alt="license" /></a>
  <a href="https://www.npmjs.com/package/@spinabot/brigade"><img src="https://img.shields.io/node/v/@spinabot/brigade" alt="node engine" /></a>
</p>

🦁 **Brigade is your personal AI crew** — a polished terminal interface for working
with the world's leading language models (Anthropic Claude, OpenAI GPT, Google
Gemini, Groq, xAI, DeepSeek, Mistral, OpenRouter, Cerebras) plus your own local
models via Ollama or any OpenAI-compatible endpoint.

It runs as a single-process chat TUI by default, or as a headless WebSocket
gateway you can attach multiple thin clients to. Under the hood: isolated
agents with their own workspaces and credentials, a sub-agent spawn lifecycle,
memory that persists across sessions, a skill system, a cron scheduler, and
optional channel adapters (WhatsApp shipped, more coming).

## Install

```bash
npm install -g @spinabot/brigade
```

Requires Node.js 22.12 or newer.

## From source (run the GitHub repo)

For development, contribution, or running the latest unreleased code:

### Prerequisites

- Node.js **22.12 or newer** (`node --version`) — Pi SDK uses `using`/`AsyncDisposable` and `v22.12` features
- npm 10+ (ships with Node 22)
- git
- (Optional) `tsx` is installed locally — no need to install globally

### Clone & build

```bash
git clone https://github.com/Bhasvanth-Dev9380/brigade.git
cd brigade
npm install          # installs deps (Pi SDK 0.70.6, ws, croner, etc.)
npm run build        # compiles src/ → dist/ (~300 files, postbuild prints summary)
```

### Run it

Three ways, depending on what you're doing:

```bash
# 1. Production-style — run the built dist/ once, fastest startup
node brigade.mjs                  # → brigade tui (default)
node brigade.mjs agents list
node brigade.mjs gateway --port 7777

# 2. Smart dev runner — auto-rebuilds dist/ if src/ is newer
npm run dev                       # → brigade tui
npm run agents:list
npm run gateway

# 3. Pure TypeScript via tsx — no build step (slower per-invocation, no cache)
npm run dev:tsx                   # → brigade entry directly
npm run watch                     # auto-restart on file change
```

### Link globally (so `brigade` works anywhere)

```bash
npm link              # one-time — creates a global `brigade` symlink → this checkout
brigade --help        # now works from any directory
brigade onboard
```

Run `npm unlink -g brigade` from any directory to remove the link.

### Common dev workflows

```bash
npm test                          # 1700+ tests via node:test (tempdir-isolated)
npm run typecheck                 # tsc --noEmit
npm run build:watch               # incremental build while editing
npm run clean                     # rm -rf dist/

# Drive a single turn end-to-end (smoke test)
npm run brigade -- agent --provider anthropic --model claude-sonnet-4-6 -m "hello"

# Convenient subcommand aliases (all wired to scripts/run-brigade.mjs)
npm run agents:list
npm run agents:add -- support
npm run gateway
npm run gateway:stop
npm run connect
npm run tui
```

### What `npm install` brings down

| Layer                | Package                                  | Why                                  |
|----------------------|------------------------------------------|--------------------------------------|
| Loop engine          | `@mariozechner/pi-agent-core@0.70.6`     | The agent loop primitive             |
| Sessions + tools     | `@mariozechner/pi-coding-agent@0.70.6`   | JSONL sessions, coding tools, skills |
| Multi-provider       | `@mariozechner/pi-ai@0.70.6`             | Anthropic / OpenAI / Gemini / etc.   |
| Terminal UI          | `@mariozechner/pi-tui@0.70.6`            | Flicker-free TUI components          |
| WS server            | `ws@^8.18`                               | Gateway WebSocket transport          |
| Cron                 | `croner@^10.0.1`                         | Schedule parsing + tick worker       |
| WhatsApp             | `@whiskeysockets/baileys` (lazy)         | Loaded only when channel is linked   |

Zero runtime telemetry. No magic. Brigade's whole runtime is ~1.5 MB of TypeScript on top of Pi.

## Quick start

```bash
brigade
```

First launch walks you through three steps:

1. Pick a provider.
2. Connect it (paste an API key, or scan your local Ollama).
3. Choose a default model.

That's it. Subsequent launches resume right where you left off.

## Commands

Brigade is a single binary with subcommands. `brigade` on its own is shorthand
for `brigade tui` (the chat TUI).

| Command             | What it does                                                             |
|---------------------|--------------------------------------------------------------------------|
| `brigade`           | Start the chat TUI (default)                                             |
| `brigade tui`       | Start the chat TUI (auto-starts the gateway if needed)                   |
| `brigade gateway`   | Run or manage the headless WebSocket gateway (no TUI)                    |
| `brigade connect`   | Open a thin TUI client against a running gateway                         |
| `brigade agent`     | Drive a single turn through the agent pipeline                           |
| `brigade agents`    | Manage isolated agents — list, add, delete, bind, set-identity (default: list) |
| `brigade onboard`   | Re-run the provider/model setup wizard                                   |
| `brigade doctor`    | Health-check Node, config, providers, prompts, log sink, and gateway     |
| `brigade status`    | Print a snapshot of config, sessions, and gateway state                  |
| `brigade config`    | Read & write your Brigade configuration                                  |
| `brigade channels`  | Manage messaging channels (WhatsApp etc.) — link, status, enable/disable |
| `brigade sessions`  | List + clean up agent session transcripts                                |
| `brigade skills`    | Inspect installed Brigade skills                                         |
| `brigade cron`      | Manage scheduled cron jobs                                               |
| `brigade exec`      | Manage the bash-tool approval allowlist                                  |
| `brigade backup`    | Snapshot, verify, and restore your Brigade install as a `.tar.gz`        |
| `brigade pairing`   | Review and approve/revoke pending channel pairing codes                  |
| `brigade secrets`   | Find suspected leaked credentials inside your Brigade install            |
| `brigade logs`      | Tail today's gateway log file                                            |
| `brigade --version` | Print the version                                                        |
| `brigade --help`    | Print the full help text                                                 |

### `brigade gateway`

Runs Brigade as a WebSocket server with no terminal UI of its own. Useful when
you want a long-lived process that survives terminal sessions — channel adapters
(WhatsApp etc.), cron jobs, and sub-agent spawns all need the gateway running.

```bash
brigade gateway --port 7777 --host 127.0.0.1 --verbose
brigade gateway status
brigade gateway stop
brigade gateway restart
brigade gateway install     # install as a system service (launchd / systemd / Task Scheduler)
```

| Flag             | Default       | Notes                                        |
|------------------|---------------|----------------------------------------------|
| `--port N`       | `7777`        | Listen port (also `BRIGADE_PORT` env var)    |
| `--host A`       | `127.0.0.1`   | Bind address (loopback by design)            |
| `--verbose`      | off           | Stream a one-line summary of every event     |
| `--quiet`        | off           | Suppress the live console stream             |
| `--log-level X`  | `info`        | `debug`, `info`, `warn`, `error`             |

### `brigade connect`

Attaches a TUI to a running gateway. Same chat experience as `brigade`, but the
agent runs in the gateway process — so you can disconnect, walk away, reconnect
later, and pick up where you left off. Other clients (channel adapters, cron
jobs) continue running while you're away.

```bash
brigade connect --host 127.0.0.1 --port 7777
```

| Flag           | Default       | Notes                                |
|----------------|---------------|--------------------------------------|
| `--host A`     | `127.0.0.1`   | Gateway host to connect to           |
| `--port N`     | `7777`        | Gateway port                         |
| `--timeout MS` | `60000`       | Per-request timeout                  |

### `brigade agents`

Brigade ships with a default agent called `main`. You can add more — each agent
has its own workspace (persona files), auth profiles, exec allowlist, sessions,
and optional channel/account routing bindings.

```bash
brigade agents                                                # list every agent (default)
brigade agents list [--json] [--bindings]
brigade agents bindings [--agent <id>] [--json]
brigade agents bind --agent <id> --bind <spec> [--bind <spec> …] [--json]
brigade agents unbind --agent <id> (--bind <spec> [--bind <spec> …] | --all) [--json]
brigade agents add <name> [--workspace <dir>]
                  [--model <id>] [--provider <id>] [--agent-dir <dir>]
                  [--bind <spec> [--bind <spec> …]]
                  [--non-interactive] [--json]
brigade agents set-identity --agent <id>
                  [--workspace <dir>] [--identity-file <path>] [--from-identity]
                  [--name <…>] [--theme <…>] [--emoji <…>] [--avatar <…>]
                  [--json]
brigade agents delete <id> --force [--json]
```

`agents add <name>` without `--workspace` defaults to
`~/.brigade/agents/<name>/workspace/`. Delete is a soft-delete — the workspace
moves into `.brigade-trash/` so you can recover it.

Reserved ids: `main` (the default), `none`, `null`, `undefined`, `default`,
`all`, `any` — these cannot be used as agent names.

### `brigade doctor`

Runs a health check across Node version, your `~/.brigade/` directory, config,
configured providers, log sink, prompt files, and (optionally) a running
gateway. Exits 0 if everything passes, 1 if anything fails.

```bash
brigade doctor
brigade doctor --gateway ws://127.0.0.1:7777
brigade doctor --json           # machine-readable
brigade doctor --strict         # exit 1 on warnings (CI mode)
```

### `brigade config`

Read and write the local config without opening the TUI.

```bash
brigade config list
brigade config get agents.defaults.provider
brigade config set agents.defaults.provider openrouter
brigade config set agents.defaults.model.primary "anthropic/claude-sonnet-4.6"
brigade config unset agents.defaults.thinking
```

### `brigade cron`

Schedule recurring or one-shot agent turns — useful for daily briefings,
reminders, or background scans.

```bash
brigade cron list
brigade cron add --schedule "every 1 hour" --message "drink water"
brigade cron add --at "2026-06-04T09:00:00+05:30" --message "good morning"
brigade cron remove <jobId>
```

Cron jobs survive gateway restarts and missed-fire windows replay on next boot.

### `brigade channels`

Connect external messaging channels — WhatsApp is shipping today; Slack,
Discord, Telegram queued.

```bash
brigade channels list
brigade channels link --channel whatsapp
brigade channels status --channel whatsapp --probe
brigade channels disable --channel whatsapp
```

## In-chat commands

When you're in the chat TUI (whether via `brigade` or `brigade connect`):

| Command             | What it does                                                |
|---------------------|-------------------------------------------------------------|
| `/agent`            | Show the agent your messages are currently bound to         |
| `/agent <id>`       | Bind this connection to a different agent                   |
| `/agents`           | List every agent the gateway knows about                    |
| `/sessions`         | List sessions for the currently-bound agent                 |
| `/session <key>`    | Switch to a different session of the same agent             |
| `/model`            | Switch to a different configured model (picker)             |
| `/model <id>`       | Switch directly by model id                                 |
| `/provider`         | Add a new provider mid-session — no restart required        |
| `/thinking <level>` | Adjust reasoning effort (off, minimal, low, medium, high)   |
| `/reasoning [on\|off]` | Toggle whether thinking blocks render before each reply  |
| `/compact`          | Force a context compaction now                              |
| `/abort`            | Stop the current turn (same as Ctrl+C)                      |
| `/steer "<text>"`   | Inject mid-turn guidance without aborting                   |
| `/mute`             | Silence agent voice output (TTS) until /unmute              |
| `/usage`            | Show token + cost usage for this session                    |
| `/help`             | Show all commands                                           |
| `/exit`             | Quit Brigade                                                |

Keyboard:

- **Enter** — send (mid-turn submits steer the model without aborting)
- **Ctrl+C** — stop the current response (doesn't exit)
- **Ctrl+D** — quit
- **↑** / **↓** — message history

## Built-in tools

Every Brigade agent gets a curated toolset out of the box:

- `read`, `bash`, `edit`, `write`, `grep` — Pi SDK coding tools
- `write_memory`, `recall_memory` — persistent file-based memory with auto-recall
- `spawn_agent` — sync sub-agent for delegated tasks (returns the reply inline)
- `sessions_spawn` — async sub-agent that delivers its result into your transcript on the next turn
- `sessions_send`, `sessions_history`, `sessions_list` — cross-session messaging (gated by visibility + A2A policy)
- `cron` — schedule jobs from inside a turn
- `web_search` — when a search provider is configured
- Channel-specific tools (e.g. `send_whatsapp_message`) when a channel is linked

## Skills

Drop a folder into `~/.brigade/workspace/skills/<name>/` containing a
`SKILL.md` file, and Brigade auto-discovers it on the next turn. Skills are
prompt-resident — they get injected into the system prompt with name +
description, and the model reads the body on demand via the `read` tool.

Six scan roots in precedence order (lowest → highest):

1. **Bundled** — shipped with the install
2. **Config extras** — paths from `config.skills.paths[]`
3. **Managed** — `~/.brigade/skills/` (shared across agents)
4. **Personal** — `~/.agents/skills/`
5. **Project** — `<workspace>/.agents/skills/`
6. **Workspace** — `<workspace>/skills/` (workspace wins on name collision)

Per-agent allowlists: `cfg.agents.<id>.skills = ["skill1", "skill2"]` restricts
that agent to those skills. Defaults inherit via `cfg.agents.defaults.skills`.

## Filesystem layout

Brigade keeps every byte of state under `~/.brigade/` — `rm -rf ~/.brigade/`
truly wipes everything Brigade knows.

```
~/.brigade/
├── brigade.json                          # main config (JSON5, ${VAR} refs preserved on write)
├── brigade.json.bak{,.1..4}              # rotating backups
├── workspace/                            # default agent (main) — shared v1-compat layout
│   ├── SOUL.md, IDENTITY.md, AGENTS.md   # persona files (auto-seeded)
│   ├── TOOLS.md, USER.md, HEARTBEAT.md
│   ├── memory/facts.jsonl                # write_memory / recall_memory
│   └── skills/                           # drop-a-folder skills
├── agents/<id>/                          # per-agent isolation
│   ├── workspace/                        # same shape as above, per agent
│   ├── sessions/                         # JSONL transcripts (Pi SDK)
│   ├── inbox/<sessionKey>.jsonl          # async sub-agent result delivery
│   ├── auth-profiles.json                # OAuth + API keys (mode 0600)
│   ├── exec-approvals.json               # bash-tool allowlist
│   └── .brigade-trash/                   # soft-deleted dirs (recoverable)
├── skills/                               # managed skills (shared across agents)
├── cron.json                             # scheduled jobs (versioned)
├── models.json                           # custom provider catalog
├── channels/<id>/...                     # channel state (allow-from, pairings)
├── identity/                             # gateway Ed25519 keypair
├── oauth/                                # pairing codes + allowlists
└── logs/                                 # daily rolling logs
```

## Supported providers

Out of the box: Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, xAI,
Cerebras, DeepSeek, Mistral, **Ollama** (local), and **Custom OpenAI-compatible**
endpoints (Together AI, Fireworks, vLLM, on-prem gateways, anything that
speaks `/v1/chat/completions`).

You can mix and match — connect three providers, switch between their models
with `/model`, and Brigade keeps your conversation context across the switch.

## Multi-agent isolation

Every agent has its own workspace, persona, credentials, memory, sessions,
exec approvals, and routing bindings. By design:

- Agent A cannot read agent B's session transcripts (unless visibility ≠ `self`)
- Agent A cannot send to agent B's session (unless `cfg.session.agentToAgent.allow` permits)
- Memory facts are per-agent — they don't bleed between agents
- Provider credentials are per-agent — `support` and `prod-bot` can use different Anthropic accounts

The default policy is `visibility: "self"` (an agent only sees its own sessions).
Switch to `"tree"` to allow a parent to see sub-agents it spawned.

## Privacy

Brigade is a local CLI. Your API keys never leave your computer; they're stored
in your home directory under mode 0600 and used only to talk to the providers
you connect. No telemetry, no analytics, no cloud component.

For Ollama and Custom endpoints, requests stay entirely on your network.

The gateway binds to `127.0.0.1` by default — no external network exposure.

## Environment overrides

- `BRIGADE_STATE_DIR` — alternate state directory (default: `~/.brigade`)
- `BRIGADE_CONFIG_PATH` — alternate config file path
- `BRIGADE_PORT` — gateway port (default `7777`)
- `BRIGADE_PROFILE` — named profile (`workspace-<profile>/` instead of `workspace/`)
- `BRIGADE_ENABLE_INBOX_PERSIST` — enable JSONL persistence for the sub-agent inbox (auto-on at gateway boot)
- `BRIGADE_HOST_ENV` — operator-override host-environment tag (for the system prompt's runtime line)

## License

MIT
