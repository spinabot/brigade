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
import type { ChannelManager } from "./manager.js";
import type { WhatsAppPluginHandle } from "./whatsapp/plugin.js";

/** Build a manager facade over a list of plugin handles. */
export function createPluginChannelManagerFacade(args: {
	plugins: WhatsAppPluginHandle[];
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
	};
}
