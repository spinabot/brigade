/**
 * Brigade exec-approvals — synchronous tool-approval gate for `bash` and any
 * future tool that touches the operator's machine.
 *
 * v1 shape (per-agent, file-backed allowlist):
 *   - Operator approves once → command (or pattern) lands in an allowlist file
 *     at `<agentDir>/exec-approvals.json` (one file per agent id).
 *   - Subsequent invocations of the same command short-circuit `decideApproval`
 *     → returns `"allow"` without prompting.
 *   - Unknown commands return `"prompt"`; the caller (bash tool) then surfaces
 *     a TUI prompt and writes the decision back via `recordApproval`.
 *   - Hard-deny patterns (rm -rf /, dd to /dev/sda, etc.) return `"deny"` and
 *     are NEVER stored. Caller rejects without prompting the operator.
 *
 * Per-agent layout:
 *   - Each agent gets its own allowlist at `<agentDir>/exec-approvals.json`,
 *     matching how `auth-profiles.json` and `profile-state.json` are scoped.
 *     A `rm -rf <agentDir>` reset truly wipes that agent's trust state along
 *     with everything else.
 *   - The DEFAULT agent ("main") migrates the legacy global file at
 *     `~/.brigade/exec-approvals.json` on first read: if the global exists and
 *     the per-agent file doesn't, the contents move into `<agentDir>/exec-
 *     approvals.json` and the global is renamed to `.migrated`. Idempotent —
 *     re-running after migration is a no-op.
 *
 * Multi-process cache discipline (matters for long-lived gateway + concurrent
 * `brigade exec allow` from another shell):
 *   - The file's mtime is captured at load time (per-agent cache entry). Every
 *     `decideApproval` / `recordApproval` stats the file FIRST; if mtime moved,
 *     the entry is dropped and reloaded. This makes the second-shell flow
 *     ("operator runs `brigade exec allow X --agent main` while the TUI is
 *     mid-turn") work without restart — the next bash refusal in the running
 *     TUI picks up the new approval on its next call.
 *   - Cost: one stat() per gate call. Negligible (microseconds) vs the
 *     correctness gain.
 *
 * Concurrent-writer race avoidance (two `brigade exec allow` shells racing):
 *   - Every write reads FRESH from disk first (bypassing cache), merges the
 *     in-memory mutation with whatever's on disk RIGHT NOW, then writes the
 *     union atomically via PID-tagged tempfile + rename. Last writer wins
 *     PER COMMAND, but no entries are LOST.
 *
 * File-permission discipline:
 *   - On write we chmod 0600 (operator-only read/write). Allowlist entries
 *     can reveal a lot about an operator's workflow (cloud creds, secrets
 *     paths, internal hostnames) — group/world access is never warranted.
 *   - The check is best-effort on Windows (chmod is a partial-fidelity op
 *     under NTFS) but defensible on POSIX hosts where the threat is real.
 *
 * Symlink-target guard:
 *   - Before writing, lstat the destination — if it's a symbolic link, refuse.
 *     This catches the footgun where an operator (or a malicious dotfile in
 *     a shared system) plants `exec-approvals.json` as a symlink pointing at
 *     `/etc/passwd`.
 *
 * Storage layout (`<agentDir>/exec-approvals.json`):
 *   {
 *     "version": 1,
 *     "commands": ["ls -la", "git status", "npm test"],
 *     "patterns": ["^git diff( |$)", "^cat package\\.json$"]
 *   }
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_AGENT_ID, resolveAgentDir, resolveStateDir } from "../config/paths.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";

const SUPPORTED_SCHEMA_VERSION = 1 as const;

export type ApprovalDecision = "allow" | "deny" | "prompt";

interface ApprovalsFile {
	version: typeof SUPPORTED_SCHEMA_VERSION;
	commands: string[];
	patterns: string[];
}

/**
 * Hard-deny patterns. Match-first, never prompt the operator. Kept short and
 * conservative — the goal is to catch obvious foot-guns, not be a sandbox.
 * The operator has explicitly run `brigade chat` and accepted the v1 trust
 * model; this list exists to prevent autonomous loops from typing fatal
 * commands the operator never would.
 *
 * Coverage spans BOTH POSIX (rm -rf /, dd, fork bombs) and Windows
 * (PowerShell Remove-Item, cmd /c rd / del, Format-Volume, Clear-Disk).
 * Brigade ships on win32 first-class — refusing only POSIX would leave
 * the Windows operator with a half-armored gate.
 */
