/**
 * Command lanes — cooperative parallelism for the Brigade gateway.
 *
 * Public surface every Brigade caller imports from. Internally the actual
 * FIFO + generation-counter + drain-helpers implementation lives in
 * `./command-queue.ts` — this module is a thin re-export + naming-stable
 * adapter so the upstream lift could land without renaming every Brigade
 * caller (`enqueueInLane`, `getLaneQueueSize`, `resetLanesForTests`,
 * `CommandLane.{Main,Cron,Subagent,Nested}`).
 *
 * Lane model:
 *
 *   - `Main`      — the operator's primary turn lane. TUI / connect-mode
 *                   prompts + direct-RPC calls land here. Strictly FIFO.
 *   - `Cron`      — manual cron-fire work (operator clicking "run now").
 *                   Timer-driven fires bypass this lane and run directly
 *                   in their own per-instance lock.
 *   - `Subagent`  — sub-agent spawns. Parent's `Main` lane keeps moving
 *                   while a sub-agent runs.
 *   - `Nested`    — sub-agents OF sub-agents, or work spawned from inside
 *                   a cron turn. Prevents nested deadlock when a Cron-lane
 *                   task tries to enqueue more Cron-lane work.
 *   - `session:<key>` — per-session lanes for channel-routed turns. Two
 *                   different DMs (WhatsApp A and WhatsApp B) get
 *                   different lanes and run concurrently. Inside a single
 *                   peer's lane work is still FIFO so messages 1, 2, 3
 *                   process in order.
 *
 * Same-lane tasks queue and run one at a time. Different-lane tasks run
 * concurrently. The lane is a string for extensibility — adding a new
 * well-known lane is a string-literal addition; per-session lanes use
 * `session:<sessionKey>` keys built on the fly.
 *
 * Concurrency budget: every lane defaults to `maxConcurrent: 1`. Use
 * `setCommandLaneConcurrency(lane, n)` from `./command-queue.js` to lift
 * the cap (e.g. for parallel-account inbound processing on a channel).
 */

import {
	clearCommandLane,
	enqueueCommandInLane,
	getQueueSize,
	resetCommandQueueStateForTest,
} from "./command-queue.js";

/** Well-known lane ids. */
export const CommandLane = {
	Main: "main",
	Cron: "cron",
	Subagent: "subagent",
	Nested: "nested",
} as const;
export type CommandLane = (typeof CommandLane)[keyof typeof CommandLane];
export type CommandLaneId = (typeof CommandLane)[keyof typeof CommandLane] | string;

/** Upstream-parity aliases for lift-and-paste compatibility. */
export const AGENT_LANE_MAIN = CommandLane.Main;
export const AGENT_LANE_CRON = CommandLane.Cron;
export const AGENT_LANE_SUBAGENT = CommandLane.Subagent;
export const AGENT_LANE_NESTED = CommandLane.Nested;

/**
 * Compute the per-session lane id for a session key. Channel-routed turns
 * pass `session:<sessionKey>` so each peer gets its own FIFO queue;
 * different peers run concurrently.
 */
export function sessionLane(sessionKey: string): string {
	return `session:${sessionKey}`;
}

/**
 * Per-parent sub-agent lane id. Each parent session gets its own FIFO
 * lane (`subagent:<parentSessionKey>`) so spawns from different parents
 * never block one another. The PROCESS-WIDE in-flight cap lives outside
 * the lane engine — see `agents/subagent-budget.ts` for the semaphore the
 * gateway pushes `resolveSubagentMaxConcurrent(cfg)` into.
 */
export function subagentLane(parentSessionKey: string | undefined | null): string {
	const trimmed = (parentSessionKey ?? "").trim();
	return trimmed ? `subagent:${trimmed}` : CommandLane.Subagent;
}

/**
 * Per-parent A2A / nested lane id. Same shape as `subagentLane` but keyed
 * for cross-session sends originated by the same caller so a chatty caller
 * doesn't starve siblings.
 */
export function nestedLane(parentSessionKey: string | undefined | null): string {
	const trimmed = (parentSessionKey ?? "").trim();
	return trimmed ? `nested:${trimmed}` : CommandLane.Nested;
}

/**
 * Run `work` on the named lane. Resolves with the work's result. Backed
 * by the generation-aware engine in `./command-queue.js` — same FIFO
 * semantics as before, but a `resetAllLanes()` call (e.g. from a config
 * reload) no longer leaks stale active-task IDs that would block future
 * pumps.
 *
 * Concurrency:
 *   - Two `enqueueInLane(lane, ...)` calls on the SAME lane: the second
 *     awaits the first (when `maxConcurrent: 1`, the default).
 *   - Two calls on DIFFERENT lanes: run concurrently.
 */
export function enqueueInLane<T>(lane: CommandLaneId, work: () => Promise<T>): Promise<T> {
	return enqueueCommandInLane(lane, work);
}

/**
 * Combined depth (queued + active) of a lane. Used by the heartbeat
 * runner: if `Main` has pending work, skip the heartbeat and let it run
 * naturally. Returns 0 when the lane has never been used.
 */
export function getLaneQueueSize(lane: CommandLaneId): number {
	return getQueueSize(lane);
}

/**
 * Cancel every queued (not yet active) entry on a lane. Used by `/stop`
 * + by graceful-shutdown to refuse pending work. Active tasks keep
 * running. Returns the number of entries removed.
 */
export function clearLane(lane: CommandLaneId): number {
	return clearCommandLane(lane);
}

/** Test-only — hard reset of every lane's state. */
export function resetLanesForTests(): void {
	resetCommandQueueStateForTest();
}

/** Re-export the lower-level engine for callers that need maxConcurrent /
 *  drain-await / draining-flag control. */
export {
	CommandLaneClearedError,
	GatewayDrainingError,
	enqueueCommand,
	enqueueCommandInLane,
	getActiveTaskCount,
	getTotalQueueSize,
	markGatewayDraining,
	resetAllLanes,
	setCommandLaneConcurrency,
	waitForActiveTasks,
} from "./command-queue.js";
