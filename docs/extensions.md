# Authoring Brigade extensions

An **extension** is the unit of Brigade extensibility. One extension (a *module*)
can register any mix of agent-level capabilities (tools, hooks, slash commands,
model providers) and product-level capabilities (channels, voice, media,
memory backends, background services, HTTP routes, gateway RPC methods) — all
through a single `register(b)` function.

This guide covers how to write one, how Brigade discovers it, the safety model,
and the CLI commands that help you build + debug it.

---

## The shape of a module

Every extension exports a module built with `defineModule`:

```ts
import { defineModule } from "brigade/extension-sdk";

export default defineModule({
  id: "my-extension",
  register(b) {
    // register capabilities through b.* here
  },
});
```

- `id` is a stable, kebab-case identifier (also the folder name).
- `register(b)` receives the extension context `b`. Everything you register is
  **recorded** — agent-level registrations are replayed into every agent turn,
  and product-level registrations are started once by the gateway at boot.

You may also export an array of modules, or attach an optional `manifest`,
`requiresEnv`, `configSchema`, and `eligible()` gate. See the SDK types for the
full surface.

---

## How discovery works

Brigade loads two sets of modules:

1. **Built-in** modules that ship with Brigade.
2. **Your** modules, dropped into your extensions folder:
   `~/.brigade/extensions/`.

A candidate in that folder is either a top-level file (`*.js`, `*.mjs`, `*.ts`,
`*.mts`) or a folder containing an `index.{js,mjs,ts,mts}`. Each must
`export default` a module (or an array of modules); anything else is skipped
with a clear reason — a broken add-on never stops Brigade from starting.

TypeScript loads directly: there is **no build step**. Brigade transpiles
`.ts`/`.mts` on import, so you can author in TypeScript and run it as-is.

A built-in module always wins an id conflict with one of yours, so an add-on
can't quietly shadow a core capability.

---

## The SDK imports

You import Brigade's stable authoring surface by name — you do **not** install
Brigade into your extensions folder:

- `brigade/channel-sdk` — for authoring a **channel** (the channel contract plus
  the shared helpers every channel reuses).
- `brigade/extension-sdk` — for everything else (the full `defineModule` +
  capability surface).

Brigade resolves these imports to its own bundled SDK automatically.

---

## The three kinds

`brigade extensions init <id> --kind <kind>` scaffolds a runnable starter for
each:

- **channel** — connects Brigade to a messaging surface. You implement a small
  adapter (`start` / `stop` / `sendText`, plus optional media, reactions,
  read-receipts, …) and register it with `b.channel(adapter)`. Import from
  `brigade/channel-sdk`.
- **tool** — gives the agent a new action it can call during a turn. Register it
  with `b.tool({...})`. Import from `brigade/extension-sdk`.
- **provider** — plugs an external capability in (e.g. a web-search backend).
  Register it with the matching `b.*` method (`b.webSearch`, `b.webFetch`,
  `b.tts`, `b.mediaGen`, …). A provider only activates once it reports itself as
  configured. Import from `brigade/extension-sdk`.

The default kind is `channel`.

---

## The safety model

On non-Windows systems, Brigade applies safety checks to each candidate file
**before** it is loaded, so a tampered or misplaced file never runs its code:

- **world-writable** files are rejected (anyone could drop code in),
- files owned by a **different unprivileged user** are rejected,
- a **symlink that points outside** your extensions folder is rejected.

Each rejection is reported with its reason and the candidate is skipped; the
rest still load. Windows doesn't carry these file-permission bits, so the gate
is skipped there.

Two more guardrails protect startup: a candidate whose top-level code hangs is
time-boxed and skipped, and a module whose `register()` hangs is time-boxed too
— a misbehaving add-on can never wedge a turn or boot.

---

## The CLI

### `brigade extensions list`

Lists every extension Brigade knows about — built-in and your own — with whether
each one loaded. Add `--json` for machine-readable output.

### `brigade extensions doctor`

The "why didn't my plugin load" surface. For each of your extensions it shows,
step by step, whether the file:

1. passed the safety check,
2. loaded without errors,
3. exported a valid Brigade module.

When something is wrong it tells you exactly which step failed and how to fix it.
Add `--json` for machine-readable output.

### `brigade extensions init <id> [--kind channel|tool|provider]`

Scaffolds a starter extension into `~/.brigade/extensions/<id>/` — an `index.ts`
wired to the right SDK plus a short `README.md`. It refuses (cleanly) if a folder
with that name already exists. Edit `index.ts`, then run
`brigade extensions doctor` to confirm it loads.

---

## A minimal channel

```ts
import { defineModule } from "brigade/channel-sdk";
import type { ChannelAdapter, ChannelStartContext } from "brigade/channel-sdk";

function createMyChannelAdapter(): ChannelAdapter {
  return {
    id: "my-channel",
    label: "My Channel",
    isConfigured(_cfg, _env) {
      return false; // return true once you have what you need to run
    },
    async start(ctx: ChannelStartContext) {
      // connect, and call ctx.onInbound({ channel: "my-channel", conversationId, from, text })
      // for each incoming message
    },
    async stop() {
      // tear down
    },
    async sendText(conversationId, text) {
      // deliver the reply
    },
  };
}

export default defineModule({
  id: "my-channel",
  register(b) {
    b.channel(createMyChannelAdapter());
  },
});
```

Run `brigade extensions init my-channel` to get this (and a README) generated for
you.
