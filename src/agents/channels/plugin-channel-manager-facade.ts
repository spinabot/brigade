/**
 * Thin `ChannelManager` facade over the plugin path — so the
 * `send_message` agent tool's `getActiveChannelManager().adapter(id)`
 * lookup returns a working dispatch handle when the gateway is running
 * the multi-account plugin manager instead of the legacy `startChannels`.
 *
 * `adapter(id, accountId?)` resolves a specific account's adapter when
 * `accountId` is supplied; otherwise returns the first started account
 * (back-compat for callers that don't yet pass accountId). Single-account
 * installs return their one account either way.
 */

import type { ChannelAdapter } from "../extensions/types.js";
import type { ChannelManager, StartChannelResult, StopChannelResult } from "./manager.js";

/**
 * The minimal per-account introspection surface the facade needs from a plugin
 * handle — `id` + which accounts are running + a per-account adapter lookup.
 * Both `WhatsAppPluginHandle` and `TelegramPluginHandle` satisfy this, so the
 * facade is channel-agnostic and one facade can front a mixed plugin list.
 */
export interface PluginChannelManagerHandle {
	id: string;
	startedAccountIds(): string[];
	getAdapter(accountId: string): ChannelAdapter | undefined;
}

/** Build a manager facade over a list of plugin handles. */
export function createPluginChannelManagerFacade(args: {
	plugins: PluginChannelManagerHandle[];
}): ChannelManager {
	const started = (): string[] => {
		const ids: string[] = [];
		for (const p of args.plugins) {
			if (p.startedAccountIds().length > 0) ids.push(p.id);
		}
		return ids;
	};
	return {
		get started() {
			return started();
		},
		adapter(id: string, accountId?: string): ChannelAdapter | undefined {
			for (const p of args.plugins) {
				if (p.id !== id) continue;
				const accounts = p.startedAccountIds();
				if (accountId !== undefined) {
					const normalized = accountId.trim();
					if (normalized.length === 0) return undefined;
					if (!accounts.includes(normalized)) return undefined;
					return p.getAdapter(normalized);
				}
				const first = accounts[0];
				if (!first) return undefined;
				return p.getAdapter(first);
			}
			return undefined;
		},
		async stop(): Promise<void> {
			// Stop is owned by the `ChannelPluginManager` directly; the facade
			// is a read-only surface for the `send_message` tool.
		},
		async startChannel(id: string): Promise<StartChannelResult> {
			// The multi-account plugin path owns its own lifecycle through the
			// `ChannelPluginManager` (per-account loops + restart-backoff), so a
			// live single-channel start does NOT route through this read-only
			// facade. Report it honestly so `connect_channel` falls back to
			// "config written — restart the gateway to connect".
			return {
				ok: false,
				started: false,
				reason: "start-failed",
				message: `live start for "${id}" is managed by the multi-account channel plugin manager — restart the gateway to apply config changes`,
			};
		},
		async stopChannel(id: string): Promise<StopChannelResult> {
			// Same ownership note as startChannel — the plugin manager owns stop.
			return {
				ok: true,
				stopped: false,
				message: `live stop for "${id}" is managed by the multi-account channel plugin manager`,
			};
		},
	};
}
