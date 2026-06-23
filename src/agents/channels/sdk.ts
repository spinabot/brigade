/**
 * ════════════════════════════════════════════════════════════════════════════
 *  Brigade Channel SDK — the COMPLETE surface for authoring a channel
 * ════════════════════════════════════════════════════════════════════════════
 *
 * One import for everything a new channel adapter (Slack, Discord, iMessage, …)
 * needs: the CONTRACT it implements (BOTH the single-account `ChannelAdapter`
 * AND the multi-account `ChannelPlugin`), the SHARED HELPERS every channel
 * reuses (the inbound pipeline, the approval router, the last-channel pin), and
 * the central capabilities (inline-button approvals, message actions, the
 * durable token seal, the webhook HTTP route). The goal is that the NEXT channel
 * — including a multi-account + webhook + native-commands channel like Discord —
 * is built ENTIRELY on this barrel: no reaching across into `whatsapp/`,
 * `../types.*`, `../inbound-pipeline`, `../approval-router`, `../manager`, or
 * `../../extensions/` for a stray type or helper.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  TWO AUTHORING PATHS
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   A. SINGLE-ACCOUNT adapter (`ChannelAdapter`) — one live connection per
 *      gateway, started by the legacy `startChannels` manager. Simplest path;
 *      implement `start/stop/sendText/…` and register via `b.channel(adapter)`.
 *
 *   B. MULTI-ACCOUNT plugin (`ChannelPlugin`) — run N accounts of the same
 *      channel at once (`channels.<id>.accounts: [{ id, … }, …]`). You implement
 *      the sub-adapters (`config`/`gateway`/`outbound`/`security`/`status`/
 *      `actions`/`secrets`/`approvalCapability`), partition per-account runtime
 *      state in a `Map<accountId, …>`, and drive each account's inbound through
 *      the SHARED `runChannelInboundPipeline` so every account carries the
 *      identical ACL + debounce + abort + approval surface. Telegram's
 *      `plugin.ts` is the reference; mirror it.
 *
 * Most real channels ship BOTH: the `ChannelAdapter` is the per-connection
 * worker, and the `ChannelPlugin` wraps `createXAdapter()` once per account.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  HOW TO AUTHOR A CHANNEL — the 8-file skeleton
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Mirror the `telegram/` layout (the reference token-based channel):
 *
 *   channels/<id>/
 *     ├─ module.ts          register: `defineModule({ id, register(b){ b.channel(createXAdapter()) } })`
 *     ├─ adapter.ts         implement `ChannelAdapter` (id/label/start/stop/sendText/…)
 *     ├─ plugin.ts          implement `ChannelPlugin` (multi-account: config/gateway/outbound/…)
 *     ├─ connection.ts      the live transport (lazy-import the heavy SDK here)
 *     ├─ account-config.ts  resolve per-account config + token (see secret seal below)
 *     ├─ format.ts          markdown → the channel's native markup
 *     ├─ inbound-extras.ts  normalize provider payloads → `InboundMessage` fields
 *     ├─ command-menu.ts    map `buildBundledCommands(adapter)` → native `/`-menu (optional)
 *     ├─ webhook.ts         build the inbound `HttpRoute` for push transport (optional)
 *     ├─ media.ts           in/out media (run `validateOutboundMediaPath` on send)
 *     └─ index.ts           re-export the public surface
 *
 *   plus tests alongside each (`*.test.ts`).
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  REGISTRATION
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   1. `module.ts` calls `b.channel(createXAdapter())` inside `defineModule`.
 *   2. Add the module to the bundled module list (`extensions/modules/index.ts`).
 *   3. Account config lives under `~/.brigade/channels/<id>/<accountId>/`.
 *   4. Lazy-import the heavy transport SDK inside `connection.ts` (Baileys /
 *      grammY style) so a non-X boot never pays for it.
 *   5. Implement reconnect with `nextBackoffDelay({ attempt, initialMs, maxMs,
 *      factor, jitter })` (do NOT hand-roll the curve) + a capped attempt count.
 *   6. Run inbound through dedupe (`createDedupeCache`) and outbound media
 *      through `validateOutboundMediaPath` before uploading bytes.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  MULTI-ACCOUNT PLUGIN PATH (`ChannelPlugin`)
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   1. Declare `id` / `meta` / `capabilities` / `config` (required) plus the
 *      sub-adapters you support (`gateway`/`outbound`/`security`/`status`/
 *      `actions`/`secrets`/`approvalCapability`). Omit a slot to opt out; the
 *      manager pre-checks `capabilities.<flag>` before calling an adapter.
 *   2. `config.listAccountIds(cfg)` + `config.resolveAccount(cfg, id)` drive
 *      multi-account discovery. Make the legacy single-account `ChannelAdapter`
 *      STEP ASIDE when >1 account is configured (its `isConfigured` returns
 *      false for the default account) so the two paths never double-start.
 *   3. In `gateway.startAccount`, build a per-account pipeline with
 *      `createInboundPipelineContext({ adapter, config, agentId, runTurn,
 *      commandMap, parentAbort })` and feed each inbound through
 *      `runChannelInboundPipeline(pipeline, msg)` (stamp `msg.accountId`).
 *      Build the command map from `buildBundledCommands(adapter)`.
 *   4. Register a PER-ACCOUNT approval dispatcher with
 *      `registerChannelApprovalDispatcher(channelId, accountId, dispatcher)` on
 *      start and `removeChannelApprovalDispatcher(channelId, accountId)` on stop,
 *      so an exec-gate prompt raised by a turn on (channel, accountId) replies on
 *      that same account — not the channel default.
 *   5. Take `runTurn` from the gateway via `StartChannelsArgs["runTurn"]`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  WEBHOOK / PUSH TRANSPORT (`HttpRoute`)
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   For channels that receive updates via an inbound POST (Telegram webhook
 *   mode, Slack Events API, …) instead of long-polling:
 *     • Build an `HttpRoute` (the `HttpRoute` type is re-exported here) whose
 *       handler verifies the provider's signature / secret header FIRST (before
 *       parsing the body), then feeds the parsed update into the started
 *       adapter's normalize+dedupe+dispatch path.
 *     • Register it from `module.ts` via `b.httpRoute(route)`, gated on config so
 *       a default polling install exposes NO inbound HTTP surface.
 *     • Set `auth: "none"` ONLY when the provider authenticates via a signed
 *       payload the handler verifies itself (the gateway can't present operator-
 *       auth to a third-party webhook); otherwise use `auth: "operator"`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  NATIVE COMMAND MENU
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   Brigade owns the channel command set centrally (`buildBundledCommands(adapter)`
 *   → `/help`, `/status`, `/allowlist`, `/agent`, `/agents`, `/whoami`, `/org`,
 *   plus module-registered `ChannelCommand`s). A channel with a native `/`-menu
 *   (Telegram `setMyCommands`, Discord application commands) maps that set onto
 *   the provider's shape on connect — see `telegram/command-menu.ts`. Advertise
 *   `capabilities.nativeCommands: true`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  OPTING INTO CENTRAL CAPABILITIES
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   • Inline-button approvals: set `adapter.approvalCapability.sendApprovalPrompt`
 *     (render `buildApprovalCallbackButtons({ approvalId })` as native buttons whose
 *     `callback_data` is each button's `.data`). Deliver the press back as
 *     `InboundMessage.callbackQuery` — the central pipeline decodes + resolves
 *     it. Add `authorizeApprover` to refuse non-operator pressers.
 *     NOTE: native-button approvals currently fire on the MULTI-ACCOUNT plugin
 *     path only. A single-account `ChannelAdapter` that sets `sendApprovalPrompt`
 *     still falls back to the text approval card today (`authorizeApprover` IS
 *     honored on both paths) — use the plugin path for native single-account buttons.
 *   • Message actions (edit / delete / react / pin): the CANONICAL path is the
 *     single-account `ChannelAdapter.handleAction({ conversationId, action,
 *     accountId?, signal? })`. Implement THAT and advertise the matching
 *     `capabilities` flags (`edit` / `unsend` / `reactions` / `reply`); the
 *     central `message_action` tool pre-checks the flag before calling you.
 *     NOTE: the `ChannelPlugin.actions` typed slot (`ChannelMessageActionAdapter`,
 *     a `{ cfg, runtime, target, … }` shape) is a DEAD slot — it is NOT consumed
 *     by the message-action path, so it is deprecated and no longer part of this
 *     barrel. Implementing it alone gives your channel NO message actions.
 *   • Outbound id: return `{ messageId }` from `sendText`/`sendMedia` so the
 *     agent can reference "my last message" via `message_action`.
 *   • Durable token: `connect_channel` seals tokens via `sealChannelToken`;
 *     read yours back at start with `readSealedChannelToken("<id>")` as a token
 *     source (survives a gateway reboot when the live env is gone).
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ENUMERATION TESTS TO UPDATE when you add a channel-related agent tool
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   • `agents/tools/registry.test.ts`        — the sorted tool-name list + count
 *   • `agents/session-wiring.test.ts`        — the brigade-tool list + counts
 *   • `agents/tools/owner-only.test.ts`      — the customTools count + name list
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  DESIGN NOTE — RE-EXPORT, never RELOCATE
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Helpers like `chunkText` physically live where they were first written
 * (`whatsapp/chunk.js`) and WhatsApp imports them directly. Moving a file would
 * change WhatsApp's import and risk the one channel that works perfectly, so
 * this barrel RE-EXPORTS from where things already are — it has zero runtime
 * behaviour of its own. The codec + the durable-seal + the backoff helper DO
 * live in `channels/` (they are channel-neutral by design) and are re-exported
 * here as the canonical author-facing surface.
 */

