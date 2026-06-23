/**
 * User-module discovery.
 *
 * Out-of-tree modules dropped into `~/.brigade/extensions/` are discovered and
 * imported here, alongside the bundled ones. A candidate is either a top-level
 * `*.js`/`*.mjs`/`*.ts`/`*.mts` file or a folder containing
 * `index.{js,mjs,ts,mts}`. Each must `export default` a `BrigadeModule` (or an
 * array of them); anything else is skipped with a warning — a bad user module
 * never aborts boot. `.d.ts` declaration files are NOT candidates.
 *
 * TypeScript-authored modules load directly: imports go through a Jiti instance
 * that transpiles `.ts`/`.mts` on import, so authors don't need a build step.
 *
 * Authors import the stable `brigade/extension-sdk` / `brigade/channel-sdk`
 * surface (defineModule + the capability contracts), so a user module never
 * reaches into Brigade internals. Those specifiers are alias-resolved to
 * Brigade's own built SDK entry points by the Jiti instance (see `sdk-alias.ts`),
 * so the author does NOT install Brigade into the extensions folder.
 *
 * POSIX safety gates (non-Windows only): world-writable files are rejected
 * (mode & 0o002), suspicious ownership (uid != current uid AND != root) is
 * rejected, and a `realpath` escape from `extensionsDir` (via symlink) is
 * rejected. Each rejection logs WHY and skips the candidate; the loader
 * continues with the rest.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { createExtensionSdkJiti, type ExtensionSdkJiti } from "./sdk-alias.js";
import type { BrigadeModule, BrigadeModuleManifest } from "./types.js";

const log = createSubsystemLogger("extensions/discovery");

// A user module whose top-level module init hangs (e.g. a stray top-level
// `await`) must not wedge a turn or boot. Cap each import; a slow one is
// logged + skipped (the import keeps running detached but we move on).
const IMPORT_TIMEOUT_MS = 5_000;

// Single Jiti instance shared across every candidate (per process). It carries
// the SDK alias (`brigade/extension-sdk` / `brigade/channel-sdk` → Brigade's own
// built entries) and the TypeScript transpile config. Created lazily so the cost
// is only paid when at least one user module is actually imported.
let sharedJiti: ExtensionSdkJiti | null = null;
function getExtensionJiti(): ExtensionSdkJiti {
	sharedJiti ??= createExtensionSdkJiti(import.meta.url);
	return sharedJiti;
}

/**
 * Import a candidate through the shared Jiti instance (applies the SDK alias +
 * TS transpile), racing against `IMPORT_TIMEOUT_MS`. Jiti takes an absolute file
 * path (not a `file://` URL), and resolves `.ts`/`.mts`/`.js` itself.
 */
function importWithTimeout(absPath: string): Promise<unknown> {
	return Promise.race([
		getExtensionJiti().import(absPath),
		new Promise((_, reject) => {
			const t = setTimeout(() => reject(new Error(`import timed out after ${IMPORT_TIMEOUT_MS}ms`)), IMPORT_TIMEOUT_MS);
			t.unref?.();
		}),
	]);
}

/** A discovered module plus where it came from (for conflict reporting + reload). */
export interface DiscoveredModule {
	module: BrigadeModule;
	/**
	 * Where the module came from. Today discovery only walks the user dir
	 * (`~/.brigade/extensions/`), so the value is always `"user"` from here;
	 * the loader tags bundled-in-tree modules with `"bundled"` when it
	 * merges them. The field is fixed at the discovery layer so downstream
	 * tracing (activation logs, conflict reports) always has provenance.
	 */
	origin: "user" | "bundled";
	/** Absolute path the module was imported from. */
	source: string;
	/**
	 * Module manifest, when the module exported one. Surfaces capability
	 * metadata WITHOUT requiring the module's `register` to run; informational
	 * today, consumed by the future discovery planner.
	 */
	manifest?: BrigadeModuleManifest;
}

/** Duck-type check: a value is a usable BrigadeModule. */
function isModule(value: unknown): value is BrigadeModule {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as BrigadeModule).id === "string" &&
		typeof (value as BrigadeModule).register === "function"
	);
}

/** Duck-type check for a BrigadeModuleManifest carried on a module export. */
function isManifest(value: unknown): value is BrigadeModuleManifest {
	return !!value && typeof value === "object" && typeof (value as BrigadeModuleManifest).id === "string";
}

// Accepted top-level / index entry extensions. `.d.ts` is excluded explicitly
// in `isCandidateFile` — it is a declaration file, never an importable module.
const ENTRY_EXTENSIONS = [".js", ".mjs", ".ts", ".mts"] as const;

// Directory index basenames, in PRECEDENCE order. When a folder ships more than
// one (e.g. both a precompiled `index.js` and a source `index.ts`), the FIRST
// match here wins — compiled (`.js`/`.mjs`) is preferred over source
// (`.ts`/`.mts`) so a built artifact takes precedence over its own source, and
// the runtime stays deterministic regardless of readdir order.
const DIR_INDEX_BASENAMES = ["index.js", "index.mjs", "index.ts", "index.mts"] as const;

