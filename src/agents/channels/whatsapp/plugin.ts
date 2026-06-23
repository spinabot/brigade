/**
 * WhatsApp `ChannelPlugin` — the multi-account contract surface.
 *
 * Wraps `createWhatsAppAdapter()` (the per-connection implementation) with
 * the lifecycle adapters the `ChannelPluginManager` consumes:
 *
 *   - `config.listAccountIds` / `resolveAccount`  → multi-account discovery
 *   - `gateway.startAccount` / `stopAccount`      → per-account socket lifecycle
 *   - `outbound.sendText` / `sendMedia`           → routes by `target.accountId`
 *
 * Per-account state lives in a `Map<accountId, AccountRuntime>` held in this
 * closure — one socket per account, partitioned auth dirs at
 * `~/.brigade/channels/whatsapp/<accountId>/auth/`. Inbound dispatch reuses
 * the shared `runChannelInboundPipeline` so the multi-account path carries
 * the identical ACL + debounce + abort + approval-reply intercept surface as
 * the legacy single-adapter manager.
 */

import { createSubsystemLogger } from "../../../logging/subsystem-logger.js";
import { ensureDir } from "../../../config/paths.js";
import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";
import type { BrigadeConfig } from "../../../config/types.js";
import type {
	ChannelAdapter,
	ChannelStartContext,
	InboundMessage,
} from "../../extensions/types.js";
import {
	registerChannelApprovalDispatcher,
	removeChannelApprovalDispatcher,
} from "../approval-router.js";
import {
	buildBundledCommands,
	createInboundPipelineContext,
	runChannelInboundPipeline,
	type InboundPipelineContext,
	type RunChannelTurnFn,
} from "../inbound-pipeline.js";
import type { ChannelCommand } from "../../extensions/types.js";
import type { StartChannelsArgs } from "../manager.js";
import type {
	ChannelGatewayContext,
	ChannelLogoutContext,
	ChannelLogoutResult,
	ChannelOutboundTarget,
} from "../types.adapters.js";
import type { ChannelPlugin } from "../types.plugin.js";
import { WHATSAPP_CHANNEL_META } from "../bundled-channel-metas.js";
import {
	listWhatsAppAccountIds,
	resolveWhatsAppAccount,
	WHATSAPP_CHANNEL_ID,
	WHATSAPP_DEFAULT_ACCOUNT_ID,
	type ResolvedWhatsAppAccount,
} from "./account-config.js";
import { createWhatsAppAdapter } from "./adapter.js";

const log = createSubsystemLogger("channels/whatsapp/plugin");

// Single source of truth for the channel's user-facing metadata lives in the
// import-light `bundled-channel-metas` module (so the registry / markdown gate
// can read it without loading this adapter). `WHATSAPP_CHANNEL_META.id` is the
// same canonical `"whatsapp"` string as `WHATSAPP_CHANNEL_ID`.
const WHATSAPP_META = WHATSAPP_CHANNEL_META;

/** Per-account runtime — one started adapter + a pipeline closure. */
interface AccountRuntime {
	adapter: ChannelAdapter;
	pipeline: InboundPipelineContext;
	abort: AbortController;
}

/** Dependencies the gateway hands the plugin to drive turns + replies. */
export interface WhatsAppPluginDeps {
	/** Boot-time defaults for routing fallbacks. */
	defaultAgentId: string;
	/** Active gateway config — re-read fresh per inbound for live policy. */
	loadConfig: () => BrigadeConfig;
	/** Run one agent turn (the gateway's serialised turn executor). */
	runTurn: StartChannelsArgs["runTurn"];
	/**
	 * Surface pairing QR / codes to the operator. The plugin path adds the
	 * `accountId` so concurrent pairings (personal + work) never interleave
	 * unlabelled QR images in the log.
	 */
	onPairing?: (
		channelId: string,
		accountId: string,
		info: { kind: "qr" | "code"; value: string },
	) => void;
	/** Optional adapter factory — tests inject a fake; production uses `createWhatsAppAdapter`. */
	adapterFactory?: (args: { accountId: string; authDir: string }) => ChannelAdapter;
}

/** Operator-grade view of a per-account socket — exposed via attached helpers. */
export interface WhatsAppPluginRuntimeView {
	/** Currently-running account ids. */
	startedAccountIds(): string[];
	/** Look up the per-account adapter (or undefined when the account isn't started). */
	getAdapter(accountId: string): ChannelAdapter | undefined;
}

/** Plugin handle with the extra per-account introspection surface attached. */
export type WhatsAppPluginHandle = ChannelPlugin<ResolvedWhatsAppAccount> & WhatsAppPluginRuntimeView;

