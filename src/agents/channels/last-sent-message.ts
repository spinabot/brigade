/**
 * Per-agent last-sent-message registry.
 *
 * The additive `{ messageId }` return on `ChannelAdapter.sendText` / `sendMedia`
 * lets the pipeline learn the native id of the message the agent just sent. This
 * registry remembers that id per (agent, channel, conversation) so the agent can
 * say "edit my last message" / "delete that" without having to have memorised an
 * id — the `message_action` tool falls back to this record when no explicit
 * `messageId` is supplied.
 *
 * Mirrors `last-channel.ts` exactly in scope + persistence: an in-memory map
 * pinned via global-singleton (one record set across hot-reload / dual-build),
 * updated whenever a reply send returns an id, read by `message_action`. NOT
 * persisted across a gateway restart — the agent can always re-send and act on
 * the fresh id; there is no correctness risk in losing the pin on reboot.
 */

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/** The most recent outbound message the agent sent on one conversation. */
export interface LastSentMessageRecord {
	messageId: string;
	threadId?: string;
	accountId?: string;
	updatedAtMs: number;
}

/** Pinned via global-singleton so hot-reload / dual-build share one record map. */
const LAST_SENT_MESSAGE_KEY = Symbol.for("brigade.lastSentMessage.byKey");
const lastSentByKey = resolveGlobalSingleton<Map<string, LastSentMessageRecord>>(
	LAST_SENT_MESSAGE_KEY,
	() => new Map<string, LastSentMessageRecord>(),
);

/** Key by (agent, channel, conversation) so each chat tracks its own last id. */
function recordKey(agentId: string, channelId: string, conversationId: string): string {
	return `${agentId}::${channelId}::${conversationId}`;
}

/**
 * Record the id of the message the agent just sent on this conversation. A
 * no-op when any of the keys (or the id itself) is empty — channels that don't
 * return an id simply never populate the registry.
 */
export function recordLastSentMessage(args: {
	agentId: string;
	channelId: string;
	conversationId: string;
	messageId: string | undefined;
	threadId?: string;
	accountId?: string;
	nowMs?: number;
}): void {
	if (!args.agentId || !args.channelId || !args.conversationId) return;
	const id = (args.messageId ?? "").trim();
	if (!id) return;
	lastSentByKey.set(recordKey(args.agentId, args.channelId, args.conversationId), {
		messageId: id,
		...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
		...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
		updatedAtMs: args.nowMs ?? Date.now(),
	});
}

/**
 * Look up the agent's most-recently-sent message id on a conversation, or
 * `undefined` if none has been recorded (fresh boot, a channel that doesn't
 * return ids, or no sends yet).
 */
export function getLastSentMessage(
	agentId: string,
	channelId: string,
	conversationId: string,
): LastSentMessageRecord | undefined {
	return lastSentByKey.get(recordKey(agentId, channelId, conversationId));
}

/** Test-only — clear every recorded last-sent message. */
export function resetLastSentMessageRegistryForTests(): void {
	lastSentByKey.clear();
}