/** Is `name` an importable top-level entry file? Accepts the entry extensions
 *  but rejects `.d.ts` declaration files. */
function isCandidateFile(name: string): boolean {
	if (name.endsWith(".d.ts")) return false;
	return ENTRY_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Resolve the import entry for a directory candidate
 *  (index.{js,mjs,ts,mts}). Picks the first present per DIR_INDEX_BASENAMES
 *  precedence (compiled before source). */
function dirEntry(dir: string): string | null {
	for (const name of DIR_INDEX_BASENAMES) {
		const candidate = path.join(dir, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* not present */
		}
	}
	return null;
}

/**
 * POSIX safety gate. Returns `null` when the candidate passes; otherwise a
 * short reason string that the caller logs + uses to skip the candidate.
 *
 * Skipped entirely on Windows (`process.platform === "win32"`) — the POSIX
 * mode/uid bits don't carry meaning there. Brigade ships to Windows, so this
 * gate must never break that platform.
 *
 * Three checks (all non-Windows):
 *   1. world-writable bit (`mode & 0o002`) — anyone could drop code in.
 *   2. ownership: file owned by someone other than the current user AND not
 *      root. Avoids loading code planted by a different unprivileged account.
 *   3. realpath escape: `realpath(candidate)` must stay under
 *      `realpath(extensionsDir)`. A symlink that points outside the dir
 *      (e.g. → `/etc/something.js`) is rejected.
 *
 * `platformOverride` is a test seam — callers normally omit it.
 */
export function checkPosixSafety(
	candidate: string,
	extensionsDir: string,
	platformOverride?: NodeJS.Platform,
): string | null {
	const platform = platformOverride ?? process.platform;
	if (platform === "win32") return null;

	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(candidate);
	} catch (err) {
		return `stat failed: ${err instanceof Error ? err.message : String(err)}`;
	}

	// (1) world-writable bit — anyone could drop code in.
	if ((st.mode & 0o002) !== 0) {
		return `world-writable (mode=${(st.mode & 0o777).toString(8)})`;
	}

	// (2) ownership — file owned by someone other than the current uid AND
	// not root. We can't enforce this in environments where getuid is not
	// available (Windows: handled above; non-POSIX runtimes: skip).
	const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (currentUid !== undefined && st.uid !== currentUid && st.uid !== 0) {
		return `suspicious ownership (uid=${st.uid}, currentUid=${currentUid})`;
	}

	// (3) realpath escape — symlinks must not point outside extensionsDir.
	try {
		const realCandidate = realpathSync(candidate);
		const realExtDir = realpathSync(extensionsDir);
		const rel = path.relative(realExtDir, realCandidate);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			return `symlink escape (resolves to ${realCandidate}, outside ${realExtDir})`;
		}
	} catch (err) {
		return `realpath failed: ${err instanceof Error ? err.message : String(err)}`;
	}

	return null;
}

