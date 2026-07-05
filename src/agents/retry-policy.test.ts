import { test } from "node:test";
import assert from "node:assert/strict";

import { BrigadeRetryError } from "./error-classifier.js";
import {
  RetryExhaustedError,
  computeBackoffMs,
  getRetryPolicy,
  isRetryExhaustedError,
  resolveMaxRunRetryIterations,
  runWithRetry,
} from "./retry-policy.js";

test("getRetryPolicy: rate_limit → transient, 2 retries, 5s base", () => {
  const p = getRetryPolicy("rate_limit");
  assert.equal(p.transient, true);
  assert.equal(p.maxRetries, 2);
  assert.equal(p.baseBackoffMs, 5_000);
  assert.equal(p.consumesProbeSlot, true);
});

test("getRetryPolicy: format → non-transient, 0 retries", () => {
  const p = getRetryPolicy("format");
  assert.equal(p.transient, false);
  assert.equal(p.maxRetries, 0);
});

test("getRetryPolicy: auth_permanent → never retry, never rotate", () => {
  const p = getRetryPolicy("auth_permanent");
  assert.equal(p.transient, false);
  assert.equal(p.rotateAuthProfile, false);
  assert.equal(p.rotateModel, false);
});

test("getRetryPolicy: model_not_found → rotate model, no retry", () => {
  const p = getRetryPolicy("model_not_found");
  assert.equal(p.transient, false);
  assert.equal(p.maxRetries, 0);
  assert.equal(p.rotateModel, true);
});

test("computeBackoffMs: zero base → zero backoff regardless of attempt", () => {
  const p = getRetryPolicy("format");
  assert.equal(computeBackoffMs(p, 0), 0);
  assert.equal(computeBackoffMs(p, 5), 0);
});

test("computeBackoffMs: bounded by 60s cap even at very high attemptIndex", () => {
  const p = getRetryPolicy("rate_limit"); // 5000 base
  // 5000 × 2^30 would overflow without the exponent cap.
  for (let i = 0; i < 20; i++) {
    const ms = computeBackoffMs(p, 30);
    assert.ok(ms >= 0 && ms <= 60_000, `ms=${ms}`);
  }
});

test("computeBackoffMs: negative attemptIndex clamped to 0", () => {
  const p = getRetryPolicy("timeout");
  const ms = computeBackoffMs(p, -1);
  assert.ok(ms >= 0 && ms <= p.baseBackoffMs);
});

test("resolveMaxRunRetryIterations: floor 32, ceiling 160", () => {
  assert.equal(resolveMaxRunRetryIterations(0), 32);  // 24 + 8 = 32 (clamped to MIN)
  assert.equal(resolveMaxRunRetryIterations(1), 32);  // 24 + 8 = 32
  assert.equal(resolveMaxRunRetryIterations(2), 40);  // 24 + 16 = 40
  assert.equal(resolveMaxRunRetryIterations(20), 160); // 24 + 160 = 184 (clamped)
});

