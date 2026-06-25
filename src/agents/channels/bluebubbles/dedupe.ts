/**
 * BlueBubbles inbound dedupe key.
 *
 * BlueBubbles has no inbound ack/sequence and its message poller can REPLAY a
 * lookback window of `new-message` events after a server restart, so the same
 * message GUID can arrive twice. The connection layer claims each inbound through
 * the shared `createDedupeCache` (claim-once, LRU + TTL); this module just
 * computes the dedupe KEY.
 *
 * The key is the message GUID, namespaced per account. An `updated-message`
 * (attachment-indexing follow-up) gets a distinct `:updated` suffix so the text
 * pass and the attachment follow-up aren't collapsed into one (the follow-up
 * must be allowed through to attach the now-indexed media).
 */

import { normalizeBlueBubblesWebhook } from "./normalize.js";

/** The default dedupe cache TTL — generous (BlueBubbles replays up to ~1 week). */
export const BLUEBUBBLES_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The default dedupe cache size cap. */
export const BLUEBUBBLES_DEDUPE_MAX_ENTRIES = 5000;

/**
 * Resolve the dedupe key for a webhook payload (or undefined when the payload has
 * no usable message GUID — those are handled by the normalize skip path anyway).
 * `accountId` namespaces the key so two accounts never collide.
 */
export function resolveBlueBubblesDedupeKey(accountId: string, payload: unknown, eventType?: string): string | undefined {
	const result = normalizeBlueBubblesWebhook(payload, eventType);
	if (result.kind !== "message") return undefined;
	const guid = result.message.messageGuid.trim();
	if (!guid) return undefined;
	const base = `${accountId}:${guid}`;
	return eventType === "updated-message" ? `${base}:updated` : base;
}
