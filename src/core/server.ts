/**
 * Brigade gateway server.
 *
 * Long-running headless process that owns:
 *   - the Pi AgentSession (model, messages, tools, hooks)
 *   - the AuthStorage + ModelRegistry
 *   - the JSONL event log
 *
 * Exposes a single WebSocket endpoint on `:7777` (configurable). Clients
 * (TUI, future web/mobile) connect, receive a state snapshot + every Pi
 * event, and send commands as request/response frames or one-way events.
 *
 * Architecture:
 *   - Raw `ws` package — no transport library, full control of the wire
 *   - Req/Res/Event tri-frame protocol on the same connection (see protocol.ts)
 *   - Tick heartbeat — server pushes a tick frame every TICK_INTERVAL_MS;
 *     client closes if no frame received in 2× that. Catches dead sockets.
 *   - Single source of truth: state lives only here. Clients hold a mirror
 *     refreshed via the `state` event after every mutation.
 *
 * State persistence: server is otherwise stateless. AuthStorage / ModelRegistry
 * / config / sessions all live on disk under `~/.brigade/`. A server crash
 * loses only in-flight turn state; resume picks up from the last persisted
 * Pi session entry.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { pathToFileURL } from "node:url";

import type { Model } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AuthStorage,
	ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";

import {
	DEFAULT_PORT,
	type EventName,
	type EventPayload,
	type Frame,
	isFrame,
	modelToSummary,
	type RequestFrame,
	type RequestMethod,
	type RequestParams,
	type ResponseFor,
	type SessionStateSnapshot,
	TICK_INTERVAL_MS,
} from "../protocol.js";
// Per-turn execution path (the single canonical runtime). The gateway no
// longer holds a long-lived Pi session: every inbound `prompt` builds a
// fresh session via `runResilientTurn`, resumes the JSONL transcript by
// sessionKey, runs the full Brigade safety stack, and drops the session
// when the turn settles. This mirrors OpenClaw, where each turn is its own
// `runEmbeddedAttempt` and no session lives between turns. The in-flight
// session is surfaced for the turn's lifetime via `onSessionReady` so the
// gateway can steer / abort / switch-model mid-stream.
import { runResilientTurn, type RunSingleTurnResult } from "../agents/agent-loop.js";
import { BrigadeExtensionRegistry, BUNDLED_MODULES, clearDiscoveryCache, loadModules } from "../agents/extensions/index.js";
import type { HttpRouteHandler, Service } from "../agents/extensions/index.js";
import { type ChannelManager, startChannels } from "../agents/channels/manager.js";
import { makeOpQueue, withTimeout } from "./extension-lifecycle.js";
import { resolveModelNeverMiss } from "../agents/model-resolution.js";
import { switchModelMidTurn as piSwitchModelMidTurn } from "../agents/mid-turn-switch.js";
import { onAgentEvent } from "../agents/agent-event-bus.js";
import { DEFAULT_AGENT_ID, resolveAgentDir, resolveAgentWorkspaceDir } from "../config/paths.js";
import { defaultSessionKey } from "../sessions/session-store.js";
import { makeExtractionLlm, runExtractionSweep } from "../agents/memory/extract.js";
import { runDecayGc } from "../agents/memory/decay.js";
import {
	makeConsolidationLlm,
	markConsolidationRun,
	runConsolidation,
	shouldRunConsolidation,
} from "../agents/memory/consolidate.js";
import { loadBrigadeAuthStorage } from "./auth-bridge.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, loadConfig, saveConfig, type Config } from "./config.js";
import { acquireGatewayLock, type GatewayLockHandle } from "./gateway-lock.js";
import { clearPidFile, writePidFile } from "./gateway-probe.js";

// Persist a model selection to brigade.json's new wizard-shape (the lifted
// code expected the older flat `defaultProvider`/`defaultModelId` fields).
// Writes through the same `agents.defaults.{provider, model.primary}` path
// the onboard wizard uses, so set-model and onboard stay consistent.
// Seed the snapshot's "available thinking levels" from a model when no live
// Pi session exists to ask. Pi's `getAvailableThinkingLevels()` is the source
// of truth during a turn (it refreshes the cache); this is the between-turns
// fallback. Reasoning models expose the full ladder; non-reasoning models
// only "off". Kept deliberately simple — the live session corrects it the
// moment a turn starts.
function deriveThinkingLevels(model: Model<string>): string[] {
	return model?.reasoning ? ["off", "low", "medium", "high"] : ["off"];
}

function persistDefaultModel(cfg: Config, provider: string, modelId: string): Config {
  const next: Config = { ...cfg };
  const agents = { ...((next.agents as Record<string, unknown> | undefined) ?? {}) } as Record<string, unknown>;
  const defaults = { ...((agents.defaults as Record<string, unknown> | undefined) ?? {}) } as Record<string, unknown>;
  const existingModel = (defaults.model as { fallbacks?: string[] } | undefined) ?? {};
  defaults.provider = provider;
  defaults.model = { ...existingModel, primary: modelId };
  agents.defaults = defaults;
  (next as Record<string, unknown>).agents = agents;
  return next;
}
import { type ConsoleStream } from "./console-stream.js";
import { attachEventLogger, getTodayLogPath } from "./event-logger.js";
import { pickInitialThinkingLevel } from "./model-caps.js";
import { getBuildInfo } from "../version.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { extractIdentityName, isIdentityNameUnset } from "./system-prompt.js";
import { existsSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

export interface ServerOptions {
	/** Port to listen on. Defaults to BRIGADE_PORT env or 7777. */
	port?: number;
	/** Bind address. Defaults to 127.0.0.1 — localhost only, no LAN exposure. */
	host?: string;
	/**
	 * Optional live-stream sink for human-readable lines on stderr. Wired by
	 * `brigade gateway --verbose` so the operator sees Pi events + WS req/res
	 * in real time without tailing the JSONL file. Pass `undefined` for the
	 * default silent behavior.
	 */
	consoleStream?: ConsoleStream;
}

export interface ServerHandle {
	port: number;
	host: string;
	stop(): Promise<void>;
}

