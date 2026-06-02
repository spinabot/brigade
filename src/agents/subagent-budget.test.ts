/**
 * Process-wide sub-agent budget semaphore — fairness + cap tests.
 *
 * Brigade routes sub-agents onto per-parent lanes for isolation but relies
 * on this semaphore for the GLOBAL cap that the upstream reference codebase
 * gets from `setCommandLaneConcurrency(CommandLane.Subagent, ...)`.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	acquireSubagentSlot,
	getSubagentBudget,
	getSubagentInFlight,
	releaseSubagentSlot,
	resetSubagentBudgetForTests,
	setSubagentBudget,
	withSubagentSlot,
} from "./subagent-budget.js";

afterEach(() => resetSubagentBudgetForTests());

describe("subagent-budget — defaults", () => {
	it("starts with a permissive cap of 1_000", () => {
		assert.equal(getSubagentBudget(), 1_000);
		assert.equal(getSubagentInFlight(), 0);
	});
});

describe("subagent-budget — setSubagentBudget", () => {
	it("clamps the cap to >= 1", () => {
		setSubagentBudget(0);
		assert.equal(getSubagentBudget(), 1);
		setSubagentBudget(-5);
		assert.equal(getSubagentBudget(), 1);
	});
	it("floors fractional values", () => {
		setSubagentBudget(3.9);
		assert.equal(getSubagentBudget(), 3);
	});
});

describe("subagent-budget — acquire/release semaphore", () => {
	it("admits up to `max` callers immediately", async () => {
		setSubagentBudget(2);
		await acquireSubagentSlot();
		await acquireSubagentSlot();
		assert.equal(getSubagentInFlight(), 2);
	});

	it("blocks the third caller until a slot is released", async () => {
		setSubagentBudget(2);
		await acquireSubagentSlot();
		await acquireSubagentSlot();

		let thirdResolved = false;
		const third = acquireSubagentSlot().then(() => {
			thirdResolved = true;
		});
		// Give the event loop a tick — third should still be blocked.
		await new Promise((r) => setImmediate(r));
		assert.equal(thirdResolved, false);
		assert.equal(getSubagentInFlight(), 2);

		// Releasing wakes the waiter, in-flight count stays at 2.
		releaseSubagentSlot();
		await third;
		assert.equal(thirdResolved, true);
		assert.equal(getSubagentInFlight(), 2);
	});

	it("waiters are woken FIFO", async () => {
		setSubagentBudget(1);
		await acquireSubagentSlot();
		const order: number[] = [];
		const w1 = acquireSubagentSlot().then(() => order.push(1));
		const w2 = acquireSubagentSlot().then(() => order.push(2));
		const w3 = acquireSubagentSlot().then(() => order.push(3));
		releaseSubagentSlot();
		await w1;
		releaseSubagentSlot();
		await w2;
		releaseSubagentSlot();
		await w3;
		assert.deepEqual(order, [1, 2, 3]);
	});
});

describe("subagent-budget — withSubagentSlot", () => {
	it("acquires + releases automatically (happy path)", async () => {
		setSubagentBudget(1);
		await withSubagentSlot(async () => {
			assert.equal(getSubagentInFlight(), 1);
		});
		assert.equal(getSubagentInFlight(), 0);
	});

	it("releases the slot even if the wrapped function throws", async () => {
		setSubagentBudget(1);
		await assert.rejects(
			withSubagentSlot(async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal(getSubagentInFlight(), 0);
	});

	it("serialises two parents sharing one slot (global cap)", async () => {
		setSubagentBudget(1);
		const order: string[] = [];

		async function parentTurn(label: string) {
			await withSubagentSlot(async () => {
				order.push(`${label}-enter`);
				await new Promise((r) => setImmediate(r));
				order.push(`${label}-exit`);
			});
		}

		await Promise.all([parentTurn("A"), parentTurn("B")]);
		// The exit/enter ordering proves the second parent was held off until
		// the first one released the slot.
		assert.deepEqual(order, ["A-enter", "A-exit", "B-enter", "B-exit"]);
	});
});

describe("subagent-budget — setSubagentBudget wakes waiters when raised", () => {
	it("admits queued waiters when the cap rises", async () => {
		setSubagentBudget(1);
		await acquireSubagentSlot();
		let secondWoken = false;
		const second = acquireSubagentSlot().then(() => {
			secondWoken = true;
		});
		// Raise the cap; the waiter should be admitted.
		setSubagentBudget(2);
		await second;
		assert.equal(secondWoken, true);
		assert.equal(getSubagentInFlight(), 2);
	});
});

describe("subagent-budget — two-parent isolation through per-parent lanes", () => {
	// This isn't testing the semaphore directly; it's checking that two
	// independent parents BOTH can hold a slot when the cap allows.
	it("two parents each holding a slot count toward in-flight", async () => {
		setSubagentBudget(2);
		await acquireSubagentSlot();
		await acquireSubagentSlot();
		assert.equal(getSubagentInFlight(), 2);
		// A third spawn (from EITHER parent) is now gated until one releases.
		let third = false;
		const w = acquireSubagentSlot().then(() => {
			third = true;
		});
		await new Promise((r) => setImmediate(r));
		assert.equal(third, false);
		releaseSubagentSlot();
		await w;
		assert.equal(third, true);
	});
});
