/**
 * Optional per-instance bindings for the legacy synchronous fact store.
 *
 * The default store owns its filesystem persistence. A host can supply a
 * different persistence realization without importing that host's runtime into
 * Tideline. These ports preserve the legacy cache-backed semantics; they are
 * not a distributed transactional storage contract.
 */

import type { MemoryEvent } from "../store/event-log.js";
import type { MemoryRecord } from "../store/records.js";

export interface FactStoreBackend {
	/** Await an authoritative initial snapshot; retry a failed hydration explicitly. */
	ready?(): Promise<void>;
	/** Await queued fact mutations; reject if durable persistence fails. */
	flush?(): Promise<void>;
	/** Return a detached snapshot so callers can safely mutate records. */
	readAll(): MemoryRecord[];
	/** Replace the complete record snapshot, including archived and pruned records. */
	writeAll(records: MemoryRecord[]): void;
	/** Additive, best-effort provenance; it must not fail an active-store write. */
	appendEvent(event: MemoryEvent): void;
	/** Ordered oldest-first, empty when the backend has no event history. */
	readEventsAsync(): Promise<MemoryEvent[]>;
}

export interface FactStoreHostPorts {
	/**
	 * Resolved for every operation, not once at import or construction. Returning
	 * undefined selects the built-in filesystem realization. Host mode changes
	 * remain the host's responsibility; a store never installs process globals.
	 */
	getBackend?(workspaceDir: string): FactStoreBackend | undefined;
	logger?: {
		warn(message: string, metadata?: Record<string, unknown>): void;
	};
}
