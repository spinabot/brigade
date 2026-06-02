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
 *
 * P1#9 (Wave H) — pinned via `resolveGlobalSingleton` so dual-loaded
 * Brigade modules (test harness + runtime in one process; hot-reload in
 * dev) share ONE slot. Without the pin, every module copy would carry its
 * own `activeState` and the agent tool / gateway handler that imported a
 * different copy than the boot path would silently see `null`.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CronServiceState } from "./service/state.js";

type ActiveCronServiceState = { activeState: CronServiceState | null };

const ACTIVE_CRON_SERVICE_KEY = Symbol.for("brigade.cron.activeService");

function getState(): ActiveCronServiceState {
	return resolveGlobalSingleton<ActiveCronServiceState>(ACTIVE_CRON_SERVICE_KEY, () => ({
		activeState: null,
	}));
}

/** Set the process-wide active cron service. Gateway boot calls this once. */
export function setActiveCronService(state: CronServiceState | null): void {
	getState().activeState = state;
}

/** Read the active service. Returns `null` when no daemon has booted yet. */
export function getActiveCronService(): CronServiceState | null {
	return getState().activeState;
}

/** Resolve or throw — caller wants the service and wants a clear error otherwise. */
export function requireActiveCronService(): CronServiceState {
	const state = getState().activeState;
	if (!state) {
		throw new Error(
			"cron service not initialized — boot the gateway (or set a test fake) before calling this surface",
		);
	}
	return state;
}

/** Test-only — clear between cases. */
export function clearActiveCronServiceForTests(): void {
	getState().activeState = null;
}
