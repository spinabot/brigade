// src/storage/sentinel.ts
//
// `~/.brigade/mode.sentinel` — the file that pins Brigade's storage mode.
//
// Why a sentinel and not just an env var: env vars get lost between shells,
// CI overrides, and IDE configurations. The sentinel is sticky — once
// `brigade onboard` writes it, every Brigade invocation on this machine
// boots in the chosen mode. Conflict between sentinel and env vars is a
// hard error unless `BRIGADE_FORCE_MODE=1` (one-shot diagnostic only).
//
// File location: `<stateDir>/mode.sentinel` (default `~/.brigade/mode.sentinel`)
// File format: pretty JSON, < 1 KiB

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

import type { ModeSentinel, StorageMode } from "./runtime-context.js";

const SENTINEL_FILENAME = "mode.sentinel";

export interface SentinelOptions {
	stateDir?: string;
}

export function resolveSentinelPath(stateDir?: string): string {
	return path.join(stateDir ?? resolveStateDir(), SENTINEL_FILENAME);
}

/**
 * Read the sentinel if present. Returns `undefined` when the file doesn't
 * exist (operator hasn't onboarded). Throws on corrupt file — fixing it is
 * the operator's call, we don't silently fall back to a default.
 */
export function readSentinel(opts: SentinelOptions = {}): ModeSentinel | undefined {
	const p = resolveSentinelPath(opts.stateDir);
	if (!existsSync(p)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch (err) {
		throw new Error(`mode.sentinel at ${p} is unreadable: ${(err as Error).message}`);
	}
	let parsed: ModeSentinel;
	try {
		parsed = JSON.parse(raw) as ModeSentinel;
	} catch (err) {
		throw new Error(`mode.sentinel at ${p} is invalid JSON: ${(err as Error).message}`);
	}
	if (parsed.mode !== "filesystem" && parsed.mode !== "convex") {
		throw new Error(
			`mode.sentinel at ${p} has invalid mode "${String(parsed.mode)}" (expected "filesystem" or "convex")`,
		);
	}
	if (parsed.mode === "convex") {
		if (typeof parsed.convexUrl !== "string" || parsed.convexUrl.length === 0) {
			throw new Error(`mode.sentinel at ${p} is convex mode but has no convexUrl`);
		}
	}
	return parsed;
}

/**
 * Atomic write — tmp + rename so a crash mid-write doesn't leave a torn file.
 * Refuses to write a convex sentinel without a URL.
 */
export function writeSentinel(sentinel: ModeSentinel, opts: SentinelOptions = {}): void {
	if (sentinel.mode !== "filesystem" && sentinel.mode !== "convex") {
		throw new Error(`writeSentinel: invalid mode "${String(sentinel.mode)}"`);
	}
	if (sentinel.mode === "convex" && (!sentinel.convexUrl || sentinel.convexUrl.length === 0)) {
		throw new Error(`writeSentinel: convex mode requires a convexUrl`);
	}

	const stateDir = opts.stateDir ?? resolveStateDir();
	mkdirSync(stateDir, { recursive: true });

	const target = path.join(stateDir, SENTINEL_FILENAME);
	const tmp = `${target}.tmp.${process.pid}`;
	const body = JSON.stringify(sentinel, null, 2) + "\n";
	writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, target);
}

/**
 * Convenience for the common "I just decided what mode this machine should
 * use" flow — fills in `migratedAt` if the caller didn't supply one.
 */
export function writeSentinelNow(
	mode: StorageMode,
	extras: { convexUrl?: string; manifestSha256?: string } = {},
	opts: SentinelOptions = {},
): ModeSentinel {
	const sentinel: ModeSentinel = {
		mode,
		migratedAt: new Date().toISOString(),
		...(extras.convexUrl !== undefined ? { convexUrl: extras.convexUrl } : {}),
		...(extras.manifestSha256 !== undefined ? { manifestSha256: extras.manifestSha256 } : {}),
	};
	writeSentinel(sentinel, opts);
	return sentinel;
}

export function sentinelExists(opts: SentinelOptions = {}): boolean {
	return existsSync(resolveSentinelPath(opts.stateDir));
}

/** Remove the mode pin (factory reset / `store reset`). Missing file is fine. */
export function deleteSentinel(opts: SentinelOptions = {}): void {
	try {
		rmSync(resolveSentinelPath(opts.stateDir), { force: true });
	} catch {
		// Best-effort — a stuck sentinel surfaces on the next mode show.
	}
}
