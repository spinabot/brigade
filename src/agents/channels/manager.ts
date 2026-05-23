/**
 * Channel manager — boots configured channels and wires inbound → turn → reply.
 *
 * The gateway owns exactly one of these. At boot it hands over the channel
 * adapters the extension registry collected, plus a `runTurn` that funnels
 * through the gateway's serialized turn queue (so a channel turn never overlaps
 * a TUI turn or another channel turn). For each configured channel the manager:
 *   1. starts the adapter, giving it an `onInbound` callback;
 *   2. on every inbound message, runs an agent turn keyed by the conversation;
 *   3. sends the reply back through the same adapter.
 *
 * Failure isolation: a channel that fails to start is logged and skipped (the
 * others still come up); an inbound message that throws is logged and dropped
 * (the channel stays connected). Nothing here can crash the gateway.
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { BrigadeConfig } from "../../config/io.js";
import type { ChannelAdapter, ChannelCommand, ChannelStartContext, InboundMessage } from "../extensions/types.js";
import { channelSessionKey } from "./session-key.js";

const log = createSubsystemLogger("channels/manager");

/** Result of running one agent turn — only the reply text matters to a channel. */
export interface ChannelTurnResult {
	reply: string;
}

export interface StartChannelsArgs {
	/** Channel adapters collected from the extension registry. */
	adapters: ChannelAdapter[];
	/** The active Brigade config (channel adapters read their settings from it). */
	config: BrigadeConfig;
	/** Agent id whose workspace + transcripts these conversations belong to. */
	agentId: string;
	/**
	 * Run one agent turn. The gateway supplies this bound to its serialized turn
	 * queue, so channel turns interleave safely with TUI turns. Resolves with the
	 * reply text to send back to the conversation.
	 */
	runTurn: (args: { text: string; sessionKey: string }) => Promise<ChannelTurnResult>;
	/** Channel commands (`/name`) handled before the LLM. */
	commands?: ChannelCommand[];
	/** Injected env for gating (tests); defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Surface a pairing code / QR to the operator (e.g. WhatsApp first-link). */
	onPairing?: (channelId: string, info: { kind: "qr" | "code"; value: string }) => void;
}

export interface ChannelManager {
	/** Ids of channels that started successfully. */
	readonly started: string[];
	/** Stop every started channel + abort their listeners. Idempotent. */
	stop(): Promise<void>;
}

/**
 * Start every configured channel adapter. Returns a handle whose `stop()` tears
 * them all down. Channels that aren't configured (missing keys/settings) are
 * skipped silently — only configured channels spin up a listener.
 */
export async function startChannels(args: StartChannelsArgs): Promise<ChannelManager> {
	const env = args.env ?? process.env;
	const abort = new AbortController();
	const started: { id: string; adapter: ChannelAdapter }[] = [];
	const commandMap = new Map((args.commands ?? []).map((c) => [c.name.toLowerCase(), c]));

	for (const adapter of args.adapters) {
		// Gate: required env present AND the adapter says it's configured.
		const envMissing = adapter.requiresEnv?.some((v) => !env[v] || env[v]?.trim() === "");
		if (envMissing) {
			log.info("channel skipped — required env missing", { channel: adapter.id, requiresEnv: adapter.requiresEnv });
			continue;
		}
		let configured = false;
		try {
			configured = adapter.isConfigured(args.config, env);
		} catch (err) {
			log.warn("channel isConfigured threw — skipping", {
				channel: adapter.id,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		if (!configured) {
			log.info("channel skipped — not configured", { channel: adapter.id });
			continue;
		}

		const ctx: ChannelStartContext = {
			signal: abort.signal,
			log: (msg, meta) => log.info(`[${adapter.id}] ${msg}`, meta),
			onPairing: args.onPairing ? (info) => args.onPairing?.(adapter.id, info) : undefined,
			onInbound: async (msg: InboundMessage) => {
				try {
					const text = msg.text?.trim();
					if (!text) return; // nothing to answer (sticker / empty / system event)
					// Channel command (`/name ...`) — handled before the LLM. Unknown
					// commands fall through to a normal turn so plain "/" text isn't eaten.
					if (text.startsWith("/") && commandMap.size > 0) {
						const space = text.indexOf(" ");
						const name = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
						const command = commandMap.get(name);
						if (command) {
							const cmdCtx = {
								channel: adapter.id,
								conversationId: msg.conversationId,
								from: msg.from,
								fromName: msg.fromName,
								args: space === -1 ? "" : text.slice(space + 1).trim(),
								config: args.config,
							};
							if (command.authorize && !command.authorize(cmdCtx)) {
								await adapter.sendText(msg.conversationId, "Not authorized to run that command.");
								return;
							}
							const out = await command.handler(cmdCtx);
							if (typeof out === "string" && out.trim()) await adapter.sendText(msg.conversationId, out.trim());
							return; // command handled — no turn
						}
					}
					const sessionKey = channelSessionKey(args.agentId, adapter.id, msg.conversationId);
					const result = await args.runTurn({ text, sessionKey });
					const reply = result.reply?.trim();
					if (reply) await adapter.sendText(msg.conversationId, reply);
				} catch (err) {
					// An inbound failure must never tear down the listener.
					log.warn("inbound handling failed", {
						channel: adapter.id,
						conversationId: msg.conversationId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		};

		try {
			await adapter.start(ctx);
			started.push({ id: adapter.id, adapter });
			log.info("channel started", { channel: adapter.id, label: adapter.label });
		} catch (err) {
			log.warn("channel failed to start — skipping", {
				channel: adapter.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	let stopped = false;
	return {
		started: started.map((s) => s.id),
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			abort.abort();
			for (const { id, adapter } of started) {
				try {
					await adapter.stop();
				} catch (err) {
					log.warn("channel stop failed", {
						channel: id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		},
	};
}
