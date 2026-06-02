/**
 * Channel manager — boots configured channels and wires inbound → turn → reply.
 *
 * The gateway owns exactly one of these. At boot it hands over the channel
 * adapters the extension registry collected, plus a `runTurn` that funnels
 * through the gateway's serialized turn queue (so a channel turn never overlaps
 * a TUI turn or another channel turn). The actual per-inbound pipeline lives
 * in `inbound-pipeline.ts` — shared by both this legacy single-adapter manager
 * AND the multi-account WhatsApp plugin path so the safety surface (ACL,
 * debounce, abort triggers, approval-reply intercept, last-channel pin order)
 * is identical on every channel.
 *
 * Failure isolation: a channel that fails to start is logged and skipped (the
 * others still come up); an inbound message that throws is logged and dropped
 * (the channel stays connected). Nothing here can crash the gateway.
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { BrigadeConfig } from "../../config/io.js";
import type { ChannelAdapter, ChannelCommand, ChannelStartContext, InboundMessage } from "../extensions/types.js";
import {
	type ChannelApprovalRoute,
	registerChannelApprovalDispatcher,
	removeChannelApprovalDispatcher,
} from "./approval-router.js";
import {
	buildBundledCommands,
	createInboundPipelineContext,
	runChannelInboundPipeline,
	type ChannelTurnResult as PipelineChannelTurnResult,
	type InboundPipelineContext,
	type RunChannelTurnFn,
} from "./inbound-pipeline.js";

const log = createSubsystemLogger("channels/manager");

/** Result of running one agent turn — only the reply text matters to a channel. */
export type ChannelTurnResult = PipelineChannelTurnResult;

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
	runTurn: (args: {
		text: string;
		sessionKey: string;
		agentId: string;
		signal?: AbortSignal;
		senderIsOwner?: boolean;
		channelApprovalRoute?: ChannelApprovalRoute;
	}) => Promise<ChannelTurnResult>;
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
	/**
	 * Look up a started channel adapter by id. Returns `undefined` when the
	 * channel never started (config disabled, env missing, start threw).
	 *
	 * Optional `accountId` (multi-account installs only): resolves to that
	 * specific account's adapter. Single-account / legacy installs ignore
	 * the arg. Required for `send_message` cross-account routing through
	 * the plugin facade — the legacy `startChannels` path collapses N
	 * accounts onto one adapter so the arg is a no-op there.
	 */
	adapter(id: string, accountId?: string): ChannelAdapter | undefined;
}

/**
 * Start every configured channel adapter. Returns a handle whose `stop()` tears
 * them all down. Channels that aren't configured (missing keys/settings) are
 * skipped silently — only configured channels spin up a listener.
 */
export async function startChannels(args: StartChannelsArgs): Promise<ChannelManager> {
	const env = args.env ?? process.env;
	const abort = new AbortController();
	const started: { id: string; adapter: ChannelAdapter; pipeline: InboundPipelineContext }[] = [];
	const userCommands = args.commands ?? [];

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

		// Per-adapter command map: user-registered + bundled `/help` `/status` `/allowlist`.
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of userCommands) commandMap.set(c.name.toLowerCase(), c);
		for (const c of buildBundledCommands(adapter)) commandMap.set(c.name.toLowerCase(), c);

		// Adapt the boot-args `runTurn` into the pipeline's `RunChannelTurnFn`
		// shape — same payload, additive optional fields the pipeline reads.
		const pipelineRunTurn: RunChannelTurnFn = (turn) => args.runTurn(turn);
		const pipeline = createInboundPipelineContext({
			adapter,
			config: args.config,
			agentId: args.agentId,
			runTurn: pipelineRunTurn,
			commandMap,
			parentAbort: abort.signal,
		});

		const ctx: ChannelStartContext = {
			signal: abort.signal,
			log: (msg, meta) => log.info(`[${adapter.id}] ${msg}`, meta),
			onPairing: args.onPairing ? (info) => args.onPairing?.(adapter.id, info) : undefined,
			onInbound: async (msg: InboundMessage) => {
				await runChannelInboundPipeline(pipeline, msg);
			},
		};

		try {
			await adapter.start(ctx);
			started.push({ id: adapter.id, adapter, pipeline });
			// Register the adapter's outbound surface so a gated tool call inside
			// a channel-routed turn surfaces the prompt INTO this conversation.
			// Single-account adapters land on the default-account dispatcher slot.
			registerChannelApprovalDispatcher(adapter.id, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, opts),
				prettyName: adapter.label,
			});
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
		adapter(id: string): ChannelAdapter | undefined {
			const entry = started.find((s) => s.id === id);
			return entry?.adapter;
		},
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			// Cancel pending debounce slots so a flush can't fire post-stop.
			for (const { pipeline } of started) {
				for (const slot of pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
				pipeline.pendingDispatches.clear();
			}
			abort.abort();
			for (const { id, adapter } of started) {
				// Drop the approval router's dispatcher BEFORE adapter.stop()
				// so an in-flight bridge can't ask a torn-down channel to send.
				removeChannelApprovalDispatcher(id);
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
