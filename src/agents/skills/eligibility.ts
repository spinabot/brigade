/**
 * Skill eligibility — the filter Pi's loader does NOT provide.
 *
 * Pi's `loadSkillsFromDir` discovers + validates skills (name, description,
 * disable-model-invocation) but has no notion of "only on macOS" or "only when
 * `gh` is installed". A skill that lists API endpoints for a CLI the user
 * doesn't have, or workflows for the wrong OS, is noise in the prompt at best
 * and misleading at worst. So Brigade reads a small set of Brigade-native
 * eligibility keys from each SKILL.md frontmatter and excludes skills that
 * can't run here BEFORE they reach the prompt.
 *
 * Eligibility is read from the SKILL.md YAML frontmatter, in EITHER of two
 * shapes (the frontmatter is parsed with a real YAML parser, so block lists,
 * flow lists, and comma-separated scalars all work — and a YAML formatter
 * reformatting the file can't silently break it):
 *
 *   1. Nested `metadata.brigade` block (how ported skills carry it — preserves
 *      the upstream metadata structure incl. install specs verbatim):
 *        metadata:
 *          { "brigade": { "os": ["darwin"], "requires": { "bins": ["gh"] } } }
 *
 *   2. Flat top-level keys (the simplest form, taught by the skill-creator skill
 *      for hand-authored skills):
 *        os: macos, linux, windows
 *        requires-bins: gh
 *        requires-any-bins: rg, grep
 *        requires-env: GITHUB_TOKEN
 *
 * `metadata.brigade` takes precedence per-field; flat keys fill in anything it
 * doesn't set. Semantics (all must pass): `os` — current platform must be in the
 * list (when present); `requires-bins` — every binary on PATH; `requires-any-bins`
 * — at least one on PATH; `requires-env` — every env var set & non-empty. A skill
 * declaring none of these is always eligible.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import YAML from "yaml";

/** Parsed Brigade eligibility metadata from a SKILL.md frontmatter block. */
export interface SkillEligibility {
	/** Allowed platforms (node `process.platform` values). Empty → any OS. */
	os: string[];
	/** Binaries that must ALL be on PATH. */
	requiresBins: string[];
	/** Binaries of which at least ONE must be on PATH. */
	requiresAnyBins: string[];
	/** Env vars that must ALL be set & non-empty. */
	requiresEnv: string[];
	/**
	 * Dotted config paths that must ALL resolve to truthy values in the active
	 * `brigade.json`. Patterned on the reference messaging-stack's same field:
	 * a `bluebubbles` skill (iMessage) declares `requires.config: ["channels.bluebubbles"]`
	 * and is hidden from the prompt entirely when the operator has WhatsApp
	 * but not BlueBubbles configured. Without this, the model sees skills it
	 * can't actually use and goes off-rails trying to invoke them.
	 *
	 * Truthy semantics for the resolved value:
	 *   - object              → truthy when it has at least one key
	 *   - array               → truthy when non-empty
	 *   - string              → truthy when non-empty (after trim)
	 *   - boolean             → truthy when true
	 *   - number              → truthy when non-zero
	 *   - null / undefined    → falsy
	 *
	 * Empty array → no constraint (eligible regardless of config).
	 */
	requiresConfig: string[];
}

/** Friendly OS name → node `process.platform`. Unknown names pass through. */
const OS_ALIASES: Record<string, string> = {
	macos: "darwin",
	mac: "darwin",
	osx: "darwin",
	darwin: "darwin",
	linux: "linux",
	windows: "win32",
	win: "win32",
	win32: "win32",
};

function normalizeOs(token: string): string {
	const key = token.trim().toLowerCase();
	return OS_ALIASES[key] ?? key;
}

/**
 * Coerce a parsed YAML value into a clean string-token list. Handles every
 * shape eligibility values legitimately take: a YAML sequence (block or flow)
 * → array of strings; a comma-separated scalar (`gh, jq`) → split; a single
 * scalar (`gh`) → one token. Non-strings are dropped.
 */
