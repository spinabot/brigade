import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { formatWindowLabel, normalizePlanLimit, recordPlanLimit } from "./plan-limits.js";
import { getLimits, onLimitChange, resetLimitsForTest } from "../usage/limits.js";

beforeEach(() => resetLimitsForTest());

test("resetsAt is converted from epoch SECONDS to milliseconds", () => {
	// The CLI reports seconds. Stored unconverted, every reset instant lands in
	// January 1970 and a UI renders "resets 56 years ago".
	const sec = 1_800_000_000;
	const w = normalizePlanLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: sec });
	assert.equal(w?.resetsAt, sec * 1000);
	assert.ok(new Date(w!.resetsAt!).getUTCFullYear() > 2020, "must not be a 1970 date");
});

test("provider vocabulary is normalized onto the neutral status set", () => {
	// A client renders Claude plan windows, Anthropic token buckets and OpenAI
	// request buckets through one code path, so "allowed"/"rejected" must not
	// leak past this adapter.
	assert.equal(normalizePlanLimit({ rateLimitType: "five_hour", status: "allowed" })?.status, "ok");
	assert.equal(normalizePlanLimit({ rateLimitType: "five_hour", status: "rejected" })?.status, "exhausted");
	assert.equal(normalizePlanLimit({ rateLimitType: "five_hour", status: "weird" })?.status, "unknown");
	assert.equal(normalizePlanLimit({ rateLimitType: "five_hour", status: "allowed" })?.provider, "claude-cli");
});

test("a window is exhausted when either it or its overage path is rejected", () => {
	assert.equal(
		normalizePlanLimit({ rateLimitType: "five_hour", status: "allowed", overageStatus: "rejected" })?.status,
		"exhausted",
	);
});

test("a spent base allowance with overage still allowed is NOT exhausted", () => {
	// This account is still working. Showing it as blocked would tell the
	// operator to stop when they don't have to.
	const w = normalizePlanLimit({
		rateLimitType: "five_hour",
		status: "allowed",
		overageStatus: "allowed",
		isUsingOverage: true,
	});
	assert.equal(w?.status, "ok");
	assert.equal(w?.usingOverage, true);
});

test("an unidentifying block is ignored rather than overwriting a good observation", () => {
	recordPlanLimit({ rateLimitType: "five_hour", status: "allowed" });
	recordPlanLimit({});
	recordPlanLimit(undefined);
	const all = getLimits();
	assert.equal(all.length, 1);
	assert.equal(all[0]?.status, "ok");
});

test("windows are tracked independently by kind", () => {
	recordPlanLimit({ rateLimitType: "five_hour", status: "allowed" });
	recordPlanLimit({ rateLimitType: "seven_day", status: "rejected" });
	const byKind = Object.fromEntries(getLimits().map((w) => [w.kind, w]));
	assert.equal(byKind.five_hour?.status, "ok");
	assert.equal(byKind.seven_day?.status, "exhausted");
});

test("listeners fire on a meaningful change and stay quiet on a repeat", () => {
	// A backend that emits this frame every turn must not turn quota telemetry
	// into a broadcast storm.
	let calls = 0;
	onLimitChange(() => calls++);
	recordPlanLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: 1_800_000_000 });
	assert.equal(calls, 1, "first observation is a change");
	recordPlanLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: 1_800_000_000 });
	assert.equal(calls, 1, "an identical repeat is not a change");
	recordPlanLimit({ rateLimitType: "five_hour", status: "rejected", resetsAt: 1_800_000_000 });
	assert.equal(calls, 2, "status flipping to exhausted is a change");
});

test("a throwing listener cannot break the turn that produced the observation", () => {
	onLimitChange(() => {
		throw new Error("boom");
	});
	assert.doesNotThrow(() => recordPlanLimit({ rateLimitType: "five_hour", status: "allowed" }));
	assert.equal(getLimits().length, 1, "the observation is still recorded");
});

test("an unknown future window kind renders readably instead of being dropped", () => {
	assert.equal(formatWindowLabel("five_hour"), "5-hour window");
	assert.equal(formatWindowLabel("seven_day"), "7-day window");
	assert.equal(formatWindowLabel("thirty_day"), "thirty day");
	assert.equal(formatWindowLabel(""), "plan window");
});
