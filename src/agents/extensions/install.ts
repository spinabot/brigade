/**
 * Extension install / remove engine — the source-agnostic machinery behind
 * `brigade extensions add <source>` and `brigade extensions remove <id>`.
 *
 * `add` brings a third-party module into `~/.brigade/extensions/<id>/` from one
 * of three source forms:
 *   • a LOCAL PATH (a folder or a single file) → copied in;
 *   • an NPM SPEC (`name`, `name@version`, `@scope/name@1.2.3`) → fetched with
 *     `npm pack` into a temp dir, unpacked, and moved in (npm only — never pnpm);
 *   • a GIT URL (`https://…/repo.git`, `git@…`, `git+…`) → cloned in.
 *
 * The installed module's id is resolved from its `brigade.extension.json`
 * manifest id, else its `package.json` name, else the source basename. An
 * existing id is refused unless `force` is set.
 *
 * After the files land, two read-only gates run:
 *   1. COMPAT — read the installed manifest and compare `minBrigadeVersion` /
 *      `pluginApi` against the running build. A module that needs a NEWER
 *      Brigade is refused (the only hard failure here); a missing field is
 *      lenient (compatible).
 *   2. SCAN — `install-scan.ts` does a static dual-use pattern sweep. Findings
 *      are SURFACED, never auto-blocking; the CLI asks the operator to ack.
 *
 * This module does the filesystem + compat work and RETURNS a structured result;
 * the CLI layer (`commands/extensions.ts`) owns all rendering + the interactive
 * scan acknowledgement. Keeping the two apart lets the install logic be unit-
 * tested against a tempdir source with no TTY + no network.
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getBuildInfo } from "../../version.js";
import { scanInstalledModule, type ScanReport } from "./install-scan.js";
import type { BrigadeModuleManifest } from "./types.js";

const SIDECAR_BASENAME = "brigade.extension.json";

/** Which kind of source `add` resolved the argument to. */
export type InstallSourceKind = "local" | "npm" | "git";

/** Verdict from the compat (version) gate. */
export interface CompatVerdict {
	/** True when the module is safe to run on this Brigade build. */
	compatible: boolean;
	/** Running Brigade version (for display). */
	brigadeVersion: string;
	/** The module's declared minimum Brigade version, when it set one. */
	minBrigadeVersion?: string;
	/** The module's declared plugin-API generation, when it set one. */
	pluginApi?: string;
	/** One operator-facing line — why it's (in)compatible. */
	reason: string;
}

/** Everything the CLI needs to render a completed install. */
export interface InstallResult {
	/** Resolved extension id (the folder name under the extensions dir). */
	id: string;
	/** Absolute folder the module landed in. */
	dir: string;
	/** How the source argument was classified. */
	sourceKind: InstallSourceKind;
	/** The original source argument, echoed back. */
	source: string;
	/** Installed manifest, when the module shipped a sidecar. */
	manifest?: BrigadeModuleManifest;
	/** Compat (version) verdict. */
	compat: CompatVerdict;
	/** Static security-scan report. */
	scan: ScanReport;
	/** True when `--force` overwrote a pre-existing extension of the same id. */
	replacedExisting: boolean;
}

/** A thrown install failure carrying an operator-facing message. */
export class InstallError extends Error {}

/* ─────────────────────────── plugin-API generation ─────────────────────────── */

/**
 * The plugin-API generation THIS Brigade build implements. Bumped only on a
 * breaking change to the module/SDK contract. A module whose manifest
 * `pluginApi` is a higher integer than this targets a future Brigade and is
 * refused by the compat gate.
 */
export const CURRENT_PLUGIN_API = 1;

/* ─────────────────────────── source classification ─────────────────────────── */

