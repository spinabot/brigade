/**
 * Channel-plugin manager (multi-account runtime for the Step 15 contract).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/server-channels.ts`,
 * scoped to the slice Brigade needs at this milestone:
 *
 *   - Per-account abort controllers + lifecycle isolation
 *   - Auto-restart with exponential backoff (5s → 5min, capped at 10 attempts)
 *   - Runtime snapshot aggregator for `brigade status`
 *   - Plugin-discovery DI hooks (Brigade's Pi-engine adapter passes the
 *     plugin list in; the manager doesn't own discovery itself)
 *
 * Coexistence with Brigade's existing `manager.ts`:
 *
 *   Brigade today has `agents/channels/manager.ts`, a v1 `ChannelManager`
 *   built around the OLDER `ChannelAdapter` contract (`extensions/types.ts`).
 *   That file is what the WhatsApp adapter and the gateway's `startChannels`
 *   path already use. This new module lives alongside it and consumes the
 *   NEWER `ChannelPlugin` contract (Step 15). The two can coexist: gateway
 *   bootstrap can run BOTH during the migration window; new channels adopt
 *   `ChannelPlugin` going forward.
 *
 * What this module DOES NOT do:
 *
 *   - It does NOT load channel plugins from disk — the `discoverPlugins`
 *     dependency hands an array in. Pi 0.73's extension engine drives
 *     discovery; this manager just consumes the result.
 *   - It does NOT enqueue agent turns. The plugin's `gateway.startAccount`
 *     receives an `AbortSignal` + runtime + cfg and is responsible for
 *     hooking into the rest of Brigade (route resolver → command-queue).
 *   - It does NOT touch the `approval-router.ts` registration — Step 17
 *     adds that wiring when `plugin.approvalAdapter` lands.
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { BrigadeConfig } from "../../config/types.js";
import type {
	ChannelGatewayContext,
	ChannelLogoutContext,
} from "./types.adapters.js";
import type { ChannelAccountSnapshot, RuntimeEnv } from "./types.core.js";
import type { ChannelPlugin } from "./types.plugin.js";

const log = createSubsystemLogger("channels/plugin-manager");

/* ─── Restart-backoff policy (verbatim from upstream) ─────────────── */

const RESTART_INITIAL_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
const RESTART_FACTOR = 2;
const RESTART_JITTER = 0.1;
const RESTART_MAX_ATTEMPTS = 10;

function computeBackoff(attempt: number): number {
	const base = Math.min(
		RESTART_MAX_MS,
		RESTART_INITIAL_MS * Math.pow(RESTART_FACTOR, Math.max(0, attempt - 1)),
	);
	const jitter = base * RESTART_JITTER * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(base + jitter));
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/* ─── Per-channel-account state ───────────────────────────────────── */

type AccountRuntime = {
	aborts: AbortController;
	startedAt: number;
	restartAttempts: number;
	manuallyStopped: boolean;
	healthMonitorEnabled: boolean;
	lastSnapshot: ChannelAccountSnapshot;
};

type ChannelRuntimeState = {
	accounts: Map<string, AccountRuntime>;
};

type ChannelPluginManagerState = {
	channels: Map<string, ChannelRuntimeState>;
};

const PLUGIN_MANAGER_STATE_KEY = Symbol.for("brigade.channelPluginManager.state");

function createState(): ChannelPluginManagerState {
	return { channels: new Map() };
}

function getState(): ChannelPluginManagerState {
	return resolveGlobalSingleton<ChannelPluginManagerState>(PLUGIN_MANAGER_STATE_KEY, createState);
}

function getOrCreateChannelState(channelId: string): ChannelRuntimeState {
	const state = getState();
	const existing = state.channels.get(channelId);
	if (existing) return existing;
	const created: ChannelRuntimeState = { accounts: new Map() };
	state.channels.set(channelId, created);
	return created;
}

/* ─── Manager API + dependencies ──────────────────────────────────── */

