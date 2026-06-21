/**
 * Telegram inline-keyboard rendering for native approval prompts.
 *
 * When a channel-routed turn raises an exec/plugin approval AND the Telegram
 * adapter has opted into `approvalCapability.sendApprovalPrompt`, the central
 * approval-router asks this channel to render the question as native inline
 * BUTTONS instead of the default "reply yes/no" text card. The button payloads
 * are produced by the CENTRAL codec (`buildApprovalCallbackButtons`) so the
 * press comes back as an `InboundMessage.callbackQuery` the central
 * `tryConsumeChannelApprovalCallback` decodes + resolves — this file only maps
 * the codec's `{ label, data }` specs onto Telegram's `InlineKeyboardMarkup`
 * shape and assembles the prompt text.
 *
 * Layout mirrors the reference Telegram extension: buttons are laid out in rows
 * of at most {@link TELEGRAM_INTERACTIVE_ROW_SIZE} (3). The standard approval has
 * three buttons (Allow once / Allow always / Deny) so they sit on one row.
 *
 * SAFETY: every `callback_data` value here is the codec's output — versioned,
 * base64url + printable-ASCII, already proven `<= 64` UTF-8 bytes by
 * `encodeApprovalCallback`. This module never mints its own payloads, so no NUL
 * / control byte can appear. `sanitizeTelegramCallbackData` is a defensive
 * belt-and-braces clamp for any externally-supplied value.
 */

import { buildApprovalCallbackButtons } from "../sdk.js";

/** Telegram's `callback_data` hard cap (UTF-8 bytes). Matches the codec ceiling. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** Max inline buttons per keyboard row (reference parity). */
export const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

/** C0/C1 control-character class (incl. NUL) as printable hex escapes — never a raw control byte in source. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** One Telegram inline button (the subset Brigade emits). */
export interface TelegramInlineButton {
	text: string;
	callback_data: string;
}

/** Telegram `InlineKeyboardMarkup` — rows of buttons. */
export interface TelegramInlineKeyboardMarkup {
	inline_keyboard: TelegramInlineButton[][];
}

/**
 * Clamp a callback-data string to Telegram's 64-byte budget and strip any
 * control bytes. The codec already guarantees both, so this is purely defensive
 * for a value that didn't come from the codec. Truncates on a UTF-8 boundary.
 */
export function sanitizeTelegramCallbackData(value: string): string {
	// Drop C0/C1 control chars (incl. NUL) — callback_data must be printable.
	// oxlint-disable-next-line no-control-regex
	const cleaned = value.replace(CONTROL_CHARS_RE, "");
	if (Buffer.byteLength(cleaned, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES) return cleaned;
	// Truncate to the byte budget without splitting a multi-byte sequence.
	const buf = Buffer.from(cleaned, "utf8").subarray(0, TELEGRAM_CALLBACK_DATA_MAX_BYTES);
	return new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/�+$/g, "");
}

/** Chunk a flat button list into rows of at most `rowSize`. */
function chunkIntoRows(buttons: TelegramInlineButton[], rowSize: number): TelegramInlineButton[][] {
	const rows: TelegramInlineButton[][] = [];
	for (let i = 0; i < buttons.length; i += rowSize) {
		rows.push(buttons.slice(i, i + rowSize));
	}
	return rows;
}

/**
 * Build the inline keyboard for an approval prompt from the central codec.
 * Returns `null` when fewer than two byte-safe buttons could be minted (a
 * pathologically long approval id) — the caller then falls back to the text
 * prompt rather than ship a half-rendered keyboard.
 *
 * `allowAlways: false` drops the "Allow always" button (approvals where
 * persisting an allowlist entry doesn't apply).
 */
export function buildTelegramApprovalKeyboard(args: {
	approvalId: string;
	allowAlways?: boolean;
}): TelegramInlineKeyboardMarkup | null {
	const specs = buildApprovalCallbackButtons({
		approvalId: args.approvalId,
		...(args.allowAlways === false ? { allowAlways: false } : {}),
	});
	if (specs.length < 2) return null; // not enough buttons → caller uses text prompt
	const buttons: TelegramInlineButton[] = specs.map((s) => ({
		text: s.label,
		callback_data: sanitizeTelegramCallbackData(s.data),
	}));
	return { inline_keyboard: chunkIntoRows(buttons, TELEGRAM_INTERACTIVE_ROW_SIZE) };
}

/**
 * Compose the operator-facing approval question text rendered ABOVE the inline
 * keyboard. Kept short + control-char-scrubbed; the buttons carry the action,
 * so the text only needs the command preview + a one-line ask. The 🦁 mark is
 * the Brigade brand-stamp so the operator recognises this as a Brigade prompt.
 */
export function buildTelegramApprovalText(args: {
	command: string;
	approvalKind: "exec" | "plugin";
	toolName?: string;
	agentId?: string;
}): string {
	const flat = args.command
		.replace(/[\r\n]+/g, " ")
		// oxlint-disable-next-line no-control-regex
		.replace(CONTROL_CHARS_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
	const preview = flat.length <= 180 ? flat : `${flat.slice(0, 177)}…`;
	const what = args.approvalKind === "plugin" ? "run a plugin action" : "run a shell command";
	const lines = [`🦁 Brigade wants to ${what}:`, `\`${preview}\``, "", "Choose below — times out in 5 minutes."];
	return lines.join("\n");
}
