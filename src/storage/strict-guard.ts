// src/storage/strict-guard.ts
//
// Convex-mode enforcement that ~/.brigade stays file-free (modulo the
// operator-approved allowlist). Two layers:
//
//   1. PREVENTIVE — patches the `node:fs` namespace write methods to
//      intercept writes targeting the state dir. Catches `fs.writeFileSync`
//      style callers (the namespace object is shared); ESM named-import
//      bindings snapshot before the patch are NOT covered — that's what
//      layer 2 is for.
//   2. DETECTIVE — a recursive fs.watch on the state dir reports EVERY
//      file event regardless of who wrote it (named imports, third-party
//      libs, child processes). After-the-fact by nature, so it logs/counts
//      rather than blocks.
//
// Levels via BRIGADE_STRICT_MODE: "off" (no guard), "warn" (default —
// log + count), "enforce" (layer 1 throws; layer 2 still logs). The
// violation counter feeds `brigade doctor`.
//
// Allowlist (operator decisions 2026-06-10):
//   • mode.sentinel — THE bootstrap file
//   • workspace/** and agents/<id>/workspace/** — the workspace directory
//     (including .git) stays local by explicit operator choice

import fs from "node:fs";
import path from "node:path";

export type StrictMode = "off" | "warn" | "enforce";

interface Violation {
	method: string;
	target: string;
	at: number;
	stack?: string;
}

let _installed = false;
let _stateDir: string | undefined;
let _mode: StrictMode = "warn";
let _watcher: fs.FSWatcher | undefined;
const _violations: Violation[] = [];
const VIOLATION_CAP = 500;

function isAllowlisted(target: string): boolean {
	if (!_stateDir) return true;
	const rel = path.relative(_stateDir, path.resolve(target));
	if (rel.startsWith("..") || path.isAbsolute(rel)) return true; // outside state dir
	const parts = rel.split(path.sep);
	if (parts[0] === "mode.sentinel") return true;
	// Workspace stays local (incl. .git) — operator decision.
	if (parts[0] === "workspace") return true;
	// The self-hosted Convex backend a global install runs locally keeps its
	// binary + sqlite database under `convex/`. That IS the authoritative store
	// (factory-reset deliberately PRESERVES it), not leaked state, and its
	// constant `*.sqlite3-journal` churn would otherwise flood the guard.
	if (parts[0] === "convex") return true;
	if (parts[0] === "agents") {
		// agents/<id>/workspace/** stays local (operator decision).
		if (parts[2] === "workspace") return true;
		// `agents` and `agents/<id>` are just the PARENT dirs of allowed
		// workspaces — creating a new agent (org init mkdir -p's the tree)
		// fires watcher events on the intermediates, which flooded the
		// console with false violations during a 20-agent org creation.
		// A REAL leak under agents/<id>/<anything-else> fires its own event
		// with parts[2] !== "workspace" and still flags (e.g. a stray
		// agents/<id>/agent/auth-profiles.json).
		if (parts.length <= 2) return true;
	}
	// Agent-deletion trash is local recovery state (workspace is local), so
	// its trash is too — covers agents/.brigade-trash/**, agents/<id>/
	// .brigade-trash/**, and a custom in-state workspace's trash.
	if (parts.includes(".brigade-trash")) return true;
	return false;
}

function recordViolation(method: string, target: string): void {
	if (_violations.length < VIOLATION_CAP) {
		_violations.push({
			method,
			target,
			at: Date.now(),
			...(_mode !== "off" ? { stack: new Error().stack?.split("\n").slice(3, 7).join("\n") } : {}),
		});
	}
	// Do NOT print to stderr by default: this process's stderr renders straight
	// into the interactive TUI, and per-write spam (a chatty external binary, or
	// churny sqlite journals) floods the conversation. The violation is COUNTED
	// above for `brigade doctor`; opt into live logging with BRIGADE_STRICT_LOG=1.
	if (process.env.BRIGADE_STRICT_LOG === "1") {
		console.error(
			`brigade: STRICT-ZERO VIOLATION — ${method} targeting ${target} (convex mode forbids writes under the state dir)`,
		);
	}
}

