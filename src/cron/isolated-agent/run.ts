/**
 * Entry point for the cron service's "run an agentTurn job" dependency.
 *
 * This is the function that gets wired into `CronServiceDeps.runIsolatedAgentJob`
 * at gateway boot time. The cron service holds the call deliberately abstract
 * (`runIsolatedAgentJob?: (args) => Promise<CronIsolatedRunOutcome>`) so the
 * service layer is testable without standing up a real agent loop — tests
 * pass a fake that returns a deterministic outcome.
 *
 * Production wiring (in `core/server.ts` or equivalent boot path):
 *
 *   const cronState = createCronServiceState({
 *     deps: {
 *       ...,
 *       runIsolatedAgentJob: runCronIsolatedAgentJob,
 *     },
 *   });
 *
 * The implementation delegates to `executeCronIsolatedRun`, which dispatches by
 * payload kind — `agentTurn` → the full `runSingleTurn` integration (per-job
 * model / thinking / tools-allow / light-context), `script` → a shell run that
 * by default delivers output with no model turn (the cost-saver).
 */

import { executeCronIsolatedRun } from "./run-executor.js";
import type {
	CronIsolatedRunArgs,
	CronIsolatedRunOutcome,
} from "../service/state.js";

/** The dep callback signature documented in `CronServiceDeps`. */
export async function runCronIsolatedAgentJob(
	args: CronIsolatedRunArgs,
): Promise<CronIsolatedRunOutcome> {
	return executeCronIsolatedRun(args);
}
