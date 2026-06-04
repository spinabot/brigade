/**
 * Brigade extension seam — the contracts every capability plugs into.
 *
 * Brigade's plugin layer = Pi 0.73's native extension engine (agent-level:
 * tools / hooks / commands / model providers) + thin Brigade "capability
 * registries" for the product surfaces Pi has no concept of (channels, voice,
 * media, integrations, memory backends). A single **module** registers across
 * both through one context (`BrigadeExtensionContext`); the loader records each
 * registration, replays the agent-level ones into every Pi session as an
 * `ExtensionFactory`, and hands the product-level ones to the gateway.
 *
 * THE NO-REWRITE GUARANTEE: every capability contract below is fixed HERE, once.
 * Adding a Slack channel, a background service, an HTTP webhook, or an RPC method
 * means writing a module that calls `b.channel(...)` / `b.service(...)` /
 * `b.httpRoute(...)` / `b.gatewayMethod(...)` — the gateway already consumes those
 * registries, so existing code never changes. Voice (`b.tts`/`b.stt`) and media
 * (`b.mediaGen`) contracts are likewise fixed; the gateway surfaces them today via
 * `system.capabilities`, and the turn-time synthesis/transcription wiring lands
 * with the Voice/Media phase against these same shapes.
 *
 * Provides a full plugin-API register surface, but realized as Pi extensions +
 * light capability registries instead of a bespoke engine.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { TSchema } from "typebox";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";

/* ─────────────────────────── capability contracts ─────────────────────────── */
/* These are the LOCKED interfaces. Implementations arrive per phase; the shapes
 * are stable so nothing downstream is rewritten when a capability lands. */

/** Outbound media payload — what the agent wants to send out via `sendMedia`. */
export interface OutboundMedia {
	kind: "image" | "video" | "audio" | "voice" | "document" | "sticker";
	/** Absolute path to the file on disk. */
	path: string;
	/** Override the file name surfaced to the recipient (documents). */
	fileName?: string;
	/** Caption to render alongside image/video/document. */
	caption?: string;
	/** Override MIME (defaults to a kind-specific value). */
	mimeType?: string;
}

/** Inbound media attachment (image / voice note / document / sticker / video). */
export interface InboundMediaAttachment {
	/** What it is. */
	kind: "image" | "video" | "audio" | "voice" | "document" | "sticker";
	/** Absolute path on disk where the adapter saved the bytes (under ~/.brigade). */
	path: string;
	/** Detected MIME type, e.g. "image/jpeg". */
	mimeType?: string;
	/** Original file name (documents) or sender-provided caption-extracted name. */
	fileName?: string;
	/** Caption sent alongside the media; surfaces as `text` when no other text was sent. */
	caption?: string;
}

/** Context of a previous message the inbound is replying to. */
export interface InboundReplyContext {
	/** Stable id of the quoted message, when the channel exposes one. */
	messageId?: string;
	/** A short excerpt of the quoted body so the LLM can see what was replied to. */
	body?: string;
	/** Sender id of the quoted message. */
	from?: string;
}

/** A normalized inbound message from any channel (WhatsApp/Slack/Telegram/…). */
export interface InboundMessage {
	/** Channel id, e.g. "whatsapp". */
	channel: string;
	/** Stable conversation/chat id within the channel (the session-key seed). */
	conversationId: string;
	/**
	 * Channel-native id of THIS inbound message (e.g. Baileys `msg.key.id`).
	 * Used by the manager to call `adapter.markRead` after the access-control
	 * gate allows the message. `undefined` for channels that don't expose a
	 * stable id per inbound.
	 */
	messageId?: string;
	/**
	 * Channel-native id of the speaker on a group message (e.g. WhatsApp
	 * `msg.key.participant`). Used alongside `messageId` for read receipts on
	 * group rooms where the platform tracks read state per-participant.
	 */
	participantId?: string;
	/**
	 * When the platform stamped this message (epoch ms). Compared against
	 * `adapter.connectedAt()` to detect "queued during the gateway downtime"
	 * messages — those are SUPPRESSED from triggering pairing challenges, so
	 * a Brigade restart doesn't burst-spam every stranger who DM'd while we
	 * were offline. `undefined` for channels without per-message timestamps.
	 */
	messageTimestampMs?: number;
	/** Sender id within the channel (phone/user id). */
	from: string;
	/** Plain text of the message (may be empty when media has no caption). */
	text: string;
	/** Optional display name of the sender. */
	fromName?: string;
	/**
	 * `direct` (a DM) or `group` (a multi-party room). Channels that don't
	 * carry the distinction (Slack channels behave like groups) should pick
	 * `group`. The access-control gate routes on this.
	 */
	chatType?: "direct" | "group";
	/** True iff `chatType === "group"`. Convenience flag for gates that don't care about other distinctions. */
	isGroup?: boolean;
	/**
	 * Channel-native ids of accounts mentioned/@-tagged in the message
	 * (e.g. WhatsApp jids in a group). Empty when no @-mentions were used.
	 */
	mentions?: string[];
	/**
	 * Quoted-reply context — what message this inbound is replying to.
	 * `undefined` when the inbound is a fresh message, not a reply.
	 */
	replyTo?: InboundReplyContext;
	/**
	 * Thread id for channels that support threads (Slack/Discord/Telegram topics).
	 * `undefined` for WhatsApp and other flat-DM channels. Used by access-control
	 * and session-key for thread-scoped routing.
	 */
	threadId?: string;
	/** Parent thread id when this inbound is a reply nested under another thread; channels without parent-thread tracking leave it undefined. */
	threadParentId?: string;
	/** Media attachments saved to disk, when the inbound carried any. */
	media?: InboundMediaAttachment[];
	/**
	 * Discord guild id this message originated in. Populated by Discord
	 * adapters; left undefined by every other channel. The 8-tier route
	 * resolver uses `guildId` (with optional `memberRoleIds`) to pick the
	 * binding tier for guild + role-aware routing.
	 */
	guildId?: string;
	/**
	 * Slack team id (workspace id) this message originated in. Populated
	 * by Slack adapters; left undefined elsewhere. Feeds the route
	 * resolver's `binding.team` tier.
	 */
	teamId?: string;
	/**
	 * Discord member role ids carried with this inbound (role names are
	 * NOT used — only ids). Populated by Discord adapters when the
	 * message arrived in a guild. The resolver's `binding.guild+roles`
	 * tier matches if ANY role overlaps with the binding's `roles[]`.
	 */
	memberRoleIds?: string[];
	/**
	 * Per-account-channel-peer scope: the channel account id this inbound
	 * arrived on (for adapters that run multiple accounts of the same
	 * channel — e.g. WhatsApp personal + work). When omitted, falls back
	 * to the channel-manager-level account-id resolution.
	 */
	accountId?: string;
	/** Raw provider payload (for adapters that need more). */
	raw?: unknown;
}