/* ────────────────────────── boot ────────────────────────── */

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
	const port = opts.port ?? (Number(process.env.BRIGADE_PORT) || DEFAULT_PORT);
	const host = opts.host ?? "127.0.0.1";

	// Capture the boot start time so the `ready (Xs)` line can report total
	// startup duration. Mirrors openclaw's `serverStartedAt = Date.now()`
	// (`src/gateway/server.impl.ts:408`) threaded through the boot chain.
	const startupStartedAt = Date.now();

	// Phase logger — emits to the verbose console-stream when present, falls
	// back to plain stderr lines so the bare-mode boot still surfaces
	// progress. Mirrors openclaw's `gatewayLog.info("loading configuration…")`
	// pattern from `src/cli/gateway-cli/run.ts:301` etc.
	const bootLog = (message: string): void => {
		if (opts.consoleStream) {
			opts.consoleStream.info(message);
		} else {
			process.stderr.write(`brigade-gateway: ${message}\n`);
		}
	};

	// Phase 1 — acquire the gateway lock BEFORE we touch the port. Two
	// `brigade gateway run` invocations both reach this line; only one
	// gets the lock. The other receives a typed GatewayLockError that
	// `cli/commands/gateway.ts` formats with the OpenClaw-shape "gateway
	// already running (pid X); lock timeout after 5000ms" message.
	//
	// We DON'T emit a "phase" log line for the lock attempt because in
	// the happy path it's instant and silent (mirrors openclaw — its lock
	// also doesn't log on success).
	const lockHandle: GatewayLockHandle = await acquireGatewayLock({ port });

	try {
		// Phase 2 — TIME_WAIT recovery probe. The lock guarantees no other
		// brigade gateway is running, but the kernel may still be holding
		// the port from a recent clean shutdown. Mirror the proven 4× /
		// 500ms pattern — long enough to absorb most TIME_WAIT windows,
		// short enough to fail loud if a non-brigade process is bound.
		const probeOnce = (): Promise<void> =>
			new Promise<void>((resolve, reject) => {
				const probe = createTcpServer();
				probe.unref();
				probe.once("error", (err) => reject(err));
				probe.listen(port, host, () => {
					probe.close(() => resolve());
				});
			});
		const PROBE_RETRIES = 4;
		const PROBE_BACKOFF_MS = 500;
		for (let attempt = 0; ; attempt++) {
			try {
				await probeOnce();
				break;
			} catch (err) {
				const code = (err as { code?: string }).code;
				if (code === "EADDRINUSE" && attempt < PROBE_RETRIES - 1) {
					await new Promise((r) => setTimeout(r, PROBE_BACKOFF_MS));
					continue;
				}
				throw err;
			}
		}

		// Phase 3 — Loading configuration. Mirrors openclaw's
		// `gatewayLog.info("loading configuration…")` immediately before
		// `loadConfig()` (`src/cli/gateway-cli/run.ts:301`).
		bootLog("loading configuration…");
		const config = await loadConfig();

		// Phase 4 — Resolving authentication. Mirrors openclaw's
		// `gatewayLog.info("resolving authentication…")`
		// (`src/cli/gateway-cli/run.ts:424`).
		bootLog("resolving authentication…");
		// Read auth from Brigade's `~/.brigade/agents/main/agent/auth-profiles.json`
		// (the file `brigade onboard` writes), NOT from Pi's vanilla
		// `${BRIGADE_DIR}/auth.json`. Without this bridge the gateway would
		// never see keys that onboarding produced.
		const authStorage = loadBrigadeAuthStorage() as AuthStorage;
		const modelRegistry = ModelRegistry.create(authStorage, `${BRIGADE_DIR}/models.json`);

		// F:\Brigade's brigade.json (post-2026-05-02 wizard refactor) stores
		// the default model under `agents.defaults.{provider, model.primary}`
		// to mirror the reference shape. The lifted code expected the older
		// flat `config.defaultProvider` / `config.defaultModelId` fields, so
		// we read the new shape here and project to local string vars.
		const wizardDefaults = (config.agents as { defaults?: { provider?: string; model?: { primary?: string } } } | undefined)?.defaults;
		const provider: string | undefined = wizardDefaults?.provider;
		const modelId: string | undefined = wizardDefaults?.model?.primary;
		if (!provider || !modelId) {
			throw new Error("server: no saved config — run setup first");
		}
		let model =
			modelRegistry.find(provider, modelId) ??
			((await resolveModelNeverMiss({
				modelRegistry,
				provider,
				modelId,
				modelsFile: `${BRIGADE_DIR}/models.json`,
				authStorage,
			})) as Model<string> | undefined);
		if (!model) {
			throw new Error(`server: model ${provider}/${modelId} not in registry`);
		}

		// Phase 5 — Starting. Mirrors openclaw's `gatewayLog.info("starting...")`
		// (`src/cli/gateway-cli/run.ts:539`) right before the runtime build.
		bootLog("starting...");

		return await continueBoot({
			opts,
			port,
			host,
			startupStartedAt,
			lockHandle,
			authStorage,
			modelRegistry,
			model,
			provider,
			modelId,
			bootLog,
		});
	} catch (err) {
		// Lock acquired but boot failed downstream — release the lock so a
		// retry doesn't have to wait for the 30s stale window.
		await lockHandle.release();
		throw err;
	}
}

interface BootContinueArgs {
	opts: ServerOptions;
	port: number;
	host: string;
	startupStartedAt: number;
	lockHandle: GatewayLockHandle;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model<string>;
	provider: string;
	modelId: string;
	bootLog: (message: string) => void;
}

