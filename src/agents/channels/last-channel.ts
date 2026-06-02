/**
 * Per-agent last-used channel registry.
 *
 * When a cron's `delivery.mode === "announce"` is created from a turn
 * that DID NOT have an explicit channel target (typical TUI / connect-mode
 * scheduling), the channel auto-fill in cron-tool.ts skips — leaving the
 * job with `{mode: "announce"}` and no `channel`/`to`. At fire time, the
 * timer's `maybeDeliverAnnounce` then has no obvious target.
 *
 * OC handles this by remembering the operator's most recently active
 * channel: every channel inbound updates a per-session `lastChannel` field
 * in session metadata. When a cron fires without an explicit channel, the
 * delivery resolver reads `lastChannel` and announces there — so a
 * reminder scheduled from TUI but most-recently-active on WhatsApp lands
 * back in WhatsApp.
 *
 * Brigade mirrors that pattern here. The registry is intentionally simple:
 *
 *   - In-memory map keyed by agentId.
 *   - Records `{channelId, conversationId, threadId?, updatedAtMs}`.
 *   - Updated by every channel-routed inbound that reaches dispatch.
 *   - Read by cron's announce delivery as a last-resort target when
 *     `delivery.channel`/`to` are unset.
 *
 * Persistence is in-memory only — same scope as `pending-system-events`.
 * On gateway restart the registry empties; the first channel inbound
 * after restart populates it. This is fine because the operator's
 * channels reconnect on boot anyway, and the FIRST DM through any of
 * them re-establishes the last-channel pin before the cron service has
 * had time to fire anything that would need it.
 */

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { ChannelApprovalRoute } from "./approval-router.js";

/** One operator's most recently active channel + peer + thread. */
export interface LastChannelRecord {
	channelId: string;
	conversationId: string;
	threadId?: string;
	accountId?: string;
	updatedAtMs: number;
}

/** Pinned via global-singleton so hot-reload / dual-build keep one per-agent record map. */
const LAST_CHANNEL_BY_AGENT_KEY = Symbol.for("brigade.lastChannel.byAgent");
const lastChannelByAgent = resolveGlobalSingleton<Map<string, LastChannelRecord>>(
	LAST_CHANNEL_BY_AGENT_KEY,
	() => new Map<string, LastChannelRecord>(),
);

/**
 * Record this turn's channel as the agent's most recent. Called from the
 * channel manager's dispatch path on every inbound that passes the access
 * gate (so a stranger DM doesn't accidentally pin the agent's last-channel
 * to a peer the operator hasn't approved).
 */
export function recordLastChannelForAgent(
	agentId: string,
	route: ChannelApprovalRoute,
	nowMs: number = Date.now(),
): void {
	if (!agentId || !route.channelId || !route.conversationId) return;
	lastChannelByAgent.set(agentId, {
		channelId: route.channelId,
		conversationId: route.conversationId,
		...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
		...(route.accountId !== undefined ? { accountId: route.accountId } : {}),
		updatedAtMs: nowMs,
	});
}

/**
 * Look up the agent's last-recorded channel. Returns `undefined` if the
 * agent has had no channel activity since the gateway started (e.g. a
 * fresh boot with no inbound traffic yet, or a pure-TUI session).
 */
export function getLastChannelForAgent(agentId: string): LastChannelRecord | undefined {
	return lastChannelByAgent.get(agentId);
}

/** Test-only — clear every agent's last-channel record. */
export function resetLastChannelRegistryForTests(): void {
	lastChannelByAgent.clear();
}
