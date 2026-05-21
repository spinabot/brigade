// Single source of truth for the brigade package version + build identity.
// Build pipeline reads VERSION; the bin shim and CLI surface both reference it.
//
// The build stamp (`dist/buildstamp.json`, written by scripts/build-done.mjs in
// the postbuild hook) carries the git commit + build time, so `--version` and
// the gateway boot banner can report the EXACT build that's running — mirroring
// OpenClaw's `.buildstamp` → version surfacing. Reads are best-effort: in a dev
// source tree (no stamp) we fall back to the bare version string.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

export interface BuildInfo {
	version: string;
	/** Git commit SHA captured at build, when available. */
	head?: string;
	/** Build timestamp (epoch ms), when available. */
	builtAt?: number;
}

let cached: BuildInfo | undefined;

/**
 * Resolve the running build's identity. Reads `buildstamp.json` next to this
 * compiled module (`dist/buildstamp.json`); returns just the version when no
 * stamp is present (dev / unbuilt source tree). Cached after first read.
 */
export function getBuildInfo(): BuildInfo {
	if (cached) return cached;
	let head: string | undefined;
	let builtAt: number | undefined;
	try {
		const stampPath = join(dirname(fileURLToPath(import.meta.url)), "buildstamp.json");
		const parsed = JSON.parse(readFileSync(stampPath, "utf8")) as { head?: unknown; builtAt?: unknown };
		if (typeof parsed.head === "string" && parsed.head.length > 0) head = parsed.head;
		if (typeof parsed.builtAt === "number" && Number.isFinite(parsed.builtAt)) builtAt = parsed.builtAt;
	} catch {
		// No stamp — bare version.
	}
	cached = { version: VERSION, head, builtAt };
	return cached;
}

/**
 * Human-readable version line: `0.1.0 (a1b2c3d, built 2026-05-22 14:03)`.
 * Falls back to the bare version when no build stamp is present.
 */
export function formatVersion(): string {
	const info = getBuildInfo();
	const parts: string[] = [];
	if (info.head) parts.push(info.head.slice(0, 7));
	if (info.builtAt) {
		const d = new Date(info.builtAt);
		const pad = (n: number) => String(n).padStart(2, "0");
		parts.push(
			`built ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
		);
	}
	return parts.length > 0 ? `${info.version} (${parts.join(", ")})` : info.version;
}