/** List candidate entry files under the extensions dir (files + folder index entries). */
function candidateEntries(extensionsDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(extensionsDir);
	} catch {
		return []; // dir absent — nothing to discover (the common case)
	}
	const entries: string[] = [];
	for (const name of names) {
		if (name.startsWith(".")) continue; // dotfiles / hidden
		const full = path.join(extensionsDir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isFile() && isCandidateFile(name)) {
			entries.push(full);
		} else if (st.isDirectory()) {
			const entry = dirEntry(full);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

// Process-lifetime cache keyed by dir. The per-turn agent path and the gateway
// both call discovery; without this they'd readdir+stat (and re-run the import
// resolution) on every turn. Node already caches the dynamic imports themselves;
// this avoids the filesystem walk. Cleared by `clearDiscoveryCache()` on reload.
const discoveryCache = new Map<string, DiscoveredModule[]>();

/**
 * Public lister — returns the candidate sources under `extensionsDir` with
 * each one's safety verdict, WITHOUT importing them. Useful for diagnostic
 * surfaces (`brigade doctor`, the storage layer's listSources) that need
 * to know what *would* load and whether the file passes the safety gate.
 *
 * Each entry's `safetyReason` is `null` when the candidate passed the
 * POSIX safety gate; a non-null string surfaces the rejection reason.
 */
export function listExtensionSources(
	extensionsDir: string,
): ReadonlyArray<{ source: string; kind: "file" | "dir-index"; safetyReason: string | null }> {
	const out: Array<{ source: string; kind: "file" | "dir-index"; safetyReason: string | null }> = [];
	for (const source of candidateEntries(extensionsDir)) {
		const safetyReason = checkPosixSafety(source, extensionsDir);
		// `candidateEntries` returns the absolute path; for dir-style entries
		// that path points at the chosen `dirEntry` (the dir's resolved entry
		// file, e.g. `<dir>/index.js`). The shape lets the caller surface
		// "module folder X resolved to file Y" diagnostics without us baking
		// in the formatting.
		let kind: "file" | "dir-index" = "file";
		try {
			const st = statSync(source);
			if (st.isDirectory()) kind = "dir-index";
		} catch {
			// Already-stat'd by candidateEntries; if it's gone now treat as file.
		}
		out.push({ source, kind, safetyReason });
	}
	return out;
}

/** Does the extensions dir exist? Plain `fs.existsSync` lift so callers don't
 *  need to re-derive the path. */
export function extensionsRootExists(extensionsDir: string): boolean {
	return existsSync(extensionsDir);
}

/** Drop the discovery cache so the next `discoverUserModules` re-scans (reload).
 *  Also drops the shared Jiti instance so a reloaded module is re-transpiled
 *  fresh rather than served from Jiti's own module cache. */
export function clearDiscoveryCache(): void {
	discoveryCache.clear();
	sharedJiti = null;
}

/**
 * Per-candidate import outcome used by the diagnostic surfaces
 * (`brigade extensions list` / `doctor`). Reports — WITHOUT mutating any
 * registry — whether a single candidate file imports cleanly and exports a
 * usable module.
 */
export interface CandidateImportResult {
	/** The candidate imported without throwing (or timing out). */
	imported: boolean;
	/** A usable BrigadeModule was found on the default/module export. */
	hasValidModule: boolean;
	/** The discovered module's declared id, when one was found. */
	moduleId?: string;
	/** Failure detail when `imported` is false (timeout / transpile / throw). */
	error?: string;
}

/**
 * Import a single candidate the same way `discoverUserModules` does — through
 * the shared SDK-alias + TypeScript Jiti instance, time-boxed — and report what
 * came back, without recording anything into a registry. This is the engine
 * behind `brigade extensions doctor`'s "did my plugin import + export a module?"
 * diagnosis. Callers run `checkPosixSafety` FIRST; this only runs for a
 * candidate that passed the safety gate.
 */
export async function importCandidateForDiagnosis(source: string): Promise<CandidateImportResult> {
	try {
		const imported = (await importWithTimeout(source)) as { default?: unknown; module?: unknown };
		const exported = imported.default ?? imported.module;
		const candidates = Array.isArray(exported) ? exported : [exported];
		const firstModule = candidates.find((c) => isModule(c)) as BrigadeModule | undefined;
		if (firstModule) {
			return { imported: true, hasValidModule: true, moduleId: firstModule.id };
		}
		return { imported: true, hasValidModule: false };
	} catch (err) {
		return {
			imported: false,
			hasValidModule: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Discover + import user modules from `extensionsDir`. Returns the loaded
 * modules (shape-validated). Errors per candidate are logged and skipped.
 * Cached per dir for the process lifetime (see `clearDiscoveryCache`).
 */
export async function discoverUserModules(extensionsDir: string): Promise<DiscoveredModule[]> {
	const cached = discoveryCache.get(extensionsDir);
	if (cached) return cached;
	// Do NOT cache the absent-dir case — otherwise a user who creates the dir +
	// drops a module AFTER boot stays invisible until a reload. Re-checking an
	// absent dir each turn is one cheap stat. Once the dir exists we cache.
	if (!existsSync(extensionsDir)) return [];
	const out: DiscoveredModule[] = [];
	for (const source of candidateEntries(extensionsDir)) {
		// POSIX safety gate — runs BEFORE the import so a malicious world-
		// writable or symlink-escape candidate never executes its top-level.
		const safetyReason = checkPosixSafety(source, extensionsDir);
		if (safetyReason) {
			log.warn("rejected user extension — POSIX safety check failed", {
				source,
				reason: safetyReason,
			});
			continue;
		}
		try {
			const imported = (await importWithTimeout(source)) as {
				default?: unknown;
				module?: unknown;
				manifest?: unknown;
			};
			const exported = imported.default ?? imported.module;
			const candidates = Array.isArray(exported) ? exported : [exported];
			// A module may carry `manifest` either as a top-level named export OR
			// as a field on the module object itself. Prefer the top-level form
			// (matches the documented authoring shape); fall back to the module
			// field for compactness.
			const topLevelManifest = isManifest(imported.manifest) ? imported.manifest : undefined;
			for (const c of candidates) {
				if (isModule(c)) {
					const manifest =
						topLevelManifest ??
						(isManifest((c as BrigadeModule).manifest) ? (c as BrigadeModule).manifest : undefined);
					out.push({ module: c, origin: "user", source, manifest });
				} else {
					log.warn("ignored user extension — no default BrigadeModule export", { source });
				}
			}
		} catch (err) {
			log.warn("failed to import user extension — skipping", {
				source,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	discoveryCache.set(extensionsDir, out);
	return out;
}
