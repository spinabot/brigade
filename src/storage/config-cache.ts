// src/storage/config-cache.ts
//
// In-process config cache for convex mode. Pi SDK boot paths and the per-turn
// loop read config SYNCHRONOUSLY (readConfigOrInit), which a network-backed
// store cannot serve directly. In convex mode the boot sequence primes this
// cache from `store.config.read()`; long-lived processes (the gateway) also
// subscribe to the config live-query and re-prime on every server-side change.
//
// The cache holds the RAW form — `${VAR}` secret references intact, exactly
// as the bytes sit in the brigadeConfig row. `readConfigOrInit`'s convex
// branch clones it and resolves secrets per call, mirroring the disk path's
// read-parse-resolve sequence byte-for-semantically.
//
// Filesystem mode never touches this module.

import type { BrigadeConfig } from "../config/types.js";

let _raw: BrigadeConfig | undefined;
const _listeners = new Set<() => void>();

/** Install/replace the cached raw config. Deep-clones so later caller
 *  mutations can't corrupt the cache. Notifies listeners AFTER the swap —
 *  in filesystem mode the gateway hot-reloads agents off an fs.watch on
 *  brigade.json, but convex-mode config writes never touch disk, so a
 *  mid-session `manage_agent add` / org init left the gateway's
 *  perAgentRuntime stale: 20 agents in config, `agents on the gateway:
 *  main` only, `/agent <id>` refusing every new id until restart. This
 *  notification is the convex-mode equivalent of that fs.watch — fired by
 *  BOTH the in-process write path (io.ts) and the cross-process live
 *  subscription (boot.ts enableConfigLiveRefresh). */
export function primeConfigCache(cfg: BrigadeConfig): void {
	_raw = structuredClone(cfg);
	for (const cb of _listeners) {
		try {
			cb();
		} catch {
			// A listener error must never poison the config write path.
		}
	}
}

/** Subscribe to cache re-primes (= every convex-mode config change, local or
 *  remote). Returns the unsubscribe. Listeners should debounce themselves —
 *  a burst of writes fires once per write. */
export function onConfigCachePrimed(cb: () => void): () => void {
	_listeners.add(cb);
	return () => _listeners.delete(cb);
}

/** The cached raw (secret-refs-intact) config, or undefined when boot has
 *  not primed it. Callers MUST clone before mutating or resolving. */
export function getCachedConfigRaw(): BrigadeConfig | undefined {
	return _raw;
}

export function isConfigCachePrimed(): boolean {
	return _raw !== undefined;
}

/** Test-only. */
export function __resetConfigCacheForTests(): void {
	_raw = undefined;
	_listeners.clear();
}
