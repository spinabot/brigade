/**
 * Telegram `ChannelPlugin` — the multi-account contract surface.
 *
 * Mirrors `whatsapp/plugin.ts`: wraps `createTelegramAdapter()` (the
 * per-connection implementation) with the lifecycle adapters the
 * `ChannelPluginManager` consumes, so an operator can run MORE THAN ONE
 * Telegram bot at once via:
 *
 *   channels.telegram = {
 *     enabled: true,
 *     accounts: [
 *       { id: "main", botToken: "111:AAA" },
 *       { id: "ops",  botToken: "222:BBB" },
 *     ],
 *   }
 *
 *   - `config.listAccountIds` / `resolveAccount`  → multi-account discovery
 *   - `gateway.startAccount` / `stopAccount`      → per-account bot lifecycle
 *   - `outbound.sendText` / `sendMedia`           → routes by `target.accountId`
 *   - per-account approval-dispatcher registration → an exec-gate prompt raised
 *     by a turn on (telegram, ops) replies on (telegram, ops), not the default
 *
 * Per-account state lives in a `Map<accountId, AccountRuntime>` held in this
 * closure — one bot per account, partitioned token resolution per
 * `channels.telegram.accounts[].botToken`. Inbound dispatch reuses the shared
 * `runChannelInboundPipeline` so the multi-account path carries the identical
 * ACL + debounce + abort + approval-reply + approval-callback surface as the
 * legacy single-adapter manager.
 *
 * The legacy single-account `createTelegramAdapter` (started by the legacy
 * `startChannels` manager) STEPS ASIDE when >1 account is configured — its
 * `isConfigured` returns false for the default account in that case (mirrors
 * WhatsApp), so the two paths never double-start a bot.
 */

import type { BrigadeConfig } from "../../../config/types.js";
// Channel SDK barrel — the SINGLE import surface for the multi-account
// `ChannelPlugin` contract + every sub-adapter type + the shared inbound
// pipeline + the approval router + the gateway boot args. A multi-account
// channel authors entirely from here; nothing reaches past `../sdk.js` into
// `../types.*`, `../inbound-pipeline`, `../approval-router`, `../manager`, or
// `../../extensions/`.
import {
	buildBundledCommands,
	createInboundPipelineContext,
	createSubsystemLogger,
	registerChannelApprovalDispatcher,
	removeChannelApprovalDispatcher,
	runChannelInboundPipeline,
	type ChannelAdapter,
	type ChannelApprovalCapability,
	type ChannelApprovalPromptParams,
	type ChannelCommand,
	type ChannelGatewayContext,
	type ChannelLogoutContext,
	type ChannelLogoutResult,
	type ChannelMeta,
	type ChannelOutboundTarget,
	type ChannelPlugin,
	type ChannelStartContext,
	type InboundMessage,
	type InboundPipelineContext,
	type RunChannelTurnFn,
	type StartChannelsArgs,
} from "../sdk.js";
import {
	listTelegramAccountIds,
	resolveTelegramAccount,
	resolveTelegramBotToken,
	telegramAutoLabelTopics,
	TELEGRAM_CHANNEL_ID,
	TELEGRAM_DEFAULT_ACCOUNT_ID,
	type ResolvedTelegramAccount,
} from "./account-config.js";
import { createTelegramAdapter, TELEGRAM_CAPABILITIES } from "./adapter.js";
import { buildTelegramCommandMenu } from "./command-menu.js";
import { probeTelegram, type TelegramProbeResult } from "./probe.js";

const log = createSubsystemLogger("channels/telegram/plugin");

const TELEGRAM_META: ChannelMeta = {
	id: TELEGRAM_CHANNEL_ID,
	label: "Telegram",
	selectionLabel: "Telegram",
	docsPath: "channels/telegram",
	blurb: "Paste a @BotFather token, DM/group chat over a Telegram bot.",
	order: 20,
	exposure: "public",
	markdownCapable: true,
};

/** Per-account runtime — one started adapter + a pipeline closure. */
interface AccountRuntime {
	adapter: ChannelAdapter;
	pipeline: InboundPipelineContext;
	abort: AbortController;
}

/** Dependencies the gateway hands the plugin to drive turns + replies. */
export interface TelegramPluginDeps {
	/** Boot-time default agent for routing fallbacks. */
	defaultAgentId: string;
	/** Active gateway config — re-read fresh per inbound for live policy. */
	loadConfig: () => BrigadeConfig;
	/** Run one agent turn (the gateway's serialised turn executor). */
	runTurn: StartChannelsArgs["runTurn"];
	/**
	 * Optional adapter factory — tests inject a fake; production uses
	 * `createTelegramAdapter`. Receives the per-account scope + the resolved
	 * command menu + auto-label flag the plugin threads in.
	 */
	adapterFactory?: (args: {
		accountId: string;
		commandMenu: Array<{ command: string; description: string }>;
		autoLabelTopics: boolean;
	}) => ChannelAdapter;
}