function guardTarget(method: string, target: unknown): void {
	if (typeof target !== "string" && !(target instanceof URL)) return;
	const p = target instanceof URL ? target.pathname : target;
	if (isAllowlisted(p)) return;
	recordViolation(method, String(p));
	if (_mode === "enforce") {
		throw new Error(
			`brigade strict-zero: refusing ${method} under the state dir in convex mode — ${String(p)}. ` +
				"State belongs in Convex; scratch belongs in the OS cache dir.",
		);
	}
}

/** Patch the fs namespace write methods (layer 1) + start the watcher
 *  (layer 2). Idempotent; no-op when BRIGADE_STRICT_MODE=off or outside
 *  convex mode (callers gate). */
export function installStrictGuard(stateDir: string): void {
	if (_installed) return;
	const env = process.env.BRIGADE_STRICT_MODE?.trim().toLowerCase();
	_mode = env === "off" || env === "enforce" ? (env as StrictMode) : "warn";
	if (_mode === "off") return;
	_installed = true;
	_stateDir = path.resolve(stateDir);

	// Layer 1 — namespace patches. First-arg-is-target methods only; rename
	// and copy check the DESTINATION (second arg).
	const firstArg = [
		"writeFileSync",
		"appendFileSync",
		"mkdirSync",
		"openSync",
		"createWriteStream",
	] as const;
	for (const method of firstArg) {
		const original = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
		if (typeof original !== "function") continue;
		(fs as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => {
			// openSync only writes with write-ish flags.
			if (method === "openSync") {
				const flags = a[1];
				if (typeof flags === "string" && !/[wa+]/.test(flags)) {
					return original(...a);
				}
			}
			guardTarget(`fs.${method}`, a[0]);
			return original(...a);
		};
	}
	const secondArg = ["renameSync", "copyFileSync"] as const;
	for (const method of secondArg) {
		const original = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
		if (typeof original !== "function") continue;
		(fs as unknown as Record<string, unknown>)[method] = (...a: unknown[]) => {
			guardTarget(`fs.${method}`, a[1]);
			return original(...a);
		};
	}

	// Layer 2 — detective watcher. Recursive watch is supported on Windows +
	// macOS; on Linux it throws — degrade to layer 1 only.
	try {
		if (fs.existsSync(_stateDir)) {
			_watcher = fs.watch(_stateDir, { recursive: true }, (_event, filename) => {
				if (!filename) return;
				const name = filename.toString();
				// Windows quirk: when the WATCHED ROOT itself is removed (e.g.
				// `store reset --purge-local` rm -rf's ~/.brigade), events can
				// carry an absolute extended-length path (`\\?\C:\…`) instead of
				// a relative name. Joining that onto the state dir produced
				// nonsense like `…\.brigade\?\C:\…\.brigade` and a violation
				// FLOOD for what is actually the sanctioned wipe. Treat absolute
				// names as-is, never join them.
				const full = path.isAbsolute(name) || name.startsWith("\\\\?\\")
					? name.replace(/^\\\\\?\\/, "")
					: path.join(_stateDir as string, name);
				if (isAllowlisted(full)) return;
				// Strict-zero forbids WRITES; deletions are the goal. fs.watch
				// can't distinguish create/delete (both are "rename" events), so
				// discriminate cheaply: a path that no longer exists was removed
				// — not a violation. And once the state dir itself is gone, the
				// watcher is moot — close it instead of spinning on events.
				try {
					if (!fs.existsSync(_stateDir as string)) {
						stopStrictGuard();
						return;
					}
					if (!fs.existsSync(full)) return;
				} catch {
					return; // unreadable mid-delete — never flag noise
				}
				recordViolation("fs.watch(detected)", full);
			});
			_watcher.unref?.();
		}
	} catch {
		// Recursive watch unsupported — layer 1 still active.
	}
}

export function getStrictViolations(): ReadonlyArray<Violation> {
	return _violations;
}

export function stopStrictGuard(): void {
	try {
		_watcher?.close();
	} catch {
		/* idempotent */
	}
	_watcher = undefined;
}

/** Test-only. */
export function __resetStrictGuardForTests(): void {
	stopStrictGuard();
	_installed = false;
	_stateDir = undefined;
	_violations.length = 0;
	_mode = "warn";
}