async function continueBoot(args: BootContinueArgs): Promise<ServerHandle> {
	const { opts, port, host, startupStartedAt, lockHandle, modelRegistry, authStorage, bootLog } = args;
	const modelsFile = `${BRIGADE_DIR}/models.json`;

	// Gateway-held turn parameters. There is NO long-lived Pi session: each
	// inbound `prompt` builds a fresh session per turn (see the `prompt`
	// handler). These vars carry the "current selection" between turns and
	// are mutated by set-model / set-thinking / switch-model-mid-turn. The
	// next turn reads them when it constructs its session.
	let provider = args.provider;
	let modelId = args.modelId;
	let model = args.model;
	let thinkingLevel: ThinkingLevel = pickInitialThinkingLevel(model);

	// The agent identity + session key the gateway drives. A single
	// long-lived sessionKey gives conversation continuity across turns:
	// every turn resumes the same JSONL transcript (the per-turn mirror —
	// state lives on disk, not in a held session object).
	const agentId = DEFAULT_AGENT_ID;
	const sessionKey = defaultSessionKey(agentId);

	// The in-flight Pi session, surfaced via `runResilientTurn`'s
	// `onSessionReady` for the DURATION of a turn only. Null between turns.
	// abort / steer / switch-model-mid-turn / compact operate on it; when
	// no turn is active they no-op (there is nothing to steer).
	let inFlightSession: AgentSession | null = null;
	// Per-turn cleanup: detaches the gateway's Pi-event subscription + the
	// JSONL event logger for the active turn. Set when a turn starts, called
	// (idempotently) when it settles.
	let currentTurnCleanup: (() => void) | null = null;

	// Channel manager (WhatsApp/Slack/…): started after the WS listener is up
	// (see below), torn down in handle.stop(). Null when no channel is configured.
	let channelManager: ChannelManager | undefined;

	// Extension registry + the product capabilities it yields (services, HTTP
	// routes, gateway methods). Populated in Phase 11 after the listener is up.
	// `customMethods` is consulted by the request dispatcher's default branch so
	// module-registered RPCs resolve; `serviceAbort` stops background services.
	let extensionRegistry: BrigadeExtensionRegistry | undefined;
	let customMethods = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
	let httpRoutes: { method?: string; path: string; handler: HttpRouteHandler }[] = [];
	const startedServices: { id: string; service: Service }[] = [];
	let serviceAbort: AbortController | undefined;

	// Set true once handle.stop() begins, so background work (memory extraction
	// debounce) doesn't re-arm timers or run sweeps against a torn-down server.
	let serverStopped = false;

	// ── Background memory extraction (off the hot path) ──
	// After a turn settles we DEBOUNCE a batched sweep: during quiet time it
	// distills the NEW transcript turns into structured facts in ONE extra
	// model call, so the per-turn path stays at a single call. This is the
	// scalable shape (OpenClaw-style off-hot-path + batching) over Boop's
	// extraction algorithm — see agents/memory/extract.ts. Kill-switch:
	// BRIGADE_DISABLE_MEMORY_EXTRACT=1 turns off the ENTIRE background memory
	// sweep — extraction AND the decay GC AND consolidation that ride in the
	// same quiet window (runDecayGc + runConsolidation live inside
	// runExtractionNow below). This is intentional: disabling background memory
	// processing freezes the fact store wholesale rather than letting decay keep
	// silently ageing out facts the user can no longer see being replenished.
	const memoryExtractEnabled = process.env.BRIGADE_DISABLE_MEMORY_EXTRACT !== "1";
	const EXTRACT_DEBOUNCE_MS = 45_000;
	let extractTimer: ReturnType<typeof setTimeout> | null = null;
	// Keyed by sessionId so turns from DIFFERENT conversations (e.g. a WhatsApp
	// chat and the TUI) that settle inside the same debounce window each keep
	// their own pending batch — a single slot would let one overwrite another
	// and silently drop its turns. Re-setting the same sessionId just refreshes
	// that conversation's batch with the latest transcript.
	const pendingExtracts = new Map<string, unknown[]>();
	let extracting = false;

	const armExtractTimer = (): void => {
		if (serverStopped) return; // never re-arm after shutdown
		if (extractTimer) clearTimeout(extractTimer);
		extractTimer = setTimeout(() => void runExtractionNow(), EXTRACT_DEBOUNCE_MS);
		extractTimer.unref?.();
	};

	const runExtractionNow = async (): Promise<void> => {
		if (pendingExtracts.size === 0 || serverStopped) return;
		// Defer while a turn is active OR another sweep is in flight — never
		// compete with the user-facing call or run two extractions at once.
		// CRITICAL: re-arm rather than DROP the pending batches (otherwise a sweep
		// that fires mid-turn would silently lose the turns it was meant to
		// distill, with nothing to retrigger it until the next prompt).
		if (isAgentRunning || extracting) {
			armExtractTimer();
			return;
		}
		// Drain every pending conversation's batch this window.
		const batches = [...pendingExtracts.entries()];
		pendingExtracts.clear();
		extracting = true;
		try {
			const workspaceDir = resolveAgentWorkspaceDir(agentId);
			const llm = makeExtractionLlm({
				workspaceDir,
				agentDir: resolveAgentDir(agentId),
				authStorage,
				modelRegistry,
				model,
			});
			for (const [sessionId, messages] of batches) {
				await runExtractionSweep({ workspaceDir, sessionId, messages, llm });
			}
			// Cheap, no-model-call decay GC in the same quiet window — ages out
			// neglected facts so the structured store self-prunes. Runs once per
			// drain regardless of how many conversations were swept.
			runDecayGc(workspaceDir);
			// Lean semantic consolidation (1 LLM call) — THROTTLED to ~once/30min:
			// archives contradicted/duplicate facts that lexical write-time dedup
			// can't see. Off the hot path, rare, batched. Best-effort. The window
			// is tunable via BRIGADE_CONSOLIDATE_INTERVAL_MS (set 0 to run it on
			// every sweep — useful for manually verifying consolidation).
			const envInterval = Number(process.env.BRIGADE_CONSOLIDATE_INTERVAL_MS);
			const consolidateInterval =
				Number.isFinite(envInterval) && envInterval >= 0 ? envInterval : undefined;
			if (shouldRunConsolidation(workspaceDir, consolidateInterval)) {
				const consolidateLlm = makeConsolidationLlm({
					workspaceDir,
					agentDir: resolveAgentDir(agentId),
					authStorage,
					modelRegistry,
					model,
				});
				await runConsolidation({ workspaceDir, llm: consolidateLlm });
				markConsolidationRun(workspaceDir);
			}
		} catch (err) {
			// Best-effort — extraction never affects the user-facing turn.
			opts.consoleStream?.info?.(
				`memory extraction error: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			extracting = false;
		}
	};

	const scheduleExtraction = (result: { sessionId: string; messages: unknown[] }): void => {
		if (!memoryExtractEnabled || serverStopped) return;
		pendingExtracts.set(result.sessionId, result.messages);
		armExtractTimer();
	};

	// Cumulative usage totals for the state snapshot. Pi reports per-turn
	// usage on turn_end; we accumulate across turns.
	let totalIn = 0;
	let totalOut = 0;
	let totalCost = 0;
	let isAgentRunning = false;

	// Snapshot fields that can only be read from a LIVE Pi session
	// (context usage %, message count, thinking capabilities). With no
	// session between turns we cache the last-known values: seeded from the
	// model at boot, refreshed from the in-flight session during each turn.
	let lastContextUsagePercent: number | null = null;
	let lastMessageCount = 0;
	let cachedSupportsThinking = !!model.reasoning;
	let cachedThinkingLevels: string[] = deriveThinkingLevels(model);

	// Refresh the session-derived caches from a live Pi session. Called on
	// every forwarded event during a turn so the snapshot tracks the live
	// state, and once more as the turn settles so the between-turns snapshot
	// reflects the final message count / context usage.
	const refreshCachesFromSession = (s: AgentSession): void => {
		try {
			lastMessageCount = s.messages.length;
		} catch {
			/* session torn down — keep last value */
		}
		try {
			const usage = s.getContextUsage();
			if (usage?.percent != null) lastContextUsagePercent = usage.percent;
		} catch {
			/* ignore */
		}
		try {
			cachedSupportsThinking = s.supportsThinking();
		} catch {
			/* ignore */
		}
		try {
			cachedThinkingLevels = [...s.getAvailableThinkingLevels()];
		} catch {
			/* ignore */
		}
	};

	/**
	 * Detect "fresh-bootstrap mode + no turn yet" — the signal that drives
	 * connect-side auto-kickoff. Cheap path first: if a turn has happened we
	 * never need to stat the disk. Mirrors the gating used by the assembler
	 * for BOOTSTRAP.md injection (presence on disk + IDENTITY name unset).
	 *
	 * Sync I/O is intentional: this is called once per state broadcast, and
	 * the workspace files are tiny + on local disk — turning it async would
	 * complicate the buildSnapshot signature for sub-millisecond savings.
	 */
	const computeFirstRunBootstrap = (): boolean => {
		if (lastMessageCount > 0) return false;
		const wsDir = getBrigadeWorkspaceDir();
		try {
			if (!existsSync(joinPath(wsDir, "BOOTSTRAP.md"))) return false;
			const identityText = readFileSync(joinPath(wsDir, "IDENTITY.md"), "utf8");
			return isIdentityNameUnset(identityText);
		} catch {
			// IDENTITY.md missing or unreadable → treat as unset (fresh state).
			return existsSync(joinPath(wsDir, "BOOTSTRAP.md"));
		}
	};

	/**
	 * Pull the agent's chosen Name from IDENTITY.md for the snapshot.
	 * Resolves to `undefined` when not set or unreadable — the connect TUI
	 * falls back to its hardcoded "brigade" label in that case.
	 *
	 * Sync I/O for the same reason as computeFirstRunBootstrap above:
	 * snapshot is built per state broadcast, IDENTITY.md is tiny + local.
	 */
	const computeAgentName = (): string | undefined => {
		const wsDir = getBrigadeWorkspaceDir();
		try {
			const identityText = readFileSync(joinPath(wsDir, "IDENTITY.md"), "utf8");
			return extractIdentityName(identityText);
		} catch {
			return undefined;
		}
	};

	const buildSnapshot = (): SessionStateSnapshot => {
		return {
			provider,
			modelId,
			modelName: model?.name,
			thinkingLevel,
			supportsThinking: cachedSupportsThinking,
			availableThinkingLevels: cachedThinkingLevels,
			contextUsagePercent: lastContextUsagePercent,
			totalTokensIn: totalIn,
			totalTokensOut: totalOut,
			totalCostUsd: totalCost,
			isAgentRunning,
			messageCount: lastMessageCount,
			firstRunBootstrap: computeFirstRunBootstrap(),
			agentName: computeAgentName(),
		};
	};

	/* ──────────────── transport ──────────────── */

	// Phase 6 — Starting HTTP server. Mirrors openclaw's
	// `log.info("starting HTTP server...")` (`src/gateway/server.impl.ts:423`).
	bootLog("starting HTTP server...");
	const httpServer: HttpServer = createServer();
	const wss = new WebSocketServer({ server: httpServer });

	// `WebSocketServer` re-emits errors from the underlying httpServer (and
	// can emit its own — bad upgrade frame, etc). With NO 'error' listener on
	// wss, Node's EventEmitter throws the error, crashing the process with an
	// unhandled stack trace BEFORE our listen-promise's reject can fire.
	// Concrete repro: `npm run gateway` when 7777 is already bound.
	//
	// Capture and store; the listen promise below races against this. If a
	// wssError lands before listen resolves, we use it as the reject reason.
	let wssError: Error | undefined;
	wss.on("error", (err) => {
		wssError = err instanceof Error ? err : new Error(String(err));
	});

	const clients = new Set<WebSocket>();

	/** Send one event to all connected clients. */
	const broadcast = <K extends EventName>(event: K, payload: EventPayload[K]): void => {
		const frame: Frame = { type: "event", event, payload };
		const json = JSON.stringify(frame);
		for (const ws of clients) {
			if (ws.readyState === ws.OPEN) ws.send(json);
		}
	};

	/* ──────────────── per-turn pi event forwarding ──────────────── */

	// Wire a fresh per-turn Pi session into the gateway's broadcast +
	// logging plumbing. Called from the `prompt` handler's `onSessionReady`
	// the moment `runResilientTurn` finishes constructing the session (after
	// persona injection + guard install, before the model call). Returns a
	// cleanup that detaches both the Pi subscription and the JSONL logger;
	// the prompt handler calls it when the turn settles so nothing leaks
	// across turns (the per-turn mirror — no subscription outlives its turn).
	const attachTurnSession = (session: AgentSession): (() => void) => {
		inFlightSession = session;
		// Stream this turn's Pi events to the JSONL log file. Logger silently
		// degrades on I/O errors so log loss never crashes the server.
		const detachLogger = attachEventLogger(session);
		const detachPi = session.subscribe((piEvent: AgentSessionEvent) => {
			// NOTE: `isAgentRunning` is owned by the `prompt` handler's
			// try/finally — NOT by Pi's per-run agent_start/agent_end. A single
			// logical turn fires multiple `session.prompt()` runs (content-quality
			// retry, thinking-fallback, max_tokens continuations), each emitting
			// its own agent_start/agent_end. Toggling the flag here would flap it
			// false mid-turn, flicker the connect header, and re-open the
			// single-turn concurrency guard. We only forward the events.
			if (piEvent.type === "turn_end") {
				const usage = (piEvent as any).message?.usage;
				if (usage) {
					totalIn += usage.input ?? 0;
					totalOut += usage.output ?? 0;
					totalCost += usage.cost ?? 0;
				}
			}
			// Keep the between-turns snapshot caches (message count, context
			// usage %, thinking caps) tracking the live session.
			refreshCachesFromSession(session);
			// Live console stream (verbose mode). Mirrors the JSONL file but
			// human-readable. Same event sequence in both places.
			opts.consoleStream?.pi(piEvent);
			broadcast("pi", { event: piEvent });
			broadcast("state", buildSnapshot());
		});
		let cleaned = false;
		return () => {
			if (cleaned) return;
			cleaned = true;
			try {
				detachPi();
			} catch {
				/* session may already be torn down */
			}
			try {
				detachLogger();
			} catch {
				/* ignore */
			}
			// Final cache refresh so the idle snapshot reflects the settled
			// turn, then drop the session reference (no session between turns).
			refreshCachesFromSession(session);
			if (inFlightSession === session) inFlightSession = null;
		};
	};

	// Lifecycle bus subscriber (Phase 5b): translate `runBrigadeTurnLoop`
	// events into broadcast("log", ...) frames so connect-mode TUI clients
	// see the same status messages the inline composition used to emit.
	const detachLifecycleBus = onAgentEvent((event) => {
		switch (event.type) {
			case "turn-heartbeat":
				broadcast("log", {
					level: "info",
					message: `still working… ${Math.round(event.elapsedMs / 1000)}s elapsed`,
					at: Date.now(),
				});
				break;
			case "turn-stream-timeout":
				broadcast("log", {
					level: "warn",
					message: `no response for ${Math.round(event.idleMs / 1000)}s — aborting`,
					at: Date.now(),
				});
				break;
			case "turn-length-continue":
				broadcast("log", {
					level: "info",
					message: "reply was truncated — asking the model to continue",
					at: Date.now(),
				});
				break;
			case "turn-content-retry":
				broadcast("log", {
					level: "info",
					message: `${event.reason} — re-prompting for a usable answer`,
					at: Date.now(),
				});
				break;
			case "turn-thinking-downgrade":
				broadcast("log", {
					level: "info",
					message: `model doesn't support thinking — switching from ${event.from} to off and retrying`,
					at: Date.now(),
				});
				break;
			case "turn-fallback-attempt":
				broadcast("log", {
					level: "warn",
					message: `primary failed (${event.reason}) — trying ${event.toModelId ?? "fallback"}`,
					at: Date.now(),
				});
				break;
			case "turn-fallback-exhausted":
				broadcast("log", {
					level: "error",
					message: `all fallback models failed: ${event.reason}`,
					at: Date.now(),
				});
				break;
			case "turn-retry-attempt":
				broadcast("log", {
					level: event.errorClass === "context_overflow" ? "info" : "warn",
					message: event.reason,
					at: Date.now(),
				});
				break;
			case "turn-compact-before-retry":
				broadcast("log", {
					level: "info",
					message: "context overflow — compacting then retrying same model",
					at: Date.now(),
				});
				break;
			case "tool-blocked":
				// Surface guard/exec-gate refusals to connect-mode clients as a
				// warn log. The model ALSO sees Pi's synthetic error tool_result
				// (broadcast via "pi"), but this gives the operator an explicit
				// "✗ <tool> blocked" status line with the reason.
				broadcast("log", {
					level: "warn",
					message: `${event.toolName} blocked: ${event.reason.split("\n")[0]}`,
					at: Date.now(),
				});
				break;
			default:
				// `pi`, `turn-start`, `turn-settled`, etc. — handled elsewhere
				// or not surfaced as status logs.
				break;
		}
	});

	/* ──────────────── serialized turn executor ──────────────── */

	// Every agent turn — whether from a TUI `prompt` RPC or an inbound channel
	// message — runs through this single FIFO queue. There is exactly one brain
	// in this phase: turns never overlap, so the per-turn session plumbing
	// (inFlightSession / broadcast snapshot / extraction debounce) stays
	// single-writer. Phase 2 (multi-user) will shard the queue per crew; the
	// `runGatewayTurn` seam is what they'll plug into.
	let turnChain: Promise<unknown> = Promise.resolve();
	const runQueued = <T>(fn: () => Promise<T>): Promise<T> => {
		// Chain onto the previous turn regardless of how it settled, so one
		// turn's failure never wedges the queue.
		const run = turnChain.then(fn, fn);
		turnChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	/**
	 * Run one agent turn end-to-end and return its result. Builds a FRESH Pi
	 * session via the canonical per-turn path (`runResilientTurn`), resumes the
	 * transcript identified by `sessionKey`, runs the full Brigade safety stack,
	 * schedules the off-hot-path memory sweep, and tears the per-turn wiring down
	 * when it settles. Always invoked inside `runQueued` so only one runs at once.
	 */
	const runGatewayTurn = (turn: { text: string; sessionKey: string }): Promise<RunSingleTurnResult> =>
		runQueued(async () => {
			isAgentRunning = true;
			broadcast("state", buildSnapshot());
			try {
				// Resolve fallback model fresh per turn — the user may have edited
				// config (or rotated keys) between turns. F:\Brigade's shape:
				// `agents.defaults.model.fallbacks[]` (string array).
				const cfgNow = await loadConfig();
				const wizardNow = (
					cfgNow.agents as { defaults?: { provider?: string; model?: { fallbacks?: string[] } } } | undefined
				)?.defaults;
				const fallbackProvider = wizardNow?.provider;
				const fallbackModelId = wizardNow?.model?.fallbacks?.[0];
				// Include the configured fallback unconditionally — the per-turn path
				// runs the never-miss resolver on it, so we don't pre-filter with a
				// static `find` (which would drop a valid-but-uncatalogued fallback).
				const fallbacks =
					fallbackProvider && fallbackModelId ? [{ provider: fallbackProvider, modelId: fallbackModelId }] : [];

				const result = await runResilientTurn({
					agentId,
					provider,
					modelId,
					message: turn.text,
					sessionKey: turn.sessionKey,
					thinkingLevel: thinkingLevel as "off" | "low" | "medium" | "high",
					fallbacks,
					onSessionReady: (session) => {
						// A fallback candidate builds a fresh session; tear down the
						// previous candidate's wiring before attaching the new one.
						if (currentTurnCleanup) currentTurnCleanup();
						currentTurnCleanup = attachTurnSession(session);
					},
				});
				// Queue a debounced, batched memory-extraction sweep over the settled
				// transcript (off the hot path; see scheduleExtraction).
				scheduleExtraction({ sessionId: result.sessionId, messages: result.messages });
				return result;
			} finally {
				if (currentTurnCleanup) {
					currentTurnCleanup();
					currentTurnCleanup = null;
				}
				inFlightSession = null;
				isAgentRunning = false;
				broadcast("state", buildSnapshot());
			}
		});

	/* ──────────────── request handler ──────────────── */

	/**
	 * Type-safe request dispatcher. Each method handler returns its declared
	 * payload (per `ResponseFor`), which is wrapped into a ResponseFrame.
	 *
	 * Adding a new method:
	 *   1. Add the literal to RequestMethod in protocol.ts
	 *   2. Add params/payload types in RequestParams / ResponseFor
	 *   3. Add a case here returning the payload
	 *   4. Add a typed wrapper in the client
	 */
	const handleRequest = async <M extends RequestMethod>(
		method: M,
		rawParams: unknown,
	): Promise<ResponseFor[M]> => {
		const params = rawParams as RequestParams[M];

		switch (method) {
			case "prompt": {
				const p = params as RequestParams["prompt"];
				// One turn at a time. Fast-reject if a turn is already streaming so
				// the interactive client gets immediate feedback rather than a
				// silently-queued duplicate. Correctness (no overlap) is guaranteed
				// by `runGatewayTurn`'s serialized queue regardless — this check is
				// just UX. The TUI prompt drives the gateway's main session key.
				if (isAgentRunning) throw new Error("a turn is already in progress");
				await runGatewayTurn({ text: p.text, sessionKey });
				return undefined as ResponseFor[M];
			}
			case "abort": {
				// Abort only means something mid-turn. With no held session,
				// abort the in-flight one if present; otherwise harmless no-op.
				if (inFlightSession) await inFlightSession.abort().catch(() => {});
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "steer": {
				const p = params as RequestParams["steer"];
				// Steer injects a mid-turn user message. Only valid while a turn
				// is active — there's no session to enqueue into otherwise.
				if (!inFlightSession) throw new Error("nothing to steer — no turn in progress");
				await inFlightSession.steer(p.text);
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "set-model": {
				const p = params as RequestParams["set-model"];
				const target =
					modelRegistry.find(p.provider, p.modelId) ??
					((await resolveModelNeverMiss({
						modelRegistry,
						provider: p.provider,
						modelId: p.modelId,
						modelsFile,
						authStorage,
					})) as Model<string> | undefined);
				if (!target) throw new Error(`model ${p.provider}/${p.modelId} not found`);
				// No live session to mutate — update the gateway's current
				// selection so the NEXT turn builds with this model. Re-pick a
				// safe thinking level (reasoning models reject "off") + refresh
				// the snapshot's thinking caps from the new model.
				provider = p.provider;
				modelId = p.modelId;
				model = target;
				thinkingLevel = pickInitialThinkingLevel(target);
				cachedSupportsThinking = !!target.reasoning;
				cachedThinkingLevels = deriveThinkingLevels(target);
				await saveConfig(persistDefaultModel(await loadConfig(), p.provider, p.modelId));
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "switch-model-mid-turn": {
				const p = params as RequestParams["switch-model-mid-turn"];
				const target =
					modelRegistry.find(p.provider, p.modelId) ??
					((await resolveModelNeverMiss({
						modelRegistry,
						provider: p.provider,
						modelId: p.modelId,
						modelsFile,
						authStorage,
					})) as Model<string> | undefined);
				if (!target) throw new Error(`model ${p.provider}/${p.modelId} not found`);
				// A live mid-turn switch (abort → swap → replay) only applies
				// when a turn is actually running. If one is, perform it on the
				// in-flight session; either way, update the gateway selection so
				// subsequent turns continue on the new model.
				if (inFlightSession) {
					await piSwitchModelMidTurn(inFlightSession, target, p.replayMessage);
				}
				provider = p.provider;
				modelId = p.modelId;
				model = target;
				thinkingLevel = pickInitialThinkingLevel(target);
				cachedSupportsThinking = !!target.reasoning;
				cachedThinkingLevels = deriveThinkingLevels(target);
				await saveConfig(persistDefaultModel(await loadConfig(), p.provider, p.modelId));
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "set-thinking": {
				const p = params as RequestParams["set-thinking"];
				// Update the gateway's current level; the next turn passes it
				// into its session. If a turn is live, set it on the in-flight
				// session too so it takes effect immediately. Pi clamps to the
				// model's capabilities either way.
				thinkingLevel = p.level as ThinkingLevel;
				if (inFlightSession) {
					try {
						inFlightSession.setThinkingLevel(p.level as never);
					} catch {
						/* clamp / unsupported — snapshot still reflects intent */
					}
				}
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "compact": {
				// Compaction operates on a live session. Between turns there's
				// nothing loaded — compaction auto-triggers at the start of the
				// next turn when usage crosses the threshold (maybeTriggerCompaction
				// in agent-loop.ts). If a turn IS live, compact it now.
				if (!inFlightSession) {
					throw new Error(
						"nothing to compact yet — compaction runs during a turn and auto-triggers near the context limit",
					);
				}
				await (inFlightSession as AgentSession & { compact?: () => Promise<unknown> }).compact?.();
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "list-models": {
				const models = modelRegistry.getAvailable().map((m: Model<any>) => modelToSummary(m));
				return models as ResponseFor[M];
			}
			case "refresh-models": {
				modelRegistry.refresh();
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "get-state": {
				return buildSnapshot() as ResponseFor[M];
			}
			case "shutdown": {
				// Graceful shutdown — ack the request synchronously, then schedule
				// the actual stop on the next tick so the response frame has time
				// to flush before the process exits. `brigade gateway stop` calls
				// this to avoid Windows' `process.kill(SIGTERM)` being a forceful
				// kill that skips the gateway's cleanup chain (PID file, lock
				// file, Pi session detach, JSONL log close).
				setImmediate(() => {
					void (async () => {
						try {
							await handleSelfRef.value?.stop();
						} catch (err) {
							process.stderr.write(
								`brigade-gateway: shutdown error during stop: ${(err as Error).message}\n`,
							);
						}
						process.exit(0);
					})();
				});
				return undefined as ResponseFor[M];
			}
			default: {
				// Module-registered gateway methods (extensions). These don't appear
				// in the static RequestMethod union, so they resolve here.
				const custom = customMethods.get(method as string);
				if (custom) return (await custom(rawParams)) as ResponseFor[M];
				throw new Error(`unknown method: ${method}`);
			}
		}
	};

	// Self-reference so the shutdown RPC can call our own stop() without a
	// circular declaration. Filled in just before we return the handle.
	const handleSelfRef: { value: ServerHandle | undefined } = { value: undefined };

	/* ──────────────── connection lifecycle ──────────────── */

	wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
		clients.add(ws);
		const clientLabel = `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
		opts.consoleStream?.clientConnected(clientLabel, clients.size);

		// Send the initial snapshot so the client can render its header
		// before any user action.
		ws.send(JSON.stringify({ type: "event", event: "state", payload: buildSnapshot() } satisfies Frame));

		ws.on("message", async (data) => {
			let frame: Frame;
			try {
				const parsed = JSON.parse(data.toString());
				if (!isFrame(parsed)) return;
				frame = parsed;
			} catch {
				return; // unparseable — drop, never crash
			}

			if (frame.type !== "req") return; // server only handles requests

			const reqFrame = frame as RequestFrame;
			opts.consoleStream?.wsRequest(reqFrame.method, reqFrame.id, clientLabel);
			const startedAt = Date.now();
			try {
				const payload = await handleRequest(reqFrame.method, reqFrame.params);
				const response: Frame = {
					type: "res",
					id: reqFrame.id,
					ok: true,
					payload,
				};
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
				opts.consoleStream?.wsResponse(reqFrame.method, reqFrame.id, true, Date.now() - startedAt);
			} catch (err) {
				const response: Frame = {
					type: "res",
					id: reqFrame.id,
					ok: false,
					error: {
						code: "internal",
						message: err instanceof Error ? err.message : String(err),
					},
				};
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
				opts.consoleStream?.wsResponse(reqFrame.method, reqFrame.id, false, Date.now() - startedAt);
			}
		});

		ws.on("close", () => {
			clients.delete(ws);
			opts.consoleStream?.clientDisconnected(clientLabel, clients.size);
		});

		ws.on("error", () => {
			clients.delete(ws);
		});
	});

	/* ──────────────── tick heartbeat ──────────────── */

	// Push an empty `state` snapshot every TICK_INTERVAL_MS so clients can
	// detect a dead server (no frames in 2× this interval = close + reconnect).
	// Sending the snapshot doubles as keep-alive AND consistency check.
	const tickTimer = setInterval(() => {
		broadcast("state", buildSnapshot());
	}, TICK_INTERVAL_MS);
	tickTimer.unref(); // don't block process exit on timer

	/* ──────────────── start listening ──────────────── */

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			httpServer.removeListener("error", onError);
			wss.removeListener("error", onWssError);
			reject(err);
		};
		const onWssError = (err: Error): void => {
			// wss errors during boot (typically the re-emitted EADDRINUSE)
			// must reject the boot promise — without this, only `wssError`
			// (captured above) sees them and the listen() callback never
			// fires either, hanging forever.
			httpServer.removeListener("error", onError);
			wss.removeListener("error", onWssError);
			reject(err);
		};
		httpServer.once("error", onError);
		wss.once("error", onWssError);
		httpServer.listen(port, host, () => {
			httpServer.removeListener("error", onError);
			wss.removeListener("error", onWssError);
			// If wss already errored before listen's success fired, surface it.
			if (wssError) {
				reject(wssError);
				return;
			}
			resolve();
		});
	});

	// Phase 7 — agent model resolved. Mirrors openclaw's
	// `agent model: <provider>/<model>` line (`src/gateway/server-startup-log.ts:24-27`).
	bootLog(`agent model: ${provider}/${modelId}`);

	// Phase 8 — Listening on bound port. Mirrors openclaw's
	// `listening on ws://${host}:${port}` line that the verbose banner emits.
	bootLog(`listening on ws://${host}:${port}`);

	// Phase 9 — ready marker with timing. Mirrors openclaw's
	// `ready (N plugins: ...; Xs)` line (`src/gateway/server-startup-log.ts:32`).
	// Brigade has zero plugins in v1, so the body is timing-only — `ready (Xs)`.
	const startupDurationMs = Date.now() - startupStartedAt;
	const startupDurationLabel = `${(startupDurationMs / 1000).toFixed(1)}s`;
	bootLog(`ready (${startupDurationLabel})`);

	// Build identity — reports the exact commit + build time this daemon is
	// running, from the postbuild stamp (dist/buildstamp.json). Only emitted
	// when a stamp is present (skipped in a dev source tree).
	const build = getBuildInfo();
	if (build.head) {
		const builtAt = build.builtAt ? ` · ${new Date(build.builtAt).toISOString()}` : "";
		bootLog(`build: ${build.head.slice(0, 7)}${builtAt}`);
	}

	// Phase 10 — log-file pointer. Mirrors openclaw's
	// `log file: <path>` line (`src/gateway/server-startup-log.ts:33`).
	bootLog(`log file: ${getTodayLogPath()}`);

	// HTTP request handler for module-registered routes. Attached once; it reads
	// the live `httpRoutes` list, so a reload swaps routes without re-binding.
	// WS upgrades use the separate 'upgrade' event and are unaffected.
	httpServer.on("request", (req, res) => {
		void (async () => {
			try {
				const reqPath = (req.url ?? "").split("?")[0];
				const route = httpRoutes.find((r) => r.path === reqPath && (!r.method || r.method === req.method));
				if (!route) {
					res.statusCode = 404;
					res.end("Not found");
					return;
				}
				await route.handler(req, res);
			} catch (err) {
				opts.consoleStream?.info?.(`http route error: ${err instanceof Error ? err.message : String(err)}`);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end("Internal error");
				}
			}
		})();
	});

	// A module's start()/stop() must never wedge boot, reload, or shutdown — cap
	// each. On timeout we log + move on (the straggler is left running; the race
	// keeps it handled — see extension-lifecycle.ts).
	const SERVICE_START_TIMEOUT_MS = 15_000;
	const SERVICE_STOP_TIMEOUT_MS = 10_000;

	// Serialize ALL extension-lifecycle ops (initial start + every reload) onto
	// one chain. Without this, a `system.reload` racing boot — or two concurrent
	// reloads — would build two registries, double-start services, and leak a
	// channel manager (start a second WhatsApp socket while the first is never
	// stopped). The chain guarantees stop→start runs atomically, one at a time.
	const queueExtensionsOp = makeOpQueue();

	// Stop every started product capability (channels + services). Idempotent;
	// used by both shutdown and reload.
	const stopExtensions = async (): Promise<void> => {
		if (channelManager) {
			await channelManager.stop().catch(() => {});
			channelManager = undefined;
		}
		if (serviceAbort) {
			serviceAbort.abort();
			serviceAbort = undefined;
		}
		for (const { id, service } of startedServices.splice(0)) {
			try {
				await withTimeout(Promise.resolve(service.stop()), SERVICE_STOP_TIMEOUT_MS, `service ${id} stop`);
			} catch (err) {
				opts.consoleStream?.info?.(`service ${id} stop error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};

	// Load the extension registry and start/mount everything it yields: channels,
	// background services, HTTP routes, gateway methods, plus a built-in
	// `system.capabilities` / `system.reload` RPC. Best-effort — a module failure
	// never stops the gateway. Reusable so `system.reload` can re-run it.
	const startExtensions = async (): Promise<void> => {
		if (serverStopped) return; // a reload queued after shutdown must not restart anything
		const cfg = await loadConfig();
		const workspaceDir = resolveAgentWorkspaceDir(agentId);
		const registry = await loadModules({
			modules: BUNDLED_MODULES,
			meta: { agentId, workspaceDir, cwd: workspaceDir, config: cfg as never },
		});
		extensionRegistry = registry;

		// Gateway methods: module-registered RPCs + two built-ins. The `system.`
		// prefix is reserved for built-ins — a module that uses it would be
		// silently overwritten below, so warn instead of failing quietly.
		for (const m of registry.gatewayMethods) {
			if (m.name.startsWith("system.")) {
				bootLog(`extension gateway method "${m.name}" ignored — the "system." prefix is reserved`);
			}
		}
		const methods = new Map<string, (params: unknown) => Promise<unknown> | unknown>(
			registry.gatewayMethods.filter((m) => !m.name.startsWith("system.")).map((m) => [m.name, m.handler]),
		);
		methods.set("system.capabilities", () => ({
			channels: registry.channels.map((c) => c.id),
			voice: {
				tts: registry.speechProviders.map((p) => p.id),
				stt: registry.transcriptionProviders.map((p) => p.id),
			},
			media: registry.mediaGenProviders.map((p) => p.id),
			integrations: registry.integrations.map((i) => i.id),
			services: registry.services.map((s) => s.id),
			httpRoutes: registry.httpRoutes.map((r) => ({ method: r.method ?? "ANY", path: r.path })),
			gatewayMethods: registry.gatewayMethods.map((m) => m.name),
			modules: registry.loadedModules.map((m) => m.id),
		}));
		methods.set("system.reload", () =>
			// Serialized onto the extension-lifecycle chain — can't race boot or
			// another reload (no double-start / leaked channel manager).
			queueExtensionsOp(async () => {
				await stopExtensions();
				clearDiscoveryCache(); // re-scan ~/.brigade/extensions on reload
				await startExtensions();
				for (const m of extensionRegistry?.loadedModules ?? []) {
					try {
						await m.reload?.();
					} catch (err) {
						opts.consoleStream?.info?.(
							`module ${m.id} reload error: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				return { ok: true };
			}),
		);
		customMethods = methods;

		// HTTP routes — swap in the live list the request handler reads.
		httpRoutes = registry.httpRoutes.map((r) => ({ method: r.method, path: r.path, handler: r.handler }));

		// Channels — inbound runs through the SAME serialized turn queue as TUI
		// prompts (`runGatewayTurn`), so a channel turn never overlaps a TUI turn.
		if (registry.channels.length > 0) {
			channelManager = await startChannels({
				adapters: registry.channels,
				config: cfg as never,
				agentId,
				commands: registry.channelCommands,
				runTurn: (turn) => runGatewayTurn(turn),
				onPairing: (channelId, info) => {
					const line =
						info.kind === "qr"
							? `[${channelId}] scan the QR code shown in the gateway logs to link your account`
							: `[${channelId}] pairing code: ${info.value}`;
					bootLog(line);
					broadcast("log", { level: "info", message: line, at: Date.now() });
				},
			});
			if (channelManager.started.length > 0) bootLog(`channels: ${channelManager.started.join(", ")}`);
		}

		// Background services — start each; a failing one is skipped, not fatal.
		if (registry.services.length > 0) {
			serviceAbort = new AbortController();
			for (const service of registry.services) {
				// Track BEFORE awaiting start so a hung/slow start is still stopped on
				// teardown (its abort signal fires, and stop() is attempted).
				startedServices.push({ id: service.id, service });
				try {
					await withTimeout(
						Promise.resolve(
							service.start({
								signal: serviceAbort.signal,
								log: (msg, m) =>
									opts.consoleStream?.info?.(`[${service.id}] ${msg}${m ? ` ${JSON.stringify(m)}` : ""}`),
							}),
						),
						SERVICE_START_TIMEOUT_MS,
						`service ${service.id} start`,
					);
				} catch (err) {
					bootLog(`service ${service.id} failed to start: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (startedServices.length > 0) bootLog(`services: ${startedServices.map((s) => s.id).join(", ")}`);
		}

		// Surface the rest so voice/media/integration/route/method registrations
		// are visible (and the registries are genuinely consumed, not dead).
		const caps: string[] = [];
		if (registry.speechProviders.length) caps.push(`tts:${registry.speechProviders.map((p) => p.id).join("/")}`);
		if (registry.transcriptionProviders.length)
			caps.push(`stt:${registry.transcriptionProviders.map((p) => p.id).join("/")}`);
		if (registry.mediaGenProviders.length) caps.push(`media:${registry.mediaGenProviders.map((p) => p.id).join("/")}`);
		if (registry.integrations.length) caps.push(`integrations:${registry.integrations.map((i) => i.id).join("/")}`);
		if (registry.httpRoutes.length) caps.push(`http:${registry.httpRoutes.length}`);
		if (registry.gatewayMethods.length) caps.push(`rpc:${registry.gatewayMethods.length}`);
		if (caps.length) bootLog(`capabilities: ${caps.join(" ")}`);
	};

	// Phase 11 — extensions. Load the registry + start product capabilities.
	// Routed through the lifecycle queue so a `system.reload` arriving during
	// boot serializes AFTER this initial start (never concurrently).
	try {
		await queueExtensionsOp(startExtensions);
	} catch (err) {
		// Best-effort — an extension failure must not stop the gateway.
		bootLog(`extensions failed to start: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Write the PID file AFTER the listen succeeded so a failed-to-bind boot
	// doesn't leave a stale pointer to a process that never accepted any
	// connections. `brigade gateway stop` reads this to find the daemon.
	try {
		await writePidFile();
	} catch {
		// Best-effort — gateway operates fine without it; only `gateway stop`
		// + `gateway status` lose discoverability when the file is missing.
	}

	const handle: ServerHandle = {
		port,
		host,
		async stop() {
			serverStopped = true; // freeze background memory work
			clearInterval(tickTimer);
			if (extractTimer) clearTimeout(extractTimer);
			pendingExtracts.clear();
			// Stop all product capabilities (channels + services) first so no new
			// inbound turn is enqueued during teardown. Routed through the lifecycle
			// queue so it can't race an in-flight `system.reload`.
			await queueExtensionsOp(stopExtensions).catch(() => {});
			// Best-effort abort of a turn that's still streaming, then WAIT for the
			// turn queue to drain so an in-flight (or just-queued) turn's finally —
			// cleanup, broadcast, scheduleExtraction — can't run against a
			// torn-down server after stop() returns.
			if (inFlightSession) await inFlightSession.abort().catch(() => {});
			await turnChain.catch(() => {});
			// Tear down any in-flight turn's Pi subscription + JSONL logger.
			// Between turns there's nothing attached, so this is a no-op then.
			if (currentTurnCleanup) {
				currentTurnCleanup();
				currentTurnCleanup = null;
			}
			detachLifecycleBus();
			for (const ws of clients) {
				try {
					ws.close();
				} catch {
					/* ignore */
				}
			}
			wss.close();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			// Clean up the PID pointer last so concurrent `gateway status`
			// calls during shutdown still see a sensible (alive) PID until
			// the listening socket is actually closed.
			try {
				await clearPidFile();
			} catch {
				// Same reasoning as the boot-side write — non-fatal.
			}
			// Release the gateway lock so the next `brigade gateway run`
			// doesn't have to wait for the 30s stale window. Idempotent.
			await lockHandle.release();
		},
	};
	// Wire the self-reference so the `shutdown` RPC handler above can call
	// `handle.stop()` without a circular forward-declaration.
	handleSelfRef.value = handle;
	return handle;
}

/* ────────────────────────── standalone entry ────────────────────────── */

/**
 * Allow running this file directly: `npx tsx src/core/server.ts` or
 * `node dist/core/server.js`. Uses the canonical Node pattern (compare
 * import.meta.url against pathToFileURL of argv[1]) so Windows backslash
 * paths and tsx loader prefixes don't confuse the equality check.
 */
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
	startServer()
		.then((handle) => {
			const onSignal = (sig: string) => {
				process.stderr.write(`brigade-server: ${sig} received, shutting down\n`);
				void handle.stop().then(() => process.exit(0));
			};
			process.on("SIGTERM", () => onSignal("SIGTERM"));
			process.on("SIGINT", () => onSignal("SIGINT"));
		})
		.catch((err) => {
			process.stderr.write(`brigade-server: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
			process.exit(1);
		});
}
