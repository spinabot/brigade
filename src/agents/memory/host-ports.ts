/**
 * Memory host seams — the ONE swappable module.
 *
 * The Tideline core (`records.ts` / `FactStore`) needs four things it does not own:
 *   1. a subsystem LOGGER,
 *   2. the Convex write-through CACHE (convex storage mode only),
 *   3. the runtime storage-MODE probe (filesystem vs convex),
 *   4. a write-time content THREAT-SCAN (+ its error).
 *
 * Rather than have the core reach into Brigade's `../../` subsystems directly (which
 * is what made it un-extractable), the core imports ALL of them from HERE. This file
 * is Brigade's binding: it just forwards to the real host modules — PURE INDIRECTION,
 * identical behavior, no wiring, no test changes.
 *
 * The decoupling: a standalone `brigade-tideline` publish swaps THIS one file for an
 * fs-only variant (no-op logger, no Convex cache, runtime-mode = filesystem so the
 * convex branches never fire, a vendored pure threat-scan). Every other memory module
 * is already host-import-free, so the core reaches outside its own directory ONLY
 * through this seam — making the standalone build a single-file swap, not a refactor.
 * See `src/tideline/host-ports.standalone.ts` for the fs-only implementation + the
 * package README's "packaging status" for the build swap.
 */

// 1. logger
export { createSubsystemLogger } from "../../logging/subsystem-logger.js";
// 2. + 3. runtime storage-mode probe (carries the convex store for write-through)
export { tryGetRuntimeContext } from "../../storage/runtime-context.js";
// 3. convex write-through cache (all sync; only exercised in convex mode)
export { getCachedFacts, primeFactsCache, workspaceIdFromDir, writeThroughFactsCache } from "../../storage/facts-cache.js";
// 4. write-time content threat-scan + its error
export { MemoryThreatError, scanForThreats } from "../../security/injection-patterns.js";