const HARD_DENY_PATTERNS: RegExp[] = [
	// ── POSIX ─────────────────────────────────────────────────────────
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*[fF]?[a-zA-Z]*|--recursive\s+--force|-rf|-fr)\s+["']?\/["']?(?:\s|$)/, // rm -rf /
	/\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme|hd[a-z])/, // dd to raw disk
	/\bmkfs\.[a-z0-9]+\s+\/dev\//, // format raw disk
	/:\(\)\s*\{[^}]*:\|:[^}]*\}\s*;?\s*:/, // fork bomb
	/\bchmod\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+0+\s+\//, // chmod 000 /
	/\bchown\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+\S+\s+\//, // chown /
	/>\s*\/dev\/sd[a-z]/, // redirect into raw disk
	// ── Windows: cmd.exe ──────────────────────────────────────────────
	/\brd\s+[^\n]*\/s\b[^\n]*\b[a-z]:/i,
	/\bdel\s+[^\n]*\/s\b[^\n]*\b[a-z]:/i,
	// ── Windows: PowerShell ──────────────────────────────────────────
	/(?:Remove-Item|\bri)\b[^\n]*(?:-Recurse\b[^\n]*-Force|-Force\b[^\n]*-Recurse|-r\b[^\n]*-Force|-Force\b[^\n]*-r)\b[^\n]*\b[a-z]:/i,
	/Format-Volume\b[^\n]*-DriveLetter\s+[A-Z]/i,
	/Clear-Disk\b[^\n]*-RemoveData/i,
];

interface CacheEntry {
	contents: ApprovalsFile;
	/** mtime ms at load time. -1 sentinel = file was missing when loaded. */
	mtimeMs: number;
}

// Per-agentId cache. Keyed on normalised agentId so two callers passing
// "main" / " main " resolve to the same slot.
const cache = new Map<string, CacheEntry>();

// Track per-agent migration-from-legacy status so we only attempt the rename
// once per process start.
const migrationAttempted = new Set<string>();

/**
 * Normalise an agentId for cache lookup + path resolution. Trims and falls
 * back to the default when empty so callers passing `undefined` or `""` still
 * land in a deterministic slot.
 */
function normaliseAgentId(agentId: string | undefined): string {
	const trimmed = (agentId ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_AGENT_ID;
}

/**
 * Resolve the absolute path to an agent's exec-approvals.json. Pure function
 * over `resolveAgentDir` so callers (CLI, diagnostics) can discover the path
 * without loading the file.
 */
export function resolveExecApprovalsPath(agentId: string | undefined = DEFAULT_AGENT_ID): string {
	return path.join(resolveAgentDir(normaliseAgentId(agentId)), "exec-approvals.json");
}

/** Legacy global path — `~/.brigade/exec-approvals.json`. */
function resolveLegacyExecApprovalsPath(): string {
	return path.join(resolveStateDir(), "exec-approvals.json");
}

/**
 * Best-effort migration: if a legacy global file exists AND the per-agent file
 * for the default agent doesn't, move the legacy contents into the default
 * agent's slot. The legacy file is renamed to `.migrated` so a second boot
 * doesn't try to migrate it again. Failures are logged-and-ignored — the
 * gate falls back to the (empty) per-agent file so the default behaviour
 * stays "refuse every bash command until approved".
 *
 * Only the default agent ("main") inherits the legacy file — other agents
 * start fresh, which matches how `auth-profiles.json` migrated.
 */
function maybeMigrateLegacyApprovals(agentId: string): void {
	if (agentId !== DEFAULT_AGENT_ID) return;
	if (migrationAttempted.has(agentId)) return;
	migrationAttempted.add(agentId);
	const legacy = resolveLegacyExecApprovalsPath();
	const target = resolveExecApprovalsPath(agentId);
	if (target === legacy) return; // BRIGADE_STATE_DIR override collapsed paths
	try {
		if (!fs.existsSync(legacy)) return;
		if (fs.existsSync(target)) return; // per-agent slot already populated
		fs.mkdirSync(path.dirname(target), { recursive: true });
		// Copy contents then rename the legacy file so a partial copy doesn't
		// leave an empty target. `renameSync(legacy, target)` would be cheaper
		// but doesn't work cross-filesystem; copy + unlink is portable.
		const raw = fs.readFileSync(legacy, "utf8");
		fs.writeFileSync(target, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
		try {
			fs.renameSync(legacy, `${legacy}.migrated`);
		} catch {
			// Couldn't rename — leave the legacy file in place so a future
			// migration attempt can retry, but the per-agent target now wins.
		}
	} catch {
		// Migration is best-effort. The per-agent file's absence becomes the
		// "empty allowlist" default, which is the secure choice.
	}
}

/**
 * Stat the approvals file and return its mtime, or -1 if it doesn't exist.
 * Defensive against transient stat errors (EACCES on a tempfile rename, etc.) —
 * those propagate the cached snapshot rather than panicking the gate.
 */
function currentMtimeMs(filePath: string, fallback: number): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return -1;
		return fallback;
	}
}

