/**
 * Process-wide active cron service singleton.
 *
 * The cron service is a singleton in Brigade's process model — the gateway
 * daemon owns ONE `CronServiceState` instance, constructed at boot and
 * wired with the real deps (`runIsolatedAgentJob`, `enqueueSystemEvent`,
 * etc.). Surfaces that need to reach the service — the agent-callable
 * `cron` tool, the gateway RPC handlers, the CLI commands — all look it
 * up here rather than threading the state through every callsite.
 *
 * Pattern mirrors `approval-bridge.ts`'s active-bridge singleton. Tests
 * set this to a fake state in `beforeEach` + null it in `afterEach` so a
 * stray test instance can't leak across suites.
 */

import type { CronServiceState } from "./service/state.js";

let activeState: CronServiceState | null = null;

/** Set the process-wide active cron service. Gateway boot calls this once. */
export function setActiveCronService(state: CronServiceState | null): void {
	activeState = state;
}

/** Read the active service. Returns `null` when no daemon has booted yet. */
export function getActiveCronService(): CronServiceState | null {
	return activeState;
}

/** Resolve or throw — caller wants the service and wants a clear error otherwise. */
export function requireActiveCronService(): CronServiceState {
	if (!activeState) {
		throw new Error(
			"cron service not initialized — boot the gateway (or set a test fake) before calling this surface",
		);
	}
	return activeState;
}

/** Test-only — clear between cases. */
export function clearActiveCronServiceForTests(): void {
	activeState = null;
}
