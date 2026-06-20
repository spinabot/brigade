/**
 * brigade-tideline/eval — the recall-quality evaluation harness.
 *
 * The deterministic, reproducible measurement layer (build Steps 2-3): seedable
 * gold sets, the recall metrics (recall@k / MRR / nDCG@k + bootstrap CIs), the
 * baseline + production capabilities for head-to-head comparison, and the
 * privacy-safe real-data export→approve pipeline. Re-exported ON TOP of the
 * in-tree `agents/memory/eval/*` without modification, so an adopter can measure
 * Tideline on their own data exactly as Brigade does in CI.
 */

// ── gold sets + the spec/seed/approve pipeline ──
export {
	seedGold,
	loadGoldSpec,
	GOLD_CATEGORIES,
	GOLD_REVIEW_PLACEHOLDER,
	type GoldSpec,
	type GoldCase,
	type GoldFact,
} from "../agents/memory/eval/gold.js";
export { RICH_GOLD } from "../agents/memory/eval/gold-rich.js";
export { HARD_GOLD } from "../agents/memory/eval/gold-hard.js";
export { SYNTHETIC_GOLD } from "../agents/memory/eval/gold-synthetic.js";
export { exportGoldScaffold, writeLocalGoldSpec, assertLocalGoldPath } from "../agents/memory/eval/gold-export.js";

// ── the harness + metrics ──
export {
	runRecallEval,
	formatRecallEval,
	type RecallEvalResult,
	type EvalCase,
	type RecallCapability,
	type RecallHit,
	type PerCaseResult,
	type CategoryRollup,
	type RunRecallEvalOptions,
} from "../agents/memory/eval/harness.js";
export { bootstrapMeanCI } from "../agents/memory/eval/metrics.js";

// ── capabilities: the linear floor, the FTS/BM25 baselines, the reproduced
//    competitor weighted-sum fusion, the graph lane, the dump-all oracle, and the
//    production hybrid scorer — the head-to-head set. ──
export {
	linearScanCapability,
	defaultRecallCapability,
	ftsBaselineCapability,
	hybridRecallCapability,
	weightedSumFusionBaseline,
	graphRecallCapability,
	oracleCapability,
} from "../agents/memory/eval/capabilities.js";
