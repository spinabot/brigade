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
// when the turn settles. Each turn builds and tears down its own session
// — no session lives between turns. The in-flight
// session is surfaced for the turn's lifetime via `onSessionReady` so the
// gateway can steer / abort / switch-model mid-stream.
import { runResilientTurn, type RunSingleTurnResult } from "../agents/agent-loop.js";
import { BrigadeExtensionRegistry, BUNDLED_MODULES, clearDiscoveryCache, loadModules } from "../agents/extensions/index.js";
import type { GatewayCaller, GatewayMethodHandler, HttpRoute, Service } from "../agents/extensions/index.js";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, readBodyWithLimit } from "./webhook-guards.js";
import { setActiveChannelManager } from "../agents/channels/active-manager.js";
import { type ChannelManager, startChannels } from "../agents/channels/manager.js";
import { makeOpQueue, withTimeout } from "./extension-lifecycle.js";
import { resolveModelNeverMiss } from "../agents/model-resolution.js";
import { switchModelMidTurn as piSwitchModelMidTurn } from "../agents/mid-turn-switch.js";
import { onAgentEvent } from "../agents/agent-event-bus.js";
import {
	InMemoryApprovalBridge,
	setActiveApprovalBridge,
} from "../agents/approval-bridge.js";
import { setActiveCronService } from "../cron/active-service.js";
import { runCronIsolatedAgentJob } from "../cron/isolated-agent/run.js";
import { createCronServiceState } from "../cron/service/state.js";
import { start as cronStart, stop as cronStop } from "../cron/service/ops.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { DEFAULT_AGENT_ID, resolveAgentDir, resolveAgentWorkspaceDir } from "../config/paths.js";
import { runHeartbeatNow } from "../agents/heartbeat.js";
import { enqueuePendingSystemEvent } from "../agents/pending-system-events.js";
// Multi-routing wiring (Step 1-27 lift): in-process gateway-call dispatcher,
// per-method handlers (sessions.*, health), agent-events bridge, heartbeat
// runner + wake flag, lane drain helpers. All exported but never called
// pre-wiring; the boot path below installs them once.
import {
	installInProcessGatewayCaller,
	registerGatewayHandler,
} from "./gateway-caller-impl.js";
import { handleHealthMethod } from "./server-methods/health.js";
import {
	handleSessionsHistory,
	handleSessionsList,
	handleSessionsPatch,
	handleSessionsSend,
	handleSessionsSpawn,
} from "./server-methods/sessions.js";
import { wireAgentEventsBridge } from "../agents/agent-events.js";
import { requestHeartbeatNow, setHeartbeatsEnabled } from "../agents/heartbeat-wake.js";
import {
	setHeartbeatFiredHook,
	startHeartbeatRunner,
	type HeartbeatRunnerHandle,
} from "../agents/heartbeat-runner.js";
import {
	createHeartbeatScheduler,
	type HeartbeatScheduler,
} from "../agents/heartbeat-scheduler.js";
import { markGatewayDraining, waitForActiveTasks } from "../process/lanes.js";
import { ensureDir } from "../config/paths.js";
import {
	CommandLane,
	type CommandLaneId,
	enqueueInLane,
	getLaneQueueSize,
	sessionLane,
} from "../process/lanes.js";
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

/** Bind addresses that are safe to listen on under the v1 "single-user" model. */
const LOCALHOST_BINDS = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0/loopback-only"]);

