# 🦁 Brigade — Your personal intelligence, built enterprise-grade

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/spinabot/brigade/main/assets/brigade-banner-on-black.gif" />
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/spinabot/brigade/main/assets/brigade-banner.gif" />
    <img src="https://raw.githubusercontent.com/spinabot/brigade/main/assets/brigade-banner.gif" alt="Brigade — your personal intelligence, built enterprise-grade" width="900" />
  </picture>
</p>

<p align="center">
  <strong>Built for enterprise scale. Open for everyone.</strong> &middot; <em>An ecosystem, not an app.</em>
</p>

<p align="center">
  🔐 <strong>No tokens to juggle. No drama.</strong> No copy-pasting secrets, no telemetry —
  <strong>we handle them, not you</strong>. Your API keys stay on your own machine, never sent to a middleman.
</p>

<p align="center">
  🔑 <strong>No API key? No problem.</strong> Sign in with your <strong>Claude</strong>, <strong>ChatGPT</strong>, or
  <strong>Copilot</strong> subscription — or, if you're already signed into the <strong>Claude Code</strong> or
  <strong>Codex</strong> CLI, reuse that login (no browser, no re-auth).
</p>

<p align="center">
  🩸💥 <strong>B³ — Brigade Bloody Benchmark</strong> 💥🩸<br/>
  <sub><strong>NEW in v1.9.0</strong> · the one command that throws your crew to the wolves (lovingly)</sub>
</p>

<p align="center">
  <strong><em>Three B's. One bloody command. Your crew — loose on the open internet.</em></strong>
</p>

<p align="center">
  <strong>Brigade</strong> is your crew. <strong>Bloody</strong> is what you do to it — fling it into the open with no net, down a red-hot tunnel to the wild. <strong>Benchmark</strong> is the punchline: the only test that ever mattered isn't a lab, it's <em>strangers poking your agents at 3&nbsp;a.m.</em> Survive that, and you've shipped.
</p>

<p align="center">
  Under the hood it's tame — HTTPS at the edge, no account, no setup. Cloudflare by default, or bring your own relay (<code>bore</code> · <code>frp</code> · <code>sish</code>, all open-source). A secret key rides along <strong>invisibly</strong>: you never see it, and gate-crashers just bleed out on a <code>401</code>. Not feeling the name? It also answers to the buttoned-up <code>brigade expose</code>. 🩸
</p>

<p align="center">
  <code>brigade bloody&nbsp;benchmark</code> &nbsp;·&nbsp; <code>brigade expose</code> &nbsp;·&nbsp; <code>brigade expose stop</code> &nbsp;🩸
</p>

<p align="center">
  <a href="https://github.com/spinabot/brigade/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/spinabot/brigade/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@spinabot/brigade"><img src="https://img.shields.io/npm/v/@spinabot/brigade?style=for-the-badge&logo=npm&logoColor=white&color=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@spinabot/brigade"><img src="https://img.shields.io/npm/dt/@spinabot/brigade?style=for-the-badge&logo=npm&logoColor=white&color=CB3837&label=downloads" alt="npm total downloads"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@spinabot/brigade?style=for-the-badge&logo=nodedotjs&logoColor=white&color=5FA04E&label=node" alt="node engine"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://brigade.spinabot.com"><img src="https://img.shields.io/badge/website-brigade.spinabot.com-E8B021?style=for-the-badge&logo=googlechrome&logoColor=white" alt="website"></a>
</p>

**Brigade is your personal intelligence, built on enterprise-grade tech**: a crew of
AI agents on a real org chart that share one long-term memory, Tideline, so what one
agent learns, the rest can use. They delegate to each other, switch models mid-task
without losing the thread, and act inside the 1,000+ apps you already use. It's an
ecosystem you host yourself, with the controls and data sovereignty of enterprise
tech: no account to create, no SaaS in the middle.

The same crew runs on a Raspberry Pi or a server. By default it's a small filesystem
install; switch to a self-hosted Convex database when you want one. Bring any model:
Claude, GPT, Gemini, Llama, or a local Ollama. Privileged actions wait for your
approval, and your keys and data never leave your machine. No telemetry.

It's an ecosystem, not an app: one crew you reach from the terminal, WhatsApp, Telegram,
Slack, Discord, iMessage, and BlueBubbles, and from your watch, Meta smart glasses, and Meta Quest.

```bash
npm i -g @spinabot/brigade
brigade
```

Start it and you get a fast chat TUI. Keep going and you get isolated agents with
their own workspaces and credentials, persistent memory, a skill system, a cron
scheduler, sub-agent fan-out, an org hierarchy, messaging channels like WhatsApp and Telegram,
1,000+ app connectors, an MCP memory server, and an optional self-hosted Convex
backend — all under one `~/.brigade/` directory you fully own.

> One owner, a whole crew — many agents that coordinate through a real org chart,
> all on hardware and storage **you** control.

---

## Table of contents

