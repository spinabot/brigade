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
 * This module is the PACKAGE ENTRY: a curated, stable public API assembled ON TOP
 * of the in-tree implementation (`../agents/memory/*`) WITHOUT modifying it. The
 * facade was deliberately written host-import-free for exactly this lift (see the
 * note atop `agents/memory/tideline.ts`).
 *
 * PACKAGING STATUS — this is the in-repo extraction layer: it freezes the package
 * boundary + the public API + the manifest. Publishing as a fully *standalone* npm
 * package additionally requires making the v1 `FactStore`'s three host seams (the
 * Convex write-through cache, the runtime-mode probe, the subsystem logger) injected
 * or optional rather than imported — the documented next refinement. The facade and
 * the pure core (scoring / links / decay / hybrid / graph / embedder) are ALREADY
 * host-import-free; only the `FactStore` realization carries those seams. See
 * README.md for the decoupling checklist.
 */

// ───────────────────────── the facade + its adapter SPI ─────────────────────────
export {
	Tideline,
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
} from "../agents/memory/tideline.js";

// The error `Tideline.add` / `FactStore.write` throw on a blocked poisoning write
// (the full write-gate API — `evaluateWriteGate` + the trust/segment helpers — is
// in `brigade-tideline/advanced`).
export { WriteGateError } from "../agents/memory/write-gate.js";

// ───────────────────── the v1 storage backend + the record model ────────────────
export {
	FactStore,
	MEMORY_SEGMENTS,
	SEGMENT_DEFAULTS,
	clampImportance,
	makeMemoryId,
	type MemoryRecord,
	type MemorySegment,
	type MemoryTier,
	type MemoryLifecycle,
	type NewFact,
	type ListFilter,
} from "../agents/memory/records.js";

// ───────────────────────────── the link-graph substrate ─────────────────────────
export { linksFrom, backlinksTo, type MemoryLink, type MemoryLinkKind } from "../agents/memory/links.js";

// ──────────────────── recall internals (transparency + composition) ─────────────
export { tokenize, bm25Score, linearScanScore, type ScoreBreakdown } from "../agents/memory/scoring.js";
export { recallHybrid } from "../agents/memory/hybrid.js";
export {
	recallWithGraph,
	recallWithGraphAsync,
	type GraphRecallOpts,
	type GraphRecallResult,
} from "../agents/memory/graph-recall.js";

// ───────────── the embedder seam: zero-dep model-free default + learned providers ─
export {
	cosine,
	getDefaultEmbedder,
	setDefaultEmbedder,
	HrrEmbedder,
	HashingEmbedder,
	type Embedder,
} from "../agents/memory/embedder.js";
export { resolveEmbedder, EMBEDDER_DIMS, OpenAiEmbedder } from "../agents/memory/embedder-providers.js";
