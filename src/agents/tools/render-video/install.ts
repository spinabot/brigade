// Install the optional HyperFrames render engine where Brigade can actually find it.
//
// The engine is a plain npm library Brigade `require()`s — not a Brigade plugin, so
// `~/.brigade/extensions/` (manifests, `npm pack`, a scan step) is the wrong home.
//
// It goes in `~/.brigade/engines/`, and that directory gets its OWN `package.json`.
// That file is the whole point. Without it, `npm i @hyperframes/producer` run from
// anywhere under `~/.brigade` walks UP looking for a package.json, finds the
// operator's home directory, and installs there — leaving the package on disk in a
// place `resolveProducerEntry()` will never resolve. That is not hypothetical: it is
// what our own error message told an agent to do, and it did.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveEnginesDir } from "../../../config/paths.js";
import { HYPERFRAMES_PACKAGE, __resetRenderVideoAvailabilityCache, resolveProducerEntry } from "./availability.js";

/** Injected so tests never touch npm or the real `~/.brigade`. */
export type InstallRunner = (
	command: string,
	args: string[],
	opts: { cwd: string },
) => { code: number; stdout: string; stderr: string };

export interface InstallEngineResult {
	ok: boolean;
	/** Where the engine now resolves from, when `ok`. */
	entry?: string;
	/** The directory npm was pointed at. */
	dir: string;
	message: string;
}

/**
 * The manifest that pins npm to `~/.brigade/engines`.
 *
 * `private: true` so it can never be published by accident. No `dependencies` block:
 * npm writes the engine in itself, and hand-maintaining a mirror of it here would just
 * be a second source of truth to drift.
 */
function ensureEnginesManifest(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const manifest = path.join(dir, "package.json");
	if (existsSync(manifest)) {
		// Repair only if it stopped being valid JSON — never clobber a real one.
		try {
			JSON.parse(readFileSync(manifest, "utf8"));
			return;
		} catch {
			/* fall through and rewrite */
		}
	}
	writeFileSync(
		manifest,
		`${JSON.stringify(
			{
				name: "brigade-engines",
				version: "1.0.0",
				private: true,
				description:
					"Optional engines Brigade drives programmatically. Managed by `brigade video install` — not published, not a plugin.",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

/**
 * Install (or re-install) the render engine into Brigade's engines dir.
 *
 * Idempotent: an engine that already resolves is reported, not reinstalled, unless
 * `force`. Never throws — a failed install returns `ok: false` with npm's own output,
 * because "it didn't work and here is what npm said" beats a stack trace.
 */
export function installRenderEngine(
	opts: { force?: boolean; run: InstallRunner; enginesDir?: string },
): InstallEngineResult {
	const dir = opts.enginesDir ?? resolveEnginesDir();

	if (!opts.force) {
		const existing = resolveProducerEntry();
		if (existing) {
			return { ok: true, entry: existing, dir, message: `Render engine already installed — ${existing}` };
		}
	}

	try {
		ensureEnginesManifest(dir);
	} catch (err) {
		return { ok: false, dir, message: `Could not prepare ${dir}: ${err instanceof Error ? err.message : String(err)}` };
	}

	// `--no-save` would defeat the manifest; we WANT npm to record the dep there.
	// `--omit=dev` keeps the engine's own test tooling out of the operator's disk.
	const res = opts.run("npm", ["install", HYPERFRAMES_PACKAGE, "--omit=dev"], { cwd: dir });
	if (res.code !== 0) {
		const detail = (res.stderr || res.stdout || "").trim().split("\n").slice(-6).join("\n");
		return { ok: false, dir, message: `npm install failed in ${dir}\n${detail}` };
	}

	// The availability answer is cached with a TTL; a fresh install must be visible
	// immediately, not in five minutes.
	__resetRenderVideoAvailabilityCache();

	const entry = resolveProducerEntry();
	if (!entry) {
		return {
			ok: false,
			dir,
			message:
				`npm reported success but ${HYPERFRAMES_PACKAGE} still does not resolve from ${dir}. ` +
				"Check that npm installed into that directory and not a parent.",
		};
	}
	return { ok: true, entry, dir, message: `Render engine installed — ${entry}` };
}
