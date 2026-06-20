/**
 * Brigade memory — public re-exports.
 *
 * Re-exports the core memory surface for external consumers (e.g. the
 * Tideline public package and downstream packages). Internal Brigade call
 * sites (tools, agent-loop, gateway) import directly from the per-file
 * modules to keep circular imports easy to spot and avoid barrel indirection.
 */

export {
	FactStore,
	FACTS_RELATIVE_PATH,
	MEMORY_SEGMENTS,
	SEGMENT_DEFAULTS,
	clampImportance,
	makeMemoryId,
	type ListFilter,
	type MemoryLifecycle,
	type MemoryRecord,
	type MemorySegment,
	type MemoryTier,
	type NewFact,
} from "./records.js";

export {
	BrigadeMemoryPathError,
	FileMemoryStore,
	scoreChunk,
	splitIntoChunks,
	tokenize,
	type BrigadeStorage,
	type MemoryReadOptions,
	type MemoryReadResult,
	type MemorySearchOptions,
	type MemorySearchResult,
	type MemoryStatus,
} from "./storage.js";

export { buildAutoRecallBlock } from "./auto-recall.js";

export {
	createDefaultMemoryCapability,
	isDefaultMemoryCapability,
	resolveActiveMemoryCapability,
	type DefaultMemoryCapability,
	type DefaultMemoryHit,
} from "./plugin-runtime.js";
