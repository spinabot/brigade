/**
 * WhatsApp config-shape helpers (multi-account aware).
 *
 * Brigade's WhatsApp config supports two shapes:
 *
 *   Legacy (single-account, back-compat):
 *     channels.whatsapp = { enabled: true, verbose?: boolean }
 *
 *   Multi-account (Wave F):
 *     channels.whatsapp = {
 *       enabled: true,
 *       accounts: [
 *         { id: "personal", enabled?: true },
 *         { id: "work",     enabled?: true, authDir?: "/custom/path" },
 *       ],
 *     }
 *
 * Helpers here normalise both shapes onto the multi-account surface the
 * `ChannelPlugin` contract consumes (`listAccountIds`, `resolveAccount`).
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 */

import path from "node:path";

import type { BrigadeConfig } from "../../../config/io.js";
import { resolveChannelStateDir } from "../../../config/paths.js";

const CHANNEL_ID = "whatsapp";
const DEFAULT_ACCOUNT_ID = "default";

/** Raw shape of `channels.whatsapp` in `brigade.json`. */
interface WhatsAppAccountEntry {
	id?: string;
	enabled?: boolean;
	authDir?: string;
	[key: string]: unknown;
}

interface WhatsAppChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	accounts?: WhatsAppAccountEntry[];
	[key: string]: unknown;
}

/** Resolved per-account info — what the plugin runtime hands to handlers. */
export interface ResolvedWhatsAppAccount {
	accountId: string;
	enabled: boolean;
	authDir: string;
	verbose: boolean;
}

/** Read `channels.whatsapp` loosely (schema keeps it open). */
function whatsappChannelConfig(cfg: BrigadeConfig): WhatsAppChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, WhatsAppChannelConfigSlot> }).channels?.[CHANNEL_ID];
}

/** Is the WhatsApp channel switched on at all (any shape)? */
export function whatsappChannelEnabled(cfg: BrigadeConfig): boolean {
	return whatsappChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listWhatsAppAccountIds(cfg: BrigadeConfig): string[] {
	const slot = whatsappChannelConfig(cfg);
	if (!slot || slot.enabled !== true) return [];
	const accounts = Array.isArray(slot.accounts) ? slot.accounts : undefined;
	if (!accounts || accounts.length === 0) return [DEFAULT_ACCOUNT_ID];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of accounts) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	// Empty / malformed `accounts:[]` still degrades to the default account so a
	// half-typed config doesn't silently disable WhatsApp.
	return ids.length === 0 ? [DEFAULT_ACCOUNT_ID] : ids;
}

/** Look up the raw account entry from config (or null when missing). */
function findAccountEntry(cfg: BrigadeConfig, accountId: string): WhatsAppAccountEntry | null {
	const slot = whatsappChannelConfig(cfg);
	if (!slot) return null;
	const accounts = Array.isArray(slot.accounts) ? slot.accounts : undefined;
	if (!accounts) return null;
	for (const entry of accounts) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (id === accountId) return entry;
	}
	return null;
}

/**
 * Resolve the on-disk auth directory for an account. Layout:
 *   ~/.brigade/channels/whatsapp/<accountId>/auth/
 *
 * Legacy `default` account preserves the historical path
 * (`~/.brigade/channels/whatsapp/auth/`) so existing single-account installs
 * keep their creds without a migration. The plugin path always uses the
 * per-account layout — `default` lives at the legacy path purely for
 * compatibility with the legacy single-adapter boot.
 */
export function resolveWhatsAppAccountAuthDir(accountId: string): string {
	const id = (accountId || "").trim();
	const base = resolveChannelStateDir(CHANNEL_ID);
	if (!id || id === DEFAULT_ACCOUNT_ID) {
		return path.join(base, "auth");
	}
	return path.join(base, id, "auth");
}

/** Resolve a per-account view of the config (defaults filled in). */
export function resolveWhatsAppAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
): ResolvedWhatsAppAccount {
	const slot = whatsappChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	const authDir =
		typeof entry?.authDir === "string" && entry.authDir.trim()
			? path.resolve(entry.authDir.trim())
			: resolveWhatsAppAccountAuthDir(id);
	return {
		accountId: id,
		enabled,
		authDir,
		verbose: slot?.verbose === true,
	};
}

export { CHANNEL_ID as WHATSAPP_CHANNEL_ID, DEFAULT_ACCOUNT_ID as WHATSAPP_DEFAULT_ACCOUNT_ID };
