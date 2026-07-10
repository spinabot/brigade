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

import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AuthStorage,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type ServerOptions as WsServerOptions, type WebSocket } from "ws";

import {
	type AgentSummary,
	DEFAULT_PORT,
	EVENT_NAMES,
	type EventName,
	type EventPayload,
	type Frame,
	isFrame,
	modelToSummary,
	REQUEST_METHODS,
	type RequestFrame,
	type RequestMethod,
	type RequestParams,
	type ResponseFor,
	type SessionStateSnapshot,
	TICK_INTERVAL_MS,
	type WireMessage,
} from "../protocol.js";
import { type HelloOk, PROTOCOL_VERSION } from "../protocol/handshake.js";
import { nextSeq } from "../protocol/stream-seq.js";
// Per-turn execution path (the single canonical runtime). The gateway no
// longer holds a long-lived Pi session: every inbound `prompt` builds a
// fresh session via `runResilientTurn`, resumes the JSONL transcript by
// sessionKey, runs the full Brigade safety stack, and drops the session
// when the turn settles. Each turn builds and tears down its own session
// — no session lives between turns. The in-flight
// session is surfaced for the turn's lifetime via `onSessionReady` so the
// gateway can steer / abort / switch-model mid-stream.
import { applyAutoEnableA2AAtBoot } from "../agents/a2a-policy-canonicalize.js";
import { flattenAssistantContent, runResilientTurn, type RunSingleTurnResult } from "../agents/agent-loop.js";
import { BrigadeExtensionRegistry, BUNDLED_MODULES, clearDiscoveryCache, loadModules } from "../agents/extensions/index.js";
import { setActiveRegistry } from "../agents/extensions/active-registry.js";
import type { GatewayCaller, GatewayMethodHandler, HttpRoute, Service } from "../agents/extensions/index.js";
import { createMcpHttpRoute } from "../agents/mcp/http-route.js";
import { createMcpTurnRegistry, setActiveMcpToolPlaneHost } from "../agents/mcp/tool-plane-host.js";
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS, readBodyWithLimit } from "./webhook-guards.js";
import { extractFrameTags, shouldDeliverFrame } from "./ws-subscription-filter.js";
import { setActiveChannelManager } from "../agents/channels/active-manager.js";
import { sanitizeReplyForChannel } from "../agents/channels/reply-sanitizer.js";
import { type ChannelManager, startChannels } from "../agents/channels/manager.js";
import {
	createChannelPluginManager,
	type ChannelPluginManager,
} from "../agents/channels/channel-plugin-manager.js";
import { listWhatsAppAccountIds, whatsappChannelEnabled } from "../agents/channels/whatsapp/account-config.js";
import { createWhatsAppPlugin, type WhatsAppPluginHandle } from "../agents/channels/whatsapp/plugin.js";
import {
	listTelegramAccountIds,
	telegramChannelEnabled,
	telegramThreadIdleTtlMs,
} from "../agents/channels/telegram/account-config.js";
import { createTelegramPlugin, type TelegramPluginHandle } from "../agents/channels/telegram/plugin.js";
import {
	listSlackAccountIds,
	slackChannelEnabled,
	slackThreadIdleTtlMs,
} from "../agents/channels/slack/account-config.js";
import { createSlackPlugin, type SlackPluginHandle } from "../agents/channels/slack/plugin.js";
import {
	listDiscordAccountIds,
	discordChannelEnabled,
	discordThreadIdleTtlMs,
} from "../agents/channels/discord/account-config.js";
import { createDiscordPlugin, type DiscordPluginHandle } from "../agents/channels/discord/plugin.js";
import {
	listIMessageAccountIds,
	imessageChannelEnabled,
	imessageThreadIdleTtlMs,
} from "../agents/channels/imessage/account-config.js";
import { createIMessagePlugin, type IMessagePluginHandle } from "../agents/channels/imessage/plugin.js";
import {
	listBlueBubblesAccountIds,
	bluebubblesChannelEnabled,
	bluebubblesThreadIdleTtlMs,
} from "../agents/channels/bluebubbles/account-config.js";
import { createBlueBubblesPlugin, type BlueBubblesPluginHandle } from "../agents/channels/bluebubbles/plugin.js";
import { createPluginChannelManagerFacade } from "../agents/channels/plugin-channel-manager-facade.js";
import type { ChannelPlugin } from "../agents/channels/types.plugin.js";
import {
	clearChannelMessagingRegistry,
	syncChannelMessagingAdaptersFromPlugins,
} from "../agents/channels/channel-messaging-registry.js";
import {
	clearChannelSecurityRegistry,
	syncChannelSecurityAdaptersFromPlugins,
} from "../agents/channels/channel-security-registry.js";
import { clearChannelMetaRegistry, registerChannelMeta } from "../agents/channels/channel-meta-registry.js";
import type { GroupToolPolicyConfig } from "../agents/channels/access-control/index.js";
import { makeOpQueue, withTimeout } from "./extension-lifecycle.js";
import { resolveModelNeverMiss } from "../agents/model-resolution.js";
import { isClaudeCliAvailable } from "../agents/claude-cli/availability.js";
import { listClaudeCliModels, listClaudeCliModelsLive } from "../agents/claude-cli/register.js";
import {
	getCachedSubscriptionModels,
	listOpenRouterModels,
	prefetchSubscriptionModels,
} from "../integrations/provider-discovery.js";
import { onAgentEvent } from "../agents/agent-event-bus.js";
import {
	InMemoryApprovalBridge,
	setActiveApprovalBridge,
} from "../agents/approval-bridge.js";
import { getActiveCronService, setActiveCronService } from "../cron/active-service.js";
import { runCronIsolatedAgentJob } from "../cron/isolated-agent/run.js";
import { createCronServiceState } from "../cron/service/state.js";
import { start as cronStart, stop as cronStop } from "../cron/service/ops.js";
import { bootRuntimeContext, enableConfigLiveRefresh } from "../storage/boot.js";
import { onConfigCachePrimed } from "../storage/config-cache.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { checkForUpdate } from "./update-check.js";
import {
	DEFAULT_AGENT_ID,
	resolveAgentDir,
	resolveAgentWorkspaceDir,
	resolveConfigPath,
	resolveModelsPath,
} from "../config/paths.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { BrigadeConfig } from "../config/types.js";
import {
	abortAllSessions,
	countActiveLiveSessions,
	countActiveLiveSessionsForAgent,
	registerLiveSession,
	unregisterLiveSession,
} from "../agents/session-registry.js";
import crypto from "node:crypto";
import { enqueuePendingSystemEvent } from "../agents/pending-system-events.js";
import {
	enqueueSystemEvent as enqueueSessionInboxEvent,
	resolveSystemEventDeliveryContext,
} from "../agents/session-inbox.js";
// Multi-routing wiring (Step 1-27 lift): in-process gateway-call dispatcher,
// per-method handlers (sessions.*, health), agent-events bridge, heartbeat
// runner + wake flag, lane drain helpers. All exported but never called
// pre-wiring; the boot path below installs them once.
import {
	createInProcessGatewayCaller,
	installInProcessGatewayCaller,
	registerGatewayHandler,
} from "./gateway-caller-impl.js";
import { dispatchAgentRun } from "./agent-dispatcher.js";
import {
	handleCronAdd,
	handleCronList,
	handleCronRemove,
	handleCronRun,
	handleCronRuns,
	handleCronStatus,
	handleCronUpdate,
	handleWake,
	type CronHandlerContext,
} from "./server-methods/cron.js";
import { handleHealthMethod } from "./server-methods/health.js";
import { handleOrgSnapshot } from "./server-methods/org.js";
import { buildSkillStatusReport } from "../agents/skills/status.js";
import { installSkill } from "../agents/skills/install.js";
import type { SkillInstallSpec } from "../agents/skills/install-spec.js";
import { applySkillUpdate } from "../agents/skills/update-config.js";
import {
	handleSessionsHistory,
	handleSessionsList,
	handleSessionsPatch,
	handleSessionsSend,
	handleSessionsSpawn,
	type SessionsHandlerAccessCheck,
} from "./server-methods/sessions.js";
import {
	checkSessionToolAccess,
	createAgentToAgentPolicy,
	type SessionToolsVisibility,
} from "../agents/tools/sessions/shared.js";
import { wireAgentEventsBridge } from "../agents/agent-events.js";
import { requestHeartbeatNow, setHeartbeatsEnabled } from "../agents/heartbeat-wake.js";
import { setExecAllowAll } from "../agents/exec-session-allow.js";
import { grantSkill, revokeSkill } from "../agents/skills/grant.js";
import {
	addHeartbeatFiredHook,
	setHeartbeatBootAgentId,
	startHeartbeatRunner,
	type HeartbeatRunnerHandle,
} from "../agents/heartbeat-runner.js";
import {
	createHeartbeatScheduler,
	type HeartbeatScheduler,
} from "../agents/heartbeat-scheduler.js";
import { markGatewayDraining, resetAllLanes, waitForActiveTasks } from "../process/lanes.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import {
	detectDmScopeCollapseRisk,
	formatDmScopeWarning,
} from "../agents/routing/dm-scope-warning.js";
import { ensureDir } from "../config/paths.js";
import {
	CommandLane,
	type CommandLaneId,
	enqueueInLane,
	getLaneQueueSize,
	sessionLane,
} from "../process/lanes.js";
import { defaultSessionKey, readSessionStore } from "../sessions/session-store.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { resolveSessionTranscriptPath } from "../config/paths.js";
import {
	flattenConversation,
	makeExtractionLlm,
	makeIsolatedLlm,
	runExtractionSweep,
	setPreCompactionExtractionHook,
} from "../agents/memory/extract.js";
import { RELINK_PROMPT, setRelinkLlmFactory } from "../agents/memory/relationship-extract.js";
import { makeSkillReviewer, runSkillReview, shouldReviewSkills } from "../agents/skills/skill-review.js";
import { detectAndRecordSkillUses, runSkillCurator } from "../agents/skills/skill-curator.js";
import { makeSkillConsolidationLlm, runSkillConsolidation } from "../agents/skills/skill-consolidate.js";
import { getDefaultEmbedder, setDefaultEmbedder } from "../agents/memory/embedder.js";
import { resolveEmbedder } from "../agents/memory/embedder-providers.js";
import { reembedPending } from "../agents/memory/reembed.js";
import { makeBehaviorReviewer, runBehaviorReview, shouldReviewBehavior } from "../agents/memory/behavior-review.js";
import { resolveAutoRecallOrigin } from "../agents/memory/auto-recall.js";
import { runCurator } from "../agents/memory/curator.js";
import { runDecayGc } from "../agents/memory/decay.js";
import { runMemoryMaintenance } from "../agents/memory/maintenance.js";
import { exportMemoryGraph } from "../agents/memory/graph-export.js";
import { queryMemory } from "../agents/memory/query.js";
import { FactStore, type MemoryRecordOrigin, type MemorySourceType } from "../agents/memory/records.js";
import {
	makeConsolidationLlm,
	markConsolidationRun,
	runConsolidation,
	shouldRunConsolidation,
} from "../agents/memory/consolidate.js";
import { loadBrigadeAuthStorage } from "./auth-bridge.js";
import { validateApiKeyOnline } from "../providers/validate-key.js";
import { upsertApiKeyProfile } from "../auth/profiles.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, loadConfig, saveConfig, type Config } from "./config.js";
import { mutateConfigAtomic } from "../config/io.js";
import { acquireGatewayLock, type GatewayLockHandle } from "./gateway-lock.js";
import { clearHeartbeatFile, clearPidFile, writeHeartbeatFile, writePidFile } from "./gateway-probe.js";
import { extractToken, matchesAnyToken, resolveGatewayAuth } from "./gateway-auth.js";
import {
	handleConfigGet,
	handleConfigList,
	handleConfigSchema,
	handleConfigSet,
	handleConfigUnset,
	handleConfigValidate,
} from "./config-ops.js";
import {
	handleExecAllow,
	handleExecAllowPattern,
	handleExecDenyTest,
	handleExecList,
	handleExecRemove,
} from "./exec-ops.js";
import { handleAgentsBind, handleAgentsBindings, handleAgentsUnbind } from "./agents-ops.js";
import { handlePairingApprove, handlePairingList, handlePairingRevoke } from "./pairing-ops.js";
import { handleSessionsCleanup } from "./sessions-ops.js";
import { handleMemoryManage, handleMemoryWrite } from "./memory-ops.js";
import { handleAgentsAdd, handleAgentsDelete, handleAgentsSetIdentity } from "./agents-crud-ops.js";
import { handleSkillsCreate, handleSkillsDelete, handleSkillsWriteFile } from "./skills-ops.js";
import {
	handleChannelsAllowAdd,
	handleChannelsAllowList,
	handleChannelsAllowRemove,
	handleChannelsConnect,
	handleChannelsDisconnect,
} from "./channels-ops.js";
import { handleProviderRemove } from "./provider-ops.js";
import { handleComposio, handleOauth } from "./integrations-ops.js";

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
import { pickInitialThinkingLevel, readPersistedThinkingLevel, remapThinkingLevel } from "./model-caps.js";
import { Carrow } from "../agents/carrow.js";
import { getBuildInfo } from "../version.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { extractIdentityName, isIdentityNameUnset } from "./system-prompt.js";
import { existsSync, readFileSync, watch as fsWatch } from "node:fs";
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
const LOCALHOST_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLocalhostBind(host: string): boolean {
	return LOCALHOST_BINDS.has(host) || host === "::ffff:127.0.0.1";
}

/**
 * O0 H1 — sessions.history JSONL reader.
 *
 * Resolves the agent id from a canonical session key (`agent:<id>:<rest>`),
 * looks up the persisted session id via the per-agent session-store, then
 * reads the JSONL transcript line-by-line and projects `type:"message"`
 * entries down to their inner `message` field. Last-N truncation honours
 * the caller's `limit`. Defensive fallbacks on every error path so a
 * corrupt or missing file never crashes the gateway.
 */
async function readSessionTranscriptMessages(params: {
	sessionKey: string;
	limit?: number;
}): Promise<ReadonlyArray<unknown>> {
	const sessionKey = (params.sessionKey ?? "").trim();
	if (!sessionKey) return [];
	const parsed = parseAgentSessionKey(sessionKey);
	const agentId = parsed?.agentId ?? "main";
	let entry: { sessionId?: string } | undefined;
	try {
		const store = readSessionStore(agentId);
		entry = store.sessions?.[sessionKey];
	} catch {
		return [];
	}
	const sessionId = entry?.sessionId;
	if (!sessionId) return [];

	// Convex mode — project the transcript rows instead of the JSONL file.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		try {
			const records = await rctx.store.messages.readTranscript(agentId, sessionId);
			const messages: unknown[] = [];
			for (const record of records) {
				const r = record as { type?: string; message?: unknown };
				if (r?.type === "message" && r.message !== undefined) messages.push(r.message);
			}
			const limit =
				typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
			if (limit !== undefined && messages.length > limit) {
				return messages.slice(messages.length - limit);
			}
			return messages;
		} catch {
			return [];
		}
	}

	let transcriptPath: string;
	try {
		transcriptPath = resolveSessionTranscriptPath(agentId, sessionId);
	} catch {
		return [];
	}
	if (!existsSync(transcriptPath)) return [];
	let raw: string;
	try {
		raw = readFileSync(transcriptPath, "utf8");
	} catch {
		return [];
	}
	const messages: unknown[] = [];
	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		const text = line.trim();
		if (!text) continue;
		try {
			const parsedLine = JSON.parse(text) as { type?: string; message?: unknown };
			if (parsedLine?.type === "message" && parsedLine.message !== undefined) {
				messages.push(parsedLine.message);
			}
		} catch {
			// Corrupt line — drop and continue.
		}
	}
	const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
	if (limit !== undefined && messages.length > limit) {
		return messages.slice(messages.length - limit);
	}
	return messages;
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

	// Phase 0 — storage layer. Idempotent: the CLI preAction hook normally
	// booted it already; this covers embedded/test paths that call
	// `startServer` directly. After this line every subsystem may reach
	// storage via `getRuntimeContext().store`. Convex mode with an
	// unreachable deployment fails HERE, before the lock/port are touched.
	await bootRuntimeContext();
	// Convex mode: keep the config cache hot via the live-query subscription
	// (the convex-mode counterpart of the brigade.json hot-reload watcher).
	// No-op in filesystem mode. The gateway is the only long-lived process,
	// so this is the only call site; handle.stop() disables it.
	enableConfigLiveRefresh();

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

		// Push lane concurrency budgets from config into the command-queue engine
		// BEFORE channels / cron / heartbeat boot so the first enqueues already
		// see the resolved caps. `system.reload` re-applies this below.
		applyGatewayLaneConcurrency(config);

		// Boot warning when `session.dmScope` is unset AND bindings reference
		// multiple peers on the same channel — the back-compat default
		// (`"main"`) silently collapses every DM into one session.
		try {
			const dmScopeWarnings = detectDmScopeCollapseRisk(config as never);
			for (const w of dmScopeWarnings) {
				const log = createSubsystemLogger("routing");
				log.warn(formatDmScopeWarning(w));
			}
		} catch {
			/* best-effort warning; never block boot */
		}

		// Phase 4 — Resolving authentication. Emits the standard
		// "resolving authentication…" line.
		bootLog("resolving authentication…");
		// Read auth from Brigade's `~/.brigade/agents/main/agent/auth-profiles.json`
		// (the file `brigade onboard` writes), NOT from Pi's vanilla
		// `${BRIGADE_DIR}/auth.json`. Without this bridge the gateway would
		// never see keys that onboarding produced.
		const authStorage = loadBrigadeAuthStorage() as AuthStorage;
		const modelRegistry = ModelRegistry.create(authStorage, resolveModelsPath(DEFAULT_AGENT_ID));

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
				modelsFile: resolveModelsPath(DEFAULT_AGENT_ID),
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
			bootConfig: config,
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
	/** Boot-time loaded config used to seed `perAgentRuntime` + resolve the default agent id. */
	bootConfig: Config;
}

