/**
 * brigade-tideline — STANDALONE host-ports (filesystem-only binding).
 *
 * The publish build swaps the core's `agents/memory/host-ports.ts` (Brigade's
 * binding, which forwards to the real subsystems) for THIS file, giving the vendored
 * Tideline core a ZERO-Brigade-dependency binding:
 *   1. logger        → no-op (logging never alters behavior),
 *   2. runtime-mode  → filesystem always (so every Convex branch in the core short-circuits),
 *   3. Convex cache  → no-ops (never reached in filesystem mode),
 *   4. write-scan    → stub (see the note).
 *
 * Defenses that REMAIN in standalone: the provenance WRITE-GATE (`write-gate.ts`,
 * already host-import-free, fully active) and the facade's recall-time
 * `ThreatScanAdapter` (screens recalled content). The only belt-and-suspenders layer
 * not bundled here is the WRITE-time content scan; a publish wanting exact parity
 * vendors the pure `security/injection-patterns.ts` and re-exports its
 * `scanForThreats` / `MemoryThreatError` in place of the two stubs below.
 *
 * Every signature here matches what the core (`records.ts`) calls, so the swap is a
 * drop-in. The lone import is TYPE-ONLY (erased at compile) and resolves to the
 * vendored record model in a built package.
 */

import type { MemoryRecord } from "../agents/memory/records.js";

// 1. logger — no-op with the full method surface the core may touch.
type StandaloneLogger = {
	trace: (...a: unknown[]) => void;
	debug: (...a: unknown[]) => void;
	info: (...a: unknown[]) => void;
	warn: (...a: unknown[]) => void;
	error: (...a: unknown[]) => void;
	fatal: (...a: unknown[]) => void;
	child: (name: string) => StandaloneLogger;
};
export function createSubsystemLogger(_name: string): StandaloneLogger {
	const noop = (..._a: unknown[]): void => {};
	// `child` returns the same no-op logger (matches the real SubsystemLogger surface
	// so any vendored module calling `.child(...)` stays a valid drop-in).
	const logger: StandaloneLogger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };
	return logger;
}

// 2.+3. runtime storage-mode — always filesystem (no Convex store), so the core's
// `tryGetRuntimeContext()?.mode === "convex"` guards are always false.
// biome-ignore lint/suspicious/noExplicitAny: the convex store is NEVER reached in standalone
// (this always returns undefined ⇒ mode is filesystem ⇒ the core's convex branch is dead). Typing
// `store` as `any` lets that dead branch type-check without vendoring the Brigade store interface.
export function tryGetRuntimeContext(): { mode: "filesystem" | "convex"; store: any } | undefined {
	return undefined;
}

// 3. Convex write-through cache — no-ops; unreachable in filesystem mode.
export function workspaceIdFromDir(_workspaceDir: string): string {
	return "main";
}
export function getCachedFacts(_workspaceId: string): MemoryRecord[] | undefined {
	return undefined;
}
export function primeFactsCache(_workspaceId: string, _records: MemoryRecord[]): void {}
export function writeThroughFactsCache(_store: unknown, _workspaceId: string, _records: MemoryRecord[]): void {}

// 4. write-time content threat-scan — STUB (see the module note). Returns "no threat";
// vendor `injection-patterns` for exact parity if the write-time layer is wanted.
export function scanForThreats(_content: string, _scope?: string): string[] {
	return [];
}
export class MemoryThreatError extends Error {
	readonly code = "memory:threat"; // matches the real class so `err.code` branching works
	readonly threats: string[];
	constructor(threats: string[]) {
		super(`memory content matched threat pattern(s): ${threats.join(", ")}`);
		this.name = "MemoryThreatError";
		this.threats = threats;
	}
}
