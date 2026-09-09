/**
 * Brigade's per-instance binding for Tideline's legacy synchronous fact store.
 * Runtime mode, workspace identity, cache hydration and queued Convex mutations
 * belong to the harness. Importing this module never changes standalone Tideline.
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { awaitFactsFlush, ensureFactsHydrated, readThroughFactsCache, workspaceIdFromDir, writeThroughFactsCache } from "../../storage/facts-cache.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import type { MemoryEvent } from "../../tideline/store/event-log.js";
import type { FactStoreHostPorts } from "../../tideline/ports/host-ports.js";

/** A fresh binding per consumer; runtime mode is resolved on every operation. */
export function createBrigadeMemoryHostPorts(): FactStoreHostPorts {
	return {
		logger: createSubsystemLogger("memory/records"),
		getBackend(workspaceDir) {
			const rctx = tryGetRuntimeContext();
			if (rctx?.mode !== "convex") return undefined;
			const wsId = workspaceIdFromDir(workspaceDir);
			return {
				ready: () => ensureFactsHydrated(rctx.store, wsId),
				flush: () => awaitFactsFlush(wsId),
				readAll() {
					return readThroughFactsCache(rctx.store, wsId);
				},
				writeAll(records) {
					// Existing cache diffing, cloning, retry ordering and flush tracking.
					writeThroughFactsCache(rctx.store, wsId, records);
				},
				appendEvent(event) {
					// Preserve the optional, fire-and-forget legacy audit hook.
					const append = rctx.store.memory.appendMemoryEvent;
					if (append) {
						void append.call(rctx.store.memory, wsId, event as unknown as Record<string, unknown>).catch(() => {});
					}
				},
				async readEventsAsync() {
					const list = rctx.store.memory.listMemoryEvents;
					if (!list) return [];
					return (await list.call(rctx.store.memory, wsId)) as unknown as MemoryEvent[];
				},
			};
		},
	};
}

// Preserve the old host entry's named exports for existing internal consumers.
export { createSubsystemLogger } from "../../logging/subsystem-logger.js";
export { tryGetRuntimeContext } from "../../storage/runtime-context.js";
export { getCachedFacts, primeFactsCache, workspaceIdFromDir, writeThroughFactsCache } from "../../storage/facts-cache.js";
export { MemoryThreatError, scanForThreats } from "../../security/injection-patterns.js";
