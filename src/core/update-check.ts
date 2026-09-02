// Is a newer Brigade published?
//
// Answered on a background timer, never on the hot path. Three rules shape this:
//
//   1. It must NEVER fail a boot. Registry down, offline, proxy in the way, DNS
//      broken — every one of those resolves to "no update known", silently.
//   2. It must NEVER nag a source checkout. A `.git` + `src/` tree is a developer's
//      working copy; telling it to `npm i -g` is wrong and a little insulting.
//   3. It must NEVER act. It reports. The operator decides, because an update
//      restarts their gateway, and they may be mid-turn.
//
// The answer is cached so a gateway that restarts twenty times in an afternoon asks
// the registry once.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { isSourceCheckout, resolvePackageInfo } from "../cli/commands/update.js";

/** How long a registry answer stays fresh. A release is not an emergency. */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6h
/** The registry gets this long to answer before we shrug and move on. */
export const UPDATE_CHECK_TIMEOUT_MS = 3_000;
/** Set truthy to disable the check entirely. */
export const UPDATE_CHECK_OPT_OUT_ENV = "BRIGADE_NO_UPDATE_CHECK";

export interface UpdateStatus {
	current: string;
	latest: string;
}

interface CacheFile {
	checkedAt: number;
	latest: string;
}

export interface UpdateCheckDeps {
	/**
	 * Skip the cache READ and ask the registry now.
	 *
	 * For explicit operator commands only. The ambient boot/interval check must
	 * keep using the cache, or a restart loop becomes a registry hammer.
	 */
	force?: boolean;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	/** Resolve the published `latest` version, or undefined when unreachable. */
	fetchLatest?: (pkg: string, timeoutMs: number) => Promise<string | undefined>;
	readCache?: () => CacheFile | undefined;
	writeCache?: (c: CacheFile) => void;
	packageInfo?: { name: string; version: string; root: string };
	isSourceCheckout?: (root: string) => boolean;
}

/* ───────────────────────────── semver ───────────────────────────── */

interface Semver {
	major: number;
	minor: number;
	patch: number;
	/** A prerelease (`1.27.0-rc.1`) sorts BELOW its release. */
	pre: boolean;
}

/** Parse `1.26.1` / `v1.26.1` / `1.27.0-rc.1`. Undefined when it isn't semver. */
export function parseSemver(raw: string | undefined): Semver | undefined {
	if (typeof raw !== "string") return undefined;
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
	if (!m) return undefined;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] !== undefined,
	};
}

/**
 * Is `latest` strictly newer than `current`?
 *
 * Deliberately conservative: anything we cannot parse, and any prerelease, is not an
 * upgrade. A nag we cannot justify is worse than a missed one.
 */
export function isNewerVersion(latest: string | undefined, current: string | undefined): boolean {
	const l = parseSemver(latest);
	const c = parseSemver(current);
	if (!l || !c) return false;
	if (l.pre) return false; // never push someone onto an rc they didn't ask for
	if (l.major !== c.major) return l.major > c.major;
	if (l.minor !== c.minor) return l.minor > c.minor;
	if (l.patch !== c.patch) return l.patch > c.patch;
	// Same numbers: only an upgrade if we are ON a prerelease of it (1.27.0-rc.1 → 1.27.0).
	return c.pre;
}

/* ───────────────────────────── io ───────────────────────────── */

function cachePath(): string {
	return path.join(resolveStateDir(), "state", "update-check.json");
}

function defaultReadCache(): CacheFile | undefined {
	try {
		const p = cachePath();
		if (!existsSync(p)) return undefined;
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CacheFile>;
		if (typeof parsed?.checkedAt !== "number" || typeof parsed?.latest !== "string") return undefined;
		return { checkedAt: parsed.checkedAt, latest: parsed.latest };
	} catch {
		return undefined; // a corrupt cache is simply a cold cache
	}
}

function defaultWriteCache(c: CacheFile): void {
	try {
		const p = cachePath();
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(c), "utf8");
	} catch {
		/* a read-only home is not a reason to fail a boot */
	}
}

/** Ask the npm registry for `latest`. Resolves undefined on any failure. */
async function defaultFetchLatest(pkg: string, timeoutMs: number): Promise<string | undefined> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
	try {
		const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
			signal: ac.signal,
			headers: { accept: "application/vnd.npm.install-v1+json" },
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { version?: unknown };
		return typeof body?.version === "string" ? body.version : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/* ───────────────────────────── check ───────────────────────────── */

/**
 * Returns the update the operator could take, or undefined when there is none to
 * report — including every failure mode. Never throws.
 */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<UpdateStatus | undefined> {
	const env = deps.env ?? process.env;
	const optOut = env[UPDATE_CHECK_OPT_OUT_ENV]?.trim();
	if (optOut && optOut !== "0" && optOut.toLowerCase() !== "false") return undefined;

	const now = deps.now ?? (() => Date.now());
	const pkg = deps.packageInfo ?? resolvePackageInfo();
	const sourceCheckout = deps.isSourceCheckout ?? isSourceCheckout;

	// A developer's working tree updates with `git pull`, not `npm i -g`.
	if (sourceCheckout(pkg.root)) return undefined;

	const current = parseSemver(pkg.version);
	if (!current) return undefined;
	// `resolvePackageInfo()` falls back to 0.0.0 when it cannot find a package.json.
	// We do not know what this build is, so we are in no position to call it outdated.
	if (current.major === 0 && current.minor === 0 && current.patch === 0) return undefined;

	const readCache = deps.readCache ?? defaultReadCache;
	const writeCache = deps.writeCache ?? defaultWriteCache;

	let latest: string | undefined;
	// `force` SKIPS THE CACHE READ, for an operator who explicitly asked.
	//
	// The 6h TTL is right for the ambient check that rides every boot — it stops
	// a gateway restarted twenty times in an afternoon hammering the registry.
	// It is wrong for `/update` or `brigade update`, where someone has typed a
	// command to ask a question and gets a cached "you're on the latest" about a
	// release that shipped an hour ago. Observed exactly that: npm at 1.35.3,
	// the machine on 1.35.2, and the command reporting it was current.
	//
	// The write still happens either way, so a forced check refreshes the cache
	// for the ambient path rather than bypassing it twice.
	const cached = deps.force === true ? undefined : readCache();
	if (cached && now() - cached.checkedAt < UPDATE_CHECK_TTL_MS) {
		latest = cached.latest;
	} else {
		const fetchLatest = deps.fetchLatest ?? defaultFetchLatest;
		try {
			latest = await fetchLatest(pkg.name, UPDATE_CHECK_TIMEOUT_MS);
		} catch {
			latest = undefined; // belt: a custom fetcher that throws must not escape
		}
		// Only cache a real answer. Caching a failure would silence the next 6 hours.
		if (latest !== undefined) writeCache({ checkedAt: now(), latest });
	}

	if (!isNewerVersion(latest, pkg.version)) return undefined;
	return { current: pkg.version, latest: latest as string };
}

/**
 * What an update does NOT touch. Shown to the operator so the decision is informed:
 * the fear is "will this eat my work", and the answer is no.
 */
export const UPDATE_PRESERVES_MESSAGE =
	"Your sessions, memory, skills, agents and config live in ~/.brigade and are left exactly as they are.";
