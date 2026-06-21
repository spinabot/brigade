/**
 * session-reaper — retention parsing + isolated-cron-run key matching +
 * sweep-throttle gate.
 *
 * The actual `reapIsolatedCronSessions` sweep touches the on-disk session
 * store and transcript files; we exercise the small parsers + matchers
 * here without spinning a real session store.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	DEFAULT_RETENTION_MS,
	MIN_SWEEP_INTERVAL_MS,
	isIsolatedCronRunSessionKey,
	isThreadSessionKey,
	parseSessionRetention,
	shouldRunSweep,
} from "./session-reaper.js";

describe("session-reaper — parseSessionRetention", () => {
	it("`false` disables pruning entirely", () => {
		assert.equal(parseSessionRetention(false), null);
	});

	it("undefined → default (24h)", () => {
		assert.equal(parseSessionRetention(undefined), DEFAULT_RETENTION_MS);
	});

	it("empty / whitespace → default", () => {
		assert.equal(parseSessionRetention(""), DEFAULT_RETENTION_MS);
		assert.equal(parseSessionRetention("   "), DEFAULT_RETENTION_MS);
	});

	it("parses numeric + unit suffix", () => {
		assert.equal(parseSessionRetention("1h"), 60 * 60 * 1000);
		assert.equal(parseSessionRetention("30m"), 30 * 60 * 1000);
		assert.equal(parseSessionRetention("7d"), 7 * 86_400_000);
		assert.equal(parseSessionRetention("2w"), 2 * 604_800_000);
	});

	it("unknown unit falls back to default", () => {
		assert.equal(parseSessionRetention("3y"), DEFAULT_RETENTION_MS);
	});

	it("garbage string falls back to default", () => {
		assert.equal(parseSessionRetention("not a duration"), DEFAULT_RETENTION_MS);
	});
});

describe("session-reaper — isIsolatedCronRunSessionKey", () => {
	it("matches the per-fire cron-run pattern", () => {
		assert.equal(isIsolatedCronRunSessionKey("cron:job-1:run:abc-uuid"), true);
		assert.equal(
			isIsolatedCronRunSessionKey("agent:main:cron:job-1:run:abc-uuid"),
			true,
		);
	});

	it("does NOT match base cron session keys (preserved indefinitely)", () => {
		assert.equal(isIsolatedCronRunSessionKey("cron:job-1"), false);
		assert.equal(isIsolatedCronRunSessionKey("cron:job-1:named-target"), false);
	});

	it("does NOT match unrelated session keys", () => {
		assert.equal(isIsolatedCronRunSessionKey("agent:main:main"), false);
		assert.equal(isIsolatedCronRunSessionKey("whatsapp:thread:abc"), false);
	});
});

describe("session-reaper — isThreadSessionKey", () => {
	it("matches a channel-thread session key (`:thread:<id>` suffix)", () => {
		assert.equal(isThreadSessionKey("agent:main:telegram:555:thread:88"), true);
		assert.equal(isThreadSessionKey("telegram:peer:thread:topic-12"), true);
	});

	it("does NOT match a base (non-thread) session key", () => {
		assert.equal(isThreadSessionKey("agent:main:telegram:555"), false);
		assert.equal(isThreadSessionKey("agent:main:main"), false);
	});

	it("does NOT match cron-run keys (those are the other reaper's job)", () => {
		assert.equal(isThreadSessionKey("cron:job-1:run:abc"), false);
	});
});

describe("session-reaper — shouldRunSweep", () => {
	it("first call always runs (lastSweepAtMs undefined)", () => {
		assert.equal(shouldRunSweep(undefined, Date.now()), true);
	});

	it("runs again once MIN_SWEEP_INTERVAL_MS has elapsed", () => {
		const now = Date.now();
		assert.equal(shouldRunSweep(now - MIN_SWEEP_INTERVAL_MS - 1, now), true);
	});

	it("skips before the interval has elapsed", () => {
		const now = Date.now();
		assert.equal(shouldRunSweep(now - 1000, now), false);
	});
});