/**
 * Read + parse the approvals file. On future schema versions we throw a
 * typed error so the gate REFUSES to operate instead of silently dropping
 * fields on the next save. On missing/malformed/empty content we return an
 * empty v1 allowlist — the secure default.
 */
function loadApprovalsFromDisk(filePath: string): ApprovalsFile {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return emptyApprovals();
	}
	if (raw.trim().length === 0) return emptyApprovals();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyApprovals();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return emptyApprovals();
	}
	const obj = parsed as { version?: unknown; commands?: unknown; patterns?: unknown };
	if (obj.version !== undefined && obj.version !== SUPPORTED_SCHEMA_VERSION) {
		throw new BrigadeApprovalFileVersionError(
			`exec-approvals.json declares schema version ${JSON.stringify(obj.version)} ` +
				`but this Brigade build only understands v${SUPPORTED_SCHEMA_VERSION}. ` +
				`Either upgrade Brigade, or move the file aside and start fresh: ` +
				`\`mv "${filePath}" "${filePath}.from-v${String(obj.version)}.bak"\` ` +
				`then re-approve commands with \`brigade exec allow ...\`.`,
		);
	}
	return {
		version: SUPPORTED_SCHEMA_VERSION,
		commands: Array.isArray(obj.commands) ? obj.commands.filter((s) => typeof s === "string") : [],
		patterns: Array.isArray(obj.patterns) ? obj.patterns.filter((s) => typeof s === "string") : [],
	};
}

function emptyApprovals(): ApprovalsFile {
	return { version: SUPPORTED_SCHEMA_VERSION, commands: [], patterns: [] };
}

/**
 * Load the cache slot for `agentId` if absent OR if the on-disk file's mtime
 * moved since we captured it. Triggers the lazy legacy migration the first
 * time we look up the default agent.
 */
function loadApprovals(agentId: string): ApprovalsFile {
	const id = normaliseAgentId(agentId);

	// Convex mode — serve from the in-process cache. Boot hydration
	// (storage/boot.ts) fills every config agent's slot from the
	// execApprovals table; the mutators below pin the slot on every write;
	// the gateway's live-query watch keeps cross-process changes fresh.
	// An agent with no slot has no approvals — the empty shape is correct.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		const existing = cache.get(id);
		if (existing) return existing.contents;
		const empty = emptyApprovals();
		cache.set(id, { contents: empty, mtimeMs: -1 });
		return empty;
	}

	maybeMigrateLegacyApprovals(id);
	const filePath = resolveExecApprovalsPath(id);
	const existing = cache.get(id);
	const observed = currentMtimeMs(filePath, existing?.mtimeMs ?? -1);
	if (existing && existing.mtimeMs === observed) {
		return existing.contents;
	}
	const contents = loadApprovalsFromDisk(filePath);
	cache.set(id, { contents, mtimeMs: observed });
	return contents;
}

/** Convex-mode boot hydration — install the agent's allowlist into the
 *  module cache so the synchronous gate (`decideApproval`) works without
 *  disk or network on the hot path. Called from storage/boot.ts. */
export function primeApprovalsCache(
	agentId: string,
	contents: { commands: string[]; patterns: string[] },
): void {
	const id = normaliseAgentId(agentId);
	cache.set(id, {
		contents: {
			version: SUPPORTED_SCHEMA_VERSION,
			commands: [...contents.commands],
			patterns: [...contents.patterns],
		},
		mtimeMs: -1,
	});
}

// Serialises convex-mode approval mutations; errors are surfaced loudly but
// don't poison later writes.
let approvalsFlushChain: Promise<void> = Promise.resolve();

/** Resolves when every approval mutation enqueued so far reached the
 *  backend (convex mode). */
