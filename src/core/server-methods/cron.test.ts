/**
 * Cron RPC handler tests (Wave N6).
 *
 * Tempdir-isolated; never touches `~/.brigade`. Each test builds a fresh
 * cron service state with a unique `storePath` so concurrent test files
 * don't collide.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	handleCronAdd,
	handleCronList,
	handleCronRemove,
	handleCronRun,
	handleCronRuns,
	handleCronStatus,
	handleCronUpdate,
	handleWake,
} from "./cron.js";
import {
	createCronServiceState,
	type CronServiceState,
	type CronSystemEventArgs,
} from "../../cron/service/state.js";
import { stopTimer } from "../../cron/service/timer.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";

interface Harness {
	state: CronServiceState;
	systemEvents: CronSystemEventArgs[];
	cleanup: () => void;
}

function makeHarness(): Harness {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-cron-rpc-test-"));
	const storePath = path.join(tempDir, "cron.json");
	const systemEvents: CronSystemEventArgs[] = [];
	const state = createCronServiceState({
		storePath,
		config: { enabled: true },
		deps: {
			log: createSubsystemLogger("cron-rpc-test"),
			enqueueSystemEvent: (args) => {
				systemEvents.push(args);
			},
			requestHeartbeatNow: () => {
				/* swallow */
			},
		},
	});
	return {
		state,
		systemEvents,
		cleanup: () => {
			stopTimer(state);
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

describe("cron RPC handlers — service-not-running guard", () => {
	it("cron.status throws when state is null", async () => {
		await assert.rejects(
			() => handleCronStatus(undefined, { state: null }),
			/not running/,
		);
	});

	it("cron.add throws when state is null", async () => {
		await assert.rejects(
			() =>
				handleCronAdd(
					{
						name: "x",
						schedule: { kind: "every", everyMs: 1000 },
						sessionTarget: "isolated",
						payload: { kind: "agentTurn", message: "x" },
					} as never,
					{ state: null },
				),
			/not running/,
		);
	});
});

describe("cron RPC handlers — happy paths", () => {
	it("cron.add → cron.list → cron.status returns sane shapes", async () => {
		const h = makeHarness();
		try {
			const job = await handleCronAdd(
				{
					name: "j1",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "do thing" },
				} as never,
				{ state: h.state },
			);
			assert.equal(typeof job.id, "string");
			assert.equal(job.name, "j1");
			const list = await handleCronList(undefined, { state: h.state });
			assert.equal(list.total, 1);
			assert.equal(list.jobs[0]!.id, job.id);
			const status = await handleCronStatus(undefined, { state: h.state });
			assert.equal(status.jobCount, 1);
		} finally {
			h.cleanup();
		}
	});

	it("cron.add with sessionTarget:'current' + sessionKey resolves to session:<key>", async () => {
		const h = makeHarness();
		try {
			const job = await handleCronAdd(
				{
					name: "ctx-job",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "current",
					sessionKey: "agent:main:peer-7",
					payload: { kind: "agentTurn", message: "x" },
				} as never,
				{ state: h.state },
			);
			assert.equal(job.sessionTarget, "session:agent:main:peer-7");
		} finally {
			h.cleanup();
		}
	});

	it("cron.update via 'jobId' field works", async () => {
		const h = makeHarness();
		try {
			const job = await handleCronAdd(
				{
					name: "j2",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				} as never,
				{ state: h.state },
			);
			const updated = await handleCronUpdate(
				{ jobId: job.id, patch: { enabled: false } },
				{ state: h.state },
			);
			assert.equal(updated.enabled, false);
		} finally {
			h.cleanup();
		}
	});

	it("cron.update via 'id' field also works (dual-key compat)", async () => {
		const h = makeHarness();
		try {
			const job = await handleCronAdd(
				{
					name: "j3",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				} as never,
				{ state: h.state },
			);
			const updated = await handleCronUpdate(
				{ id: job.id, patch: { enabled: false } },
				{ state: h.state },
			);
			assert.equal(updated.enabled, false);
		} finally {
			h.cleanup();
		}
	});

	it("cron.remove returns {removed: true} on success", async () => {
		const h = makeHarness();
		try {
			const job = await handleCronAdd(
				{
					name: "j4",
					schedule: { kind: "every", everyMs: 60_000 },
					sessionTarget: "isolated",
					payload: { kind: "agentTurn", message: "x" },
				} as never,
				{ state: h.state },
			);
			const res = await handleCronRemove({ id: job.id }, { state: h.state });
			assert.equal(res.removed, true);
			const after = await handleCronRemove({ id: job.id }, { state: h.state });
			assert.equal(after.removed, false);
		} finally {
			h.cleanup();
		}
	});

	it("cron.runs scope:'all' returns an empty list when nothing has run", async () => {
		const h = makeHarness();
		try {
			const res = await handleCronRuns({}, { state: h.state });
			assert.deepEqual(res.entries, []);
		} finally {
			h.cleanup();
		}
	});
});

describe("cron RPC handlers — validation", () => {
	it("cron.update without id/jobId throws INVALID_REQUEST-shaped error", async () => {
		const h = makeHarness();
		try {
			await assert.rejects(
				() => handleCronUpdate({ patch: {} } as never, { state: h.state }),
				/id or jobId required/,
			);
		} finally {
			h.cleanup();
		}
	});

	it("cron.update without patch throws", async () => {
		const h = makeHarness();
		try {
			await assert.rejects(
				() => handleCronUpdate({ id: "ghost" } as never, { state: h.state }),
				/patch required/,
			);
		} finally {
			h.cleanup();
		}
	});

	it("cron.remove without id throws", async () => {
		const h = makeHarness();
		try {
			await assert.rejects(
				() => handleCronRemove({} as never, { state: h.state }),
				/id or jobId required/,
			);
		} finally {
			h.cleanup();
		}
	});

	it("cron.run without id throws", async () => {
		const h = makeHarness();
		try {
			await assert.rejects(
				() => handleCronRun({} as never, { state: h.state }),
				/id or jobId required/,
			);
		} finally {
			h.cleanup();
		}
	});

	it("wake without text throws", async () => {
		const h = makeHarness();
		try {
			assert.throws(
				() => handleWake({ text: "  " } as never, { state: h.state }),
				/text required/,
			);
		} finally {
			h.cleanup();
		}
	});
});

describe("wake handler — enqueues system event", () => {
	it("queues into pendingSystemEvents (default mode)", () => {
		const h = makeHarness();
		try {
			handleWake({ text: "hello" }, { state: h.state });
			assert.equal(h.state.pendingSystemEvents.length >= 1, true);
		} finally {
			h.cleanup();
		}
	});
});