function toStrList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
	}
	if (typeof value === "string") {
		return value.split(",").map((s) => s.trim()).filter(Boolean);
	}
	return [];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Extract the leading `---`-fenced frontmatter block of a file as raw text.
 * Returns "" when there's no well-formed leading block. Tolerant of a leading
 * BOM and CRLF line endings.
 */
export function extractFrontmatterBlock(content: string): string {
	const text = content.replace(/^﻿/, "");
	// Must open with `---` on the very first line.
	const open = text.match(/^---[ \t]*\r?\n/);
	if (!open) return "";
	const rest = text.slice(open[0].length);
	const close = rest.search(/\r?\n---[ \t]*(\r?\n|$)/);
	if (close === -1) return "";
	return rest.slice(0, close);
}

/**
 * Parse the Brigade eligibility out of a YAML frontmatter block. Reads the
 * nested `metadata.brigade.{os, requires.{bins,anyBins,env}}` block first (the
 * faithful ported form), then fills any unset field from the flat top-level
 * keys (`os` / `requires-bins` / `requires-any-bins` / `requires-env`). Parsed
 * with a real YAML parser, so block lists, flow lists `[a, b]` (incl. trailing
 * commas), and comma-separated scalars all work. Never throws.
 */
export function parseEligibility(frontmatter: string): SkillEligibility {
	const out: SkillEligibility = {
		os: [],
		requiresBins: [],
		requiresAnyBins: [],
		requiresEnv: [],
		requiresConfig: [],
	};
	let doc: unknown;
	try {
		doc = YAML.parse(frontmatter);
	} catch {
		return out; // malformed frontmatter → no constraints (eligible)
	}
	const fm = asObject(doc);
	if (!fm) return out;

	// 1. Nested metadata.brigade — the ported upstream block (preserves install
	//    specs etc. verbatim). Takes precedence per-field.
	const brigadeMeta = asObject(asObject(fm.metadata)?.brigade);
	if (brigadeMeta) {
		out.os = toStrList(brigadeMeta.os).map(normalizeOs);
		const req = asObject(brigadeMeta.requires);
		if (req) {
			out.requiresBins = toStrList(req.bins);
			out.requiresAnyBins = toStrList(req.anyBins);
			out.requiresEnv = toStrList(req.env);
			out.requiresConfig = toStrList(req.config);
		}
	}

	// 2. Flat top-level keys — the hand-authored form; fills anything unset above.
	if (out.os.length === 0) out.os = toStrList(fm.os).map(normalizeOs);
	if (out.requiresBins.length === 0) out.requiresBins = toStrList(fm["requires-bins"]);
	if (out.requiresAnyBins.length === 0) out.requiresAnyBins = toStrList(fm["requires-any-bins"]);
	if (out.requiresEnv.length === 0) out.requiresEnv = toStrList(fm["requires-env"]);
	if (out.requiresConfig.length === 0) out.requiresConfig = toStrList(fm["requires-config"]);
	return out;
}

/** Read + parse a SKILL.md file's eligibility. Missing/unreadable file → empty (eligible). */
export function readSkillEligibility(filePath: string): SkillEligibility {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return {
			os: [],
			requiresBins: [],
			requiresAnyBins: [],
			requiresEnv: [],
			requiresConfig: [],
		};
	}
	return parseEligibility(extractFrontmatterBlock(content));
}

/**
 * Resolve a dotted path like `"channels.whatsapp"` against a config object and
 * test for truthy presence. Lifted from the reference implementation's
 * `isConfigPathTruthy` shape, brand-scrubbed. Used to hide skills that
 * declare `requires.config: ["channels.whatsapp"]` when the operator has no
 * whatsapp section in brigade.json. Returns `false` on any traversal failure
 * (missing intermediate key, null path) — "if the config has nothing there,
 * the skill is ineligible".
 */