/** Does the argument look like a git URL we should clone? */
function isGitUrl(source: string): boolean {
	return (
		/^git\+/.test(source) ||
		/^git@/.test(source) ||
		/^(?:https?|git|ssh):\/\/.*\.git(?:#.*)?$/.test(source) ||
		/^(?:https?:\/\/)?(?:www\.)?(?:github|gitlab|bitbucket)\.com\/[^/]+\/[^/]+/.test(source)
	);
}

/**
 * Classify the source argument. A path that exists on disk is always `local`
 * (so a folder literally named like a package still installs from disk); then
 * git URLs; then everything else is treated as an npm spec.
 */
export function classifySource(source: string): InstallSourceKind {
	const trimmed = source.trim();
	if (trimmed.length === 0) throw new InstallError("No source given. Pass a folder, a file, an npm package, or a git URL.");
	// An on-disk path always wins — unambiguous + offline.
	try {
		if (existsSync(trimmed)) return "local";
	} catch {
		/* fall through to remote classification */
	}
	// Explicit relative/absolute path markers that don't (yet) exist → still local
	// (the install step then reports "no such file" clearly rather than trying npm).
	if (/^[.~]/.test(trimmed) || path.isAbsolute(trimmed)) return "local";
	if (isGitUrl(trimmed)) return "git";
	return "npm";
}

/* ─────────────────────────── manifest + id resolution ─────────────────────────── */

/** Read + parse a JSON file, returning `undefined` on any failure. */
function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Find + read the sidecar manifest at the root of an installed/extracted module. */
function readManifestAt(dir: string): BrigadeModuleManifest | undefined {
	const sidecar = path.join(dir, SIDECAR_BASENAME);
	const parsed = readJson(sidecar);
	if (parsed && typeof parsed.id === "string") return parsed as unknown as BrigadeModuleManifest;
	return undefined;
}

/** Read a `package.json` `name` at the root of a module, when present. */
function readPackageName(dir: string): string | undefined {
	const parsed = readJson(path.join(dir, "package.json"));
	const name = parsed?.name;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Strip an npm scope + version range to a bare, folder-safe id. */
function bareNameFromSpec(spec: string): string {
	// `@scope/name@1.2.3` → `name`; `name@^2` → `name`; `name` → `name`.
	let s = spec.trim();
	// Drop a trailing version range (the LAST `@` that isn't the scope `@`).
	const at = s.lastIndexOf("@");
	if (at > 0) s = s.slice(0, at);
	// Drop the scope prefix.
	if (s.startsWith("@")) {
		const slash = s.indexOf("/");
		if (slash >= 0) s = s.slice(slash + 1);
	}
	return s;
}

/** Strip a git URL down to its repo basename (sans `.git` + fragment). */
function repoNameFromGit(url: string): string {
	let s = url.trim().replace(/^git\+/, "");
	s = s.split("#")[0] ?? s; // drop a `#branch` fragment
	s = s.replace(/\/+$/, ""); // trailing slashes
	const last = s.split(/[/:]/).pop() ?? s;
	return last.replace(/\.git$/i, "");
}

/**
 * Normalise an arbitrary string into a safe extensions-folder id: lowercase,
 * `[a-z0-9-]`, no leading digit-only weirdness. Mirrors the `init` id rules
 * loosely (we accept what we can sanitise rather than reject).
 */
export function sanitizeId(raw: string): string {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned;
}

/**
 * Resolve the target id for an extracted/staged module: manifest id wins, then
 * package.json name, then the supplied `fallback` (source basename). All run
 * through `sanitizeId`.
 */
export function resolveModuleId(stagedDir: string, fallback: string): string {
	const manifest = readManifestAt(stagedDir);
	if (manifest?.id) {
		const id = sanitizeId(manifest.id);
		if (id) return id;
	}
	const pkgName = readPackageName(stagedDir);
	if (pkgName) {
		const id = sanitizeId(bareNameFromSpec(pkgName));
		if (id) return id;
	}
	const id = sanitizeId(fallback);
	if (id) return id;
	throw new InstallError("Couldn't work out a name for this extension. Give it one by adding a brigade.extension.json with an \"id\".");
}

/* ─────────────────────────── compat (version) gate ─────────────────────────── */

/** Parse a leading `major.minor.patch` from a version string → numeric tuple. */
function parseSemverLead(v: string): [number, number, number] | null {
	const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
	if (!m) return null;
	return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Compare two semver leads: -1 / 0 / 1. */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av !== bv) return av < bv ? -1 : 1;
	}
	return 0;
}

/**
 * Decide whether a module (by its manifest) is compatible with the running
 * Brigade. Lenient by design: a module that declares neither field is always
 * compatible. The two hard-fail cases are forward-incompatibility — the module
 * needs a NEWER Brigade than this build, or targets a NEWER plugin-API
 * generation than this build implements.
 *
 * `brigadeVersionOverride` / `pluginApiOverride` are test seams.
 */