/** Context handed to a channel adapter when the gateway starts it. */
export interface ChannelStartContext {
	/** Called by the adapter for every inbound message; Brigade runs a turn + replies. */
	onInbound: (msg: InboundMessage) => Promise<void>;
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/** Abort signal — adapter must stop cleanly when this fires. */
	signal: AbortSignal;
	/** A place to surface a QR / pairing code to the operator (e.g. WhatsApp). */
	onPairing?: (info: { kind: "qr" | "code"; value: string }) => void;
	/**
	 * Called once the adapter completes its initial connection (e.g. WhatsApp
	 * reaches the `open` state after the QR is scanned). The CLI link command
	 * uses this as its "done" signal; the gateway can ignore it.
	 */
	onConnected?: () => void;
	/**
	 * Called when the channel ends the session and re-linking is required
	 * (e.g. WhatsApp creds invalidated). The link/status commands surface this;
	 * the gateway logs it.
	 */
	onLoggedOut?: () => void;
	/**
	 * One-shot link mode — the CLI's `channels link` command sets this so the
	 * adapter knows to skip aggressive reconnect-loops (those are right for the
	 * gateway, wrong for an interactive pair). Adapters that don't have a link
	 * vs serve distinction can ignore it.
	 */
	linkMode?: boolean;
	/**
	 * Linking progress callback. The adapter emits short polished status
	 * strings here during multi-step link handshakes (e.g. WhatsApp's
	 * post-pair restart). The CLI renders them as clean status lines instead
	 * of letting protocol-level logs leak through. Only fires when `linkMode`
	 * is true.
	 */
	onLinkProgress?: (status: string) => void;
}

/**
 * Optional outbound-send parameters. Channels that support threading (Slack,
 * Discord) consume `threadId` to scope a reply to a specific thread; channels
 * without threading silently ignore it. Adding fields here is backward-
 * compatible because every consumer passes `opts?` and the channel decides
 * what to honour.
 */
export interface OutboundSendOptions {
	/** Reply within this thread (Slack thread_ts, Discord thread id). */
	threadId?: string;
	/** Which channel account to send from on multi-account adapters (e.g. Slack with two workspaces, WhatsApp with two linked numbers); `undefined` falls back to the adapter's default account. */
	accountId?: string;
}

/**
 * Per-adapter health status. Returned synchronously by `ChannelAdapter.health()`
 * and consumed by every code path that's about to attempt an outbound send:
 * the cron timer's announce dispatch, the `send_message` agent tool's
 * pre-flight check, and the system-prompt assembler's `## Messaging` block
 * (which highlights degraded channels so the model warns the operator
 * BEFORE choosing them).
 *
 * Convention: `kind` is a stable enum for programmatic dispatch (e.g.
 * "logged-out" → re-link prompt UX); `reason` is one human-readable line
 * suitable for inline display; `remediation` is the CLI/UX action the
 * operator runs to recover. All three are operator-facing.
 */
export type ChannelHealth =
	| { ok: true }
	| {
			ok: false;
			/** Stable, programmatic state. `logged-out` is the headline case (WhatsApp
			 *  socket terminated by the phone, Slack token revoked, …). `disconnected`
			 *  covers transient socket drops where reconnect is in flight.
			 *  `degraded` is a catch-all for rate-limit / partial-availability states. */
			kind: "logged-out" | "disconnected" | "starting" | "degraded";
			/** One-liner the model / TUI / cron failure path surfaces verbatim. */
			reason: string;
			/** Optional CLI command the operator can run to recover. */
			remediation?: string;
	  };

/**
 * Per-channel pairing customization. Today the manager hard-codes a phone-
 * vs-account heuristic + `🦁 Brigade` copy in the challenge card. As soon as
 * a second channel ships, the operator-visible idLabel ("Your number" vs
 * "Your account" vs "Your username") needs to vary per channel — that's
 * what `idLabel` is for. `normalizeAllowEntry` lets a channel strip an
 * operator-typed `@` prefix or `<@U…>` mention syntax before the entry
 * lands in the allow-from store. `notifyApproval` is invoked by the CLI's
 * `pairing approve` command so the requester sees confirmation in-channel.
 */
export interface ChannelPairingAdapter {
	/** Friendly label for the sender id in the challenge card. */
	idLabel: "phone" | "username" | "account";
	/**
	 * Normalize an allow-from entry the operator typed before it's stored.
	 * Default behaviour (when omitted) is identity.
	 */
	normalizeAllowEntry?(entry: string): string;
	/**
	 * Notify the requester they've been approved. Optional — channels that
	 * already auto-route can omit it; the CLI's `pairing approve` invokes
	 * this when present so the requester sees confirmation in-channel.
	 */
	notifyApproval?(args: { senderId: string; senderName?: string }): Promise<void>;
}

/**
 * A credential the channel needs to be configured (e.g. Slack bot token).
 * The setup wizard prompts the operator for each declared key and writes the
 * answer into `channels.<id>.*`. WhatsApp omits this entirely (QR pairing
 * via `brigade channels link` covers it).
 */
export interface ChannelSetupCredentialKey {
	/** Config path under `channels.<id>.*` (e.g. `"botToken"`). */
	key: string;
	/** Prompt shown to the operator. */
	prompt: string;
	/** When true, input is hidden in the terminal (passwords / tokens). */
	secret?: boolean;
	/** Optional env-var fallback the wizard reads if set. */
	envVar?: string;
	/** Optional reference URL shown next to the prompt. */
	docsUrl?: string;
}

/**
 * Channel-specific setup wizard. The `brigade channels add <id>` CLI walks
 * the operator through these credential prompts and writes a fully-formed
 * `channels.<id>` block to `brigade.json`. Channels that pair via QR/OAuth
 * (WhatsApp) don't have a setup adapter — they use `channels link`.
 */