async function continueBoot(args: BootContinueArgs): Promise<ServerHandle> {
	const { opts, port, host, startupStartedAt, lockHandle, modelRegistry, authStorage, bootLog } = args;
	const modelsFile = resolveModelsPath(DEFAULT_AGENT_ID);

	// Wave L P2#3 — clear stale lane state from any prior in-process boot
	// (test harness double-boots, dev hot-reload). `markGatewayDraining`
	// from a previous stop() may still be set on the pinned queue singleton;
	// without this, the first enqueue here rejects with GatewayDrainingError
	// and the gateway looks alive but accepts nothing.
	try {
		resetAllLanes();
	} catch {
		// best-effort — lane reset never blocks boot
	}

	// A2A boot-default — canonicalise `cfg.session.agentToAgent` at boot
	// so personal installs work out of the box (the sessions-access guard,
	// `sessions_send` policy, and every other A2A consumer downstream read
	// the canonical shape). Default-on; operators set
	// `cfg.session.autoEnableA2AAtBoot = false` for strict-allowlist
	// installs where every (from, to) pair is hand-authored.
	//
	// Mutates the local `args.bootConfig` (every downstream reader sees the
	// canonicalised shape) and best-effort persists the canonical form back
	// to disk via `mutateConfigAtomic` so the on-disk shape stabilises in
	// one write per boot. Disk-write failure is non-fatal — the in-memory
	// shape still wins.
	{
		const canonicalized = applyAutoEnableA2AAtBoot(args.bootConfig as unknown as BrigadeConfig);
		if (canonicalized !== (args.bootConfig as unknown as BrigadeConfig)) {
			bootLog("canonicalizing cfg.session.agentToAgent at boot…");
			args.bootConfig = canonicalized as unknown as Config;
			try {
				await mutateConfigAtomic(
					(cur) => applyAutoEnableA2AAtBoot(cur as BrigadeConfig) as unknown as typeof cur,
				);
			} catch (err) {
				bootLog(
					`a2a canonicalize disk write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	/**
	 * Per-agent runtime state. Each entry carries the active `provider`,
	 * `modelId`, resolved `Model`, and `thinkingLevel` for one agent. Seeded
	 * on boot from `cfg.agents.defaults` + every named `cfg.agents.<id>`,
	 * mutated by `set-model` / `set-thinking` / `switch-model-mid-turn`.
	 *
	 * Replaces the four closure-scoped singletons (provider/modelId/model/
	 * thinkingLevel) that used to be shared across every agent — those caused
	 * a `set-model` for agent A to silently retarget agent B's next turn.
	 */
	type AgentRuntime = {
		provider: string;
		modelId: string;
		model: Model<string>;
		thinkingLevel: ThinkingLevel;
	};
	const perAgentRuntime = new Map<string, AgentRuntime>();

	// H4: narrow a persisted `cfg.agents.<id>.thinking` string back to a
	// ThinkingLevel. set-thinking writes the operator's selection to
	// brigade.json, but the boot + seed paths previously always derived the
	// level from the model — silently resetting the choice on every daemon
	// restart. The validator lives in model-caps.js so unit tests can exercise
	// it directly.
	const readPersistedThinking = readPersistedThinkingLevel;

	// The agent identity + session key the gateway drives. A single
	// long-lived sessionKey gives conversation continuity across turns:
	// every turn resumes the same JSONL transcript (the per-turn mirror —
	// state lives on disk, not in a held session object). The boot default
	// agent is now config-derived (resolveDefaultAgentId) rather than hard-
	// coded so operators who pin a non-`main` agent are honoured.
	const agentId = resolveDefaultAgentId(args.bootConfig as unknown as BrigadeConfig);
	const sessionKey = defaultSessionKey(agentId);

	/**
	 * Per-agent memoised AuthStorage. Each non-boot agent has its own
	 * `~/.brigade/agents/<id>/agent/auth-profiles.json` and may carry
	 * agent-specific keys; the boot agent re-uses the boot-loaded storage so
	 * we don't double-read its profile. Used by the boot runtime seed, the
	 * memory sweep, and the set-model / switch-model-mid-turn validation
	 * paths — anywhere a non-boot agent's credentials could otherwise be
	 * silently substituted with the boot agent's keys.
	 */
	const authStorageByAgent = new Map<string, AuthStorage>();
	const getAuthStorageForAgent = (id: string): AuthStorage => {
		const cached = authStorageByAgent.get(id);
		if (cached) return cached;
		const built = id === agentId ? authStorage : (loadBrigadeAuthStorage(id) as AuthStorage);
		authStorageByAgent.set(id, built);
		return built;
	};

	// Seed perAgentRuntime: defaults entry under the boot agent id, then every
	// per-agent override (resolving overrides through the registry). Failures
	// fall back to the boot defaults — a misconfigured agent doesn't kill boot.
	// H4: honour the persisted `cfg.agents.<bootAgent>.thinking` (set via the
	// set-thinking RPC) before falling back to the model-derived initial level.
	// Without this lookup the operator's selection silently resets on every
	// daemon restart.
	const bootPersistedThinking = readPersistedThinking(
		(args.bootConfig.agents as Record<string, unknown> | undefined)?.[agentId],
	);
	perAgentRuntime.set(agentId, {
		provider: args.provider,
		modelId: args.modelId,
		model: args.model,
		thinkingLevel: bootPersistedThinking ?? pickInitialThinkingLevel(args.model),
	});

	// Reusable per-agent seed pass. Boot calls it with the bootConfig; the
	// brigade.json watcher (H1) calls it again when the file changes so newly
	// added agents are usable without restarting the gateway.
	async function seedAgentsFromConfig(
		cfgAgents:
			| {
					[id: string]:
						| { provider?: string; model?: { primary?: string }; thinking?: string }
						| undefined;
			  }
			| undefined,
	): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
		const map = cfgAgents ?? {};
		const defaultsEntry = map.defaults;
		const defaultsProvider =
			defaultsEntry && typeof defaultsEntry.provider === "string" ? defaultsEntry.provider : undefined;
		const defaultsModelId =
			defaultsEntry && typeof defaultsEntry.model === "object" && defaultsEntry.model &&
			typeof defaultsEntry.model.primary === "string"
				? defaultsEntry.model.primary
				: undefined;
		const seenIds = new Set<string>([agentId]);
		const added: string[] = [];
		const updated: string[] = [];
		// H4: honour a persisted `thinking` on the boot agent entry even when
		// re-seeding (config hot-reload edits the level for the boot agent).
		const bootPersisted = readPersistedThinking(map[agentId]);
		if (bootPersisted !== undefined) {
			const bootCur = perAgentRuntime.get(agentId);
			if (bootCur && bootCur.thinkingLevel !== bootPersisted) {
				perAgentRuntime.set(agentId, { ...bootCur, thinkingLevel: bootPersisted });
			}
		}
		for (const [id, entry] of Object.entries(map)) {
			if (id === "defaults" || !entry || typeof entry !== "object") continue;
			seenIds.add(id);
			const aProvider =
				(typeof entry.provider === "string" ? entry.provider : undefined) ?? defaultsProvider;
			const aModelId =
				(typeof entry.model === "object" && entry.model && typeof entry.model.primary === "string"
					? entry.model.primary
					: undefined) ?? defaultsModelId;
			if (perAgentRuntime.has(id)) {
				// BOOT AGENT EXCEPTION (audit P0 F5/F6, 2026-06-11): the boot
				// agent's model is owned by the in-process set-model path
				// (perAgentRuntime.set + persistDefaultModel → agents.defaults),
				// NOT by its `agents.<id>` entry. Re-deriving it here from a
				// stale per-agent pin REVERTED a just-applied set-model ~500ms
				// later (config write → this watcher). HEAD skipped every
				// already-seeded agent; preserve that for the boot agent exactly
				// (its thinking hot-reload is handled separately above at the
				// bootPersistedThinking block). Only NON-boot agents get the
				// model hot-reload this branch was added for.
				if (id === agentId) continue;
				// Hot-reload model/provider edits for EXISTING non-boot agents.
				// Previously this skipped outright, so changing an agent's model
				// in brigade.json silently required a full gateway restart while
				// every surface claimed "applies next turn". Rebuild the runtime
				// only when the configured pair actually changed; the operator's
				// in-session thinking choice survives the swap.
				const current = perAgentRuntime.get(id);
				if (
					current &&
					aProvider &&
					aModelId &&
					(current.provider !== aProvider || current.modelId !== aModelId)
				) {
					const rebuilt =
						modelRegistry.find(aProvider, aModelId) ??
						((await resolveModelNeverMiss({
							modelRegistry,
							provider: aProvider,
							modelId: aModelId,
							modelsFile,
							authStorage: getAuthStorageForAgent(id),
						})) as Model<string> | undefined);
					if (rebuilt) {
						perAgentRuntime.set(id, {
							provider: aProvider,
							modelId: aModelId,
							model: rebuilt,
							thinkingLevel:
								readPersistedThinking(entry) ?? current.thinkingLevel,
						});
						updated.push(id);
					} else {
						bootLog(
							`hot-reload: agent "${id}" model ${aProvider}/${aModelId} could not be resolved — keeping ${current.provider}/${current.modelId}`,
						);
					}
				}
				continue;
			}
			if (!aProvider || !aModelId) {
				bootLog(
					`skipping agent "${id}" — no provider/model resolved (per-agent entry has none and cfg.agents.defaults is incomplete)`,
				);
				continue;
			}
			const aModel =
				modelRegistry.find(aProvider, aModelId) ??
				((await resolveModelNeverMiss({
					modelRegistry,
					provider: aProvider,
					modelId: aModelId,
					modelsFile,
					authStorage: getAuthStorageForAgent(id),
				})) as Model<string> | undefined);
			if (!aModel) {
				bootLog(
					`skipping agent "${id}" — model ${aProvider}/${aModelId} could not be resolved (check auth profile + provider availability)`,
				);
				continue;
			}
			// H4: prefer the operator-persisted thinking level over the
			// model-derived default so a daemon restart honours the choice.
			const persistedThinking = readPersistedThinking(entry);
			perAgentRuntime.set(id, {
				provider: aProvider,
				modelId: aModelId,
				model: aModel,
				thinkingLevel: persistedThinking ?? pickInitialThinkingLevel(aModel),
			});
			added.push(id);
		}
		// Evict runtimes for agents that no longer appear in cfg. The boot
		// agent is always preserved so the snapshot's default never disappears.
		const removed: string[] = [];
		for (const existingId of [...perAgentRuntime.keys()]) {
			if (existingId === agentId) continue;
			if (seenIds.has(existingId)) continue;
			perAgentRuntime.delete(existingId);
			removed.push(existingId);
		}
		return { added, removed, updated };
	}

	await seedAgentsFromConfig(
		args.bootConfig.agents as
			| {
					[id: string]:
						| { provider?: string; model?: { primary?: string }; thinking?: string }
						| undefined;
			  }
			| undefined,
	);

	/** Look up runtime entry for an agent id, falling back to the boot default. */
	const getAgentRuntime = (id: string | undefined): AgentRuntime => {
		const target = id && perAgentRuntime.has(id) ? id : agentId;
		const entry = perAgentRuntime.get(target);
		if (entry) return entry;
		// Hard fallback: if even the boot default vanished from the map (it
		// shouldn't), fabricate one from args so callers never crash.
		const fab: AgentRuntime = {
			provider: args.provider,
			modelId: args.modelId,
			model: args.model,
			thinkingLevel: pickInitialThinkingLevel(args.model),
		};
		perAgentRuntime.set(agentId, fab);
		return fab;
	};

	// H1: hot-reload. One debounced re-seed body, two triggers by mode:
	//
	//   • Filesystem — fs.watch on brigade.json (editor atomic-write bursts
	//     coalesce via the 500ms debounce). Unchanged behaviour.
	//   • Convex — there is no brigade.json; config changes land in the
	//     in-process config cache (primed by io.ts on every local write AND by
	//     the live subscription for cross-process writes). Subscribe to those
	//     primes. Without this, a mid-session `manage_agent add` / org init
	//     updated the CONFIG but never perAgentRuntime: 20 agents in config
	//     while `agents on the gateway` listed only main and `/agent <id>` /
	//     `brigade tui <id>` refused every new agent until a restart.
	//
	// Newly added agents become usable without restarting the gateway;
	// removed agents are evicted from perAgentRuntime.
	let configWatcher: ReturnType<typeof fsWatch> | undefined;
	let configReloadTimer: ReturnType<typeof setTimeout> | undefined;
	let configPrimeUnsub: (() => void) | undefined;
	const scheduleAgentReseed = (): void => {
		if (configReloadTimer) clearTimeout(configReloadTimer);
		configReloadTimer = setTimeout(() => {
			configReloadTimer = undefined;
			void (async () => {
				try {
					const fresh = await loadConfig();
					const result = await seedAgentsFromConfig(
						(fresh as { agents?: Record<string, unknown> }).agents as
							| {
									[id: string]:
										| {
												provider?: string;
												model?: { primary?: string };
												thinking?: string;
										  }
										| undefined;
							  }
							| undefined,
					);
					for (const id of result.added) bootLog(`hot-reload: seeded agent "${id}"`);
					for (const id of result.removed) bootLog(`hot-reload: evicted agent "${id}"`);
					for (const id of result.updated) bootLog(`hot-reload: updated agent "${id}" model`);
				} catch (err) {
					bootLog(
						`hot-reload failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			})();
		}, 500);
	};
	if (tryGetRuntimeContext()?.mode === "convex") {
		configPrimeUnsub = onConfigCachePrimed(scheduleAgentReseed);
		bootLog("config hot-reload: convex mode — following backend config changes (no disk watcher)");
	} else
	try {
		const configPath = resolveConfigPath();
		configWatcher = fsWatch(configPath, { persistent: false }, scheduleAgentReseed);
		configWatcher.on("error", (err: Error) => {
			bootLog(`config watcher error: ${err.message}`);
		});
	} catch (err) {
		bootLog(
			`config watcher failed to start: ${err instanceof Error ? err.message : String(err)} (hot-reload disabled)`,
		);
	}

	// Channel manager (WhatsApp/Slack/…): started after the WS listener is up
	// (see below), torn down in handle.stop(). Null when no channel is configured.
	let channelManager: ChannelManager | undefined;
	// Plugin-shaped channel manager (Wave F multi-account WhatsApp ride-along).
	// Coexists with the legacy `channelManager` above: legacy is the v1
	// `ChannelAdapter` path (single-account; covers Slack/Telegram/etc. when
	// they ship), this one is the `ChannelPlugin` path for multi-account
	// channels (WhatsApp personal+work). Both fan into the same `runGatewayTurn`.
	let channelPluginManager: ChannelPluginManager | undefined;
	// Plugins we hand to the plugin manager. Currently bundled-only (WhatsApp);
	// future channels can register through the seam. Captured here so the
	// `getChannelPlugin` lookup stays O(n) with a small in-memory list.
	let bundledChannelPlugins: ChannelPlugin[] = [];

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
	//
	// CORE routes (below) are non-extension and must survive a config hot-reload,
	// which rebuilds `httpRoutes` from the extension registry. The MCP tool-plane
	// route (`/mcp/<token>`) lets the claude-cli harness backend call Brigade's
	// full guarded tool surface in-process — so it lives here, ahead of extension
	// routes, and is re-merged on every rebuild.
	const mcpTurnRegistry = createMcpTurnRegistry();
	const coreHttpRoutes: HttpRoute[] = [createMcpHttpRoute(mcpTurnRegistry)];
	let httpRoutes: HttpRoute[] = [...coreHttpRoutes];
	const startedServices: { id: string; service: Service }[] = [];
	let serviceAbort: AbortController | undefined;

	// Set true once handle.stop() begins, so background work (memory extraction
	// debounce) doesn't re-arm timers or run sweeps against a torn-down server.
	let serverStopped = false;

	// ── Recall embedder selection ── Default = the model-free HRR (air-gap,
	// zero-dep — unchanged). Opt into a LEARNED embedder for true-synonymy recall
	// via BRIGADE_MEMORY_EMBEDDER = "auto" | "local-embeddinggemma" | "openai-256"
	// (local model preferred, then remote, graceful-degrade to HRR). Fire-and-
	// forget: recall uses HRR until a learned model finishes loading
	// (a local GGUF can take seconds), then switches the process default in place;
	// the sweep's re-embed pass backfills vectors for facts written meanwhile.
	const embedderSelection = process.env.BRIGADE_MEMORY_EMBEDDER ?? "model-free";
	void resolveEmbedder(embedderSelection)
		.then((e) => {
			setDefaultEmbedder(e);
			const memLog = createSubsystemLogger("memory");
			// VISIBLE degradation: a requested LEARNED embedder that fell back to the
			// model-free HRR (missing key / model / optional dep) would otherwise drop
			// recall to BM25-primary SILENTLY. Warn so the operator knows synonymy
			// recovery is off; otherwise confirm which embedder is live.
			if (embedderSelection !== "model-free" && e.id.startsWith("hrr")) {
				memLog.warn(
					`memory embedder "${embedderSelection}" unavailable (missing key / model / optional dep) — ` +
						`degraded to model-free HRR. Recall stays BM25-primary; true-synonymy recovery is OFF ` +
						`until a learned embedder loads.`,
				);
			} else {
				memLog.info(`memory embedder ready: ${e.id} (${e.dims}-dim)`);
			}
		})
		.catch(() => {});

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
	// Per-agent → per-session pending batches. Turns from DIFFERENT agents (and
	// DIFFERENT conversations within an agent) that settle inside the same
	// debounce window each keep their own pending batch. A single shared slot
	// would let one overwrite another and silently drop its turns. Re-setting
	// the same (agentId, sessionId) just refreshes that conversation's batch
	// with the latest transcript.
	// Per-session extraction queue. The entry carries the turn's resolved memory
	// ORIGIN (+ sourceType) so the off-hot-path sweep stamps peer-derived facts
	// with the peer's channel scope (isolated) instead of the operator's — closing
	// the poisoned-inbox extraction breach.
	type ExtractEntry = { messages: unknown[]; origin: MemoryRecordOrigin; sourceType?: MemorySourceType };
	const pendingExtracts = new Map<string, Map<string, ExtractEntry>>();
	/** Agents currently mid-extraction. Replaces the process-wide `extracting`
	 * boolean so N agents can sweep concurrently without blocking each other. */
	const extractingAgents = new Set<string>();
	/**
	 * When each in-flight extraction started, paired with `extractingAgents`.
	 * Lets the stuck-flag watchdog (run on every armed sweep) detect entries
	 * held for longer than a reasonable bound and force-clear them. Without
	 * this, an extraction whose driver promise never settles (a deadlocked
	 * disk write, a Pi session that abort()'d silently without resolving)
	 * would leave the agent's slot permanently blocked — every later
	 * scheduleExtraction call would observe the set membership and re-queue
	 * forever.
	 *
	 * The watchdog threshold is 2.5× BRIGADE_MEMORY_LLM_TIMEOUT_MS plus a
	 * 30s buffer for cursor + persistence I/O, so a legitimately-slow sweep
	 * is never reaped while a genuinely-wedged one is recovered well before
	 * the operator notices missing memory updates.
	 */
	const extractingSince = new Map<string, number>();
	// Per-sweep token: the watchdog can force-clear a stuck flag, after which a NEW
	// sweep may start — without a token, the OLD (still-running) sweep's finally{} would
	// then delete the NEW sweep's flag, letting a 3rd start, and so on (cascading
	// concurrent sweeps + cursor churn). A sweep only clears its flag if its token is
	// still the current one.
	const extractingToken = new Map<string, number>();
	let extractTokenSeq = 0;
	const extractionStuckBufferMs = 30_000;

	// ── Skill-learning review (the behavior-change half of self-improvement) ──
	// On a cadence, a tool-less reviewer distils the OWNER's session into reusable
	// SKILLS (written to the agent's workspace, discovered on its next turn). This
	// is the half memory can't do: it changes how the agent ACTS, not just what it
	// knows. OWNER-ONLY by construction — a skill is authority over behavior, so a
	// channel peer must never author one (that would be behavior injection). The
	// per-(agent|session) counter fires every BRIGADE_SKILL_REVIEW_INTERVAL drains
	// (default 6); BRIGADE_DISABLE_SKILL_REVIEW=1 (or interval 0) turns it off.
	const skillReviewEnabled = process.env.BRIGADE_DISABLE_SKILL_REVIEW !== "1";
	const skillReviewInterval = (() => {
		const raw = Number(process.env.BRIGADE_SKILL_REVIEW_INTERVAL);
		return Number.isFinite(raw) && raw >= 0 ? raw : 6;
	})();
	const skillReviewCounter = new Map<string, number>();

	// ── Skill curator (the maintenance half) ── Off-hot-path aging of agent-
	// created skills so the auto-learned library doesn't bloat: it records which
	// skills were USED (a SKILL.md read in the transcript) and ages out the rest
	// (active→stale→archived, reversible). BRIGADE_DISABLE_SKILL_CURATOR=1 turns
	// it off; the day-cutoffs are tunable for testing.
	const skillCuratorEnabled = process.env.BRIGADE_DISABLE_SKILL_CURATOR !== "1";
	const skillStaleDays = (() => {
		const raw = Number(process.env.BRIGADE_SKILL_STALE_DAYS);
		return Number.isFinite(raw) && raw >= 0 ? raw : 30;
	})();
	const skillArchiveDays = (() => {
		const raw = Number(process.env.BRIGADE_SKILL_ARCHIVE_DAYS);
		return Number.isFinite(raw) && raw >= 0 ? raw : 90;
	})();

	// ── Behavioral review (the self-model half of self-improvement) ── On a cadence,
	// distil the OWNER's durable preferences/corrections/persona and write them
	// FIRST-CLASS (owner_message trust). OWNER-only (a peer must never shape the
	// self-model). The write-gate makes the preference AUTHORITATIVE regardless of
	// order — an untrusted extraction write can never override/supersede an owner
	// fact — so the run-before-extraction ordering is incidental, not load-bearing;
	// extraction still confines preferences→knowledge as defense-in-depth.
	// BRIGADE_DISABLE_BEHAVIOR_REVIEW=1 off.
	const behaviorReviewEnabled = process.env.BRIGADE_DISABLE_BEHAVIOR_REVIEW !== "1";
	const behaviorReviewInterval = (() => {
		const raw = Number(process.env.BRIGADE_BEHAVIOR_REVIEW_INTERVAL);
		return Number.isFinite(raw) && raw >= 0 ? raw : 6;
	})();
	const behaviorReviewCounter = new Map<string, number>();

	/** One cadence-gated behavioral review for an owner session (no-op otherwise).
	 *  Writes self-model facts first-class; best-effort, never throws into the sweep. */
	const maybeReviewBehavior = async (
		targetAgentId: string,
		sessionId: string,
		entry: ExtractEntry,
		ctx: { workspaceDir: string; agentDir: string; agentAuth: unknown; agentModel: unknown },
	): Promise<void> => {
		if (!behaviorReviewEnabled || behaviorReviewInterval <= 0) return;
		if (entry.origin.kind !== "owner") return; // peers never shape the self-model
		const key = `${targetAgentId}|${sessionId}`;
		// Bound the per-session cadence map (see maybeReviewSkills) — FIFO-evict the
		// oldest when a new key arrives at the cap, so it can't grow unbounded.
		if (behaviorReviewCounter.size >= 4096 && !behaviorReviewCounter.has(key)) {
			const oldest = behaviorReviewCounter.keys().next().value;
			if (oldest !== undefined) behaviorReviewCounter.delete(oldest);
		}
		const n = (behaviorReviewCounter.get(key) ?? 0) + 1;
		if (!shouldReviewBehavior(n, behaviorReviewInterval)) {
			behaviorReviewCounter.set(key, n);
			return;
		}
		behaviorReviewCounter.set(key, 0);
		try {
			const transcript = flattenConversation(entry.messages);
			if (transcript.trim().length === 0) return;
			const br = await runBehaviorReview({
				transcript,
				reviewer: makeBehaviorReviewer({
					workspaceDir: ctx.workspaceDir,
					agentDir: ctx.agentDir,
					authStorage: ctx.agentAuth,
					modelRegistry,
					model: ctx.agentModel,
				}),
				store: new FactStore(ctx.workspaceDir),
				origin: entry.origin,
			});
			if (br.written) {
				opts.consoleStream?.info?.(`behavior review (agent=${targetAgentId}): ${br.summary}`);
			}
		} catch (brErr) {
			opts.consoleStream?.info?.(
				`behavior review error (agent=${targetAgentId}): ${brErr instanceof Error ? brErr.message : String(brErr)}`,
			);
		}
	};

	/** One cadence-gated skill-review pass for an owner session (no-op otherwise).
	 *  Best-effort: never throws into the sweep; the isolated LLM is wall-clock-bounded. */
	const maybeReviewSkills = async (
		targetAgentId: string,
		sessionId: string,
		entry: ExtractEntry,
		ctx: { workspaceDir: string; agentDir: string; agentAuth: unknown; agentModel: unknown },
	): Promise<void> => {
		if (!skillReviewEnabled || skillReviewInterval <= 0) return;
		// OWNER-only — a channel peer must never author the agent's behavior.
		if (entry.origin.kind !== "owner") return;
		const key = `${targetAgentId}|${sessionId}`;
		// Bound the per-session cadence map on a long-lived gateway (one entry per
		// owner session, never reclaimed otherwise): FIFO-evict the oldest when a NEW
		// key arrives at the cap. An evicted session just restarts its cadence count.
		if (skillReviewCounter.size >= 4096 && !skillReviewCounter.has(key)) {
			const oldest = skillReviewCounter.keys().next().value;
			if (oldest !== undefined) skillReviewCounter.delete(oldest);
		}
		const n = (skillReviewCounter.get(key) ?? 0) + 1;
		if (!shouldReviewSkills(n, skillReviewInterval)) {
			skillReviewCounter.set(key, n);
			return;
		}
		skillReviewCounter.set(key, 0); // reset on fire
		try {
			const transcript = flattenConversation(entry.messages);
			if (transcript.trim().length === 0) return;
			const sr = await runSkillReview({
				transcript,
				reviewer: makeSkillReviewer({
					workspaceDir: ctx.workspaceDir,
					agentDir: ctx.agentDir,
					authStorage: ctx.agentAuth,
					modelRegistry,
					model: ctx.agentModel,
				}),
				agentId: targetAgentId,
			});
			if (sr.created.length) {
				opts.consoleStream?.info?.(`skill review (agent=${targetAgentId}): ${sr.summary}`);
			}
		} catch (skillErr) {
			opts.consoleStream?.info?.(
				`skill review error (agent=${targetAgentId}): ${skillErr instanceof Error ? skillErr.message : String(skillErr)}`,
			);
		}
	};

	const armExtractTimer = (): void => {
		if (serverStopped) return; // never re-arm after shutdown
		if (extractTimer) clearTimeout(extractTimer);
		extractTimer = setTimeout(() => void runExtractionNow(), EXTRACT_DEBOUNCE_MS);
		extractTimer.unref?.();
	};

	// FINAL DRAIN — fire any pending (debounced) extraction NOW and await it,
	// bounded, so the last turn's facts land before shutdown instead of being lost
	// with the unref'd timer. Called by handle.stop() BEFORE `serverStopped` flips
	// (runExtractionNow no-ops once stopped). Best-effort + time-boxed: a wedged
	// provider must never hang teardown.
	const flushPendingExtraction = async (timeoutMs = 5_000): Promise<void> => {
		if (extractTimer) {
			clearTimeout(extractTimer);
			extractTimer = null;
		}
		if (pendingExtracts.size === 0) return;
		await Promise.race([
			runExtractionNow().catch(() => {}),
			new Promise<void>((resolve) => {
				const t = setTimeout(resolve, timeoutMs);
				t.unref?.();
			}),
		]);
	};

	// PRE-COMPACTION extraction hook (memory-ops) — when the agent loop is about to
	// compact a session, distil the about-to-be-replaced history FIRST so a fact
	// living only in those turns isn't lost. Runs the SAME extraction sweep as the
	// post-turn path, with the turn's origin (isolation-preserving). Guarded against
	// overlapping an in-flight sweep for the same agent (no cursor race), and a no-op
	// once the server is stopped or extraction is disabled.
	setPreCompactionExtractionHook(async ({ agentId, sessionId, messages, origin }) => {
		if (!memoryExtractEnabled || serverStopped) return;
		if (extractingAgents.has(agentId)) return; // an in-flight sweep already covers this agent
		extractingAgents.add(agentId);
		extractingSince.set(agentId, Date.now());
		try {
			const workspaceDir = resolveAgentWorkspaceDir(agentId);
			const agentDir = resolveAgentDir(agentId);
			const agentAuth = getAuthStorageForAgent(agentId);
			const agentModel = getAgentRuntime(agentId).model;
			const llm = makeExtractionLlm({
				workspaceDir,
				agentDir,
				authStorage: agentAuth,
				modelRegistry,
				model: agentModel,
			});
			await runExtractionSweep({ workspaceDir, sessionId, messages, llm, origin });
		} catch (err) {
			opts.consoleStream?.info?.(
				`pre-compaction extraction error (agent=${agentId}): ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			extractingAgents.delete(agentId);
			extractingSince.delete(agentId);
		}
	});

	// RELINK factory (manage_memory action=relink) — build a tool-less isolated LLM
	// with the RELINK_PROMPT pinned for the requested agent, so the operator's
	// on-demand "link my related facts" pass has a model. Keyed by agentId (the tool
	// registry knows it) → resolve auth/model/dir directly. DELIBERATELY NOT gated by
	// memoryExtractEnabled: the kill-switch freezes the BACKGROUND sweep, but relink is
	// an explicit one-shot operator action that must still work on demand. One model
	// call per fact-window, only when the operator invokes it. Best-effort: a resolve
	// failure (unknown agent) returns undefined → the tool reports relink unavailable.
	setRelinkLlmFactory((targetAgentId: string) => {
		if (serverStopped) return undefined;
		try {
			return makeIsolatedLlm(RELINK_PROMPT, {
				workspaceDir: resolveAgentWorkspaceDir(targetAgentId),
				agentDir: resolveAgentDir(targetAgentId),
				authStorage: getAuthStorageForAgent(targetAgentId),
				modelRegistry,
				model: getAgentRuntime(targetAgentId).model,
			});
		} catch {
			return undefined;
		}
	});

	const runExtractionNow = async (): Promise<void> => {
		if (pendingExtracts.size === 0 || serverStopped) return;
		// Stuck-flag watchdog. Before we look at the pending batches, sweep
		// any extractingAgents entry that's been held longer than the
		// configured bound — that's an in-flight extraction whose driver
		// promise never settled (deadlocked I/O, an abort that resolved
		// without finally{} reaching us, etc.). Force-clearing the flag
		// here lets the next pendingExtracts batch for that agent actually
		// run instead of being silently re-queued forever.
		if (extractingSince.size > 0) {
			const llmTimeoutMs = (() => {
				const raw = process.env.BRIGADE_MEMORY_LLM_TIMEOUT_MS;
				const parsed = raw ? Number(raw) : NaN;
				return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 60_000;
			})();
			const stuckThresholdMs = Math.round(2.5 * llmTimeoutMs) + extractionStuckBufferMs;
			const now = Date.now();
			for (const [agentId, startedAt] of extractingSince) {
				if (now - startedAt >= stuckThresholdMs) {
					opts.consoleStream?.info?.(
						`memory extraction stuck-flag cleared (agent=${agentId}, ageMs=${now - startedAt})`,
					);
					extractingAgents.delete(agentId);
					extractingSince.delete(agentId);
					extractingToken.delete(agentId);
				}
			}
		}
		// Defer while ANY turn is active — never compete with the user-facing
		// call. Per-agent sweeps run concurrently below, but the in-flight
		// check is global (any agent's live turn defers all sweeps).
		// CRITICAL: re-arm rather than DROP the pending batches.
		if (countActiveLiveSessions() > 0) {
			armExtractTimer();
			return;
		}
		// Drain every pending agent's per-session batches this window.
		const agentBatches = [...pendingExtracts.entries()];
		pendingExtracts.clear();
		// Run agents concurrently; within an agent, sweeps are sequential so
		// the cursor advance order stays deterministic per session.
		await Promise.all(
			agentBatches.map(async ([targetAgentId, sessions]) => {
				// Re-queue agents that are already sweeping (and skip — they'll be
				// picked up on the next armed timer). Set membership is per-agent so
				// a slow sweep in one agent doesn't block another.
				if (extractingAgents.has(targetAgentId)) {
					for (const [sid, msgs] of sessions) {
						const existing = pendingExtracts.get(targetAgentId);
						if (existing) existing.set(sid, msgs);
						else pendingExtracts.set(targetAgentId, new Map([[sid, msgs]]));
					}
					armExtractTimer();
					return;
				}
				extractingAgents.add(targetAgentId);
				extractingSince.set(targetAgentId, Date.now());
				const sweepToken = ++extractTokenSeq;
				extractingToken.set(targetAgentId, sweepToken);
				try {
					const workspaceDir = resolveAgentWorkspaceDir(targetAgentId);
					const agentDir = resolveAgentDir(targetAgentId);
					const agentAuth = getAuthStorageForAgent(targetAgentId);
					const agentModel = getAgentRuntime(targetAgentId).model;
					const llm = makeExtractionLlm({
						workspaceDir,
						agentDir,
						authStorage: agentAuth,
						modelRegistry,
						model: agentModel,
					});
					for (const [sessionId, entry] of sessions) {
						// Self-model half: distil the owner's durable preferences/corrections
						// BEFORE extraction (which confines them) — owner-only, cadence-gated.
						await maybeReviewBehavior(targetAgentId, sessionId, entry, {
							workspaceDir,
							agentDir,
							agentAuth,
							agentModel,
						});
						await runExtractionSweep({
							workspaceDir,
							sessionId,
							messages: entry.messages,
							llm,
							origin: entry.origin,
							...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
						});
						// Record which agent-created skills the model USED this session (a
						// SKILL.md read) so the curator ages on real use, not just creation.
						if (skillCuratorEnabled && entry.origin.kind === "owner") {
							try {
								detectAndRecordSkillUses(joinPath(workspaceDir, "skills"), entry.messages);
							} catch {
								/* best-effort telemetry */
							}
						}
						// Behavior-change half: distil reusable SKILLS from owner sessions
						// (cadence-gated, owner-only — see maybeReviewSkills).
						await maybeReviewSkills(targetAgentId, sessionId, entry, {
							workspaceDir,
							agentDir,
							agentAuth,
							agentModel,
						});
					}
					// Cheap, no-model-call decay GC in the same quiet window for THIS
					// agent's workspace. Runs once per drain per agent.
					runDecayGc(workspaceDir);
					// Re-embed pass: fill vectors that embed-on-write SKIPPED under a
					// LEARNED (async) embedder. No-op for the sync HRR default (facts are
					// vectored inline on write). Best-effort + bounded — gives a selected
					// learned embedder its synonymy recall progressively.
					if (!getDefaultEmbedder().id.startsWith("hrr")) {
						try {
							await reembedPending(new FactStore(workspaceDir), getDefaultEmbedder());
						} catch (reErr) {
							opts.consoleStream?.info?.(
								`reembed error (agent=${targetAgentId}): ${reErr instanceof Error ? reErr.message : String(reErr)}`,
							);
						}
					}
					// Deterministic memory maintenance (no LLM): PER-ORIGIN confirm of
					// repeatedly-asserted/corrected beliefs + near-duplicate merge.
					// Eviction is intentionally left to runDecayGc above (no double-GC),
					// so this is cheap + idempotent and rides every drain. Its own
					// try/catch so a maintenance hiccup can't skip consolidation below.
					try {
						// `vaultDir` re-renders the owner's Obsidian-style markdown vault
						// AFTER a pass that actually changed facts (change-gated inside the
						// curator; filesystem mode only) — preserving any human-pinned edits.
						runCurator(new FactStore(workspaceDir), {
							dream: { evictMinAgeMs: Number.POSITIVE_INFINITY },
							vaultDir: joinPath(workspaceDir, "memory-vault"),
						});
					} catch (curErr) {
						opts.consoleStream?.info?.(
							`memory curator error (agent=${targetAgentId}): ${curErr instanceof Error ? curErr.message : String(curErr)}`,
						);
					}
					// Skill curator (maintenance half) — pure, cheap aging of agent-created
					// skills (active→stale→archived, reversible). Own try/catch so a hiccup
					// can't skip the consolidation below.
					if (skillCuratorEnabled) {
						try {
							const sc = runSkillCurator({
								skillsRoot: joinPath(workspaceDir, "skills"),
								staleAfterDays: skillStaleDays,
								archiveAfterDays: skillArchiveDays,
							});
							if (sc.archived || sc.markedStale || sc.reactivated) {
								opts.consoleStream?.info?.(
									`skill curator (agent=${targetAgentId}): ${sc.markedStale} stale, ${sc.archived} archived, ${sc.reactivated} reactivated`,
								);
							}
						} catch (scErr) {
							opts.consoleStream?.info?.(
								`skill curator error (agent=${targetAgentId}): ${scErr instanceof Error ? scErr.message : String(scErr)}`,
							);
						}
					}
					// Lean semantic consolidation (1 LLM call) per agent — THROTTLED
					// per-workspace via shouldRunConsolidation's mtime gate, so each
					// agent's workspace tracks its own consolidation cadence.
					const envInterval = Number(process.env.BRIGADE_CONSOLIDATE_INTERVAL_MS);
					const consolidateInterval =
						Number.isFinite(envInterval) && envInterval >= 0 ? envInterval : undefined;
					if (shouldRunConsolidation(workspaceDir, consolidateInterval)) {
						const consolidateLlm = makeConsolidationLlm({
							workspaceDir,
							agentDir,
							authStorage: agentAuth,
							modelRegistry,
							model: agentModel,
						});
						try {
							await runConsolidation({ workspaceDir, llm: consolidateLlm });
						} catch (mcErr) {
							// Best-effort: a throw here must NOT skip markConsolidationRun below
							// (else the throttle never stamps and a full LLM consolidation
							// re-fires every drain). Its own LLM failure is already swallowed
							// inside runConsolidation; this catches an fs/store throw.
							opts.consoleStream?.info?.(
								`memory consolidation error (agent=${targetAgentId}): ${mcErr instanceof Error ? mcErr.message : String(mcErr)}`,
							);
						}
						// Skill consolidation (umbrella-building) rides the SAME throttle —
						// merges overlapping auto-learned skills into class-level keepers
						// (owner workspace; reuses append + archive; reversible). Own
						// try/catch so a hiccup can't skip the throttle stamp below.
						if (skillCuratorEnabled) {
							try {
								const scResult = await runSkillConsolidation({
									skillsRoot: joinPath(workspaceDir, "skills"),
									llm: makeSkillConsolidationLlm({
										workspaceDir,
										agentDir,
										authStorage: agentAuth,
										modelRegistry,
										model: agentModel,
									}),
								});
								if (scResult.merged || scResult.pruned) {
									// Surface the rename-map ("where did my skill go") + that a
									// rollback snapshot was saved, so a surprising merge is legible
									// and reversible.
									const renameMap = scResult.appliedMerges
										.map((m) => `${m.folded.join("+")}→${m.keeper}`)
										.join(", ");
									opts.consoleStream?.info?.(
										`skill consolidation (agent=${targetAgentId}): ${scResult.merged} merged, ${scResult.pruned} pruned` +
											(renameMap ? ` [${renameMap}]` : "") +
											(scResult.appliedPrunes.length ? `; pruned ${scResult.appliedPrunes.join(", ")}` : "") +
											(scResult.snapshotPath ? " (rollback snapshot saved)" : ""),
									);
								}
							} catch (scErr) {
								opts.consoleStream?.info?.(
									`skill consolidation error (agent=${targetAgentId}): ${scErr instanceof Error ? scErr.message : String(scErr)}`,
								);
							}
						}
						markConsolidationRun(workspaceDir);
					}
				} catch (err) {
					// Best-effort — extraction never affects the user-facing turn.
					opts.consoleStream?.info?.(
						`memory extraction error (agent=${targetAgentId}): ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				} finally {
					// Only clear the flag if THIS sweep still owns it. If the watchdog
					// force-cleared us and a newer sweep took over, leave the newer sweep's
					// flag intact rather than deleting it out from under it (which would let
					// a third sweep start concurrently).
					if (extractingToken.get(targetAgentId) === sweepToken) {
						extractingAgents.delete(targetAgentId);
						extractingSince.delete(targetAgentId);
						extractingToken.delete(targetAgentId);
					}
				}
			}),
		);
	};

	/** Schedule an off-hot-path extraction sweep for the agent that owns `sessionId`. */
	const scheduleExtraction = (result: {
		/** Routed agent id — defaults to the boot agent for single-agent callers. */
		agentId?: string;
		sessionId: string;
		messages: unknown[];
		/** Turn's owner verdict (undefined ⇒ owner: TUI / direct RPC). */
		senderIsOwner?: boolean;
		channelApprovalRoute?: { channelId: string; conversationId: string; accountId?: string };
		sessionKey: string;
	}): void => {
		if (!memoryExtractEnabled || serverStopped) return;
		// Resolve the SAFE origin for the facts this sweep will write — fail CLOSED,
		// exactly like auto-recall and the write_memory tool: an owner turn ⇒ owner
		// scope; a channel-routed peer ⇒ the peer's channel scope (isolated); a
		// non-owner turn with NO route ⇒ undefined ⇒ SKIP extraction entirely (never
		// author owner-attributed facts from an unidentified peer).
		const origin = resolveAutoRecallOrigin({
			senderIsOwner: result.senderIsOwner ?? true,
			...(result.channelApprovalRoute ? { channelApprovalRoute: result.channelApprovalRoute } : {}),
			sessionKey: result.sessionKey,
		});
		if (!origin) return;
		// Owner extraction stays untyped (trusted, as before); peer-derived facts are
		// tagged channel_message — honest provenance + the write-gate's documented
		// "isolated-by-origin" trust model.
		const sourceType: MemorySourceType | undefined = origin.kind === "owner" ? undefined : "channel_message";
		const targetAgentId = result.agentId ?? agentId;
		let perAgent = pendingExtracts.get(targetAgentId);
		if (!perAgent) {
			perAgent = new Map<string, ExtractEntry>();
			pendingExtracts.set(targetAgentId, perAgent);
		}
		perAgent.set(result.sessionId, { messages: result.messages, origin, ...(sourceType ? { sourceType } : {}) });
		armExtractTimer();
	};

	// Cumulative usage totals for the state snapshot. Pi reports per-turn
	// usage on turn_end; we accumulate across turns.
	let totalIn = 0;
	let totalOut = 0;
	let totalCost = 0;

	// Snapshot fields that can only be read from a LIVE Pi session
	// (context usage %, message count, thinking capabilities). With no
	// session between turns we cache the last-known values: seeded from the
	// model at boot, refreshed from the in-flight session during each turn.
	let lastContextUsagePercent: number | null = null;
	// Filled once, in the background, shortly after listen. Rides every subsequent
	// state snapshot so an attaching client can ASK the operator. Never acted on here.
	let latestUpdate: { current: string; latest: string } | undefined;
	let lastMessageCount = 0;
	let cachedSupportsThinking = !!args.model.reasoning;
	let cachedThinkingLevels: string[] = deriveThinkingLevels(args.model);

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
			// Assign unconditionally, INCLUDING null. Pi returns null right after a
			// compaction by design (its token estimate needs a fresh response), and a
			// guard that only overwrote non-null values pinned the pre-compaction
			// figure forever: a turn compacted at 889% then reported "usage now 889%".
			// A stale number is worse than no number.
			lastContextUsagePercent = s.getContextUsage()?.percent ?? null;
		} catch {
			/* session torn down — keep last value */
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
	 *
	 * Wave K — accepts an optional `targetAgentId`. When omitted, falls back
	 * to the boot agent's workspace (legacy behaviour). When supplied, reads
	 * THAT agent's IDENTITY.md so a per-binding snapshot shows the right
	 * persona name.
	 */
	const computeAgentName = (targetAgentId?: string): string | undefined => {
		const wsDir = targetAgentId && targetAgentId !== agentId
			? resolveAgentWorkspaceDir(targetAgentId)
			: getBrigadeWorkspaceDir();
		try {
			const identityText = readFileSync(joinPath(wsDir, "IDENTITY.md"), "utf8");
			return extractIdentityName(identityText);
		} catch {
			return undefined;
		}
	};

	const buildSnapshot = (snapshotAgentId?: string): SessionStateSnapshot => {
		// Wave K — per-binding snapshot. When the caller supplies a
		// `snapshotAgentId`, the snapshot reflects THAT agent's runtime entry
		// + workspace-derived persona name + per-agent live-session count, so
		// a TUI bound to a non-boot agent sees its own header rather than the
		// boot agent's stale state. When omitted, falls back to the boot
		// agent's view (legacy behaviour, default broadcast target).
		const targetAgentId = snapshotAgentId?.trim() || agentId;
		const isBoot = targetAgentId === agentId;
		const rt = getAgentRuntime(targetAgentId);
		// Thinking caps are only cached for the boot agent (cached at
		// session-init + refreshed by boot-agent set-model). Non-boot
		// snapshots derive on the fly from the agent's selected model — the
		// derivation is pure + cheap (no I/O).
		const supportsThinking = isBoot ? cachedSupportsThinking : !!rt.model?.reasoning;
		const availableThinkingLevels = isBoot
			? cachedThinkingLevels
			: rt.model ? deriveThinkingLevels(rt.model) : [];
		// Per-binding session targeting: the TUI bound to `targetAgentId`
		// defaults to that agent's canonical session key when nothing else
		// is bound. Falls back to the gateway's boot `sessionKey` for the
		// boot agent to keep legacy unchanged.
		const targetSessionKey = isBoot ? sessionKey : defaultSessionKey(targetAgentId);
		return {
			provider: rt.provider,
			modelId: rt.modelId,
			modelName: rt.model?.name,
			thinkingLevel: rt.thinkingLevel,
			supportsThinking,
			availableThinkingLevels,
			...(latestUpdate ? { updateAvailable: latestUpdate } : {}),
			contextUsagePercent: lastContextUsagePercent,
			totalTokensIn: totalIn,
			totalTokensOut: totalOut,
			totalCostUsd: totalCost,
			// Wave K — per-agent live-session count. Was process-wide before,
			// which lit the boot-agent header as "running" while only a
			// channel-routed turn on agent:ops was busy — leading the operator
			// to route a fresh prompt through the mid-turn steer path which
			// throws.
			isAgentRunning: countActiveLiveSessionsForAgent(targetAgentId) > 0,
			messageCount: lastMessageCount,
			firstRunBootstrap: computeFirstRunBootstrap(),
			agentName: computeAgentName(targetAgentId),
			// Multi-agent visibility: surface the agent id + session key the
			// TUI is bound to so the operator sees `agent main · agent:main:main`
			// next to the model in the header.
			agentId: targetAgentId,
			sessionKey: targetSessionKey,
		};
	};

	/* ──────────────── transport ──────────────── */

	// Phase 6 — Starting HTTP server. Emits the standard
	// "starting HTTP server..." line.
	bootLog("starting HTTP server...");
	const httpServer: HttpServer = createServer();
	// Inbound frame size cap. Without this the `ws` default is 100 MiB PER
	// FRAME — every message is fully buffered then `JSON.parse`'d synchronously
	// on the single event loop (see the `ws.on("message", ...)` handler below),
	// so one oversized frame blocks the loop that also refreshes the heartbeat
	// file in the tick timer; a stalled refresh makes the external supervisor
	// see a wedged gateway and restart it. The per-connection rate limiter
	// bounds the NUMBER of requests, never their SIZE. `maxPayload` makes `ws`
	// reject oversized frames at the protocol layer BEFORE they are buffered or
	// parsed. The cap is sized for the largest legitimate frame (chat history /
	// media snapshots) and is the concrete value the handshake's
	// `HelloOk.policy.maxPayload` field is meant to advertise.
	const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024; // 32 MiB
	// Per-client send-buffer cap. `broadcast()` below checks `ws.bufferedAmount`
	// against this before sending so a live-but-slow consumer (answers PINGs, so
	// the ping reaper never reaps it, but can't drain its receive side) does not
	// grow gateway memory without bound under a busy turn. This is the concrete
	// value the handshake's `HelloOk.policy.maxBufferedBytes` field advertises;
	// at 2× the payload cap a client this far behind is a stuck/slow consumer.
	const MAX_WS_BUFFERED_BYTES = 64 * 1024 * 1024; // 64 MiB
	// Optional, opt-in gateway authentication (see core/gateway-auth.ts).
	// DEFAULT — no tokens configured — resolves to `required:false`, so the
	// gateway stays unauthenticated + localhost-only exactly as before; this
	// feature NEVER changes behaviour until the operator sets
	// `gateway.auth.tokens` (or the BRIGADE_GATEWAY_TOKENS env var). When tokens
	// ARE present we install a `verifyClient` gate that rejects the WS upgrade
	// with 401 unless a valid token rides in via `Authorization: Bearer`,
	// `x-brigade-token`, or `?token=`. We gate ONLY the WS control surface (every
	// connection is granted operator scope) — NOT the HTTP routes, which carry
	// inbound channel webhooks that must stay reachable. Resolved once at boot;
	// token changes take effect on the next gateway start.
	const gatewayAuth = resolveGatewayAuth(loadConfig().gateway?.auth, process.env);
	const wssOptions: WsServerOptions = { server: httpServer, maxPayload: MAX_WS_PAYLOAD_BYTES };
	if (gatewayAuth.required) {
		wssOptions.verifyClient = (info: { req: IncomingMessage }) =>
			matchesAnyToken(gatewayAuth.tokens, extractToken(info.req.url, info.req.headers));
	}
	const wss = new WebSocketServer(wssOptions);
	if (gatewayAuth.required) {
		bootLog(
			`authentication enabled — clients must present a valid token (${gatewayAuth.tokens.length} configured)`,
		);
	}

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
	/**
	 * P1#3 (Wave H) — per-client subscription filter. Each connected client
	 * gets a unique `connId`, registered in `clientConnIds`. A client opts
	 * into one or more agentIds via `subscribeAgent`; when no subscriptions
	 * are recorded (legacy single-agent TUI) the client receives every
	 * event (default-deny would break existing clients).
	 *
	 * Subscriptions are scoped to the connection — `ws.on("close")` drops
	 * them. The filter is consulted by `broadcast()` when the payload
	 * carries an `agentId` and/or `sessionId`. Today only the approval
	 * router, pi events, and log events thread those fields; future
	 * subscribers can opt into per-session filtering on top.
	 */
	const clientConnIds = new WeakMap<WebSocket, string>();
	const clientAgentSubs = new Map<string, Set<string>>();
	const clientSessionSubs = new Map<string, Set<string>>();

	/**
	 * Per-session monotonic sequence for the ordered, recoverable stream.
	 * `broadcast` stamps the next value onto every ORDERED frame tagged with a
	 * sessionId (= sessionKey): top-level `pi`, `approval-request`, and
	 * `system-event` (they SHARE one counter per session, so a client detects a
	 * gap in any of them and `resume`s). A client tracks the last seq it saw per
	 * session; a jump means it missed a frame. `resume` returns the current value
	 * as `headSeq`. One int per session — negligible; never pruned so a session's
	 * seq stays monotonic across turns. A gateway restart resets these to 0 — the
	 * client detects that via the `epoch` change on its next `HelloOk` and
	 * invalidates its cursor.
	 */
	const seqCounters = new Map<string, number>();

	/**
	 * Bounded per-session tail of recent `system-event` notices (cron announces /
	 * channel-health), so a client that was disconnected when one fired can still
	 * recover it via `resume`. Oldest-first, capped at RECENT_SYSTEM_EVENTS_MAX.
	 */
	const recentSystemEvents = new Map<string, EventPayload["system-event"][]>();
	const RECENT_SYSTEM_EVENTS_MAX = 30;
	// Cap how many transcript messages `resume` ships. A thread can grow to
	// thousands of messages; replaying ALL of them on every connect/reconnect/
	// resync would re-read + re-parse the whole JSONL synchronously and ship a
	// huge frame (risking the 32 MiB payload cap). Bound it to the recent tail —
	// the operator lands back in context without the cost scaling with thread
	// length. (Lazy-loading older history on scroll is a later enhancement.)
	const RESUME_TRANSCRIPT_MAX = 200;
	// Cap how many DISTINCT sessions we retain recovery state for. `seqCounters`
	// and `recentSystemEvents` would otherwise grow unbounded over a multi-day
	// daemon (every cron run, channel thread, sub-agent child key, and `/new`
	// mints a fresh key that never gets evicted). LRU-evict the coldest sessions
	// past this bound — safe because the durable transcript is the source of
	// truth: an evicted session simply rebuilds from disk on its next `resume`,
	// and a re-touched seq counter restarting at 0 only triggers a harmless
	// resync on any client still watching it.
	const RECOVERY_SESSION_MAX = 512;
	const evictColdRecoverySessions = (): void => {
		// JS Maps iterate in insertion order. The recentSystemEvents write below
		// moves a touched key to the end (delete+set), so its FIRST keys are the
		// least-recently-used; seqCounters evicts in creation order. Either way the
		// durable transcript is the source of truth, so eviction is safe — an
		// evicted session rebuilds from disk on its next `resume`, and a re-touched
		// seq counter restarting at 0 only makes a still-connected client issue one
		// harmless self-healing resync.
		while (recentSystemEvents.size > RECOVERY_SESSION_MAX) {
			const oldest = recentSystemEvents.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			recentSystemEvents.delete(oldest);
		}
		while (seqCounters.size > RECOVERY_SESSION_MAX) {
			const oldest = seqCounters.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			seqCounters.delete(oldest);
		}
	};

	/**
	 * Process boot id (session generation / "epoch"). Constant for this gateway
	 * process; a restart yields a new value. Advertised in `HelloOk` so a client
	 * can tell a restart (→ invalidate seq cursors) from a normal reconnect.
	 */
	const gatewayEpoch = crypto.randomUUID();

	const subscribeAgent = (connId: string, agentIdValue: string): void => {
		let set = clientAgentSubs.get(connId);
		if (!set) {
			set = new Set();
			clientAgentSubs.set(connId, set);
		}
		set.add(agentIdValue);
	};
	const unsubscribeAgent = (connId: string, agentIdValue: string): void => {
		clientAgentSubs.get(connId)?.delete(agentIdValue);
	};
	const subscribeSession = (connId: string, sessionIdValue: string): void => {
		let set = clientSessionSubs.get(connId);
		if (!set) {
			set = new Set();
			clientSessionSubs.set(connId, set);
		}
		set.add(sessionIdValue);
	};
	const unsubscribeSession = (connId: string, sessionIdValue: string): void => {
		clientSessionSubs.get(connId)?.delete(sessionIdValue);
	};

	/**
	 * Filter predicate: should `connId` receive an event tagged with the
	 * supplied agent/session ids? Delegates to the pure helper in
	 * `ws-subscription-filter.ts` so the behaviour is exercised by a focused
	 * unit test without spinning a live WS server.
	 */
	const connWantsFrame = (
		connId: string,
		frameAgentId: string | undefined,
		frameSessionId: string | undefined,
	): boolean =>
		shouldDeliverFrame(
			clientAgentSubs.get(connId),
			clientSessionSubs.get(connId),
			{ agentId: frameAgentId, sessionId: frameSessionId },
		);

	/** Send one event to all connected clients (or a filtered subset). */
	const broadcast = <K extends EventName>(event: K, payload: EventPayload[K]): void => {
		// Untagged payloads broadcast to everyone (state, error, basic log).
		// Tagged payloads (pi, log with agent/session, approval-request,
		// system-event with target) consult the subscription filter so the
		// approval prompt for agent A doesn't pop on operator B's TUI.
		const { agentId: frameAgentId, sessionId: frameSessionId } = extractFrameTags(payload);
		// Stamp a per-session monotonic seq on the ordered transcript stream
		// (`pi`). This is the gap detector: a client that sees seq jump knows it
		// missed a frame and issues `resume`. Only `pi` frames carry seq — they
		// are the transcript; state/error/log are unordered side-channels a
		// client never gap-checks. Same `json` goes to every subscriber, so the
		// seq is shared across all clients watching this session.
		//
		// The ordered, recoverable stream = top-level `pi` + `approval-request` +
		// `system-event`, sharing one per-session counter so a client detects a
		// gap in ANY of them and `resume`s. EXCLUDED (no seq):
		//  - sub-agent `pi` frames (subagentDepth>0): they carry the child's own
		//    session id (a UUID) and live in a separate child transcript the
		//    parent's `resume` can't backfill — ephemeral nested decoration.
		//  - SYNTHETIC `pi` frames: the tool events Brigade mints for a claude-cli
		//    turn (its tools run in the binary's loop, via the MCP route). They are
		//    not in the JSONL transcript, so `resume` cannot replay them; seq-stamping
		//    them would make a dropped decoration frame look like a real gap and
		//    thrash resume. Same category as sub-agent frames.
		//  - `state` (self-healing cumulative snapshot), `error`, `log` (on disk).
		const subDepth = event === "pi" ? Number((payload as { subagentDepth?: number }).subagentDepth) || 0 : 0;
		const isSyntheticPi = event === "pi" && (payload as { synthetic?: boolean }).synthetic === true;
		const isOrderedFrame =
			(event === "pi" && subDepth === 0 && !isSyntheticPi) ||
			event === "approval-request" ||
			event === "system-event";
		const seq = isOrderedFrame ? nextSeq(seqCounters, frameSessionId) : undefined;
		// Retain a bounded per-session tail of system-events for `resume` recovery.
		// delete+set moves this session to the end of the Map (LRU touch) so the
		// eviction sweep below drops the least-recently-active sessions first.
		if (event === "system-event" && frameSessionId) {
			const ring = recentSystemEvents.get(frameSessionId) ?? [];
			ring.push(payload as EventPayload["system-event"]);
			while (ring.length > RECENT_SYSTEM_EVENTS_MAX) ring.shift();
			recentSystemEvents.delete(frameSessionId);
			recentSystemEvents.set(frameSessionId, ring);
		}
		// Bound the recovery maps so a long-lived daemon that touches many
		// distinct session keys (cron runs, channel threads, sub-agent children,
		// `/new`) doesn't grow them without limit.
		if (isOrderedFrame && frameSessionId) evictColdRecoverySessions();
		const frame: Frame =
			seq !== undefined
				? { type: "event", event, payload, seq }
				: { type: "event", event, payload };
		const json = JSON.stringify(frame);
		for (const ws of clients) {
			if (ws.readyState !== ws.OPEN) continue;
			// Slow-consumer backpressure. A client that keeps answering
			// protocol-level PINGs (so the ping reaper never reaps it) but
			// can't drain its receive side accumulates every broadcast in its
			// send buffer without bound — `broadcast` fires on every Pi event
			// mid-turn. When the buffered bytes exceed the cap, close the
			// socket (1008 = policy violation) and drop the client instead of
			// growing gateway memory. The `close` handler removes it from
			// `clients` + the subscription maps.
			if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
				try {
					ws.close(1008, "slow consumer");
				} catch {
					/* best-effort — socket may already be closing */
				}
				continue;
			}
			const connId = clientConnIds.get(ws);
			// No connId yet (race between socket open + onConnection assign):
			// best-effort send (matches old behaviour).
			//
			// `ws.send` is wrapped because the `readyState === OPEN` check
			// above narrows but does not fully eliminate the window — a socket
			// can transition state between the check and the send. Most
			// not-OPEN sends surface as an async `'error'` event (handled by
			// `ws.on("error")`) rather than a synchronous throw, so an escaping
			// throw is unlikely, but the swallow keeps a hot broadcast path
			// (Pi events, tick, cron) from ever crashing on one bad socket —
			// matching the try-wrapped `ws.ping()` in the reaper below.
			if (!connId) {
				try {
					ws.send(json);
				} catch {
					/* best-effort — drop send to a transitioning socket */
				}
				continue;
			}
			if (connWantsFrame(connId, frameAgentId, frameSessionId)) {
				try {
					ws.send(json);
				} catch {
					/* best-effort — drop send to a transitioning socket */
				}
			}
		}
	};

	/**
	 * Wave K — fan out a state snapshot to every binding. Sends the boot-agent
	 * snapshot (untagged → reaches legacy un-subscribed clients) PLUS one
	 * tagged snapshot per distinct non-boot agentId any connected client is
	 * subscribed to. The per-conn filter delivers each tagged frame only to
	 * that agent's subscribers — so a TUI bound to `agent:ops` sees `ops`'s
	 * header while an un-bound TUI keeps seeing the boot header.
	 */
	const broadcastStateAllBindings = (): void => {
		const seen = new Set<string>();
		for (const subs of clientAgentSubs.values()) {
			for (const id of subs) {
				if (id && id !== agentId) seen.add(id);
			}
		}
		broadcast("state", buildSnapshot());
		for (const id of seen) {
			broadcast("state", buildSnapshot(id));
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
			// P1#3 (Wave H): forward agent/session ids so the per-client
			// subscription filter can route the prompt to the operator
			// watching THIS agent's turn — and not surface it to a TUI
			// connected only to a different agent.
			...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
			...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
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
				// Wave I — tag the broadcast with the routed agent + session so
				// the per-client subscription filter delivers the system-event
				// only to operators watching THIS agent. Falls back to the
				// gateway's boot defaults for legacy un-tagged cron jobs.
				const cronTargetAgentId = args.agentId ?? agentId;
				const cronTargetSessionKey =
					args.sessionKey ?? defaultSessionKey(cronTargetAgentId);
				broadcast("system-event", {
					text: args.text,
					at,
					source: args.source ?? "cron",
					...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
					...(args.jobName !== undefined ? { jobName: args.jobName } : {}),
					...(args.delivered !== undefined ? { delivered: args.delivered } : {}),
					agentId: cronTargetAgentId,
					sessionId: cronTargetSessionKey,
				});
				// TRACK 2 — model awareness. Queue the text in the SESSION INBOX
				// (`agents/session-inbox.ts`) — the queue the heartbeat runner
				// peeks/consumes. The cron timer follows its enqueue with a
				// `requestHeartbeatNow` wake; the runner inspects this inbox and
				// dispatches a synthetic turn that receives the event text as its
				// message, so the agent ACTS on the reminder at fire time (e.g.
				// sends the WhatsApp message) instead of the text sleeping until
				// the operator happens to type. This used to write to
				// `pending-system-events.ts` (Track 2's original cron-only queue)
				// — a queue the runner never reads — so every wake was skipped
				// "no-pending-events" and main-target reminders only ever
				// piggybacked on the operator's next message. Real turns drain
				// the session inbox at turn start too (`drainFormattedSessionEvents`
				// in agent-loop.ts), so the catch-up path this write used to serve
				// is preserved.
				const targetSessionKey = args.sessionKey ?? defaultSessionKey(args.agentId ?? agentId);
				const attribution =
					args.jobName && !args.text.startsWith("[cron ")
						? `[cron "${args.jobName}"] ${args.text}`
						: args.text;
				enqueueSessionInboxEvent(attribution, {
					sessionKey: targetSessionKey,
					...(args.jobId !== undefined ? { contextKey: `cron:${args.jobId}` } : {}),
					trusted: true,
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
			 * Idle channel-thread TTL for the session-reaper's thread sweep — read
			 * live from `channels.telegram.threadIdleTtlMs` (Telegram forum topics)
			 * or, when that's unset, `channels.slack.threadIdleTtlMs` (Slack threads)
			 * so an idle threaded session gets aged out. `null` (default / unset)
			 * leaves thread sessions untouched; the isolated-cron-run reaper is
			 * unaffected.
			 */
			resolveThreadIdleTtlMs: () => {
				try {
					// `loadConfig` is synchronous + cheap; reading fresh keeps the TTL
					// live across config reloads without threading a mutable holder.
					const cfg = loadConfig() as never;
					return (
						telegramThreadIdleTtlMs(cfg) ??
						slackThreadIdleTtlMs(cfg) ??
						discordThreadIdleTtlMs(cfg) ??
						imessageThreadIdleTtlMs(cfg) ??
						bluebubblesThreadIdleTtlMs(cfg)
					);
				} catch {
					return null;
				}
			},
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
				//
				// Routes through the wake layer (`requestHeartbeatNow` from
				// `heartbeat-wake.ts`) so the cron-fire path uses the SAME
				// three-tier gate (enabled flag → per-session lane → live
				// session) as the scheduler-driven interval wakes. The
				// firedHook installed below turns the consumed events into a
				// `runGatewayTurn` dispatch — single canonical synthetic-turn
				// path instead of two parallel runners.
				const targetAgentId = opts?.agentId?.trim() || agentId;
				const targetSessionKey = opts?.sessionKey?.trim() || defaultSessionKey(targetAgentId);
				try {
					requestHeartbeatNow({
						reason: opts?.reason ?? "cron-wake",
						agentId: targetAgentId,
						sessionKey: targetSessionKey,
					});
				} catch {
					/* best-effort wake; the runner logs its own failures */
				}
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
						// Wave I — tag with the cron job's agent + session so the
						// per-client subscription filter delivers the failure only
						// to the operator watching this agent. Falls back to the
						// gateway's boot default for legacy un-tagged jobs.
						const failureAgentId = args.job.agentId ?? agentId;
						const failureSessionKey =
							args.job.sessionKey ?? defaultSessionKey(failureAgentId);
						broadcast("system-event", {
							text: failureText,
							at,
							source: "cron",
							jobId: args.job.id,
							jobName: args.job.name,
							agentId: failureAgentId,
							sessionId: failureSessionKey,
						});
						// Route to the agent that scheduled the cron job (multi-
						// agent). Falls back to the boot agent for legacy jobs
						// missing `agentId`. Mirrors the enqueueSystemEvent
						// resolution above — `job.sessionKey` (explicit override)
						// wins over `agentId → defaultSessionKey()`.
						enqueuePendingSystemEvent(
							args.job.sessionKey ?? defaultSessionKey(args.job.agentId ?? agentId),
							{
								text: failureText,
								queuedAtMs: at,
								jobId: args.job.id,
								jobName: args.job.name,
							},
						);
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
					// Wave I — tag with the cron job's agent + session so the
					// per-client subscription filter delivers the send-failure
					// only to the operator watching this agent.
					const sendFailureAgentId = args.job.agentId ?? agentId;
					const sendFailureSessionKey =
						args.job.sessionKey ?? defaultSessionKey(sendFailureAgentId);
					broadcast("system-event", {
						text: failureText,
						at,
						source: "cron",
						jobId: args.job.id,
						jobName: args.job.name,
						agentId: sendFailureAgentId,
						sessionId: sendFailureSessionKey,
					});
					// Same multi-agent routing as the health-check branch above.
					enqueuePendingSystemEvent(
						args.job.sessionKey ?? defaultSessionKey(args.job.agentId ?? agentId),
						{
							text: failureText,
							queuedAtMs: at,
							jobId: args.job.id,
							jobName: args.job.name,
						},
					);
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

	/**
	 * Map from sessionKey → currently-running Pi session. Each entry's
	 * presence here is what abort / steer / compact / set-thinking-live /
	 * switch-model-mid-turn look up (keyed by RPC sessionKey). Replaces the
	 * old `inFlightSession` module-level singleton, which clobbered when two
	 * concurrent peer turns overlapped.
	 *
	 * Wire owner: `attachTurnSession` adds an entry as the session is built;
	 * the cleanup returned by `attachTurnSession` removes it. Two distinct
	 * peer turns therefore each carry their own entry under their own key.
	 */
	const liveSessionsByKey = new Map<string, AgentSession>();

	// Wire a fresh per-turn Pi session into the gateway's broadcast +
	// logging plumbing. Called from the `prompt` handler's `onSessionReady`
	// the moment `runResilientTurn` finishes constructing the session (after
	// persona injection + guard install, before the model call). Returns a
	// cleanup that detaches both the Pi subscription and the JSONL logger;
	// the prompt handler calls it when the turn settles so nothing leaks
	// across turns (the per-turn mirror — no subscription outlives its turn).
	//
	// Wave I — `agentIdForTurn` is captured into the per-event broadcast
	// payload so the per-client subscription filter (`connWantsFrame`) routes
	// Pi events to the operator watching THIS agent only. Falls back to the
	// gateway's boot-default agent id when omitted (legacy single-agent path).
	const attachTurnSession = (
		session: AgentSession,
		sessionKeyForTurn: string,
		agentIdForTurn: string,
	): (() => void) => {
		liveSessionsByKey.set(sessionKeyForTurn, session);
		// Stream this turn's Pi events to the JSONL log file. Logger silently
		// degrades on I/O errors so log loss never crashes the server.
		const detachLogger = attachEventLogger(session);
		const detachPi = session.subscribe((piEvent: AgentSessionEvent) => {
			// NOTE: per-turn liveness is tracked in the session-registry, NOT
			// by Pi's per-run agent_start/agent_end. A single logical turn fires
			// multiple `session.prompt()` runs (content-quality retry, thinking-
			// fallback, max_tokens continuations), each emitting its own
			// agent_start/agent_end. Toggling registry state here would flap it
			// false mid-turn, flicker the connect header, and re-open the
			// single-turn concurrency guard. We only forward the events.
			if (piEvent.type === "turn_end") {
				const usage = (piEvent as any).message?.usage;
				if (usage) {
					totalIn += usage.input ?? 0;
					totalOut += usage.output ?? 0;
					totalCost += ((c) => (typeof c?.total === "number" && Number.isFinite(c.total) && c.total > 0 ? c.total : 0))(usage.cost as { total?: number } | undefined); // .total only; ignore the -1 sentinel of an unpriced model
				}
			}
			// Keep the between-turns snapshot caches (message count, context
			// usage %, thinking caps) tracking the live session.
			refreshCachesFromSession(session);
			// Live console stream (verbose mode). Mirrors the JSONL file but
			// human-readable. Same event sequence in both places.
			opts.consoleStream?.pi(piEvent);
			// Wave I — tag every broadcast frame with the routed agentId +
			// sessionId so `connWantsFrame` routes pi events to the operator
			// watching THIS agent's turn only. Untagged frames fall through
			// to the back-compat "broadcast to everyone" branch.
			broadcast("pi", {
				event: piEvent,
				agentId: agentIdForTurn,
				sessionId: sessionKeyForTurn,
			});
			broadcastStateAllBindings();
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
			if (liveSessionsByKey.get(sessionKeyForTurn) === session) {
				liveSessionsByKey.delete(sessionKeyForTurn);
			}
		};
	};

	/**
	 * OPTIONAL live-streaming delta forwarder. Subscribes to the SAME Pi session
	 * `attachTurnSession` watches, but extracts only the accumulating assistant
	 * ANSWER text from each `message_update` and forwards it to the channel's
	 * `onReplyDelta` sink so the channel can progressively edit its message. The
	 * `<think>` reasoning is stripped here with the same sanitizer the final
	 * reply uses, so a stream never leaks reasoning into a channel preview.
	 *
	 * When `sink` is undefined (TUI / cron / sub-agent / RPC callers) this is a
	 * no-op that returns an inert detach — those turns never stream.
	 */
	const attachReplyDeltaForwarder = (
		session: AgentSession,
		sink: ((accumulatedText: string) => void) | undefined,
	): (() => void) => {
		if (!sink) return () => {};
		const detach = session.subscribe((piEvent: AgentSessionEvent) => {
			if (piEvent.type !== "message_update" && piEvent.type !== "message_end") return;
			const message = (piEvent as { message?: { role?: string; content?: unknown } }).message;
			if (!message || message.role !== "assistant") return;
			const raw = flattenAssistantContent(message.content);
			if (!raw) return;
			// Strip reasoning so the live preview shows only the answer-in-progress.
			const answer = sanitizeReplyForChannel(raw);
			if (answer) {
				try {
					sink(answer);
				} catch {
					/* a misbehaving sink must never break the turn */
				}
			}
		});
		let cleaned = false;
		return () => {
			if (cleaned) return;
			cleaned = true;
			try {
				detach();
			} catch {
				/* session may already be torn down */
			}
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
		// Depth-0 Pi events already go out via `attachTurnSession`'s direct
		// subscribe, so forwarding them here would duplicate every frame. The one
		// exception is a SYNTHETIC event: Brigade minted it (the claude-cli tool
		// events), Pi never saw it, so `attachTurnSession` will never broadcast it.
		const isSynthetic = event.synthetic === true;
		if (!isSynthetic && (!event.subagentDepth || event.subagentDepth <= 0)) return;
		// The operator's terminal, too — not just attached WS clients.
		//
		// `opts.consoleStream.pi()` is wired inside `attachTurnSession`, and that is
		// only ever called for a DEPTH-0 gateway turn. So a `spawn_agent` that ran for
		// 57 seconds printed nothing between "sub-agent starting" and "sub-agent
		// settled": the gateway looked wedged while a whole child turn was streaming.
		if (event.subagentDepth && event.subagentDepth > 0) {
			opts.consoleStream?.pi(event.piEvent as AgentSessionEvent, event.subagentDepth);
		}
		// Wave I — forward the parent's agentId + sessionId from the bus
		// event so child pi frames carry the same routing tags as the
		// top-level pi frames; the operator's subscription filter applies
		// identically to top-level and sub-agent events.
		broadcast("pi", {
			event: event.piEvent,
			...(event.subagentDepth ? { subagentDepth: event.subagentDepth } : {}),
			...(isSynthetic ? { synthetic: true } : {}),
			agentId: event.agentId,
			sessionId: event.sessionId,
		});
	});

	// Lifecycle bus subscriber (Phase 5b): translate `runBrigadeTurnLoop`
	// events into broadcast("log", ...) frames so connect-mode TUI clients
	// see the same status messages the inline composition used to emit.
	//
	// Wave I — each loop-lifecycle bus event carries the agent + session it
	// fired against (added in agent-event-bus.ts variants + agent-loop emit
	// sites). Forward those onto the `log` payload so `connWantsFrame` routes
	// the status line to the operator watching THIS agent/session only.
	const tagsFor = (event: {
		agentId?: string;
		sessionKey?: string;
	}): { agentId?: string; sessionId?: string } => {
		const out: { agentId?: string; sessionId?: string } = {};
		if (event.agentId !== undefined) out.agentId = event.agentId;
		if (event.sessionKey !== undefined) out.sessionId = event.sessionKey;
		return out;
	};
	const detachLifecycleBus = onAgentEvent((event) => {
		switch (event.type) {
			case "turn-heartbeat":
				broadcast("log", {
					level: "info",
					message: `still working… ${Math.round(event.elapsedMs / 1000)}s elapsed`,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-stream-timeout":
				broadcast("log", {
					level: "warn",
					message: `no response for ${Math.round(event.idleMs / 1000)}s — aborting`,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-length-continue":
				broadcast("log", {
					level: "info",
					message: "reply was truncated — asking the model to continue",
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-content-retry":
				broadcast("log", {
					level: "info",
					message: `${event.reason} — re-prompting for a usable answer`,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-thinking-downgrade":
				broadcast("log", {
					level: "info",
					message: `model doesn't support thinking — switching from ${event.from} to off and retrying`,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-fallback-attempt":
				broadcast("log", {
					level: "warn",
					message: `primary failed (${event.reason}) — trying ${event.toModelId ?? "fallback"}`,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-fallback-exhausted":
				broadcast("log", {
					level: "error",
					message: `all fallback models failed: ${event.reason}`,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-retry-attempt":
				broadcast("log", {
					level: event.errorClass === "context_overflow" ? "info" : "warn",
					message: event.reason,
					at: Date.now(),
					...tagsFor(event),
				});
				break;
			case "turn-compact-before-retry":
				broadcast("log", {
					level: "info",
					message: "context overflow — compacting then retrying same model",
					at: Date.now(),
					...tagsFor(event),
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
					// Wave I — tool-blocked carries `agentId` directly + sessionKey
					// via the optional Wave I extension; route accordingly.
					...(event.agentId ? { agentId: event.agentId } : {}),
					...(event.sessionKey !== undefined ? { sessionId: event.sessionKey } : {}),
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
	// matches the reference's `enqueueCommandInLane` model and is what unblocks the
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
		/**
		 * OPTIONAL inbound IMAGE blocks to send INLINE with this turn's user
		 * message (A3 — "auto-see inbound images"). Each is `{ data: <raw
		 * base64>, mimeType }` (a Pi `ImageContent` minus the literal tag). Set
		 * ONLY by the channel inbound pipeline when an inbound carried image
		 * attachments; forwarded into `runResilientTurn` → `runSingleTurn`,
		 * which attaches them to `session.prompt` ONLY when the resolved model
		 * is vision-capable. Always undefined for TUI / cron / sub-agent / RPC
		 * callers, so their turn is byte-identical (string-only prompt).
		 */
		images?: ReadonlyArray<{ data: string; mimeType: string }>;
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
		/**
		 * Per-group / per-sender tool policy for THIS turn. Set ONLY by the
		 * channel inbound pipeline for GROUP messages that resolved a policy
		 * (`resolveChannelGroupToolsPolicy`), threaded here via the channel
		 * manager's `runTurn(turn)` bridge. Forwarded into `runResilientTurn`
		 * → `runSingleTurn` → `assembleBrigadeToolset`, where it narrows the
		 * per-turn toolset by name (allow ∪ alsoAllow, then deny wins) ON TOP
		 * of the `ownerOnly` wrapping — it can only REMOVE tools. Always
		 * undefined for TUI / cron / sub-agent / direct-RPC / DM turns and any
		 * group without a configured policy, so their toolset is unchanged.
		 */
		toolPolicy?: GroupToolPolicyConfig;
		/**
		 * OPTIONAL live-streaming delta sink. When a channel turn opts into
		 * progressive delivery (e.g. Telegram `liveStream: true`), the channel
		 * manager passes this callback; the gateway forwards the ACCUMULATED
		 * assistant answer text on every Pi `message_update` so the channel can
		 * edit its in-progress message. Always undefined for TUI / cron / sub-
		 * agent / RPC callers, so their delivery is byte-unchanged. The final
		 * reply is still returned in `RunSingleTurnResult.reply` (the channel's
		 * final-only fallback path stays authoritative).
		 */
		onReplyDelta?: (accumulatedText: string) => void;
	}): Promise<RunSingleTurnResult> => {
		// Pick the lane:
		//   - The BOOT operator's primary session (`agent:<bootAgentId>:main`)
		//     lands on the global `Main` lane — TUI / direct-RPC callers +
		//     heartbeat turns for that single session share that FIFO.
		//   - EVERY other shape (other-agent primary sessions like
		//     `agent:ops:main`, channel-routed peers, sub-agent children,
		//     cron sessions, A2A targets) lands on its own per-session lane
		//     so concurrent agents / peers run in parallel rather than
		//     funnelling onto Main. agentId is part of the discriminator —
		//     `rest === "main"` alone would route every agent's primary
		//     session onto Main and force all-agents to share one FIFO.
		const parsedKey = parseAgentSessionKey(turn.sessionKey);
		const isBootMainSession =
			parsedKey !== null &&
			parsedKey.agentId === agentId &&
			parsedKey.rest === "main";
		const lane = isBootMainSession ? CommandLane.Main : sessionLane(turn.sessionKey);
		return runOnLane(lane, async () => {
			// Per-turn cleanup — LOCAL to this invocation. Turn A's onSessionReady
			// (a fallback rebuild inside the same turn) calls THIS cleanup, not a
			// neighbouring turn's. Replaces the old module-level `currentTurnCleanup`
			// singleton that two concurrent turns would clobber.
			//
			// Wrapped in a holder object so the assignment from inside the
			// `onSessionReady` callback doesn't get narrowed away by TS's
			// flow analysis in the `finally` block.
			const turnState: {
				cleanup: (() => void) | null;
				activeSession: AgentSession | null;
			} = { cleanup: null, activeSession: null };
			// Per-turn abort controller registered in session-registry. A graceful
			// shutdown calls `abortAllSessions("shutdown")` which fires every
			// turn's controller in parallel.
			const turnAbortController = new AbortController();
			const targetAgentId = turn.agentId ?? agentId;
			const turnSessionKey = turn.sessionKey;
			const runId = crypto.randomUUID();

			registerLiveSession({
				sessionKey: turnSessionKey,
				sessionId: runId,
				agentId: targetAgentId,
				runId,
				lane,
				abortController: turnAbortController,
			});
			broadcastStateAllBindings();

			// Hoist the abort listener so the finally can detach it without a
			// scope issue (a `const` inside `try` is invisible from `finally`).
			const onAbort = () => {
				turnState.activeSession?.abort().catch(() => {});
			};
			// Also abort the in-flight Pi session when our own per-turn controller
			// fires (e.g. session-registry's `abortAllSessions` during shutdown).
			turnAbortController.signal.addEventListener("abort", onAbort, { once: true });
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

				// Per-agent dispatch: read the target agent's currently-selected
				// model + thinking level from `perAgentRuntime`. Each agent's
				// runtime is mutated independently by set-model / set-thinking,
				// so a turn for `agent:ops` no longer sees mutations meant for
				// `agent:main`.
				const turnRuntime = getAgentRuntime(targetAgentId);
				const turnProvider = turnRuntime.provider;
				const turnModelId = turnRuntime.modelId;
				const turnThinkingLevel = turnRuntime.thinkingLevel;

				// C2: forward the per-agent `workspace` override from cfg so the
				// agent-loop's resolveAgentWorkspaceDir() honours it. Without this,
				// the boot loop seeded perAgentRuntime but the per-turn path always
				// fell back to the default <state>/agents/<id>/workspace path.
				const agentsMapNow = (cfgNow.agents as
					| { [id: string]: { workspace?: unknown } | undefined }
					| undefined) ?? {};
				const perAgentEntryNow = agentsMapNow[targetAgentId];
				const perAgentWorkspace =
					perAgentEntryNow && typeof perAgentEntryNow.workspace === "string"
						? perAgentEntryNow.workspace.trim()
						: "";

				// If a channel inbound passed an AbortSignal, abort the in-flight Pi
				// session when it fires (so `/stop` from the chat actually cancels).
				turn.signal?.addEventListener("abort", onAbort, { once: true });
				const result = await runResilientTurn({
					agentId: targetAgentId,
					provider: turnProvider,
					modelId: turnModelId,
					message: turn.text,
					// A3: forward inbound image blocks (set ONLY by the channel
					// pipeline). runSingleTurn gates them on the resolved model's
					// vision capability; undefined here for TUI / cron / RPC →
					// string-only prompt, byte-identical.
					...(turn.images && turn.images.length > 0 ? { images: turn.images } : {}),
					sessionKey: turn.sessionKey,
					thinkingLevel: turnThinkingLevel as "off" | "low" | "medium" | "high",
					fallbacks,
					signal: turn.signal,
					...(perAgentWorkspace ? { workspaceDir: perAgentWorkspace } : {}),
					// Forward the channel's senderIsOwner verdict (defaults to true
					// when undefined — TUI / direct RPC calls are always operator).
					senderIsOwner: turn.senderIsOwner,
					// Forward the channel approval route (set ONLY for channel-
					// routed inbounds) so exec-gate surfaces approval prompts
					// in the originating chat instead of (only) the WS feed.
					...(turn.channelApprovalRoute !== undefined
						? { channelApprovalRoute: turn.channelApprovalRoute }
						: {}),
					// Forward the per-group/per-sender tool policy (set ONLY for
					// group-message turns that resolved one) so the tool-assembly
					// site narrows this turn's toolset by name. Undefined elsewhere
					// → toolset unchanged.
					...(turn.toolPolicy !== undefined ? { toolPolicy: turn.toolPolicy } : {}),
					onSessionReady: (session) => {
						// A fallback candidate builds a fresh session; tear down the
						// previous candidate's wiring before attaching the new one.
						// IMPORTANT: this only tears down THIS turn's cleanup, never a
						// sibling turn's — `turnState` is a per-invocation local.
						if (turnState.cleanup) turnState.cleanup();
						turnState.activeSession = session;
						const detachStream = attachReplyDeltaForwarder(session, turn.onReplyDelta);
						const detachTurn = attachTurnSession(session, turnSessionKey, targetAgentId);
						turnState.cleanup = () => {
							detachStream();
							detachTurn();
						};
					},
				});
				// Queue a debounced, batched memory-extraction sweep over the settled
				// transcript (off the hot path; see scheduleExtraction). Thread the
				// routed agent id so the sweep runs against the right workspace and
				// uses the right model — boot agent for single-agent callers, the
				// resolved agent for channel-routed multi-agent inbounds.
				scheduleExtraction({
					agentId: targetAgentId,
					sessionId: result.sessionId,
					messages: result.messages,
					// Thread the turn's origin context so peer-derived facts are written
					// to the peer's channel scope, never the operator's (isolation).
					senderIsOwner: turn.senderIsOwner,
					...(turn.channelApprovalRoute !== undefined ? { channelApprovalRoute: turn.channelApprovalRoute } : {}),
					sessionKey: turn.sessionKey,
				});
				return result;
			} finally {
				turn.signal?.removeEventListener("abort", onAbort);
				turnAbortController.signal.removeEventListener("abort", onAbort);
				if (turnState.cleanup) {
					turnState.cleanup();
					turnState.cleanup = null;
				}
				turnState.activeSession = null;
				try {
					unregisterLiveSession(turnSessionKey);
				} catch {
					/* best-effort unregister */
				}
				broadcastStateAllBindings();
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
				// Resolve which agent + sessionKey this RPC targets. When the
				// caller omits both, fall back to the gateway's boot binding —
				// preserving single-agent semantics for legacy callers. When the
				// caller supplies an agentId but no sessionKey, materialise the
				// canonical default for that agent so the per-agent session lane
				// stays consistent across requests.
				const targetAgentId = p.agentId?.trim() || agentId;
				const targetSessionKey =
					p.sessionKey?.trim() ||
					(targetAgentId === agentId ? sessionKey : defaultSessionKey(targetAgentId));
				// Wave O0.6 — access guard. Injecting a turn into another
				// agent's session is equivalent to `sessions.send` from the
				// boot operator's lens: refuse cross-agent prompt RPCs
				// unless the active visibility + A2A policy permits it.
				// Same-key fast-path keeps single-agent / TUI callers
				// flowing through unchanged.
				const promptVerdict = sessionsAccessCheck({
					action: "send",
					targetSessionKey,
				});
				if (!promptVerdict.allowed) {
					const err = new Error(promptVerdict.reason ?? "prompt forbidden");
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				// Wave N4 — no hasLiveSession pre-flight. The session-lane FIFO
				// inside `runGatewayTurn` (sessionLane(turn.sessionKey)) already
				// serialises every prompt on the same session: a second client's
				// prompt for an in-flight session enqueues and runs after the
				// first settles, instead of being rejected with "a turn is
				// already in progress". Different sessionKeys still run
				// concurrently. The legacy reject was UX-only and broke same-
				// session multi-client (e.g. TUI + chat both attached to
				// `agent:main:main`).
				await runGatewayTurn({
					text: p.text,
					sessionKey: targetSessionKey,
					agentId: targetAgentId,
				});
				return undefined as ResponseFor[M];
			}
			case "abort": {
				const p = (params ?? {}) as RequestParams["abort"];
				// Pick the session to abort: explicit sessionKey > agentId-default
				// > boot default. Looks the session up in the registry; if found,
				// abort just THAT session's in-flight Pi session. Harmless no-op
				// when nothing is live.
				const targetKey =
					p?.sessionKey?.trim() ||
					(p?.agentId ? defaultSessionKey(p.agentId.trim()) : sessionKey);
				// Wave O0.5 — access guard. The local-operator WS connection
				// gets a same-key fast-pass for the boot session; cross-agent
				// aborts require visibility="all" + A2A allow.
				const abortVerdict = sessionsAccessCheck({
					action: "abort",
					targetSessionKey: targetKey,
				});
				if (!abortVerdict.allowed) {
					const err = new Error(abortVerdict.reason ?? "abort forbidden");
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const liveSession = liveSessionsByKey.get(targetKey);
				if (liveSession) await liveSession.abort().catch(() => {});
				broadcastStateAllBindings();
				return undefined as ResponseFor[M];
			}
			case "steer": {
				const p = params as RequestParams["steer"];
				const targetKey =
					p.sessionKey?.trim() ||
					(p.agentId ? defaultSessionKey(p.agentId.trim()) : sessionKey);
				// Wave O0.5 — access guard before mutating an in-flight session.
				const steerVerdict = sessionsAccessCheck({
					action: "steer",
					targetSessionKey: targetKey,
				});
				if (!steerVerdict.allowed) {
					const err = new Error(steerVerdict.reason ?? "steer forbidden");
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const liveSession = liveSessionsByKey.get(targetKey);
				if (!liveSession) throw new Error("nothing to steer — no turn in progress");
				await liveSession.steer(p.text);
				broadcastStateAllBindings();
				return undefined as ResponseFor[M];
			}
			case "set-model": {
				const p = params as RequestParams["set-model"];
				// Resolve against the TARGET agent's auth so a per-agent key
				// (e.g. agent:ops has its own anthropic key) is honoured during
				// validation. Boot agent reuses the boot AuthStorage. The previous
				// closure-captured `authStorage` would silently use main's creds
				// for an ops set-model and reject a valid ops key — see Wave B P0#5.
				const targetAgentId = p.agentId?.trim() || agentId;
				// Wave O0.6 — access guard. Mutating another agent's runtime
				// (and persisting that mutation into `cfg.agents.<id>`) is a
				// cross-agent control operation; refuse callers that cannot
				// reach the target's session.
				const setModelVerdict = sessionsAccessCheck({
					action: "send",
					targetSessionKey: defaultSessionKey(targetAgentId),
				});
				if (!setModelVerdict.allowed) {
					const err = new Error(setModelVerdict.reason ?? "set-model forbidden");
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const targetAuth = getAuthStorageForAgent(targetAgentId);
				const target =
					modelRegistry.find(p.provider, p.modelId) ??
					((await resolveModelNeverMiss({
						modelRegistry,
						provider: p.provider,
						modelId: p.modelId,
						modelsFile,
						authStorage: targetAuth,
					})) as Model<string> | undefined);
				if (!target) throw new Error(`model ${p.provider}/${p.modelId} not found`);
				// Mutate ONLY this agent's runtime entry — never spill model
				// changes for one agent onto another's next turn.
				perAgentRuntime.set(targetAgentId, {
					provider: p.provider,
					modelId: p.modelId,
					model: target,
					// Preserve the operator's thinking level across the switch (clamp
					// only if the new model can't honor it) — re-anchored via Carrow,
					// the named cross-model continuity API (delegates to model-caps).
					thinkingLevel: Carrow.reanchorThinking(getAgentRuntime(targetAgentId).thinkingLevel, target),
				});
				// Boot agent's set-model also refreshes the snapshot's cached
				// thinking caps (since the snapshot mirrors the boot agent).
				if (targetAgentId === agentId) {
					cachedSupportsThinking = !!target.reasoning;
					cachedThinkingLevels = deriveThinkingLevels(target);
				}
				// Persist into cfg.agents.<id>. The boot/default agent writes
				// through the existing wizard-shape (`agents.defaults`) so the
				// onboard wizard + set-model stay coherent; per-agent overrides
				// land under `agents.<id>` so they don't bleed into defaults.
				//
				// H8: route through mutateConfigAtomic so a concurrent TUI
				// /model + channel inbound + CLI agent add cannot read the
				// same baseline and stomp each other's diffs.
				if (targetAgentId === agentId) {
					await mutateConfigAtomic((cur) =>
						persistDefaultModel(cur as Config, p.provider, p.modelId) as unknown as typeof cur,
					);
				} else {
					await mutateConfigAtomic((cur) => {
						const next: Config = { ...(cur as Config) };
						const agentsMap = {
							...((next.agents as Record<string, unknown> | undefined) ?? {}),
						} as Record<string, unknown>;
						const prevEntry =
							(agentsMap[targetAgentId] as { model?: { fallbacks?: string[] } } | undefined) ??
							{};
						const prevModel = prevEntry.model ?? {};
						// H5: if the per-agent entry has no fallbacks of its own, inherit
						// from cfg.agents.defaults so set-model doesn't silently drop the
						// resilient-turn fallback chain configured at onboarding time.
						let inheritedFallbacks: string[] | undefined;
						if (!Array.isArray(prevModel.fallbacks) || prevModel.fallbacks.length === 0) {
							const defaults = agentsMap.defaults as
								| { model?: { fallbacks?: unknown } }
								| undefined;
							if (Array.isArray(defaults?.model?.fallbacks)) {
								inheritedFallbacks = (defaults?.model?.fallbacks as unknown[]).filter(
									(f): f is string => typeof f === "string" && f.length > 0,
								);
							}
						}
						const nextModel: { primary: string; fallbacks?: string[] } = {
							...prevModel,
							primary: p.modelId,
						};
						if (inheritedFallbacks && inheritedFallbacks.length > 0) {
							nextModel.fallbacks = inheritedFallbacks;
						}
						agentsMap[targetAgentId] = {
							...(typeof agentsMap[targetAgentId] === "object" && agentsMap[targetAgentId]
								? (agentsMap[targetAgentId] as Record<string, unknown>)
								: {}),
							provider: p.provider,
							model: nextModel,
						};
						(next as Record<string, unknown>).agents = agentsMap;
						return next as unknown as typeof cur;
					});
				}
				broadcastStateAllBindings();
				return undefined as ResponseFor[M];
			}
			case "switch-model-mid-turn": {
				const p = params as RequestParams["switch-model-mid-turn"];
				// Same per-agent auth resolution as set-model above — never validate
				// agent:ops's new model against agent:main's keys.
				const targetAgentId = p.agentId?.trim() || agentId;
				// Wave O0.6 — access guard. Abort+swap+replay on another
				// agent's live session is identical in blast radius to a
				// cross-agent send; reject when policy disallows.
				const switchVerdict = sessionsAccessCheck({
					action: "send",
					targetSessionKey:
						p.sessionKey?.trim() ||
						(targetAgentId === agentId ? sessionKey : defaultSessionKey(targetAgentId)),
				});
				if (!switchVerdict.allowed) {
					const err = new Error(
						switchVerdict.reason ?? "switch-model-mid-turn forbidden",
					);
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const targetAuth = getAuthStorageForAgent(targetAgentId);
				const target =
					modelRegistry.find(p.provider, p.modelId) ??
					((await resolveModelNeverMiss({
						modelRegistry,
						provider: p.provider,
						modelId: p.modelId,
						modelsFile,
						authStorage: targetAuth,
					})) as Model<string> | undefined);
				if (!target) throw new Error(`model ${p.provider}/${p.modelId} not found`);
				const targetKey =
					p.sessionKey?.trim() ||
					(targetAgentId === agentId ? sessionKey : defaultSessionKey(targetAgentId));
				// A live mid-turn switch (abort → swap → replay) only applies
				// when a turn is actually running for the target session. If one
				// is, perform it on that session; either way, update the
				// agent's runtime so subsequent turns continue on the new model.
				// Re-anchor the operator's thinking level to what the target can honor (Carrow).
				const reanchoredThinking = Carrow.reanchorThinking(
					getAgentRuntime(targetAgentId).thinkingLevel,
					target,
				);
				// Set the new model + re-anchored thinking FIRST — so the replay below, a NORMAL
				// gateway turn (which reads perAgentRuntime), runs on the new model at this level.
				perAgentRuntime.set(targetAgentId, {
					provider: p.provider,
					modelId: p.modelId,
					model: target,
					thinkingLevel: reanchoredThinking,
				});
				const liveSession = liveSessionsByKey.get(targetKey);
				if (liveSession && p.replayMessage) {
					// MID-TURN: abort the in-flight turn, then REPLAY the user's last message as a
					// FULL gateway turn — runGatewayTurn gives it TUI event broadcast (attachTurnSession)
					// AND post-turn extraction, on the new model. The per-session FIFO lane serialises
					// the replay behind the aborting turn. This replaces the old headless
					// session.prompt replay, which emitted no TUI events and mined no facts — so the
					// operator now SEES the handoff reply stream and Tideline extracts from it.
					await liveSession.abort().catch(() => {});
					await runGatewayTurn({
						text: p.replayMessage,
						sessionKey: targetKey,
						agentId: targetAgentId,
					});
				}
				if (targetAgentId === agentId) {
					cachedSupportsThinking = !!target.reasoning;
					cachedThinkingLevels = deriveThinkingLevels(target);
					await saveConfig(persistDefaultModel(await loadConfig(), p.provider, p.modelId));
				} else {
					const cur = await loadConfig();
					const next: Config = { ...cur };
					const agentsMap = {
						...((next.agents as Record<string, unknown> | undefined) ?? {}),
					} as Record<string, unknown>;
					const prevEntry =
						(agentsMap[targetAgentId] as { model?: { fallbacks?: string[] } } | undefined) ??
						{};
					const prevModel = prevEntry.model ?? {};
					agentsMap[targetAgentId] = {
						...(typeof agentsMap[targetAgentId] === "object" && agentsMap[targetAgentId]
							? (agentsMap[targetAgentId] as Record<string, unknown>)
							: {}),
						provider: p.provider,
						model: { ...prevModel, primary: p.modelId },
					};
					(next as Record<string, unknown>).agents = agentsMap;
					await saveConfig(next);
				}
				broadcastStateAllBindings();
				return undefined as ResponseFor[M];
			}
			case "set-thinking": {
				const p = params as RequestParams["set-thinking"];
				const targetAgentId = p.agentId?.trim() || agentId;
				// Wave O0.6 — access guard. Toggling another agent's
				// reasoning level mutates its in-flight session AND
				// persists into `cfg.agents.<id>.thinking`; treat as a
				// cross-agent send.
				const thinkingVerdict = sessionsAccessCheck({
					action: "send",
					targetSessionKey:
						p.sessionKey?.trim() ||
						(targetAgentId === agentId ? sessionKey : defaultSessionKey(targetAgentId)),
				});
				if (!thinkingVerdict.allowed) {
					const err = new Error(
						thinkingVerdict.reason ?? "set-thinking forbidden",
					);
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const cur = getAgentRuntime(targetAgentId);
				// Clamp the requested level against what THIS agent's model can do —
				// e.g. `high` on a non-reasoning model → off; `off` on a reasoning-
				// only model → low — so we never persist a level the model rejects.
				const effective = remapThinkingLevel(p.level as ThinkingLevel, cur.model);
				// Mutate only the target agent's thinking level. The next turn
				// for that agent reads it back; other agents' turns are unaffected.
				perAgentRuntime.set(targetAgentId, {
					...cur,
					thinkingLevel: effective,
				});
				// If a turn is live for this agent's selected session, push the
				// level into the in-flight session so it takes effect immediately.
				const targetKey =
					p.sessionKey?.trim() ||
					(targetAgentId === agentId ? sessionKey : defaultSessionKey(targetAgentId));
				const liveSession = liveSessionsByKey.get(targetKey);
				if (liveSession) {
					try {
						liveSession.setThinkingLevel(effective as never);
					} catch {
						/* clamp / unsupported — snapshot still reflects intent */
					}
				}
				// H4: persist the new thinking level so a daemon restart picks up
				// the operator's selection instead of resetting to the model's
				// initial default.
				//
				// H8: read+mutate+write under the in-process mutex so a
				// concurrent set-model / agents-add can't stomp this update.
				try {
					await mutateConfigAtomic((cur2) => {
						const next: Config = { ...(cur2 as Config) };
						const agentsMap = {
							...((next.agents as Record<string, unknown> | undefined) ?? {}),
						} as Record<string, unknown>;
						const prevEntry =
							agentsMap[targetAgentId] && typeof agentsMap[targetAgentId] === "object"
								? (agentsMap[targetAgentId] as Record<string, unknown>)
								: {};
						agentsMap[targetAgentId] = { ...prevEntry, thinking: effective };
						(next as Record<string, unknown>).agents = agentsMap;
						return next as unknown as typeof cur2;
					});
				} catch (err) {
					bootLog(
						`set-thinking: persistence failed for ${targetAgentId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				broadcastStateAllBindings();
				return undefined as ResponseFor[M];
			}
			case "compact": {
				const p = (params ?? {}) as RequestParams["compact"];
				// Compaction operates on a live session. Between turns there's
				// nothing loaded — compaction auto-triggers at the start of the
				// next turn when usage crosses the threshold (maybeTriggerCompaction
				// in agent-loop.ts). If a turn IS live for the target session,
				// compact it now.
				const targetKey =
					p?.sessionKey?.trim() ||
					(p?.agentId ? defaultSessionKey(p.agentId.trim()) : sessionKey);
				// Wave O0.6 — access guard. Forcing compaction on another
				// agent's live session rewrites its context and is a
				// destructive cross-agent operation; refuse when policy
				// disallows.
				const compactVerdict = sessionsAccessCheck({
					action: "send",
					targetSessionKey: targetKey,
				});
				if (!compactVerdict.allowed) {
					const err = new Error(compactVerdict.reason ?? "compact forbidden");
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const liveSession = liveSessionsByKey.get(targetKey);
				if (!liveSession) {
					throw new Error(
						"nothing to compact yet — compaction runs during a turn and auto-triggers near the context limit",
					);
				}
				await (liveSession as AgentSession & { compact?: () => Promise<unknown> }).compact?.();
				broadcastStateAllBindings();
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
			case "exec-allow-all": {
				const p = (params ?? {}) as RequestParams["exec-allow-all"];
				// Resolve the SAME session key the operator's turns run under —
				// identical resolution to `compact` above — so we arm the key the
				// exec-gate will actually check.
				const targetKey =
					p?.sessionKey?.trim() ||
					(p?.agentId ? defaultSessionKey(p.agentId.trim()) : sessionKey);
				setExecAllowAll(targetKey, p?.enabled === true);
				return { sessionKey: targetKey, enabled: p?.enabled === true } as ResponseFor[M];
			}
			case "exec-grant-skill": {
				const p = (params ?? {}) as RequestParams["exec-grant-skill"];
				const skillName = p?.skillName?.trim();
				if (!skillName) throw new Error("exec-grant-skill: missing skillName");
				const targetAgentId = p?.agentId?.trim() || agentId;
				const cfgNow = await loadConfig();
				const wsOverride = (
					cfgNow.agents as Record<string, { workspace?: unknown }> | undefined
				)?.[targetAgentId]?.workspace;
				const workspaceDir = resolveAgentWorkspaceDir(
					targetAgentId,
					typeof wsOverride === "string" && wsOverride.trim() ? wsOverride.trim() : undefined,
				);
				if (p?.revoke === true) {
					const r = revokeSkill({ config: cfgNow, workspaceDir, agentId: targetAgentId, skillName });
					return {
						found: r.found,
						skill: r.skill,
						applied: false,
						manifest: { commands: [], patterns: [] },
						granted: { commands: [], patterns: [] },
						refused: [],
						removed: r.removed,
						revoked: true,
					} as unknown as ResponseFor[M];
				}
				const res = grantSkill({
					config: cfgNow,
					workspaceDir,
					agentId: targetAgentId,
					skillName,
					apply: p?.apply === true,
				});
				return {
					found: res.found,
					skill: res.skill,
					applied: res.applied,
					emptyManifest: res.emptyManifest,
					manifest: res.manifest,
					granted: res.granted,
					refused: res.refused,
				} as unknown as ResponseFor[M];
			}
			case "list-models": {
				const registryModels = modelRegistry.getAvailable() as Array<Model<any>>;
				// Live-merge OpenRouter's CURRENT catalog (only when OpenRouter is
				// configured) so `/model` lists models newer than Pi's bundled
				// snapshot. Best-effort + cached + short timeout; on any failure the
				// registry list stands alone. Registry entries win (richer metadata).
				let merged: Array<Model<any>> = registryModels;
				if (registryModels.some((m) => m.provider === "openrouter")) {
					try {
						const live = await listOpenRouterModels();
						if (live.length > 0) {
							const seen = new Set(registryModels.map((m) => m.id));
							merged = [...registryModels];
							for (const lm of live) {
								if (!seen.has(lm.id)) merged.push(lm as unknown as Model<any>);
							}
						}
					} catch {
						/* keep the registry list */
					}
				}
				// Subscription live-merge: a login can grant models NEWER than Pi's
				// bundled catalog (GitHub Copilot). Pi already FILTERS `/model` to the
				// account's live ids via `availableModelIds` but can't ADD ids it doesn't
				// ship — so merge the live-only ids from the per-account cache.
				//
				// (L1) The merge reads the cache SYNCHRONOUSLY, so `/model` never blocks
				// on a network round-trip; the cache is warmed at login and kept fresh by
				// the background refresh below. Live-only ids may appear one call late on
				// a cold cache (e.g. right after a gateway restart) — an acceptable trade
				// for a never-blocking picker; the static plan-filtered list always stands.
				// (L2) The refresh runs in the BACKGROUND with a token from
				// `authStorage.getApiKey`, which auto-refreshes an idle-expired Copilot
				// token — the raw on-disk token would 401 and silently no-op the merge.
				for (const subProvider of ["github-copilot"]) {
					if (!merged.some((m) => m.provider === subProvider)) continue;
					const live = getCachedSubscriptionModels(subProvider);
					if (live && live.length > 0) {
						const seen = new Set(merged.map((m) => m.id));
						for (const lm of live) {
							if (!seen.has(lm.id)) merged.push(lm as unknown as Model<any>);
						}
					}
					// Fire-and-forget: freshen the cache for the NEXT call. Never awaited,
					// so a slow or failing fetch can't delay this response.
					void (async () => {
						try {
							const token = await authStorage.getApiKey(subProvider);
							if (token) await prefetchSubscriptionModels(subProvider, token);
						} catch {
							/* best-effort — the merged list above already stands */
						}
					})();
				}
				// claude-cli subscription backend — advertise its models only when the
				// `claude` binary is actually installed, so the operator never picks a
				// backend that can't run. These are synthesized (not in the registry),
				// so merge them explicitly; registry entries win on id collision.
				if (isClaudeCliAvailable()) {
					const seenCli = new Set(merged.map((m) => `${m.provider}/${m.id}`));
					// Live model set from the account's `/v1/models` (Fable 5, Sonnet 5,
					// …); falls back to the static catalog internally on any failure.
					const cliModels = await listClaudeCliModelsLive().catch(() => listClaudeCliModels());
					for (const cm of cliModels) {
						if (!seenCli.has(`${cm.provider}/${cm.id}`)) merged.push(cm as unknown as Model<any>);
					}
				}
				const models = merged.map((m: Model<any>) => modelToSummary(m));
				return models as ResponseFor[M];
			}
			case "refresh-models": {
				modelRegistry.refresh();
				broadcastStateAllBindings();
				return undefined as ResponseFor[M];
			}
			case "add-provider": {
				const p = params as RequestParams["add-provider"];
				// Adding a provider persists a gateway-WIDE credential — strictly an
				// operator write. Every WS connection is currently granted the full
				// operator scope set (single-operator model), but gate explicitly so
				// the day a narrower scope is issued, key-add stays owner-only.
				if (
					!caller.scopes.includes("operator.write") &&
					!caller.scopes.includes("operator.admin")
				) {
					const err = new Error("add-provider requires operator.write");
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				const providerId = p.providerId?.trim();
				const apiKey = p.apiKey?.trim();
				if (!providerId) throw new Error("providerId is required");
				if (!apiKey) throw new Error("apiKey is required");
				// Live validation against the provider's models endpoint (8s timeout):
				// 401/403 hard-reject; rate-limit / outage soft-accept with a warning.
				let warning: string | undefined;
				let modelCount: number | undefined;
				if (!p.skipValidation) {
					const v = await validateApiKeyOnline(providerId, apiKey);
					if (!v.ok) throw new Error(v.reason);
					warning = v.warning;
					modelCount = v.modelCount;
				}
				// Persist into main's auth-profiles.json (mode 0600) — the same store
				// `brigade onboard` writes, so the key survives a gateway restart.
				upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: providerId, key: apiKey });
				// Hot-load the credential into the gateway's live auth view so the model
				// registry resolves this provider's models on the NEXT turn without a
				// restart. `authStorage` is the boot store ModelRegistry was created with.
				(authStorage as AuthStorage).set(providerId, { type: "api_key", key: apiKey });
				// Drop cached per-agent auth views so non-boot agents rebuild from disk
				// and see the new credential too (boot agent re-caches `authStorage`).
				authStorageByAgent.clear();
				modelRegistry.refresh();
				broadcastStateAllBindings();
				return { ok: true, provider: providerId, modelCount, warning } as ResponseFor[M];
			}
			case "get-state": {
				return buildSnapshot() as ResponseFor[M];
			}
			case "resume": {
				// Reliable-streaming recovery. Return the session's committed
				// transcript (the single source of truth — works in BOTH
				// filesystem + Convex mode via `readSessionTranscriptMessages`)
				// plus the session's current head seq and the header snapshot.
				// The client re-materialises from this on (re)connect or a
				// detected seq gap, then keeps applying live `pi` frames keyed by
				// identity — so a dropped/reordered frame self-heals. Any
				// in-flight (not-yet-committed) message is NOT in the transcript
				// yet; the live `message_update` stream paints it after resume and
				// the identity-keyed renderer dedupes it on commit. Read-only;
				// default-pass session guard (the local WS client is the operator).
				const guardErr = defaultPassSessionGuard(rawParams, "list");
				if (guardErr) throw guardErr;
				const p = (params ?? {}) as RequestParams["resume"];
				const targetAgentId = p.agentId?.trim() || agentId;
				const targetSessionKey = p.sessionKey?.trim() || defaultSessionKey(targetAgentId);
				const messages = await readSessionTranscriptMessages({
					sessionKey: targetSessionKey,
					limit: RESUME_TRANSCRIPT_MAX,
				});
				const headSeq = seqCounters.get(targetSessionKey) ?? 0;
				// Recovery for the two non-transcript event types so a (re)connecting
				// client loses NOTHING: tool-approval prompts still pending on this
				// session (else the turn hangs to auto-deny), and the recent
				// system-event tail. Pending approvals are filtered to this session.
				const pendingApprovals = approvalBridge
					.listPending()
					.filter((a) => a.sessionId === targetSessionKey)
					.map((a) => ({
						id: a.id,
						command: a.command,
						toolName: a.toolName,
						timeoutMs: a.timeoutMs,
						decisions: a.decisions,
						...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
						...(a.subagentLabel !== undefined ? { subagentLabel: a.subagentLabel } : {}),
						...(a.subagentDepth !== undefined ? { subagentDepth: a.subagentDepth } : {}),
						...(a.parentRunId !== undefined ? { parentRunId: a.parentRunId } : {}),
						...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
						...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
					})) as EventPayload["approval-request"][];
				return {
					sessionKey: targetSessionKey,
					agentId: targetAgentId,
					messages: messages as WireMessage[],
					headSeq,
					pendingApprovals,
					recentSystemEvents: recentSystemEvents.get(targetSessionKey) ?? [],
					epoch: gatewayEpoch,
					snapshot: buildSnapshot(targetAgentId),
				} as ResponseFor[M];
			}
			case "memory-graph": {
				// Memory Graph dashboard data — nodes + typed edges + topic clusters
				// + stats, for an agent's workspace. Read; default-pass access guard
				// (declares the decision; denies only a forbidden session target). The
				// local WS client is the operator. maxNodes caps the viz set.
				const guardErr = defaultPassSessionGuard(rawParams, "list");
				if (guardErr) throw guardErr;
				const p = (params ?? {}) as RequestParams["memory-graph"];
				const wsDir = resolveAgentWorkspaceDir(p.agentId ?? agentId);
				const graph = exportMemoryGraph(new FactStore(wsDir).readAll(), { maxNodes: p.maxNodes ?? 250 });
				return graph as ResponseFor[M];
			}
			case "memory-query": {
				// Operator memory inspection — PASSIVE (no recall/reinforcement, no
				// mutation); read, default-pass access guard. The local WS client is the
				// operator, so all origins are shown (labeled) for auditing.
				const guardErr = defaultPassSessionGuard(rawParams, "list");
				if (guardErr) throw guardErr;
				const p = (params ?? {}) as RequestParams["memory-query"];
				const wsDir = resolveAgentWorkspaceDir(p.agentId ?? agentId);
				const result = queryMemory(new FactStore(wsDir), {
					action: p.action,
					query: p.query,
					memoryId: p.memoryId,
					limit: p.limit,
				});
				return result as ResponseFor[M];
			}
			case "agents.list": {
				// Wave N5 (bug #9) — emit every agent the gateway has runtime
				// state for. `perAgentRuntime` is the authoritative seed (boot
				// default + every `cfg.agents.<id>` that resolved on boot), so
				// the list never advertises an agent the gateway couldn't load.
				const entries: AgentSummary[] = [];
				for (const [id, rt] of perAgentRuntime.entries()) {
					entries.push({
						id,
						provider: rt.provider,
						modelId: rt.modelId,
						isBoot: id === agentId,
						...(computeAgentName(id) !== undefined
							? { personaName: computeAgentName(id) as string }
							: {}),
					});
				}
				// Stable order: boot agent first, then the rest alphabetically
				// so two consecutive `/agents` calls render identically.
				entries.sort((a, b) => {
					if (a.isBoot && !b.isBoot) return -1;
					if (!a.isBoot && b.isBoot) return 1;
					return a.id.localeCompare(b.id);
				});
				return entries as ResponseFor[M];
			}
			// Wave O0.6 — the stale `sessions.list` switch case was removed.
			// All `sessions.list` traffic now flows through the registered
			// handler (`registerGatewayHandler("sessions.list", ...)` below),
			// which is fully guarded by `sessionsAccessCheck`. The switch
			// case here previously duplicated the logic and could be
			// reached if the registered handler dispatched fall-through —
			// but the `default:` branch of this switch checks
			// `customMethods.get(method)` first, so a registered handler
			// always wins. The case was dead code maintenance-wise AND a
			// foot-gun if someone unregistered the handler.
			//
			// Wave O0.8 — the cron.* and wake switch cases were also deleted
			// for the same reason: the registered handlers below carry the
			// `sessionsAccessCheck` access guard, while the in-switch
			// dispatch path bypassed it. All cron + wake traffic now flows
			// through `registerGatewayHandler(...)` exclusively, which is
			// the single source of truth for guard wiring.
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
					// Wave O0.8 — default-pass session guard. If the call
					// names a `sessionKey` / `agentId` and the resolved
					// target is unreachable under current policy, refuse
					// before invoking the plugin handler. Plugins whose
					// methods take those fields but legitimately do not
					// touch session state opt out via
					// `skipSessionGuard: true` in their registration.
					if (!custom.skipSessionGuard) {
						const guardErr = defaultPassSessionGuard(rawParams, "send");
						if (guardErr) throw guardErr;
					}
					return (await custom.handler(rawParams, caller)) as ResponseFor[M];
				}
				// Bridge to the in-process registry. `registerGatewayHandler`
				// (from `gateway-caller-impl.ts`) populates a SEPARATE
				// singleton registry used by in-process tool callers
				// (`callGateway(...)`). Without this fallback, methods like
				// `org.snapshot`, `sessions.list`, `cron.*`, and `health` —
				// all registered there — are reachable from tools but
				// throw "unknown method" over the WebSocket, even though
				// the dispatcher COMMENT above claims registered handlers
				// "always win" at the default branch. They don't; they
				// live in a different Map. We forward here so the WS
				// surface matches the in-process one.
				try {
					return (await inProcessCaller.call({
						method: method as string,
						params: rawParams,
					})) as ResponseFor[M];
				} catch (err) {
					// Distinguish "method not registered" from "method
					// threw an actual error" so the WS client sees the
					// same `unknown method` shape as before for missing
					// methods, and the genuine handler errors propagate.
					if (
						err instanceof Error &&
						err.message.startsWith("gateway method not registered:")
					) {
						throw new Error(`unknown method: ${method}`);
					}
					throw err;
				}
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

	// Server-side dead-client detection. The client already runs its own
	// tick-watchdog (closes after 2× TICK_INTERVAL_MS without an inbound
	// frame) — but on a half-open TCP (laptop carried into a tunnel, NAT
	// router silently dropped, OS suspended the client's process) the
	// SERVER has no way to know the client is gone until it tries to send.
	// Stale clients accumulate, broadcasts pile up in their send buffers,
	// and `clients.size` reports a phantom audience. The ws library
	// supports WebSocket-protocol PING/PONG frames; we send a PING every
	// tick interval and terminate any client that didn't respond before
	// the next round.
	const wsIsAlive = new WeakMap<WebSocket, boolean>();

	wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
		clients.add(ws);
		// Mark alive on connect; the next ping cycle will set it false until
		// the client's PONG arrives. ws emits `pong` for the protocol-level
		// PONG control frame (not user-level messages), so this can't be
		// faked by a half-open TCP.
		wsIsAlive.set(ws, true);
		ws.on("pong", () => wsIsAlive.set(ws, true));
		// P1#3 (Wave H) — per-connection id used to key subscription
		// filters. Cheap UUID; client never sees it.
		const connId = crypto.randomUUID();
		clientConnIds.set(ws, connId);
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

		// Champion-tier handshake: the FIRST frame is `hello-ok`, handing the
		// client everything it needs to subscribe without hardcoding — the
		// protocol version, its connId, the gateway's build version + epoch
		// (session generation, for restart detection), the full list of callable
		// methods (core wire methods + registered control-plane RPCs) and
		// subscribable events, and the policy limits (payload/buffer caps + tick
		// interval). A client that ignores it still works (the `state` frame
		// below preserves the legacy boot path).
		const helloOk: HelloOk = {
			type: "hello-ok",
			protocol: PROTOCOL_VERSION,
			server: { version: getBuildInfo().version, connId, epoch: gatewayEpoch },
			features: {
				methods: [...REQUEST_METHODS, ...customMethods.keys()],
				events: [...EVENT_NAMES],
			},
			policy: {
				maxPayload: MAX_WS_PAYLOAD_BYTES,
				maxBufferedBytes: MAX_WS_BUFFERED_BYTES,
				tickIntervalMs: TICK_INTERVAL_MS,
			},
			auth: { role: "operator" },
		};
		ws.send(JSON.stringify(helloOk satisfies Frame));
		// Then the initial snapshot so the client can render its header before
		// any user action (also the back-compat boot frame for older clients).
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

			// P1#3 (Wave H) — subscribe / unsubscribe live at the WS layer
			// (the registry is per-connection) so handle them inline before
			// touching the cross-cutting `handleRequest` dispatcher.
			if (reqFrame.method === "subscribe" || reqFrame.method === "unsubscribe") {
				const p =
					(reqFrame.params ?? {}) as { agentId?: string; sessionId?: string };
				try {
					if (reqFrame.method === "subscribe") {
						if (p.agentId) subscribeAgent(connId, p.agentId.trim());
						if (p.sessionId) subscribeSession(connId, p.sessionId.trim());
					} else {
						if (p.agentId) unsubscribeAgent(connId, p.agentId.trim());
						if (p.sessionId) unsubscribeSession(connId, p.sessionId.trim());
					}
					const response: Frame = { type: "res", id: reqFrame.id, ok: true };
					if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
					// Wave K — push a fresh per-binding snapshot on subscribe so
					// the client's header reflects the agent it just bound to
					// (model / persona / running flag) without waiting for the
					// next mutation. The per-conn filter will deliver it because
					// the snapshot frame carries the same agentId tag.
					if (reqFrame.method === "subscribe" && p.agentId && ws.readyState === ws.OPEN) {
						const snapFrame: Frame = {
							type: "event",
							event: "state",
							payload: buildSnapshot(p.agentId.trim()),
						};
						ws.send(JSON.stringify(snapFrame));
					}
					opts.consoleStream?.wsResponse(
						reqFrame.method,
						reqFrame.id,
						true,
						Date.now() - startedAt,
					);
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
				}
				return;
			}

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
			clientConnIds.delete(ws);
			clientAgentSubs.delete(connId);
			clientSessionSubs.delete(connId);
			opts.consoleStream?.clientDisconnected(clientLabel, clients.size);
		});

		ws.on("error", () => {
			clients.delete(ws);
			clientConnIds.delete(ws);
			clientAgentSubs.delete(connId);
			clientSessionSubs.delete(connId);
		});
	});

	/* ──────────────── tick heartbeat ──────────────── */

	// Send a raw (non-`event`) frame to every open client. Used for the cheap
	// `tick` keepalive + the graceful `shutdown` notice — each a single tiny
	// frame, so no backpressure gate (the ping reaper handles a truly dead one).
	const sendRawToAll = (frame: Frame): void => {
		const json = JSON.stringify(frame);
		for (const ws of clients) {
			if (ws.readyState !== ws.OPEN) continue;
			try {
				ws.send(json);
			} catch {
				/* best-effort */
			}
		}
	};

	// Emit a cheap `tick` frame every TICK_INTERVAL_MS so clients detect a dead
	// server (no frames in 2× this interval = close + reconnect). Was a full
	// `state` snapshot to every binding; a tick is far lighter (battery/bandwidth
	// on mobile) and `state` is still pushed on every real mutation + on connect,
	// so idle clients stay consistent. The tick also doubles as the heartbeat-file
	// beat: refreshing it from inside the event-loop tick proves the loop is
	// healthy — a starved loop misses it and the supervisor restarts the process.
	const tickTimer = setInterval(() => {
		sendRawToAll({ type: "tick", ts: Date.now() });
		void writeHeartbeatFile().catch(() => {
			/* best-effort */
		});
	}, TICK_INTERVAL_MS);
	tickTimer.unref(); // don't block process exit on timer

	// Idle-gateway memory hygiene. The post-turn quiet window runs decay-GC + curator per
	// workspace, but ONLY after a turn — so a gateway that sits quiet for days never ages or
	// consolidates memory. This wall-clock sweep runs the same cheap (no-model) pass for every
	// configured agent workspace, independent of traffic. Cleared on shutdown; unref'd so it
	// never blocks process exit. Cadence via BRIGADE_MAINTENANCE_INTERVAL_MS (default 24h).
	const maintenanceIntervalMs = (() => {
		const env = Number(process.env.BRIGADE_MAINTENANCE_INTERVAL_MS);
		return Number.isFinite(env) && env > 0 ? env : 24 * 60 * 60 * 1000;
	})();
	const maintenanceTimer = setInterval(() => {
		// Skip on shutdown, OR when the memory kill-switch (BRIGADE_DISABLE_MEMORY_EXTRACT=1)
		// froze the fact store — decay/curator are background memory processing, so they must
		// honor the same freeze the post-turn sweep does (else facts age while "disabled").
		if (serverStopped || !memoryExtractEnabled) return;
		void (async () => {
			try {
				const cfg = await loadConfig();
				const ids = new Set<string>([agentId]);
				const ab = (cfg as { agents?: Record<string, unknown> }).agents;
				if (ab && typeof ab === "object") {
					for (const id of Object.keys(ab)) {
						if (id !== "defaults" && id.trim()) ids.add(id.trim());
					}
				}
				for (const id of ids) {
					runMemoryMaintenance(
						resolveAgentWorkspaceDir(id),
						(stage, err) =>
							opts.consoleStream?.info?.(
								`memory maintenance ${stage} error (agent=${id}): ${err instanceof Error ? err.message : String(err)}`,
							),
						(pairs) => {
							// Surface contradictions for human review — never auto-resolve.
							const top = [...pairs].sort((a, b) => b.score - a.score).slice(0, 3);
							opts.consoleStream?.info?.(
								`memory: ${pairs.length} possible contradiction(s) for agent=${id} (review; not auto-resolved): ${top
									.map((p) => `"${p.a.content.length > 80 ? p.a.content.slice(0, 80) + "…" : p.a.content}" <-> "${p.b.content.length > 80 ? p.b.content.slice(0, 80) + "…" : p.b.content}" (${p.score.toFixed(2)})`)
									.join("; ")}`,
							);
						},
					);
					// Yield to the event loop between agents so channel inbounds keep flowing
					// during a multi-agent sweep — Brigade's org can have ~22 agents; without
					// this the whole batch runs sync in one tick and starves inbound handling.
					await new Promise((resolve) => setImmediate(resolve));
				}
			} catch (err) {
				opts.consoleStream?.info?.(
					`memory maintenance sweep error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		})();
	}, maintenanceIntervalMs);
	maintenanceTimer.unref(); // don't block process exit on timer

	// Server-side dead-client reaper. Pattern (mirrors the `ws` library's
	// own example): on each cycle, terminate any client that didn't ACK
	// the previous round's PING; then mark every survivor as "needs an
	// ACK before next round" and send a fresh PING. A half-open TCP that
	// can't deliver the PONG ends up reaped within one cycle of the next.
	// Same cadence as the tick timer so a stale client gets caught within
	// ~one full tick interval of going silent.
	const pingTimer = setInterval(() => {
		for (const ws of clients) {
			const alive = wsIsAlive.get(ws);
			if (alive === false) {
				// Last round's PING never got a PONG. Reap.
				opts.consoleStream?.clientDisconnected(
					`${(ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? "?"}`,
					clients.size - 1,
				);
				try {
					ws.terminate();
				} catch {
					/* best-effort */
				}
				continue;
			}
			wsIsAlive.set(ws, false);
			try {
				ws.ping();
			} catch {
				// If `ping()` throws (very unusual — the socket is in an odd
				// state), the next cycle's alive-check will reap it.
			}
		}
	}, TICK_INTERVAL_MS);
	pingTimer.unref();

	/* ──────────────── multi-routing spine wiring (Step 1-27) ──────────────── */

	// Install the in-process gateway caller. Every `callGateway(...)` from
	// a tool (sessions_send, sessions_spawn, sessions_history, sessions_list)
	// resolves to a local handler via the registry below. WebSocket clients
	// also dispatch through the same registry once the connection handler
	// routes their request frame here (in `handleRequest`).
	const disposeGatewayCaller = installInProcessGatewayCaller();
	// In-process caller instance used by handleRequest's default branch
	// to bridge to the singleton-registry path. See the comment block
	// in the default branch for why this fallback is needed (TL;DR:
	// `registerGatewayHandler` populates a separate registry that the
	// WS dispatcher otherwise can't see).
	const inProcessCaller = createInProcessGatewayCaller();

	// Register the five sessions handlers + health. Bound `agentId` is the
	// boot-time default; the dispatcher's per-turn route resolver overrides
	// this for channel-routed inbounds. `runAgentTurn` adapter calls the
	// already-defined `runGatewayTurn` so each method dispatches through the
	// existing serialized turn queue.
	const disposeHandlers: Array<() => void> = [];

	// Wave O0.5/O0.6 — server-side access guard. The closure resolves
	// the caller's visibility + A2A policy from the *current* live
	// config (read fresh on every call so a `system.reload` that
	// tightens visibility takes effect without daemon restart) and
	// delegates to `checkSessionToolAccess` — the same helper the tool
	// surface uses. Today the gateway is localhost-only and the only
	// requester identity we trust is the boot agent's session
	// (`sessionKey`).
	//
	// TODO(phase-2-multi-user): the requester identity is hard-pinned to
	// the boot sessionKey here. Phase 2 must thread the actual calling
	// agentId/sessionKey through `callerContext` on each RPC dispatch so
	// per-connection auth (HTTP-session) drives the check instead of the
	// process-wide boot binding. The hard-pin is acceptable for the
	// single-user gateway because every WS client is localhost + admin
	// scope, but it silently grants admin reach to anything that opens a
	// WS connection — must be replaced before multi-user lands.
	let configReadWarningSurfaced = false;
	const buildSessionsAccessCheck = (): SessionsHandlerAccessCheck => {
		return ({ action, targetSessionKey }) => {
			// SAME-AGENT operator pass. The WS requester is the LOCAL OPERATOR
			// (localhost-bind + admin scope), anchored to the boot agent. The
			// operator owns EVERY session of their own agent, so any target under
			// that same agent passes — this guard's job is solely to refuse
			// CROSS-AGENT reach (gated below by visibility="all" + A2A policy).
			// Without this, the operator prompting a fresh same-agent thread
			// (`/new` → `agent:main:t-…`) or switching to any non-boot session of
			// their own agent was wrongly refused by the `visibility:"self"` rule
			// in `checkSessionToolAccess`, even though they plainly own it. The
			// agent's own `sessions_send` tool is unaffected — it calls
			// `checkSessionToolAccess` directly with the AGENT's session as the
			// requester, so its self/tree visibility still applies.
			if ((parseAgentSessionKey(targetSessionKey)?.agentId ?? agentId) === agentId) {
				return { allowed: true };
			}
			// Read the live config snapshot so `system.reload` that
			// tightens visibility/A2A takes effect on the very next RPC.
			// Sync `loadConfig()` would be ideal but the project's
			// loadConfig is async; fall back to the cached boot snapshot
			// when the sync read isn't available. The async refresher
			// below repopulates a live cache on a best-effort cadence so
			// the next call sees the new policy.
			const cfgNow = (liveConfigSnapshot ?? (args.bootConfig as unknown)) as {
				session?: {
					sessionTools?: { visibility?: SessionToolsVisibility };
					agentToAgent?: {
						enabled?: boolean;
						allow?: Array<{ from?: unknown; to?: unknown }>;
					};
				};
			};
			void scheduleLiveConfigRefresh();
			const visibility: SessionToolsVisibility =
				cfgNow.session?.sessionTools?.visibility ?? "self";
			const allowRaw = cfgNow.session?.agentToAgent?.allow;
			const allow: string[] = [];
			if (Array.isArray(allowRaw)) {
				for (const pair of allowRaw) {
					const from = typeof pair?.from === "string" ? pair.from.trim() : "";
					const to = typeof pair?.to === "string" ? pair.to.trim() : "";
					if (from) allow.push(from);
					if (to) allow.push(to);
				}
			}
			const policy = createAgentToAgentPolicy({
				enabled: !!cfgNow.session?.agentToAgent?.enabled,
				allow,
			});
			// Requester identity: the boot session key. WS clients today
			// are the local operator (localhost-bind + admin scope) so the
			// operator's session anchors the check; Phase 2 will thread a
			// per-connection key here. Actions that are not list/history/send
			// are mapped to "send" for the shared helper (which only
			// distinguishes those three at the error-message level).
			if (!configReadWarningSurfaced && !liveConfigSnapshot) {
				configReadWarningSurfaced = true;
				bootLog(
					"sessions access guard: using boot-config snapshot until first live reload (TODO phase-2 multi-user)",
				);
			}
			const mapped: "list" | "history" | "send" =
				action === "list" || action === "history" ? action : "send";
			const verdict = checkSessionToolAccess({
				action: mapped,
				requesterSessionKey: sessionKey,
				targetSessionKey,
				visibility,
				a2aPolicy: policy,
			});
			if (verdict.allowed) return { allowed: true };
			return { allowed: false, reason: verdict.error };
		};
	};
	// Live config cache for the access guard. `system.reload` and the
	// per-call best-effort refresher keep this fresh so operator-driven
	// visibility tightening takes effect without a daemon restart.
	let liveConfigSnapshot: Config | undefined;
	let liveConfigRefreshInflight: Promise<void> | undefined;
	let liveConfigLastRefreshMs = 0;
	const LIVE_CONFIG_REFRESH_MIN_MS = 250;
	const scheduleLiveConfigRefresh = (): Promise<void> => {
		if (liveConfigRefreshInflight) return liveConfigRefreshInflight;
		const now = Date.now();
		if (liveConfigSnapshot && now - liveConfigLastRefreshMs < LIVE_CONFIG_REFRESH_MIN_MS) {
			return Promise.resolve();
		}
		liveConfigRefreshInflight = (async () => {
			try {
				const fresh = await loadConfig();
				liveConfigSnapshot = fresh;
				liveConfigLastRefreshMs = Date.now();
			} catch {
				// Best-effort — keep the previous snapshot on read failure.
			} finally {
				liveConfigRefreshInflight = undefined;
			}
		})();
		return liveConfigRefreshInflight;
	};
	// Prime the cache so the very first access check uses the disk state
	// instead of the boot snapshot when the daemon has been running for a
	// while before the first cross-agent op.
	void scheduleLiveConfigRefresh();
	const sessionsAccessCheck = buildSessionsAccessCheck();

	/**
	 * Wave O0.8 — extract a session-target from an arbitrary params/body
	 * shape so the default-pass guard for extension handlers (customMethods
	 * + HTTP routes) can check access without each plugin opting in
	 * manually.
	 *
	 * Strategy (one level deep, intentionally narrow):
	 *   • If `sessionKey` is a non-empty string, use it verbatim.
	 *   • Else if `agentId` is a non-empty string, derive `defaultSessionKey`.
	 *   • Else inspect nested objects (one level) for the same fields —
	 *     covers `{ params: { agentId: "..." } }` and similar wrappers.
	 *   • Else return `null` meaning "no targeting hint; nothing to guard".
	 *
	 * Returning `null` skips the guard entirely — handlers that DO want a
	 * guard against the boot agent should call `sessionsAccessCheck`
	 * directly. The deep-walk is capped at depth 1 to avoid pathological
	 * shapes (cyclic objects, deeply nested user payloads).
	 */
	const extractSessionTargetFromParams = (raw: unknown): string | null => {
		if (raw === null || raw === undefined || typeof raw !== "object") return null;
		const root = raw as Record<string, unknown>;
		const direct = (() => {
			const sk = root.sessionKey;
			if (typeof sk === "string" && sk.trim().length > 0) return sk.trim();
			const aid = root.agentId;
			if (typeof aid === "string" && aid.trim().length > 0)
				return defaultSessionKey(aid.trim());
			return null;
		})();
		if (direct !== null) return direct;
		for (const key of Object.keys(root)) {
			const v = root[key];
			if (v && typeof v === "object" && !Array.isArray(v)) {
				const inner = v as Record<string, unknown>;
				const sk = inner.sessionKey;
				if (typeof sk === "string" && sk.trim().length > 0) return sk.trim();
				const aid = inner.agentId;
				if (typeof aid === "string" && aid.trim().length > 0)
					return defaultSessionKey(aid.trim());
			}
		}
		return null;
	};

	/**
	 * Wave O0.8 — default-pass session guard for extension surfaces. Returns
	 * `null` when the call should proceed (no target detected, or guard
	 * passed), or an `Error` with `code: "forbidden"` when the resolved
	 * target is unreachable for the caller. Callers throw the returned
	 * Error themselves so the call site keeps its own response shape (WS
	 * frames vs HTTP responses differ).
	 */
	const defaultPassSessionGuard = (
		raw: unknown,
		action: "list" | "history" | "send",
	): (Error & { code?: string }) | null => {
		const target = extractSessionTargetFromParams(raw);
		if (target === null) return null;
		const verdict = sessionsAccessCheck({ action, targetSessionKey: target });
		if (verdict.allowed) return null;
		const err = new Error(verdict.reason ?? "forbidden") as Error & {
			code?: string;
		};
		err.code = "forbidden";
		return err;
	};

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
				{ accessCheck: sessionsAccessCheck },
			),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.history", (params: unknown) =>
			handleSessionsHistory(
				params as Parameters<typeof handleSessionsHistory>[0],
				// O0 H1 — real JSONL reader. Resolves the agent id + session id
				// from the canonical `agent:<id>:<rest>` session key via the
				// session-store index, then reads the matching transcript
				// JSONL line-by-line. Each line is one SessionEntry; we filter
				// to `type:"message"` entries and project to `entry.message`
				// for the wire shape callers expect. Last-N truncation honours
				// the caller's `limit`. Errors fall back to an empty array so
				// a corrupt transcript file never crashes the gateway.
				{
					readMessages: async (p) => readSessionTranscriptMessages(p),
					accessCheck: sessionsAccessCheck,
				},
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
							// Wave O0.7 - capture the per-turn reply so the
							// dispatcher's lifecycle "end" event carries the
							// child's text. Bridges to subagent-announce-
							// delivery for the parent's inbox.
							const result = await runGatewayTurn({
								text: turn.message,
								sessionKey: turn.sessionKey,
								...(turn.signal ? { signal: turn.signal } : {}),
							});
							return {
								ok: true,
								...(typeof result?.reply === "string" ? { reply: result.reply } : {}),
							};
						} catch (err) {
							// Wave O0.8 GAP 8 — surface abort/timeout outcomes so the
							// dispatcher's lifecycle `phase:end` classifies them
							// correctly instead of folding into a generic error.
							const isAbortErr =
								err instanceof Error &&
								(err.name === "AbortError" ||
									(err as { code?: unknown }).code === "ABORT_ERR" ||
									(err as { code?: unknown }).code === 20);
							const aborted = isAbortErr || (turn.signal?.aborted ?? false);
							const message = err instanceof Error ? err.message : String(err);
							const timedOut = /timed?[- ]?out|timeout/i.test(message);
							return {
								ok: false,
								error: message,
								...(aborted ? { aborted: true } : {}),
								...(timedOut && !aborted ? { timedOut: true } : {}),
							};
						}
					},
					accessCheck: sessionsAccessCheck,
				},
			),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.spawn", (params: unknown) =>
			handleSessionsSpawn(params as Parameters<typeof handleSessionsSpawn>[0], {
				accessCheck: sessionsAccessCheck,
			}),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("sessions.patch", (params: unknown) =>
			handleSessionsPatch(params as Parameters<typeof handleSessionsPatch>[0], {
				accessCheck: sessionsAccessCheck,
			}),
		),
	);
	// `agent` method: legacy sub-agent fan-out path the spawn engine uses to
	// hand off the initial child turn (see `subagent-spawn.ts` calling
	// `callGateway({method:"agent", ...})`). Dispatches through `dispatchAgentRun`
	// + `runGatewayTurn` so the sub-agent run rides the same serialized lane +
	// lifecycle hooks as a direct `sessions.send`. Mirrors the upstream
	// `agent` server-method (see `server-methods/agent.ts` in the reference
	// codebase). Coexists with the in-process `spawn_agent` tool — both call
	// sites resolve to the same dispatcher today.
	disposeHandlers.push(
		registerGatewayHandler("agent", async (params: unknown) => {
			const p = (params ?? {}) as {
				message?: string;
				sessionKey?: string;
				idempotencyKey?: string;
				thinking?: string;
				timeout?: number;
				/** Sync-style: await the run's settled outcome (ok/reply/error)
				 *  instead of the fire-and-forget {ok, runId} ack. */
				wait?: boolean;
				deliver?: boolean;
				channel?: string;
				accountId?: string;
				to?: string;
				threadId?: string | number;
				lane?: string;
				label?: string;
				spawnedBy?: string;
				workspaceDir?: string;
				agentId?: string;
				extraSystemPrompt?: string;
			};
			const text = (p.message ?? "").trim();
			const sessionKey = (p.sessionKey ?? "").trim();
			if (!text || !sessionKey) {
				return { ok: false, error: "agent: message + sessionKey required" };
			}
			// Wave O0.5 — access guard before fan-out dispatch. Refused
			// calls return an error envelope (legacy fire-and-forget shape)
			// instead of letting the runner enqueue a turn against a session
			// the caller is not allowed to reach.
			const accessVerdict = sessionsAccessCheck({
				action: "agent",
				targetSessionKey: sessionKey,
			});
			if (!accessVerdict.allowed) {
				return {
					ok: false,
					error: accessVerdict.reason ?? "agent forbidden",
				};
			}
			const run = dispatchAgentRun(
				{
					sessionKey,
					message: text,
					...(p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : {}),
					...(p.thinking ? { thinking: p.thinking } : {}),
					...(typeof p.timeout === "number" ? { timeout: p.timeout } : {}),
					...(typeof p.deliver === "boolean" ? { deliver: p.deliver } : {}),
					...(p.channel ? { channel: p.channel } : {}),
					...(p.accountId ? { accountId: p.accountId } : {}),
					...(p.to ? { to: p.to } : {}),
					...(p.threadId !== undefined ? { threadId: p.threadId } : {}),
					...(p.lane ? { lane: p.lane } : {}),
					...(p.label ? { label: p.label } : {}),
					...(p.spawnedBy ? { spawnedBy: p.spawnedBy } : {}),
					...(p.workspaceDir ? { workspaceDir: p.workspaceDir } : {}),
					...(p.agentId ? { agentId: p.agentId } : {}),
					...(p.extraSystemPrompt ? { extraSystemPrompt: p.extraSystemPrompt } : {}),
				},
				{
					runAgentTurn: async (turn) => {
						try {
							// Wave O0.7 - thread the child's reply text on the
							// adapter return so the dispatcher's lifecycle
							// "end" event carries it to the parent's inbox via
							// subagent-announce-delivery.
							const result = await runGatewayTurn({
								text: turn.message,
								sessionKey: turn.sessionKey,
								...(turn.agentId ? { agentId: turn.agentId } : {}),
								...(turn.signal ? { signal: turn.signal } : {}),
							});
							return {
								ok: true,
								...(typeof result?.reply === "string" ? { reply: result.reply } : {}),
							};
						} catch (err) {
							// Wave O0.8 GAP 8 — surface abort/timeout outcomes so the
							// completion bridge classifies them as ABORT/TIMEOUT
							// rather than ERROR. Mirrors the sessions.send adapter.
							const isAbortErr =
								err instanceof Error &&
								(err.name === "AbortError" ||
									(err as { code?: unknown }).code === "ABORT_ERR" ||
									(err as { code?: unknown }).code === 20);
							const aborted = isAbortErr || (turn.signal?.aborted ?? false);
							const message = err instanceof Error ? err.message : String(err);
							const timedOut = /timed?[- ]?out|timeout/i.test(message);
							return {
								ok: false,
								error: message,
								...(aborted ? { aborted: true } : {}),
								...(timedOut && !aborted ? { timedOut: true } : {}),
							};
						}
					},
				},
			);
			// `wait: true` — sync-style: await the run's settled outcome and
			// return it (ok/error/reply). sessions_send needs this to know
			// when the PEER'S RUN actually finished: the in-process gateway
			// caller resolves when this handler RETURNS, so without `wait`
			// the caller's "held run promise" settled in ~1 tick and every
			// settle-gated behaviour (final-reply reads, async late delivery)
			// was dead code. Awaiting blocks only this handler invocation —
			// each call is independently async — and a caller-side timeout or
			// rejection does NOT abort the run (the dispatcher owns the run).
			if (p.wait === true) {
				const settled = await run.settled.catch(
					(err): { ok: false; error: string } => ({
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
				return {
					ok: settled.ok,
					runId: run.runId,
					...(settled.error ? { error: settled.error } : {}),
					...("reply" in settled && typeof settled.reply === "string"
						? { reply: settled.reply }
						: {}),
					...("aborted" in settled && settled.aborted ? { aborted: true } : {}),
					...("timedOut" in settled && settled.timedOut ? { timedOut: true } : {}),
				};
			}
			// Same fire-and-forget pattern as sessions.send - return runId now,
			// let the lifecycle stream surface the settled outcome.
			void run.settled.catch(() => undefined);
			return { ok: true, runId: run.runId };
		}),
	);

	/* ─── Cron methods (Wave N6) — full reference parity. ───── */
	// Service context snapshot per-call so a delayed re-register honours
	// service stop/start. `getActiveCronService()` is the canonical
	// runtime accessor; the handler returns null-state errors when the
	// daemon hasn't started yet.
	const cronCtx = (): CronHandlerContext => ({ state: getActiveCronService() });
	disposeHandlers.push(
		registerGatewayHandler("cron.status", async (params: unknown) =>
			handleCronStatus(
				params as Parameters<typeof handleCronStatus>[0],
				cronCtx(),
			),
		),
	);
	disposeHandlers.push(
		registerGatewayHandler("cron.list", async (params: unknown) =>
			handleCronList(
				params as Parameters<typeof handleCronList>[0],
				cronCtx(),
			),
		),
	);
	// Wave O0.6 — cron access guard. A cron job's agentId + sessionTarget
	// determines which agent's session the fire-time turn lands on. Refuse
	// add/update/run when the caller cannot reach that target. The check
	// is best-effort for malformed shapes: if the target cannot be
	// resolved we fall back to the boot agent's session, which is the
	// safest default for a single-user gateway.
	const resolveCronTargetSessionKey = (input: {
		agentId?: unknown;
		sessionTarget?: unknown;
		sessionKey?: unknown;
	}): string => {
		const rawAgentId =
			typeof input.agentId === "string" ? input.agentId.trim() : "";
		const effectiveAgentId = rawAgentId.length > 0 ? rawAgentId : agentId;
		const rawSessionKey =
			typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
		if (rawSessionKey.length > 0) return rawSessionKey;
		const target =
			typeof input.sessionTarget === "string" ? input.sessionTarget.trim() : "";
		if (target.startsWith("session:")) {
			const id = target.slice("session:".length).trim();
			if (id.length > 0) return id;
		}
		return defaultSessionKey(effectiveAgentId);
	};
	disposeHandlers.push(
		registerGatewayHandler("cron.add", async (params: unknown) => {
			const p = (params ?? {}) as Record<string, unknown>;
			const cronAddVerdict = sessionsAccessCheck({
				action: "send",
				targetSessionKey: resolveCronTargetSessionKey(p),
			});
			if (!cronAddVerdict.allowed) {
				const err = new Error(cronAddVerdict.reason ?? "cron.add forbidden");
				(err as Error & { code?: string }).code = "forbidden";
				throw err;
			}
			return handleCronAdd(
				params as Parameters<typeof handleCronAdd>[0],
				cronCtx(),
			);
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("cron.update", async (params: unknown) => {
			const p = (params ?? {}) as Record<string, unknown>;
			// Resolve the target against the patch (if it tries to retarget
			// the job) AND fall back to the persisted job's identity when
			// the patch leaves agentId unset. Without the existing-job
			// fallback a caller could blind-mutate someone else's job by
			// omitting agentId from the patch.
			const patch = (p.patch ?? {}) as Record<string, unknown>;
			let existingAgentId: string | undefined;
			let existingSessionTarget: string | undefined;
			let existingSessionKey: string | undefined;
			try {
				const idRaw =
					typeof p.id === "string"
						? p.id
						: typeof p.jobId === "string"
							? p.jobId
							: undefined;
				const state = cronCtx().state;
				if (state && idRaw && typeof idRaw === "string" && idRaw.trim().length > 0) {
					const { getJob } = await import("../cron/service/ops.js");
					try {
						const existing = await getJob(state, idRaw.trim());
						if (typeof existing.agentId === "string") existingAgentId = existing.agentId;
						if (typeof existing.sessionTarget === "string")
							existingSessionTarget = existing.sessionTarget;
						if (typeof existing.sessionKey === "string")
							existingSessionKey = existing.sessionKey;
					} catch {
						// Job lookup failed (not found / corrupt) — fall through
						// to the patch-only resolution below.
					}
				}
			} catch {
				// Dynamic import / state lookup failed — patch-only resolution.
			}
			const cronUpdateVerdict = sessionsAccessCheck({
				action: "send",
				targetSessionKey: resolveCronTargetSessionKey({
					agentId: patch.agentId ?? existingAgentId,
					sessionTarget: patch.sessionTarget ?? existingSessionTarget,
					sessionKey: patch.sessionKey ?? existingSessionKey,
				}),
			});
			if (!cronUpdateVerdict.allowed) {
				const err = new Error(
					cronUpdateVerdict.reason ?? "cron.update forbidden",
				);
				(err as Error & { code?: string }).code = "forbidden";
				throw err;
			}
			return handleCronUpdate(
				params as Parameters<typeof handleCronUpdate>[0],
				cronCtx(),
			);
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("cron.remove", async (params: unknown) => {
			// Wave O0.8 — access guard. Removing a job belonging to another
			// agent is a destructive cross-agent mutation: it suppresses
			// scheduled fires that would have driven that agent's next turn.
			// Look up the persisted job and evaluate the guard against its
			// actual target before delete.
			const p = (params ?? {}) as Record<string, unknown>;
			const idRaw =
				typeof p.id === "string"
					? p.id
					: typeof p.jobId === "string"
						? p.jobId
						: undefined;
			let existingAgentId: string | undefined;
			let existingSessionTarget: string | undefined;
			let existingSessionKey: string | undefined;
			try {
				const state = cronCtx().state;
				if (state && idRaw && typeof idRaw === "string" && idRaw.trim().length > 0) {
					const { getJob } = await import("../cron/service/ops.js");
					try {
						const existing = await getJob(state, idRaw.trim());
						if (typeof existing.agentId === "string") existingAgentId = existing.agentId;
						if (typeof existing.sessionTarget === "string")
							existingSessionTarget = existing.sessionTarget;
						if (typeof existing.sessionKey === "string")
							existingSessionKey = existing.sessionKey;
					} catch {
						// Job not found — let the handler surface the error.
					}
				}
			} catch {
				/* best-effort */
			}
			const cronRemoveVerdict = sessionsAccessCheck({
				action: "send",
				targetSessionKey: resolveCronTargetSessionKey({
					agentId: existingAgentId,
					sessionTarget: existingSessionTarget,
					sessionKey: existingSessionKey,
				}),
			});
			if (!cronRemoveVerdict.allowed) {
				const err = new Error(
					cronRemoveVerdict.reason ?? "cron.remove forbidden",
				);
				(err as Error & { code?: string }).code = "forbidden";
				throw err;
			}
			return handleCronRemove(
				params as Parameters<typeof handleCronRemove>[0],
				cronCtx(),
			);
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("cron.run", async (params: unknown) => {
			const p = (params ?? {}) as Record<string, unknown>;
			// Look up the persisted job so we evaluate the access check
			// against the actual fire-time target — running someone else's
			// job is equivalent to a cross-agent send.
			const idRaw =
				typeof p.id === "string"
					? p.id
					: typeof p.jobId === "string"
						? p.jobId
						: undefined;
			let existingAgentId: string | undefined;
			let existingSessionTarget: string | undefined;
			let existingSessionKey: string | undefined;
			try {
				const state = cronCtx().state;
				if (state && idRaw && typeof idRaw === "string" && idRaw.trim().length > 0) {
					const { getJob } = await import("../cron/service/ops.js");
					try {
						const existing = await getJob(state, idRaw.trim());
						if (typeof existing.agentId === "string") existingAgentId = existing.agentId;
						if (typeof existing.sessionTarget === "string")
							existingSessionTarget = existing.sessionTarget;
						if (typeof existing.sessionKey === "string")
							existingSessionKey = existing.sessionKey;
					} catch {
						// Job not found — let the handler surface the error.
					}
				}
			} catch {
				/* best-effort */
			}
			const cronRunVerdict = sessionsAccessCheck({
				action: "send",
				targetSessionKey: resolveCronTargetSessionKey({
					agentId: existingAgentId,
					sessionTarget: existingSessionTarget,
					sessionKey: existingSessionKey,
				}),
			});
			if (!cronRunVerdict.allowed) {
				const err = new Error(cronRunVerdict.reason ?? "cron.run forbidden");
				(err as Error & { code?: string }).code = "forbidden";
				throw err;
			}
			return handleCronRun(
				params as Parameters<typeof handleCronRun>[0],
				cronCtx(),
			);
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("cron.runs", async (params: unknown) => {
			// Wave O0.8 — access guard. A run log discloses fire history for a
			// job (timestamps, outcomes), which in cross-agent mode is a
			// list-class read against the owning agent's session.
			//   • scope=job: resolve the single owning job, guard its target.
			//   • scope=all: enumerate the result and drop entries whose
			//     owning job the caller cannot reach. We re-resolve the job
			//     for every distinct jobId so the filter stays correct when
			//     policy says "self only".
			const p = (params ?? {}) as Record<string, unknown>;
			const jobIdRaw =
				typeof p.id === "string"
					? p.id
					: typeof p.jobId === "string"
						? p.jobId
						: undefined;
			const explicitScope =
				typeof p.scope === "string" ? (p.scope as "job" | "all") : undefined;
			const scope: "job" | "all" =
				explicitScope ?? (jobIdRaw && jobIdRaw.trim().length > 0 ? "job" : "all");

			const { getJob } = await import("../cron/service/ops.js");

			if (scope === "job") {
				let existingAgentId: string | undefined;
				let existingSessionTarget: string | undefined;
				let existingSessionKey: string | undefined;
				try {
					const state = cronCtx().state;
					if (state && jobIdRaw && jobIdRaw.trim().length > 0) {
						try {
							const existing = await getJob(state, jobIdRaw.trim());
							if (typeof existing.agentId === "string") existingAgentId = existing.agentId;
							if (typeof existing.sessionTarget === "string")
								existingSessionTarget = existing.sessionTarget;
							if (typeof existing.sessionKey === "string")
								existingSessionKey = existing.sessionKey;
						} catch {
							// Job not found — let the handler surface the error.
						}
					}
				} catch {
					/* best-effort */
				}
				const cronRunsVerdict = sessionsAccessCheck({
					action: "list",
					targetSessionKey: resolveCronTargetSessionKey({
						agentId: existingAgentId,
						sessionTarget: existingSessionTarget,
						sessionKey: existingSessionKey,
					}),
				});
				if (!cronRunsVerdict.allowed) {
					const err = new Error(
						cronRunsVerdict.reason ?? "cron.runs forbidden",
					);
					(err as Error & { code?: string }).code = "forbidden";
					throw err;
				}
				return handleCronRuns(
					params as Parameters<typeof handleCronRuns>[0],
					cronCtx(),
				);
			}

			// scope = all — run the handler, then strip entries whose job
			// target the caller cannot reach. Caching the per-job verdict
			// avoids re-hitting `sessionsAccessCheck` for every row.
			const raw = await handleCronRuns(
				params as Parameters<typeof handleCronRuns>[0],
				cronCtx(),
			);
			const allowedByJob = new Map<string, boolean>();
			const state = cronCtx().state;
			const filtered: Array<(typeof raw.entries)[number]> = [];
			for (const entry of raw.entries) {
				const jobId =
					typeof (entry as { jobId?: unknown }).jobId === "string"
						? ((entry as { jobId: string }).jobId)
						: undefined;
				if (!jobId) {
					// No jobId on the row — exclude defensively; the row
					// can't be access-checked.
					continue;
				}
				if (!allowedByJob.has(jobId)) {
					let aId: string | undefined;
					let sT: string | undefined;
					let sK: string | undefined;
					if (state) {
						try {
							const existing = await getJob(state, jobId);
							if (typeof existing.agentId === "string") aId = existing.agentId;
							if (typeof existing.sessionTarget === "string") sT = existing.sessionTarget;
							if (typeof existing.sessionKey === "string") sK = existing.sessionKey;
						} catch {
							/* missing job — exclude */
						}
					}
					const verdict = sessionsAccessCheck({
						action: "list",
						targetSessionKey: resolveCronTargetSessionKey({
							agentId: aId,
							sessionTarget: sT,
							sessionKey: sK,
						}),
					});
					allowedByJob.set(jobId, verdict.allowed);
				}
				if (allowedByJob.get(jobId) === true) filtered.push(entry);
			}
			return { ...raw, entries: filtered };
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("wake", async (params: unknown) => {
			// Wave O0.8 — access guard. `wake` injects a synthetic prompt into
			// a target agent's next-heartbeat (or immediate) turn. That is a
			// cross-agent send by every meaningful definition; refuse when
			// policy disallows reaching the resolved target.
			const p = (params ?? {}) as Record<string, unknown>;
			const wakeVerdict = sessionsAccessCheck({
				action: "send",
				targetSessionKey: resolveCronTargetSessionKey({
					agentId: p.agentId,
					sessionKey: p.sessionKey,
				}),
			});
			if (!wakeVerdict.allowed) {
				const err = new Error(wakeVerdict.reason ?? "wake forbidden");
				(err as Error & { code?: string }).code = "forbidden";
				throw err;
			}
			handleWake(params as Parameters<typeof handleWake>[0], cronCtx());
			return undefined;
		}),
	);

	/* ─── Skills methods (Wave S) — status / install / update. ─── */
	// Per-call config + workspaceDir resolution so an operator's edits land
	// on the very next RPC without a gateway restart. Each handler keeps its
	// own narrow params parsing — params validation here, business logic in
	// the dedicated modules under `agents/skills/`.
	disposeHandlers.push(
		registerGatewayHandler("skills.status", async (params: unknown) => {
			const p = (params ?? {}) as { agentId?: string };
			const cfg = await loadConfig();
			const targetAgentId =
				p.agentId && p.agentId.trim().length > 0 ? p.agentId.trim() : agentId;
			// Wave O0.6 — access guard. The skill report enumerates an
			// agent's full skill inventory + per-skill enabled state, which
			// is enough surface for a cross-agent caller to map another
			// agent's capabilities. Treat as a list-class read against the
			// target's session.
			const skillsVerdict = sessionsAccessCheck({
				action: "list",
				targetSessionKey: defaultSessionKey(targetAgentId),
			});
			if (!skillsVerdict.allowed) {
				const err = new Error(skillsVerdict.reason ?? "skills.status forbidden");
				(err as Error & { code?: string }).code = "forbidden";
				throw err;
			}
			const workspaceDir = resolveAgentWorkspaceDir(targetAgentId);
			return buildSkillStatusReport({
				workspaceDir,
				config: cfg as unknown as BrigadeConfig,
				agentId: targetAgentId,
			});
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("skills.install", async (params: unknown) => {
			const p = (params ?? {}) as Partial<SkillInstallSpec> & { timeoutMs?: number };
			if (!p.kind) {
				return { ok: false, message: "skills.install: missing kind" };
			}
			return await installSkill(p as SkillInstallSpec, {}, {
				...(typeof p.timeoutMs === "number" && p.timeoutMs > 0
					? { timeoutMs: p.timeoutMs }
					: {}),
			});
		}),
	);
	disposeHandlers.push(
		registerGatewayHandler("skills.update", async (params: unknown) => {
			const p = (params ?? {}) as {
				name?: string;
				skillKey?: string;
				enabled?: boolean;
				apiKey?: string;
				env?: Record<string, string>;
			};
			const name = (p.name ?? p.skillKey ?? "").trim();
			if (!name) return { ok: false, message: "skills.update: missing name" };
			const cfg = await loadConfig();
			const { config: nextCfg, entry } = applySkillUpdate(
				cfg as unknown as BrigadeConfig,
				{
					name,
					...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
					...(typeof p.apiKey === "string" ? { apiKey: p.apiKey } : {}),
					...(p.env && typeof p.env === "object" ? { env: p.env } : {}),
				},
			);
			await saveConfig(nextCfg);
			return { ok: true, name, entry };
		}),
	);

	// `org.snapshot` — operator-only read of the current org topology + every
	// pre-rendered Pride chart format (TUI / channel / ASCII / JSON). Sits
	// next to `agents.list` and the other operator-side snapshot RPCs: read-
	// only, no per-session targeting, no agentId/sessionKey in the params. The
	// guard-sweep CI test allowlists this method explicitly for that reason
	// (see `ALLOWLIST_NO_GUARD_NEEDED` in `server.guard-sweep.test.ts`).
	disposeHandlers.push(
		registerGatewayHandler("org.snapshot", (_params: unknown) =>
			handleOrgSnapshot(undefined, {
				loadConfig: () => loadConfig() as never,
			}),
		),
	);

	// `config.*` — operator-level config CRUD over the wire (the `brigade
	// config` CLI, reachable from a remote client). Path/value/redact shape:
	// never session-targeted, so the guard-sweep correctly needs no per-session
	// access check. Reads/writes go through the mode-aware loadConfig/saveConfig,
	// so this works in filesystem AND Convex mode.
	disposeHandlers.push(registerGatewayHandler("config.get", handleConfigGet));
	disposeHandlers.push(registerGatewayHandler("config.set", handleConfigSet));
	disposeHandlers.push(registerGatewayHandler("config.unset", handleConfigUnset));
	disposeHandlers.push(registerGatewayHandler("config.list", handleConfigList));
	disposeHandlers.push(registerGatewayHandler("config.schema", handleConfigSchema));
	disposeHandlers.push(registerGatewayHandler("config.validate", handleConfigValidate));

	// `exec.*` — operator-level exec-approval allowlist CRUD (the `brigade exec`
	// CLI over the wire). Per-agent + operator-scoped (the operator manages
	// their OWN agents' bash-approval allowlist), the same posture as the
	// allowlisted exec-allow-all / exec-grant-skill RPCs — no per-session guard
	// (see ALLOWLIST_NO_GUARD_NEEDED in server.guard-sweep.test.ts). The
	// hard-deny safety net in exec-approvals.ts still applies on every allow.
	disposeHandlers.push(registerGatewayHandler("exec.list", handleExecList));
	disposeHandlers.push(registerGatewayHandler("exec.allow", handleExecAllow));
	disposeHandlers.push(registerGatewayHandler("exec.allow-pattern", handleExecAllowPattern));
	disposeHandlers.push(registerGatewayHandler("exec.remove", handleExecRemove));
	disposeHandlers.push(registerGatewayHandler("exec.deny-test", handleExecDenyTest));

	// `agents.*` — operator-level routing-binding management (which agent owns
	// which channel/account). The genuine no-other-path gap: agent add/delete/
	// set-identity are already reachable via the `manage_agent` tool, but
	// bindings had no remote path. Operator-scoped config mutation, no per-
	// session guard (allowlisted in server.guard-sweep.test.ts).
	disposeHandlers.push(registerGatewayHandler("agents.bindings", handleAgentsBindings));
	disposeHandlers.push(registerGatewayHandler("agents.bind", handleAgentsBind));
	disposeHandlers.push(registerGatewayHandler("agents.unbind", handleAgentsUnbind));

	// `pairing.*` — operator-level channel pairing (approve/revoke strangers who
	// DM the bot). Per-channel + operator-scoped, no per-session guard. The RPCs
	// require an explicit channel (a client gets the channel list from
	// system.capabilities), unlike the CLI's single-channel auto-pick.
	disposeHandlers.push(registerGatewayHandler("pairing.list", handlePairingList));
	disposeHandlers.push(registerGatewayHandler("pairing.approve", handlePairingApprove));
	disposeHandlers.push(registerGatewayHandler("pairing.revoke", handlePairingRevoke));

	// `sessions.cleanup` — operator maintenance: delete an agent's stale idle
	// transcript files (the gateway regenerates the store entry on next access).
	// NOT session-content access (unlike sessions.list/history), so no per-
	// session guard (allowlisted in server.guard-sweep.test.ts).
	disposeHandlers.push(registerGatewayHandler("sessions.cleanup", handleSessionsCleanup));

	// `memory.*` — Tideline write + governance (write_memory / manage_memory).
	// Memory lives in facts.jsonl (NOT config), so config.set can't reach it;
	// these are the only typed remote path to MUTATE memory (read is covered by
	// memory-query / memory-graph). Operator-scoped owner origin, no per-session
	// guard (allowlisted in server.guard-sweep.test.ts).
	disposeHandlers.push(registerGatewayHandler("memory.write", handleMemoryWrite));
	disposeHandlers.push(registerGatewayHandler("memory.manage", handleMemoryManage));

	// agents.add/delete/set-identity — agent CRUD (reuses the manage_agent tool,
	// which wraps `brigade agents add/delete/set-identity`). Seeds/soft-deletes a
	// workspace, so config.set alone can't do it. Operator-scoped (allowlisted).
	disposeHandlers.push(registerGatewayHandler("agents.add", handleAgentsAdd));
	disposeHandlers.push(registerGatewayHandler("agents.delete", handleAgentsDelete));
	disposeHandlers.push(registerGatewayHandler("agents.set-identity", handleAgentsSetIdentity));

	// skills.create/delete/write-file — skill authoring (reuses the manage_skill
	// tool). SKILL.md files on disk, not config. (status/install/update already
	// cover read/install/enable.) Operator-scoped (allowlisted).
	disposeHandlers.push(registerGatewayHandler("skills.create", handleSkillsCreate));
	disposeHandlers.push(registerGatewayHandler("skills.delete", handleSkillsDelete));
	disposeHandlers.push(registerGatewayHandler("skills.write-file", handleSkillsWriteFile));

	// channels.* — LIVE connect/disconnect (runtime adapter via the global
	// channel manager) + DM allow-from (a per-channel file store, not config).
	// Channel enable/disable/policy are already config.set-reachable. Operator-
	// scoped (allowlisted). connect reuses the owner-scoped connect_channel tool.
	disposeHandlers.push(registerGatewayHandler("channels.connect", handleChannelsConnect));
	disposeHandlers.push(registerGatewayHandler("channels.disconnect", handleChannelsDisconnect));
	disposeHandlers.push(registerGatewayHandler("channels.allow-add", handleChannelsAllowAdd));
	disposeHandlers.push(registerGatewayHandler("channels.allow-remove", handleChannelsAllowRemove));
	disposeHandlers.push(registerGatewayHandler("channels.allow-list", handleChannelsAllowList));

	// provider.remove — delete a provider key (auth-profiles.json, not config;
	// add-provider exists, removal had no gateway path). Operator-scoped.
	disposeHandlers.push(registerGatewayHandler("provider.remove", handleProviderRemove));

	// composio + oauth — integrations. `composio` is remote-clean (Composio
	// hosts the OAuth callback; the gateway hands over a click-link + polls).
	// `oauth` is the DIY loopback flow (callback on the gateway host — completes
	// only for a local/tunneled operator; status/token work remotely). Both
	// reuse the owner-scoped tools. Operator-scoped (allowlisted).
	disposeHandlers.push(registerGatewayHandler("composio", handleComposio));
	disposeHandlers.push(registerGatewayHandler("oauth", handleOauth));

	// Wave O0.8 GAP 11 — opt the session inbox into JSONL persistence at
	// gateway boot. The disk write surface defaults off so the existing
	// unit-test fleet (which doesn't tempdir-isolate ~/.brigade) keeps
	// passing; the gateway flips it on so a restart between child
	// completion and parent next turn does not lose the announce.
	// Operators can opt out via BRIGADE_DISABLE_INBOX_PERSIST=1.
	if (process.env.BRIGADE_DISABLE_INBOX_PERSIST !== "1") {
		process.env.BRIGADE_ENABLE_INBOX_PERSIST = "1";
	}

	// Wire the agent-events bridge. Subagent-ended hooks (Step 10) +
	// heartbeat-fired hooks (Step 14) + session-state listeners (Step 11)
	// all now flow into the unified `agent-events.ts` bus where Step 25's
	// event-stream broadcaster can fan out to WebSocket subscribers.
	const disposeAgentEventsBridge = wireAgentEventsBridge();

	// Enable heartbeats globally (read from env override if set; tests can
	// disable via BRIGADE_DISABLE_HEARTBEAT=1).
	setHeartbeatsEnabled(process.env.BRIGADE_DISABLE_HEARTBEAT !== "1");

	// Tell the heartbeat runner which agent owns the global `Main` lane so
	// its lane gate only Main-checks the BOOT operator's `:main` session.
	// Other agents' `:main` sessions route to per-session lanes and must
	// NOT be cross-gated against the boot operator's Main FIFO.
	setHeartbeatBootAgentId(agentId);

	// Install the heartbeat-fired hook BEFORE starting the runner so the
	// runner can dispatch a synthetic turn the first time it fires. The
	// hook formats the consumed events as the user message and routes
	// through `runGatewayTurn` (same path as a channel inbound).
	//
	// P1#8 (Wave H) — `addHeartbeatFiredHook` returns a disposer so this
	// hook COMPOSES with whatever `wireAgentEventsBridge()` registered
	// above (which emits `heartbeat` bus events). Without this both hooks
	// would have raced for the single slot and the bridge's emit would
	// have silently lost.
	// P0-2 — deliver a woken turn's reply back to the requester's CHANNEL when
	// a consumed event carries a deliveryContext (the A2A late-delivery stamps
	// the requester's last channel). Without this, a WhatsApp/Slack-origin
	// requester only ever sees the relayed reply in the TUI. Cron awareness
	// events carry NO deliveryContext (cron delivers to its channel separately
	// in maybeDeliverAnnounce), so they never double-deliver here. Best-effort:
	// reuses the same adapter.sendText path the cron dispatcher uses.
	const deliverReplyToChannel = async (
		ctx: { channel?: string; to?: string; accountId?: string; threadId?: string | number },
		replyText: string,
	): Promise<boolean> => {
		if (!channelManager || !ctx.channel || !ctx.to || !replyText.trim()) return false;
		const adapter = channelManager.adapter(ctx.channel);
		if (!adapter) return false;
		try {
			if (typeof adapter.health === "function" && !adapter.health().ok) return false;
			await adapter.sendText(
				ctx.to,
				replyText,
				ctx.threadId !== undefined ? { threadId: String(ctx.threadId) } : undefined,
			);
			return true;
		} catch (err) {
			createSubsystemLogger("agents/heartbeat-runner").warn("A2A channel delivery failed", {
				channel: ctx.channel,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	};

	const disposeHeartbeatHook = addHeartbeatFiredHook(async (params) => {
		if (!params.consumedEvents.length && params.reason !== "interval") return;
		const text =
			params.consumedEvents.length > 0
				? params.consumedEvents.map((e) => e.text).join("\n")
				: "Heartbeat tick.";
		// A2A late-delivery events stamp the requester's channel here; cron +
		// plain system events leave it undefined (TUI-only, unchanged).
		const deliveryContext = resolveSystemEventDeliveryContext(params.consumedEvents);
		try {
			const result = await runGatewayTurn({
				text,
				sessionKey: params.sessionKey,
				agentId: params.agentId,
				senderIsOwner: true,
			});
			if (deliveryContext?.channel && deliveryContext.to && result?.reply?.trim()) {
				void deliverReplyToChannel(deliveryContext, result.reply);
			}
		} catch {
			// Heartbeat turns are best-effort; failures already log via the runner.
			// Audit P2 (F3, 2026-06-11): the runner CONSUMED these events before
			// firing this hook, so a dispatch throw (e.g. shutdown drain) would
			// silently drop a real cron/system event. Re-enqueue the consumed
			// payload events so the next turn/wake still surfaces them. Interval
			// ticks carry no payload ("Heartbeat tick.") — nothing to restore.
			// No tight loop: this hook only fires on a wake tick, not in a spin.
			for (const ev of params.consumedEvents) {
				if (!ev?.text) continue;
				try {
					enqueueSessionInboxEvent(ev.text, {
						sessionKey: params.sessionKey,
						...(ev.contextKey ? { contextKey: ev.contextKey } : {}),
						trusted: ev.trusted !== false,
					});
				} catch {
					/* best-effort restore */
				}
			}
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

	// Publish the MCP tool-plane host now the loopback HTTP server is bound. The
	// claude-cli harness backend registers each eligible turn's toolset + guard in
	// `mcpTurnRegistry` and points the binary at `${baseUrl}/mcp/<token>`.
	//
	// The server binds loopback, and the route re-checks `remoteAddress`. That is
	// NOT the same as "unreachable remotely": `brigade expose` proxies HTTP from
	// 127.0.0.1, so a tunnelled request passes the loopback check. It grants no
	// INCREMENTAL capability — reaching the tunnel already means holding the expose
	// bearer token, which carries operator rights over the gateway anyway — and a
	// caller still needs the ephemeral per-turn 256-bit token. Stated plainly here
	// so nobody later mistakes the loopback check for a remote-access boundary.
	setActiveMcpToolPlaneHost({ baseUrl: `http://127.0.0.1:${port}`, registry: mcpTurnRegistry });

	// Is a newer Brigade published? Fire-and-forget: a listening gateway must never
	// wait on the npm registry, and an offline machine must boot in silence. The
	// result rides the next state snapshot to every attached client, which ASKS the
	// operator — we never update anything on our own. See `core/update-check.ts`.
	void checkForUpdate()
		.then((found) => {
			if (!found) return;
			latestUpdate = found;
			createSubsystemLogger("update").info("a newer Brigade is available", {
				current: found.current,
				latest: found.latest,
				hint: "run `brigade update` when convenient — nothing under ~/.brigade is touched",
			});
			broadcastStateAllBindings();
		})
		.catch(() => {
			/* checkForUpdate never rejects; this is belt for a future refactor */
		});

	// Phase 7 — agent model resolved. Emits the standard
	// `agent model: <provider>/<model>` line for the boot agent.
	{
		const bootRt = getAgentRuntime(agentId);
		bootLog(`agent model: ${bootRt.provider}/${bootRt.modelId}`);
	}

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
				let parsedBodyForGuard: unknown = undefined;
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
					// Wave O0.8 — best-effort JSON parse for the default-pass
					// session guard. Non-JSON bodies (signed webhooks,
					// multipart) leave `parsedBodyForGuard` undefined; the
					// guard treats undefined params as "no targeting hint"
					// and lets the handler run (loopback-auth + plugin auth
					// remain the primary gates).
					const ctHeader = req.headers["content-type"];
					const contentType = (
						Array.isArray(ctHeader) ? ctHeader[0] : ctHeader ?? ""
					).toLowerCase();
					if (
						contentType.startsWith("application/json") &&
						body.length > 0 &&
						body.length <= 64 * 1024
					) {
						try {
							parsedBodyForGuard = JSON.parse(body.toString("utf8"));
						} catch {
							/* malformed — skip guard, let handler decide */
						}
					}
				}

				// Wave O0.8 — default-pass session guard for extension HTTP
				// routes. When the parsed body names a `sessionKey` /
				// `agentId` and the resolved target is unreachable, refuse
				// before invoking the plugin. Routes that take those fields
				// but legitimately do not touch session state (e.g. webhook
				// dispatches whose `agentId` is the receiver) opt out via
				// `skipSessionGuard: true` on the route registration.
				if (!route.skipSessionGuard && parsedBodyForGuard !== undefined) {
					const guardErr = defaultPassSessionGuard(
						parsedBodyForGuard,
						"send",
					);
					if (guardErr) {
						res.statusCode = 403;
						res.setHeader("Content-Type", "application/json; charset=utf-8");
						res.end(
							JSON.stringify({
								error: guardErr.message,
								code: guardErr.code ?? "forbidden",
							}),
						);
						return;
					}
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
		if (channelPluginManager) {
			// Stop every per-account socket the plugin manager holds; the
			// `ChannelPlugin.gateway.stopAccount` for each bundled plugin runs
			// per accountId so the per-account `Map<accountId, socket>` drains
			// cleanly. Idempotent — `stopChannel` on an already-stopped channel
			// no-ops.
			for (const plugin of bundledChannelPlugins) {
				await channelPluginManager.stopChannel(plugin.id).catch(() => {});
			}
			channelPluginManager = undefined;
			bundledChannelPlugins = [];
		}
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
		// Reset the process-wide channel slot registries (messaging / security /
		// meta). These are populated by `startExtensions()` via a `.set()`-only sync
		// seam that never REMOVES a slot, so an operator who removes/edits a slot-
		// bearing channel and reloads would otherwise leak its stale adapter: a stale
		// security adapter keeps TIGHTENING DM policy (security-relevant) and a stale
		// messaging adapter keeps rewriting outbound targets. Clearing here means a
		// reload starts clean and `startExtensions()` re-syncs ONLY the currently-
		// loaded channels. Each clear is idempotent + total, so shutdown is safe too.
		clearChannelMessagingRegistry();
		clearChannelSecurityRegistry();
		clearChannelMetaRegistry();
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
		// Publish the live registry so deep hot-path callers (e.g. the inbound media
		// pipeline reaching a TranscriptionProvider) can fetch it without threading it
		// through every channel adapter's args. Cleared on shutdown.
		setActiveRegistry(registry);

		// Channel slot registries — populate the process-wide messaging + security
		// registries from EVERY channel that declared `b.channelMessaging(...)` /
		// `b.channelSecurity(...)`, over the FULL registered set (bundled + user
		// channels alike), UNCONDITIONALLY — never gated on the multi-account branch
		// below. Without this, a channel that declares a `messaging`/`security` slot
		// is inert: the `send_message` outbound resolver + the inbound DM-policy
		// consult never see it. A channel that omits the slot registers nothing and
		// keeps today's raw-id / central-policy behaviour by construction.
		syncChannelMessagingAdaptersFromPlugins(registry.channelMessagingAdapters);
		syncChannelSecurityAdaptersFromPlugins(registry.channelSecurityAdapters);

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
					// Wave L — per-agent caches that read from disk-backed config
					// must be invalidated alongside the extension reload, or a
					// post-reload turn still uses pre-reload model/auth bindings.
					// Drop every cached AuthStorage entry; the next turn rebuilds
					// from the agent's auth-profiles.json file.
					try {
						authStorageByAgent.clear();
					} catch {
						// best-effort — clearing the cache must never block reload
					}
					// Re-apply lane budgets + propagate the fresh config to the
					// heartbeat scheduler + cron config consumers. Each block runs
					// independently so one failure doesn't gate the others.
					let cfgAfterReload: BrigadeConfig | undefined;
					try {
						cfgAfterReload = (await loadConfig()) as BrigadeConfig;
					} catch (err) {
						opts.consoleStream?.info?.(
							`config-reload error: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					// Wave O0.8 — close the access-guard TOCTOU window. Without
					// this, `system.reload` returned `ok:true` while
					// `liveConfigSnapshot` still pointed at the pre-reload
					// shape until the next 250ms-throttled refresh — meaning a
					// caller could tighten visibility, see ok, and immediately
					// observe the old policy on the very next RPC. Push the
					// fresh config into the snapshot synchronously and bump
					// the throttle timestamp so the access check sees the new
					// state on the very next call.
					if (cfgAfterReload) {
						liveConfigSnapshot = cfgAfterReload as unknown as Config;
						liveConfigLastRefreshMs = Date.now();
					} else {
						// Disk read failed — drop the cache so the next access
						// check falls through to the boot snapshot rather than
						// returning a stale (post-mutate, pre-reload) shape.
						liveConfigSnapshot = undefined;
					}
					try {
						if (cfgAfterReload) applyGatewayLaneConcurrency(cfgAfterReload as never);
					} catch (err) {
						opts.consoleStream?.info?.(
							`lane-concurrency reload error: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					try {
						if (cfgAfterReload && heartbeatScheduler) {
							heartbeatScheduler.updateConfig(cfgAfterReload as never);
						}
					} catch (err) {
						opts.consoleStream?.info?.(
							`heartbeat-scheduler reload error: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					// Wave L P2#8 — perAgentRuntime caches a `Model` whose internal
					// auth binding is from boot. After `system.reload`, the auth
					// storage map was cleared above; rebuild each entry's Model
					// under the agent's fresh AuthStorage so the next turn uses
					// the post-reload keys. Falls back to keeping the existing
					// Model if resolveModelNeverMiss can't locate one.
					try {
						for (const [id, rt] of [...perAgentRuntime.entries()]) {
							try {
								const freshAuth = getAuthStorageForAgent(id);
								const rebuilt =
									modelRegistry.find(rt.provider, rt.modelId) ??
									((await resolveModelNeverMiss({
										modelRegistry,
										provider: rt.provider,
										modelId: rt.modelId,
										modelsFile,
										authStorage: freshAuth,
									})) as Model<string> | undefined);
								if (rebuilt) {
									perAgentRuntime.set(id, { ...rt, model: rebuilt });
								}
							} catch {
								// per-agent rebuild is best-effort; old Model still works
							}
						}
					} catch {
						// outer guard — never break reload on runtime rebuild
					}
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
		httpRoutes = [...coreHttpRoutes, ...registry.httpRoutes];

		// Channels — inbound runs through the SAME serialized turn queue as TUI
		// prompts (`runGatewayTurn`), so a channel turn never overlaps a TUI turn.
		//
		// The manager is mounted UNCONDITIONALLY (even when zero channels are
		// configured at boot) so the owner-gated `connect_channel` tool can
		// start the FIRST channel LIVE via `getActiveChannelManager().startChannel(id)`
		// without a gateway restart. The manager captures the FULL adapter
		// catalog (`registry.channels`), so a channel that isn't started at boot
		// is still reachable for a later live start. Bundled modules guarantee
		// `registry.channels` is non-empty in normal installs; the guard stays
		// only so a build that trims every channel module doesn't construct an
		// empty manager.
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
			// `send_message` + `connect_channel` agent tools (+ future
			// channel-action tools) can reach the started adapters AND start /
			// stop a single channel live. Without this the tool registry's
			// `getActiveChannelManager()` returns null and those tools quietly
			// stay out of the surface (or can't perform a live connect).
			setActiveChannelManager(channelManager);
			if (channelManager.started.length > 0) bootLog(`channels: ${channelManager.started.join(", ")}`);
		}

		// Plugin-shaped channel manager (Wave F). Only activates when at least
		// one channel plugin reports a multi-account config — today that's
		// WhatsApp with `channels.whatsapp.accounts: [...]`. Single-account
		// installs fall through to the legacy `startChannels` path above and
		// this manager simply never spins up an account.
		const whatsappAccounts = whatsappChannelEnabled(cfg as never)
			? listWhatsAppAccountIds(cfg as never)
			: [];
		const telegramAccounts = telegramChannelEnabled(cfg as never)
			? listTelegramAccountIds(cfg as never)
			: [];
		const slackAccounts = slackChannelEnabled(cfg as never)
			? listSlackAccountIds(cfg as never)
			: [];
		const discordAccounts = discordChannelEnabled(cfg as never)
			? listDiscordAccountIds(cfg as never)
			: [];
		const imessageAccounts = imessageChannelEnabled(cfg as never)
			? listIMessageAccountIds(cfg as never)
			: [];
		const bluebubblesAccounts = bluebubblesChannelEnabled(cfg as never)
			? listBlueBubblesAccountIds(cfg as never)
			: [];
		const wantWhatsAppMulti = whatsappAccounts.length > 1;
		const wantTelegramMulti = telegramAccounts.length > 1;
		const wantSlackMulti = slackAccounts.length > 1;
		const wantDiscordMulti = discordAccounts.length > 1;
		const wantIMessageMulti = imessageAccounts.length > 1;
		const wantBlueBubblesMulti = bluebubblesAccounts.length > 1;
		if (
			wantWhatsAppMulti ||
			wantTelegramMulti ||
			wantSlackMulti ||
			wantDiscordMulti ||
			wantIMessageMulti ||
			wantBlueBubblesMulti
		) {
			// Fresh list each (re)start so a reload doesn't accumulate stale plugins.
			bundledChannelPlugins = [];
			const facadeHandles: Array<
				| WhatsAppPluginHandle
				| TelegramPluginHandle
				| SlackPluginHandle
				| DiscordPluginHandle
				| IMessagePluginHandle
				| BlueBubblesPluginHandle
			> = [];
			const multiAccountSummary: string[] = [];
			if (wantWhatsAppMulti) {
				const whatsappPlugin = createWhatsAppPlugin({
					defaultAgentId: agentId,
					loadConfig: () => cfg as never,
					runTurn: (turn) => runGatewayTurn(turn),
					onPairing: (channelId, accountId, info) => {
						const line =
							info.kind === "qr"
								? `[${channelId}/${accountId}] scan the QR code shown in the gateway logs to link your account`
								: `[${channelId}/${accountId}] pairing code: ${info.value}`;
						bootLog(line);
						broadcast("log", { level: "info", message: line, at: Date.now() });
					},
				});
				bundledChannelPlugins.push(whatsappPlugin);
				facadeHandles.push(whatsappPlugin);
				multiAccountSummary.push(`whatsapp x${whatsappAccounts.length}`);
			}
			if (wantTelegramMulti) {
				const telegramPlugin = createTelegramPlugin({
					defaultAgentId: agentId,
					loadConfig: () => cfg as never,
					runTurn: (turn) => runGatewayTurn(turn),
				});
				bundledChannelPlugins.push(telegramPlugin);
				facadeHandles.push(telegramPlugin);
				multiAccountSummary.push(`telegram x${telegramAccounts.length}`);
			}
			if (wantSlackMulti) {
				const slackPlugin = createSlackPlugin({
					defaultAgentId: agentId,
					loadConfig: () => cfg as never,
					runTurn: (turn) => runGatewayTurn(turn),
				});
				bundledChannelPlugins.push(slackPlugin);
				facadeHandles.push(slackPlugin);
				multiAccountSummary.push(`slack x${slackAccounts.length}`);
			}
			if (wantDiscordMulti) {
				const discordPlugin = createDiscordPlugin({
					defaultAgentId: agentId,
					loadConfig: () => cfg as never,
					runTurn: (turn) => runGatewayTurn(turn),
				});
				bundledChannelPlugins.push(discordPlugin);
				facadeHandles.push(discordPlugin);
				multiAccountSummary.push(`discord x${discordAccounts.length}`);
			}
			if (wantIMessageMulti) {
				const imessagePlugin = createIMessagePlugin({
					defaultAgentId: agentId,
					loadConfig: () => cfg as never,
					runTurn: (turn) => runGatewayTurn(turn),
				});
				bundledChannelPlugins.push(imessagePlugin);
				facadeHandles.push(imessagePlugin);
				multiAccountSummary.push(`imessage x${imessageAccounts.length}`);
			}
			if (wantBlueBubblesMulti) {
				const bluebubblesPlugin = createBlueBubblesPlugin({
					defaultAgentId: agentId,
					loadConfig: () => cfg as never,
					runTurn: (turn) => runGatewayTurn(turn),
				});
				bundledChannelPlugins.push(bluebubblesPlugin);
				facadeHandles.push(bluebubblesPlugin);
				multiAccountSummary.push(`bluebubbles x${bluebubblesAccounts.length}`);
			}
			const pluginById = new Map(bundledChannelPlugins.map((p) => [p.id, p] as const));
			// Register each constructed plugin's `meta` + its `messaging`/`security`
			// slots into the process-wide registries. These are full `ChannelPlugin`
			// objects (carrying the slots) that are NOT registered through the
			// `b.channelMessaging`/`b.channelSecurity` context seam, so the
			// registry-getter sync above doesn't see them — wire them here so a
			// multi-account plugin's declared slots are live too.
			for (const plugin of bundledChannelPlugins) registerChannelMeta(plugin.meta);
			syncChannelMessagingAdaptersFromPlugins(bundledChannelPlugins);
			syncChannelSecurityAdaptersFromPlugins(bundledChannelPlugins);
			channelPluginManager = createChannelPluginManager({
				loadConfig: () => cfg as never,
				listChannelPlugins: () => bundledChannelPlugins,
				getChannelPlugin: (id) => pluginById.get(id),
			});
			await channelPluginManager.startChannels();
			// Mount a thin manager facade so the `send_message` + `message_action`
			// agent tools' `getActiveChannelManager().adapter(id)` lookup returns a
			// working per-account adapter on multi-account installs. Without this
			// those tools quietly hid because the legacy `startChannels` manager
			// only runs when there's <= 1 account per channel.
			if (!channelManager) {
				setActiveChannelManager(
					createPluginChannelManagerFacade({ plugins: facadeHandles }),
				);
			}
			bootLog(`channels (multi-account): ${multiAccountSummary.join(", ")}`);
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

	// Initial heartbeat write so an out-of-process supervisor that starts
	// alongside us (or right after) sees a fresh timestamp before the first
	// tick fires; otherwise the first 30 s would look like a stale gateway.
	void writeHeartbeatFile().catch(() => {
		/* best-effort — supervisor degrades to "no heartbeat present" */
	});

	const handle: ServerHandle = {
		port,
		host,
		async stop() {
			// FINAL DRAIN — land the last turn's pending memory extraction before we
			// freeze background work. The debounce timer is unref'd, so without this a
			// clean shutdown right after a turn would silently drop that turn's facts.
			// Bounded inside flushPendingExtraction so it can't hang teardown.
			try {
				await flushPendingExtraction();
			} catch {
				/* best-effort — never block shutdown on extraction */
			}
			setPreCompactionExtractionHook(undefined); // drop the module hook → no stale closure
			setRelinkLlmFactory(undefined); // drop the relink factory → no stale agent-context closure
			serverStopped = true; // freeze background memory work
			// Signal the lane engine to reject new enqueues. Channel inbounds
			// that arrive during shutdown get a clean `GatewayDrainingError`
			// instead of being silently queued against a tearing-down server.
			try {
				markGatewayDraining();
			} catch {
				/* best-effort */
			}
			// Tell connected clients we're going down gracefully BEFORE the
			// sockets close, so a web/mobile UI shows "reconnecting…" and
			// pre-empts the resume instead of treating the drop as an error.
			try {
				sendRawToAll({ type: "shutdown", reason: "gateway shutting down" });
			} catch {
				/* best-effort */
			}
			// Stop the heartbeat runner first so its wake handler unregisters
			// before the rest of the wires unwire — prevents a late wake
			// from firing through a half-torn-down dispatcher.
			try {
				heartbeatRunnerHandle?.stop();
				setHeartbeatBootAgentId(null);
				// Remove only our composed hook, not every registered one
				// (the agent-events bridge's hook is owned by that bridge).
				disposeHeartbeatHook();
			} catch {
				/* best-effort */
			}
			try {
				heartbeatScheduler?.stop();
			} catch {
				/* best-effort */
			}
			try {
				if (configReloadTimer) clearTimeout(configReloadTimer);
				configWatcher?.close();
				configPrimeUnsub?.();
			} catch {
				/* best-effort */
			}
			// Convex mode: stop the config live-query subscription and drain
			// any config writes still on the flush chain so a save made just
			// before shutdown isn't lost. Both are no-ops in filesystem mode.
			try {
				const { disableConfigLiveRefresh } = await import("../storage/boot.js");
				disableConfigLiveRefresh();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitConfigFlush } = await import("../config/io.js");
				await awaitConfigFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitSessionFlush } = await import("../storage/session-cache.js");
				await awaitSessionFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitApprovalsFlush } = await import("./exec-approvals.js");
				await awaitApprovalsFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitAccessFlush } = await import(
					"../agents/channels/access-control/store.js"
				);
				await awaitAccessFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitCronFlush } = await import("../storage/cron-cache.js");
				await awaitCronFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitFactsFlush } = await import("../storage/facts-cache.js");
				await awaitFactsFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitCursorFlush } = await import("../agents/memory/extract.js");
				await awaitCursorFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitAuthFlush } = await import("../auth/profiles.js");
				await awaitAuthFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitProfileStateFlush } = await import("../auth/profile-cooldown.js");
				await awaitProfileStateFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitTranscriptFlush } = await import(
					"../sessions/session-manager-factory.js"
				);
				await awaitTranscriptFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitEventLogFlush } = await import("./event-logger.js");
				await awaitEventLogFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitSubsystemLogFlush } = await import(
					"../logging/subsystem-logger.js"
				);
				await awaitSubsystemLogFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitMediaMirrorFlush } = await import(
					"../agents/channels/whatsapp/media.js"
				);
				await awaitMediaMirrorFlush();
			} catch {
				/* best-effort */
			}
			try {
				const { awaitInboxMirrorFlush } = await import("../agents/session-inbox.js");
				await awaitInboxMirrorFlush();
			} catch {
				/* best-effort */
			}
			try {
				// Drain the live workspace mirror (forces a final persona sweep so
				// an edit inside the watcher debounce window isn't lost), then
				// close the watchers.
				const { awaitWorkspaceMirrorFlush, disposeWorkspaceLiveMirror } = await import(
					"../storage/workspace-live-mirror.js"
				);
				await awaitWorkspaceMirrorFlush();
				disposeWorkspaceLiveMirror();
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
			clearInterval(pingTimer);
			clearInterval(maintenanceTimer);
			if (extractTimer) clearTimeout(extractTimer);
			pendingExtracts.clear();
			// Detach the approval bridge so a late-arriving exec-gate call
			// after stop() doesn't broadcast to dead clients.
			setActiveApprovalBridge(null);
			// Detach the MCP tool-plane host so a late claude-cli turn can't
			// register against a dead gateway (falls back to memory-only stdio).
			setActiveMcpToolPlaneHost(null);
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
			setActiveRegistry(undefined);
			// Stop all product capabilities (channels + services) first so no new
			// inbound turn is enqueued during teardown. Routed through the lifecycle
			// queue so it can't race an in-flight `system.reload`.
			await queueExtensionsOp(stopExtensions).catch(() => {});
			// Best-effort abort of EVERY turn still streaming via the registry's
			// abort-all helper, then also defensively abort any live Pi session
			// indexed by sessionKey (a turn may have registered a session ref
			// without yet enrolling its abortController). WAIT for the turn
			// queue to drain so an in-flight turn's finally — cleanup,
			// broadcast, scheduleExtraction — can't run against a torn-down
			// server after stop() returns.
			try {
				abortAllSessions("shutdown");
			} catch {
				/* best-effort */
			}
			for (const session of liveSessionsByKey.values()) {
				await session.abort().catch(() => {});
			}
			// Serialize the per-lane drain. `markGatewayDraining()` above
			// already rejected new enqueues; this waits up to 10s for the
			// in-flight tasks in every lane to settle.
			try {
				await waitForActiveTasks(10_000);
			} catch {
				/* best-effort drain */
			}
			await turnChainTail.catch(() => {});
			// `runGatewayTurn`'s per-invocation finally already detached each
			// turn's Pi subscription + JSONL logger as the turns settled. The
			// `liveSessionsByKey` map should be empty here; if it isn't (a
			// turn raced shutdown), the registry's `abortAllSessions` above
			// kicked them and their finally chains will fire as the queue drains.
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
			// Clean up the PID + heartbeat pointers last so concurrent
			// `gateway status` calls during shutdown still see sensible
			// (alive) values until the listening socket is actually closed.
			// Heartbeat removed BEFORE pid so a supervisor watching both
			// can never read "fresh heartbeat + missing pid" (an impossible
			// state that would indicate a torn shutdown).
			try {
				await clearHeartbeatFile();
			} catch {
				/* best-effort */
			}
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