/* ───────────────────────── contract: register ───────────────────────── */

export {
	/** Register a channel through the extension seam: `defineModule({ id, register(b){ b.channel(adapter) } })`. */
	defineModule,
} from "../extensions/types.js";

/* ───────────────────────── contract: core adapter + message types ───────────────────────── */

export type {
	/** The channel contract every adapter implements (start/stop/sendText/handleAction/…). */
	ChannelAdapter,
	/** A normalized inbound message handed to `ChannelStartContext.onInbound`. */
	InboundMessage,
	/** Inbound media attachment saved to disk (image / voice / document / …). */
	InboundMediaAttachment,
	/** Quoted-reply context an inbound carries when it replies to a prior message. */
	InboundReplyContext,
	/** Forwarded-message provenance attached to a forwarded inbound. */
	InboundForwardContext,
	/** What the manager passes to `adapter.start(ctx)` — onInbound, log, signal, pairing hooks. */
	ChannelStartContext,
	/** Synchronous health verdict an adapter exposes via `health()`. */
	ChannelHealth,
	/** A `/command` handler a channel can register. */
	ChannelCommand,
	/** Context handed to a channel `/command` handler. */
	ChannelCommandContext,
	/** Per-channel pairing customization (idLabel, allow-entry normalize, approve notify). */
	ChannelPairingAdapter,
	/** Declarative setup wizard (`brigade channels add`) credential prompts. */
	ChannelSetupAdapter,
	/** One credential key the setup wizard prompts for. */
	ChannelSetupCredentialKey,
	/** Outbound media descriptor for `adapter.sendMedia(...)`. */
	OutboundMedia,
	/** Per-send options (threadId, accountId) for `adapter.sendText(...)`. */
	OutboundSendOptions,
	/** A live reply-stream handle returned by `adapter.beginReplyStream(...)`. */
	ChannelReplyStream,
	/** The module shape `defineModule` returns / consumes. */
	BrigadeModule,
} from "../extensions/types.js";

