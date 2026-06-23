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

---

## Channel slot methods

`b.channel(adapter)` registers the connection worker (`start` / `stop` /
`sendText` / …). Three further context methods let a channel opt into central
seams **without** dragging its runtime into the send / inbound / policy paths.
Each is keyed by `channelId` explicitly, and a channel that never calls one keeps
today's behaviour by construction.

### `b.channelMessaging(channelId, adapter)` — name / handle addressing

```ts
b.channelMessaging("my-channel", adapter);
```

Registers a `ChannelMessagingAdapter` so the `send_message` tool can turn the
agent's loose `to` ("Alex", "@alex", "my-channel:123") into a concrete target,
and so a name-addressed inbound collapses onto the same conversation the outbound
side resolves to.

```ts
type ChannelMessagingAdapter = {
  // Required. Recognize an explicit `scheme:value` / `@handle` form → split into
  // an optional channel id + bare target. Return null when it isn't explicit.
  parseExplicitTarget: (text: string) => { channelId?: string; target: string } | null;
  // Required. Canonicalise a target id into the channel's stable shape. Must be idempotent.
  normalizeTarget: (raw: string) => string;
  // Optional. Resolve a human NAME/handle → a concrete id (a contact directory).
  // Return null (sync or async) when it doesn't resolve.
  targetResolver?: (name: string) => Promise<string | null> | string | null;
  // Optional. Best-effort DM-vs-group guess for a normalized target.
  inferTargetChatType?: (target: string) => "dm" | "group" | undefined;
  // Optional. Human-readable label for a target, for tool results / logs.
  formatTargetDisplay?: (target: string) => string;
  // Optional INBOUND hook (the inverse of targetResolver). Canonicalise an
  // incoming peer id → a stable conversation/session identity. Must be cheap,
  // side-effect-free, and must not throw.
  resolveInboundConversation?: (peerId: string) => string | null;
};
```

- **Outbound** runs through `resolveOutboundTarget({ channelId, to })`:
  `parseExplicitTarget` → optional `targetResolver` (only for name-shaped input)
  → `normalizeTarget`. It **never throws** — a misbehaving adapter degrades to
  the raw `to`.
- **Inbound** runs through `resolveInboundConversation({ channelId, peerId })`
  just before the route resolver; a `null`/empty result (or no hook) keeps the
  raw peer id, so routing stays byte-identical.

### `b.channelSecurity(channelId, adapter)` — tighten-only DM-policy consult + doctor audit

```ts
b.channelSecurity("my-channel", adapter);
```

Registers a **supplementary** `ChannelSecurityAdapter`. The authoritative
access-control engine (config allow-from, owner bootstrap, pairing) is **not**
replaced — this adapter sits on top of it.

```ts
type ChannelSecurityAdapter = {
  // Optional. A supplementary DM-policy opinion ("owner" | "allow-from" | "all"
  // | "disabled"), or null to take no opinion.
  resolveDmPolicy?: (ctx: ChannelSecurityContext) => ChannelSecurityDmPolicy | null;
  // Optional. Free-text warnings for `brigade doctor`.
  collectWarnings?: (ctx: ChannelSecurityContext) => string[] | Promise<string[]>;
  // Optional. Structured findings ({ checkId, severity, title, detail, remediation? })
  // for `brigade doctor`.
  collectAuditFindings?: (ctx) => ChannelSecurityAuditFinding[] | Promise<ChannelSecurityAuditFinding[]>;
};
```

- **DM policy** is consulted via `consultChannelDmPolicy({ channelId, base, ctx })`
  under a strict **TIGHTEN-ONLY** rule: the central `base` policy stays
  authoritative, and the adapter may only ever move it *tighter* on the ladder
  `open < allowlist < pairing < disabled` (author values map
  `all→open`, `allow-from→allowlist`, `owner→pairing`, `disabled→disabled`). An
  opinion that would loosen `base` is ignored; `null`/throw leaves `base`
  unchanged. It **never throws**.
- **Audit** findings are surfaced by `collectChannelSecurityAudit(...)` for
  `brigade doctor`'s per-channel security section; a throwing adapter is skipped
  and never breaks the doctor run.

### `b.httpRoute(route)` — webhook inbound

```ts
b.httpRoute(route);
```

Mounts an `HttpRoute` on the gateway's HTTP server — the inbound path for a
push-transport channel (Telegram webhook, Slack Events API) or any plugin
endpoint. Register it gated on config so a default polling install exposes no
inbound HTTP surface.

```ts
interface HttpRoute {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; // any when omitted
  path: string;                                          // e.g. "/webhooks/my-channel"
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  // "none" (default): public — the handler verifies the provider's signature itself.
  // "operator": the gateway gates the route on operator-auth (admin endpoints).
  auth?: "none" | "operator";
  match?: "exact" | "prefix";   // "exact" (default); "prefix" matches sub-paths
  maxBodyBytes?: number;        // 413 above this; defaults to 1 MiB
  timeoutMs?: number;           // 408 past this; defaults to 30s
  skipSessionGuard?: boolean;   // opt out of the default-pass cross-agent guard
}
```

Verify the provider's signature / secret header **first** (before parsing the
body), then feed the parsed update into the started adapter's
normalize + dedupe + dispatch path. Use `auth: "none"` **only** when the provider
authenticates via a signed payload the handler checks itself (the gateway can't
present operator-auth to a third-party webhook); otherwise use `auth: "operator"`.
