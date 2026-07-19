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

import { peekConvexMode, resolveOsConfigDir, resolveStateDir } from "../../config/paths.js";

/**
 * The dedicated Claude config dir. Filesystem mode: `<stateDir>/claude-config`.
 *
 * Convex mode: NOTHING may live under `~/.brigade` (the strict-zero invariant
 * that keeps `rm -rf ~/.brigade` safe and lets convex be authoritative), so it
 * resolves to the OS config dir instead. The `claude` CLI's login credential,
 * sessions, and projects are machine-local by nature (the binary reads
 * CLAUDE_CONFIG_DIR from disk — they can't live in convex), and leaving them
 * under the state dir made every `fs.watch` on them trip the strict guard with
 * "STRICT-ZERO VIOLATION" spam. The OS config dir (durable, NOT the reapable
 * cache) survives a state wipe and keeps the login. Overridable via
 * BRIGADE_CLAUDE_CONFIG_DIR (tests / exotic setups).
 */
export function resolveBrigadeClaudeConfigDir(): string {
	const override = process.env.BRIGADE_CLAUDE_CONFIG_DIR?.trim();
	if (override) return override;
	if (peekConvexMode()) {
		const dest = path.join(resolveOsConfigDir(), "claude-config");
		migrateLegacyClaudeConfigOnce(dest);
		return dest;
	}
	return path.join(resolveStateDir(), "claude-config");
}

// One-time relocation guard: convex mode moved this dir OUT of <stateDir> (see
// above). Carry an existing login ACROSS so a returning operator who updates does
// NOT silently have to re-login — the production cost of a bare relocation.
// Idempotent + best-effort; copy+remove (not rename) so it survives a cross-
// volume ~/.brigade-vs-OS-config split (rename would EXDEV). Removing the legacy
// dir fires only "delete" watcher events, which the strict guard does not flag.
let _claudeConfigMigrated = false;
function migrateLegacyClaudeConfigOnce(dest: string): void {
	if (_claudeConfigMigrated) return;
	_claudeConfigMigrated = true;
	try {
		const legacy = path.join(resolveStateDir(), "claude-config");
		if (path.resolve(legacy) === path.resolve(dest)) return; // same dir — nothing to do
		if (fs.existsSync(dest) || !fs.existsSync(legacy)) return; // already moved / nothing to move
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.cpSync(legacy, dest, { recursive: true });
		fs.rmSync(legacy, { recursive: true, force: true });
	} catch {
		// Perms / partial copy — leave the legacy dir in place; worst case the
		// binary re-logins once. Never let a migration hiccup break resolution.
	}
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