/** Operator-grade view of a per-account bot — exposed via attached helpers. */
export interface TelegramPluginRuntimeView {
	/** Currently-running account ids. */
	startedAccountIds(): string[];
	/** Look up the per-account adapter (or undefined when the account isn't started). */
	getAdapter(accountId: string): ChannelAdapter | undefined;
	/** Run a `getMe` probe for an account (for status / doctor). */
	probeAccount(accountId: string, cfg: BrigadeConfig): Promise<TelegramProbeResult>;
}

/** Plugin handle with the extra per-account introspection surface attached. */
export type TelegramPluginHandle = ChannelPlugin<ResolvedTelegramAccount> & TelegramPluginRuntimeView;

/** Build the per-account approval capability — the native button prompt + approver gate. */
function buildApprovalCapability(adapter: ChannelAdapter, accountId: string): ChannelApprovalCapability {
	return {
		async sendApprovalPrompt(params: ChannelApprovalPromptParams): Promise<void> {
			// Delegate to the adapter's own native prompt (inline buttons). The
			// adapter throws when the approval id can't fit the button budget, so
			// the router falls back to its text prompt — mirror that here.
			const cap = adapter.approvalCapability?.sendApprovalPrompt;
			if (!cap) throw new Error("telegram adapter has no approval prompt");
			await cap({ ...params, accountId });
		},
		authorizeApprover(p) {
			const cap = adapter.approvalCapability?.authorizeApprover;
			if (!cap) return { authorized: true };
			return cap(p);
		},
	};
}

