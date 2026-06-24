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
 *
 * Runtime single-channel lifecycle (added for `connect_channel`): the manager
 * captures its boot args + the FULL adapter catalog so a channel can be started
 * or stopped LIVE — after boot, without a gateway restart — via `startChannel`
 * / `stopChannel`. Each started adapter gets its OWN abort controller chained
 * to the manager's master controller, so stopping ONE channel never signals the
 * others (master `stop()` still cascades to all). WhatsApp's boot path does not
 * call the new methods, so its behaviour is byte-identical to before.
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

/** Outcome of a runtime single-channel start attempt. */
export interface StartChannelResult {
	/** True when the adapter is now started (either freshly or already running). */
	ok: boolean;
	/** True when this call actually started it; false when it was already running. */
	started: boolean;
	/** Machine-readable reason when `ok` is false. */
	reason?: "unknown-channel" | "env-missing" | "not-configured" | "start-failed";
	/** Human-facing detail (safe to surface). */
	message?: string;
}

/** Outcome of a runtime single-channel stop attempt. */
export interface StopChannelResult {
	ok: boolean;
	/** True when this call actually stopped a running adapter; false when it wasn't running. */
	stopped: boolean;
	message?: string;
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
	/**
	 * Start ONE channel adapter LIVE, after boot, without a gateway restart.
	 * The adapter is resolved from the FULL catalog the manager was built with
	 * (`startChannels({ adapters })`), gated the same way boot gates it
	 * (`requiresEnv` present + `adapter.isConfigured(config, env)`), then wired
	 * through the identical inbound pipeline. Idempotent: starting an
	 * already-running channel returns `{ ok: true, started: false }`.
	 *
	 * `config` (optional) overrides the snapshot the manager captured at boot —
	 * pass the freshly-written config when the caller has just enabled the
	 * channel + set its token via `mutateConfigAtomic`, so `isConfigured` and
	 * the adapter's `start()` see the new values without a manager rebuild.
	 */
	startChannel(id: string, config?: BrigadeConfig): Promise<StartChannelResult>;
	/**
	 * Stop ONE channel adapter LIVE without touching the others. Aborts only
	 * that channel's listener (its own controller, chained to the master), drops
	 * its approval dispatcher, clears its pending debounce slots, and calls
	 * `adapter.stop()`. Idempotent: stopping a channel that isn't running
	 * returns `{ ok: true, stopped: false }`.
	 */
	stopChannel(id: string): Promise<StopChannelResult>;
}

/** One started adapter + the machinery needed to stop it independently. */
interface StartedEntry {
	id: string;
	adapter: ChannelAdapter;
	pipeline: InboundPipelineContext;
	/** Per-channel abort controller, chained to the manager master controller. */
	abort: AbortController;
}

/**
 * Start every configured channel adapter. Returns a handle whose `stop()` tears
 * them all down. Channels that aren't configured (missing keys/settings) are
 * skipped silently — only configured channels spin up a listener.
 *
 * The returned manager also supports LIVE single-channel start/stop
 * (`startChannel` / `stopChannel`) so a tool can connect a new channel after
 * boot without a gateway restart.
 */
