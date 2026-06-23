/**
 * Per-channel markdown gate — "should the agent emit raw markdown to this
 * channel, or plain text?"
 *
 * Brand-scrubbed analogue of upstream's `isMarkdownCapableMessageChannel`
 * (`src/utils/message-channel.ts`), with ONE deliberate Brigade difference in
 * the default direction (see below).
 *
 * The verdict reads a channel's declared `meta.markdownCapable` (via the
 * channel-meta registry). A channel that renders markdown natively (Telegram,
 * WhatsApp Web) declares `markdownCapable: true`; a channel that would show the
 * literal `**bold**` / backticks to the user (an SMS gateway, a plain-text
 * webhook) declares `markdownCapable: false`, and Brigade then withholds the
 * raw-markdown formatting it would otherwise inject.
 *
 * ┌─ CRITICAL: DEFAULT IS MARKDOWN-ON ────────────────────────────────────────┐
 * │ Unlike upstream (which defaults a NON-matched channel to plain), Brigade   │
 * │ defaults to markdown ON whenever the channel is unknown or carries no      │
 * │ meta. Brigade has always injected raw markdown unconditionally, so the     │
 * │ gate must preserve that for every existing surface (cli/tui, the internal  │
 * │ webchat, any channel that hasn't declared the flag). Only an EXPLICIT      │
 * │ `markdownCapable: false` flips a channel to plain. This guarantees the     │
 * │ gate is additive — it can only ever turn markdown OFF for a channel that   │
 * │ opted out, never silently strip it from a channel that relied on it.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { getRegisteredChannelPluginMeta } from "./channel-meta-registry.js";

/**
 * Operator-facing surfaces that ALWAYS render markdown regardless of channel
 * metadata: the local CLI, the TUI, and the internal/programmatic channel the
 * gateway uses for non-delivered turns. Lowercased for case-insensitive match.
 */
const ALWAYS_MARKDOWN_SURFACES = new Set<string>(["cli", "tui", "internal"]);

/**
 * True iff a channel (by id) should receive RAW MARKDOWN.
 *
 * Returns `false` ONLY when the channel has a registered meta whose
 * `markdownCapable` is explicitly `false`. Every other case — unknown channel,
 * meta present without the flag, or `markdownCapable: true` — returns `true`,
 * preserving Brigade's historical markdown-on default (see the file header).
 */
export function isMarkdownCapableChannel(channelId: string | null | undefined): boolean {
	const meta = getRegisteredChannelPluginMeta(channelId);
	// Unknown channel / no registered meta → keep the historical markdown-on
	// behavior. Only an explicit opt-out (`markdownCapable: false`) flips to plain.
	if (!meta) return true;
	return meta.markdownCapable !== false;
}

/**
 * True iff the agent should format a reply destined for `channel` as markdown.
 * Wraps {@link isMarkdownCapableChannel} but first short-circuits the
 * operator-facing surfaces (cli/tui/internal) to markdown-capable, mirroring
 * upstream's message-channel helper. Empty / null input → markdown-on (the
 * historical default for an unspecified surface).
 */
export function isMarkdownCapableMessageChannel(channel: string | null | undefined): boolean {
	const normalized = normalizeOptionalLowercaseString(channel);
	if (!normalized) return true;
	if (ALWAYS_MARKDOWN_SURFACES.has(normalized)) return true;
	return isMarkdownCapableChannel(normalized);
}
