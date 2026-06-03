import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
	MAX_SCHEDULE_ERRORS,
	STUCK_RUN_MS,
	applyJobPatch,
	applyJobResult,
	assertSupportedJobSpec,
	computeJobNextRunAtMs,
	createJob,
	errorBackoffMs,
	normalizeJobTickState,
	recordScheduleComputeError,
} from "./jobs.js";
import type { CronJobCreate } from "../types.js";

const BASE_NOW = 1_730_000_000_000; // 2024-10-27ish; arbitrary fixed stamp

function buildBaseAgentTurnCreate(): CronJobCreate {
	return {
		name: "test-job",
		enabled: true,
		schedule: { kind: "every", everyMs: 60_000 },
		sessionTarget: "isolated",
		payload: { kind: "agentTurn", message: "do the thing" },
	};
}

describe("createJob", () => {
	it("assigns a uuid id and stamps createdAt/updatedAt/timestamps", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		assert.equal(typeof job.id, "string");
		assert.equal(job.id.length >= 32, true, "uuid v4 is at least 32 chars including dashes");
		assert.equal(job.createdAtMs, BASE_NOW);
		assert.equal(job.updatedAtMs, BASE_NOW);
		assert.equal(typeof job.state.nextRunAtMs, "number");
		assert.equal(job.state.nextRunAtMs! > BASE_NOW, true);
	});

	it("rejects main+agentTurn pairing", () => {
		const create: CronJobCreate = {
			...buildBaseAgentTurnCreate(),
			sessionTarget: "main",
		};
		assert.throws(() => createJob(create, BASE_NOW), /sessionTarget "main" requires payload\.kind "systemEvent"/);
	});

	it("rejects isolated+systemEvent pairing", () => {
		const create: CronJobCreate = {
			...buildBaseAgentTurnCreate(),
			payload: { kind: "systemEvent", text: "ping" },
		};
		assert.throws(() => createJob(create, BASE_NOW), /sessionTarget "isolated"/);
	});
});

describe("assertSupportedJobSpec — session-id safety", () => {
	it("rejects session:<empty>", () => {
		assert.throws(
			() =>
				assertSupportedJobSpec({
					sessionTarget: "session:",
					payload: { kind: "agentTurn", message: "x" },
				}),
			/must not be empty/,
		);
	});

	it("rejects session ids containing path separators", () => {
		assert.throws(
			() =>
				assertSupportedJobSpec({
					sessionTarget: "session:foo/bar",
					payload: { kind: "agentTurn", message: "x" },
				}),
			/path separators/,
		);
		assert.throws(
			() =>
				assertSupportedJobSpec({
					sessionTarget: "session:foo\\bar",
					payload: { kind: "agentTurn", message: "x" },
				}),
			/path separators/,
		);
	});

	it("accepts a clean session:<id>", () => {
		assert.doesNotThrow(() =>
			assertSupportedJobSpec({
				sessionTarget: "session:nightly",
				payload: { kind: "agentTurn", message: "x" },
			}),
		);
	});

	it("accepts 'current' paired with agentTurn (defensive — normally resolved earlier)", () => {
		assert.doesNotThrow(() =>
			assertSupportedJobSpec({
				sessionTarget: "current",
				payload: { kind: "agentTurn", message: "x" },
			}),
		);
	});

	it("rejects 'current' paired with systemEvent (isolated-like family)", () => {
		assert.throws(
			() =>
				assertSupportedJobSpec({
					sessionTarget: "current",
					payload: { kind: "systemEvent", text: "x" },
				}),
			/"current"|agentTurn/,
		);
	});
});

describe("computeJobNextRunAtMs — kind: every", () => {
	it("anchors at job creation time when anchorMs omitted", () => {
		const job = createJob(
			{ ...buildBaseAgentTurnCreate(), schedule: { kind: "every", everyMs: 5_000 } },
			BASE_NOW,
		);
		assert.equal(job.state.nextRunAtMs, BASE_NOW + 5_000);
	});

	it("uses explicit anchorMs when provided", () => {
		const job = createJob(
			{
				...buildBaseAgentTurnCreate(),
				schedule: { kind: "every", everyMs: 5_000, anchorMs: BASE_NOW - 12_500 },
			},
			BASE_NOW,
		);
		// Anchor at BASE_NOW - 12_500; with 5s step we land at ceil(12500/5000) = 3 steps forward.
		assert.equal(job.state.nextRunAtMs, BASE_NOW - 12_500 + 3 * 5_000);
	});
});

describe("computeJobNextRunAtMs — kind: at", () => {
	it("returns the at time when in the future", () => {
		const future = BASE_NOW + 10_000;
		const job = createJob(
			{ ...buildBaseAgentTurnCreate(), schedule: { kind: "at", at: future } },
			BASE_NOW,
		);
		assert.equal(job.state.nextRunAtMs, future);
	});

	it("returns undefined when the at time is already past", () => {
		const past = BASE_NOW - 10_000;
		const job = createJob(
			{ ...buildBaseAgentTurnCreate(), schedule: { kind: "at", at: past } },
			BASE_NOW,
		);
		assert.equal(job.state.nextRunAtMs, undefined);
	});
});

describe("computeJobNextRunAtMs — disabled jobs", () => {
	it("returns undefined when the job is disabled", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const disabled = { ...job, enabled: false };
		assert.equal(computeJobNextRunAtMs(disabled, BASE_NOW), undefined);
	});
});

