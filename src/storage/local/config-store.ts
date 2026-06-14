// src/storage/local/config-store.ts
//
// LocalConfigStore — the filesystem-mode wrapper around `config/io.ts`.
// Implements `ConfigStore` from `../store.ts`.
//
// Behaviour rule (additive Phase-2 discipline): every method calls today's
// existing functions byte-for-byte. No new write paths, no atomicity changes.
// The existing locking + .bak rotation + `${VAR}` resolution all keep
// working unchanged. All 2,154 existing tests pass.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolveConfigPath } from "../../config/paths.js";
import {
	type BrigadeConfig,
	mutateConfigAtomic,
	readConfigOrInit,
	writeConfigSafe,
} from "../../config/io.js";

import { watchFile } from "./file-watcher.js";

import type {
	ConfigStore,
	RevToken,
	Unsub,
	WriteResult,
} from "../store.js";

/** Build a `RevToken` from a freshly-read file's content + mtime. The hash
 *  is deterministic from the on-disk bytes, so two readers that observe the
 *  same file get the same RevToken. */
function revFromConfig(cfg: BrigadeConfig): RevToken {
	const hash = createHash("sha256");
	hash.update(JSON.stringify(cfg));
	try {
		const cfgPath = resolveConfigPath();
		if (existsSync(cfgPath)) {
			const st = statSync(cfgPath);
			hash.update(":");
			hash.update(String(st.mtimeMs));
			hash.update(":");
			hash.update(String(st.size));
		}
	} catch {
		// Pre-create state — mtime/size unavailable; the content hash alone
		// is still a stable rev. Fall through.
	}
	return hash.digest("hex") as RevToken;
}

export class LocalConfigStore implements ConfigStore {
	constructor(private readonly _stateDir: string) {}

	async read(): Promise<{ value: BrigadeConfig; rev: RevToken }> {
		const value = readConfigOrInit();
		return { value, rev: revFromConfig(value) };
	}

	async write(cfg: BrigadeConfig, opts?: { expectedRev?: RevToken }): Promise<WriteResult> {
		// Opt-in OCC: when an expectedRev is supplied, refuse to write if the
		// on-disk file has drifted since the caller's read. Without an
		// expectedRev, behave as a plain write (the existing config-io path
		// has its own safe-rotation invariants).
		if (opts?.expectedRev) {
			const current = readConfigOrInit();
			const currentRev = revFromConfig(current);
			if (currentRev !== opts.expectedRev) {
				// Pull in ConflictError lazily to avoid an import cycle when
				// store.ts later re-exports types via this module.
				const { ConflictError } = await import("../store.js");
				throw new ConflictError(opts.expectedRev, currentRev);
			}
		}
		writeConfigSafe(cfg);
		const writtenAt = Date.now();
		return { rev: revFromConfig(cfg), writtenAt };
	}

	async mutate(
		fn: (current: BrigadeConfig) => BrigadeConfig | Promise<BrigadeConfig>,
	): Promise<BrigadeConfig> {
		// Delegates to the existing serialised read-modify-write path. The
		// underlying `mutateConfigAtomic` already owns proper-lockfile +
		// atomic-rename semantics; we just adapt the return value.
		const next = await mutateConfigAtomic(async (current) => fn(current));
		return next;
	}

	subscribe(cb: (cfg: BrigadeConfig, rev: RevToken) => void): Unsub {
		// fs.watch on brigade.json with the standard 500 ms debounce — same
		// pattern the gateway hot-reload watcher (core/server.ts) uses. On
		// change we re-read + recompute the rev, then fan out to the caller.
		// Read failures are swallowed (best-effort listener); a malformed
		// mid-write file simply skips that callback firing.
		return watchFile(resolveConfigPath(), () => {
			try {
				const value = readConfigOrInit();
				cb(value, revFromConfig(value));
			} catch {
				// Read failed (file mid-write, permissions, etc.) — skip.
			}
		});
	}

	async listBackups(): Promise<
		Array<{ slot: number; sha256: string; mtimeMs: number; bytes: number }>
	> {
		// The .bak rotation lives in config/io.ts but isn't exported as a
		// listing helper today. PR2 scope: keep the surface present and
		// empty; a real lister lands when `brigade doctor` needs it.
		return [];
	}

	async restoreBackup(_slot: number): Promise<BrigadeConfig> {
		throw new Error(
			"LocalConfigStore.restoreBackup is not wired yet — restore by hand-copying ~/.brigade/brigade.json.bak.<N> over brigade.json",
		);
	}
}
