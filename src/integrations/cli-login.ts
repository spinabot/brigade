/**
 * Reuse an already-logged-in CLI's stored credential.
 *
 * Brigade can adopt the token that a vendor's own CLI already minted on this
 * machine — so an operator who has logged into Claude Code or Codex can connect
 * Brigade with no browser flow and no API key. We read the CLI's on-disk
 * credential file directly (file-based only for v1) and hand it back in a normalized
 * shape the onboarding flow persists via the standard profile helpers.
 *
 * Everything here is DEFENSIVE: any missing file, parse failure, or malformed
 * shape returns `null`. We never throw — a failed read just means "no CLI login
 * present" and onboarding falls through to the key / fresh-login path.
 *
 * // TODO: macOS keychain (Claude Code-credentials / Codex Auth) — file-based only for v1.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** Normalized credential returned by a CLI-login reader. */
export type CliLogin =
	| { provider: string; type: "oauth"; access: string; refresh: string; expires?: number; accountId?: string }
	| { provider: string; type: "token"; token: string; expires?: number };

/**
 * Read Claude Code's stored login from `~/.claude/.credentials.json`.
 *
 * Shape: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`.
 * When a refresh token is present we return an `oauth` credential (Pi can
 * refresh it); otherwise a `token` credential carrying just the access token.
 * Returns `null` on any missing file / parse error / absent access token.
 */
export function readClaudeCliLogin(): CliLogin | null {
	try {
		const credPath = path.join(homedir(), ".claude", ".credentials.json");
		if (!fs.existsSync(credPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(credPath, "utf8")) as {
			claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number };
		};
		const oauth = parsed.claudeAiOauth;
		const access = oauth?.accessToken;
		if (!access) return null;
		const refresh = oauth?.refreshToken;
		const expires = oauth?.expiresAt;
		if (refresh) {
			return { provider: "anthropic", type: "oauth", access, refresh, expires };
		}
		return { provider: "anthropic", type: "token", token: access, expires };
	} catch {
		return null;
	}
}

/**
 * Read Codex's stored login from `${CODEX_HOME || ~/.codex}/auth.json`.
 *
 * Shape: `{ tokens: { access_token, refresh_token, account_id } }`. Codex
 * doesn't store an explicit expiry, so we decode the `exp` claim from the
 * access token JWT (×1000 → epoch-ms). If decoding fails we fall back to the
 * file's mtime + 1 hour — a conservative TTL that triggers a refresh sooner
 * rather than later. Returns `null` on any missing file / parse error / absent
 * access token.
 */
export function readCodexCliLogin(): CliLogin | null {
	try {
		const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
		const authPath = path.join(codexHome, "auth.json");
		if (!fs.existsSync(authPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
			tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
		};
		const tokens = parsed.tokens;
		const access = tokens?.access_token;
		const refresh = tokens?.refresh_token;
		if (!access || !refresh) return null;

		let expires = decodeJwtExp(access);
		if (expires === undefined) {
			try {
				expires = fs.statSync(authPath).mtimeMs + 3600_000;
			} catch {
				/* mtime unavailable — leave expires undefined */
			}
		}

		const accountId = tokens?.account_id;
		return {
			provider: "openai-codex",
			type: "oauth",
			access,
			refresh,
			expires,
			...(accountId ? { accountId } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Read the Gemini / Antigravity CLI's stored login from
 * `~/.gemini/oauth_creds.json` (the google-auth-library credential the
 * gemini-cli / antigravity-cli writes after `gemini`/`antigravity` login).
 *
 * Shape: `{ access_token, refresh_token, expiry_date }` where `expiry_date` is
 * ALREADY epoch-ms (google-auth-library convention). Returns an `oauth`
 * credential (Pi/Brigade can refresh it against Google). Returns `null` on any
 * missing file / parse error / absent token — e.g. an IDE-only Antigravity user
 * whose token lives in the OS keyring, which we can't read (they use the browser
 * login path instead). Never throws.
 */
export function readGeminiCliLogin(): CliLogin | null {
	try {
		const credPath = path.join(homedir(), ".gemini", "oauth_creds.json");
		if (!fs.existsSync(credPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(credPath, "utf8")) as {
			access_token?: string;
			refresh_token?: string;
			expiry_date?: number;
		};
		const access = parsed.access_token;
		const refresh = parsed.refresh_token;
		if (!access || !refresh) return null;
		const expires = typeof parsed.expiry_date === "number" ? parsed.expiry_date : undefined;
		return { provider: "antigravity", type: "oauth", access, refresh, expires };
	} catch {
		return null;
	}
}

/**
 * Decode the `exp` claim (seconds) of a JWT and return it as epoch-ms, or
 * `undefined` if the token isn't a parseable three-part JWT with a numeric
 * `exp`. Base64url-decodes the middle (payload) segment.
 */
function decodeJwtExp(jwt: string): number | undefined {
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3) return undefined;
		const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
		const payload = JSON.parse(payloadJson) as { exp?: number };
		if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
			return payload.exp * 1000;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
