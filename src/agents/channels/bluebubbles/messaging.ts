/**
 * BlueBubbles outbound-addressing adapter (the `ChannelPlugin.messaging` slot).
 *
 * Turns the loose `to` the agent hands `send_message` ("+1 555 123 4567",
 * "bluebubbles:user@example.com", "chat_guid:…") into a concrete target the
 * runtime `sendText` understands. BlueBubbles shares iMessage's target grammar,
 * so this reuses the iMessage target primitives (chat_guid / chat_id / handle)
 * and only swaps the channel-name prefix to `bluebubbles:`.
 */

import type { ChannelMessagingAdapter, ParsedExplicitTarget } from "../sdk.js";
import {
	inferIMessageTargetChatType,
	looksLikeIMessageTargetId,
	normalizeIMessageHandle,
} from "../imessage/targets.js";

/** The BlueBubbles messaging adapter. */
export const bluebubblesMessagingAdapter: ChannelMessagingAdapter = {
	parseExplicitTarget(text: string): ParsedExplicitTarget | null {
		const trimmed = (text ?? "").trim();
		if (!trimmed) return null;
		// An explicit `bluebubbles:<handle>` form names the channel.
		const m = /^bluebubbles:(.+)$/i.exec(trimmed);
		if (m && m[1]) return { channelId: "bluebubbles", target: m[1].trim() };
		// A concrete chat/service/handle id (vs a bare name) is an explicit target.
		if (looksLikeIMessageTargetId(trimmed)) return { target: trimmed };
		return null;
	},
	normalizeTarget(raw: string): string {
		const trimmed = (raw ?? "").trim();
		if (!trimmed) return trimmed;
		return normalizeIMessageHandle(trimmed);
	},
	inferTargetChatType(target: string): "dm" | "group" | undefined {
		return inferIMessageTargetChatType(target);
	},
};
