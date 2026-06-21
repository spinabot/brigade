/**
 * Telegram `allowed_updates` resolver.
 *
 * Telegram's `getUpdates` / `setWebhook` take an `allowed_updates` allow-list:
 * only the named update kinds are delivered. Brigade subscribes the MINIMAL set
 * its central pipeline actually consumes — keeping the firehose narrow means a
 * chatty group never floods the poller with update kinds Brigade ignores
 * (business messages, channel posts, inline queries, shipping/checkout, …, all
 * of which the reference upstream subscribes but Brigade has no consumer for).
 *
 * The base set is always:
 *   - `message`        — the inbound text/media path (the core surface).
 *   - `callback_query` — inline-button presses (interactive approvals). Without
 *     this in the list, a button tap is silently never delivered and the
 *     approval prompt hangs for its full timeout. Subscribed unconditionally so
 *     a button rendered by `sendApprovalPrompt` is always answerable.
 *
 * Conditionally added:
 *   - `message_reaction` — only when the channel opts into reaction inbound
 *     handling (`opts.reactions`). Brigade does not route inbound reactions to a
 *     turn today, so it is OFF by default; the flag exists so a future reaction-
 *     trigger feature can switch it on without touching the poller wiring.
 *   - `edited_message`   — only when `opts.editedMessages` (off by default;
 *     Brigade treats an edit as a no-op rather than re-running the turn).
 *
 * Output is always a DEDUPED, STABLE-ORDER array of plain lowercase ASCII update
 * names (no NUL / control bytes — these are fixed string literals).
 */

/** One Telegram update kind Brigade may subscribe. */
export type TelegramAllowedUpdate =
	| "message"
	| "callback_query"
	| "message_reaction"
	| "edited_message";

/** Options gating the conditional update kinds. */
export interface ResolveTelegramAllowedUpdatesOptions {
	/** Subscribe `message_reaction` (inbound reaction events). Default false. */
	reactions?: boolean;
	/** Subscribe `edited_message` (inbound message edits). Default false. */
	editedMessages?: boolean;
}

/**
 * Resolve the `allowed_updates` list Brigade's Telegram poller/webhook should
 * request. `message` + `callback_query` are always present; reactions / edited
 * messages are added only when explicitly enabled. Deduped + stable order.
 */
export function resolveTelegramAllowedUpdates(
	opts: ResolveTelegramAllowedUpdatesOptions = {},
): TelegramAllowedUpdate[] {
	const out: TelegramAllowedUpdate[] = ["message", "callback_query"];
	if (opts.reactions) out.push("message_reaction");
	if (opts.editedMessages) out.push("edited_message");
	// De-dupe defensively (the base list is already unique, but a future caller
	// could pass overlapping flags) while preserving first-seen order.
	const seen = new Set<TelegramAllowedUpdate>();
	const deduped: TelegramAllowedUpdate[] = [];
	for (const u of out) {
		if (seen.has(u)) continue;
		seen.add(u);
		deduped.push(u);
	}
	return deduped;
}
