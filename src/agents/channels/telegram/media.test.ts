import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { withMediaRetry } from "./media.js";

describe("withMediaRetry", () => {
	it("returns the first successful result without retrying", async () => {
		let calls = 0;
		const out = await withMediaRetry(async () => {
			calls += 1;
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 1);
	});

	it("retries a transient failure and then succeeds", async () => {
		let calls = 0;
		const out = await withMediaRetry(async () => {
			calls += 1;
			if (calls < 3) throw new Error("transient");
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 3);
	});

	it("throws the last error after exhausting attempts (default 3)", async () => {
		let calls = 0;
		await assert.rejects(
			withMediaRetry(async () => {
				calls += 1;
				throw new Error(`fail-${calls}`);
			}),
			/fail-3/,
		);
		assert.equal(calls, 3);
	});

	it("honors a custom attempt count", async () => {
		let calls = 0;
		await assert.rejects(
			withMediaRetry(async () => {
				calls += 1;
				throw new Error("nope");
			}, 1),
		);
		assert.equal(calls, 1);
	});
});
