/**
 * brigade-tideline/advanced — the power-user surface.
 *
 * The lifecycle/cognition passes, the typed link graph, governance, transparency,
 * and the human-gated self-improving loop. The facade's verbs are built from these;
 * this entry exposes them directly for adopters composing their own loops. All
 * re-exported ON TOP of `../agents/memory/*` without modification.
 *
 * (These compose over a `FactStore` / `StorageAdapter` — pass one in.
 * HOST-IMPORT NOTE: the pure-function exports (graph / contradiction / write-gate /
 * self-improve / graph-export) are host-import-free. `MemoryEventLog` carries its own
 * `node:fs`/`node:path` coupling, and the governance + dream functions carry it
 * transitively via `FactStore`. See the package README's "packaging status" for the
 * storage-backend decoupling that a standalone publish still needs.)
 */

// ── lifecycle / cognition passes ──
export { runDream, type DreamOpts, type DreamResult } from "../agents/memory/dream.js";
export { effectiveScore, runDecayGc, type DecayResult } from "../agents/memory/decay.js";
export { findContradictions, type ContradictionCandidate } from "../agents/memory/contradiction.js";

// ── the typed link graph ──
export {
	buildGraph,
	neighbors,
	spread,
	synonymyEdges,
	resolveEntities,
	TRANSITION_KINDS,
	type MemoryGraph,
	type NeighborOpts,
	type SpreadOpts,
	type ResolvedEntity,
	type SynonymyEdge,
} from "../agents/memory/graph.js";

// ── governance: purge cascade, retention, inspect, export ──
export {
	purge,
	applyRetention,
	inspect,
	exportMemory,
	type PurgeResult,
	type InspectResult,
} from "../agents/memory/governance.js";

// ── the provenance write-gate (poisoning defense). `WriteGateError` is ALSO
//    re-exported from the main entry, since `Tideline.add` throws it. ──
export {
	WriteGateError,
	evaluateWriteGate,
	isUntrustedSource,
	isTrustedTarget,
	isProtectedSegment,
	confineUntrustedSegment,
	type WriteGateVerdict,
} from "../agents/memory/write-gate.js";

// ── transparency: the append-only event log. ──
export { MemoryEventLog, type MemoryEvent, type MemoryEventKind } from "../agents/memory/event-log.js";

// ── the human-gated self-improving loop (propose → gate-on-eval → approve → apply → revert). ──
export {
	proposeFromTelemetry,
	gateOnEval,
	approve,
	reject,
	applyProposal,
	revertProposal,
	type Proposal,
	type ProposalDiff,
	type ProposalStatus,
	type ProposeOpts,
} from "../agents/memory/self-improve.js";

// ── the Memory Graph dashboard data layer: nodes + typed edges + topic clusters
//    (deterministic label-propagation community detection) + headline stats. ──
export {
	exportMemoryGraph,
	type MemoryGraphExport,
	type GraphNode,
	type GraphEdge,
	type GraphCluster,
	type MemoryGraphStats,
	type EdgeStrength,
} from "../agents/memory/graph-export.js";