test("runWithRetry: succeeds on first attempt", async () => {
  let calls = 0;
  const result = await runWithRetry({
    attempt: async () => {
      calls++;
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("runWithRetry: retries transient and eventually succeeds", async () => {
  let calls = 0;
  const result = await runWithRetry({
    attempt: async () => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("runWithRetry: surfaces format error immediately (non-transient)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWithRetry({
        attempt: async () => {
          calls++;
          throw new BrigadeRetryError({
            message: "tool_use_id mismatch",
            reason: "format",
          });
        },
      }),
    (err: unknown) => {
      // The original BrigadeRetryError should be re-thrown, not wrapped.
      return err instanceof BrigadeRetryError && err.reason === "format";
    },
  );
  assert.equal(calls, 1);
});

test("runWithRetry: throws RetryExhaustedError after exhaustion of generic Error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWithRetry({
        attempt: async () => {
          calls++;
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
      }),
    (err: unknown) => err instanceof RetryExhaustedError,
  );
  // rate_limit policy: maxRetries=2 → 3 attempts total (indices 0, 1, 2).
  assert.equal(calls, 3);
});

test("runWithRetry: pre-aborted signal short-circuits before first attempt", async () => {
  const ac = new AbortController();
  ac.abort(new Error("user cancelled"));
  let calls = 0;
  await assert.rejects(() =>
    runWithRetry({
      signal: ac.signal,
      attempt: async () => {
        calls++;
        return "ok";
      },
    }),
  );
  assert.equal(calls, 0);
});

test("runWithRetry: AbortError thrown during attempt propagates immediately", async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      runWithRetry({
        signal: ac.signal,
        attempt: async () => {
          calls++;
          ac.abort(new Error("abort during attempt"));
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(calls, 1);
});

test("runWithRetry: signal.aborted between attempts surfaces abort, not RetryExhausted", async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(() =>
    runWithRetry({
      signal: ac.signal,
      attempt: async () => {
        calls++;
        if (calls === 1) {
          ac.abort(new Error("interrupted"));
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        return "ok";
      },
    }),
  );
  // First attempt fails, signal flips, the abort path takes precedence.
  assert.equal(calls, 1);
});

test("runWithRetry: onAttemptFailed observer is invoked on each failure", async () => {
  const observed: string[] = [];
  let calls = 0;
  await assert.rejects(() =>
    runWithRetry({
      onAttemptFailed: (info) => {
        observed.push(`${info.attemptIndex}:${info.reason}:${info.willRetry}`);
      },
      attempt: async () => {
        calls++;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    }),
  );
  // 3 attempts, 3 observations — first two willRetry=true, last false.
  assert.equal(observed.length, 3);
  assert.match(observed[0]!, /^0:rate_limit:true$/);
  assert.match(observed[1]!, /^1:rate_limit:true$/);
  assert.match(observed[2]!, /^2:rate_limit:false$/);
});

/* ───────────────────── RetryExhaustedError shape ───────────────────── */

test("RetryExhaustedError chains the underlying error as `cause`", async () => {
  // The downstream error classifier walks `.cause` looking for known reason
  // markers. Without the chain, a 402 billing wrapped in a retry-exhausted
  // shell was being classified as `unknown` and recipients saw the generic
  // apology reply instead of "out of credits" — that regression closed here.
  const innerErr = Object.assign(new Error("402 insufficient credits"), { status: 402 });
  let caught: unknown;
  try {
    await runWithRetry({
      attempt: async () => {
        throw innerErr;
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RetryExhaustedError, "should throw RetryExhaustedError");
  const wrapped = caught as RetryExhaustedError & { cause?: unknown };
  assert.equal(wrapped.cause, innerErr, ".cause must point at the underlying error");
  assert.equal(wrapped.lastReason, "billing", "lastReason should carry the classifier verdict");
});

test("isRetryExhaustedError type guard accepts RetryExhaustedError, rejects other shapes", () => {
  const real = new RetryExhaustedError(
    [
      {
        attemptIndex: 0,
        reason: "billing",
        policy: getRetryPolicy("billing"),
        willRetry: false,
        backoffMs: 0,
        errorSummary: "402",
        error: new Error("402"),
      },
    ],
    new Error("402"),
  );
  assert.equal(isRetryExhaustedError(real), true);
  assert.equal(isRetryExhaustedError(new Error("plain")), false);
  assert.equal(isRetryExhaustedError(new BrigadeRetryError({ message: "x", reason: "billing" })), false);
  assert.equal(isRetryExhaustedError(null), false);
  assert.equal(isRetryExhaustedError(undefined), false);
  assert.equal(isRetryExhaustedError({ name: "RetryExhaustedError" }), false, "name alone insufficient");
});

// ─── subscription_limit policy ───

test("getRetryPolicy: subscription_limit → fail fast, rotate model only", () => {
  const p = getRetryPolicy("subscription_limit");
  assert.equal(p.transient, false);
  assert.equal(p.maxRetries, 0);
  assert.equal(p.rotateAuthProfile, false); // same account = same window
  assert.equal(p.rotateModel, true);        // a fallback provider may be configured
  assert.equal(p.consumesProbeSlot, false);
});

test("RetryExhaustedError: subscription_limit message carries the reset hint, others don't", () => {
  const subInfo = {
    attemptIndex: 0,
    reason: "subscription_limit" as const,
    policy: getRetryPolicy("subscription_limit"),
    willRetry: false,
    backoffMs: 0,
    errorSummary: "out of extra usage",
    error: new Error("out of extra usage"),
  };
  const err = new RetryExhaustedError([subInfo], subInfo.error);
  assert.match(err.message, /resets on its own/);
  assert.match(err.message, /not missing API credits/);

  const plain = new RetryExhaustedError(
    [{ ...subInfo, reason: "timeout" as const, policy: getRetryPolicy("timeout") }],
    subInfo.error,
  );
  assert.doesNotMatch(plain.message, /resets on its own/);
});

test("runWithRetry: subscription_limit fails fast — exactly one attempt, no backoff burn", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry({
      attempt: async () => {
        calls++;
        throw Object.assign(
          new Error("You're out of extra usage. Add more at claude.ai/settings/usage and keep going."),
          { status: 400 },
        );
      },
    }),
    (e: unknown) => isRetryExhaustedError(e) && e.lastReason === "subscription_limit",
  );
  assert.equal(calls, 1);
});
