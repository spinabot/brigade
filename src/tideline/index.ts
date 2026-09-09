/**
 * brigade-tideline — Brigade's long-term memory framework. PUBLIC PACKAGE SURFACE.
 *
 * Tideline is a model-agnostic long-term memory engine: hybrid recall (BM25-primary
 * + a model-free HRR vector recovery lane), bi-temporal decay + trust modulation, a
 * provenance write-gate (poisoning defense), per-origin isolation, a typed link
 * graph, and a nightly reflect/consolidate/relate pass — all behind the
 * {@link Tideline} facade with a small adapter SPI (Storage / Clock / ThreatScan /
 * Embedder / Llm).
 *
 * The canonical implementation lives beside this entry. Brigade imports this
 * engine and supplies optional, per-instance host bindings; the engine never
 * imports the Brigade runtime. The publish build checks both runtime and type
 * dependency closures and preserves singleton identity across public entries.
 * The bundled FactStore is still a synchronous legacy store, not a distributed
 * transactional authority implementation. See README.md for the current scope.
 */

// ───────────────────────── the facade + its adapter SPI ─────────────────────────
export {
	Tideline,
	type TidelineAdapters,
	type RecalledFact,
	type ExplainedFact,
	type RecallOpts,
	type ExplainOpts,
	type ContextOpts,
	type FeedbackSignal,
	type FactInspection,
	type StorageAdapter,
	type ClockAdapter,
	type ThreatScanAdapter,
	type EmbedderAdapter,
	type LlmAdapter,
} from "./api/tideline.js";

// The error `Tideline.add` / `FactStore.write` throw on a blocked poisoning write
// (the full write-gate API — `evaluateWriteGate` + the trust/segment helpers — is
// in `brigade-tideline/advanced`).
export { WriteGateError } from "./governance/write-gate.js";

// ───────────────────── the v1 storage backend + the record model ────────────────
export {
	FactStore,
	type FactStoreOptions,
	type FactStoreHostPorts,
	type FactStoreBackend,
	MEMORY_SEGMENTS,
	SEGMENT_DEFAULTS,
	clampImportance,
	makeMemoryId,
	type MemoryRecord,
	type MemorySegment,
	type MemoryTier,
	type MemoryLifecycle,
	type MemoryRecordOrigin,
	type RecordOriginFilter,
	type NewFact,
	type ListFilter,
} from "./store/records.js";

// ───────────────────────────── the link-graph substrate ─────────────────────────
export { linksFrom, backlinksTo, type MemoryLink, type MemoryLinkKind } from "./graph/links.js";

// ──────────────────── recall internals (transparency + composition) ─────────────
export { tokenize, bm25Score, linearScanScore, type ScoreBreakdown } from "./retrieval/scoring.js";
export { recallHybrid } from "./retrieval/hybrid.js";
export {
	recallWithGraph,
	recallWithGraphAsync,
	type GraphRecallOpts,
	type GraphRecallResult,
} from "./retrieval/graph-recall.js";

// ───────────── the embedder seam: zero-dep model-free default + learned providers ─
export {
	cosine,
	getDefaultEmbedder,
	setDefaultEmbedder,
	HrrEmbedder,
	HashingEmbedder,
	type Embedder,
} from "./embeddings/embedder.js";
export { resolveEmbedder, EMBEDDER_DIMS, OpenAiEmbedder } from "./embeddings/embedder-providers.js";
