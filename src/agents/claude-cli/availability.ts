// Detect whether the `claude` binary is installed, so the backend is only
// advertised (in `/model` lists, onboarding, etc.) when it can actually run.
// A PATH scan — no subprocess — cached for the process, with a short TTL so a
// mid-session install is picked up without a restart.

import { accessSync, constants } from "node:fs";
import path from "node:path";

import { resolveClaudeCliCommand } from "./catalog.js";

interface AvailabilityCache {
	available: boolean;
	checkedAtMs: number;
}

let cache: AvailabilityCache | undefined;
const AVAILABILITY_TTL_MS = 60_000;

/** On Windows a bare command resolves via these extensions. */
const WINDOWS_EXTS = ["", ".exe", ".cmd", ".bat"];

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		// X_OK is unreliable on Windows (returns false for real .exe/.cmd) — fall
		// back to a plain existence check there.
		if (process.platform === "win32") {
			try {
				accessSync(file, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}
}

/** Scan PATH for the resolved command. Pure of side effects beyond fs reads. */
function scanPathForCommand(command: string): boolean {
	// An absolute/relative path (BRIGADE_CLAUDE_CLI_PATH) — check it directly.
	if (command.includes("/") || command.includes("\\")) {
		if (process.platform === "win32") {
			return WINDOWS_EXTS.some((ext) => isExecutable(command + ext)) || isExecutable(command);
		}
		return isExecutable(command);
	}
	const pathEnv = process.env.PATH ?? process.env.Path ?? "";
	const dirs = pathEnv.split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		const base = path.join(dir, command);
		if (process.platform === "win32") {
			if (WINDOWS_EXTS.some((ext) => isExecutable(base + ext))) return true;
		} else if (isExecutable(base)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the `claude` binary is available on this machine. Cached for
 * `AVAILABILITY_TTL_MS`; pass `force` to bypass the cache (e.g. right after an
 * install). Never throws — a scan failure reports "unavailable".
 */
export function isClaudeCliAvailable(opts: { force?: boolean; nowMs?: number } = {}): boolean {
	const now = opts.nowMs ?? Date.now();
	if (!opts.force && cache && now - cache.checkedAtMs < AVAILABILITY_TTL_MS) {
		return cache.available;
	}
	let available = false;
	try {
		available = scanPathForCommand(resolveClaudeCliCommand());
	} catch {
		available = false;
	}
	cache = { available, checkedAtMs: now };
	return available;
}

/** Test-only cache reset. */
export function __resetClaudeCliAvailabilityCache(): void {
	cache = undefined;
}
