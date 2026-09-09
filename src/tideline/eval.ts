/**
 * brigade-tideline/eval — the recall-quality evaluation harness.
 *
 * The deterministic, reproducible measurement layer (build Steps 2-3): seedable
 * gold sets, the recall metrics (recall@k / MRR / nDCG@k + bootstrap CIs), the
 * baseline + production capabilities for head-to-head comparison, and the
 * privacy-safe real-data export→approve pipeline. Exported from the canonical
 * `tideline/eval/*` implementation, so independent adopters and Brigade use the
 * same measurement code. Synthetic fixtures are regression checks, not evidence
 * of improved real-world recall, token reduction, or billing savings.
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
} from "./eval/gold.js";
export { RICH_GOLD } from "./eval/gold-rich.js";
export { HARD_GOLD } from "./eval/gold-hard.js";
export { SYNTHETIC_GOLD } from "./eval/gold-synthetic.js";
export { exportGoldScaffold, writeLocalGoldSpec, assertLocalGoldPath } from "./eval/gold-export.js";

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
} from "./eval/harness.js";
export { bootstrapMeanCI } from "./eval/metrics.js";

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
} from "./eval/capabilities.js";