/* ───────────────────────── contract: capability flags ───────────────────────── */

export type {
	/** Static capability flags a channel advertises (`reactions`/`edit`/`unsend`/`reply`/`media`/…). */
	ChannelCapabilities,
} from "./types.core.js";

/* ───────────────────────── bundled channel metas (single source of truth) ───────────────────────── */

export {
	/** WhatsApp's user-facing `ChannelMeta` — import this for your plugin's `meta` field. */
	WHATSAPP_CHANNEL_META,
	/** Telegram's user-facing `ChannelMeta` — import this for your plugin's `meta` field. */
	TELEGRAM_CHANNEL_META,
	/** Every bundled channel meta in declaration order (the meta registry seeds from this). */
	BUNDLED_CHANNEL_METAS,
} from "./bundled-channel-metas.js";

/* ───────────────────────── channel-meta registry + markdown gate ───────────────────────── */

export {
	/** Register/replace a channel's `ChannelMeta` at runtime (external/future channels). */
	registerChannelMeta,
	/** Look up a registered channel's full `ChannelMeta` by id/alias (undefined if unknown). */
	getRegisteredChannelPluginMeta,
	/** Friendlier alias of `getRegisteredChannelPluginMeta`. */
	getChatChannelMeta,
	/** Every channel meta currently known (built-in + dynamic). */
	listChannelMetas,
} from "./channel-meta-registry.js";

