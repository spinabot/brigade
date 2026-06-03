/**
 * Wave N4 / Bug #7 — same-sessionKey 2nd client must queue on the session
 * lane, not get rejected with "a turn is already in progress".
 *
 * The gateway's prompt handler used to call `hasLiveSession(sessionKey)`
 * pre-flight and throw when a turn was already streaming on the same
 * session. That made same-session multi-client (TUI + connect, two web
 * clients on the same chat) impossible — the second client saw a hard
 * reject even though the session lane FIFO inside `runGatewayTurn`
 * would have queued + serialised them correctly.
 *
 * This test exercises the underlying lane primitive directly with the
 * exact `sessionLane(sessionKey)` discriminator the prompt handler uses,
 * confirming:
 *
 *   1. Two enqueues on the SAME session lane run serially (FIFO).
 *   2. Both complete — neither is rejected.
 *   3. Two enqueues on DIFFERENT session lanes run in parallel.
 *
 * It does NOT spin a real gateway server because the boot path requires
 * onboarding + auth (heavyweight, brittle). Verifying the lane primitive
 * is what the handler delegates to is enough — the handler change is a
 * one-line removal of the pre-flight check.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { enqueueInLane, resetLanesForTests, sessionLane } from "../process/lanes.js";

afterEach(() => {
	resetLanesForTests();
});

describe("Wave N4 — prompt handler delegates same-session serialisation to sessionLane FIFO", () => {
	it("two enqueues on the same session lane run serially and both complete", async () => {
		const events: string[] = [];
		const sessionKey = "agent:main:main";
		const lane = sessionLane(sessionKey);

		let releaseA: () => void = () => {};
		const aStarted = new Promise<void>((resolve) => {
			const work = enqueueInLane(lane, async () => {
				events.push("a:start");
				resolve();
				await new Promise<void>((r) => {
					releaseA = r;
				});
				events.push("a:end");
				return "A";
			});
			void work;
		});

		// Wait for A to start before enqueuing B so we exercise the
		// "live turn on this session" condition the old pre-flight would
		// have rejected.
		await aStarted;

		const bPromise = enqueueInLane(lane, async () => {
			events.push("b:start");
			events.push("b:end");
			return "B";
		});

		// B must NOT have started yet — same lane, FIFO. With the old
		// pre-flight, B would have errored instead.
		assert.deepEqual(events, ["a:start"]);

		releaseA();
		const bResult = await bPromise;

		assert.equal(bResult, "B");
		assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
	});

	it("two enqueues on different session lanes run in parallel", async () => {
		const events: string[] = [];
		const laneA = sessionLane("agent:main:main");
		const laneB = sessionLane("agent:ops:main");

		let releaseA: () => void = () => {};
		const aPromise = enqueueInLane(laneA, async () => {
			events.push("a:start");
			await new Promise<void>((r) => {
				releaseA = r;
			});
			events.push("a:end");
			return "A";
		});

		const bPromise = enqueueInLane(laneB, async () => {
			events.push("b:start");
			events.push("b:end");
			return "B";
		});

		// B should finish before A because it runs on its own lane.
		const bResult = await bPromise;
		assert.equal(bResult, "B");
		assert.deepEqual(events, ["a:start", "b:start", "b:end"]);

		releaseA();
		const aResult = await aPromise;
		assert.equal(aResult, "A");
		assert.deepEqual(events, ["a:start", "b:start", "b:end", "a:end"]);
	});

	it("third same-session enqueue still queues — N clients on one session all complete in order", async () => {
		const events: string[] = [];
		const lane = sessionLane("agent:main:main");

		const releases: Array<() => void> = [];
		const promises: Array<Promise<string>> = [];

		for (let i = 0; i < 3; i++) {
			const idx = i;
			promises.push(
				enqueueInLane(lane, async () => {
					events.push(`t${idx}:start`);
					await new Promise<void>((r) => releases.push(r));
					events.push(`t${idx}:end`);
					return `T${idx}`;
				}),
			);
		}

		// Only the first should have started — lane caps at maxConcurrent=1.
		// Give the event loop a tick so the first task actually runs.
		await new Promise<void>((r) => setImmediate(r));
		assert.deepEqual(events, ["t0:start"]);

		// Release in order; each release lets the next task start.
		for (let i = 0; i < 3; i++) {
			releases[i]!();
			// Wait for the i-th task to settle before checking next.
			await promises[i];
		}

		assert.deepEqual(events, [
			"t0:start",
			"t0:end",
			"t1:start",
			"t1:end",
			"t2:start",
			"t2:end",
		]);
	});
});
