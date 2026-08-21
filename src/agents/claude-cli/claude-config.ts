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

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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

/**
 * macOS keeps the `claude` binary's OAuth credential in the LOGIN KEYCHAIN, not
 * in `<configDir>/.credentials.json` — under a service name derived from the
 * config dir: `Claude Code-credentials-<sha256(dir).slice(0,8)>` (the
 * un-suffixed `Claude Code-credentials` belongs to the default `~/.claude`).
 *
 * The keychain entry WINS over the file. A tombstoned entry — one the binary
 * emptied after a failed refresh (`accessToken: ""`, `expiresAt: 0`) — makes
 * every turn fail with "OAuth session expired and could not be refreshed" while
 * a perfectly good Brigade-written `.credentials.json` sits unread beside it.
 * Worse, it is UNRECOVERABLE by re-login: `brigade login claude-cli` rewrites
 * the file the binary never reads.
 *
 * Brigade deliberately does NOT write the keychain — that shape is the vendor's
 * to own, and guessing it is how you get a second split-brain. Instead we DELETE
 * the shadow when minting a fresh credential, so the binary bootstraps from our
 * file and repopulates the keychain itself.
 */
function claudeKeychainService(dir: string): string {
	const digest = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8);
	// ALWAYS suffixed. The operator's personal login lives under the UN-suffixed
	// `Claude Code-credentials` (the default `~/.claude`), so a derived name can
	// never name it — this is the invariant that makes deleting safe at all.
	return `Claude Code-credentials-${digest}`;
}

/** The operator's personal Claude Code login. We must never touch this. */
const CLAUDE_DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * `security` can block on a LOCKED keychain (it raises a GUI unlock prompt). A
 * headless gateway would hang there forever, so every call is bounded — a
 * timeout degrades to "leave it alone", which is always the safe direction.
 */
const KEYCHAIN_CMD_TIMEOUT_MS = 5_000;

/** Delete the keychain shadow for `dir`. Returns true only if one was removed. */
export function clearClaudeKeychainShadow(dir: string = resolveBrigadeClaudeConfigDir()): boolean {
	if (os.platform() !== "darwin") return false;
	const service = claudeKeychainService(dir);
	// Belt-and-braces: refuse to delete the operator's personal login even if the
	// derivation above is ever changed to something that could collide with it.
	if (service === CLAUDE_DEFAULT_KEYCHAIN_SERVICE) return false;
	try {
		execFileSync("security", ["delete-generic-password", "-s", service], {
			stdio: "ignore",
			timeout: KEYCHAIN_CMD_TIMEOUT_MS,
		});
		return true;
	} catch {
		return false; // no entry — the common case, not an error
	}
}

/**
 * Clear the keychain shadow ONLY when it is unusable (missing/empty access
 * token). A healthy shadow is left alone: the binary owns it and rotates it
 * in place. Returns what happened, for the caller to report.
 */
export type ClaudeKeychainShadowState =
	/** Not macOS — the binary reads the file, so no shadow can exist. */
	| "unsupported"
	/** No keychain entry for this config dir; our file is authoritative. */
	| "none"
	/** A real credential the binary owns and rotates. Leave it alone. */
	| "healthy"
	/** Emptied by a failed refresh — outranks, and silently masks, our file. */
	| "tombstoned";

/**
 * READ-ONLY view of the keychain shadow. Never mutates, so diagnostics
 * (`brigade doctor`) can report the condition without repairing it behind the
 * operator's back — a doctor that silently changes state is a doctor you
 * cannot use to reproduce a bug.
 */
export function inspectClaudeKeychainShadow(
	dir: string = resolveBrigadeClaudeConfigDir(),
): ClaudeKeychainShadowState {
	if (os.platform() !== "darwin") return "unsupported";
	let raw: string;
	try {
		raw = execFileSync("security", ["find-generic-password", "-s", claudeKeychainService(dir), "-w"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: KEYCHAIN_CMD_TIMEOUT_MS,
		});
	} catch {
		return "none"; // no entry — the file is already authoritative
	}
	let token: unknown;
	try {
		token = (JSON.parse(raw.trim()) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth?.accessToken;
	} catch {
		token = undefined; // unparseable shadow is by definition unusable
	}
	return typeof token === "string" && token.length > 0 ? "healthy" : "tombstoned";
}

export function healClaudeKeychainShadow(dir: string = resolveBrigadeClaudeConfigDir()): "none" | "cleared" {
	if (os.platform() !== "darwin") return "none";
	// Never trade a shadow for nothing: if OUR credential is absent or itself
	// empty, the shadow — stale as it looks — may still hold the only refresh
	// token on this machine. Clearing then would destroy the last way back in.
	// Read from `dir` — NOT the resolved default. The keychain probe is keyed on
	// `dir`, and a mismatch would judge one store by the other's health.
	let ours: ClaudeCodeCredentialFile["claudeAiOauth"] | undefined;
	try {
		ours = (JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")) as ClaudeCodeCredentialFile)
			.claudeAiOauth;
	} catch {
		ours = undefined;
	}
	if (!ours || typeof ours.accessToken !== "string" || ours.accessToken.length === 0) return "none";
	if (inspectClaudeKeychainShadow(dir) !== "tombstoned") return "none";
	return clearClaudeKeychainShadow(dir) ? "cleared" : "none";
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
	// The keychain shadow (macOS) outranks this file — a stale one would make
	// the binary ignore the credential we just minted. Drop it so the binary
	// bootstraps from here and writes a fresh entry itself.
	clearClaudeKeychainShadow(dir);
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
	// Remove the credential everywhere Brigade caused it to exist. On macOS the
	// binary mirrored our grant into the login keychain under this config dir's
	// own service name; leaving it behind would keep a live credential on the
	// machine after the operator asked us to forget it — and would silently
	// shadow the next login. Never touches the operator's personal `~/.claude`
	// entry, which is un-suffixed and unreachable from this derivation.
	clearClaudeKeychainShadow();
}