export {
	/** True iff a channel renders markdown (defaults ON for an unknown channel — no regression). */
	isMarkdownCapableChannel,
	/** Message-channel markdown gate — also treats internal/cli/tui surfaces as markdown-capable. */
	isMarkdownCapableMessageChannel,
} from "./markdown-capability.js";

/* ───────────────────────── outbound addressing: the channel-messaging registry ───────────────────────── */

export {
	/** Register a channel's OUTBOUND `messaging` adapter (parse/normalize/resolve). The plugin
	 *  engine calls this so `send_message` can address by name/handle/explicit target. */
	registerChannelMessagingAdapter,
	/** Bulk-register every plugin's `messaging` adapter (gateway bootstrap seeds with its plugin list). */
	syncChannelMessagingAdaptersFromPlugins,
	/** Look up a channel's registered messaging adapter by id (undefined → raw-id passthrough). */
	getChannelMessagingAdapter,
	/** Turn a loose `to` into a concrete outbound target via the channel's messaging adapter (or
	 *  return the raw `to` unchanged when none is registered). Never throws. */
	resolveOutboundTarget,
	/** Heuristic: does a `to` read like a human contact NAME (vs an already-concrete id)? */
	looksLikeContactName,
} from "./channel-messaging-registry.js";
export type {
	/** Outcome of `resolveOutboundTarget` ({ to, channelId?, usedAdapter, resolvedByName }). */
	ResolvedOutboundTarget,
} from "./channel-messaging-registry.js";

/* ───────────────────────── channel-exposure resolver (visibility surfaces) ───────────────────────── */

export {
	/** Resolve a channel's `meta.exposure` (+ legacy show* flags) to concrete per-surface booleans. */
	resolveChannelExposure,
	/** True when the channel should appear in "configured channels" views. */
	isChannelVisibleInConfiguredLists,
	/** True when the channel should be offered in the setup / onboarding wizard. */
	isChannelVisibleInSetup,
	/** True when the channel should be surfaced in generated docs / help. */
	isChannelVisibleInDocs,
} from "./exposure.js";
export type {
	/** The `ChannelMeta` subset the exposure resolver reads. */
	ChannelExposureInput,
	/** Concrete per-surface exposure verdict (every key resolved to a boolean). */
	ResolvedChannelExposure,
} from "./exposure.js";

/* ───────────────────────── contract: message actions + approvals ───────────────────────── */

export type {
	/** The action union the agent can take on a message (reply/react/edit/delete/pin/unpin). */
	ChannelMessageAction,
	/** Result of a message action ({ ok, messageId?, error? }). */
	ChannelMessageActionResult,
	/** The native inline-button approval capability an adapter opts into. */
	ChannelApprovalCapability,
	/** Approval prompt params handed to `sendApprovalPrompt`. */
	ChannelApprovalPromptParams,
	/** Approval kind discriminator ("exec" | "plugin"). */
	ChannelApprovalKind,
	/** Decision kinds an approval button can encode. */
	ChannelApprovalDecisionKind,
	/** Outcome params for `formatApprovalOutcome`. */
	ChannelApprovalOutcomeParams,
	/** A config-path entry declaring a secret-ref target for the secrets system. */
	SecretTargetRegistryEntry,
} from "./types.adapters.js";

