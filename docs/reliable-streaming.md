# Reliable streaming — the gateway subscription + render contract

This is the contract a web, mobile, or desktop client follows to stream a
Brigade agent's output (assistant text + interleaved tool calls + tool results)
so that **messages always land in order, none go missing, and each renders in
the right place** — across flaky networks, backgrounded phones, and gateway
restarts, with no "pull to refresh" and no duplicated or misplaced bubbles.

The reference client is `src/tui/client.ts` (`BrigadeClient`); the reference
renderer is `src/cli/commands/connect.ts`. A new client mirrors the same wire
shapes (`src/protocol.ts`) over its own transport.

## The one idea

**The committed transcript is the single source of truth. The live stream is a
fast accelerator on top of it.** Both resolve to the same messages, keyed by
identity — so any dropped, reordered, or duplicated live frame self-heals by
re-reading the transcript, and re-applying a message you already have is a
no-op.

## Wire frames (`src/protocol.ts`)

Every frame is JSON with a `type` discriminator:

| `type`     | direction | meaning |
|------------|-----------|---------|
| `req`      | client→server | a request: `{ type, id, method, params }` |
| `res`      | server→client | the paired reply: `{ type, id, ok, payload?, error?:{code,message,retryable?,retryAfterMs?} }` |
| `event`    | server→client | a push: `{ type, event, payload, seq? }` |
| `tick`     | server→client | keepalive `{ type, ts }` (liveness only) |
| `shutdown` | server→client | graceful restart notice `{ type, reason }` |
| `hello-ok` | server→client | FIRST frame on connect (handshake — see below) |

The streamed agent output arrives as `event` frames with `event: "pi"`, whose
`payload` is `{ event: PiEvent, agentId, sessionId, subagentDepth? }`. The inner
`event` conforms to the exported `PiEvent` discriminated union (mirrors Pi's
`AgentSessionEvent`; switch on `event.type`, the values in `PI_EVENT_TYPES`).
`error.code` is one of the exported `ErrorCodes`.

### Connect handshake (`hello-ok`)

The **first** frame the server sends on every connection is `hello-ok` — a
client reads it to learn everything it needs to subscribe, with no hardcoding:

```
{ type: "hello-ok",
  protocol: 1,                              // bump only on a breaking wire change
  server: { version, connId, epoch },       // epoch = process boot id (restart detection)
  features: { methods: string[], events: string[] },   // everything callable + subscribable
  policy: { maxPayload, maxBufferedBytes, tickIntervalMs },
  auth?: { role } }
```

`features.methods` is the live list (core wire methods + registered control-plane
RPCs); `features.events` is every `event` name. `epoch` changes when the gateway
restarts — if it differs from the epoch you saw last, the server's seq counters
reset, so **invalidate your seq cursors and `resume`** rather than treat the new
low seq as a backwards gap. `BrigadeClient` does this for you (`"hello"` event +
`client.server`) and clears cursors on an epoch change automatically.

### `seq` — the gap detector

Every **ordered** frame carries a per-session monotonic `seq` (1, 2, 3, …):
top-level `pi`, `approval-request`, and `system-event` — they **share one
counter per session**, so a client detects a gap in ANY of them. Unordered
side-channels (`state`, `error`, `log`) and **sub-agent `pi` frames**
(`subagentDepth > 0`) carry **no `seq`**: sub-agent output is ephemeral nested
decoration in a child's separate transcript the parent's `resume` can't
backfill, so it's rendered live but not sequenced. The recoverable, ordered
stream is the top-level conversation + its approvals + its system notices.

A client tracks the last `seq` it saw **per session**. When the next one isn't
`last + 1` — a jump (missed frame), a reorder, or a lower value (the gateway
restarted and reset its counter) — the live view may be incomplete, so the
client **resumes** (below). First frame seen for a session is never a gap. The
client must NOT rewind its cursor on `resume` (the cursor is owned by the live
receive path); doing so on a busy session causes a resync storm.
(See `src/protocol/stream-seq.ts`: `nextSeq`, `isSeqGap`.)