export interface ChannelSetupAdapter {
	credentialKeys: ReadonlyArray<ChannelSetupCredentialKey>;
	/**
	 * Optional validation of operator input. Return `null` to accept, or an
	 * error string to re-prompt.
	 */
	validateInput?(key: string, value: string): string | null;
	/**
	 * Final assembly — given a map of {credentialKey: value}, produce the
	 * `channels.<id>` config block to merge into `brigade.json`. Default is
	 * identity (write keys verbatim under `channels.<id>`).
	 */
	buildAccountConfig?(values: Record<string, string>): Record<string, unknown>;
}

/**
 * A messaging channel (Channels phase). WhatsApp is the first implementer; Slack/
 * Telegram/etc. implement the same shape. The gateway starts each configured
 * channel once, routes inbound → agent turn → `sendText` for the reply.
 */
export interface ChannelAdapter {
	id: string;
	label: string;
	/** Env vars / config the channel needs (gating). */
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Begin listening; call `ctx.onInbound` per message. Resolves once connected. */
	start(ctx: ChannelStartContext): Promise<void>;
	/** Stop listening + tear down. */
	stop(): Promise<void>;
	/**
	 * Send an outbound text reply to a conversation. Optional `opts` carries
	 * thread routing + future per-send hints; channels that don't honour an
	 * option silently ignore it.
	 */
	sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<void>;
	/**
	 * Optional: send a media attachment (image / video / audio / voice / doc /
	 * sticker) to a conversation. Channels that don't support media omit this
	 * slot. The `send_media` tool REFUSES with a clear operator-facing error
	 * pointing at the file path; it does NOT auto-fallback to `sendText`. If
	 * you want a text fallback, the LLM calls `send_message` itself after the
	 * refusal. See `send-media-tool.ts` for the refusal branch.
	 */
	sendMedia?(conversationId: string, media: OutboundMedia): Promise<void>;
	/**
	 * Optional: react to a previously-received message with an emoji (or pass
	 * `""` to clear a prior reaction). `messageId` is the inbound message id
	 * the adapter normalized into `InboundMessage.raw` (Baileys: `msg.key.id`).
	 */
	react?(conversationId: string, messageId: string, emoji: string): Promise<void>;
	/**
	 * The linked self id (operator's own account on the channel) once connected.
	 * Used by the access-control gate to always allow the operator's own DMs.
	 * `undefined` before the first successful connection.
	 */
	selfId?(): string | undefined;
	/**
	 * Epoch-ms of the channel's most recent successful connection. The manager
	 * uses this with `InboundMessage.messageTimestampMs` to detect "queued
	 * since last restart" inbounds and suppress pairing-challenge replies
	 * for them (avoids burst-spamming strangers with codes after every
	 * gateway restart). Returns `null` pre-connect or for channels that
	 * don't track connection timing.
	 */
	connectedAt?(): number | null;
	/**
	 * Optional: mark a previously-received message as read (e.g. WhatsApp "blue
	 * ticks"). Called by the manager AFTER access control allows the inbound so
	 * a stranger waiting on a pairing challenge never sees a read receipt before
	 * the bot has decided to engage. `messageId`/`participant` are the channel-
	 * native ids; channels without read receipts omit this slot.
	 */
	markRead?(
		conversationId: string,
		messageId: string,
		participant?: string,
	): Promise<void>;
	/**
	 * Optional: signal "typing…" on the conversation while the agent thinks
	 * (`state: "composing"`) and clear it when done (`state: "paused"`). Called
	 * by the manager around the turn so a blocked stranger never sees a typing
	 * indicator. Best-effort — channels without presence omit this slot.
	 */
	setComposing?(conversationId: string, state: "composing" | "paused"): Promise<void>;
	/**
	 * Optional: live health probe for this adapter. Distinguishes "started but
	 * actually unable to send right now" (e.g. WhatsApp logged out on the
	 * phone, Slack token expired, Discord rate-limited) from "started + ready".
	 * Cheap + synchronous-shape: must read CACHED connection state, NEVER
	 * round-trip the provider — the cron timer, `send_message` tool, and
	 * system-prompt assembler all call it on the hot path.
	 *
	 * Returns:
	 *   - `{ ok: true }` — adapter is healthy, sends should succeed.
	 *   - `{ ok: false, reason, remediation? }` — adapter is degraded; the
	 *     caller surfaces `reason` (one-line operator-facing string) + an
	 *     optional `remediation` CLI hint (`brigade channels link ...`).
	 *
	 * Channels without their own health concept omit this slot entirely;
	 * callers treat that as `{ ok: true }` (no information to gate on).
	 */
	health?(): ChannelHealth;
	/**
	 * Optional: per-channel pairing customization. When present, the manager
	 * uses this adapter's `idLabel` for the challenge card's "Your X" line
	 * and calls `notifyApproval` after `brigade pairing approve` so the
	 * requester sees confirmation in-channel. When absent, the manager
	 * falls back to its built-in phone-vs-account heuristic.
	 */
	pairing?: ChannelPairingAdapter;
	/**
	 * Optional: declarative setup wizard the CLI's `brigade channels add`
	 * walks the operator through. Channels with non-QR credentials (Slack
	 * bot token, Discord app token, etc.) MUST provide this; channels with
	 * QR/OAuth pairing (WhatsApp) leave it undefined.
	 */
	setup?: ChannelSetupAdapter;
}

/** Context for a channel command handler (a `/cmd` typed in a channel chat). */
export interface ChannelCommandContext {
	/** Channel id the command came from. */
	channel: string;
	/** Conversation/chat id (where to reply). */
	conversationId: string;
	/** Sender id within the channel. */
	from: string;
	/** Sender display name, when known. */
	fromName?: string;
	/** Text after the command word, trimmed (e.g. `/echo hi there` → `hi there`). */
	args: string;
	/** Active config (for the handler to read its own settings / owner list). */
	config: BrigadeConfig;
	/**
	 * Optional: channel account id this command arrived on (for adapters
	 * that run multiple accounts of the same channel — e.g. WhatsApp
	 * personal + work). Legacy adapters that don't carry the field default
	 * to `"default"` at the consumer side. Additive — handlers that don't
	 * need account scoping can ignore it.
	 */
	accountId?: string;
	/**
	 * Optional: `true` when the message arrived in a group/room rather
	 * than a 1:1 DM. Mirrors `InboundMessage.isGroup`. Handlers that
	 * scope bindings by peer kind read this; legacy adapters that don't
	 * surface a group/direct distinction leave it undefined and the
	 * consumer treats that as `direct`.
	 */
	isGroup?: boolean;
}

