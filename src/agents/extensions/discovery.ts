/**
 * User-module discovery.
 *
 * Out-of-tree modules dropped into `~/.brigade/extensions/` are discovered and
 * dynamic-imported here, alongside the bundled ones. A candidate is either a
 * top-level `*.js`/`*.mjs` file or a folder containing `index.js`/`index.mjs`.
 * Each must `export default` a `BrigadeModule` (or an array of them); anything
 * else is skipped with a warning — a bad user module never aborts boot.
 *
 * Authors import the stable `@brigade/extension-sdk` surface (defineModule + the
 * capability contracts), so a user module never reaches into Brigade internals.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { BrigadeModule } from "./types.js";

const log = createSubsystemLogger("extensions/discovery");

// A user module whose top-level module init hangs (e.g. a stray top-level
// `await`) must not wedge a turn or boot. Cap each import; a slow one is
// logged + skipped (the import keeps running detached but we move on).
const IMPORT_TIMEOUT_MS = 5_000;

function importWithTimeout(href: string): Promise<unknown> {
	return Promise.race([
		import(href),
		new Promise((_, reject) => {
			const t = setTimeout(() => reject(new Error(`import timed out after ${IMPORT_TIMEOUT_MS}ms`)), IMPORT_TIMEOUT_MS);
			t.unref?.();
		}),
	]);
}

/** A discovered module plus where it came from (for conflict reporting + reload). */
export interface DiscoveredModule {
	module: BrigadeModule;
	origin: "user";
	/** Absolute path the module was imported from. */
	source: string;
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

/** Resolve the import entry for a directory candidate (index.js / index.mjs). */
function dirEntry(dir: string): string | null {
	for (const name of ["index.js", "index.mjs"]) {
		const candidate = path.join(dir, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* not present */
		}
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
		if (st.isFile() && (name.endsWith(".js") || name.endsWith(".mjs"))) {
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

/** Drop the discovery cache so the next `discoverUserModules` re-scans (reload). */
export function clearDiscoveryCache(): void {
	discoveryCache.clear();
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
		try {
			const imported = (await importWithTimeout(pathToFileURL(source).href)) as {
				default?: unknown;
				module?: unknown;
			};
			const exported = imported.default ?? imported.module;
			const candidates = Array.isArray(exported) ? exported : [exported];
			for (const c of candidates) {
				if (isModule(c)) {
					out.push({ module: c, origin: "user", source });
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
