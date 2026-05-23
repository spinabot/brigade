import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { makeOpQueue, withTimeout } from "./extension-lifecycle.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withTimeout", () => {
	it("resolves with the value when the promise wins", async () => {
		assert.equal(await withTimeout(Promise.resolve(42), 1000, "x"), 42);
	});

	it("rejects with a labelled timeout error when the promise is too slow", async () => {
		await assert.rejects(() => withTimeout(tick(1000).then(() => "late"), 10, "start"), /start timed out after 10ms/);
	});

	it("propagates the promise's own rejection when it loses to nothing", async () => {
		await assert.rejects(() => withTimeout(Promise.reject(new Error("boom")), 1000, "x"), /boom/);
	});

	it("does NOT surface an unhandledRejection when the loser rejects after the timeout", async () => {
		let unhandled: unknown;
		const onUnhandled = (e: unknown) => {
			unhandled = e;
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			// Promise rejects AFTER the timeout already won.
			await assert.rejects(() => withTimeout(tick(50).then(() => Promise.reject(new Error("late"))), 5, "start"));
			await tick(120); // let the straggler reject + any unhandled fire
			assert.equal(unhandled, undefined, "late rejection must be handled by the race, not unhandled");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("makeOpQueue", () => {
	it("serializes ops — the second starts only after the first settles", async () => {
		const queue = makeOpQueue();
		const order: string[] = [];
		const a = queue(async () => {
			order.push("a-start");
			await tick(30);
			order.push("a-end");
		});
		const b = queue(async () => {
			order.push("b-start");
			await tick(5);
			order.push("b-end");
		});
		await Promise.all([a, b]);
		assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]); // strictly serial
	});

	it("a rejected op does NOT poison the chain — the next op still runs", async () => {
		const queue = makeOpQueue();
		await assert.rejects(() => queue(async () => Promise.reject(new Error("op1 failed"))));
		const result = await queue(async () => "op2 ran");
		assert.equal(result, "op2 ran");
	});

	it("propagates each op's own result/rejection to its caller", async () => {
		const queue = makeOpQueue();
		assert.equal(await queue(async () => "ok"), "ok");
		await assert.rejects(() => queue(async () => Promise.reject(new Error("mine"))), /mine/);
	});
});
