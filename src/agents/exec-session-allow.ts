/**
 * Session-scoped exec "allow-all" toggle (operator-armed).
 *
 * When the operator runs `/allow-all on` for a session, the exec-gate stops
 * PROMPTING for shell commands in that session and lets them run. It ONLY
 * waives the interactive approval prompt — every protective layer still
 * applies, by construction:
 *
 *   - hard-deny patterns (rm -rf /, fork bombs, …) → exec-gate returns "deny"
 *     and never reaches the allow-all check;
 *   - workdir / cwd / env hijack refusals → returned before decideApproval;
 *   - the config-write-guard + path-write-guard (which protect brigade.json,
 *     encryption.key, auth, cron.json, mode.sentinel, protected roots) run
 *     BEFORE the exec-gate in composeBrigadeBeforeToolCall, so they block
 *     regardless of allow-all.
 *
 * State is in-memory and per session key: it clears on gateway restart, never
 * persists to disk, and does NOT cascade to sub-agents (they run under their
 * own derived child session keys, so their gate checks a key that was never
 * armed). Pinned via global-singleton so hot-reload / dual-build share one set.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const ALLOW_ALL_KEY = Symbol.for("brigade.execSessionAllowAll");

const armed = resolveGlobalSingleton<Set<string>>(ALLOW_ALL_KEY, () => new Set<string>());

/** Arm (`on`) or disarm allow-all for a session key. No-op on empty key. */
export function setExecAllowAll(sessionKey: string | undefined, on: boolean): void {
	const key = (sessionKey ?? "").trim();
	if (!key) return;
	if (on) armed.add(key);
	else armed.delete(key);
}

/** True when allow-all is armed for this session key. */
export function isExecAllowAll(sessionKey: string | undefined): boolean {
	const key = (sessionKey ?? "").trim();
	if (!key) return false;
	return armed.has(key);
}

/** Snapshot of armed session keys (sorted) — diagnostics / status. */
export function listExecAllowAllSessions(): string[] {
	return [...armed].sort();
}

/** Test-only — clear every armed session. */
export function clearExecAllowAllForTests(): void {
	armed.clear();
}