/* ───────────────────────── shared helper: outbound chunking ───────────────────────── */

export {
	/**
	 * Split a long outbound message into provider-safe chunks WITHOUT shredding
	 * code fences / paragraphs. Lives under `whatsapp/` for history; it is
	 * channel-agnostic (Telegram reuses it with `{ limit: 4096 }`). Re-exported
	 * here so new channels don't reach across into the WhatsApp folder.
	 */
	chunkText,
} from "./whatsapp/chunk.js";

/* ───────────────────────── shared helper: inbound dedupe ───────────────────────── */

export {
	/** Build a per-channel inbound dedupe cache (claim-once, LRU + TTL). Options:
	 *  `{ maxEntries, ttlMs }` — the cap field is `maxEntries` (NOT `max`; a stray
	 *  `max` type-checks but is silently ignored). */
	createDedupeCache,
} from "./dedupe.js";
export type { DedupeCache, DedupeOptions } from "./dedupe.js";

/* ───────────────────────── shared helper: outbound media guard ───────────────────────── */

export {
	/**
	 * Refuse to ATTACH a local secret / system file on outbound media — the
	 * content-exfil guard every `sendMedia` path must run before uploading
	 * a local path's bytes to a conversation.
	 */
	validateOutboundMediaPath,
} from "../../security/media-path-guard.js";
export type { MediaPathVerdict } from "../../security/media-path-guard.js";

/* ───────────────────────── shared helper: structured logger ───────────────────────── */

export {
	/** Named JSON subsystem logger — `createSubsystemLogger("channels/<id>")`. */
	createSubsystemLogger,
} from "../../logging/subsystem-logger.js";
export type { SubsystemLogger } from "../../logging/subsystem-logger.js";

/* ───────────────────────── shared helper: reconnect backoff ───────────────────────── */

export {
	/**
	 * Jittered exponential reconnect-delay helper shared by every channel.
	 * Pass the schedule ({ attempt, initialMs, maxMs, factor, jitter }); the
	 * arithmetic is WhatsApp's proven curve. WhatsApp + Telegram both delegate
	 * to it; a new channel should too instead of hand-rolling its own.
	 */
	nextBackoffDelay,
} from "./backoff.js";
export type { BackoffSchedule } from "./backoff.js";

/* ───────────────────────── central: inline-button approval codec ───────────────────────── */

export {
	/** Encode `{ approvalId, decision }` into a <=64-byte callback payload (undefined if oversized). */
	encodeApprovalCallback,
	/** Decode a callback payload back to `{ approvalId, decision }` (null if not ours / malformed). */
	decodeApprovalCallback,
	/** True iff a string fits the universal 64-byte callback-data budget. */
	fitsApprovalCallback,
	/** Build the standard Allow once / Allow always / Deny buttons (label + encoded payload). */
	buildApprovalCallbackButtons,
	/** The universal callback-data byte ceiling (Telegram's 64). */
	APPROVAL_CALLBACK_MAX_BYTES,
} from "./approval-callback-codec.js";
export type {
	/** Decisions an inline approval button can encode. */
	ApprovalCallbackDecision,
	/** One inline approval button: label + decision + encoded payload. */
	ApprovalCallbackButton,
} from "./approval-callback-codec.js";

/* ───────────────────────── central: durable channel-token seal ───────────────────────── */

export {
	/** Durably seal a channel's token into the encrypted credential store (survives reboot). */
	sealChannelToken,
	/** Read a channel's durably-sealed token (""→ none) at start time, no agent context needed. */
	readSealedChannelToken,
	/** Provider key a channel's token is sealed under (`channel:<id>`). */
	channelSecretProvider,
} from "./channel-secrets.js";

/* ───────────────────────── single-account essentials: config + state paths + storage mode ───────────────────────── */