export function checkCompat(
	manifest: BrigadeModuleManifest | undefined,
	brigadeVersionOverride?: string,
	pluginApiOverride?: number,
): CompatVerdict {
	const brigadeVersion = brigadeVersionOverride ?? getBuildInfo().version;
	const currentApi = pluginApiOverride ?? CURRENT_PLUGIN_API;
	const minBrigadeVersion = manifest?.minBrigadeVersion;
	const pluginApi = manifest?.pluginApi;

	// (1) plugin-API generation — a forward-incompatible module targets a newer
	// generation than this build understands.
	if (typeof pluginApi === "string" && pluginApi.trim().length > 0) {
		const wanted = Number.parseInt(pluginApi.trim(), 10);
		if (Number.isFinite(wanted) && wanted > currentApi) {
			return {
				compatible: false,
				brigadeVersion,
				minBrigadeVersion,
				pluginApi,
				reason: `This extension targets plugin API v${wanted}, but this Brigade only supports up to v${currentApi}. Update Brigade first.`,
			};
		}
	}

	// (2) minimum Brigade version — module needs a newer Brigade than is running.
	if (typeof minBrigadeVersion === "string" && minBrigadeVersion.trim().length > 0) {
		const need = parseSemverLead(minBrigadeVersion);
		const have = parseSemverLead(brigadeVersion);
		if (need && have && compareSemver(have, need) < 0) {
			return {
				compatible: false,
				brigadeVersion,
				minBrigadeVersion,
				pluginApi,
				reason: `This extension needs Brigade ${minBrigadeVersion} or newer; you're on ${brigadeVersion}. Update Brigade first.`,
			};
		}
	}

	return {
		compatible: true,
		brigadeVersion,
		minBrigadeVersion,
		pluginApi,
		reason: "Compatible with this version of Brigade.",
	};
}

/* ─────────────────────────── staging by source kind ─────────────────────────── */

/** Copy a local path (file OR folder) into a fresh staging dir; return it. */
function stageLocal(source: string, stageRoot: string): { stagedDir: string; fallbackName: string } {
	const abs = path.resolve(source.replace(/^~(?=$|[/\\])/, () => process.env.HOME ?? process.env.USERPROFILE ?? "~"));
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(abs);
	} catch {
		throw new InstallError(`No file or folder found at ${abs}.`);
	}
	const stagedDir = path.join(stageRoot, "staged");
	mkdirSync(stagedDir, { recursive: true });
	if (st.isDirectory()) {
		cpSync(abs, stagedDir, { recursive: true });
		return { stagedDir, fallbackName: path.basename(abs) };
	}
	// Single file → place it as the module's index, preserving its extension.
	const ext = path.extname(abs) || ".js";
	const indexName = `index${ext}`;
	cpSync(abs, path.join(stagedDir, indexName));
	return { stagedDir, fallbackName: path.basename(abs, ext) };
}

/** Run a command, surfacing a clean error. `cwd` defaults to the stage root. */
function runTool(cmd: string, args: string[], cwd: string): void {
	try {
		execFileSync(cmd, args, { cwd, stdio: "pipe", windowsHide: true });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new InstallError(`\`${cmd} ${args.join(" ")}\` failed: ${detail}`);
	}
}

/** Fetch an npm package via `npm pack`, unpack the tarball, return the dir. */
function stageNpm(spec: string, stageRoot: string): { stagedDir: string; fallbackName: string } {
	// `npm pack <spec>` downloads the tarball into cwd and prints its filename.
	let out: string;
	try {
		out = execFileSync("npm", ["pack", spec, "--silent"], {
			cwd: stageRoot,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			windowsHide: true,
		}).trim();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new InstallError(`Couldn't download "${spec}" from npm: ${detail}`);
	}
	// `npm pack` may print multiple lines; the tarball name is the last non-empty.
	const tarball = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
	if (!tarball) throw new InstallError(`npm didn't produce a package tarball for "${spec}".`);
	const tarballPath = path.join(stageRoot, tarball);
	const extractDir = path.join(stageRoot, "unpacked");
	mkdirSync(extractDir, { recursive: true });
	// Tarballs from `npm pack` always nest under a top-level `package/` dir.
	runTool("tar", ["-xzf", tarballPath, "-C", extractDir], stageRoot);
	const inner = path.join(extractDir, "package");
	const stagedDir = existsSync(inner) ? inner : extractDir;
	return { stagedDir, fallbackName: bareNameFromSpec(spec) };
}

