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

/** A normalized inbound message from any channel (WhatsApp/Slack/Telegram/…). */
export interface InboundMessage {
	/** Channel id, e.g. "whatsapp". */
	channel: string;
	/** Stable conversation/chat id within the channel (the session-key seed). */
	conversationId: string;
	/** Sender id within the channel (phone/user id). */
	from: string;
	/** Plain text of the message. */
	text: string;
	/** Optional display name of the sender. */
	fromName?: string;
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
	/** Send an outbound text reply to a conversation. */
	sendText(conversationId: string, text: string): Promise<void>;
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
	/** Exact path, e.g. `/webhooks/stripe`. */
	path: string;
	handler: HttpRouteHandler;
}

/** A module-registered gateway RPC method clients can invoke. */
export interface GatewayMethodHandler {
	/** Method name clients invoke; namespaced by convention, e.g. `whatsapp.status`. */
	name: string;
	handler: (params: unknown) => Promise<unknown> | unknown;
}

/* ─────────────────────────── the module context ─────────────────────────── */

/** A recorded model-provider registration (replayed into Pi via `pi.registerProvider`). */
export interface ModelProviderRegistration {
	name: string;
	config: unknown; // Pi's ProviderConfig (kept loose to avoid coupling the seam to Pi internals)
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

/** A recorded tool registration + its enablement gate. */
export interface ToolRegistration {
	tool: AnyBrigadeTool;
	/** Toolset grouping (minimal/coding/messaging/full); informs profile gating. */
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
	tool(tool: AnyBrigadeTool, opts?: { toolset?: string; eligible?: () => boolean }): void;
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

	/* product-level → Brigade capability registries (gateway-level) */
	channel(adapter: ChannelAdapter): void;
	/** Register a channel command (`/name`) handled before the LLM. */
	channelCommand(command: ChannelCommand): void;
	tts(provider: SpeechProvider): void;
	stt(provider: TranscriptionProvider): void;
	mediaGen(provider: MediaGenProvider): void;
	integration(integration: Integration): void;
	/** Register a long-lived background service (started at boot, stopped on shutdown). */
	service(service: Service): void;
	/** Register an HTTP route on the gateway's server. */
	httpRoute(route: HttpRoute): void;
	/** Register a gateway RPC method clients can invoke. */
	gatewayMethod(method: GatewayMethodHandler): void;
}

/**
 * A Brigade module — the unit of extension. One module may register any mix of
 * tools/hooks/commands/providers (agent-level) and channels/voice/media/integrations
 * (product-level). Discovered + loaded by the extension loader; gated by `eligible`
 * + config allow/deny + `requiresEnv`.
 */
export interface BrigadeModule {
	id: string;
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