export interface ChannelPluginManagerDeps {
	/** Resolve the current config snapshot (called fresh on every start/stop). */
	loadConfig: () => BrigadeConfig;
	/** Enumerate every loaded channel plugin (Pi-engine adapter hands in). */
	listChannelPlugins: () => ChannelPlugin[];
	/** Look up a specific plugin by id. */
	getChannelPlugin: (channelId: string) => ChannelPlugin | undefined;
	/** Per-channel logger (key = channel id). Optional; defaults to subsystem logger. */
	channelLogs?: Record<string, ReturnType<typeof createSubsystemLogger>>;
	/** Per-channel runtime env (key = channel id) handed to adapters. */
	channelRuntimes?: Record<string, RuntimeEnv>;
}

export interface ChannelPluginManager {
	startChannels: () => Promise<void>;
	startChannel: (channelId: string, accountId?: string) => Promise<void>;
	stopChannel: (channelId: string, accountId?: string) => Promise<void>;
	getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
	markChannelLoggedOut: (channelId: string, cleared: boolean, accountId?: string) => void;
	isManuallyStopped: (channelId: string, accountId: string) => boolean;
	resetRestartAttempts: (channelId: string, accountId: string) => void;
	isHealthMonitorEnabled: (channelId: string, accountId: string) => boolean;
}

export interface ChannelRuntimeSnapshot {
	/** Per-channel default-account snapshot (the channel's primary account). */
	channels: Record<string, ChannelAccountSnapshot>;
	/** Per-channel, per-account snapshot map. */
	channelAccounts: Record<string, Record<string, ChannelAccountSnapshot>>;
}

/**
 * Construct a manager that wraps a `ChannelPlugin` list. Returns a handle
 * the gateway boots once at startup. The manager is process-singleton —
 * subsequent `createChannelPluginManager(...)` calls share state via
 * `resolveGlobalSingleton`, so a hot reload doesn't double-spawn.
 */