/** Clone a git URL (shallow) into a staging dir; return it. */
function stageGit(url: string, stageRoot: string): { stagedDir: string; fallbackName: string } {
	const stagedDir = path.join(stageRoot, "cloned");
	const cleanUrl = url.replace(/^git\+/, "");
	runTool("git", ["clone", "--depth", "1", cleanUrl, stagedDir], stageRoot);
	// Drop the `.git` dir so it isn't carried into the extensions folder (and
	// doesn't trip the scanner's skip rules either way).
	try {
		rmSync(path.join(stagedDir, ".git"), { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
	return { stagedDir, fallbackName: repoNameFromGit(url) };
}

/* ─────────────────────────── install + remove ─────────────────────────── */

export interface InstallOptions {
	/** The extensions dir to install into (`~/.brigade/extensions` in prod). */
	extensionsDir: string;
	/** Overwrite an existing extension of the same id. */
	force?: boolean;
	/** Test seam — override the running Brigade version for the compat gate. */
	brigadeVersionOverride?: string;
	/** Test seam — override the plugin-API generation for the compat gate. */
	pluginApiOverride?: number;
}

/**
 * Install an extension from a source. Does NOT prompt — it stages, resolves the
 * id, refuses an existing id unless `force`, copies the module into place, then
 * runs the compat + scan gates and returns the structured result. The CLI layer
 * decides whether to keep it (e.g. after the operator acks the scan). The
 * compat gate is the one hard failure: a forward-incompatible module is
 * REMOVED again and an `InstallError` is thrown.
 */
export async function installExtension(source: string, opts: InstallOptions): Promise<InstallResult> {
	const sourceKind = classifySource(source);
	const stageRoot = mkdtempSync(path.join(tmpdir(), "brigade-ext-install-"));
	try {
		// 1. Stage the bytes into a temp dir based on the source kind.
		const staged =
			sourceKind === "local"
				? stageLocal(source, stageRoot)
				: sourceKind === "npm"
					? stageNpm(source, stageRoot)
					: stageGit(source, stageRoot);

		// 2. Resolve the id (manifest → package.json → basename).
		const id = resolveModuleId(staged.stagedDir, staged.fallbackName);

		// 3. Collision check.
		const targetDir = path.join(opts.extensionsDir, id);
		const exists = existsSync(targetDir);
		if (exists && !opts.force) {
			throw new InstallError(
				`An extension named "${id}" is already installed. Re-run with --force to replace it, or remove it first with \`brigade extensions remove ${id}\`.`,
			);
		}

		// 4. Copy the staged module into the extensions dir.
		mkdirSync(opts.extensionsDir, { recursive: true });
		if (exists) rmSync(targetDir, { recursive: true, force: true });
		cpSync(staged.stagedDir, targetDir, { recursive: true });

		// 5. Compat gate — the one hard failure. Roll back on incompatibility.
		const manifest = readManifestAt(targetDir);
		const compat = checkCompat(manifest, opts.brigadeVersionOverride, opts.pluginApiOverride);
		if (!compat.compatible) {
			rmSync(targetDir, { recursive: true, force: true });
			throw new InstallError(compat.reason);
		}

		// 6. Security scan — surfaced, never auto-blocking.
		const scan = scanInstalledModule(targetDir);

		return {
			id,
			dir: targetDir,
			sourceKind,
			source,
			manifest,
			compat,
			scan,
			replacedExisting: exists,
		};
	} finally {
		try {
			rmSync(stageRoot, { recursive: true, force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
}

/** Outcome of a remove. */
export interface RemoveResult {
	id: string;
	dir: string;
}

/**
 * Remove an installed extension by id. Refuses cleanly (throws `InstallError`)
 * when no extension of that id is installed. `id` is sanitised the same way
 * install resolves it, so `remove My-Plugin` matches the `my-plugin` folder.
 */
export function removeExtension(id: string, extensionsDir: string): RemoveResult {
	const safeId = sanitizeId(id);
	if (!safeId) throw new InstallError(`"${id}" isn't a valid extension name.`);
	const dir = path.join(extensionsDir, safeId);
	let isDir = false;
	try {
		isDir = statSync(dir).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) {
		throw new InstallError(`No extension named "${safeId}" is installed. Run \`brigade extensions list\` to see what you have.`);
	}
	rmSync(dir, { recursive: true, force: true });
	return { id: safeId, dir };
}

/** List installed extension ids (folder names) under the extensions dir. */
export function listInstalledIds(extensionsDir: string): string[] {
	try {
		return readdirSync(extensionsDir)
			.filter((name) => {
				if (name.startsWith(".")) return false;
				try {
					return statSync(path.join(extensionsDir, name)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}