/** Construct the plugin instance, capturing per-account runtime state in closure. */
export function createWhatsAppPlugin(
	deps: WhatsAppPluginDeps,
): WhatsAppPluginHandle {
	const accountRuntimes = new Map<string, AccountRuntime>();

	const startAccount = async (
		ctx: ChannelGatewayContext<ResolvedWhatsAppAccount>,
	): Promise<void> => {
		const accountId = ctx.accountId || WHATSAPP_DEFAULT_ACCOUNT_ID;
		// Re-entrant start (e.g. the plugin-manager's restart loop) should pick
		// up where it left off — stop the prior adapter, then build fresh.
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
			removeChannelApprovalDispatcher(WHATSAPP_CHANNEL_ID, accountId);
			accountRuntimes.delete(accountId);
		}
		const account = ctx.account;
		// Convex mode owns auth in tables (useConvexAuthState) — don't create
		// the on-disk auth dir under ~/.brigade (strict-zero).
		if (tryGetRuntimeContext()?.mode !== "convex") ensureDir(account.authDir);

		const factory = deps.adapterFactory ?? createWhatsAppAdapter;
		const adapter = factory({
			accountId,
			authDir: account.authDir,
		});

		// Per-account abort controller derived from the gateway's parent abort.
		// `stopAccount` aborts this so in-flight turns + debounce flushes get
		// cancelled cleanly instead of running against a torn-down socket.
		const accountAbort = new AbortController();
		const parent = ctx.signal;
		if (parent) {
			if (parent.aborted) accountAbort.abort();
			else parent.addEventListener("abort", () => accountAbort.abort(), { once: true });
		}

		const pipelineRunTurn: RunChannelTurnFn = (turn) => deps.runTurn(turn);
		// Bundled channel commands (`/help`, `/status`, `/allowlist`,
		// `/agent`, `/agents`, `/whoami`). The legacy single-account
		// `startChannels` path already wires this map; without it on the
		// multi-account plugin path every slash command silently no-ops.
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of buildBundledCommands(adapter)) {
			commandMap.set(c.name.toLowerCase(), c);
		}
		const pipeline = createInboundPipelineContext({
			adapter,
			config: deps.loadConfig(),
			agentId: deps.defaultAgentId,
			runTurn: pipelineRunTurn,
			commandMap,
			parentAbort: accountAbort.signal,
		});

		const startCtx: ChannelStartContext = {
			signal: accountAbort.signal,
			log: (msg, meta) => log.info(`[${accountId}] ${msg}`, meta),
			onInbound: async (msg: InboundMessage) => {
				// Re-read the active config per inbound so policy edits land
				// without restarting the socket. Stamp the accountId so the
				// shared pipeline keys ACL + approval-route per account.
				pipeline.config = deps.loadConfig();
				const stamped: InboundMessage = msg.accountId ? msg : { ...msg, accountId };
				await runChannelInboundPipeline(pipeline, stamped);
			},
			onPairing: deps.onPairing
				? (info) => deps.onPairing?.(WHATSAPP_CHANNEL_ID, accountId, info)
				: undefined,
		};

		try {
			await adapter.start(startCtx);
			accountRuntimes.set(accountId, { adapter, pipeline, abort: accountAbort });
			// Per-account approval dispatcher — without this, an exec-gate
			// prompt raised from a turn that came in on (whatsapp, work) would
			// fall through to the channel default and reply on (whatsapp,
			// personal) or worst-case the WS-broadcast fallback.
			registerChannelApprovalDispatcher(WHATSAPP_CHANNEL_ID, accountId, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, {
						...(opts ?? {}),
						accountId,
					}),
				prettyName: "WhatsApp",
			});
			log.info("whatsapp account started", { accountId });
		} catch (err) {
			log.warn("whatsapp account failed to start", {
				accountId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};

	const stopAccount = async (
		ctx: ChannelGatewayContext<ResolvedWhatsAppAccount>,
	): Promise<void> => {
		const runtime = accountRuntimes.get(ctx.accountId);
		if (!runtime) return;
		accountRuntimes.delete(ctx.accountId);
		// Drop the per-account dispatcher BEFORE adapter.stop() so a late
		// in-flight bridge can't ask a torn-down socket to send.
		removeChannelApprovalDispatcher(WHATSAPP_CHANNEL_ID, ctx.accountId);
		try {
			runtime.abort.abort("stop-requested");
		} catch {
			/* best-effort */
		}
		// Clear any pending debounce slots on this account so a flush can't
		// fire after stop returns.
		for (const slot of runtime.pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
		runtime.pipeline.pendingDispatches.clear();
		try {
			await runtime.adapter.stop();
		} catch (err) {
			log.warn("whatsapp account stop threw", {
				accountId: ctx.accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const logoutAccount = async (
		ctx: ChannelLogoutContext<ResolvedWhatsAppAccount>,
	): Promise<ChannelLogoutResult> => {
		try {
			await stopAccount(ctx);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		id: WHATSAPP_CHANNEL_ID,
		meta: WHATSAPP_META,
		capabilities: {
			chatTypes: ["direct", "group"],
			reactions: true,
			reply: true,
			media: true,
		},
		startedAccountIds: () => [...accountRuntimes.keys()],
		getAdapter: (accountId: string) => accountRuntimes.get(accountId)?.adapter,
		config: {
			listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
			resolveAccount: (cfg, accountId) =>
				resolveWhatsAppAccount(cfg, accountId ?? undefined),
			defaultAccountId: () => WHATSAPP_DEFAULT_ACCOUNT_ID,
			isEnabled: (account) => account.enabled,
		},
		gateway: {
			startAccount,
			stopAccount,
			logoutAccount,
		},
		outbound: {
			sendText: async (params) => {
				const accountId = params.target.accountId || WHATSAPP_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime) {
					return { ok: false, error: `whatsapp account "${accountId}" is not running` };
				}
				try {
					await runtime.adapter.sendText(params.target.to, params.text, {
						accountId,
						...(params.target.threadId !== undefined
							? { threadId: params.target.threadId }
							: {}),
					});
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			sendMedia: async (params) => {
				const accountId = params.target.accountId || WHATSAPP_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.sendMedia) {
					return { ok: false, error: `whatsapp account "${accountId}" cannot send media right now` };
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
	};
}

/** Outbound dispatch helper for callers reaching the plugin directly. */
export type WhatsAppOutboundTarget = ChannelOutboundTarget;