- [Why Brigade](#why-brigade)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Features](#features)
- [CLI reference](#cli-reference)
- [In-chat commands](#in-chat-commands)
- [Built-in tools](#built-in-tools)
- [Multi-agent isolation](#multi-agent-isolation)
- [Providers & web search](#providers--web-search)
- [Configuration & storage](#configuration--storage)
- [Storage modes: filesystem vs. Convex](#storage-modes-filesystem-vs-convex)
- [MCP memory server](#mcp-memory-server)
- [Tideline (long-term memory)](#tideline-long-term-memory)
- [Extending Brigade](#extending-brigade)
- [Privacy](#privacy)
- [Develop from source](#develop-from-source)
- [Contributing](#contributing)
- [License](#license)
- [🦁 Brigadiers](#-brigadiers)

---

## Why Brigade

| | |
|---|---|
| 🖥️ **Terminal-first** | A flicker-free chat TUI by default. No browser, no Electron. |
| 🧠 **Memory that lasts** | Facts persist across sessions with origin scoping, decay, and hybrid (keyword + vector) recall — the **Tideline** engine. |
| 👥 **A real crew** | Spawn isolated agents with their own personas, credentials, and memory; wire them into an **org chart** that governs who can talk to whom. |
| 🔌 **Bring any model** | Anthropic, OpenAI, Gemini, OpenRouter, Groq, Cerebras, xAI, DeepSeek, Mistral, local Ollama, or any OpenAI-compatible endpoint. Switch mid-conversation. |
| 📅 **Always-on** | Run as a headless WebSocket gateway with a crash supervisor, cron jobs, and OS service install. |
| 💬 **Channels** | Talk to your crew from WhatsApp, Telegram, Slack, Discord, iMessage, and BlueBubbles today; the adapter contract is built for more. |
| 🔗 **1,000+ connectors** | Gmail, Slack, GitHub, Notion, Calendar, Linear… via the built-in Composio tool. |
| 📄 **Reads & writes documents** | Send a PDF, Office doc, image, audio, or video and your crew *understands* it — then have it **create or edit** Word, Excel, PowerPoint, and PDF files and hand them back. |
| 🧩 **MCP** | Expose your long-term memory to any MCP client (`brigade mcp`), or connect MCP servers in. |
| 🗄️ **Your storage** | Default filesystem mode, or an optional **fully self-hosted Convex** backend with at-rest encryption. |
| 🔐 **Yours** | Everything lives under `~/.brigade/`. Keys are stored locally at mode `0600`. `rm -rf ~/.brigade` wipes it clean. |

---

## Install

**Fastest — handles Node for you** (installs Node 22.12+ if you don't have it, then Brigade):

```bash
# macOS / Linux
curl -fsSL https://brigade.spinabot.com/install.sh | sh
# …or straight from GitHub:
curl -fsSL https://raw.githubusercontent.com/spinabot/brigade/main/packaging/install/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://brigade.spinabot.com/install.ps1 | iex
# …or straight from GitHub:
irm https://raw.githubusercontent.com/spinabot/brigade/main/packaging/install/install.ps1 | iex
```

**Already on Node 22.12+?** Install straight from npm:

```bash
npm i -g @spinabot/brigade
```

Then launch onboarding:

```bash
brigade
```

---

## Quick start

```bash
# 1. Set up — pick a provider, paste an API key (or scan local Ollama), choose a model
brigade onboard

# 2. Start the always-on gateway — your crew, channels, and cron jobs live here
brigade gateway run

# 3. Chat with your crew
brigade tui
```

The onboarding wizard walks you through **five steps**: **(0) storage mode**
(filesystem or self-hosted Convex), **(1) pick a provider** (Anthropic, OpenAI, Gemini,
OpenRouter, Ollama, and more), **(2) connect it** (paste an API key, **sign in with a
Claude/ChatGPT/Copilot subscription**, reuse your Claude Code or Codex CLI login, or
connect local Ollama), **(3) choose a default model**, and **(4) web search** (pick a
search backend; keyless options work out of the box). Subsequent launches resume right
where you left off.

`brigade tui` (or just `brigade`) auto-starts the gateway if it isn't already running,
so for a quick local session you can skip step 2. To keep the gateway alive across
reboots, run `brigade gateway install` (installs a launchd / systemd / Task Scheduler
service).

Other handy entry points:

```bash
brigade agent -m "summarize ~/today.md"   # one-shot turn, no TUI
brigade connect                            # attach a client to a running gateway
brigade doctor                             # health-check your install
```

---

## How it works

Brigade is one binary that can act as a **gateway** (the long-lived process that
holds all state and runs agents) or as a **thin client** that attaches to it.

```
            ┌─────────────────────────── ~/.brigade/ ───────────────────────────┐
            │  config · per-agent workspaces · sessions (JSONL) · memory · cron  │
            └───────────────────────────────────────────────────────────────────┘
                                          ▲
                                          │ reads/writes (filesystem OR Convex)
                        ┌─────────────────┴─────────────────┐
   brigade tui ──ws──▶  │            GATEWAY  :7777          │  ◀──ws── brigade connect
   brigade chat         │  per-turn agent loop · routing    │
   WhatsApp·Telegram ──▶│  tools · sub-agents · supervisor  │◀──────── cron jobs
   MCP client ─stdio──▶ │  (brigade mcp → memory server)    │
                        └───────────────────────────────────┘
```

- **Clients are thin.** The TUI (`brigade`/`brigade tui`), `brigade connect`, and
  channel adapters are all WebSocket clients of the gateway. State lives only in
  the gateway; clients mirror it. Disconnect, walk away, reconnect later — your
  agents keep running.
- **One turn at a time.** Each message runs through a resilient agent loop: resolve
  the session, assemble the system prompt (persona + skills + org context), stream
  the model, run tool calls through approval and ownership guards, persist the
  transcript, reply.
- **Inbound from anywhere.** A WhatsApp message and a TUI keystroke flow through the
  same routing pipeline that resolves them to an `(agent, session)` pair, so a peer
  on one channel never bleeds into another's context.
- **It stays up.** A heartbeat file plus an out-of-process supervisor restart the
  gateway if its event loop wedges; per-OS service installers bring it up at login.

---

## Features

### 🧠 Memory (Tideline)
File-backed facts (`facts.jsonl`) tagged with an **origin** (owner vs. channel peer)
so a peer's facts never leak into your context. Facts **decay** on three tiers and
are deduped at write time, behind a **provenance write-gate** that stops untrusted
sources from overwriting your identity/preferences. The **Tideline** engine adds
**hybrid recall** (BM25 keyword + model-free vector lane), a typed link graph, and a
nightly reflect/consolidate pass. Auto-recall injects only origin-matched facts
before each turn. Tools: `recall_memory`, `read_memory`, `write_memory`,
`manage_memory`. → **[docs/tideline.md](docs/tideline.md)**

### 🪪 Skills
Drop a folder with a `SKILL.md` into your workspace and Brigade discovers it next
turn. Skills are **prompt-resident** (name + description injected; the model reads
the body on demand). Six discovery roots merge in precedence order with eligibility
filters for OS, required binaries, env vars, and config. 56 skills ship bundled.
Manage with `manage_skill`.

### 👥 Sub-agents
Delegate work to child agents: `spawn_agent` (single) and `spawn_agents` (parallel
fan-out). Depth-capped (default 3) and child-count-capped (default 5), with an
**abort cascade** and a completion bridge that wakes the parent when children settle.

### 🏢 Org / Pride hierarchy
Define a crew as a real org chart (`cfg.org`): members, departments, reporting
lines. An **A2A (agent-to-agent) policy** derives from the graph and governs which
agents may message which. Inspect it with `brigade org show` / `explain` / `doctor`,
or render a 🦁 Pride chart with the `org` tool.

### 💬 Channels
A typed channel-adapter contract with a shared inbound pipeline (access control,
dedupe, abort triggers, approval routing). **WhatsApp** (Baileys, QR/code pairing,
multi-account, reconnect backoff), **Telegram** (Bot API token, inline-button
approvals, owner bootstrapped on the gateway), **Slack** (Socket Mode, bot + app
tokens, channel/thread chat), **Discord** (bot token, DM/server/thread chat),
**iMessage** (via the `imsg` CLI, plain-text only), and **BlueBubbles** (macOS
server, REST-out + webhook-in, reactions/edit/unsend) ship today; the contract is
built for more. See [Telegram setup](#telegram-setup-end-to-end) for the full
walkthrough.

### ⏰ Cron
Schedule recurring or one-shot work: cron expressions (with IANA timezones and
stagger), fixed intervals, or one-shot timestamps. Payloads can be a system event
into your main session, a full agent turn in an isolated session, or a shell script.
Jobs survive restarts.

### 🔗 Connectors (Composio)
An owner-only `composio` tool brings **1,000+ app connectors** (Gmail, Slack, GitHub,
Notion, Calendar, Linear, …) with managed OAuth. Set a key once, then just ask your
crew in plain language: *"connect my Gmail"*, *"post to #team"*.

**Getting the key:** Brigade uses the Composio **SDK**, so it needs a **PLATFORM** key
(starts with `ak_`), *not* the "FOR YOU" consumer key (`ck_`) that Brigade rejects. At
[dashboard.composio.dev](https://dashboard.composio.dev), set the top-left mode toggle
to **PLATFORM**, open **Settings → API Keys**, and copy the `ak_…` key. Hand it to
Brigade once (*"set my Composio key to `ak_…`"*) and it's verified and stored encrypted.
Full guide: **[docs/composio.md](docs/composio.md)**.

### 📄 Documents & media
Send your crew a file and it actually **reads** it: the `analyze_media` tool
understands PDFs (text or scanned), Word / Excel / PowerPoint (including the images
embedded inside them), plain images, audio, and video — auto-selecting the right
provider and caching the result. The write side, `make_document` and
`edit_document`, **creates and edits** Word / Excel / PowerPoint / PDF in place:
fill templates and form fields, set cells and formulas, add charts, and
merge / split / stamp / watermark PDFs — all with pure-JS libraries, no sandbox.
Drop a document into a channel and Brigade sees it; ask for a report and it hands
one back with `send_media`.

### 🧩 MCP
Run `brigade mcp` to expose your long-term memory to any MCP client (Claude Desktop,
editors, etc.) as add/search/context tools over stdio, owner-bound.

### 🛡️ Safety & ownership
Privileged tools use either a **per-call ownership gate** (`cron list` is visible to
peers; `cron add` is not) or a blanket owner-only refusal. The `bash` tool is gated
by a per-agent approval allowlist (`brigade exec`). Secrets in config use `${VAR}`
references that resolve at read time and are never persisted resolved. Optional
**AES-256-GCM at-rest encryption** in Convex mode (`brigade encrypt`).

**Optional gateway tokens.** The gateway is unauthenticated and localhost-only by
default — ideal for a single machine. Want more? Add one or more access tokens
(`brigade gateway token new`) and every connection must then present a valid one
(`Authorization: Bearer`, `x-brigade-token`, or `?token=`). **Multiple tokens** are
supported, so you can hand a distinct token to each device and revoke one without
disturbing the rest, and the same tokens secure `brigade expose`. Entirely opt-in:
with no tokens configured, nothing changes.

### 🔀 Carrow — cross-model continuity
Switch models mid-conversation **without losing context**. Carrow carries the full
transcript onto the new model (it's the same session), **re-anchors your thinking
level** to what the target supports (preserved when it can reason, forced off for a
non-reasoning model, bumped for a reasoning-only one), and sanitizes provider-specific
reasoning blocks the next provider would reject. It works **mid-turn** (abort the
in-flight run and replay your last message on the new model) or **next-turn**. This is
what makes `/model` and `/provider` switches seamless.

### 🔁 Autonomous loops
A **loop-runner** drives an agent (or a planner/executor stage) step-by-step under hard
guards — token / iteration / time **budget**, plus **no-progress** and **repetition**
detection — and stops only when **independent done-checks** pass or a guard fires,
*never on the agent's own say-so*. Each step's output is gated through the slop
detector with a bounded repair retry.

### 🧹 Anti-slop quality gate
A deterministic, zero-dependency **AI-slop detector** scans generated text in four
passes (vocabulary crutches, cliché phrases, formulaic openers, structural patterns)
and flags **density, not single words**. When output trips the threshold it triggers
**one bounded repair retry**, wired as a post-generation hook — an objective check, not
the model grading itself.

### 📈 Self-improvement (human-gated)
Tideline ships a **human-gated** self-improvement loop: propose changes from telemetry
→ **gate on evaluation** → human approve → apply → revert if needed. Brigade also
reviews its own behavior and curates/reviews skills from usage. Nothing that affects
recall changes without passing the eval bar **and** a human approval. Throughout, the
principle is the same: *independent verification, never the agent judging itself.*

---

## CLI reference

`brigade` on its own is shorthand for `brigade tui`. Run `brigade --help` or
`brigade <command> --help` for full flags.

### Core

| Command | What it does |
|---|---|
| `brigade` · `brigade tui` | Start the chat TUI (auto-starts the gateway if needed) |
| `brigade connect` | Attach a thin TUI to an already-running gateway (`--host`, `--port`) |
| `brigade agent <msg>` | Drive a single turn through the agent pipeline (`--provider`, `--model`, `-m`) |
| `brigade onboard` | Run the provider/model setup wizard |
| `brigade status` | Snapshot config, sessions, and gateway state (`--json`) |
| `brigade doctor` | Health-check Node, config, providers, prompts, logs, gateway (`--json`, `--strict`, `--gateway <url>`) |
| `brigade logs` | Tail today's gateway log (`--follow`) |
| `brigade update` · `upgrade` | Update Brigade to the latest code and restart the gateway (`--check`, `--no-restart`) |

### Gateway

| Command | What it does |
|---|---|
| `brigade gateway run` | Run the headless WebSocket gateway (`--port`, `--host`, `--verbose`, `--quiet`, `--log-level`) |
| `brigade gateway status` · `stop` · `restart` | Inspect / stop / restart the running gateway |
| `brigade gateway install` · `uninstall` | Install/remove as a system service (launchd / systemd / Task Scheduler) |
| `brigade gateway supervise` | Out-of-process crash watchdog (respawns a wedged gateway) |
| `brigade expose` · `expose stop` | Publish the gateway to the public internet via a secure, token-gated tunnel (alias: `bloody benchmark`) |
| `brigade gateway token new` · `list` · `add` · `revoke` | Manage **optional** access tokens (multiple supported). No tokens → the gateway stays unauthenticated + localhost-only |

### Agents

| Command | What it does |
|---|---|
| `brigade agents` · `agents list` | List every configured agent (`--json`, `--bindings`) |
| `brigade agents add [name]` | Create an isolated agent (`--workspace`, `--model`, `--provider`, `--bind`, `--non-interactive`) |
| `brigade agents delete <id>` | Delete an agent + its workspace/sessions (`--force`) |
| `brigade agents bind` · `unbind` | Claim / release channel-account routing slots (`--agent`, `--bind`, `--all`) |
| `brigade agents bindings` | List routing bindings (`--agent`) |
| `brigade agents set-identity` | Set name / theme / emoji / avatar (`--agent`, `--from-identity`) |

### Org / Pride

| Command | What it does |
|---|---|
| `brigade org init` | Write a starter `cfg.org` block (`--template solo\|family\|company\|custom`, `--skip-editor`) |
| `brigade org show` | Print an ASCII tree of the current org |
| `brigade org explain <from> <to>` | Show whether `from` can message `to`, and the derivation/denial reason |
| `brigade org doctor` | Run org lints (single-member dept, dangling overrides, depth > 5, …) |

### Channels & pairing

| Command | What it does |
|---|---|
| `brigade channels list` · `status` · `add` | List channels, probe status, add an account |
| `brigade channels link` · `unlink` | Pair / unpair a channel (e.g. WhatsApp QR) |
| `brigade channels enable` · `disable` | Toggle a channel |
| `brigade channels allow list\|add\|remove` | Manage the per-channel allowlist |
| `brigade pairing list\|approve\|revoke` | Review / approve / revoke pending pairing codes |

### Cron

| Command | What it does |
|---|---|
| `brigade cron list` · `status` · `runs <jobId>` | List jobs, service status, per-job run history |
| `brigade cron add` | Create a job (`--cron`/`--every`/`--at`, `--tz`, `--message`/`--system-event`, `--model`, `--tools`, `--channel`/`--to`) |
| `brigade cron edit <jobId>` · `rm <jobId>` | Modify / remove a job |
| `brigade cron enable\|disable\|run <jobId>` | Toggle or run a job on demand |

### Storage, encryption & data

| Command | What it does |
|---|---|
| `brigade store mode show` | Print the active storage mode (filesystem / convex) |
| `brigade store mode set <mode>` | Pin the mode (`--convex-url` for convex) |
| `brigade store migrate --to <mode>` | Copy data between backends (`--convex-url`, `--dry-run`, `--keep-source`) |
| `brigade store reset` | Factory-reset the Convex backend (`--yes`, `--purge-local`) |
| `brigade convex dev` · `start` | Run the **bundled** self-hosted Convex backend + dashboard in the foreground (`brigade convex:dev` also works) |
| `brigade convex status` · `stop` | Probe whether the backend is running / how to stop it (Ctrl-C) |
| `brigade convex push` · `codegen` | Deploy the bundled Convex functions to the backend / regenerate the client |
| `brigade encrypt status` · `init` · `test` | Manage the AES-256-GCM at-rest key |
| `brigade backup create` · `verify` · `restore` | Snapshot / verify / restore your install as a `.tar.gz` |
| `brigade secrets audit` | Find suspected leaked credentials in your install |

### Config, skills, sessions, exec, MCP

| Command | What it does |
|---|---|
| `brigade config list\|get\|set\|unset\|file\|schema\|validate` | Read & write configuration |
| `brigade skills list\|info <name>` | Inspect installed skills |
| `brigade sessions list\|cleanup` | List + clean up session transcripts |
| `brigade exec list\|allow\|allow-pattern\|remove\|deny-test\|file` | Manage the `bash`-tool approval allowlist |
| `brigade mcp` | Serve your long-term memory as an MCP server over stdio (`--agent <id>`) |

### `brigade gateway`

Runs Brigade as a WebSocket server with no terminal UI of its own — the long-lived
process that channel adapters, cron jobs, and sub-agent spawns all need running.

```bash
brigade gateway run --port 7777 --host 127.0.0.1 --verbose
brigade gateway status
brigade gateway stop
brigade gateway restart
brigade gateway install      # install as a system service (launchd / systemd / Task Scheduler)
brigade gateway supervise    # out-of-process crash watchdog

brigade gateway token new        # generate + store an access token (printed once)
brigade gateway token list       # show configured tokens (masked) + whether auth is on
brigade gateway token revoke 1   # remove a token by its number (or its exact value)
```

| Flag | Default | Notes |
|---|---|---|
| `--port N` | `7777` | Listen port (also `BRIGADE_PORT`) |
| `--host A` | `127.0.0.1` | Bind address (loopback by design) |
| `--verbose` | off | Stream a one-line summary of every event |
| `--quiet` | off | Suppress the live console stream |
| `--log-level X` | `info` | `debug` / `info` / `warn` / `error` |

**Optional authentication.** By default the gateway is unauthenticated and refuses to
bind anywhere but loopback. To require a token, run `brigade gateway token new` (repeat
for multiple tokens) and restart the gateway. On the same machine, clients read the
token from config automatically; elsewhere pass `--token <t>` or set
`BRIGADE_GATEWAY_TOKEN`. `BRIGADE_GATEWAY_TOKENS` (comma-separated) adds tokens via the
environment. Remove every token to return to open, localhost-only mode.

### `brigade connect`

Attaches a TUI to a running gateway. Same chat experience as `brigade`, but the
agent runs in the gateway process — so you can disconnect, walk away, reconnect
later, and pick up where you left off while channel adapters and cron jobs keep
running.

```bash
brigade connect --host 127.0.0.1 --port 7777
```

### `brigade agents`

Brigade ships with a default agent called `main`. Add more — each agent has its own
workspace (persona files), auth profiles, exec allowlist, sessions, and optional
channel/account routing bindings.

```bash
brigade agents                                          # list every agent (default)
brigade agents list [--json] [--bindings]
brigade agents bindings [--agent <id>] [--json]
brigade agents bind --agent <id> --bind <spec> [--bind <spec> …] [--json]
brigade agents unbind --agent <id> (--bind <spec> … | --all) [--json]
brigade agents add [name] [--workspace <dir>] [--model <id>] [--provider <id>]
                  [--agent-dir <dir>] [--bind <spec> …] [--non-interactive] [--json]
brigade agents set-identity --agent <id> [--from-identity]
                  [--name <…>] [--theme <…>] [--emoji <…>] [--avatar <…>] [--json]
brigade agents delete <id> --force [--json]
```

`agents add` without `--workspace` defaults to `~/.brigade/agents/<id>/workspace/`.
A binding `<spec>` is `"<channel>"` or `"<channel>:<accountId>"`. Delete requires
`--force`.

### `brigade doctor`

Health-checks Node version, your `~/.brigade/` directory, config, configured
providers, log sink, prompt files, and (optionally) a running gateway. Exits 0 on
pass, 1 on failure.

```bash
brigade doctor
brigade doctor --gateway ws://127.0.0.1:7777
brigade doctor --json            # machine-readable
brigade doctor --strict          # exit 1 on warnings (CI mode)
```

### `brigade update`

Bring Brigade up to date and reload the gateway. It auto-detects how Brigade is
installed and does the right thing:

- **npm global** — `npm i -g @spinabot/brigade@latest`, then restart.
- **source checkout** — `git pull` (fast-forward, only when your tree is clean and
  behind upstream — a dirty tree is left untouched and rebuilt as-is), then
  `npm install`, `npm run build`, then restart.

```bash
brigade update            # update + restart the gateway
brigade upgrade           # alias of update
brigade update --check    # report whether newer code is available; change nothing
brigade update --no-restart
```

If Brigade is installed as a background service (`brigade gateway install`) the
restart is automatic; if you run the gateway in the foreground, restart it yourself
to load the new code. Same behavior on macOS, Linux, and Windows.

### `brigade config`

Read and write the local config without opening the TUI.

```bash
brigade config list
brigade config get agents.defaults.provider
brigade config set agents.defaults.provider openrouter
brigade config unset agents.defaults.thinking
brigade config file              # print the resolved config path
brigade config validate          # schema-check the current config
```

### `brigade cron`

Schedule recurring or one-shot agent turns. Pick exactly one of `--cron`, `--every`,
or `--at`; pair `--cron` with an IANA `--tz`.

```bash
brigade cron list
brigade cron add --cron "0 9 * * *" --tz "Asia/Kolkata" --message "good morning"
brigade cron add --at "2026-06-04T09:00:00+05:30" --message "stand-up reminder"
brigade cron run <jobId>         # fire it now
brigade cron enable <jobId>      # / disable / rm <jobId>
```

A payload can be a `--message` (system event into your main session), an isolated
agent turn (`--model`, `--tools`, `--light-context`), and an optional delivery
target (`--channel`, `--to`).

### `brigade channels`

Connect external messaging channels — WhatsApp, Telegram, Slack, Discord, iMessage,
and BlueBubbles ship today.

```bash
brigade channels list
brigade channels link --channel whatsapp         # WhatsApp: pair via QR / code
brigade channels add  --channel telegram         # Telegram: set up a bot token
brigade channels status --channel telegram
brigade channels allow list --channel telegram   # add / remove allowed senders
brigade pairing approve <code> --channel telegram # approve a waiting sender
brigade channels disable --channel whatsapp
```

### Telegram setup (end to end)

A Telegram bot is a separate account from you, so Brigade establishes ownership on
the **gateway** — never by whoever texts the bot first.

1. **Create the bot.** In Telegram, message [@BotFather](https://t.me/BotFather),
   send `/newbot`, and copy the API token it returns.
2. **Add it to Brigade** (on the gateway machine), then start the gateway:
   ```bash
   brigade channels add --channel telegram    # paste the bot token when prompted
   brigade gateway restart                     # load the channel
   ```
3. **Claim ownership.** DM your bot anything — it replies with a one-time code and
   asks an admin to approve it. Approve it once, from the gateway:
   ```bash
   brigade pairing approve <code> --channel telegram
   ```
   The **first** approval on a Telegram bot makes you the owner. Because approving
   requires access to the gateway machine, that access *is* the proof it's really
   you — nobody becomes owner just by sending `/start`.
4. **Run it from the chat.** As owner you're never challenged again, and you manage
   everyone else from Telegram itself:

   | Command | Who | What |
   |---|---|---|
   | `/start` · `/help` | admitted | welcome + command list |
   | `/pending` | owner | list people waiting for approval |
   | `/approve <code>` | owner | admit a waiting person — takes effect immediately, no restart |
   | `/deny <code>` | owner | reject a pending request |
   | `/allowlist add\|remove <id>` | owner | manage approved senders directly |
   | `/whoami` · `/agent <id>` | admitted | see / pin which agent answers you |

Everyone else who messages the bot gets a pairing challenge; only you (in chat) or
the gateway CLI can let them in. Multiple bots or accounts each track their own owner.

---

## In-chat commands

When you're in the chat TUI (`brigade` or `brigade connect`):

| Command | What it does |
|---|---|
| `/agent [<id>]` | Show or switch the agent this connection is bound to |
| `/agents` | List every agent the gateway knows about |
| `/sessions`, `/session <key>` | List or switch sessions for the current agent |
| `/model [<id>]`, `/provider` | Switch model (picker or by id), or add a provider mid-session |
| `/thinking <level>` | Reasoning effort (off, minimal, low, medium, high) |
| `/reasoning [on\|off]` | Toggle whether thinking blocks render |
| `/compact` | Force a context compaction now |
| `/abort`, `/steer "<text>"` | Stop the current turn, or inject mid-turn guidance |
| `/usage` | Token + cost usage for this session |
| `/help`, `/exit` | Show all commands / quit |

Keyboard: **Enter** sends · **Ctrl+C** stops the current response · **Ctrl+D**
quits · **↑/↓** history.

---

## Built-in tools

Every agent gets a curated toolset. Mutating/privileged tools are owner-gated
(either per-call or owner-only).

- **Coding (pi SDK):** `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`
- **Memory:** `recall_memory`, `read_memory`, `write_memory`, `manage_memory`
- **Sub-agents:** `spawn_agent` (sync), `spawn_agents` (parallel fan-out)
- **Cross-session:** `sessions_send`, `sessions_spawn`, `sessions_list`,
  `sessions_history` (gated by visibility + A2A policy)
- **Crew management:** `agents_list`, `manage_agent`, `manage_skill`,
  `manage_provider`, `manage_access`, `manage_channel_access`, `org` (when
  `cfg.org` is set)
- **Scheduling:** `cron` (schedule jobs from inside a turn)
- **Web:** `web_search`, `fetch_url`, `browser` (when a provider is configured)
- **Connectors:** `composio` (1,000+ apps), `oauth_authorize`
- **Generation:** `generate_image`
- **Documents & media:** `analyze_media` (read/understand PDF · Office · image · audio · video), `make_document` · `edit_document` (create & edit Word/Excel/PowerPoint/PDF)
- **Channels:** `send_message`, `send_media` (when a channel is linked)

---

## Multi-agent isolation

Every agent has its own workspace, persona, credentials, memory, sessions, exec
approvals, and routing bindings. By design:

- Agent A cannot read agent B's session transcripts (unless visibility ≠ `self`).
- Agent A cannot send to agent B's session unless `cfg.session.agentToAgent` (the
  A2A policy) permits it.
- Memory facts are per-agent and origin-scoped — they don't bleed between agents.
- Provider credentials are per-agent — e.g. `support` and `prod-bot` can use
  different accounts.

The default policy is `visibility: "self"` (an agent only sees its own sessions);
switch to `"tree"` to let a parent see sub-agents it spawned.

---

## Providers & web search

**Models out of the box:** Anthropic, OpenAI, Google Gemini, OpenRouter, Groq,
Cerebras, xAI, DeepSeek, Mistral, **Ollama** (local), and **Custom**
OpenAI-compatible endpoints (Together, Fireworks, vLLM, LM Studio, on-prem gateways
— anything that speaks `/v1/chat/completions`). Connect several at once, switch with
`/model`, and Brigade keeps your context across the switch.

**Sign in with a subscription — no API key.** Don't want to manage keys, consoles,
and billing? Use the subscription you already pay for. Two ways, both keyless:

- **Browser sign-in** — `brigade login` signs in to **Claude Pro/Max**, **ChatGPT
  Plus/Pro**, or **GitHub Copilot** over OAuth (also offered inside `brigade onboard`).
- **Reuse a CLI login** — already signed into the **Claude Code** or **Codex** CLI on
  this machine? `brigade onboard` offers *"Reuse this machine's login"* — one keystroke,
  no browser, no re-auth.

Keys still work if you prefer them; either way the credential is sealed on your own
machine (auto-refreshed when the provider supports it).

**Web search** is pluggable and auto-selected by what you've configured: Tavily,
Brave, Exa, Perplexity, Firecrawl, SearXNG (keyed) and DuckDuckGo, Wikipedia, Hacker
News, arXiv, GitHub, npm, local Ollama (keyless).

---

## Configuration & storage

Brigade keeps every byte of state under `~/.brigade/` — `rm -rf ~/.brigade` truly
wipes everything it knows.

```
~/.brigade/
├── brigade.json              # main config (JSON5; ${VAR} secret refs preserved on write)
├── brigade.json.bak{,.1..4}  # rotating forensic backups (mode 0600)
├── models.json               # custom provider catalog (Ollama / custom endpoints)
├── workspace/                # default agent (main): SOUL/IDENTITY/AGENTS/USER/TOOLS/
│   │                         #   BOOTSTRAP/HEARTBEAT.md persona files
│   ├── memory/facts.jsonl    # write_memory / recall_memory
│   └── skills/               # drop-a-folder skills
├── agents/<id>/              # per-agent isolation
│   ├── workspace/            # same shape, per agent
│   ├── sessions/<id>.jsonl   # transcripts (one file per session)
│   └── agent/                # auth-profiles.json, models.json (mode 0600)
├── channels/<id>/<account>/  # channel state (auth, allow-from, pairings)
├── cron/runs/<jobId>.jsonl   # cron state + per-run logs
├── logs/                     # daily rolling logs + config audit
└── gateway.{pid,lock,heartbeat}
```

**Useful environment overrides:**

| Var | Purpose |
|---|---|
| `BRIGADE_STATE_DIR` | Alternate state directory (default `~/.brigade`) |
| `BRIGADE_CONFIG_PATH` | Alternate config file path |
| `BRIGADE_PORT` | Gateway port (default `7777`) |
| `BRIGADE_PROFILE` | Named profile (`workspace-<profile>/`) |
| `BRIGADE_MODE` | `filesystem` or `convex` |
| `BRIGADE_CONVEX_URL` | Convex deployment URL (implies convex mode) |
| `BRIGADE_ENCRYPTION_KEY` | At-rest encryption master key (hex) |
| `BRIGADE_ENABLE_INBOX_PERSIST` | Persist the sub-agent inbox to JSONL (auto-on at gateway boot) |
| `BRIGADE_HOST_ENV` | Override the host-environment tag in the system prompt's runtime line |

---

## Storage modes: filesystem vs. Convex

Brigade defaults to **filesystem** mode (everything under `~/.brigade/`). It also
ships an optional **Convex** backend you can run **fully self-hosted** — no cloud
account, no telemetry. The mode resolves from a sticky sentinel and **freezes once
at boot**.

```bash
brigade store mode show                                   # what mode am I in?
brigade store mode set convex --convex-url http://127.0.0.1:3210
brigade store migrate --to convex --dry-run               # preview a migration
brigade store migrate --to filesystem                     # copy data back
```

Run the **bundled** self-hosted Convex backend — no Convex account, no separate
install. The backend binary + functions ship inside Brigade, so this works from
anywhere once `brigade` is installed, not just a repo checkout:

```bash
brigade convex dev       # download the backend if needed, then run it + dashboard (foreground)
brigade convex status    # is the backend up? (probes :3210)
brigade convex push      # deploy the bundled Convex functions to the backend
brigade convex codegen   # regenerate convex/_generated/ against the local backend
```

`brigade convex dev` runs the backend on `:3210`, the site proxy on `:3211`, and
the dashboard on `:6791`, with binaries + data under `~/.brigade/convex/`. Ctrl-C
to stop; the `brigade convex:dev` colon form works too. Then point Brigade at it
with `brigade store mode set convex --convex-url http://127.0.0.1:3210` (above).

> Running from a repo checkout? The `npm run convex:install` / `convex:dev` /
> `convex:codegen` scripts still work and write into the repo's `bin/` + `.convex-data/`.

Turn on **at-rest encryption** for Convex byte columns (credentials, persona,
memory, cron payloads, transcripts) with `BRIGADE_ENCRYPTION_KEY`:

```bash
brigade encrypt init     # generate a 32-byte key
brigade encrypt status   # is a key configured? self-check
brigade encrypt test     # round-trip seal/open
```

See [docs/convex-mode.md](docs/convex-mode.md) for the full runbook.

---

## MCP memory server

Brigade can expose your long-term memory to any MCP client over stdio:

```bash
brigade mcp                 # serves the `main` agent's memory
brigade mcp --agent support # a specific agent
```

It surfaces add / search / context tools, owner-bound. Point an MCP client (an
editor, a desktop assistant, etc.) at the command `brigade mcp`.

---

## Tideline (long-term memory)

Tideline is the **model-agnostic long-term memory engine** that backs Brigade.
Where a transcript is what an agent *just said*, Tideline is what it *knows* —
durable facts about you and your work, written under a trust gate, recalled by
meaning, decayed when stale, and reconciled over time. It's structured to be lifted
out as its own package (`brigade-tideline`).

It's built to survive the three ways naive "vector store" memory breaks:

| Pillar | What it does |
|---|---|
| 🛡️ **Provenance write-gate** | An untrusted source (a web page, a tool result) can't author or overwrite your identity/preferences/corrections. Poisoning writes are rejected. |
| 🔒 **Per-origin isolation** | Owner facts and per-channel/peer facts are scoped so one principal's memory never surfaces in another's recall. |
| 🔎 **Hybrid recall, no model needed** | BM25 keyword search + a **model-free** HRR vector recovery lane, so semantically-close phrasings match offline. Plug in a learned embedder to upgrade. |
| ⏳ **Bi-temporal decay + trust** | Recency/usage decay and source-trust fold into one effective ranking score; `permanent` facts never decay. |
| 🔗 **Typed link graph** | `supersedes` / `corrects` / `relates` / `supports` / `contradicts` edges power graph-recall and contradiction handling. |
| 🌙 **Reflect / consolidate** | A nightly pass confirms repeated beliefs, merges duplicates, writes association edges, and evicts decayed noise. |

**The flow, end to end:**

```
WRITE    add() → write-gate (trusted vs untrusted × protected segment) → dedup → store
RECALL   query → BM25 + HRR vector → graph walk → decay×trust score → origin filter → budgeted block
MAINTAIN decay GC → nightly dream (consolidate/relate) → contradiction detection
```

Each record carries a `segment` (identity / preference / correction / relationship /
project / knowledge / context), a `tier` (short / long / permanent), an `importance`,
and an `origin`.

```ts
import { Tideline } from "brigade-tideline";

const memory = Tideline.open("/path/to/workspace");
memory.add({ content: "I keep a strict vegetarian diet.", segment: "preference" });
const block = memory.context("dietary restrictions", { maxChars: 800 });
```

In Brigade you reach it through the `recall_memory` / `read_memory` / `write_memory` /
`manage_memory` tools and via auto-recall (which **fails closed** for unknown peers,
so operator memory never leaks). An evaluation harness (`brigade-tideline/eval`)
measures recall@k / MRR / nDCG@k on deterministic gold sets — run `npm run bench`.

📖 Full write-up: **[docs/tideline.md](docs/tideline.md)** ·
package surface: [`src/tideline/`](src/tideline/)

---

## Extending Brigade

Brigade ships a typed extension SDK. Drop a module into `~/.brigade/extensions/` and
register against a slot:

```ts
import { defineModule } from "@spinabot/brigade/extension-sdk";

export default defineModule((b) => {
  b.tool({ /* a custom agent tool */ });
  b.webSearch({ /* a search provider */ });
  b.channel({ /* a messaging adapter */ });
  b.gatewayMethod({ /* a gateway RPC */ });
});
```

Shipped slots include `tool`, `hook`, `command`, `modelProvider`, `channel`,
`webSearch`, `webFetch`, `integration`, `service`, `httpRoute`, and `gatewayMethod`.
Voice/media slots (`tts`, `stt`, `mediaGen`) and pluggable `memory` backends have
locked contracts with implementations on the roadmap. See [AGENTS.md](AGENTS.md) for
how to add a tool, channel, skill, or provider.

---

## Privacy

Brigade is a local CLI. Your API keys never leave your computer; they're stored in
your home directory at mode `0600` and used only to talk to the providers you
connect. **No telemetry, no analytics, no cloud component.** For Ollama and custom
endpoints, requests stay on your network. The gateway binds to `127.0.0.1` by
default.

---

## Develop from source

```bash
git clone https://github.com/spinabot/brigade.git
cd brigade
npm install
npm run build        # tsc → dist/
```

**Run from your checkout** (npm scripts wrap the binary so you don't type `node`):

```bash
npm run dev          # smart runner: rebuilds dist/ if src/ is newer, then runs
npm run dev:tsx      # run TypeScript directly via tsx (no build, slower per call)
npm run watch        # tsx --watch: auto-restart on edit
npm link             # make `brigade` available globally → this checkout
```

**Surface shortcuts** (all wrap `scripts/run-brigade.mjs`):

```bash
npm run onboard          # brigade onboard
npm run tui              # brigade tui
npm run gateway          # brigade gateway run     (also gateway:status / gateway:stop)
npm run connect          # brigade connect
npm run agent -- -m hi   # brigade agent -m hi
npm run agents:list      # brigade agents list     (agents:add / agents:bind / …)
npm run status           # brigade status          (status:json)
npm run doctor           # brigade doctor          (doctor:json / doctor:strict)
npm run channels:list    # brigade channels list   (wa:link / pairing:list / …)
npm run skills:list      # brigade skills list
npm run logs             # brigade logs            (logs:follow)
```

**Checks** (CI runs the same three):

```bash
npm run typecheck    # tsc --noEmit, strict
npm test             # node:test, tempdir-isolated (281 test files)
npm run build        # ensure the production build compiles
npm run bench        # memory / recall evaluation benchmarks
```

**Storage / Convex dev:** `npm run store:mode:show`, `npm run convex:install`,
`npm run convex:dev`, `npm run convex:codegen`.

Full contributor guide, repo layout, and conventions live in **[AGENTS.md](AGENTS.md)**.

---

## Contributing

Contributions are welcome! Read **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup,
coding conventions, and the Conventional-Commits release flow. For security issues, see
**[SECURITY.md](SECURITY.md)** — please report privately. Releases are automated with
release-please; see **[docs/RELEASING.md](docs/RELEASING.md)**.

Questions or ideas? Open a
[discussion](https://github.com/spinabot/brigade/discussions) or email
**hello@brigade-agent.ai** (security → **security@brigade-agent.ai**).

---

## License

[MIT](LICENSE) © Spinabot

## 🦁 Brigadiers

A pride of contributors who make Brigade better. Thank you to everyone who has
joined the crew!

<!-- brigadiers:start -->
[![Bhasvanth-Dev9380](https://avatars.githubusercontent.com/u/157608971?v=4&s=48)](https://github.com/Bhasvanth-Dev9380) [![Ranjithsingh2004](https://avatars.githubusercontent.com/u/122562396?v=4&s=48)](https://github.com/Ranjithsingh2004)
<!-- brigadiers:end -->

Want to join the pride? See [CONTRIBUTING.md](CONTRIBUTING.md).