/**
 * A channel command — a `/name ...` message handled BEFORE the LLM, returning a
 * direct reply. Distinct from a Pi interactive slash-command (`b.command`),
 * which is TUI-only. Auth is
 * the command's own concern via `authorize` (Brigade has no channel ACL yet);
 * default is allow-all, so gate sensitive commands explicitly.
 */
export interface ChannelCommand {
	/** Command word without the leading slash, e.g. "status". */
	name: string;
	description?: string;
	/** Optional gate; return false to refuse (the manager replies with a refusal). */
	authorize?: (ctx: ChannelCommandContext) => boolean;
	/** Handle the command; return reply text, or void/empty for no reply. */
	handler: (ctx: ChannelCommandContext) => Promise<string | void> | string | void;
}

/** Text-to-speech provider (Voice phase). e.g. ElevenLabs, OpenAI, Edge TTS. */
export interface SpeechProvider {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Synthesize speech; returns audio bytes + mime type. */
	synthesize(text: string, opts?: { voice?: string }): Promise<{ audio: Buffer; mimeType: string }>;
}

/** Speech-to-text provider (Voice phase). e.g. Whisper, Groq, Deepgram. */
export interface TranscriptionProvider {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Transcribe audio bytes to text. */
	transcribe(audio: Buffer, opts?: { mimeType?: string }): Promise<{ text: string }>;
}

/** Media generation provider (Media phase). e.g. image/video/music gen. */
export interface MediaGenProvider {
	id: string;
	label: string;
	kind: "image" | "video" | "music";
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	generate(prompt: string, opts?: Record<string, unknown>): Promise<{ data: Buffer; mimeType: string }>;
}

/** A generic third-party API integration (any external service). */
export interface Integration {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
}

/* ─────────────────────────── web provider SDK ─────────────────────────── */

/**
 * Context handed to a web provider when its `createTool(ctx)` factory runs.
 * Carries the resolved Brigade config + env + per-tool config slice the
 * resolver pulled out (e.g. `tools.web.search.providers.brave.apiKey`) so the
 * provider can read its own credentials without re-deriving them.
 */
export interface WebProviderContext {
	readonly config: BrigadeConfig;
	readonly env: NodeJS.ProcessEnv;
	readonly workspaceDir: string;
	/** Provider-scoped config slice (e.g. `tools.web.search.providers.<id>`). */
	readonly providerConfig?: Record<string, unknown>;
	/** Runtime hints carried in from the resolver — currently just timeoutMs. */
	readonly runtime?: { timeoutMs?: number; maxBytes?: number };
	/**
	 * Resolved runtime metadata captured by the provider's optional
	 * `resolveRuntimeMetadata()` hook (transport choice, model selection,
	 * detected feature flags). Opaque per-provider — `createTool` reads it.
	 */
	readonly runtimeMetadata?: Record<string, unknown>;
}

/**
 * Optional setup hook signature for a provider. The CLI's onboarding flow
 * calls this when the operator picks a provider that ships its own wizard
 * (Brave OAuth, Tavily API-key fetch, etc.). Returns a structured
 * outcome the CLI renders + persists to `brigade.json`. Providers without
 * a wizard omit the method — the CLI falls back to a generic env-var prompt.
 */
export interface WebProviderSetupContext {
	readonly config: BrigadeConfig;
	readonly env: NodeJS.ProcessEnv;
	/** Mutate to persist secrets / config. The CLI flushes after success. */
	readonly setSecret: (path: string, value: string) => void;
	readonly setConfig: (path: string, value: unknown) => void;
	/** Operator-facing prompt — pass-through to the CLI's TTY. */
	readonly prompt: (question: string, opts?: { mask?: boolean }) => Promise<string>;
	readonly print: (line: string) => void;
}
export type WebProviderSetupOutcome =
	| { status: "configured"; summary?: string }
	| { status: "skipped"; summary?: string }
	| { status: "error"; message: string };

/**
 * Shape of the tool the provider's factory returns. The runtime registers it
 * under a stable name (`fetch_url`, `web_search`) and wraps the execute via
 * `withToolUpdates` for `onUpdate` streaming. The provider declares its own
 * `parameters` (TypeBox/JSON-schema record) and `execute` body; the result
 * normalizer downstream forces every provider's free-form return into the
 * canonical `{content, details}` envelope.
 */