export type {
	/**
	 * The Brigade super-config every channel is handed — `ChannelAdapter.isConfigured(cfg)`,
	 * `ChannelStartContext.cfg`, and most plugin sub-adapters are typed against it. Every channel
	 * must be able to NAME this type, so it ships on the barrel (re-exported from the public shim).
	 */
	BrigadeConfig,
} from "../../config/types.js";

export {
	/** A channel's own per-account state dir (`~/.brigade/channels/<id>/<accountId>/`) — where it
	 *  persists its auth/creds/downloaded media. Pair with `ensureDir`. */
	resolveChannelStateDir,
	/** `mkdir -p` for a channel's state/media dirs. */
	ensureDir,
	/** OS cache dir for EPHEMERAL channel scratch (media temp), kept OUTSIDE `~/.brigade`. */
	resolveOsCacheDir,
} from "../../config/paths.js";

export {
	/** Storage-mode awareness — the runtime store context, or `undefined` in filesystem mode. A
	 *  channel that persists state branches on `tryGetRuntimeContext()?.mode === "convex"`. */
	tryGetRuntimeContext,
} from "../../storage/runtime-context.js";

export {
	/** Load the live config off disk — a defensive fallback for `start()` when no cfg was threaded in. */
	loadConfig,
} from "../../core/config.js";

export {
	/** Strip Brigade's internal reasoning/markers from a reply before rendering. The inbound pipeline
	 *  already applies this centrally — use only for a bespoke reasoning-surfacing path. */
	sanitizeReplyForChannel,
} from "./reply-sanitizer.js";

/* ───────────────────────── central: general (non-approval) inline-button callbacks ───────────────────────── */

export {
	/** Prefix a channel stamps on a general inline button's `callback_data` so the pipeline routes the
	 *  press back as a synthetic turn (an unprefixed, non-approval callback is dropped). Pairs with the
	 *  approval-callback codec above — approvals vs general buttons are the two inline-button lanes. */
	GENERAL_CALLBACK_PREFIX,
	/** True iff a callback payload is a general (prefixed) one — distinguishes it from an approval press. */
	isGeneralCallbackData,
	/** Decode a general callback payload back to the value the button carried. */
	decodeGeneralCallbackData,
} from "./general-callback.js";

/* ═══════════════════════════════════════════════════════════════════════════
 *  MULTI-ACCOUNT CHANNEL PLUGIN SURFACE
 *
 *  Everything below is what a MULTI-ACCOUNT channel (run N accounts of the same
 *  channel at once) + a WEBHOOK channel + a NATIVE-COMMANDS channel needs on top
 *  of the single-account `ChannelAdapter` contract above. Telegram's `plugin.ts`
 *  / `webhook.ts` / `command-menu.ts` build ENTIRELY on these re-exports.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── plugin: the contract ───────────────────────── */

export type {
	/**
	 * The MULTI-ACCOUNT channel contract. Wrap your `createXAdapter()` once per
	 * configured account; declare `id`/`meta`/`capabilities`/`config` (required)
	 * plus the sub-adapter slots you support. Generic over the channel's resolved
	 * per-account state (and optional probe/audit payload shapes).
	 */
	ChannelPlugin,
} from "./types.plugin.js";

/* ───────────────────────── plugin: core identity + meta + capability ───────────────────────── */

export type {
	/** Canonical kebab-case plugin id (also the `cfg.channels.<id>` key + dir name). */
	ChannelId,
	/** User-facing display metadata (labels, blurb, docs path, ordering, exposure). */
	ChannelMeta,
	/** Exposure tier controlling which setup surfaces list the channel. */
	ChannelExposure,
	/** Per-account lifecycle state surfaced by `brigade status`. */
	ChannelAccountState,
	/** Open-shaped per-account snapshot row returned by `status.buildAccountSnapshot`. */
	ChannelAccountSnapshot,
	/** A single status row for `status.collectStatusIssues`. */
	ChannelStatusIssue,
	/** One diagnostic line emitted by `status.formatCapabilitiesProbe`. */
	ChannelCapabilitiesDisplayLine,
	/** Diagnostics block emitted by `status.buildCapabilitiesDiagnostics`. */
	ChannelCapabilitiesDiagnostics,
	/** Cross-cutting runtime context (logger + abort signal) handed to side-effect adapters. */
	RuntimeEnv,
} from "./types.core.js";

