import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Model } from "@mariozechner/pi-ai";

import { Carrow } from "./carrow.js";

const fakeModel = (reasoning: boolean): Model<never> =>
	({ id: "fake/model", model: "fake/model", reasoning }) as unknown as Model<never>;

describe("Carrow — cross-model continuity facade", () => {
	it("reanchorThinking forces 'off' for a non-reasoning target", () => {
		assert.equal(Carrow.reanchorThinking("high", fakeModel(false)), "off");
	});

	it("handoff NEXT-TURN: no active turn → setModel + switched=false + re-anchored thinking", async () => {
		let setTo: unknown;
		const session = {
			agent: { signal: undefined },
			setModel: async (m: unknown) => {
				setTo = m;
			},
		} as unknown as Parameters<typeof Carrow.handoff>[0];
		const target = fakeModel(false);
		const r = await Carrow.handoff(session, target, { currentThinking: "high" });
		assert.equal(r.switched, false, "next-turn swap, not a mid-turn abort");
		assert.equal(setTo, target, "model swapped for the next turn");
		assert.equal(r.thinkingLevel, "off", "thinking re-anchored to what the non-reasoning target can honor");
	});

	it("handoff MID-TURN: active turn + last message → abort → swap → replay (switched=true)", async () => {
		const calls: string[] = [];
		const session = {
			agent: { signal: {} }, // truthy ⇒ a turn is in flight
			subscribe: (cb: (ev: { type?: string }) => void) => {
				setTimeout(() => cb({ type: "agent_end" }), 0); // settle the abort
				return () => {};
			},
			abort: async () => {
				calls.push("abort");
			},
			setModel: async () => {
				calls.push("setModel");
			},
			prompt: async (_t: string) => {
				calls.push("prompt");
			},
		} as unknown as Parameters<typeof Carrow.handoff>[0];
		const r = await Carrow.handoff(session, fakeModel(true), { lastUserMessage: "continue the task" });
		assert.equal(r.switched, true, "mid-turn handoff occurred");
		assert.deepEqual(calls, ["abort", "setModel", "prompt"], "abort → swap → replay sequence");
	});
});
