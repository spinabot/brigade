/**
 * Lane-budget knob resolvers.
 *
 * Maps `cfg.agents.defaults.maxConcurrent` /
 * `cfg.agents.defaults.maxSubagentConcurrent` (and `cfg.cron.maxConcurrentRuns`
 * via the caller) into integer caps consumed by
 * `setCommandLaneConcurrency()`. Defaults match the upstream reference
 * codebase's `DEFAULT_AGENT_MAX_CONCURRENT` / `DEFAULT_SUBAGENT_MAX_CONCURRENT`
 * so a fresh install gets sane parallelism (4 operator turns, 8 sub-agents)
 * without anyone touching brigade.json.
 */

import type { BrigadeConfig } from "./io.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
export const DEFAULT_CRON_MAX_CONCURRENT = 1;

function clampPositiveInt(raw: unknown, fallback: number): number {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return Math.max(1, Math.floor(raw));
	}
	return fallback;
}

/** Resolve the `Main` lane budget (operator turns). */
export function resolveAgentMaxConcurrent(cfg?: BrigadeConfig | null): number {
	return clampPositiveInt(cfg?.agents?.defaults?.maxConcurrent, DEFAULT_AGENT_MAX_CONCURRENT);
}

/** Resolve the global `Subagent` lane budget. */
export function resolveSubagentMaxConcurrent(cfg?: BrigadeConfig | null): number {
	return clampPositiveInt(
		cfg?.agents?.defaults?.maxSubagentConcurrent,
		DEFAULT_SUBAGENT_MAX_CONCURRENT,
	);
}

/** Resolve the global `Cron` lane budget from `cfg.cron.maxConcurrentRuns`. */
export function resolveCronMaxConcurrent(cfg?: BrigadeConfig | null): number {
	const cronCfg = (cfg as { cron?: { maxConcurrentRuns?: number } } | undefined)?.cron;
	return clampPositiveInt(cronCfg?.maxConcurrentRuns, DEFAULT_CRON_MAX_CONCURRENT);
}
