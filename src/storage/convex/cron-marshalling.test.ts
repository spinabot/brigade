import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { __cronMarshalling } from "./cron-store.js";
import type { CronJob } from "../../cron/types.js";

// Hermetic: a real operator key file (auto-created by convex onboarding)
// must not leak into the "no key" cases — point the file lookup nowhere.
process.env.BRIGADE_ENCRYPTION_KEY_FILE = path.join(tmpdir(), "brigade-no-such-key-file");

// Round-trip coverage for the cronJobs flatten/rebuild marshalling. This is
// the seam that broke "zero jobs survive a restart in convex mode": insertJob
// used to drop schedule details / delivery / createdBy / state, and the list
// path cast raw rows (scheduleKind never rebuilt into `schedule`, sealed
// payload bytes never opened). A column round-trip MUST reproduce the job
// byte-for-shape, including state clears.

const {
	jobToColumns,
	rowToJob,
	statePartialDelta,
	stateFullDelta,
	flattenSchedule,
	rebuildSchedule,
} = __cronMarshalling;

function baseJob(overrides: Partial<CronJob>): CronJob {
	return {
		id: "job-1",
		name: "nightly",
		enabled: true,
		schedule: { kind: "at", at: 1_000 },
		sessionTarget: "isolated",
		payload: { kind: "agentTurn", message: "run the backup" },
		createdAtMs: 100,
		updatedAtMs: 200,
		state: {},
		...overrides,
	} as CronJob;
}

/** A column object is shaped exactly like a Convex row, so feeding it straight
 *  into rowToJob exercises the full insert→read path without a live client. */
function roundTrip(job: CronJob): CronJob {
	return rowToJob(jobToColumns(job) as Record<string, unknown>) as unknown as CronJob;
}

describe("cron marshalling — schedule round-trip", () => {
	afterEach(() => {
		delete process.env.BRIGADE_ENCRYPTION_KEY;
	});

	it("preserves a cron-expression schedule with tz + stagger", () => {
		const job = baseJob({
			schedule: { kind: "cron", expr: "0 3 * * *", tz: "America/New_York", staggerMs: 5_000 },
		});
		assert.deepEqual(roundTrip(job).schedule, job.schedule);
	});

	it("preserves an interval schedule with anchor", () => {
		const job = baseJob({ schedule: { kind: "every", everyMs: 60_000, anchorMs: 42 } });
		assert.deepEqual(roundTrip(job).schedule, job.schedule);
	});

	it("preserves a one-shot schedule", () => {
		const job = baseJob({ schedule: { kind: "at", at: 9_999 } });
		assert.deepEqual(roundTrip(job).schedule, job.schedule);
	});

	it("omits absent optional schedule fields (no tz/stagger keys leak back)", () => {
		const job = baseJob({ schedule: { kind: "cron", expr: "* * * * *" } });
		const back = roundTrip(job).schedule as unknown as Record<string, unknown>;
		assert.equal("tz" in back, false);
		assert.equal("staggerMs" in back, false);
	});

	it("flatten→rebuild is identity for every kind", () => {
		for (const schedule of [
			{ kind: "cron", expr: "0 0 * * *" },
			{ kind: "every", everyMs: 1000 },
			{ kind: "at", at: 5 },
		] as CronJob["schedule"][]) {
			assert.deepEqual(rebuildSchedule(flattenSchedule(schedule)), schedule);
		}
	});
});

describe("cron marshalling — createdBy round-trip", () => {
	it("preserves an owner origin", () => {
		const job = baseJob({ createdBy: { kind: "owner" } });
		assert.deepEqual(roundTrip(job).createdBy, { kind: "owner" });
	});

	it("preserves a channel origin with accountId", () => {
		const job = baseJob({
			createdBy: { kind: "channel", channelId: "whatsapp", conversationId: "123@s", accountId: "acct-1" },
		});
		assert.deepEqual(roundTrip(job).createdBy, job.createdBy);
	});

	it("a channel origin without accountId round-trips without leaking the key", () => {
		const job = baseJob({
			createdBy: { kind: "channel", channelId: "telegram", conversationId: "c9" },
		});
		const back = roundTrip(job).createdBy as Record<string, unknown>;
		assert.equal("accountId" in back, false);
	});

	it("an undefined origin maps to legacy on write and back to undefined on read", () => {
		const job = baseJob({});
		delete (job as { createdBy?: unknown }).createdBy;
		const cols = jobToColumns(job);
		assert.equal(cols.createdByKind, "legacy");
		assert.equal(roundTrip(job).createdBy, undefined);
	});
});

