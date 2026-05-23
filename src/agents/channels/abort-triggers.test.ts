import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isAbortTrigger } from "./abort-triggers.js";

describe("isAbortTrigger", () => {
	it("matches the canonical English triggers", () => {
		for (const t of ["stop", "STOP", "Stop", "/stop", "/Stop", "cancel", "abort", "halt", "wait"]) {
			assert.equal(isAbortTrigger(t), true, `should match "${t}"`);
		}
	});

	it("tolerates trailing punctuation", () => {
		assert.equal(isAbortTrigger("stop."), true);
		assert.equal(isAbortTrigger("stop!"), true);
		assert.equal(isAbortTrigger("stop!!!"), true);
		assert.equal(isAbortTrigger("/stop."), true);
	});

	it("matches a handful of non-English triggers", () => {
		for (const t of ["parar", "detener", "arrête", "stopp", "止まれ", "停止", "रुको"]) {
			assert.equal(isAbortTrigger(t), true, `should match "${t}"`);
		}
	});

	it("does not match a paragraph that contains 'stop' elsewhere", () => {
		assert.equal(isAbortTrigger("Please don't stop my long-running task now"), false);
		assert.equal(isAbortTrigger("stopwatch"), false);
		assert.equal(isAbortTrigger("the stop sign was red"), false);
	});

	it("ignores empty / whitespace-only input", () => {
		assert.equal(isAbortTrigger(""), false);
		assert.equal(isAbortTrigger("   "), false);
	});
});