export function awaitApprovalsFlush(): Promise<void> {
	return approvalsFlushChain;
}

/**
 * Refuse to write through a symbolic link at the destination. A malicious
 * dotfile or operator-symlinked path could otherwise leave `exec-approvals.
 * json` pointing at `/etc/passwd`. Throw instead so the misuse is visible.
 */
function refuseAliasedApprovalsPath(filePath: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		return;
	}
	if (stat.isSymbolicLink()) {
		throw new BrigadeApprovalRefusedError(
			`refused to write through symlink: "${filePath}" is a symbolic link. ` +
				`Move or delete the symlink and let Brigade create a regular file: ` +
				`\`rm "${filePath}"\` then re-run your \`brigade exec\` command.`,
		);
	}
}

/**
 * Atomically write the given contents to the approvals file. PID + random
 * tempfile name so two concurrent writers don't collide on the temp path;
 * `flag: "wx"` enforces exclusive create so a collision is reported as an
 * error rather than silently overwriting a stranger's tempfile.
 */
function writeApprovalsFileAtomic(filePath: string, contents: ApprovalsFile): void {
	refuseAliasedApprovalsPath(filePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(contents, null, 2), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {
		// Windows or filesystem without chmod fidelity — ignore.
	}
}

/**
 * Pin the cache to the just-written file's mtime so the NEXT call doesn't
 * spuriously reload. Called after writeApprovalsFileAtomic by every mutator.
 */
function pinCacheAfterWrite(agentId: string, filePath: string, contents: ApprovalsFile): void {
	const id = normaliseAgentId(agentId);
	try {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		cache.set(id, { contents, mtimeMs });
	} catch {
		cache.set(id, { contents, mtimeMs: -1 });
	}
}

/**
 * Normalize a command for EXACT-match comparison. Collapses internal runs
 * of ASCII whitespace to a single space so a model emitting `"  ls   -la  "`
 * still matches an approved `"ls -la"`. Does NOT lowercase (case matters on
 * POSIX) and does NOT touch quoting/escaping.
 */
function normalizeForExactMatch(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/**
 * Decide whether a command can run without prompting the operator.
 *
 *   - `"deny"` — hard-blocked pattern; caller MUST refuse and never prompt.
 *   - `"allow"` — allowlist hit; caller can run immediately.
 *   - `"prompt"` — caller should surface a TUI prompt; on operator approval,
 *     caller passes the decision back via `recordApproval`.
 *
 * `agentId` selects which per-agent allowlist to consult. Defaults to the
 * canonical agent so legacy single-agent callers keep working unchanged.
 */
export function decideApproval(
	command: string,
	agentId: string | undefined = DEFAULT_AGENT_ID,
): ApprovalDecision {
	const cmd = command.trim();
	if (!cmd) return "prompt";

	if (isHardDenied(cmd)) return "deny";

	const approvals = loadApprovals(agentId ?? DEFAULT_AGENT_ID);

	const normalisedCmd = normalizeForExactMatch(cmd);
	for (const entry of approvals.commands) {
		if (normalizeForExactMatch(entry) === normalisedCmd) return "allow";
	}

	for (const pat of approvals.patterns) {
		try {
			const re = new RegExp(pat);
			if (re.test(cmd)) return "allow";
		} catch {
			// Skip malformed pattern.
		}
	}

	return "prompt";
}

/**
 * Test-time helper exported so other modules can ask "is this command in
 * the hard-deny set?" without having to re-implement the regex list.
 */
export function isHardDenied(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	for (const re of HARD_DENY_PATTERNS) {
		if (re.test(cmd)) return true;
	}
	return false;
}

/**
 * Probe corpus for `patternMatchesHardDeny`. Each entry is a concrete
 * canonical example of a hard-denied command — if an operator's pattern
 * matches ANY of these, the pattern is footgun-shaped and we refuse to
 * persist it.
 */
const HARD_DENY_PROBES: readonly string[] = [
	"rm -rf /",
	"rm -fr /",
	"dd if=/dev/zero of=/dev/sda",
	":(){ :|:& };:",
	"mkfs.ext4 /dev/sdb1",
	"chmod -R 0 /",
	"chown -R root /",
	"> /dev/sda",
	"rd /s /q C:\\",
	"del /f /s /q C:\\*",
	"Remove-Item -Recurse -Force C:\\",
	"ri -Recurse -Force C:\\",
	"Format-Volume -DriveLetter C",
	"Clear-Disk -Number 0 -RemoveData",
];

/**
 * Does a given regex pattern match ANY hard-denied probe command? Used by
 * `recordApproval(kind: "pattern")` to refuse footgun-shaped patterns at
 * write time.
 */
export function patternMatchesHardDeny(pattern: string): boolean {
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		return false;
	}
	for (const probe of HARD_DENY_PROBES) {
		if (re.test(probe)) return true;
	}
	return false;
}

/**
 * Persist an operator's "always allow" approval to the per-agent allowlist.
 * `kind: "exact"` adds the command verbatim; `kind: "pattern"` adds it as a
 * regex. Either way the change lands on disk before the function returns.
 *
 * Concurrent-write safety: re-reads FRESH from disk (bypassing cache) and
 * merges the addition INTO that fresh snapshot, so a sibling process's recent
 * write isn't clobbered.
 */
export function recordApproval(
	command: string,
	kind: "exact" | "pattern" = "exact",
	agentId: string | undefined = DEFAULT_AGENT_ID,
): void {
	const value = command.trim();
	if (!value) return;
	if (kind === "exact" && isHardDenied(value)) {
		throw new BrigadeApprovalRefusedError(
			`refused to record approval: "${value}" matches a hard-deny pattern (rm -rf /, ` +
				`dd to raw disk, fork bomb, etc.). Hard-denied commands are permanently ` +
				`refused by the gate and cannot be allowlisted — pick a safer command.`,
		);
	}
	if (kind === "pattern" && patternMatchesHardDeny(value)) {
		throw new BrigadeApprovalRefusedError(
			`refused to record approval: pattern /${value}/ matches at least one hard-deny ` +
				`command (e.g. "rm -rf /" or "Remove-Item -Recurse -Force C:\\"). The gate ` +
				`would refuse those calls anyway — narrow the pattern with an anchor (^) and ` +
				`a more specific prefix so it only matches what you intend to approve.`,
		);
	}
	const id = normaliseAgentId(agentId);

	// Convex mode — mutate the cached shape (the gate sees the approval
	// immediately) and enqueue the row insert. The insert mutation is
	// idempotent on (agentId, kind, valueNormalised), matching the
	// duplicate-skip below.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		const current = loadApprovals(id);
		const next: ApprovalsFile = {
			version: current.version,
			commands: [...current.commands],
			patterns: [...current.patterns],
		};
		if (kind === "exact") {
			if (next.commands.includes(value)) return;
			next.commands.push(value);
		} else {
			if (next.patterns.includes(value)) return;
			next.patterns.push(value);
		}
		cache.set(id, { contents: next, mtimeMs: -1 });
		const store = rctx.store;
		approvalsFlushChain = approvalsFlushChain
			.then(() => store.execApprovals.recordApproval({ agentId: id, value, kind }))
			.catch((err) => {
				console.error(
					`brigade: approval write to convex failed (agent ${id}) — ${(err as Error).message}`,
				);
			});
		return;
	}

	maybeMigrateLegacyApprovals(id);
	const filePath = resolveExecApprovalsPath(id);
	const fresh = loadApprovalsFromDisk(filePath);
	if (kind === "exact") {
		if (!fresh.commands.includes(value)) fresh.commands.push(value);
	} else {
		if (!fresh.patterns.includes(value)) fresh.patterns.push(value);
	}
	writeApprovalsFileAtomic(filePath, fresh);
	pinCacheAfterWrite(id, filePath, fresh);
}