## `resume` — the recovery primitive

```
req  { method: "resume", params: { agentId?, sessionKey? } }
res  { ok: true, payload: ResumeSnapshot }
```

`ResumeSnapshot = { sessionKey, agentId, messages, headSeq, pendingApprovals, recentSystemEvents, epoch, snapshot }`

- `messages` — the ordered conversation (`WireMessage[]`: `user` / `assistant` /
  `toolResult`), oldest first. The committed transcript.
- `headSeq` — the session's current head `seq`. Live frames continue from
  `headSeq + 1`; any frame with `seq ≤ headSeq` is a duplicate, applied
  idempotently. (Do not force your cursor to this — see the seq note above.)
- `pendingApprovals` — tool-approval prompts STILL pending on this session.
  This is the recovery for the one event that loses an operator *action*: a
  client that connected after, or missed, the live `approval-request` renders
  these and resolves them via `approval-resolve`, instead of the turn hanging to
  auto-deny. Empty when nothing is pending.
- `recentSystemEvents` — a bounded tail of recent `system-event` notices, so a
  client that was away when one fired can still surface it.
- `epoch` — the gateway's process boot id; if it changed since your last
  `hello-ok`, the server restarted (invalidate cursors).
- `snapshot` — header state (provider / model / tokens / running).

`resume` works identically in filesystem and Convex storage modes (it reads the
same transcript the agent persists). Cheap and safe to call on every connect.
Together with the shared seq, this means **nothing emitted is lost**: a dropped
`pi`/`approval-request`/`system-event` frame is detected (seq gap) and fully
recovered here.

## The reliability loop (what the client does)

1. **Connect.** Open the socket (send a token only if the gateway is
   authenticated — see `docs`/`gateway-auth`). The first frame is `hello-ok` —
   read it for the protocol version, the callable methods + subscribable events,
   the policy limits, and `epoch`. Bind a status indicator to the client's
   `"connection-state"` event (`connecting` / `connected` / `reconnecting` /
   `closed`).
2. **Subscribe** to the lane you want: `req subscribe { agentId, sessionId }`.
   Without a subscribe you receive everything (back-compat).

   **Delivery rules**, in order — the first that matches wins:

   - A frame carrying neither `agentId` nor `sessionId` goes to everyone.
   - A frame whose `parentSessionKey` is a session you subscribed to is
     delivered: a sub-agent spawned by your thread is yours to see.
   - **If you named a session on the frame's agent, that is your scope** —
     the agent's *other* sessions (cron runs, channel traffic, a second chat)
     are filtered out. Pass `scope: "agent"` to opt out and take the agent's
     whole stream instead; `scope: "session"` is the default.
   - Otherwise you get anything matching a broader `agentId` or `sessionId`
     subscription.

   Naming a session used to widen delivery to the agent as well, which meant
   other threads bled into your view. If your client names a session for a
   reason OTHER than narrowing — a snapshot push gated on the session id, say —
   pass `scope: "agent"`.

   **Deltas** are opt-in: `subscribe { deltas: true }` strips `message.content`
   from `message_update` frames (roughly 18x fewer bytes on a long answer) and
   requires the client to append `text_delta` / `thinking_delta` itself. Leave
   it unset and frames stay byte-identical to the pre-delta protocol.

   Both are advertised in `hello-ok` under `features.capabilities`
   (`subscribe.scope`, `subscribe.deltas`, `resume.seq`). **Feature-detect on
   those names, not on `protocol`** — the version integer is bumped only if the
   frames themselves become unparseable, and behaviour changes ride capabilities
   so an unknown name is safely ignorable.
3. **Resume.** `resume` → render `messages` (see render contract), set the seq
   cursor to `headSeq`. This loads history on first connect and backfills the
   gap on a reconnect.
4. **Stream live.** Apply each `pi` frame through the *same* renderer. Because
   render is identity-keyed and idempotent, frames that overlap the resume
   snapshot are harmless no-ops.