function isLocalhostBind(host: string): boolean {
	return LOCALHOST_BINDS.has(host) || host === "::ffff:127.0.0.1";
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
	const port = opts.port ?? (Number(process.env.BRIGADE_PORT) || DEFAULT_PORT);
	const host = opts.host ?? "127.0.0.1";

	// Brigade v1 is single-user / localhost-only. The gateway exposes
	// agent-controls + module RPCs over an UNAUTHENTICATED WebSocket; binding it
	// to anything reachable from the LAN/internet would publish those controls
	// to anyone who can reach the port. Multi-user/network exposure lands with
	// the Phase-2 SaaS shape (HTTP-session auth, not a static token). Refusing
	// non-localhost binds here means an operator can't accidentally ship a wide-
	// open daemon by setting `--host 0.0.0.0`.
	if (!isLocalhostBind(host)) {
		throw new Error(
			`brigade gateway only binds to localhost in v1 (got --host ${host}). ` +
				"Multi-user / network-exposed deployment requires the Phase-2 SaaS shape. " +
				"For LAN access today, front the gateway with a reverse-proxy that adds your own auth.",
		);
	}

	// Capture the boot start time so the `ready (Xs)` line can report total
	// startup duration. Threaded through the boot chain.
	const startupStartedAt = Date.now();

	// Phase logger — emits to the verbose console-stream when present, falls
	// back to plain stderr lines so the bare-mode boot still surfaces
	// progress (e.g. "loading configuration…").
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
	// `cli/commands/gateway.ts` formats with the canonical "gateway
	// already running (pid X); lock timeout after 5000ms" message.
	//
	// We DON'T emit a "phase" log line for the lock attempt because in
	// the happy path it's instant and silent.
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

		// Phase 3 — Loading configuration. Emits the standard
		// "loading configuration…" line immediately before `loadConfig()`.
		bootLog("loading configuration…");
		const config = await loadConfig();

		// Phase 4 — Resolving authentication. Emits the standard
		// "resolving authentication…" line.
		bootLog("resolving authentication…");
		// Read auth from Brigade's `~/.brigade/agents/main/agent/auth-profiles.json`
		// (the file `brigade onboard` writes), NOT from Pi's vanilla
		// `${BRIGADE_DIR}/auth.json`. Without this bridge the gateway would
		// never see keys that onboarding produced.
		const authStorage = loadBrigadeAuthStorage() as AuthStorage;
		const modelRegistry = ModelRegistry.create(authStorage, `${BRIGADE_DIR}/models.json`);

		// F:\Brigade's brigade.json (post-2026-05-02 wizard refactor) stores
		// the default model under `agents.defaults.{provider, model.primary}`.
		// Earlier code expected the older flat `config.defaultProvider` /
		// `config.defaultModelId` fields, so we read the new shape here
		// and project to local string vars.
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

		// Phase 5 — Starting. Emits the standard "starting..." line right
		// before the runtime build.
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
	// Module-registered RPCs. Stored as the full `GatewayMethodHandler` (not just
	// the bare fn) so the dispatcher can read `scope` for caller-aware gating
	// before invoking, and pass the `caller` snapshot as the 2nd argument.
	let customMethods = new Map<string, GatewayMethodHandler>();
	// Module-registered HTTP routes. We carry the full `HttpRoute` (not just the
	// handler) so the request dispatcher can apply `auth` / `match` / `maxBodyBytes`
	// / `timeoutMs` per-route before delegating to the plugin's handler.
	let httpRoutes: HttpRoute[] = [];
	const startedServices: { id: string; service: Service }[] = [];
	let serviceAbort: AbortController | undefined;

	// Set true once handle.stop() begins, so background work (memory extraction
	// debounce) doesn't re-arm timers or run sweeps against a torn-down server.
	let serverStopped = false;

	// ── Background memory extraction (off the hot path) ──
	// After a turn settles we DEBOUNCE a batched sweep: during quiet time it
	// distills the NEW transcript turns into structured facts in ONE extra
	// model call, so the per-turn path stays at a single call. This is the
	// scalable shape (off-hot-path + batching) — see agents/memory/extract.ts.
	// Kill-switch:
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
			// Multi-agent visibility: surface the agent id + session key the
			// TUI is bound to so the operator sees `agent main · agent:main:main`
			// next to the model in the header. Multi-agent gateways with
			// per-binding routing show the gateway's BOOT agentId here; the
			// per-inbound routed agent (for channels) lives on each turn's
			// own dispatcher state, not on this gateway-level snapshot.
			agentId,
			sessionKey,
		};
	};

	/* ──────────────── transport ──────────────── */

	// Phase 6 — Starting HTTP server. Emits the standard
	// "starting HTTP server..." line.
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

	// Approval bridge — the seam between the per-turn exec-gate (which
	// runs in-process) and connected TUI clients (which render the
	// inline Y/A/P/N prompt). Set up before the agent loop spins so
	// any tool-approval prompt from the very first turn is bridged
	// through the WS instead of bouncing back to the legacy "ask the
	// operator out-of-band" refusal.
	const approvalBridge = new InMemoryApprovalBridge((request) => {
		broadcast("approval-request", {
			id: request.id,
			command: request.command,
			toolName: request.toolName,
			cwd: request.cwd,
			timeoutMs: request.timeoutMs,
			decisions: request.decisions,
			// Primitive #6: forward sub-agent attribution so the TUI prompt
			// surfaces "Sub-agent wants to run …" instead of the default
			// attribution. Top-level turns leave these undefined.
			...(request.subagentLabel !== undefined ? { subagentLabel: request.subagentLabel } : {}),
			...(request.subagentDepth !== undefined ? { subagentDepth: request.subagentDepth } : {}),
			...(request.parentRunId !== undefined ? { parentRunId: request.parentRunId } : {}),
		});
	});
	setActiveApprovalBridge(approvalBridge);

	/* ──────────────── cron service boot ──────────────── */

	// Construct the per-daemon cron service. Deps wire the timer's actual
	// agent-execution path (`runCronIsolatedAgentJob`) and event logging.
	// `enqueueSystemEvent` / `requestHeartbeatNow` / `sendCronFailureAlert`
	// stay undefined for now — the scheduler logs a warning and degrades
	// gracefully (no system-event injection, no failure-alert delivery)
	// until those subsystems land.
	const cronState = createCronServiceState({
		deps: {
			log: createSubsystemLogger("cron"),
			runIsolatedAgentJob: runCronIsolatedAgentJob,
			onEvent: (event) => {
				broadcast("log", {
					level: event.action === "finished" && event.status === "error" ? "warn" : "info",
					message: `cron: ${event.action} ${event.jobId}`,
					at: Date.now(),
				});
			},
			/**
			 * System-event injector — used by:
			 *   (a) crons with `sessionTarget: "main"` to drop a message into
			 *       the operator's session at fire time, and
			 *   (b) the announce-delivery fallback when a cron's `delivery.mode
			 *       === "announce"` has no explicit channel target — the
			 *       summary becomes a system event in the operator's main
			 *       session so they STILL see the reply somewhere.
			 *
			 * Broadcasts a `system-event` (NOT a `log`) so the connect-mode TUI
			 * renders it as a visible Brigade-side chat line, distinct from the
			 * scrolling debug-log panel. The TUI handler at `src/tui/chat.ts`
			 * subscribes to `system-event` and renders each one inline. Without
			 * this distinction the cron's announce would silently land in the
			 * log panel + the operator would never see their reminder fire.
			 */
			enqueueSystemEvent: (args) => {
				const at = Date.now();
				// TRACK 1 — live visibility. Broadcast the system-event WS frame
				// so any connected connect-mode TUI client renders the announce
				// IMMEDIATELY as a Brigade-side bubble (see
				// `cli/commands/connect.ts`). This is what makes the operator
				// see "🦁 [cron \"X\"] <reply>" the moment the cron fires
				// instead of waiting for their next prompt.
				broadcast("system-event", {
					text: args.text,
					at,
					source: "cron",
					...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
					...(args.jobName !== undefined ? { jobName: args.jobName } : {}),
				});
				// TRACK 2 — model awareness. ALSO queue the text per-session so
				// the NEXT agent turn for that session picks it up via
				// `drainPendingSystemEvents` and prepends a `<system_event>`
				// block to the user message. Without this the model would be
				// answering the operator's next "did the cron fire?" question
				// blind and might bullshit "any moment now" while the actual
				// fire happened minutes ago. The operator's main session is
				// the default target — a cron without a channel target is
				// announcing into "wherever the operator is", which on a
				// TUI / connect-mode setup is the main session.
				const targetSessionKey = args.sessionKey ?? defaultSessionKey(args.agentId ?? agentId);
				enqueuePendingSystemEvent(targetSessionKey, {
					text: args.text,
					queuedAtMs: at,
					...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
					...(args.jobName !== undefined ? { jobName: args.jobName } : {}),
				});
			},
			/**
			 * Announce-delivery dispatcher — when a cron job carries
			 * `delivery: {mode: "announce", channel, to}`, the timer hands
			 * the summary text here so we can fan it out to the channel
			 * adapter that originally took the operator's add-cron message
			 * (e.g. WhatsApp `sendText(to, text)`). Returns false when no
			 * channel manager is wired so the timer falls back to the
			 * system-event injector above.
			 */
			/**
			 * List the channel ids the operator can target in
			 * `delivery.channel` — used by `cron add`/`update` to fail-fast on
			 * a typo (e.g. "whatapp" instead of "whatsapp") rather than
			 * silently persisting a job that would error every fire. Returns
			 * `[]` when no channel manager has been wired yet (boot order /
			 * fresh install) so the validator falls through to "no list, no
			 * check" rather than blocking ALL cron adds.
			 */
			listKnownChannelIds: () => channelManager?.started ?? [],
			/**
			 * Heartbeat trigger for `wakeMode: "now"` crons. Fires a synthetic
			 * agent turn on the operator's main session that drains any
			 * pending system events (including the cron's own announce text)
			 * and produces a model reply — so the operator gets a "live"
			 * response when the cron fires even if they're not actively
			 * typing. Skipped when the main lane is busy (the in-flight
			 * turn will drain naturally) or when there's nothing queued.
			 */
			requestHeartbeatNow: (opts) => {
				// Multi-agent cron: when a job carries `opts.agentId` (set by
				// the cron service when the job was added with an explicit
				// agentId), route the heartbeat to THAT agent's session.
				// Falls back to the gateway's boot-default for un-tagged jobs
				// (legacy single-agent installs).
				const targetAgentId = opts?.agentId?.trim() || agentId;
				const targetSessionKey = opts?.sessionKey?.trim() || defaultSessionKey(targetAgentId);
				void runHeartbeatNow({
					agentId: targetAgentId,
					sessionKey: targetSessionKey,
					provider,
					modelId,
					thinkingLevel: thinkingLevel as "off" | "low" | "medium" | "high",
					...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
				}).catch(() => {
					/* runHeartbeatNow logs its own failures */
				});
			},
			deliverCronAnnounce: async (args) => {
				if (!channelManager || !args.channel || !args.to) return false;
				const adapter = channelManager.adapter(args.channel);
				if (!adapter) {
					createSubsystemLogger("cron").warn(
						"announce target channel not started",
						{ channel: args.channel, jobId: args.job.id },
					);
					return false;
				}
				// Pre-flight health check. A logged-out / disconnected adapter
				// is "started" (we called start() at boot) but its underlying
				// socket is dead and sendText will either silently drop or
				// throw an opaque error. Refuse here, log a clear warning,
				// AND queue a `system-event` so the operator's TUI / next
				// channel inbound sees "your reminder X failed because
				// WhatsApp is unlinked — here's how to re-pair". Without
				// this, scheduled reminders to a dead channel just vanish.
				if (typeof adapter.health === "function") {
					const status = adapter.health();
					if (!status.ok) {
						createSubsystemLogger("cron").warn(
							"announce target channel unhealthy — refusing delivery",
							{
								channel: args.channel,
								jobId: args.job.id,
								kind: status.kind,
								reason: status.reason,
							},
						);
						const failureText = [
							`🦁 Cron "${args.job.name}" couldn't deliver via ${args.channel} — ${status.reason}`,
							status.remediation ? `Fix: ${status.remediation}` : undefined,
						]
							.filter(Boolean)
							.join("\n");
						const at = Date.now();
						broadcast("system-event", {
							text: failureText,
							at,
							source: "cron",
							jobId: args.job.id,
							jobName: args.job.name,
						});
						enqueuePendingSystemEvent(defaultSessionKey(agentId), {
							text: failureText,
							queuedAtMs: at,
							jobId: args.job.id,
							jobName: args.job.name,
						});
						return false;
					}
				}
				try {
					await adapter.sendText(
						args.to,
						args.text,
						args.threadId ? { threadId: args.threadId } : undefined,
					);
					return true;
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					createSubsystemLogger("cron").warn("announce sendText threw", {
						channel: args.channel,
						to: args.to,
						jobId: args.job.id,
						error: errMsg,
					});
					// Surface the failure so the operator finds out IMMEDIATELY
					// instead of wondering why their reminder never arrived.
					const failureText = `🦁 Cron "${args.job.name}" couldn't deliver via ${args.channel}: ${errMsg}`;
					const at = Date.now();
					broadcast("system-event", {
						text: failureText,
						at,
						source: "cron",
						jobId: args.job.id,
						jobName: args.job.name,
					});
					enqueuePendingSystemEvent(defaultSessionKey(agentId), {
						text: failureText,
						queuedAtMs: at,
						jobId: args.job.id,
						jobName: args.job.name,
					});
					return false;
				}
			},
		},
	});
	setActiveCronService(cronState);
	// Fire-and-forget — cronStart loads cron.json, replays bounded missed
	// jobs with stagger, then arms the timer. A throw here would break
	// the gateway boot, so we swallow + log.
	void cronStart(cronState).catch((err) => {
		createSubsystemLogger("cron").error("cron service failed to start", {
			error: err instanceof Error ? err.message : String(err),
		});
	});

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

	// Sub-agent pi-event forwarder (Primitive #6). The gateway's
	// `attachTurnSession` only subscribes to the TOP-LEVEL Pi session — when
	// a sub-agent runs (via `subagent-runner` recursing into `runSingleTurn`),
	// no `onSessionReady` is wired for the inner session so its events would
	// never reach the WS otherwise. The agent-event-bus carries pi events
	// from EVERY run, tagged with `subagentDepth`, so we listen here for the
	// child events (`subagentDepth > 0`) and broadcast them with the depth
	// attached. We deliberately skip top-level events (depth === undefined ||
	// depth === 0) because `attachTurnSession` already broadcasts those —
	// forwarding both paths would duplicate every event.
	const detachSubagentPiBus = onAgentEvent((event) => {
		if (event.type !== "pi") return;
		if (!event.subagentDepth || event.subagentDepth <= 0) return;
		broadcast("pi", { event: event.piEvent, subagentDepth: event.subagentDepth });
	});

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
	// message — flows through the lane registry (`src/process/lanes.ts`):
	//
	//   - TUI / direct-RPC turns       → `CommandLane.Main`
	//   - Channel-routed inbounds      → `sessionLane(sessionKey)` so two
	//                                    different peers (WhatsApp A and B)
	//                                    run in parallel, never blocking each
	//                                    other on a single global chain.
	//
	// Within a lane, work is strictly FIFO — message 1 from a peer finishes
	// before message 2 starts. Across lanes, work is concurrent. This shape
	// matches OC's `enqueueCommandInLane` model and is what unblocks the
	// "two peers DM Brigade at the same time" case Brigade used to serialise.
	//
	// The per-turn singleton plumbing (`inFlightSession`, broadcast snapshot,
	// `currentTurnCleanup`) IS still single-writer — but that's enforced
	// by `runGatewayTurn`'s own try/finally + a state.isAgentRunning gate,
	// NOT by a global lock. Each lane's runs are serialised; per-lane state
	// observations (the snapshot) reflect the in-flight turn for that lane.
	let turnChainTail = Promise.resolve(); // kept ONLY for graceful-shutdown wait
	const runOnLane = <T>(lane: CommandLaneId, fn: () => Promise<T>): Promise<T> => {
		const run = enqueueInLane(lane, fn);
		turnChainTail = run.then(
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
	const runGatewayTurn = (turn: {
		text: string;
		sessionKey: string;
		/**
		 * Routed agent id for this turn (output of the 8-tier route resolver
		 * inside the channel manager). When omitted, falls back to the
		 * gateway's boot-time `agentId` — preserving single-agent behaviour
		 * for TUI / cron / direct-RPC paths. Multi-agent inbounds (e.g. a
		 * WhatsApp DM bound to `agent:ops` via `cfg.bindings.entries`) supply
		 * the resolved id here so the turn loads ops's workspace + model +
		 * persona instead of the default agent's.
		 */
		agentId?: string;
		signal?: AbortSignal;
		/**
		 * Channel-supplied owner flag. `true` for self-chat / TUI-equivalent
		 * traffic, `false` for approved peers. Drives the BOOTSTRAP-nudge
		 * gate in the agent loop — non-owners never see the operator-
		 * onboarding intro. Defaults to `true` (TUI / RPC / non-channel
		 * callers are always the operator).
		 */
		senderIsOwner?: boolean;
		/**
		 * Channel routing for exec-gate approval prompts. When set, a gated
		 * tool call inside this turn surfaces its prompt INTO the channel
		 * conversation (via the per-channel approval-router dispatcher)
		 * instead of (only) the gateway WS — so an operator on WhatsApp /
		 * Slack / Discord sees + answers the prompt where they're chatting.
		 * Always undefined for TUI / direct-RPC callers (they fall back to
		 * the legacy WS broadcast path the connect-mode TUI watches).
		 */
		channelApprovalRoute?: import("../agents/channels/approval-router.js").ChannelApprovalRoute;
	}): Promise<RunSingleTurnResult> => {
		// Pick the lane: channel-routed turns get their own per-session lane
		// (so multiple peers run concurrently); TUI / direct-RPC turns share
		// the single Main lane (a TUI user can only type one prompt at a time
		// anyway, and direct-RPC callers are the operator).
		const lane = turn.channelApprovalRoute
			? sessionLane(turn.sessionKey)
			: CommandLane.Main;
		return runOnLane(lane, async () => {
			isAgentRunning = true;
			broadcast("state", buildSnapshot());
			// Hoist the abort listener so the finally can detach it without a
			// scope issue (a `const` inside `try` is invisible from `finally`).
			const onAbort = () => {
				inFlightSession?.abort().catch(() => {});
			};
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

				// Per-agent dispatch: the channel manager hands us a routed
				// agentId via the 8-tier resolver; we honour it here so the
				// turn loads the right workspace + model + persona. Single-
				// agent gateways (TUI, cron, direct-RPC) leave `turn.agentId`
				// undefined and fall back to the boot-time default. When the
				// routed agent has a per-agent provider/model in
				// `cfg.agents.<id>`, those override the boot defaults so e.g.
				// `agent:ops` can run on a different model than `agent:main`.
				const targetAgentId = turn.agentId ?? agentId;
				const agentOverride = (() => {
					if (!targetAgentId || targetAgentId === agentId) return undefined;
					const map = cfgNow.agents as
						| { [id: string]: { provider?: string; model?: { primary?: string } } }
						| undefined;
					const entry = map?.[targetAgentId];
					if (!entry || typeof entry !== "object") return undefined;
					return {
						provider: typeof entry.provider === "string" ? entry.provider : undefined,
						modelId:
							typeof entry.model === "object" && entry.model && typeof entry.model.primary === "string"
								? entry.model.primary
								: undefined,
					};
				})();
				const turnProvider = agentOverride?.provider ?? provider;
				const turnModelId = agentOverride?.modelId ?? modelId;

				// If a channel inbound passed an AbortSignal, abort the in-flight Pi
				// session when it fires (so `/stop` from the chat actually cancels).
				turn.signal?.addEventListener("abort", onAbort, { once: true });
				const result = await runResilientTurn({
					agentId: targetAgentId,
					provider: turnProvider,
					modelId: turnModelId,
					message: turn.text,
					sessionKey: turn.sessionKey,
					thinkingLevel: thinkingLevel as "off" | "low" | "medium" | "high",
					fallbacks,
					signal: turn.signal,
					// Forward the channel's senderIsOwner verdict (defaults to true
					// when undefined — TUI / direct RPC calls are always operator).
					senderIsOwner: turn.senderIsOwner,
					// Forward the channel approval route (set ONLY for channel-
					// routed inbounds) so exec-gate surfaces approval prompts
					// in the originating chat instead of (only) the WS feed.
					...(turn.channelApprovalRoute !== undefined
						? { channelApprovalRoute: turn.channelApprovalRoute }
						: {}),
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
				turn.signal?.removeEventListener("abort", onAbort);
				if (currentTurnCleanup) {
					currentTurnCleanup();
					currentTurnCleanup = null;
				}
				inFlightSession = null;
				isAgentRunning = false;
				broadcast("state", buildSnapshot());
			}
		});
	};

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
		caller: GatewayCaller,
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
			case "approval-resolve": {
				const p = params as RequestParams["approval-resolve"];
				if (!p?.id) throw new Error("approval-resolve: missing id");
				const resolved = approvalBridge.resolveApproval(p.id, {
					kind: p.decision,
					pattern: p.pattern,
				});
				if (!resolved) {
					// Two common causes: stale id (operator clicked twice) or
					// already-timed-out request. Either way it's not an error
					// the operator needs to see — the result is the same: the
					// next call will surface a fresh prompt if still needed.
					return undefined as ResponseFor[M];
				}
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
				if (custom) {
					// Per-method scope gate. When a module declares
					// `scope: "operator.admin"` we refuse callers that don't
					// carry that scope. The default (no scope) means
					// "anyone authenticated" — same as today's WS surface.
					// We surface the failure as a typed RPC error so a
					// client can distinguish auth from internal errors.
					if (custom.scope && !caller.scopes.includes(custom.scope)) {
						const err = new Error(`scope insufficient: method "${method}" requires "${custom.scope}"`);
						(err as Error & { code?: string }).code = "scope-insufficient";
						throw err;
					}
					return (await custom.handler(rawParams, caller)) as ResponseFor[M];
				}
				throw new Error(`unknown method: ${method}`);
			}
		}
	};

	// Self-reference so the shutdown RPC can call our own stop() without a
	// circular declaration. Filled in just before we return the handle.
	const handleSelfRef: { value: ServerHandle | undefined } = { value: undefined };

	/* ──────────────── connection lifecycle ──────────────── */

	// Per-connection rate limit: a sliding window of RPC timestamps. Anyone who
	// can reach the WS (localhost-only today) can fire requests as fast as the
	// dispatcher accepts them — a misbehaving client (or stolen creds, once
	// multi-user lands) could flood `system.reload` / `list-models` / `prompt`
	// rejections and pin the gateway. Defaults are generous: 60 RPCs/10s per
	// connection ⇒ ~6 QPS sustained, plenty for a human-driven TUI.
	const RATE_LIMIT_WINDOW_MS = 10_000;
	const RATE_LIMIT_MAX = 60;

	wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
		clients.add(ws);
		const clientLabel = `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
		opts.consoleStream?.clientConnected(clientLabel, clients.size);

		// Caller-identity snapshot threaded into every RPC dispatch on this
		// connection. Today the gateway is localhost-only (LOCALHOST_BINDS
		// guard above) so every connected client is the operator and gets the
		// full scope set; we encode that here. Phase 2 multi-user lands real
		// per-connection auth (HTTP-session) — at that point this builder
		// reads the connection's auth state and may produce a narrower
		// scope set (e.g. `["operator.read"]` for a sub-account). The
		// per-method `scope` gate in `handleRequest`'s default branch is
		// already enforced regardless, so plugins that declare a scope
		// today won't need a code change when multi-user lands.
		const caller: GatewayCaller = { id: "local", scopes: ["operator.admin", "operator.write", "operator.read"] };

		// Send the initial snapshot so the client can render its header
		// before any user action.
		ws.send(JSON.stringify({ type: "event", event: "state", payload: buildSnapshot() } satisfies Frame));

		// Per-connection ring of RPC timestamps powering the sliding-window check.
		const rateRing: number[] = [];

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

			// Sliding-window rate limit: drop oldest timestamps outside the window,
			// reject if we're already at the cap. We respond with a typed error
			// frame so well-behaved clients can back off; a flooding client just
			// keeps getting `rate-limited` until they slow down.
			const now = Date.now();
			while (rateRing.length > 0 && now - (rateRing[0] as number) > RATE_LIMIT_WINDOW_MS) rateRing.shift();
			if (rateRing.length >= RATE_LIMIT_MAX) {
				const response: Frame = {
					type: "res",
					id: reqFrame.id,
					ok: false,
					error: {
						code: "rate-limited",
						message: `WS connection exceeded ${RATE_LIMIT_MAX} requests / ${RATE_LIMIT_WINDOW_MS}ms — slow down.`,
					},
				};
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
				return;
			}
			rateRing.push(now);
			opts.consoleStream?.wsRequest(reqFrame.method, reqFrame.id, clientLabel);
			const startedAt = Date.now();
			try {
				const payload = await handleRequest(reqFrame.method, reqFrame.params, caller);
				const response: Frame = {
					type: "res",
					id: reqFrame.id,
					ok: true,
					payload,
				};
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
				opts.consoleStream?.wsResponse(reqFrame.method, reqFrame.id, true, Date.now() - startedAt);
			} catch (err) {
				// Honour a typed error code if the handler set one (e.g. the
				// `scope-insufficient` thrown by the default-branch scope gate)
				// so the client sees an auth-shaped failure instead of a
				// generic "internal" bucket.
				const code = (err as { code?: string } | undefined)?.code ?? "internal";
				const response: Frame = {
					type: "res",
					id: reqFrame.id,
					ok: false,
					error: {
						code,
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

	/* ──────────────── multi-routing spine wiring (Step 1-27) ──────────────── */

	// Install the in-process gateway caller. Every `callGateway(...)` from
	// a tool (sessions_send, sessions_spawn, sessions_history, sessions_list)
	// resolves to a local handler via the registry below. WebSocket clients
	// also dispatch through the same registry once the connection handler
	// routes their request frame here (in `handleRequest`).
	const disposeGatewayCaller = installInProcessGatewayCaller();

	// Register the five sessions handlers + health. Bound `agentId` is the
	// boot-time default; the dispatcher's per-turn route resolver overrides
	// this for channel-routed inbounds. `runAgentTurn` adapter calls the
	// already-defined `runGatewayTurn` so each method dispatches through the
	// existing serialized turn queue.
	const disposeHandlers: Array<() => void> = [];
	disposeHandlers.push(
		registerGatewayHandler("health", (params: unknown) =>
			handleHealthMethod(params as { probe?: boolean } | undefined, {
				getBrigadeVersion: () => getBuildInfo().head ?? "dev",
			}),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.list", (params: unknown) =>
			handleSessionsList(
				params as Parameters<typeof handleSessionsList>[0],
				{},
			),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.history", (params: unknown) =>
			handleSessionsHistory(
				params as Parameters<typeof handleSessionsHistory>[0],
				// `readMessages` reads from Pi's transcript JSONL. Brigade's
				// existing transcript reader is exposed via Pi's SessionManager
				// in the agent-loop layer — for this milestone we return an
				// empty array so the tool resolves without throwing. Step 27+
				// will wire the actual JSONL reader.
				{ readMessages: async () => [] },
			),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.send", (params: unknown) =>
			handleSessionsSend(
				params as Parameters<typeof handleSessionsSend>[0],
				{
					// Adapt the existing per-turn dispatcher to the
					// `DispatchAgentRunDeps.runAgentTurn` shape so a tool's
					// `sessions.send` call lands on the same path a channel
					// inbound would.
					runAgentTurn: async (turn) => {
						try {
							await runGatewayTurn({
								text: turn.message,
								sessionKey: turn.sessionKey,
							});
							return { ok: true };
						} catch (err) {
							return {
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							};
						}
					},
				},
			),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.spawn", (params: unknown) =>
			handleSessionsSpawn(params as Parameters<typeof handleSessionsSpawn>[0], {}),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.patch", (params: unknown) =>
			handleSessionsPatch(params as Parameters<typeof handleSessionsPatch>[0]),
		),
	);

	// Wire the agent-events bridge. Subagent-ended hooks (Step 10) +
	// heartbeat-fired hooks (Step 14) + session-state listeners (Step 11)
	// all now flow into the unified `agent-events.ts` bus where Step 25's
	// event-stream broadcaster can fan out to WebSocket subscribers.
	const disposeAgentEventsBridge = wireAgentEventsBridge();

	// Enable heartbeats globally (read from env override if set; tests can
	// disable via BRIGADE_DISABLE_HEARTBEAT=1).
	setHeartbeatsEnabled(process.env.BRIGADE_DISABLE_HEARTBEAT !== "1");

	// Install the heartbeat-fired hook BEFORE starting the runner so the
	// runner can dispatch a synthetic turn the first time it fires. The
	// hook formats the consumed events as the user message and routes
	// through `runGatewayTurn` (same path as a channel inbound).
	setHeartbeatFiredHook(async (params) => {
		if (!params.consumedEvents.length && params.reason !== "interval") return;
		const text =
			params.consumedEvents.length > 0
				? params.consumedEvents.map((e) => e.text).join("\n")
				: "Heartbeat tick.";
		try {
			await runGatewayTurn({
				text,
				sessionKey: params.sessionKey,
				agentId: params.agentId,
				senderIsOwner: true,
			});
		} catch {
			// Heartbeat turns are best-effort; failures already log via the runner.
		}
	});

	// Start the heartbeat runner. Returns a handle whose `.stop()` is
	// called in `handle.stop()` below to unregister the wake handler.
	let heartbeatRunnerHandle: HeartbeatRunnerHandle | undefined;
	try {
		heartbeatRunnerHandle = startHeartbeatRunner();
	} catch (err) {
		bootLog(
			`heartbeat runner failed to start: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Wall-clock heartbeat scheduler. Reads per-agent `heartbeat.intervalMs`
	// from `cfg.agents.<id>.heartbeat` (with `cfg.agents.defaults.heartbeat`
	// as fallback) and fires `requestHeartbeatNow({reason: "interval",
	// agentId})` on each agent's configured cadence. Pre-wires the on-
	// interval callback to the wake layer Brigade already has.
	let heartbeatScheduler: HeartbeatScheduler | undefined;
	try {
		heartbeatScheduler = createHeartbeatScheduler({
			onInterval: ({ agentId: scheduledAgentId, sessionKey: scheduledSessionKey }) => {
				try {
					requestHeartbeatNow({
						reason: "interval",
						agentId: scheduledAgentId,
						...(scheduledSessionKey ? { sessionKey: scheduledSessionKey } : {}),
					});
				} catch {
					// best-effort tick fire
				}
			},
		});
		const bootCfg = await loadConfig();
		heartbeatScheduler.updateConfig(bootCfg as never);
		heartbeatScheduler.start();
	} catch (err) {
		bootLog(
			`heartbeat scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Multi-agent boot: iterate `cfg.agents.*` and pre-warm each agent's
	// workspace directory. Lazy bootstrap still happens on the first turn
	// (via agent-loop's `bootstrapWorkspace`) but ensuring the dir exists
	// here prevents the first inbound for `agent:ops` from racing against
	// a missing `~/.brigade/agents/ops/workspace/` parent.
	try {
		const bootCfg = await loadConfig();
		const agentsBlock = (bootCfg as { agents?: Record<string, unknown> }).agents;
		if (agentsBlock && typeof agentsBlock === "object") {
			for (const id of Object.keys(agentsBlock)) {
				if (id === "defaults") continue;
				if (!id.trim()) continue;
				try {
					ensureDir(resolveAgentDir(id.trim()));
					ensureDir(resolveAgentWorkspaceDir(id.trim()));
				} catch {
					// per-agent dir creation is best-effort; the first turn for
					// the agent will create what's still missing.
				}
			}
		}
	} catch {
		// non-fatal — single-agent gateways have no `cfg.agents.*` entries
	}

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

	// Phase 7 — agent model resolved. Emits the standard
	// `agent model: <provider>/<model>` line.
	bootLog(`agent model: ${provider}/${modelId}`);

	// Phase 8 — Listening on bound port. Emits the standard
	// `listening on ws://${host}:${port}` verbose-banner line.
	bootLog(`listening on ws://${host}:${port}`);

	// Phase 9 — ready marker with timing. Brigade has zero plugins in v1,
	// so the body is timing-only — `ready (Xs)`.
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

	// Phase 10 — log-file pointer. Emits the standard
	// `log file: <path>` line.
	bootLog(`log file: ${getTodayLogPath()}`);

	// HTTP request handler for module-registered routes. Attached once; it reads
	// the live `httpRoutes` list, so a reload swaps routes without re-binding.
	// WS upgrades use the separate 'upgrade' event and are unaffected.
	//
	// Per-route guards applied BEFORE the handler runs:
	//   - `match`: "exact" (default) | "prefix" — prefix lets one route own a
	//     sub-tree (e.g. `/webhooks/stripe` also matches `/webhooks/stripe/foo`)
	//     so multi-event webhooks don't need 50 separate registrations.
	//   - `auth`: "none" (default) | "operator" — operator routes are gated on
	//     the same operator-auth used for WS clients. Today the WS surface is
	//     localhost-only and unauthenticated; we treat every loopback request
	//     as the operator and refuse non-loopback (matches the WS bind
	//     policy). Plugin handlers that opt into "none" MUST verify
	//     signatures themselves (use `webhook-guards.safeEqualHmac`).
	//   - `maxBodyBytes`: cap (default 1 MiB). The body is pre-buffered to
	//     this limit; oversize requests get a clean 413 BEFORE the handler
	//     sees them, and the handler reads the buffer off `req.body`.
	//   - `timeoutMs`: total handler budget (default 30s). The dispatcher
	//     races the handler against a timer; on expiry it responds 408.
	httpServer.on("request", (req, res) => {
		void (async () => {
			try {
				const reqPath = (req.url ?? "").split("?")[0] ?? "";
				const route = httpRoutes.find((r) => {
					if (r.method && r.method !== req.method) return false;
					const match = r.match ?? "exact";
					if (match === "prefix") {
						// Prefix match owns the path AND everything under a "/"
						// boundary so `/foo` doesn't accidentally match `/foobar`.
						return reqPath === r.path || reqPath.startsWith(r.path.endsWith("/") ? r.path : `${r.path}/`);
					}
					return reqPath === r.path;
				});
				if (!route) {
					res.statusCode = 404;
					res.end("Not found");
					return;
				}

				// Operator auth gate. Localhost-only today (LOCALHOST_BINDS),
				// so every accepted connection is the operator. We still
				// refuse anything that doesn't look loopback in case the bind
				// guard is relaxed mid-process (defensive — the bind guard
				// itself is the primary line). Phase 2 multi-user replaces
				// this with the real HTTP-session check.
				if (route.auth === "operator") {
					const remote = req.socket.remoteAddress ?? "";
					const isLoopback =
						remote === "127.0.0.1" ||
						remote === "::1" ||
						remote === "::ffff:127.0.0.1" ||
						remote === "localhost";
					if (!isLoopback) {
						opts.consoleStream?.info?.(
							`http route ${route.path}: refused non-loopback caller ${remote} (auth: operator)`,
						);
						res.statusCode = 401;
						res.setHeader("Content-Type", "application/json; charset=utf-8");
						res.end(JSON.stringify({ error: "Unauthorized" }));
						return;
					}
				}

				// Pre-buffer the body to the route's cap. Methods that don't
				// carry a body (GET/HEAD) skip the read — calling
				// `readBodyWithLimit` on them works (it resolves to an empty
				// Buffer) but it's a tiny perf win to skip.
				const method = (req.method ?? "GET").toUpperCase();
				const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
				if (hasBody) {
					const body = await readBodyWithLimit(req, res, {
						maxBytes: route.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
						timeoutMs: route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					});
					if (body === null) return; // 413 / 408 / 400 already written
					// Attach as a non-stream property the handler can read.
					// We deliberately don't replace the IncomingMessage stream
					// — its events have already fired — so the buffer lives
					// on a side channel the plugin reads from.
					(req as IncomingMessage & { body?: Buffer }).body = body;
				}

				// Total handler budget. We race the handler against a timer
				// so a hung plugin can't pin the connection forever. The
				// timer is set even when we already burned some of the
				// budget on body-reading — that's intentional, the cap is
				// the route's wall-clock budget end to end.
				const timeoutMs = route.timeoutMs ?? DEFAULT_TIMEOUT_MS;
				let timeoutHandle: NodeJS.Timeout | undefined;
				const timeoutPromise = new Promise<"__timeout__">((resolve) => {
					timeoutHandle = setTimeout(() => resolve("__timeout__"), timeoutMs);
					if (typeof (timeoutHandle as { unref?: () => void }).unref === "function") {
						(timeoutHandle as { unref: () => void }).unref();
					}
				});
				const result = await Promise.race([
					Promise.resolve(route.handler(req, res)).then(() => "__done__" as const),
					timeoutPromise,
				]);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (result === "__timeout__" && !res.headersSent) {
					res.statusCode = 408;
					res.setHeader("Content-Type", "application/json; charset=utf-8");
					res.end(JSON.stringify({ error: `Request timeout (${timeoutMs}ms)` }));
				}
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
			// Drop the process-wide singleton so the `send_message` tool
			// hides itself again and a future restart starts clean.
			setActiveChannelManager(null);
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
		// Build the live method map. Module-registered RPCs are stored as the
		// full `GatewayMethodHandler` so the dispatcher can read `scope` for
		// caller-aware gating; the two built-ins are wrapped to the same shape.
		const methods = new Map<string, GatewayMethodHandler>(
			registry.gatewayMethods.filter((m) => !m.name.startsWith("system.")).map((m) => [m.name, m] as const),
		);
		// Built-in RPCs. `system.capabilities` is read-equivalent; `system.reload`
		// is admin (it mutates the gateway's loaded modules + restarts every
		// channel/service). Today the localhost-only caller carries all scopes
		// so this is academic, but the gate WILL be enforced once multi-user
		// lands without any further code change here.
		methods.set("system.capabilities", {
			name: "system.capabilities",
			scope: "operator.read",
			handler: () => ({
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
			}),
		});
		methods.set("system.reload", {
			name: "system.reload",
			scope: "operator.admin",
			handler: () =>
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
		});
		customMethods = methods;

		// HTTP routes — swap in the live list the request handler reads. We carry
		// the full `HttpRoute` (auth / match / maxBodyBytes / timeoutMs) so the
		// request dispatcher can apply each route's guards before delegating.
		httpRoutes = [...registry.httpRoutes];

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
			// Mount the channel manager as a process-wide singleton so the
			// `send_message` agent tool (+ future channel-action tools) can
			// reach the started adapters. Without this the tool registry's
			// `getActiveChannelManager()` returns null and `send_message`
			// quietly stays out of the surface.
			setActiveChannelManager(channelManager);
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
			// Signal the lane engine to reject new enqueues. Channel inbounds
			// that arrive during shutdown get a clean `GatewayDrainingError`
			// instead of being silently queued against a tearing-down server.
			try {
				markGatewayDraining();
			} catch {
				/* best-effort */
			}
			// Stop the heartbeat runner first so its wake handler unregisters
			// before the rest of the wires unwire — prevents a late wake
			// from firing through a half-torn-down dispatcher.
			try {
				heartbeatRunnerHandle?.stop();
			} catch {
				/* best-effort */
			}
			try {
				heartbeatScheduler?.stop();
			} catch {
				/* best-effort */
			}
			// Dispose the agent-events bridge + every registered handler +
			// the in-process gateway caller. Order: bridge → handlers →
			// caller so a late `callGateway()` after shutdown gets a clean
			// "dispatcher not registered" error rather than racing into a
			// half-disposed bridge.
			try {
				disposeAgentEventsBridge();
			} catch {
				/* best-effort */
			}
			for (const dispose of disposeHandlers) {
				try {
					dispose();
				} catch {
					/* best-effort */
				}
			}
			disposeHandlers.length = 0;
			try {
				disposeGatewayCaller();
			} catch {
				/* best-effort */
			}
			clearInterval(tickTimer);
			if (extractTimer) clearTimeout(extractTimer);
			pendingExtracts.clear();
			// Detach the approval bridge so a late-arriving exec-gate call
			// after stop() doesn't broadcast to dead clients.
			setActiveApprovalBridge(null);
			// Disarm the cron timer + detach the active-service singleton so
			// the agent tool can no longer mutate state and the next CLI
			// invocation gets a clean "not initialised" error rather than a
			// half-torn-down state.
			try {
				cronStop(cronState);
			} catch {
				/* best-effort; service may already be down */
			}
			setActiveCronService(null);
			// Stop all product capabilities (channels + services) first so no new
			// inbound turn is enqueued during teardown. Routed through the lifecycle
			// queue so it can't race an in-flight `system.reload`.
			await queueExtensionsOp(stopExtensions).catch(() => {});
			// Best-effort abort of a turn that's still streaming, then WAIT for the
			// turn queue to drain so an in-flight (or just-queued) turn's finally —
			// cleanup, broadcast, scheduleExtraction — can't run against a
			// torn-down server after stop() returns.
			if (inFlightSession) await inFlightSession.abort().catch(() => {});
			// Serialize the per-lane drain. `markGatewayDraining()` above
			// already rejected new enqueues; this waits up to 10s for the
			// in-flight tasks in every lane to settle.
			try {
				await waitForActiveTasks(10_000);
			} catch {
				/* best-effort drain */
			}
			await turnChainTail.catch(() => {});
			// Tear down any in-flight turn's Pi subscription + JSONL logger.
			// Between turns there's nothing attached, so this is a no-op then.
			if (currentTurnCleanup) {
				currentTurnCleanup();
				currentTurnCleanup = null;
			}
			detachLifecycleBus();
			detachSubagentPiBus();
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