/**
 * Remove an exact command OR a pattern from the per-agent allowlist. Looks
 * in BOTH lists — if the value matches either, it's dropped. Returns the
 * count of entries actually removed.
 */
export function removeApproval(
	value: string,
	agentId: string | undefined = DEFAULT_AGENT_ID,
): { removedCommands: number; removedPatterns: number } {
	const v = value.trim();
	if (!v) return { removedCommands: 0, removedPatterns: 0 };
	const id = normaliseAgentId(agentId);

	// Convex mode — drop from the cached shape and enqueue the row delete.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		const current = loadApprovals(id);
		const next: ApprovalsFile = {
			version: current.version,
			commands: current.commands.filter((c) => c !== v),
			patterns: current.patterns.filter((p) => p !== v),
		};
		const removedCommands = current.commands.length - next.commands.length;
		const removedPatterns = current.patterns.length - next.patterns.length;
		if (removedCommands === 0 && removedPatterns === 0) {
			return { removedCommands: 0, removedPatterns: 0 };
		}
		cache.set(id, { contents: next, mtimeMs: -1 });
		const store = rctx.store;
		approvalsFlushChain = approvalsFlushChain
			.then(() => store.execApprovals.removeApproval(id, v))
			.then(() => {})
			.catch((err) => {
				console.error(
					`brigade: approval removal in convex failed (agent ${id}) — ${(err as Error).message}`,
				);
			});
		return { removedCommands, removedPatterns };
	}

	maybeMigrateLegacyApprovals(id);
	const filePath = resolveExecApprovalsPath(id);
	const fresh = loadApprovalsFromDisk(filePath);
	const beforeCmd = fresh.commands.length;
	const beforePat = fresh.patterns.length;
	fresh.commands = fresh.commands.filter((c) => c !== v);
	fresh.patterns = fresh.patterns.filter((p) => p !== v);
	const removedCommands = beforeCmd - fresh.commands.length;
	const removedPatterns = beforePat - fresh.patterns.length;
	if (removedCommands === 0 && removedPatterns === 0) {
		return { removedCommands: 0, removedPatterns: 0 };
	}
	writeApprovalsFileAtomic(filePath, fresh);
	pinCacheAfterWrite(id, filePath, fresh);
	return { removedCommands, removedPatterns };
}