5. **Heal automatically.** On a detected **seq gap** or a **reconnect**, go back
   to step 3 (`resume`) and rebuild. Nothing is ever lost or stuck.

`BrigadeClient` does the seq tracking for you: it emits a `"resync"` event on a
gap and exposes `resume()` (which also syncs the cursor). The reference TUI
calls `resume()` on first connect, on `"reconnected"`, and on `"resync"`.

## The render contract (how to place messages correctly)

Model the transcript as an **ordered list of blocks keyed by identity**, never
by arrival position. Apply deltas by updating the keyed block; never blindly
append.

### Keys

- **Assistant text block:** `${subagentDepth}:${message.timestamp}`.
  Pi stamps each assistant message with a stable `timestamp` at creation that is
  constant across all of that message's `message_update`s and its `message_end`.
  A continuation **after** a tool call is a **new** message with a **new**
  timestamp → a new block. `subagentDepth` (0 = top-level) keeps sub-agent
  streams separate. (Helper: `asstKey` in `connect-transcript.ts`.)
- **Tool block:** the tool call's `toolCallId` (stable from
  `tool_execution_start` through `tool_execution_end`, and present as the
  `toolCall.id` content block on the assistant message + the `toolCallId` on the
  matching `toolResult` message).

### Applying Pi events

- `message_update` / `message_end` → the `message` is the **full cumulative
  snapshot** of that assistant message (not a delta). Resolve its block by key
  and **set its content** (apply-by-replace). Create the block on first sight.
- `tool_execution_start` → insert a tool block keyed by `toolCallId`. **Do not**
  close or reposition any assistant block — the next assistant message has a new
  timestamp and naturally opens a fresh block below the tool.
- `tool_execution_end` → update the `toolCallId` block with the ✓/✗ + a short
  result preview.
- **Flush rule:** when a tool starts, paint any pending assistant text first, so
  text that preceded the tool renders above it.

### Applying a resume snapshot

Walk `messages` in order and render each through the same keyed apply:
- `user` → a user bubble.
- `assistant` → its text block (keyed as above) + a pending tool block for each
  `toolCall` content block.
- `toolResult` → fill in its `toolCallId` block's ✓/✗ + preview.

Because keys match the live stream, a snapshot rebuilt over an existing view
updates blocks in place (no duplicates) and appends only what was missing. The
reference TUI rebuilds its transcript region wholesale on resume; a web/mobile
client typically diffs a keyed message list (React/SwiftUI/Compose make this
trivial).

## Backpressure

The gateway bounds each client's send buffer; a consumer that falls too far
behind is closed (`1008`). That is **safe** because the client reconnects and
`resume`s — and because `seq` is stamped before the per-client send, a single
dropped frame makes the next frame's seq jump for that client, which triggers a
resume too. No drop is ever silent or permanent.

## Heartbeat / liveness

The server's keepalive today is the periodic `state` broadcast (a real frame
that bumps the client's last-frame timestamp) plus WS-protocol pings; the
`tick` frame type exists for forward-compat but isn't emitted yet (the client
tolerates it). If NO frame arrives in `2 × TICK_INTERVAL_MS`, the client closes
and reconnects — catching half-open sockets, the common backgrounded-mobile
case — then resumes.

## Minimal client pseudocode

```ts
const client = new BrigadeClient({ url, token });
await client.connect();

const render = (piEvent) => applyByIdentity(transcript, piEvent); // see contract
client.on("pi", (p) => render(p.event));

const recover = async () => {
  const snap = await client.resume({ agentId, sessionKey }); // syncs seq cursor
  rebuildFromMessages(transcript, snap.messages);            // keyed, idempotent
};

await client.request("subscribe", { agentId, sessionId: sessionKey });
await recover();                 // initial history
client.on("reconnected", recover); // backfill after a drop
client.on("resync", recover);      // backfill after a mid-stream gap
```

That is the whole contract: **subscribe → resume → apply live by identity →
resume again on any gap.** In order, nothing missing, nothing misplaced.
