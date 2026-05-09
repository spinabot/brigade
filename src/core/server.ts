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
import { type AgentSessionEvent, type AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
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
import {
	buildAgent,
	runWithContentQualityRetry,
	runWithFallback,
	runWithHeartbeat,
	runWithLengthContinuation,
	runWithStreamTimeout,
	runWithThinkingFallback,
	switchModelMidTurn,
} from "./agent.js";
import { makeEmbeddedChatClient } from "../agents/embedded-chat-client.js";
import { loadBrigadeAuthStorage } from "./auth-bridge.js";
import { BRIGADE_DIR, getBrigadeWorkspaceDir, loadConfig, saveConfig, type Config } from "./config.js";
import { acquireGatewayLock, type GatewayLockHandle } from "./gateway-lock.js";
import { clearPidFile, writePidFile } from "./gateway-probe.js";

// Persist a model selection to brigade.json's new wizard-shape (the lifted
// code expected the older flat `defaultProvider`/`defaultModelId` fields).
// Writes through the same `agents.defaults.{provider, model.primary}` path
// the onboard wizard uses, so set-model and onboard stay consistent.
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
import { pickStreamIdleMs } from "./model-caps.js";
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
		let model = modelRegistry.find(provider, modelId);
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
	const { opts, port, host, startupStartedAt, lockHandle, authStorage, modelRegistry, bootLog, provider, modelId } = args;
	let model = args.model;

	// Build the Pi session. This is the ONLY agent in the server process.
	//
	// cwd = workspace dir (NOT the gateway's launch dir).
	//
	// Why: openclaw runs its agent with cwd = `~/.openclaw/workspace` and
	// gets correct bootstrap behaviour where Brigade kept failing. Tracing
	// openclaw's session log (May 2026, GPT-5.4) confirmed:
	//   - openclaw's session cwd is the WORKSPACE dir, not the gateway
	//     launch dir. The system prompt's "Workspace" section reports
	//     `~/.openclaw/workspace` — a neutral folder, no project bias.
	//   - The model's reply correctly opens with "I'm your OpenClaw assistant,
	//     just waking up in this workspace. I don't have a real name yet…"
	//
	// Brigade was passing `process.cwd()` here, which (when the gateway
	// is launched from the Brigade source repo, the natural dogfooding
	// position) put `C:\...\Brigade` into the prompt's Workspace section.
	// The model read that as "I'm the assistant for the Brigade project"
	// and ignored IDENTITY.md every time — across Sonnet 4.6, Haiku 4.5,
	// GPT-5, all models, even after we put "You are felix" at position 0.
	//
	// The trade-off: tools (read/edit/write/bash) now resolve relative
	// paths against the workspace dir instead of the user's project. For
	// project-aware coding work, users should use `brigade chat` (which
	// keeps process.cwd()) or pass absolute paths. The gateway is the
	// "personal assistant" surface; chat is the "coding agent" surface.
	const session = await buildAgent({
		authStorage,
		modelRegistry,
		model,
		cwd: getBrigadeWorkspaceDir(),
	});

	// Wrap the long-lived Pi session in a Brigade-native ChatClient. The
	// gateway uses `client.X` for all read/write operations; the raw
	// `session` is kept around only for the wrapper composition further
	// below (Phase 5 will move that into the client and drop `session`).
	const client = makeEmbeddedChatClient({ session });

	// Stream every Pi event to the JSONL log file. Logger silently degrades
	// on I/O errors so log loss never crashes the server.
	const detachLogger = attachEventLogger(session);

	// Cumulative usage totals for the state snapshot. Pi reports per-turn
	// usage on turn_end; we accumulate across turns.
	let totalIn = 0;
	let totalOut = 0;
	let totalCost = 0;
	let isAgentRunning = false;

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
		if (client.messages.length > 0) return false;
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
		const usage = client.getContextUsage();
		return {
			provider,
			modelId,
			modelName: client.model?.name,
			thinkingLevel: client.thinkingLevel,
			supportsThinking: client.supportsThinking(),
			availableThinkingLevels: [...client.getAvailableThinkingLevels()],
			contextUsagePercent: usage?.percent ?? null,
			totalTokensIn: totalIn,
			totalTokensOut: totalOut,
			totalCostUsd: totalCost,
			isAgentRunning,
			messageCount: client.messages.length,
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

	/* ──────────────── pi event forwarding ──────────────── */

	const detachPi = client.subscribe((piEvent: AgentSessionEvent) => {
		if (piEvent.type === "agent_start") isAgentRunning = true;
		if (piEvent.type === "agent_end") isAgentRunning = false;
		if (piEvent.type === "turn_end") {
			const usage = (piEvent as any).message?.usage;
			if (usage) {
				totalIn += usage.input ?? 0;
				totalOut += usage.output ?? 0;
				totalCost += usage.cost ?? 0;
			}
		}
		// Live console stream (verbose mode). Mirrors the JSONL file but
		// human-readable. Same event sequence in both places.
		opts.consoleStream?.pi(piEvent);
		broadcast("pi", { event: piEvent });
		broadcast("state", buildSnapshot());
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
				// Resolve fallback model fresh per turn — the user may have
				// edited config (or rotated keys) between turns. F:\Brigade's
				// new shape: `agents.defaults.model.fallbacks[]` (string array).
				const cfgNow = await loadConfig();
				const wizardNow = (cfgNow.agents as { defaults?: { provider?: string; model?: { fallbacks?: string[] } } } | undefined)?.defaults;
				const fallbackProvider = wizardNow?.provider;
				const fallbackModelId = wizardNow?.model?.fallbacks?.[0];
				const fallbackModel =
					fallbackProvider && fallbackModelId
						? modelRegistry.find(fallbackProvider, fallbackModelId)
						: undefined;

				// Mirror the chat.ts composition so anything driven through the
				// gateway gets the same loop semantics. Composition (outer→inner):
				//   1. runWithFallback             — multi-model failover (outermost)
				//   2. runWithHeartbeat            — periodic "still working…" log
				//   3. runWithStreamTimeout        — abort on per-provider idle threshold
				//   4. runWithLengthContinuation   — auto-continue truncated replies
				//   5. runWithContentQualityRetry  — re-prompt empty/reasoning-only/planning-only
				//   6. runWithThinkingFallback     — auto-downgrade thinking on rejection
				//   7. session.prompt              — Pi's actual loop (innermost)
				await runWithFallback(session, p.text, {
					fallbacks: fallbackModel ? [{ model: fallbackModel }] : [],
					wrapAttempt: (promptFn) =>
						runWithHeartbeat(
							session,
							() =>
								runWithStreamTimeout(
									session,
									() =>
										runWithLengthContinuation(
											session,
											() =>
												runWithContentQualityRetry(
													session,
													() =>
														runWithThinkingFallback(session, promptFn, {
															onDowngrade: (originalLevel) => {
																broadcast("log", {
																	level: "info",
																	message: `model doesn't support thinking — switching from ${originalLevel} to off and retrying`,
																	at: Date.now(),
																});
															},
														}),
													{
														onRetry: (reason) => {
															broadcast("log", {
																level: "info",
																message: `${reason} — re-prompting for a usable answer`,
																at: Date.now(),
															});
														},
													},
												),
											{
												onContinue: () => {
													broadcast("log", {
														level: "info",
														message: "reply was truncated — asking the model to continue",
														at: Date.now(),
													});
												},
											},
										),
									{
										idleMs: session.model ? pickStreamIdleMs(session.model) : 60_000,
										onTimeout: (ms) => {
											broadcast("log", {
												level: "warn",
												message: `no response for ${Math.round(ms / 1000)}s — aborting`,
												at: Date.now(),
											});
										},
									},
								),
							{
								intervalMs: 30_000,
								onHeartbeat: (ms) => {
									broadcast("log", {
										level: "info",
										message: `still working… ${Math.round(ms / 1000)}s elapsed`,
										at: Date.now(),
									});
								},
							},
						),
					onFallback: (reason: string, next) => {
						broadcast("log", {
							level: "warn",
							message: `primary failed (${reason}) — trying ${next.label ?? "fallback"}`,
							at: Date.now(),
						});
					},
					onFallbackExhausted: (reason: string) => {
						broadcast("log", {
							level: "error",
							message: `all fallback models failed: ${reason}`,
							at: Date.now(),
						});
					},
					// Per-error-class retry visibility — without these the connect
					// TUI sees the gateway go silent for 30s/60s/5min during a
					// rate-limit retry and assumes the daemon is dead. Broadcasting
					// each retry attempt + each context-overflow compaction lets
					// the operator (chat OR connect) understand what's happening.
					retryPolicy: {
						onRetry: (info) => {
							broadcast("log", {
								level: info.class === "context_overflow" ? "info" : "warn",
								message: `${info.reason}`,
								at: Date.now(),
							});
						},
						onCompactBeforeRetry: () => {
							broadcast("log", {
								level: "info",
								message: "context overflow — compacting then retrying same model",
								at: Date.now(),
							});
						},
					},
				});
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "abort": {
				await client.abort().catch(() => {});
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "steer": {
				const p = params as RequestParams["steer"];
				// `client.steer({text})` wraps the text into Pi's
				// `{role:"user", content:[{type:"text",text}]}` shape internally
				// — same as the previous `session.agent.steer({...})` call.
				// Awaited so async errors (invalid encoding, transcript I/O)
				// surface as RPC failures to the caller instead of dropping
				// silently and leaving the user waiting for a steer that
				// never landed.
				await client.steer({ text: p.text });
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "set-model": {
				const p = params as RequestParams["set-model"];
				const target = modelRegistry.find(p.provider, p.modelId);
				if (!target) throw new Error(`model ${p.provider}/${p.modelId} not found`);
				await client.setModel(target);
				model = target;
				await saveConfig(persistDefaultModel(await loadConfig(), p.provider, p.modelId));
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "switch-model-mid-turn": {
				const p = params as RequestParams["switch-model-mid-turn"];
				const target = modelRegistry.find(p.provider, p.modelId);
				if (!target) throw new Error(`model ${p.provider}/${p.modelId} not found`);
				await switchModelMidTurn(session, target, p.replayMessage);
				model = target;
				await saveConfig(persistDefaultModel(await loadConfig(), p.provider, p.modelId));
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "set-thinking": {
				const p = params as RequestParams["set-thinking"];
				client.setThinkingLevel(p.level as never);
				broadcast("state", buildSnapshot());
				return undefined as ResponseFor[M];
			}
			case "compact": {
				await client.compact();
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
			default:
				throw new Error(`unknown method: ${method}`);
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

	// Phase 10 — log-file pointer. Mirrors openclaw's
	// `log file: <path>` line (`src/gateway/server-startup-log.ts:33`).
	bootLog(`log file: ${getTodayLogPath()}`);

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
			clearInterval(tickTimer);
			detachPi();
			detachLogger();
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
