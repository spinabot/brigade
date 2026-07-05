// Brigade-managed Claude Code config directory.
//
// The claude-cli backend spawns the `claude` binary, which authenticates from a
// config dir (default `~/.claude`). Rather than depend on — and risk racing —
// the operator's PERSONAL Claude Code login, Brigade can mint its OWN Claude
// subscription grant (via the browser OAuth it already drives) and store it in a
// DEDICATED config dir under `~/.brigade`. The backend then spawns `claude` with
// `CLAUDE_CONFIG_DIR` pointed there, so:
//   • the binary authenticates from Brigade's own credential,
//   • the binary refreshes that credential autonomously in-place (no Brigade
//     refresh logic, no rotated-token split-brain with the user's `~/.claude`),
//   • the operator never touches a terminal or pastes a token.
//
// A Brigade-written `.credentials.json` in this dir IS accepted by the binary —
// verified live: `CLAUDE_CONFIG_DIR=<dir> claude -p` authenticates from it.
//
// Precedence at spawn time (see catalog.buildClaudeCliEnv): if this managed dir
// holds a credential, use it; otherwise fall back to the binary's default
// (`~/.claude`) so an operator who already ran `claude` keeps working unchanged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

/** The dedicated config dir: `<stateDir>/claude-config`. Overridable for tests. */
export function resolveBrigadeClaudeConfigDir(): string {
	const override = process.env.BRIGADE_CLAUDE_CONFIG_DIR?.trim();
	if (override) return override;
	return path.join(resolveStateDir(), "claude-config");
}

function credentialPath(): string {
	return path.join(resolveBrigadeClaudeConfigDir(), ".credentials.json");
}

/** The Claude Code on-disk credential shape (`~/.claude/.credentials.json`). */
export interface ClaudeCodeCredentialFile {
	claudeAiOauth: {
		accessToken: string;
		refreshToken: string;
		/** Absolute epoch-ms. */
		expiresAt: number;
		scopes?: string[];
		subscriptionType?: string;
	};
}

/** The scopes pi-ai's Anthropic OAuth requests — the Claude Code set. Written to
 *  the credential so the binary's own scope checks are satisfied. */
export const CLAUDE_CODE_OAUTH_SCOPES = [
	"user:inference",
	"user:profile",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
];

/**
 * Persist an OAuth credential (minted by Brigade's browser login) into the
 * Brigade-managed Claude config dir, in Claude Code's own on-disk shape. Atomic
 * (tmp + rename) and mode 0600 on POSIX. The binary reads + refreshes it from
 * here on. Returns the dir written to.
 */
export function writeBrigadeClaudeCredential(cred: {
	access: string;
	refresh: string;
	/** Absolute epoch-ms. Coerced to a near-future default when absent so the
	 *  binary refreshes promptly rather than treating it as non-expiring. */
	expires?: number;
	scopes?: string[];
	subscriptionType?: string;
}): string {
	const dir = resolveBrigadeClaudeConfigDir();
	fs.mkdirSync(dir, { recursive: true });
	const file: ClaudeCodeCredentialFile = {
		claudeAiOauth: {
			accessToken: cred.access,
			refreshToken: cred.refresh,
			expiresAt:
				typeof cred.expires === "number" && Number.isFinite(cred.expires)
					? cred.expires
					: Date.now() + 60 * 60 * 1000,
			scopes: cred.scopes ?? CLAUDE_CODE_OAUTH_SCOPES,
			...(cred.subscriptionType ? { subscriptionType: cred.subscriptionType } : {}),
		},
	};
	const target = credentialPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
	if (os.platform() !== "win32") {
		try {
			fs.chmodSync(tmp, 0o600);
		} catch {
			/* fs may not support chmod */
		}
	}
	fs.renameSync(tmp, target);
	return dir;
}

/** Whether Brigade holds its own Claude login in the managed dir. */
export function hasBrigadeClaudeLogin(): boolean {
	try {
		const raw = fs.readFileSync(credentialPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<ClaudeCodeCredentialFile>;
		return typeof parsed?.claudeAiOauth?.accessToken === "string" && parsed.claudeAiOauth.accessToken.length > 0;
	} catch {
		return false;
	}
}

/** Read the managed credential (for doctor / status), or null. Never throws. */
export function readBrigadeClaudeCredential(): ClaudeCodeCredentialFile["claudeAiOauth"] | null {
	try {
		const raw = fs.readFileSync(credentialPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<ClaudeCodeCredentialFile>;
		const oauth = parsed?.claudeAiOauth;
		if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken.length > 0) return oauth;
		return null;
	} catch {
		return null;
	}
}

/** Remove the managed login (for a `logout` / re-auth flow). Best-effort. */
export function clearBrigadeClaudeLogin(): void {
	try {
		fs.rmSync(credentialPath(), { force: true });
	} catch {
		/* nothing to remove */
	}
}