/* ───────────────────────── plugin: sub-adapter contracts ───────────────────────── */

export type {
	/** Adapter 1 — account discovery + enable/disable/resolve (always required). */
	ChannelConfigAdapter,
	/** Adapter 2 — per-account inbound listener lifecycle (start/stop/logout) + webhook auth-bypass paths. */
	ChannelGatewayAdapter,
	/** Per-account context handed to `gateway.startAccount` / `stopAccount`. */
	ChannelGatewayContext,
	/** Per-account context handed to `gateway.logoutAccount` (carries `purge`). */
	ChannelLogoutContext,
	/** Result of `gateway.logoutAccount`. */
	ChannelLogoutResult,
	/** Adapter 3 — outbound dispatch (sendText / sendMedia / sendReaction). */
	ChannelOutboundAdapter,
	/** Reusable outbound address shape ({ channel, to, accountId?, threadId? }). */
	ChannelOutboundTarget,
	/** Adapter 4 — DM-policy decisions + doctor warnings + audit findings. */
	ChannelSecurityAdapter,
	/** Per-call context for the security adapter's check methods. */
	ChannelSecurityContext,
	/** DM policy verdict ("owner" | "allow-from" | "all"). */
	ChannelSecurityDmPolicy,
	/** A single structured finding from `security.collectAuditFindings`. */
	ChannelSecurityAuditFinding,
	/** Adapter 5 — config-change / removal / startup-maintenance hooks. */
	ChannelLifecycleAdapter,
	/** Adapter 6 — probe + snapshot + diagnostics for `brigade status`. */
	ChannelStatusAdapter,
	// Adapter 7 (`ChannelMessageActionAdapter`, the `ChannelPlugin.actions` slot)
	// is intentionally NOT re-exported: it is a DEAD slot the message-action path
	// never reads. Message actions flow through the runtime
	// `ChannelAdapter.handleAction({ conversationId, … })` instead — see the
	// "OPTING INTO CENTRAL CAPABILITIES → Message actions" note in the header.
	/** Adapter 8 — secret-target registry entries for the secrets system. */
	ChannelSecretsAdapter,
	/**
	 * Adapter 10 — OUTBOUND addressing: explicit-target parse + normalize + an
	 * OPTIONAL name/handle resolver. The `send_message` tool consumes it via
	 * `channel-messaging-registry` to turn a loose `to` into a concrete target.
	 * A channel that omits it keeps raw-id-straight-to-sendText behaviour.
	 */
	ChannelMessagingAdapter,
	/** Parsed explicit-target shape returned by `messaging.parseExplicitTarget`. */
	ParsedExplicitTarget,
	/**
	 * Bivariance box for adapter callbacks that need a narrower `account` type at
	 * the call site than the manager's generic (lets the rename through, no `as`).
	 */
	BivariantCallback,
} from "./types.adapters.js";

/* ───────────────────────── pipeline: the shared inbound engine ───────────────────────── */

export {
	/**
	 * Run ONE inbound message end-to-end through the shared pipeline (media + reply
	 * note synthesis → access gate → mark-read → approval-callback + approval-reply
	 * intercept → abort triggers → channel command → 8-tier route → last-channel pin
	 * → optional debounce → dispatchTurn → reply). Never throws. Both the legacy
	 * manager and every multi-account plugin call THIS so the safety surface is
	 * identical on every channel.
	 */
	runChannelInboundPipeline,
	/** Build a fresh per-channel-instance pipeline context (per account on the plugin path). */
	createInboundPipelineContext,
	/**
	 * Build the bundled built-in channel commands (`/help`, `/status`, `/allowlist`,
	 * `/agent`, `/agents`, `/whoami`, `/org`) an operator can DM to admin the bot.
	 * Feed the result into your `commandMap` AND into a native command menu.
	 */
	buildBundledCommands,
	/** Disambiguating lane key for inflight + pending maps ((adapter, account, conversation, thread)). */
	laneKey,
} from "./inbound-pipeline.js";
export type {
	/** Per-channel-instance pipeline context — captures every dispatch-time dep. */
	InboundPipelineContext,
	/** runTurn signature shared by the legacy manager and the plugin path. */
	RunChannelTurnFn,
	/** Result of one channel turn — only the reply text matters. */
	ChannelTurnResult,
	/** A pending debounce slot — accumulated text waiting to dispatch. */
	PendingDispatch,
} from "./inbound-pipeline.js";

