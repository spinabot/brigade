/**
 * Global sub-agent spawn budget — process-wide semaphore.
 *
 * Brigade routes sub-agent runs onto per-parent lanes (`subagent:<parent>`)
 * so two parents never serialise behind one another. The per-parent lanes
 * each default to `maxConcurrent: 1` (strict FIFO inside a parent), so a
 * single parent's children still run one at a time — but two distinct
 * parents would run their children fully in parallel.
 *
 * Operators expect a GLOBAL cap so a fleet of parents can't blow past the
 * `agents.defaults.maxSubagentConcurrent` budget. The upstream reference
 * codebase achieves this by parking every spawn on a single global lane
 * (`CommandLane.Subagent`) governed by `setCommandLaneConcurrency`. Brigade
 * keeps the per-parent isolation AND honours the global cap via this small
 * semaphore: every spawn `acquireSubagentSlot()` before enqueuing, and
 * `releaseSubagentSlot()` after the gateway handoff returns.
 *
 * Defaults to a permissive cap (1_000) when the gateway never wires one.
 * `setSubagentBudget(n)` is called from `core/server-lanes.ts` at boot +
 * on `system.reload` with the resolved `resolveSubagentMaxConcurrent(cfg)`.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

interface BudgetState {
	max: number;
	inFlight: number;
	waiters: Array<() => void>;
}

const BUDGET_STATE_KEY = Symbol.for("brigade.subagentBudget");

function getState(): BudgetState {
	return resolveGlobalSingleton<BudgetState>(BUDGET_STATE_KEY, () => ({
		max: 1_000,
		inFlight: 0,
		waiters: [],
	}));
}

/** Push the resolved cap into the semaphore. Wakes any waiters that the new cap admits. */
export function setSubagentBudget(maxConcurrent: number): void {
	const state = getState();
	state.max = Math.max(1, Math.floor(maxConcurrent));
	while (state.inFlight < state.max && state.waiters.length > 0) {
		const waker = state.waiters.shift();
		if (!waker) break;
		state.inFlight += 1;
		waker();
	}
}

/** Read the current cap. */
export function getSubagentBudget(): number {
	return getState().max;
}

/** Current count of acquired slots. */
export function getSubagentInFlight(): number {
	return getState().inFlight;
}

/** Block (await) until a slot is free, then mark it acquired. */
export function acquireSubagentSlot(): Promise<void> {
	const state = getState();
	if (state.inFlight < state.max) {
		state.inFlight += 1;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		state.waiters.push(resolve);
	});
}

/** Release a previously-acquired slot. Wakes the next waiter (FIFO) if any. */
export function releaseSubagentSlot(): void {
	const state = getState();
	if (state.waiters.length > 0) {
		const waker = state.waiters.shift();
		if (waker) {
			// Slot stays "in flight" — handed off to the waiter without
			// decrementing the counter (would race with a fresh acquire).
			waker();
			return;
		}
	}
	state.inFlight = Math.max(0, state.inFlight - 1);
}

/** Run `fn` with a budget slot acquired; always releases (even on throw). */
export async function withSubagentSlot<T>(fn: () => Promise<T>): Promise<T> {
	await acquireSubagentSlot();
	try {
		return await fn();
	} finally {
		releaseSubagentSlot();
	}
}

/** Test-only: reset the semaphore to its boot defaults. */
export function resetSubagentBudgetForTests(): void {
	const state = getState();
	state.max = 1_000;
	state.inFlight = 0;
	state.waiters.length = 0;
}