export function createChannelPluginManager(
	deps: ChannelPluginManagerDeps,
): ChannelPluginManager {
	const channelLogs = deps.channelLogs ?? {};
	const channelRuntimes = deps.channelRuntimes ?? {};

	function getLog(channelId: string) {
		return channelLogs[channelId] ?? log;
	}

	function defaultSnapshot(channelId: string, accountId: string): ChannelAccountSnapshot {
		return { id: accountId, state: "stopped", description: `${channelId}:${accountId}` };
	}

	async function startAccountLoop(
		plugin: ChannelPlugin,
		accountId: string,
		opts: { preserveRestartAttempts?: boolean; preserveManualStop?: boolean } = {},
	): Promise<void> {
		const channelState = getOrCreateChannelState(plugin.id);
		const channelLog = getLog(plugin.id);

		// If we're being asked to start an account that's already running, no-op.
		const existing = channelState.accounts.get(accountId);
		if (existing && !existing.aborts.signal.aborted) return;

		const aborts = new AbortController();
		const runtime: AccountRuntime = {
			aborts,
			startedAt: Date.now(),
			restartAttempts: opts.preserveRestartAttempts ? existing?.restartAttempts ?? 0 : 0,
			manuallyStopped: opts.preserveManualStop ? existing?.manuallyStopped ?? false : false,
			healthMonitorEnabled: true,
			lastSnapshot: defaultSnapshot(plugin.id, accountId),
		};
		channelState.accounts.set(accountId, runtime);

		const cfg = deps.loadConfig();
		const account = plugin.config.resolveAccount(cfg, accountId);

		const gatewayCtx: ChannelGatewayContext<unknown> = {
			account,
			accountId,
			cfg,
			runtime: channelRuntimes[plugin.id] ?? {},
			signal: aborts.signal,
		};

		// Fire-and-track the per-account listener. The plugin's `startAccount`
		// is expected to run until either it returns naturally (no more work)
		// or its abort signal fires. We don't block startChannels on it.
		void (async () => {
			try {
				if (plugin.gateway?.startAccount) {
					await plugin.gateway.startAccount(gatewayCtx);
				}
			} catch (err) {
				channelLog.error(`channel account threw`, {
					channel: plugin.id,
					accountId,
					error: (err as Error)?.message,
				});
			}
			// Auto-restart unless the operator pulled the plug.
			if (runtime.manuallyStopped || aborts.signal.aborted) {
				// Natural exit (operator stop OR abort fired) — drop the runtime
				// entry so a future startChannel call doesn't see a stale
				// aborted entry and skip via the "already running" guard.
				channelState.accounts.delete(accountId);
				return;
			}
			const nextAttempt = runtime.restartAttempts + 1;
			runtime.restartAttempts = nextAttempt;
			if (nextAttempt > RESTART_MAX_ATTEMPTS) {
				channelLog.warn(`channel account giving up after max restart attempts`, {
					channel: plugin.id,
					accountId,
					attempts: nextAttempt,
				});
				// Same cleanup: drop the runtime entry so the operator can
				// `brigade channels start` a fresh attempt later without
				// tripping the "already running" guard.
				channelState.accounts.delete(accountId);
				return;
			}
			const delayMs = computeBackoff(nextAttempt);
			channelLog.info(`channel account restart scheduled`, {
				channel: plugin.id,
				accountId,
				attempt: nextAttempt,
				delayMs,
			});
			await sleepWithAbort(delayMs, aborts.signal);
			if (aborts.signal.aborted || runtime.manuallyStopped) {
				channelState.accounts.delete(accountId);
				return;
			}
			// Drop the prior runtime entry BEFORE recursing so the inner
			// `existing && !existing.aborts.signal.aborted` guard sees the
			// fresh slot land.
			channelState.accounts.delete(accountId);
			await startAccountLoop(plugin, accountId, {
				preserveRestartAttempts: true,
				preserveManualStop: true,
			});
		})();
	}

	async function stopAccount(plugin: ChannelPlugin, accountId: string): Promise<void> {
		const channelState = getOrCreateChannelState(plugin.id);
		const runtime = channelState.accounts.get(accountId);
		if (!runtime) return;
		runtime.manuallyStopped = true;
		runtime.aborts.abort("stop-requested");
		if (plugin.gateway?.stopAccount) {
			const cfg = deps.loadConfig();
			const account = plugin.config.resolveAccount(cfg, accountId);
			const ctx: ChannelGatewayContext<unknown> = {
				account,
				accountId,
				cfg,
				runtime: channelRuntimes[plugin.id] ?? {},
				signal: runtime.aborts.signal,
			};
			try {
				await plugin.gateway.stopAccount(ctx);
			} catch (err) {
				getLog(plugin.id).warn(`channel stopAccount threw`, {
					accountId,
					error: (err as Error)?.message,
				});
			}
		}
		channelState.accounts.delete(accountId);
	}

	const manager: ChannelPluginManager = {
		startChannels: async () => {
			for (const plugin of deps.listChannelPlugins()) {
				try {
					await manager.startChannel(plugin.id);
				} catch (err) {
					getLog(plugin.id).error(`channel startup failed`, {
						channel: plugin.id,
						error: (err as Error)?.message,
					});
				}
			}
		},

		startChannel: async (channelId, accountId) => {
			const plugin = deps.getChannelPlugin(channelId);
			if (!plugin) {
				log.warn("startChannel called for unknown plugin id", { channelId });
				return;
			}
			if (!plugin.gateway?.startAccount) {
				log.debug("plugin has no gateway.startAccount; skipping", { channelId });
				return;
			}
			const cfg = deps.loadConfig();
			const accountIds = accountId
				? [accountId]
				: plugin.config.listAccountIds(cfg);
			await Promise.all(accountIds.map((id) => startAccountLoop(plugin, id)));
		},

		stopChannel: async (channelId, accountId) => {
			const plugin = deps.getChannelPlugin(channelId);
			if (!plugin) return;
			const channelState = getState().channels.get(channelId);
			if (!channelState) return;
			const accountIds = accountId ? [accountId] : Array.from(channelState.accounts.keys());
			await Promise.all(accountIds.map((id) => stopAccount(plugin, id)));
		},

		getRuntimeSnapshot: () => {
			const cfg = deps.loadConfig();
			const channels: Record<string, ChannelAccountSnapshot> = {};
			const channelAccounts: Record<string, Record<string, ChannelAccountSnapshot>> = {};
			for (const plugin of deps.listChannelPlugins()) {
				const accountIds = plugin.config.listAccountIds(cfg);
				if (accountIds.length === 0) continue;
				const perAccount: Record<string, ChannelAccountSnapshot> = {};
				const channelState = getState().channels.get(plugin.id);
				for (const accountId of accountIds) {
					const runtime = channelState?.accounts.get(accountId);
					const account = plugin.config.resolveAccount(cfg, accountId);
					const enabled = plugin.config.isEnabled?.(account, cfg) ?? true;
					const snapshot: ChannelAccountSnapshot = {
						id: accountId,
						state: runtime
							? runtime.manuallyStopped
								? "stopped"
								: "running"
							: "stopped",
						description: `${plugin.id}:${accountId}`,
					};
					if (!enabled) snapshot.state = "stopped";
					perAccount[accountId] = snapshot;
				}
				channelAccounts[plugin.id] = perAccount;
				const firstId = accountIds[0];
				if (firstId !== undefined && perAccount[firstId] !== undefined) {
					channels[plugin.id] = perAccount[firstId] as ChannelAccountSnapshot;
				}
			}
			return { channels, channelAccounts };
		},

		markChannelLoggedOut: (channelId, cleared, accountId) => {
			const channelState = getState().channels.get(channelId);
			if (!channelState) return;
			const ids = accountId ? [accountId] : Array.from(channelState.accounts.keys());
			for (const id of ids) {
				const runtime = channelState.accounts.get(id);
				if (!runtime) continue;
				runtime.manuallyStopped = true;
				runtime.lastSnapshot.state = "stopped";
				if (cleared) channelState.accounts.delete(id);
			}
		},

		isManuallyStopped: (channelId, accountId) => {
			const runtime = getState().channels.get(channelId)?.accounts.get(accountId);
			return Boolean(runtime?.manuallyStopped);
		},

		resetRestartAttempts: (channelId, accountId) => {
			const runtime = getState().channels.get(channelId)?.accounts.get(accountId);
			if (runtime) runtime.restartAttempts = 0;
		},

		isHealthMonitorEnabled: (channelId, accountId) => {
			const runtime = getState().channels.get(channelId)?.accounts.get(accountId);
			return Boolean(runtime?.healthMonitorEnabled);
		},
	};

	return manager;
}

/** Test-only — drop every channel/account entry from the singleton state. */
export function resetChannelPluginManagerStateForTests(): void {
	const state = getState();
	for (const channelState of state.channels.values()) {
		for (const runtime of channelState.accounts.values()) {
			runtime.aborts.abort("test-reset");
		}
		channelState.accounts.clear();
	}
	state.channels.clear();
}

/** Helper for plugins that need to fire a logout flow on operator command. */
export async function logoutChannelAccount(params: {
	plugin: ChannelPlugin;
	accountId: string;
	cfg: BrigadeConfig;
	runtime: RuntimeEnv;
	purge?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
	const logoutFn = params.plugin.gateway?.logoutAccount;
	if (!logoutFn) return { ok: false, error: "channel does not support logout" };
	const account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
	const ctx: ChannelLogoutContext<unknown> = {
		account,
		accountId: params.accountId,
		cfg: params.cfg,
		runtime: params.runtime,
		...(params.purge ? { purge: true } : {}),
	};
	try {
		return await logoutFn(ctx);
	} catch (err) {
		return { ok: false, error: (err as Error)?.message };
	}
}
