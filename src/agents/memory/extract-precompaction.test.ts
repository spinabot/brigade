import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	type PreCompactionExtractionArgs,
	runPreCompactionExtraction,
	setPreCompactionExtractionHook,
} from "./extract.js";

describe("pre-compaction extraction hook", () => {
	afterEach(() => {
		setPreCompactionExtractionHook(undefined); // never leak the module singleton across tests
	});

	it("invokes the registered hook with the passed args (fire-and-forget)", async () => {
		let captured: PreCompactionExtractionArgs | undefined;
		let resolveCalled!: () => void;
		const called = new Promise<void>((r) => {
			resolveCalled = r;
		});
		setPreCompactionExtractionHook(async (args) => {
			captured = args;
			resolveCalled();
		});
		runPreCompactionExtraction({
			agentId: "main",
			sessionId: "s1",
			messages: [{ role: "user" }],
			origin: { kind: "owner" },
		});
		await called;
		assert.equal(captured?.agentId, "main");
		assert.equal(captured?.sessionId, "s1");
		assert.deepEqual(captured?.origin, { kind: "owner" });
		assert.deepEqual(captured?.messages, [{ role: "user" }]);
	});

	it("is a no-op when no hook is registered", () => {
		setPreCompactionExtractionHook(undefined);
		assert.doesNotThrow(() =>
			runPreCompactionExtraction({ agentId: "a", sessionId: "s", messages: [], origin: { kind: "owner" } }),
		);
	});

	it("swallows a throwing hook (best-effort, never propagates synchronously)", async () => {
		setPreCompactionExtractionHook(async () => {
			throw new Error("boom");
		});
		// fire-and-forget — the synchronous call must not throw
		assert.doesNotThrow(() =>
			runPreCompactionExtraction({ agentId: "a", sessionId: "s", messages: [], origin: { kind: "owner" } }),
		);
		await new Promise((r) => setTimeout(r, 10)); // let the rejected microtask settle + be swallowed
	});
});
