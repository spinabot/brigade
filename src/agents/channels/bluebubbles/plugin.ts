/**
 * BlueBubbles `ChannelPlugin` — the multi-ACCOUNT contract surface.
 *
 * Mirrors `slack/plugin.ts` (webhook-in + REST-out, multi-account): wraps
 * `createBlueBubblesAdapter()` once per configured account, partitions per-account
 * runtime in a `Map<accountId, AccountRuntime>`, and drives each account's inbound
 * through the shared `runChannelInboundPipeline` so every account carries the
 * identical ACL + debounce + abort surface.
 *
 * The webhook bridge: each module-registered route resolves its account's STARTED
 * adapter via the per-account registry (`account-registry.ts`). This plugin
 * populates that registry on `startAccount` (so a webhook POST for THIS account's
 * path reaches THIS adapter) and clears it on `stopAccount` (so a torn-down
 * account's route can't feed a dead adapter).
 *
 * The legacy single-account `createBlueBubblesAdapter` STEPS ASIDE when >1 account
 * is configured (its `isConfigured` returns false for the default account).
 */

import type { BrigadeConfig } from "../../../config/types.js";
import {
	buildBundledCommands,
	createInboundPipelineContext,
	createSubsystemLogger,
	runChannelInboundPipeline,
	type ChannelAccountSnapshot,
	type ChannelAdapter,
	type ChannelCommand,
	type ChannelGatewayContext,
	type ChannelLogoutContext,
	type ChannelLogoutResult,
	type ChannelOutboundTarget,
	type ChannelPlugin,
	type ChannelStartContext,
	type InboundMessage,
	type InboundPipelineContext,
	type RunChannelTurnFn,
	type StartChannelsArgs,
	BLUEBUBBLES_CHANNEL_META,
} from "../sdk.js";
import {
	listBlueBubblesAccountIds,
	resolveBlueBubblesAccount,
	resolveBlueBubblesPassword,
	resolveBlueBubblesProbeTimeoutMs,
	resolveBlueBubblesServerUrl,
	BLUEBUBBLES_CHANNEL_ID,
	BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
	type ResolvedBlueBubblesAccount,
} from "./account-config.js";
import { registerBlueBubblesAccountSink, removeBlueBubblesAccountSink } from "./account-registry.js";
import { createBlueBubblesAdapter, type BlueBubblesAdapter } from "./adapter.js";
import { bluebubblesMessagingAdapter } from "./messaging.js";
import { probeBlueBubbles, type BlueBubblesProbeResult } from "./probe.js";
import { collectBlueBubblesStatusIssues, statusAccountFromSnapshot, toChannelStatusIssues } from "./status-issues.js";

const log = createSubsystemLogger("channels/bluebubbles/plugin");

const BLUEBUBBLES_META = BLUEBUBBLES_CHANNEL_META;

/** BlueBubbles capabilities baseline (rich actions are gated at runtime by Private-API status). */
const BLUEBUBBLES_BASE_CAPABILITIES = {
	chatTypes: ["direct", "group"] as Array<"direct" | "group">,
	media: true,
	reply: true,
	reactions: true,
	edit: true,
	unsend: true,
};

/** Per-account runtime — one started adapter + a pipeline closure. */
interface AccountRuntime {
	adapter: BlueBubblesAdapter;
	pipeline: InboundPipelineContext;
	abort: AbortController;
}

/** Dependencies the gateway hands the plugin to drive turns + replies. */
export interface BlueBubblesPluginDeps {
	defaultAgentId: string;
	loadConfig: () => BrigadeConfig;
	runTurn: StartChannelsArgs["runTurn"];
	/** Optional adapter factory — tests inject a fake; production uses `createBlueBubblesAdapter`. */
	adapterFactory?: (args: { accountId: string }) => BlueBubblesAdapter;
}