/* ───────────────────────── approvals: the channel approval router ───────────────────────── */

export {
	/**
	 * Register a (per-account) dispatcher so an exec-gate approval prompt raised by
	 * a channel-routed turn lands IN that conversation. Pass `(channelId, accountId,
	 * dispatcher)` on the multi-account path so each account routes to itself.
	 */
	registerChannelApprovalDispatcher,
	/** Drop a channel's (per-account) dispatcher + deny its in-flight prompts on stop. */
	removeChannelApprovalDispatcher,
	/** Send an approval prompt via the channel + register the pending entry (called by the bridge). */
	dispatchChannelApproval,
	/** Intercept a yes/no TEXT reply as the answer to a pending approval for this peer. */
	tryConsumeChannelApprovalReply,
	/** Intercept an inline-BUTTON press (callback_query) as the answer to a pending approval. */
	tryConsumeChannelApprovalCallback,
	/** Cancel a pending approval by request id (e.g. on session abort). */
	cancelChannelApprovalById,
	/** Diagnostic — list registered dispatcher keys. */
	listChannelApprovalDispatchers,
	/** Diagnostic — snapshot of pending channel approvals. */
	listPendingChannelApprovals,
} from "./approval-router.js";
export type {
	/** The route a channel-routed turn carries so its approval prompt comes back to the same peer. */
	ChannelApprovalRoute,
	/** Per-(account) dispatcher capability surface the router needs to ask the operator. */
	ChannelApprovalDispatcher,
} from "./approval-router.js";

/* ───────────────────────── manager: gateway boot args (for the plugin's runTurn dep) ───────────────────────── */

export type {
	/**
	 * The args the gateway hands `startChannels` at boot. A multi-account plugin
	 * takes its serialized turn executor as `StartChannelsArgs["runTurn"]` — the
	 * gateway funnels every channel turn through one queue so they never overlap.
	 * (`startChannels` itself is framework-internal: the gateway boots it, a
	 * channel never calls it.)
	 */
	StartChannelsArgs,
	/** The live channel-manager handle the gateway owns (started ids, stop, adapter lookup, live start/stop). */
	ChannelManager,
	/** Outcome of a runtime single-channel start attempt. */
	StartChannelResult,
	/** Outcome of a runtime single-channel stop attempt. */
	StopChannelResult,
} from "./manager.js";

/* ───────────────────────── last-channel: the announce-target pin ───────────────────────── */

export {
	/**
	 * Pin THIS channel as the agent's most-recently-active (called by the pipeline
	 * on every admitted inbound). A cron's announce-delivery reads it as the
	 * last-resort target when no explicit channel was set. The pipeline already
	 * calls this for you; a channel only calls it directly for a bespoke surface.
	 */
	recordLastChannelForAgent,
	/** Read the agent's last-recorded channel (undefined when no channel activity yet). */
	getLastChannelForAgent,
} from "./last-channel.js";
export type {
	/** One operator's most recently active channel + peer + thread record. */
	LastChannelRecord,
} from "./last-channel.js";

/* ───────────────────────── webhook: the gateway HTTP route surface ───────────────────────── */

export type {
	/**
	 * A module-registered HTTP route on the gateway's server. A push-transport
	 * channel (Telegram webhook, Slack Events API) builds one of these — verify the
	 * provider signature/secret in the handler, then feed the update into the
	 * adapter — and registers it via `b.httpRoute(route)` from `module.ts`.
	 */
	HttpRoute,
	/** The handler signature an `HttpRoute` carries: `(req, res) => void | Promise<void>`. */
	HttpRouteHandler,
} from "../extensions/types.js";
