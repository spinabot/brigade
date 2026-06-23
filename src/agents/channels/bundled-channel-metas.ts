/**
 * Built-in channel metas — the single source of truth for the bundled
 * channels' user-facing metadata (`ChannelMeta`).
 *
 * This module is DELIBERATELY import-light: it pulls in nothing but the
 * `ChannelMeta` type, so the channel-meta registry (and through it, the
 * system-prompt markdown gate + the exposure resolver) can read bundled
 * channel metadata WITHOUT eagerly loading the channel adapters (Baileys
 * sockets, the Telegram bot runtime). The plugins import THESE constants for
 * their `meta` field, so there is exactly one definition per channel.
 *
 * Canonical channel ids are inlined as literals here — they are stable
 * constants (`"whatsapp"`, `"telegram"`) and re-importing them from each
 * channel's `account-config` module would risk dragging adapter-adjacent code
 * into this light module. The plugin's own `WHATSAPP_CHANNEL_ID` /
 * `TELEGRAM_CHANNEL_ID` literals must stay in sync with the `id` fields below;
 * they are the same string by construction.
 */

import type { ChannelMeta } from "./types.core.js";

/** WhatsApp channel metadata (markdown-capable; visible everywhere by default). */
export const WHATSAPP_CHANNEL_META: ChannelMeta = {
	id: "whatsapp",
	label: "WhatsApp",
	selectionLabel: "WhatsApp",
	docsPath: "channels/whatsapp",
	blurb: "QR-pair a phone, DM/group chat over WhatsApp Web.",
	order: 10,
	markdownCapable: true,
};

/** Telegram channel metadata (markdown-capable; visible everywhere by default). */
export const TELEGRAM_CHANNEL_META: ChannelMeta = {
	id: "telegram",
	label: "Telegram",
	selectionLabel: "Telegram",
	docsPath: "channels/telegram",
	blurb: "Paste a @BotFather token, DM/group chat over a Telegram bot.",
	order: 20,
	markdownCapable: true,
};

/** Every bundled channel meta, in declaration order. The registry seeds from this. */
export const BUNDLED_CHANNEL_METAS: readonly ChannelMeta[] = [
	WHATSAPP_CHANNEL_META,
	TELEGRAM_CHANNEL_META,
];