export interface WebProviderToolDefinition {
	description: string;
	parameters: Record<string, unknown>;
	execute(
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

/**
 * A web-search provider (Brave / Tavily / Exa / DuckDuckGo / Serper / Kagi /
 * SearXNG / Perplexity / etc.). Provider IS a tool factory — when active, its
 * `createTool(ctx)` returns the `web_search` tool the agent calls. The
 * runtime appends the resolved tool to the agent's `customTools` list
 * alongside built-ins.
 *
 * Auto-selection: providers are sorted by `autoDetectOrder` ascending (lower
 * wins), then the first credentialed one is picked. `requiresCredential:
 * false` lets a provider win without any env/config (e.g. DuckDuckGo HTML
 * scrape). The operator pins a specific provider via
 * `tools.web.search.provider: "<id>"` in `brigade.json`.
 */
export interface WebSearchProvider {
	id: string;
	label: string;
	hint: string;
	requiresCredential?: boolean;
	envVars?: string[];
	placeholder?: string;
	signupUrl?: string;
	docsUrl?: string;
	autoDetectOrder?: number;
	/**
	 * Provider honors per-call filter args (country, language, freshness,
	 * date_after, date_before). When omitted/false, `web_search` returns a
	 * typed `unsupported_*` error BEFORE invoking the provider so the agent
	 * gets predictable feedback instead of silent drop. Brave + Perplexity
	 * are the only first-party providers that set this true.
	 */
	supportsFilters?: boolean;
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	createTool(ctx: WebProviderContext): WebProviderToolDefinition | null;
	/**
	 * Optional onboarding wizard — invoked by the CLI when the operator
	 * selects this provider in `brigade onboard`. Providers that ship a
	 * custom wizard (Brave OAuth flow, Tavily key validation) implement
	 * this; providers without one are handled by the generic env-var prompt.
	 */
	runSetup?(ctx: WebProviderSetupContext): Promise<WebProviderSetupOutcome>;
	/**
	 * Optional runtime introspection — called once per turn before
	 * `createTool` to decide transport / model / feature-flag hints. Lands
	 * on `WebProviderContext.runtimeMetadata`. Used by providers with
	 * multi-transport choices (e.g. Perplexity Search-API vs Sonar-chat).
	 */
	resolveRuntimeMetadata?(
		cfg: BrigadeConfig,
		env?: NodeJS.ProcessEnv,
	): Record<string, unknown> | null;
}

/**
 * A web-fetch provider (Firecrawl / Jina-Reader / Browserless / raw HTTP).
 * Same `createTool(ctx)` factory pattern as `WebSearchProvider`. Today
 * Brigade also ships a BUILT-IN raw fetch tool that doesn't go through this
 * abstraction — providers exist as the FALLBACK when the built-in errors or
 * returns non-OK (JS-heavy pages, blocked-by-bot-detection sites).
 *
 * Auto-selection mirrors `WebSearchProvider`: sort by `autoDetectOrder`,
 * first-credentialed wins; pin via `tools.web.fetch.provider`.
 */
export interface WebFetchProvider {
	id: string;
	label: string;
	hint: string;
	requiresCredential?: boolean;
	envVars?: string[];
	placeholder?: string;
	signupUrl?: string;
	docsUrl?: string;
	autoDetectOrder?: number;
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	createTool(ctx: WebProviderContext): WebProviderToolDefinition | null;
	/** See `WebSearchProvider.runSetup` — same contract. */
	runSetup?(ctx: WebProviderSetupContext): Promise<WebProviderSetupOutcome>;
	/** See `WebSearchProvider.resolveRuntimeMetadata` — same contract. */
	resolveRuntimeMetadata?(
		cfg: BrigadeConfig,
		env?: NodeJS.ProcessEnv,
	): Record<string, unknown> | null;
}

/* ─────────────────────────── memory plugin SDK ─────────────────────────── */

/**
 * Memory backend capability. A plugin can register an alternative memory
 * backend (vector DB, knowledge graph, sqlite-fts) that replaces Brigade's
 * bundled file-based store. Only one capability is active at a time — the
 * `extensions.slots.memory` config knob picks the active plugin. When
 * unset, Brigade uses the built-in file-based store.
 */
export interface MemoryCapability {
	id: string;
	label: string;
	/** Search the memory store. Returns ranked hits with content + score. */
	search(query: string, opts?: { limit?: number; sessionKey?: string }): Promise<
		{ id: string; content: string; score: number; source: "memory" | "session" }[]
	>;
	/** Append a fact to the store. */
	recordFact(content: string, opts?: { meta?: Record<string, string> }): Promise<{ id: string }>;
	/** Optional: backend health for `brigade doctor`. */
	status?(): Promise<{ ready: boolean; itemCount?: number; details?: string }>;
}

/**
 * Embedding provider for vector-search memory backends. Registered separately
 * from `MemoryCapability` so a backend and an embedding model can be mixed
 * (e.g. lancedb + an OpenAI embedding adapter; or local node-llama embeddings).
 */
export interface MemoryEmbeddingProvider {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Embed a single query string. */
	embedQuery(text: string): Promise<number[]>;
	/** Embed a batch of strings (vector-index population). */
	embedBatch(texts: ReadonlyArray<string>): Promise<number[][]>;
}

/* ─────────────────────────── context-engine / compaction / harness ─────────────────────────── */

/**
 * Context-engine capability. Owns assembling messages + estimating tokens +
 * compacting on-demand. Brigade's default is pass-through (the agent loop
 * uses Pi's session messages); a plugin can register an alternative
 * (semantic packing, sliding window, etc). Picked via
 * `extensions.slots.contextEngine`. Today this is shape-only — the
 * consumer-side resolver lands when the first alternative engine ships.
 */
export interface ContextEngineCapability {
	id: string;
	label: string;
	/**
	 * Assemble the context for the next turn. Returns the message array the
	 * agent loop should send and optionally a `systemPromptAddition`
	 * injected at the post-marker (ephemeral) slot. Omit `assemble` to use
	 * the session's own messages verbatim.
	 */
	assemble?(args: {
		sessionMessages: ReadonlyArray<unknown>;
		signal?: AbortSignal;
	}): Promise<{ messages: ReadonlyArray<unknown>; systemPromptAddition?: string }>;
	/** Per-message ingest hook (e.g. for RAG indexing). */
	ingest?(message: unknown): Promise<void>;
	/** Post-turn callback (background work). */
	afterTurn?(args: { turnIndex: number }): Promise<void>;
}

/**
 * Compaction provider — pluggable summarizer. Brigade's default is the
 * head+tail truncation in `smart-compaction.ts`; a plugin can register a
 * full LLM-summary-based compactor. Shape-only today.
 */
export interface CompactionProvider {
	id: string;
	label: string;
	/**
	 * Summarize older messages into one. Receives the messages to compact
	 * + the compression target ratio (0..1; smaller = more aggressive).
	 */
	summarize(args: {
		messages: ReadonlyArray<unknown>;
		compressionRatio: number;
		signal?: AbortSignal;
	}): Promise<string>;
}

/**
 * Agent harness — pluggable agent-loop shape (Pi / Codex / Claude-Code).
 * Brigade's default is the Pi-coding-agent shape; a plugin can register an
 * alternative that runs the turn through a different engine. The resolver
 * picks based on `supports(ctx)` priority. Shape-only today; the consumer-
 * side selection lives in `agent-loop.ts` and currently always picks Pi.
 */
export interface AgentHarness {
	id: string;
	label: string;
	/** Higher numbers win when multiple harnesses match. Pi default is 0. */
	priority: number;
	/** Does this harness know how to drive the given provider/model? */
	supports(ctx: { provider: string; model?: string }): boolean;
	/** Run one turn through this harness shape. */
	runAttempt(args: {
		prompt: string;
		signal?: AbortSignal;
	}): Promise<{ reply: string; toolCalls?: ReadonlyArray<unknown> }>;
}

/* ─────────────────────────── provider auth methods ─────────────────────────── */

/**
 * Auth method a model provider supports. Multiple methods can coexist (e.g.
 * Anthropic supports API key + CLI + OAuth). The onboarding wizard offers each
 * configured method; the runtime resolves the first viable one at session
 * start. Shape-only today; current providers use the bundled API-key flow.
 */
export interface ProviderAuthMethod {
	id: string;
	label: string;
	/** Auth kind — drives the onboarding UI shape. */
	kind: "api_key" | "oauth" | "cli_token" | "custom";
	/**
	 * Interactive flow — invoked by `brigade onboard` to capture credentials.
	 * Receives a logger callback for prompts; returns the credential record
	 * to persist (or `null` if the operator cancelled).
	 */
	run?(args: { logger: (msg: string) => void }): Promise<Record<string, unknown> | null>;
	/**
	 * Non-interactive resolution — invoked when the gateway boots. Returns
	 * the credentials when discoverable from env/files/keychain, else `null`.
	 */
	runNonInteractive?(args: { env: NodeJS.ProcessEnv }): Promise<Record<string, unknown> | null>;
	/**
	 * OAuth refresh — invoked when the runtime detects an expired token.
	 * Returns the refreshed credentials. Only applicable to OAuth providers.
	 */
	refreshOAuth?(args: { stored: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
}

/* ─────────────────────────── hook system contracts ─────────────────────────── */

/**
 * Hook result returned by a `modifying` or `claiming` hook handler.
 *   - `handled: true` (claiming pattern): this handler took ownership; later
 *     handlers are skipped.
 *   - `shouldStop: true` (modifying pattern): early-stop the chain after
 *     this handler's modifications are merged.
 *   - `modifications`: opaque shape — the hook runner merges these into the
 *     downstream payload per the hook's documented merge policy.
 */
export interface HookResult {
	handled?: boolean;
	shouldStop?: boolean;
	modifications?: Record<string, unknown>;
}

/**
 * Hook execution pattern. Each hook event declares its pattern; the runner
 * dispatches accordingly:
 *   - `"void"` — handlers run in parallel via Promise.all; results discarded.
 *     Used for telemetry-only events (`turn_start`, `agent_end`).
 *   - `"modifying"` — handlers run sequentially by priority; each returns
 *     optional modifications merged into the payload. Early-stops on
 *     `{shouldStop: true}`.
 *   - `"claiming"` — handlers run sequentially; first to return
 *     `{handled: true}` wins, rest skipped. Used for `inbound_claim` /
 *     `before_dispatch` / `reply_dispatch` where one plugin owns the event.
 *   - `"sync"` — sequential synchronous; throws if a handler returned a
 *     Promise. Used for write-path-time mutators that must complete before
 *     the next operation (`tool_result_persist`, `before_message_write`).
 */
export type HookExecutionPattern = "void" | "modifying" | "claiming" | "sync";

/** Context handed to a background service when the gateway starts it. */
export interface ServiceStartContext {
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/** Abort signal — the service must stop cleanly when this fires. */
	signal: AbortSignal;
}

/**
 * A long-lived background service started once at gateway boot and stopped on
 * shutdown. Use for pollers, schedulers, webhook listeners, or anything that
 * needs to run alongside the gateway.
 */
export interface Service {
	id: string;
	label?: string;
	start(ctx: ServiceStartContext): Promise<void>;
	stop(): Promise<void>;
}

/** A handler for a module-registered HTTP route on the gateway's server. */
export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** A module-registered HTTP route on the gateway's server. */
export interface HttpRoute {
	/** HTTP method; defaults to any when omitted. */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** Path to match, e.g. `/webhooks/stripe`. Combined with `match`. */
	path: string;
	handler: HttpRouteHandler;
	/**
	 * Authentication model for the route:
	 *   - `"none"` (default for back-compat) — public; the handler is
	 *     responsible for verifying signatures / HMAC. Use for inbound
	 *     webhooks that authenticate via provider-signed payloads.
	 *   - `"operator"` — gateway gates the route on the same operator-auth
	 *     used for WS clients. Use for plugin-supplied admin endpoints.
	 * Plugin authors should set this deliberately — defaulting to `"none"`
	 * preserves existing routes but newly-added ones should pick.
	 */
	auth?: "none" | "operator";
	/**
	 * Path-matching mode. `"exact"` (default) matches the literal path.
	 * `"prefix"` matches everything under the path (e.g. `/webhooks/stripe`
	 * also matches `/webhooks/stripe/foo`). Required for multi-event
	 * webhook endpoints that route on a sub-path.
	 */
	match?: "exact" | "prefix";
	/**
	 * Body size cap in bytes. The gateway rejects requests larger than
	 * this with HTTP 413 BEFORE invoking the handler. Defaults to 1 MiB
	 * (matches the reference upstream's post-auth limit).
	 */
	maxBodyBytes?: number;
	/**
	 * Total request-handling timeout (ms). The gateway sends HTTP 408 if
	 * the handler hasn't finished by then. Defaults to 30s.
	 */
	timeoutMs?: number;
	/**
	 * Wave O0.8 — opt out of the dispatcher's default-pass session guard.
	 * The dispatcher inspects the request body for `sessionKey` / `agentId`
	 * fields and refuses cross-agent access by default; routes that take
	 * those fields BUT genuinely do not target per-session state (e.g. an
	 * incoming webhook whose `agentId` is the receiver, not the actor) can
	 * set this to opt out and perform their own auth instead.
	 */
	skipSessionGuard?: boolean;
}

/**
 * Caller identity surfaced to gateway-RPC handlers. The gateway populates
 * this from the WS connection's operator-auth state. Plugin handlers can
 * gate on `scopes` to enforce per-method admin / write / read separation
 * without re-implementing the auth check.
 */
export interface GatewayCaller {
	/** Stable operator id from the WS connection (`null` for unauthenticated). */
	readonly id: string | null;
	/** Granted scopes — e.g. `["operator.read"]`, `["operator.admin"]`. */
	readonly scopes: ReadonlyArray<string>;
}

/** A module-registered gateway RPC method clients can invoke. */
export interface GatewayMethodHandler {
	/** Method name clients invoke; namespaced by convention, e.g. `whatsapp.status`. */
	name: string;
	/**
	 * Handler invoked when a WS client (or local CLI) calls this RPC.
	 * Receives parsed params plus an optional caller-identity snapshot —
	 * gate sensitive operations on `caller.scopes` to enforce per-method
	 * auth when WS is exposed beyond localhost. Existing handlers that
	 * only declare `(params)` keep working; new ones can declare
	 * `(params, caller)` to read the auth context.
	 */
	handler: (params: unknown, caller?: GatewayCaller) => Promise<unknown> | unknown;
	/**
	 * Required scope to invoke this method. The gateway refuses calls from
	 * callers without the scope. Unset = anyone authenticated can invoke
	 * (read-equivalent). Use `"operator.admin"` for state-changing methods.
	 */
	scope?: "operator.read" | "operator.write" | "operator.admin";
	/**
	 * Wave O0.8 — opt out of the dispatcher's default-pass session guard.
	 * The dispatcher inspects params for `sessionKey` / `agentId` fields
	 * (one level deep) and refuses cross-agent access by default; methods
	 * that take those fields BUT genuinely do not target per-session state
	 * (e.g. health pings keyed by agentId for filtering) can set this to
	 * opt out and perform their own auth instead.
	 */
	skipSessionGuard?: boolean;
}

/* ─────────────────────────── the module context ─────────────────────────── */

/** A recorded model-provider registration (replayed into Pi via `pi.registerProvider`). */
export interface ModelProviderRegistration {
	name: string;
	config: unknown; // Pi's ProviderConfig (kept loose to avoid coupling the seam to Pi internals)
}

/**
 * A recorded provider-auth-method registration. Brigade keeps these in its own
 * registry (not replayed into Pi) because auth resolution happens BEFORE the Pi
 * session boots — `runNonInteractive` is consulted at gateway start, `run`
 * during onboarding. Multiple methods may register against the same
 * `providerName`; iteration order = registration order.
 */
export interface ProviderAuthMethodRegistration {
	providerName: string;
	method: ProviderAuthMethod;
}

/** A recorded slash-command registration (replayed via `pi.registerCommand`). */
export interface CommandRegistration {
	name: string;
	options: unknown; // Pi's RegisteredCommand options
}

/** A recorded lifecycle-hook subscription (replayed via `pi.on(event, handler)`). */
export interface HookRegistration {
	event: string;
	handler: (...args: unknown[]) => unknown;
	/**
	 * Higher runs earlier. Pi itself has no priority ordering (handlers fire in
	 * registration order), so Brigade sorts its recorded hooks by this value
	 * before replaying them into a Pi session — the one ordering lever the seam
	 * adds above Pi. Defaults to 0.
	 */
	priority?: number;
}

/** Wave K — per-turn context handed to a tool factory at session-init. */
export interface BrigadeToolFactoryContext {
	/** The agent this Pi session belongs to. */
	readonly agentId: string;
	/** The session key the per-turn lane uses. */
	readonly sessionKey: string;
}

/** Wave K — factory shape `b.tool()` accepts in addition to a bare tool. */
export interface BrigadeToolFactory {
	create: (ctx: BrigadeToolFactoryContext) => AnyBrigadeTool;
}

/** Either a pre-built tool or a per-turn factory that produces one. */
export type BrigadeToolOrFactory = AnyBrigadeTool | BrigadeToolFactory;

/** A recorded tool registration + its enablement gate. */
export interface ToolRegistration {
	/**
	 * Either a frozen tool (legacy / closure-over-meta path) or a factory
	 * whose `create({ agentId, sessionKey })` runs at session-init so the
	 * tool can scope state to the active turn. Both shapes coexist; the
	 * replay layer in `toPiExtensionFactory` dispatches on the field that's
	 * present.
	 */
	tool?: AnyBrigadeTool;
	factory?: BrigadeToolFactory;
	/**
	 * Toolset grouping (e.g. `"minimal" | "coding" | "messaging" | "full"`)
	 * — the registry filters by the active profile when one is set.
	 *
	 * Wiring: `BrigadeExtensionRegistry.eligibleTools({ toolset })` and
	 * `toolNames({ toolset })` / `toPiExtensionFactory({ toolset })` honour
	 * this field — a tool whose `toolset` differs from the active profile
	 * is dropped from BOTH the unknown-tool allowlist and the Pi tool
	 * surface. Tools registered with no `toolset` (or `"*"`) are universal
	 * and always included, so un-tagged tools never disappear behind a
	 * profile switch. The active profile is sourced from
	 * `agents.defaults.toolset` in `brigade.json`; unset / `"full"` means
	 * "no filter".
	 */
	toolset?: string;
	/** Eligibility gate (skills-style check_fn) — false → tool not offered this run. */
	eligible?: () => boolean;
}

/**
 * The single context a module registers through. Agent-level methods are RECORDED
 * and replayed into every Pi session; product-level methods register into Brigade's
 * gateway-level capability registries. (Recording — not live delegation — because
 * Brigade's gateway is per-turn: agent-level wiring re-applies each session, while
 * channels/services start once at gateway boot.)
 *
 * CAPTURE TRAP — every field on this context is AGENT-SCOPED. Modules that close
 * over `agentId` / `workspaceDir` / `cwd` / `config` / `moduleConfig` in handlers
 * passed to `tool()` / `hook()` / `modelProvider()` get those values frozen INTO
 * the recorded registration, which `toPiExtensionFactory` then replays per Pi
 * session. The registry-cache layer is keyed by `agentId` precisely so the meta
 * captured by agent A's modules never leaks into agent B's tools. Modules that
 * want per-turn / per-session values should read them from the runtime call
 * (e.g. the Pi tool `ctx`) rather than the context closure.
 */
export interface BrigadeExtensionContext {
	/** Active agent id. */
	readonly agentId: string;
	/** Resolved workspace dir. */
	readonly workspaceDir: string;
	/** Process cwd. */
	readonly cwd: string;
	/** The active Brigade config (read-only to modules). */
	readonly config: BrigadeConfig;
	/**
	 * This module's own validated config block (`extensions.entries[id].config`),
	 * checked against the module's `configSchema` by the loader before `register`
	 * runs. `undefined` when the module declared no config / set none.
	 */
	readonly moduleConfig: unknown;

	/* agent-level → replayed into Pi's ExtensionAPI per session */
	/**
	 * Register a tool — either a pre-built `AnyBrigadeTool` (legacy path; the
	 * module closes over agent meta itself) or a `BrigadeToolFactory` whose
	 * `create({ agentId, sessionKey })` runs once per Pi-session init so the
	 * tool can scope state to the active turn (Wave K).
	 */
	tool(
		tool: BrigadeToolOrFactory,
		opts?: { toolset?: string; eligible?: () => boolean },
	): void;
	/**
	 * Subscribe to a Pi lifecycle event (replayed via `pi.on`). `priority` orders
	 * Brigade's recorded hooks before replay (higher = earlier; Pi has no native
	 * priority). NOTE: a `before_agent_start` handler may NOT replace the system
	 * prompt — Brigade pins the persona, so any `systemPrompt` returned from that
	 * event is stripped before Pi sees it (the rest of the result is kept).
	 */
	hook(event: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
	command(name: string, options: unknown): void;
	modelProvider(name: string, config: unknown): void;
	/**
	 * Register a provider auth method (API key / OAuth / CLI token / custom).
	 * `providerName` is the model provider id the method belongs to (e.g.
	 * `"anthropic"`); a single provider can register multiple methods
	 * (Anthropic ships API-key + OAuth + CLI). The onboarding wizard offers
	 * each method the operator can satisfy; the runtime resolves the first
	 * viable one at session start. Today this is shape-only — the consumer-
	 * side resolver lands when the first OAuth provider ships as a plugin.
	 */
	providerAuthMethod(providerName: string, method: ProviderAuthMethod): void;

	/* product-level → Brigade capability registries (gateway-level) */
	channel(adapter: ChannelAdapter): void;
	/** Register a channel command (`/name`) handled before the LLM. */
	channelCommand(command: ChannelCommand): void;
	tts(provider: SpeechProvider): void;
	stt(provider: TranscriptionProvider): void;
	mediaGen(provider: MediaGenProvider): void;
	/** Register an alternative memory backend. Only one is active at a time
	 *  (picked via `extensions.slots.memory` config knob). */
	memory(capability: MemoryCapability): void;
	/** Register a memory embedding provider (for vector backends). */
	memoryEmbeddingProvider(provider: MemoryEmbeddingProvider): void;
	/** Register an alternative context engine (`extensions.slots.contextEngine` picks). */
	contextEngine(engine: ContextEngineCapability): void;
	/** Register an alternative compaction strategy. */
	compactionProvider(provider: CompactionProvider): void;
	/** Register an alternative agent harness shape (Codex / Claude-Code / etc). */
	agentHarness(harness: AgentHarness): void;
	/**
	 * Register a web-search provider. Multiple providers can coexist; the
	 * resolver picks based on `tools.web.search.provider` config OR the
	 * first-credentialed candidate in `autoDetectOrder` priority. Each
	 * provider's `createTool(ctx)` factory runs per-session to inject its
	 * `web_search` tool into the agent's toolset.
	 */
	webSearch(provider: WebSearchProvider): void;
	/**
	 * Register a web-fetch provider. Same factory shape as `webSearch`. These
	 * act as the FALLBACK when the built-in raw-HTTP `fetch_url` returns
	 * non-OK or errors (JS-heavy pages, bot-blocked sites). Operators ship
	 * Firecrawl / Jina-Reader / Browserless as fallbacks.
	 */
	webFetch(provider: WebFetchProvider): void;
	integration(integration: Integration): void;
	/** Register a long-lived background service (started at boot, stopped on shutdown). */
	service(service: Service): void;
	/** Register an HTTP route on the gateway's server. */
	httpRoute(route: HttpRoute): void;
	/** Register a gateway RPC method clients can invoke. */
	gatewayMethod(method: GatewayMethodHandler): void;
}

/**
 * Optional declarative manifest a module can ship alongside `register()` to
 * surface its capability metadata WITHOUT requiring the module to be loaded.
 * Today the field is informational; the future discovery planner will consume
 * it to decide which modules to load for a given trigger (saving cold-boot
 * cost on installs with many modules).
 */
export interface BrigadeModuleManifest {
	id: string;
	name?: string;
	description?: string;
	version?: string;
	/** Whether bundled-origin modules are active by default (defaults to true). */
	enabledByDefault?: boolean;
	/** Capabilities this module CONTRIBUTES — used by the future planner. */
	provides?: {
		tools?: string[];
		hooks?: string[];
		channels?: string[];
		providers?: string[];
		memoryBackends?: string[];
		contextEngines?: string[];
		agentHarnesses?: string[];
	};
	/** Activation triggers — the planner only loads this module when one fires. */
	activation?: {
		onChannels?: string[];
		onProviders?: string[];
		onCommands?: string[];
		onCapabilities?: string[];
	};
}

/**
 * A Brigade module — the unit of extension. One module may register any mix of
 * tools/hooks/commands/providers (agent-level) and channels/voice/media/integrations
 * (product-level). Discovered + loaded by the extension loader; gated by `eligible`
 * + config allow/deny + `requiresEnv`.
 */
export interface BrigadeModule {
	id: string;
	/**
	 * Optional declarative manifest — see `BrigadeModuleManifest`. Surfaces
	 * what this module provides + when to activate it WITHOUT loading the
	 * module's full register code. Future discovery planner will consume
	 * this; today it's informational.
	 */
	manifest?: BrigadeModuleManifest;
	/** Env vars required for this module to load at all. */
	requiresEnv?: string[];
	/**
	 * Optional TypeBox schema for this module's `extensions.entries[id].config`.
	 * When present the loader validates the config before `register` runs and
	 * skips the module (non-fatally) if it doesn't match.
	 */
	configSchema?: TSchema;
	/** Optional gate evaluated at load (os/bins/config, skills-style). */
	eligible?: (ctx: { config: BrigadeConfig; env: NodeJS.ProcessEnv }) => boolean;
	/** Register this module's capabilities. */
	register(b: BrigadeExtensionContext): void | Promise<void>;
	/**
	 * Optional reload hook. Called when the gateway reloads extensions so a module
	 * can refresh in-memory state. Product capabilities (channels/services) are
	 * stopped + restarted by the gateway around this regardless.
	 */
	reload?(): void | Promise<void>;
}

/** Identity helper for authoring a module (mirrors Pi's `defineTool`). */
export function defineModule(module: BrigadeModule): BrigadeModule {
	return module;
}