export function isConfigPathTruthy(
	config: unknown,
	dottedPath: string,
): boolean {
	const segments = dottedPath.split(".").map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return false;
	let cursor: unknown = config;
	for (const segment of segments) {
		if (cursor === null || typeof cursor !== "object") return false;
		cursor = (cursor as Record<string, unknown>)[segment];
		if (cursor === undefined) return false;
	}
	// Truthy resolution — see SkillEligibility.requiresConfig doc-comment.
	if (cursor === null || cursor === undefined) return false;
	if (typeof cursor === "string") return cursor.trim().length > 0;
	if (typeof cursor === "number") return cursor !== 0;
	if (typeof cursor === "boolean") return cursor;
	if (Array.isArray(cursor)) return cursor.length > 0;
	if (typeof cursor === "object") {
		return Object.keys(cursor as Record<string, unknown>).length > 0;
	}
	return Boolean(cursor);
}

/* ───────────────────────── binary lookup ───────────────────────── */

const binaryCache = new Map<string, boolean>();

/** Windows executable extensions to probe when PATHEXT isn't set. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * True when `name` resolves to an executable on PATH. Cross-platform: on
 * Windows it honours PATHEXT (so `gh` matches `gh.exe`). Result cached per
 * process — binaries don't appear/disappear within a single run.
 */
export function hasBinary(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!name) return false;
	const pathValue = env.PATH ?? env.Path ?? "";
	// Key the cache on name + PATH: the answer depends on PATH, and the
	// injectable `env` seam (tests, future multi-env) must not get a stale hit
	// from a different PATH. In the normal single-env case the key is constant.
	const cacheKey = `${name}\x00${pathValue}`;
	const cached = binaryCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const dirs = pathValue.split(path.delimiter).filter((d) => d.length > 0);
	const isWindows = process.platform === "win32";
	const exts = isWindows
		? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").map((e) => e.trim()).filter(Boolean)
		: [""];

	let found = false;
	outer: for (const dir of dirs) {
		// An explicit extension already on the name (e.g. "node.exe") shouldn't
		// be double-suffixed; probe it bare first on every platform.
		const candidates = isWindows ? ["", ...exts] : [""];
		for (const ext of candidates) {
			const candidate = path.join(dir, name + ext);
			try {
				if (fs.statSync(candidate).isFile()) {
					found = true;
					break outer;
				}
			} catch {
				/* not here; keep looking */
			}
		}
	}
	binaryCache.set(cacheKey, found);
	return found;
}

/** Reset the binary lookup cache (tests). */
export function clearBinaryCache(): void {
	binaryCache.clear();
}

/* ───────────────────────── eligibility decision ───────────────────────── */

export interface EligibilityEnv {
	platform: string;
	env: NodeJS.ProcessEnv;
	/**
	 * Active `brigade.json` snapshot. When provided, `requires.config` paths
	 * are evaluated against it; when omitted, config-gated skills are
	 * conservatively allowed (so unit tests without a real config don't have
	 * to mock one). Callers that want the prompt to actually hide the
	 * channel-gated skills MUST pass the real config.
	 */
	config?: unknown;
}

/**
 * Evaluate whether a skill is eligible to run in this environment. Pure given
 * the injected `platform`/`env` (binary lookup reads PATH from `env`), so it's
 * deterministic in tests.
 */
export function isSkillEligible(
	meta: SkillEligibility,
	ctx: EligibilityEnv = { platform: process.platform, env: process.env },
): boolean {
	if (meta.os.length > 0 && !meta.os.includes(ctx.platform)) return false;
	for (const bin of meta.requiresBins) {
		if (!hasBinary(bin, ctx.env)) return false;
	}
	if (meta.requiresAnyBins.length > 0) {
		if (!meta.requiresAnyBins.some((bin) => hasBinary(bin, ctx.env))) return false;
	}
	for (const key of meta.requiresEnv) {
		const v = ctx.env[key];
		if (!v || v.trim().length === 0) return false;
	}
	// `requires.config` — channel-gated skills (e.g. bluebubbles needs an
	// iMessage adapter configured). When no config snapshot is provided, the
	// constraint is conservatively skipped — the prompt assembler is where
	// the real config gets passed; tests that don't care about config-gating
	// don't need to mock one.
	if (meta.requiresConfig.length > 0 && ctx.config !== undefined) {
		for (const dottedPath of meta.requiresConfig) {
			if (!isConfigPathTruthy(ctx.config, dottedPath)) return false;
		}
	}
	return true;
}
