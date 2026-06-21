/**
 * Durable channel-token seal — survives a gateway reboot.
 *
 * `connect_channel` used to put a freshly-supplied channel token ONLY into
 * `process.env[VAR]` (with a `${VAR}` ref on disk). That works for the live
 * process but evaporates on restart: the env var is gone, so the `${VAR}` ref
 * resolves to empty and the channel silently can't authenticate. This module
 * gives the token a DURABLE home by reusing Brigade's existing encrypted
 * credential store (the auth-profiles store — atomic 0600 JSON on disk in
 * filesystem mode; AES-256-GCM sealed columns via `storage/encryption.ts` in
 * convex mode). Same store WhatsApp's Baileys creds and the Composio/OAuth keys
 * use; nothing new on disk, and the secret is never persisted in plaintext in
 * convex mode.
 *
 * A channel token is an OPERATOR secret, not an agent credential, so it is
 * stored under a single fixed "home" agent ({@link CHANNEL_SECRET_HOME_AGENT})
 * and a `channel:<id>` provider key — and read back from there at channel-start
 * time WITHOUT needing an agent context. The on-disk profile is a `token`-type
 * `AuthProfile`, so it rides the same seal/restore path as every other
 * credential.
 */

import { readProfiles, upsertTokenProfile } from "../../auth/profiles.js";

/**
 * The agent whose credential store durably holds channel tokens. `main` is the
 * operator's primary agent and always exists; channel tokens are operator-wide,
 * so a single home keeps them resolvable at channel start without threading an
 * agent id through the start path.
 */
export const CHANNEL_SECRET_HOME_AGENT = "main";

/** Provider key under which a channel's token is sealed (`channel:telegram`, …). */
export function channelSecretProvider(channelId: string): string {
	return `channel:${channelId.trim().toLowerCase()}`;
}

/**
 * Durably seal a channel's token into the encrypted credential store. Returns
 * the profile id. Survives a gateway reboot; in convex mode the token is sealed
 * (AES-256-GCM) before it leaves the process.
 */
export function sealChannelToken(channelId: string, token: string): string {
	return upsertTokenProfile(CHANNEL_SECRET_HOME_AGENT, {
		provider: channelSecretProvider(channelId),
		token,
	});
}

/**
 * Read a channel's durably-sealed token, or "" when none is stored. Safe to
 * call at channel-start time (no agent context needed) — reads the fixed
 * home-agent profile store and decrypts on read. Returns "" rather than throwing
 * when the store is absent / empty, so callers can fall through to other token
 * sources cleanly.
 */
export function readSealedChannelToken(channelId: string): string {
	try {
		const profiles = readProfiles(CHANNEL_SECRET_HOME_AGENT).profiles;
		const provider = channelSecretProvider(channelId);
		for (const profile of Object.values(profiles)) {
			if (profile.provider !== provider) continue;
			const token = (profile.token ?? "").trim();
			if (token) return token;
		}
	} catch {
		/* no store / unreadable → fall through to other token sources */
	}
	return "";
}