describe("cron marshalling — state deltas", () => {
	it("full round-trip of every state field", () => {
		const job = baseJob({
			state: {
				nextRunAtMs: 1,
				lastRunAtMs: 2,
				runningAtMs: 3,
				lastStatus: "ok",
				lastError: "boom",
				scheduleErrorCount: 4,
				consecutiveErrorCount: 5,
				lastFailureAlertAtMs: 6,
				lastDelivered: true,
				lastDeliveryStatus: "delivered",
				lastDeliveryError: "nope",
			},
		});
		assert.deepEqual(roundTrip(job).state, job.state);
	});

	it("partial delta sets present-with-value and unsets present-undefined only", () => {
		const { set, unset } = statePartialDelta({
			lastStatus: "ok",
			runningAtMs: undefined, // explicit clear (run finished)
		});
		assert.deepEqual(set, { stateLastStatus: "ok" });
		assert.deepEqual(unset, ["stateRunningAtMs"]);
	});

	it("partial delta ignores absent keys entirely", () => {
		const { set, unset } = statePartialDelta({ nextRunAtMs: 50 });
		assert.deepEqual(set, { stateNextRunAtMs: 50 });
		assert.deepEqual(unset, []);
	});

	it("full delta unsets every column absent from the state object", () => {
		const { set, unset } = stateFullDelta({ nextRunAtMs: 7 });
		assert.deepEqual(set, { stateNextRunAtMs: 7 });
		// 11 total columns, 1 set → 10 unset.
		assert.equal(unset.length, 10);
		assert.equal(unset.includes("stateRunningAtMs"), true);
		assert.equal(unset.includes("stateNextRunAtMs"), false);
	});
});

describe("cron marshalling — payload + delivery", () => {
	afterEach(() => {
		delete process.env.BRIGADE_ENCRYPTION_KEY;
	});

	it("round-trips payload + delivery in plaintext (no key)", () => {
		const job = baseJob({
			payload: { kind: "agentTurn", message: "hi", model: "claude-opus-4-7" },
			delivery: { mode: "announce", channel: "whatsapp", to: "123@s" },
		});
		const back = roundTrip(job);
		assert.deepEqual(back.payload, job.payload);
		assert.deepEqual(back.delivery, job.delivery);
	});

	it("round-trips payload + delivery through the encryption seal", () => {
		process.env.BRIGADE_ENCRYPTION_KEY = "a".repeat(64);
		const job = baseJob({
			payload: { kind: "systemEvent", text: "secret reminder" },
			delivery: { mode: "webhook", webhookUrl: "https://example.test/hook" },
		});
		const cols = jobToColumns(job) as Record<string, unknown>;
		// Sealed bytes must NOT contain the plaintext.
		const payloadBytes = Buffer.from(cols.payload as ArrayBuffer);
		assert.equal(payloadBytes.includes(Buffer.from("secret reminder")), false);
		const back = rowToJob(cols) as unknown as CronJob;
		assert.deepEqual(back.payload, job.payload);
		assert.deepEqual(back.delivery, job.delivery);
	});

	it("omits delivery entirely when the job has none", () => {
		const job = baseJob({});
		const cols = jobToColumns(job);
		assert.equal("delivery" in cols, false);
		assert.equal("delivery" in roundTrip(job), false);
	});
});

describe("cron marshalling — full job identity", () => {
	it("a fully-populated job survives a column round-trip unchanged", () => {
		const job = baseJob({
			id: "job-xyz",
			name: "digest",
			description: "morning digest",
			enabled: false,
			agentId: "main",
			sessionKey: "agent:main:main",
			schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC", staggerMs: 1000 },
			sessionTarget: "session:abc",
			wakeMode: "now",
			payload: { kind: "agentTurn", message: "summarise inbox", lightContext: true },
			delivery: { mode: "announce", channel: "whatsapp", to: "1@s", bestEffort: true },
			failureAlert: { after: 3, channel: "whatsapp", to: "1@s" },
			deleteAfterRun: false,
			createdBy: { kind: "channel", channelId: "whatsapp", conversationId: "1@s" },
			createdAtMs: 111,
			updatedAtMs: 222,
			state: { nextRunAtMs: 333, lastStatus: "error", consecutiveErrorCount: 2 },
		});
		assert.deepEqual(roundTrip(job), job);
	});
});