/** Construct the plugin instance, capturing per-account runtime state in closure. */
export function createTelegramPlugin(deps: TelegramPluginDeps): TelegramPluginHandle {
	const accountRuntimes = new Map<string, AccountRuntime>();

	const startAccount = async (ctx: ChannelGatewayContext<ResolvedTelegramAccount>): Promise<void> => {
		const accountId = ctx.accountId || TELEGRAM_DEFAULT_ACCOUNT_ID;
		// Re-entrant start (the plugin-manager's restart loop) — stop the prior
		// adapter, then build fresh.
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
			removeChannelApprovalDispatcher(TELEGRAM_CHANNEL_ID, accountId);
			accountRuntimes.delete(accountId);
		}

		const cfg = deps.loadConfig();
		const autoLabel = telegramAutoLabelTopics(cfg);

		// Build the adapter first WITHOUT a command menu, then derive the menu from
		// its bundled commands and rebuild — the command set depends on the adapter
		// (its selfId etc.), so we materialise the bundled commands, map them to the
		// Telegram menu shape, and hand them to the real adapter we start.
		const factory = deps.adapterFactory ?? defaultTelegramAdapterFactory;
		const probeAdapter = factory({ accountId, commandMenu: [], autoLabelTopics: autoLabel });
		const commandMenu = buildTelegramCommandMenu(buildBundledCommands(probeAdapter));
		const adapter = factory({ accountId, commandMenu, autoLabelTopics: autoLabel });

		// Per-account abort derived from the gateway's parent abort.
		const accountAbort = new AbortController();
		const parent = ctx.signal;
		if (parent) {
			if (parent.aborted) accountAbort.abort();
			else parent.addEventListener("abort", () => accountAbort.abort(), { once: true });
		}

		const pipelineRunTurn: RunChannelTurnFn = (turn) => deps.runTurn(turn);
		// Bundled channel commands so `/help` etc. work on the multi-account path.
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of buildBundledCommands(adapter)) {
			commandMap.set(c.name.toLowerCase(), c);
		}
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
				// Re-read the active config per inbound so policy edits land without
				// restarting the bot. Stamp the accountId so the shared pipeline keys
				// ACL + approval-route per account.
				pipeline.config = deps.loadConfig();
				const stamped: InboundMessage = msg.accountId ? msg : { ...msg, accountId };
				await runChannelInboundPipeline(pipeline, stamped);
			},
		};

		try {
			await adapter.start(startCtx);
			accountRuntimes.set(accountId, { adapter, pipeline, abort: accountAbort });
			// Per-account approval dispatcher — native inline-button prompt + per-
			// account routing. Without this an exec-gate prompt from a turn on
			// (telegram, ops) would fall through to the channel default.
			registerChannelApprovalDispatcher(TELEGRAM_CHANNEL_ID, accountId, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, { ...(opts ?? {}), accountId }),
				prettyName: "Telegram",
				approvalCapability: buildApprovalCapability(adapter, accountId),
				getApprovalContext: () => ({ runtime: ctx.runtime, cfg: deps.loadConfig() }),
			});
			log.info("telegram account started", { accountId });
		} catch (err) {
			log.warn("telegram account failed to start", {
				accountId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};

	const stopAccount = async (ctx: ChannelGatewayContext<ResolvedTelegramAccount>): Promise<void> => {
		const runtime = accountRuntimes.get(ctx.accountId);
		if (!runtime) return;
		accountRuntimes.delete(ctx.accountId);
		// Drop the per-account dispatcher BEFORE adapter.stop() so a late in-flight
		// bridge can't ask a torn-down bot to send.
		removeChannelApprovalDispatcher(TELEGRAM_CHANNEL_ID, ctx.accountId);
		try {
			runtime.abort.abort("stop-requested");
		} catch {
			/* best-effort */
		}
		// Clear pending debounce slots so a flush can't fire after stop.
		for (const slot of runtime.pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
		runtime.pipeline.pendingDispatches.clear();
		try {
			await runtime.adapter.stop();
		} catch (err) {
			log.warn("telegram account stop threw", {
				accountId: ctx.accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const logoutAccount = async (
		ctx: ChannelLogoutContext<ResolvedTelegramAccount>,
	): Promise<ChannelLogoutResult> => {
		try {
			await stopAccount(ctx);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		id: TELEGRAM_CHANNEL_ID,
		meta: TELEGRAM_META,
		capabilities: TELEGRAM_CAPABILITIES,
		startedAccountIds: () => [...accountRuntimes.keys()],
		getAdapter: (accountId: string) => accountRuntimes.get(accountId)?.adapter,
		probeAccount: async (accountId, cfg) => {
			const token = resolveTelegramBotToken(cfg, accountId);
			return probeTelegram({ token });
		},
		config: {
			listAccountIds: (cfg) => listTelegramAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveTelegramAccount(cfg, accountId ?? undefined),
			defaultAccountId: () => TELEGRAM_DEFAULT_ACCOUNT_ID,
			isEnabled: (account) => account.enabled,
		},
		gateway: {
			startAccount,
			stopAccount,
			logoutAccount,
		},
		outbound: {
			sendText: async (params) => {
				const accountId = params.target.accountId || TELEGRAM_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime) {
					return { ok: false, error: `telegram account "${accountId}" is not running` };
				}
				try {
					const sent = await runtime.adapter.sendText(params.target.to, params.text, {
						accountId,
						...(params.target.threadId !== undefined ? { threadId: params.target.threadId } : {}),
					});
					return {
						ok: true,
						...(sent && typeof sent === "object" && sent.messageId !== undefined
							? { messageId: sent.messageId }
							: {}),
					};
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			sendMedia: async (params) => {
				const accountId = params.target.accountId || TELEGRAM_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.sendMedia) {
					return { ok: false, error: `telegram account "${accountId}" cannot send media right now` };
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
			sendReaction: async (params) => {
				const accountId = params.target.accountId || TELEGRAM_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.react) {
					return { ok: false, error: `telegram account "${accountId}" cannot react right now` };
				}
				try {
					await runtime.adapter.react(params.target.to, params.messageId, params.emoji);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},
		actions: {
			handleAction: async (params) => {
				const accountId = params.accountId || params.target.accountId || TELEGRAM_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.handleAction) {
					return { ok: false, error: `telegram account "${accountId}" cannot perform message actions` };
				}
				return runtime.adapter.handleAction({
					conversationId: params.target.to,
					action: params.action,
					accountId,
					...(params.signal ? { signal: params.signal } : {}),
				});
			},
		},
		secrets: {
			secretTargetRegistryEntries: [
				{ path: "channels.telegram.botToken", description: "Telegram bot token (single-account)" },
				{ path: "channels.telegram.accounts.*.botToken", description: "Telegram bot token (per account)" },
				{ path: "channels.telegram.webhook.secretToken", description: "Telegram webhook secret token" },
			],
		},
	};
}

/** Default adapter factory — threads the per-account command menu + auto-label flag. */
function defaultTelegramAdapterFactory(args: {
	accountId: string;
	commandMenu: Array<{ command: string; description: string }>;
	autoLabelTopics: boolean;
}): ChannelAdapter {
	return createTelegramAdapter({
		accountId: args.accountId,
		...(args.commandMenu.length > 0 ? { commandMenu: args.commandMenu } : {}),
		autoLabelTopics: args.autoLabelTopics,
	});
}

/** Outbound dispatch helper for callers reaching the plugin directly. */
export type TelegramOutboundTarget = ChannelOutboundTarget;
