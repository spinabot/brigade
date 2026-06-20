import type { BrigadeExtensionRegistry } from "./registry.js";

/**
 * Process-wide handle to the live extension registry, set once at gateway boot (after
 * `loadModules`) and cleared on shutdown. Mirrors `active-service.ts` (the cron service
 * singleton): lets a deep, hot-path caller — e.g. the inbound media pipeline reaching a
 * TranscriptionProvider — fetch the registry WITHOUT threading it through every channel
 * adapter's args/deps. Single-operator, single-process, so one slot is correct.
 *
 * Returns `undefined` when unset (e.g. a non-gateway path, or before boot), so callers
 * degrade gracefully rather than fault.
 */
let active: BrigadeExtensionRegistry | undefined;

export function setActiveRegistry(registry: BrigadeExtensionRegistry | undefined): void {
	active = registry;
}

export function getActiveRegistry(): BrigadeExtensionRegistry | undefined {
	return active;
}
