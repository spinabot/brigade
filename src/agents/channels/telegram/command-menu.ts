/**
 * Telegram native command menu — map Brigade's central channel commands onto
 * the `setMyCommands` shape that populates Telegram's `/` quick-menu.
 *
 * Brigade owns the command set centrally (`buildBundledCommands` → `/help`,
 * `/status`, `/allowlist`, `/agent`, `/agents`, `/whoami`, `/org`, plus any
 * module-registered channel commands). On connect the Telegram channel mirrors
 * that set into the bot's command menu so the operator sees the same commands
 * surfaced as native `/` suggestions in the Telegram client.
 *
 * Telegram's constraints (enforced here so a malformed command never makes
 * `setMyCommands` reject the WHOLE list):
 *   - command name: 1–32 chars, lowercase `[a-z0-9_]` only (leading `/` stripped).
 *   - description: 1–256 chars (clamped).
 *   - at most 100 commands.
 *
 * Pure / deterministic — no I/O. Output is always printable ASCII command names
 * (the regex strips everything else), so no NUL / control byte can appear.
 */

import type { ChannelCommand } from "../sdk.js";

/** Telegram bot-command entry. */
export interface TelegramBotCommand {
	command: string;
	description: string;
}

/** Telegram limits. */
const MAX_COMMANDS = 100;
const MAX_NAME_LEN = 32;
const MAX_DESC_LEN = 256;
const COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/;

/** Normalize a command word to Telegram's `[a-z0-9_]{1,32}` shape, or null if unusable. */
export function normalizeTelegramCommandName(raw: string): string | null {
	const stripped = raw.trim().replace(/^\/+/, "").toLowerCase();
	// Replace any disallowed char with nothing, then clamp length.
	const cleaned = stripped.replace(/[^a-z0-9_]/g, "").slice(0, MAX_NAME_LEN);
	if (!cleaned || !COMMAND_NAME_RE.test(cleaned)) return null;
	return cleaned;
}

/** Clamp + flatten a description to a single printable line within Telegram's cap. */
function normalizeDescription(desc: string | undefined, fallback: string): string {
	const raw = (desc ?? "").replace(/\s+/g, " ").trim() || fallback;
	return raw.length > MAX_DESC_LEN ? `${raw.slice(0, MAX_DESC_LEN - 1)}…` : raw;
}

/**
 * Build the Telegram command menu from Brigade's central channel commands.
 * De-dupes by normalized name (first wins), drops unusable names, and caps at
 * Telegram's 100-command ceiling. Returns `[]` when nothing maps (caller skips
 * the `setMyCommands` call entirely).
 */
export function buildTelegramCommandMenu(commands: ReadonlyArray<ChannelCommand>): TelegramBotCommand[] {
	const out: TelegramBotCommand[] = [];
	const seen = new Set<string>();
	for (const cmd of commands) {
		if (out.length >= MAX_COMMANDS) break;
		const name = normalizeTelegramCommandName(cmd.name);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push({ command: name, description: normalizeDescription(cmd.description, name) });
	}
	return out;
}
