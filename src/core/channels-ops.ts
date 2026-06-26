/**
 * Channel runtime + DM-allow control behind the `channels.*` gateway RPCs —
 * reachable from a remote client.
 *
 * Channel *config* (enable/disable, group policy) is already config.set-
 * reachable. These close the genuine gaps: LIVE connect/disconnect (a runtime
 * adapter op, not config) and the DM allow-from store (a per-channel file, not
 * brigade.json). Operator-scoped (no per-session guard — allowlisted).
 *
 * connect/disconnect reuse the owner-scoped `connect_channel` tool (its execute
 * is ctx-free; the manager comes from the global `getActiveChannelManager()`).
 * allow-add/remove/list call the access-control store directly.
 */

import { addAllowFrom, readAllowFrom, removeAllowFrom } from "../agents/channels/access-control/store.js";
import { makeConnectChannelTool } from "../agents/tools/connect-channel-tool.js";

async function runConnectChannel(args: Record<string, unknown>): Promise<unknown> {
	const tool = makeConnectChannelTool({ senderIsOwner: true });
	const res = await tool.execute("gateway", args as never);
	return res.details;
}

export async function handleChannelsConnect(params: unknown): Promise<unknown> {
	return runConnectChannel({ ...((params ?? {}) as Record<string, unknown>), action: "connect" });
}
export async function handleChannelsDisconnect(params: unknown): Promise<unknown> {
	return runConnectChannel({ ...((params ?? {}) as Record<string, unknown>), action: "disconnect" });
}

export interface ChannelsAllowResult {
	ok: boolean;
	channel: string;
	senderId: string;
	changed: boolean;
	reason?: string;
}
export function handleChannelsAllowAdd(params: unknown): ChannelsAllowResult {
	const p = (params ?? {}) as { channel?: string; senderId?: string; accountId?: string };
	const channel = (p.channel ?? "").trim();
	const senderId = (p.senderId ?? "").trim();
	if (!channel || !senderId) return { ok: false, channel, senderId, changed: false, reason: "missing 'channel' or 'senderId'" };
	const added = addAllowFrom(channel, senderId, p.accountId ?? null);
	return { ok: true, channel, senderId, changed: added };
}
export function handleChannelsAllowRemove(params: unknown): ChannelsAllowResult {
	const p = (params ?? {}) as { channel?: string; senderId?: string; accountId?: string };
	const channel = (p.channel ?? "").trim();
	const senderId = (p.senderId ?? "").trim();
	if (!channel || !senderId) return { ok: false, channel, senderId, changed: false, reason: "missing 'channel' or 'senderId'" };
	const removed = removeAllowFrom(channel, senderId, p.accountId ?? null);
	return { ok: removed, channel, senderId, changed: removed, ...(removed ? {} : { reason: "sender not on the allow-from list" }) };
}

export interface ChannelsAllowListResult {
	channel: string;
	senders: string[];
}
export function handleChannelsAllowList(params: unknown): ChannelsAllowListResult {
	const p = (params ?? {}) as { channel?: string; accountId?: string };
	const channel = (p.channel ?? "").trim();
	if (!channel) throw new Error("channels.allow-list: missing 'channel'");
	return { channel, senders: readAllowFrom(channel, p.accountId ?? null) };
}