export async function startChannels(args: StartChannelsArgs): Promise<ChannelManager> {
	const env = args.env ?? process.env;
	// Master controller — aborting it cascades to EVERY per-channel controller
	// (they're chained below). `stop()` (all channels) aborts the master.
	const master = new AbortController();
	const started: StartedEntry[] = [];
	const userCommands = args.commands ?? [];
	// Mutable config snapshot — boot value, refreshable by a live `startChannel`
	// that passes the just-written config so a late-started adapter sees it.
	let activeConfig = args.config;

	/**
	 * Start ONE adapter and register it in `started`. Shared by the boot loop
	 * and the runtime `startChannel` path so the gate + pipeline wiring + abort
	 * chaining + dispatcher registration stay byte-identical on both paths.
	 *
	 * Returns a structured result. Throwing is reserved for genuinely
	 * unexpected failures; a configured-but-failed start is captured as
	 * `{ ok:false, reason:"start-failed" }` (logged + skipped, never crashes).
	 */
	async function startOneAdapter(adapter: ChannelAdapter): Promise<StartChannelResult> {
		// Already running → no-op (idempotent).
		if (started.some((s) => s.id === adapter.id)) {
			return { ok: true, started: false, message: `channel "${adapter.id}" already started` };
		}

		// Gate: required env present AND the adapter says it's configured.
		const envMissing = adapter.requiresEnv?.some((v) => !env[v] || env[v]?.trim() === "");
		if (envMissing) {
			log.info("channel skipped — required env missing", { channel: adapter.id, requiresEnv: adapter.requiresEnv });
			return {
				ok: false,
				started: false,
				reason: "env-missing",
				message: `channel "${adapter.id}" is missing required env (${(adapter.requiresEnv ?? []).join(", ")})`,
			};
		}
		let configured = false;
		try {
			configured = adapter.isConfigured(activeConfig, env);
		} catch (err) {
			log.warn("channel isConfigured threw — skipping", {
				channel: adapter.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				ok: false,
				started: false,
				reason: "not-configured",
				message: `channel "${adapter.id}" configuration check failed`,
			};
		}
		if (!configured) {
			log.info("channel skipped — not configured", { channel: adapter.id });
			return {
				ok: false,
				started: false,
				reason: "not-configured",
				message: `channel "${adapter.id}" is not configured (enable it + provide credentials)`,
			};
		}

		// Per-adapter command map: user-registered + bundled `/help` `/status` `/allowlist`.
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of userCommands) commandMap.set(c.name.toLowerCase(), c);
		for (const c of buildBundledCommands(adapter)) commandMap.set(c.name.toLowerCase(), c);

		// Per-channel abort controller, chained to the master so an all-channels
		// `stop()` still cancels this channel, but a single-channel `stopChannel`
		// can cancel ONLY this one without signalling the others.
		const channelAbort = new AbortController();
		const onMasterAbort = () => channelAbort.abort();
		if (master.signal.aborted) channelAbort.abort();
		else master.signal.addEventListener("abort", onMasterAbort, { once: true });

		// Adapt the boot-args `runTurn` into the pipeline's `RunChannelTurnFn`
		// shape — same payload, additive optional fields the pipeline reads.
		const pipelineRunTurn: RunChannelTurnFn = (turn) => args.runTurn(turn);
		const pipeline = createInboundPipelineContext({
			adapter,
			config: activeConfig,
			agentId: args.agentId,
			runTurn: pipelineRunTurn,
			commandMap,
			parentAbort: channelAbort.signal,
		});

		const ctx: ChannelStartContext = {
			signal: channelAbort.signal,
			log: (msg, meta) => log.info(`[${adapter.id}] ${msg}`, meta),
			onPairing: args.onPairing ? (info) => args.onPairing?.(adapter.id, info) : undefined,
			onInbound: async (msg: InboundMessage) => {
				await runChannelInboundPipeline(pipeline, msg);
			},
		};

		try {
			await adapter.start(ctx);
			started.push({ id: adapter.id, adapter, pipeline, abort: channelAbort });
			// Register the adapter's outbound surface so a gated tool call inside
			// a channel-routed turn surfaces the prompt INTO this conversation.
			// Single-account adapters land on the default-account dispatcher slot.
			//
			// When the adapter exposes a NATIVE approval capability (Slack Block Kit
			// buttons, Telegram inline buttons), forward it + a `getApprovalContext`
			// so `dispatchChannelApproval` renders the prompt with native buttons
			// instead of the plain-text card. Mirrors the multi-account plugin path
			// (slack/plugin.ts). This ONE central site lights up native approval
			// buttons for every single-account adapter that advertises the capability;
			// adapters without one (WhatsApp) keep the text prompt unchanged. The
			// `runtime` is empty here (the legacy manager has no per-account runtime —
			// Slack's `sendApprovalPrompt` doesn't read it); `cfg` is the live config
			// snapshot, refreshed by a runtime `startChannel`.
			const approvalCapability = adapter.approvalCapability;
			registerChannelApprovalDispatcher(adapter.id, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, opts),
				prettyName: adapter.label,
				...(approvalCapability
					? {
							approvalCapability,
							getApprovalContext: () => ({ runtime: {}, cfg: activeConfig }),
						}
					: {}),
			});
			log.info("channel started", { channel: adapter.id, label: adapter.label });
			return { ok: true, started: true, message: `channel "${adapter.id}" started` };
		} catch (err) {
			// Clean up the abort chaining we set up before the failed start.
			master.signal.removeEventListener("abort", onMasterAbort);
			log.warn("channel failed to start — skipping", {
				channel: adapter.id,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				ok: false,
				started: false,
				reason: "start-failed",
				message: `channel "${adapter.id}" failed to start: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/** Tear down ONE started entry: dispatcher, debounce slots, abort, stop(). */
	async function teardownEntry(entry: StartedEntry): Promise<void> {
		// Drop the approval router's dispatcher BEFORE adapter.stop() so an
		// in-flight bridge can't ask a torn-down channel to send.
		removeChannelApprovalDispatcher(entry.id);
		// Cancel pending debounce slots so a flush can't fire post-stop.
		for (const slot of entry.pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
		entry.pipeline.pendingDispatches.clear();
		// Abort only THIS channel's listener.
		entry.abort.abort();
		try {
			await entry.adapter.stop();
		} catch (err) {
			log.warn("channel stop failed", {
				channel: entry.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Boot loop — start every configured adapter (same gate + skip-on-failure
	// semantics as before; the per-adapter body now lives in startOneAdapter).
	for (const adapter of args.adapters) {
		await startOneAdapter(adapter);
	}

	let stopped = false;
	return {
		// Live getter — reflects runtime single-channel start/stop, not a
		// boot-time snapshot (startChannel / stopChannel mutate `started`).
		get started(): string[] {
			return started.map((s) => s.id);
		},
		adapter(id: string): ChannelAdapter | undefined {
			const entry = started.find((s) => s.id === id);
			return entry?.adapter;
		},
		async startChannel(id: string, config?: BrigadeConfig): Promise<StartChannelResult> {
			if (stopped) {
				return { ok: false, started: false, reason: "start-failed", message: "channel manager is stopped" };
			}
			// Refresh the config snapshot when the caller just wrote new values
			// (enabled the channel + set its token) so the gate + start see them.
			if (config) activeConfig = config;
			const adapter = args.adapters.find((a) => a.id === id);
			if (!adapter) {
				return {
					ok: false,
					started: false,
					reason: "unknown-channel",
					message: `no channel adapter registered with id "${id}"`,
				};
			}
			return startOneAdapter(adapter);
		},
		async stopChannel(id: string): Promise<StopChannelResult> {
			const idx = started.findIndex((s) => s.id === id);
			if (idx === -1) {
				return { ok: true, stopped: false, message: `channel "${id}" is not running` };
			}
			const entry = started[idx]!;
			// Remove from `started` FIRST so a concurrent read of `.started`
			// doesn't see a channel that's mid-teardown.
			started.splice(idx, 1);
			await teardownEntry(entry);
			return { ok: true, stopped: true, message: `channel "${id}" stopped` };
		},
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			// Abort the master FIRST — cascades to every per-channel controller.
			master.abort();
			// Snapshot + clear so teardownEntry's own splice-free path is safe.
			const entries = started.splice(0, started.length);
			for (const entry of entries) {
				await teardownEntry(entry);
			}
		},
	};
}
