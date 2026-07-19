// src/storage/factory-reset.ts
//
// Factory-reset the LOCAL Brigade state so a re-onboard lands VIRGIN — byte-for-
// byte the same starting point as a first-ever onboard, with NO carryover of the
// previous install's workspace personas, skills, sessions, or memory facts.
//
// Why this exists: the "clean slate" paths used to clear only the Convex backend.
// The local ~/.brigade tree (workspace, skills, sessions, facts.jsonl, the
// workspace-setup stamp) always survived and was re-mirrored / re-read on the
// next boot, so "Start fresh" was NOT a fresh start. This wipes it.
//
// This clears filesystem-mode STATE only. It is NOT an uninstaller and NOT a
// convex-backend eraser, so two classes of thing under the state dir survive —
// removing either turns a routine reset into an outage or data loss:
//
//   • The RUNNING install — the interpreter + the `brigade` CLI itself. The
//     bundled-install path drops a private Node runtime AND the brigade package
//     UNDER the state dir, then puts it on PATH. A blind `rm -rf ~/.brigade`
//     deletes the very node/binary that are executing, so the next
//     `brigade`/`node`/`npm` in a new shell is "command not found" — the reset
//     silently UNINSTALLS Brigade. This is preserved by DETECTION, not by name:
//     the installers disagree on the dir name (Unix install.sh → `runtime`,
//     Windows install.ps1 → `node`), so a name allowlist would miss one and
//     uninstall the CLI. We instead keep whatever top-level entry contains
//     `process.execPath` or the installed package (see computePreservedEntries).
//     When the runtime lives OUTSIDE the state dir (Windows' %LOCALAPPDATA%, or a
//     system/nvm node), nothing under the state dir matches, so it's a no-op.
//   • `convex/` — the self-hosted Convex backend a GLOBAL install runs locally:
//     its binary at `~/.brigade/convex/bin` and, critically, its DATABASE at
//     `~/.brigade/convex/data`. In convex mode that sqlite IS the authoritative
//     store — wiping it is total, irreversible user-data loss (and if the
//     backend is running, pulls its binary + db out from under it mid-flight,
//     which on Windows also throws EPERM and aborts the reset). Callers that DO
//     want a virgin backend erase it through the admin API (resetConvexInstance
//     clears documents, keeping the dir + identity); this helper must not delete
//     the dir. (In-repo dev keeps convex under `<root>/.convex-data`, outside
//     the state dir — no entry here, no-op.)
//
// Also intentionally safe: the encryption key lives OUTSIDE the state dir (OS
// config dir) and is retired-to-`.bak` separately, never destroyed, so an OLD
// backup of the erased data stays readable.
//
// Caller contract: the gateway MUST be stopped first (open file handles +
// write-behind chains would otherwise race a directory removal), and the mode
// sentinel must be re-pinned afterward if the chosen mode should persist (the
// onboard wizard pins it after this runs; `store reset` deletes it on purpose).

import * as fs from "node:fs";
import * as path from "node:path";

import { resolvePackageRoot, resolveStateDir } from "../config/paths.js";

/**
 * Top-level entry names that are never disposable filesystem-mode state:
 *   • "convex" — the local self-hosted backend's binary AND its authoritative
 *     sqlite database (same dir name on every OS); wiping it is data loss.
 *   • "runtime" — the Unix installer's bundled-Node dir. Belt-and-suspenders:
 *     the name-agnostic detection below already covers it because the running
 *     `node` lives there, but naming it keeps the intent legible.
 * Installs that keep these elsewhere (system node; in-repo convex) simply won't
 * have the entry, so preserving the name is a harmless no-op for them.
 */
const STATIC_PRESERVE = ["convex", "runtime"] as const;

/**
 * The set of top-level entries under `stateDir` a wipe must KEEP.
 *
 * Beyond the static names, this preserves — NAME-AGNOSTICALLY — whatever
 * top-level dir (if any) contains the running Node binary (`execPath`) or the
 * installed brigade package (`packageRoot`). That is the load-bearing
 * guarantee: a reset must never delete the interpreter/CLI executing it,
 * whatever the installer named its dir (`runtime` on Unix, `node` on Windows,
 * anything tomorrow). When the runtime lives outside `stateDir`, neither path
 * is under it and nothing extra is preserved.
 *
 * Pure over its inputs — exported so the detection is unit-tested directly
 * (simulating the Windows `node`-named layout without needing Windows).
 */
export function computePreservedEntries(
	stateDir: string,
	execPath: string,
	packageRoot: string | null,
): Set<string> {
	const preserved = new Set<string>(STATIC_PRESERVE);
	for (const target of [execPath, packageRoot]) {
		const entry = topLevelEntryUnder(stateDir, target);
		if (entry) preserved.add(entry);
	}
	return preserved;
}

/**
 * The first path segment of `target` relative to `stateDir`, or null when
 * `target` is absent, IS `stateDir`, or lies outside it. Guards against `..`
 * escapes and absolute-relative results (different drive on Windows).
 */
function topLevelEntryUnder(stateDir: string, target: string | null): string | null {
	if (!target) return null;
	const rel = path.relative(stateDir, target);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	const [first] = rel.split(path.sep);
	return first && first !== ".." ? first : null;
}

/**
 * Clear the local Brigade state dir (`~/.brigade` by default) so the next
 * onboard/boot re-seeds defaults, while preserving the running install + the
 * local convex store (see computePreservedEntries). Removes the CONTENTS rather
 * than the dir itself so the preserved entries can stay put. Idempotent (a
 * missing dir is fine). Returns the path that was cleared.
 */
export function wipeLocalBrigadeState(stateDir: string = resolveStateDir()): string {
	let packageRoot: string | null = null;
	try {
		packageRoot = resolvePackageRoot();
	} catch {
		packageRoot = null;
	}
	const preserve = computePreservedEntries(stateDir, process.execPath, packageRoot);

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(stateDir, { withFileTypes: true });
	} catch {
		return stateDir; // nothing to wipe (missing dir) — matches the old `force` behaviour
	}
	for (const entry of entries) {
		if (preserve.has(entry.name)) continue;
		fs.rmSync(path.join(stateDir, entry.name), { recursive: true, force: true });
	}
	return stateDir;
}