describe("normalizeJobTickState — stuck-run detection", () => {
	it("clears runningAtMs when older than STUCK_RUN_MS", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const stuck = {
			...job,
			state: { ...job.state, runningAtMs: BASE_NOW - (STUCK_RUN_MS + 1000) },
		};
		const { job: normalized, changed } = normalizeJobTickState(stuck, BASE_NOW);
		assert.equal(changed, true);
		assert.equal(normalized.state.runningAtMs, undefined);
	});

	it("leaves runningAtMs alone when within the threshold", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const recent = {
			...job,
			state: { ...job.state, runningAtMs: BASE_NOW - 60_000 },
		};
		const { job: normalized } = normalizeJobTickState(recent, BASE_NOW);
		assert.equal(normalized.state.runningAtMs, BASE_NOW - 60_000);
	});
});

describe("applyJobResult — success path", () => {
	it("clears runningAtMs and stamps lastRunAtMs/lastStatus on ok", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const before = { ...job, state: { ...job.state, runningAtMs: BASE_NOW } };
		const { job: after, deleteAfterApply } = applyJobResult(before, {
			status: "ok",
			startedAtMs: BASE_NOW,
			endedAtMs: BASE_NOW + 1000,
		});
		assert.equal(after.state.runningAtMs, undefined);
		assert.equal(after.state.lastStatus, "ok");
		assert.equal(after.state.lastRunAtMs, BASE_NOW);
		assert.equal(after.state.consecutiveErrorCount, 0);
		assert.equal(deleteAfterApply, false);
	});

	it("disables one-shot at-jobs after success", () => {
		const future = BASE_NOW + 10_000;
		const job = createJob(
			{
				...buildBaseAgentTurnCreate(),
				deleteAfterRun: false,
				schedule: { kind: "at", at: future },
			},
			BASE_NOW,
		);
		const { job: after, deleteAfterApply } = applyJobResult(job, {
			status: "ok",
			startedAtMs: future,
			endedAtMs: future + 100,
		});
		assert.equal(after.enabled, false);
		assert.equal(after.state.nextRunAtMs, undefined);
		assert.equal(deleteAfterApply, false);
	});

	it("flags deleteAfterApply for one-shot with deleteAfterRun: true on ok", () => {
		const future = BASE_NOW + 10_000;
		const job = createJob(
			{
				...buildBaseAgentTurnCreate(),
				deleteAfterRun: true,
				schedule: { kind: "at", at: future },
			},
			BASE_NOW,
		);
		const { deleteAfterApply } = applyJobResult(job, {
			status: "ok",
			startedAtMs: future,
			endedAtMs: future + 100,
		});
		assert.equal(deleteAfterApply, true);
	});
});

describe("applyJobResult — error path", () => {
	it("increments consecutiveErrorCount and applies backoff", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const { job: after } = applyJobResult(job, {
			status: "error",
			startedAtMs: BASE_NOW,
			endedAtMs: BASE_NOW + 100,
			error: "boom",
			errorKind: "transient",
		});
		assert.equal(after.state.consecutiveErrorCount, 1);
		assert.equal(after.state.lastStatus, "error");
		assert.equal(after.state.lastError, "boom");
		assert.equal(
			after.state.nextRunAtMs! >= BASE_NOW + 100 + DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[0]!,
			true,
		);
	});

	it("disables the job on permanent error", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const { job: after } = applyJobResult(job, {
			status: "error",
			startedAtMs: BASE_NOW,
			endedAtMs: BASE_NOW + 100,
			error: "config invalid",
			errorKind: "permanent",
		});
		assert.equal(after.enabled, false);
		assert.equal(after.state.nextRunAtMs, undefined);
	});

	it("backoff schedule indexes correctly and caps at the last entry", () => {
		assert.equal(errorBackoffMs(0), 0);
		assert.equal(errorBackoffMs(1), DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[0]);
		assert.equal(errorBackoffMs(2), DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[1]);
		assert.equal(
			errorBackoffMs(99),
			DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.length - 1],
		);
	});
});

describe("recordScheduleComputeError", () => {
	it("auto-disables the job after MAX_SCHEDULE_ERRORS consecutive failures", () => {
		let job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		for (let i = 0; i < MAX_SCHEDULE_ERRORS - 1; i++) {
			job = recordScheduleComputeError(job, "parse error");
		}
		assert.equal(job.enabled, true, "still enabled before final error");
		job = recordScheduleComputeError(job, "parse error");
		assert.equal(job.enabled, false, "auto-disabled at the threshold");
		assert.equal(job.state.nextRunAtMs, undefined);
		assert.equal(job.state.scheduleErrorCount, MAX_SCHEDULE_ERRORS);
	});
});

describe("applyJobPatch", () => {
	it("validates new sessionTarget/payload pairing on update", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		assert.throws(
			() => applyJobPatch(job, { sessionTarget: "main" }, BASE_NOW),
			/sessionTarget "main"/,
		);
	});

	it("recomputes nextRunAtMs when the schedule changes", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const patched = applyJobPatch(
			job,
			{ schedule: { kind: "every", everyMs: 1_000 } },
			BASE_NOW + 100,
		);
		// New step is 1s starting from BASE_NOW+100; nextRunAtMs should be
		// recomputed off the new schedule (not the old 60s one).
		assert.equal(typeof patched.state.nextRunAtMs, "number");
		assert.notEqual(patched.state.nextRunAtMs, job.state.nextRunAtMs);
	});

	it("clears nextRunAtMs when disabled", () => {
		const job = createJob(buildBaseAgentTurnCreate(), BASE_NOW);
		const patched = applyJobPatch(job, { enabled: false }, BASE_NOW + 100);
		assert.equal(patched.state.nextRunAtMs, undefined);
	});
});
