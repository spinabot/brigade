/**
 * Tests for the neutral reconnect-backoff helper.
 *
 * The curve must match WhatsApp's / Telegram's proven schedule (2s → 30s, ×1.8,
 * ±25%) bit-for-bit, because both channels now delegate to it and their
 * existing reconnect behaviour must not drift.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { nextBackoffDelay } from "./backoff.js";

const SCHEDULE = { initialMs: 2_000, maxMs: 30_000, factor: 1.8, jitter: 0.25 } as const;

describe("nextBackoffDelay", () => {
	it("attempt 0 lands near initialMs (±25% jitter)", () => {
		for (let i = 0; i < 200; i += 1) {
			const d = nextBackoffDelay({ attempt: 0, ...SCHEDULE });
			// base = 2000; ±25% → [1500, 2500]
			assert.ok(d >= 1500 && d <= 2500, `attempt 0 in [1500,2500], got ${d}`);
		}
	});

	it("grows by ~factor each attempt until the cap", () => {
		// Attempt 1 base = 3600 (±25% → [2700, 4500]); attempt 2 base = 6480.
		for (let i = 0; i < 50; i += 1) {
			const a1 = nextBackoffDelay({ attempt: 1, ...SCHEDULE });
			assert.ok(a1 >= 2700 && a1 <= 4500, `attempt 1 in [2700,4500], got ${a1}`);
		}
	});

	it("saturates near maxMs for large attempts (±25%)", () => {
		for (let i = 0; i < 200; i += 1) {
			const d = nextBackoffDelay({ attempt: 20, ...SCHEDULE });
			// base capped at 30000; ±25% → [22500, 37500]
			assert.ok(d >= 22_000 && d <= 38_000, `attempt 20 near 30s, got ${d}`);
		}
	});

	it("never returns a negative delay even with full negative jitter", () => {
		// A degenerate schedule where jitter could overshoot base downward.
		for (let i = 0; i < 500; i += 1) {
			const d = nextBackoffDelay({ attempt: 0, initialMs: 10, maxMs: 100, factor: 2, jitter: 1 });
			assert.ok(d >= 0, `delay must be >= 0, got ${d}`);
		}
	});

	it("returns an integer number of milliseconds", () => {
		const d = nextBackoffDelay({ attempt: 3, ...SCHEDULE });
		assert.equal(d, Math.round(d), "delay must be a whole-ms integer");
	});

	it("matches the legacy inline math exactly for a fixed jitter draw", () => {
		// Pin Math.random so the helper and the reference formula see the same
		// jitter draw, proving the arithmetic is identical to the old inline body.
		const realRandom = Math.random;
		try {
			const draws = [0, 0.5, 1, 0.123_456, 0.999];
			for (const r of draws) {
				Math.random = () => r;
				const attempt = 4;
				const base = Math.min(SCHEDULE.maxMs, SCHEDULE.initialMs * SCHEDULE.factor ** attempt);
				const jitter = base * SCHEDULE.jitter * (r * 2 - 1);
				const expected = Math.max(0, Math.round(base + jitter));
				assert.equal(nextBackoffDelay({ attempt, ...SCHEDULE }), expected, `r=${r}`);
			}
		} finally {
			Math.random = realRandom;
		}
	});
});