/** Operator-grade view of a per-account bridge — exposed via attached helpers. */
export interface BlueBubblesPluginRuntimeView {
	startedAccountIds(): string[];
	getAdapter(accountId: string): ChannelAdapter | undefined;
	probeAccount(accountId: string, cfg: BrigadeConfig): Promise<BlueBubblesProbeResult>;
}

/** Plugin handle with the extra per-account introspection surface attached. */
export type BlueBubblesPluginHandle = ChannelPlugin<ResolvedBlueBubblesAccount> & BlueBubblesPluginRuntimeView;

/** Construct the plugin instance, capturing per-account runtime state in closure. */
export function createBlueBubblesPlugin(deps: BlueBubblesPluginDeps): BlueBubblesPluginHandle {
	const accountRuntimes = new Map<string, AccountRuntime>();

	const startAccount = async (ctx: ChannelGatewayContext<ResolvedBlueBubblesAccount>): Promise<void> => {
		const accountId = ctx.accountId || BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
		const existing = accountRuntimes.get(accountId);
		if (existing) {
			try {
				await existing.adapter.stop();
			} catch {
				/* best-effort */
			}
			try {
				existing.abort.abort("restart");
			} catch {
				/* best-effort */
			}
			removeBlueBubblesAccountSink(accountId);
			accountRuntimes.delete(accountId);
		}

		const cfg = deps.loadConfig();
		const factory = deps.adapterFactory ?? defaultBlueBubblesAdapterFactory;
		const adapter = factory({ accountId });

		const accountAbort = new AbortController();
		const parent = ctx.signal;
		if (parent) {
			if (parent.aborted) accountAbort.abort();
			else parent.addEventListener("abort", () => accountAbort.abort(), { once: true });
		}

		const pipelineRunTurn: RunChannelTurnFn = (turn) => deps.runTurn(turn);
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of buildBundledCommands(adapter)) commandMap.set(c.name.toLowerCase(), c);
		const pipeline = createInboundPipelineContext({
			adapter,
			config: cfg,
			agentId: deps.defaultAgentId,
			runTurn: pipelineRunTurn,
			commandMap,
			parentAbort: accountAbort.signal,
		});

		const startCtx: ChannelStartContext = {
			signal: accountAbort.signal,
			log: (msg, meta) => log.info(`[${accountId}] ${msg}`, meta),
			onInbound: async (msg: InboundMessage) => {
				pipeline.config = deps.loadConfig();
				const stamped: InboundMessage = msg.accountId ? msg : { ...msg, accountId };
				await runChannelInboundPipeline(pipeline, stamped);
			},
		};

		try {
			await adapter.start(startCtx);
			accountRuntimes.set(accountId, { adapter, pipeline, abort: accountAbort });
			// Bridge this started adapter to its webhook route via the registry.
			registerBlueBubblesAccountSink(accountId, {
				feedWebhookEvent: (eventType, payload) => adapter.feedWebhookEvent(eventType, payload),
			});
			log.info("bluebubbles account started", { accountId });
		} catch (err) {
			log.warn("bluebubbles account failed to start", {
				accountId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};

	const stopAccount = async (ctx: ChannelGatewayContext<ResolvedBlueBubblesAccount>): Promise<void> => {
		const runtime = accountRuntimes.get(ctx.accountId);
		// Drop the sink BEFORE teardown so a late in-flight POST can't drive a dead adapter.
		removeBlueBubblesAccountSink(ctx.accountId);
		if (!runtime) return;
		accountRuntimes.delete(ctx.accountId);
		try {
			runtime.abort.abort("stop-requested");
		} catch {
			/* best-effort */
		}
		for (const slot of runtime.pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
		runtime.pipeline.pendingDispatches.clear();
		try {
			await runtime.adapter.stop();
		} catch (err) {
			log.warn("bluebubbles account stop threw", {
				accountId: ctx.accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const logoutAccount = async (ctx: ChannelLogoutContext<ResolvedBlueBubblesAccount>): Promise<ChannelLogoutResult> => {
		try {
			await stopAccount(ctx);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		id: BLUEBUBBLES_CHANNEL_ID,
		meta: BLUEBUBBLES_META,
		capabilities: BLUEBUBBLES_BASE_CAPABILITIES,
		startedAccountIds: () => [...accountRuntimes.keys()],
		getAdapter: (accountId: string) => accountRuntimes.get(accountId)?.adapter,
		probeAccount: async (accountId, cfg): Promise<BlueBubblesProbeResult> => {
			return probeBlueBubbles({
				serverUrl: resolveBlueBubblesServerUrl(cfg, accountId),
				password: resolveBlueBubblesPassword(cfg, accountId),
				timeoutMs: resolveBlueBubblesProbeTimeoutMs(cfg, accountId),
			});
		},
		config: {
			listAccountIds: (cfg) => listBlueBubblesAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount(cfg, accountId ?? undefined),
			defaultAccountId: () => BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
			isEnabled: (account) => account.enabled,
		},
		gateway: {
			startAccount,
			stopAccount,
			logoutAccount,
		},
		status: {
			// Stamp probe-derived diagnostics onto the open-shaped snapshot so
			// `collectStatusIssues` can derive structured issues without re-probing.
			buildAccountSnapshot: async ({ account, cfg, runtime }) => {
				const base: Record<string, unknown> = { ...(runtime ?? {}), id: account.accountId };
				const configured = Boolean(account.serverUrl) && Boolean(account.password);
				base.configured = configured;
				if (configured) {
					try {
						const probe = await probeBlueBubbles({
							serverUrl: resolveBlueBubblesServerUrl(cfg, account.accountId),
							password: resolveBlueBubblesPassword(cfg, account.accountId),
							timeoutMs: resolveBlueBubblesProbeTimeoutMs(cfg, account.accountId),
						});
						base.reachable = probe.ok;
						base.privateApi = probe.privateApi;
					} catch {
						base.reachable = false;
					}
				}
				return base as ChannelAccountSnapshot;
			},
			collectStatusIssues: (accounts) =>
				toChannelStatusIssues(collectBlueBubblesStatusIssues((accounts ?? []).map((s) => statusAccountFromSnapshot(s)))),
		},
		outbound: {
			sendText: async (params) => {
				const accountId = params.target.accountId || BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime) return { ok: false, error: `bluebubbles account "${accountId}" is not running` };
				try {
					const sent = await runtime.adapter.sendText(params.target.to, params.text, { accountId });
					return {
						ok: true,
						...(sent && typeof sent === "object" && sent.messageId !== undefined ? { messageId: sent.messageId } : {}),
					};
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			sendMedia: async (params) => {
				const accountId = params.target.accountId || BLUEBUBBLES_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.sendMedia) {
					return { ok: false, error: `bluebubbles account "${accountId}" cannot send media right now` };
				}
				try {
					await runtime.adapter.sendMedia(params.target.to, {
						kind: (params.mediaType as never) ?? "document",
						path: params.mediaUrl,
						...(params.caption !== undefined ? { caption: params.caption } : {}),
					});
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},
		messaging: bluebubblesMessagingAdapter,
		secrets: {
			// The server password is a sealable secret-ref target.
			secretTargetRegistryEntries: [
				{ path: "channels.bluebubbles.password", description: "BlueBubbles server password (single-account)" },
				{ path: "channels.bluebubbles.accounts.*.password", description: "BlueBubbles server password (per account)" },
			],
		},
	};
}

/** Default adapter factory — threads the per-account scope. */
function defaultBlueBubblesAdapterFactory(args: { accountId: string }): BlueBubblesAdapter {
	return createBlueBubblesAdapter({ accountId: args.accountId });
}

/** Outbound dispatch helper for callers reaching the plugin directly. */
export type BlueBubblesOutboundTarget = ChannelOutboundTarget;