/**
 * Thrown by `recordApproval` (or the writer's symlink guard) when the
 * caller asks Brigade to write something it refuses to write.
 */
export class BrigadeApprovalRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrigadeApprovalRefusedError";
	}
}

/**
 * Thrown by the loader when the file's schema version isn't supported.
 */
export class BrigadeApprovalFileVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrigadeApprovalFileVersionError";
	}
}

/**
 * Test-only helper. Wipes the in-memory cache so the next call to
 * `decideApproval` re-reads from disk.
 */
export function _resetApprovalsCacheForTests(): void {
	cache.clear();
	migrationAttempted.clear();
}

/**
 * Return the absolute path to the approvals file for `agentId`. Useful for
 * `brigade doctor` + `brigade status` so the operator knows where the trust
 * list lives.
 */
export function getApprovalsFilePath(
	agentId: string | undefined = DEFAULT_AGENT_ID,
): string {
	return resolveExecApprovalsPath(agentId);
}

/**
 * Read-only summary of the on-disk allowlist for the given agent. Surfaced
 * by `brigade status` / `brigade doctor` so the operator can see at a glance
 * how many commands are approved and where the file lives.
 *
 * Always reads via the cache so a long-lived gateway sees the same view as
 * any in-flight gate call. Returns zeros when the file is missing or
 * unparseable rather than throwing — the calling diagnostic surface decides
 * how to render an empty state. A version mismatch is reported via the
 * `error` field instead of throwing so `brigade doctor` can render a
 * remediation hint without crashing.
 */
/**
 * Enumerate every approval row for an agent. Returned in a stable shape:
 *   { commands: string[], patterns: string[] }
 *
 * Used by the `brigade store migrate` engine — earlier versions only had
 * `readApprovalsSummary` (counts), which forced operators to copy entries
 * by hand. This enumerator exposes the underlying data without leaking
 * the on-disk file shape.
 */
export function listApprovals(
	agentId: string | undefined = DEFAULT_AGENT_ID,
): { commands: string[]; patterns: string[] } {
	const id = normaliseAgentId(agentId);
	maybeMigrateLegacyApprovals(id);
	const file = loadApprovals(id);
	return {
		commands: [...(file.commands ?? [])],
		patterns: [...(file.patterns ?? [])],
	};
}

export function readApprovalsSummary(
	agentId: string | undefined = DEFAULT_AGENT_ID,
): {
	commandCount: number;
	patternCount: number;
	filePath: string;
	fileExists: boolean;
	error?: string;
} {
	const id = normaliseAgentId(agentId);
	maybeMigrateLegacyApprovals(id);
	const filePath = resolveExecApprovalsPath(id);
	const exists = fs.existsSync(filePath);
	if (!exists) {
		return { commandCount: 0, patternCount: 0, filePath, fileExists: false };
	}
	try {
		const approvals = loadApprovals(id);
		return {
			commandCount: approvals.commands.length,
			patternCount: approvals.patterns.length,
			filePath,
			fileExists: true,
		};
	} catch (err) {
		return {
			commandCount: 0,
			patternCount: 0,
			filePath,
			fileExists: true,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
