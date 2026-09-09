/**
 * brigade-tideline/advanced — the power-user surface.
 *
 * The lifecycle/cognition passes, the typed link graph, governance, transparency,
 * and the human-gated self-improving loop. The facade's verbs are built from these;
 * this entry exposes them directly for adopters composing their own loops. All
 * exported from the canonical implementation in this directory.
 *
 * These compose over the legacy FactStore and its optional host ports. Filesystem
 * persistence is the default; no Brigade runtime or Convex package is required.
 * This surface does not imply transactional enterprise authority semantics.
 */

// ── lifecycle / cognition passes ──
export { runDream, type DreamOpts, type DreamResult } from "./lifecycle/dream.js";
export { effectiveScore, runDecayGc, type DecayResult } from "./lifecycle/decay.js";
export { findContradictions, type ContradictionCandidate } from "./lifecycle/contradiction.js";

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
} from "./graph/graph.js";

// ── governance: purge cascade, retention, inspect, export ──
export {
	purge,
	applyRetention,
	inspect,
	exportMemory,
	type PurgeResult,
	type InspectResult,
} from "./governance/governance.js";

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
} from "./governance/write-gate.js";

// ── transparency: the append-only event log. ──
export { MemoryEventLog, type MemoryEvent, type MemoryEventKind } from "./store/event-log.js";

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
} from "./lifecycle/self-improve.js";

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
} from "./graph/graph-export.js";
