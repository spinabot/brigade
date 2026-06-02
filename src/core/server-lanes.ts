/**
 * Gateway-lane concurrency wiring.
 *
 * Called at gateway boot and on `system.reload` to push the resolved
 * `Main` / `Subagent` / `Cron` budgets into the runtime. Pre-existing
 * in-flight tasks keep running; future enqueues pump up to the new cap.
 *
 * Knob sources (see `config/agent-limits.ts`):
 *   - `cfg.agents.defaults.maxConcurrent`         → `CommandLane.Main`
 *   - `cfg.agents.defaults.maxSubagentConcurrent` → `subagent-budget` semaphore
 *   - `cfg.cron.maxConcurrentRuns`                → `CommandLane.Cron`
 *
 * Sub-agent budget is enforced by a process-wide semaphore around the
 * spawn enqueue (see `agents/subagent-budget.ts`), NOT by a lane cap on
 * `CommandLane.Subagent` — Brigade uses per-parent lanes for isolation so
 * one parent's children never block another parent's. The global cap
 * therefore lives outside the lane engine.
 *
 * Per-session lanes (`session:<key>`) + per-parent sub-agent lanes
 * (`subagent:<key>`, `nested:<key>`) are NOT bumped here — each stays at
 * the engine default (1, strict FIFO per peer / per parent).
 */

import {
	resolveAgentMaxConcurrent,
	resolveCronMaxConcurrent,
	resolveSubagentMaxConcurrent,
} from "../config/agent-limits.js";
import type { BrigadeConfig } from "../config/io.js";
import { setSubagentBudget } from "../agents/subagent-budget.js";
import { CommandLane, setCommandLaneConcurrency } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg?: BrigadeConfig | null): void {
	setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
	setSubagentBudget(resolveSubagentMaxConcurrent(cfg));
	setCommandLaneConcurrency(CommandLane.Cron, resolveCronMaxConcurrent(cfg));
}
