// Per-category retry policy for the Brigade agent loop.
//
// `error-classifier.ts` says *what* kind of failure happened. This module
// says *what to do about it*. The policy lookup is a pure function so the
// loop can branch on it without touching state.
//
// Policy matrix (transient = retry-after-backoff, permanent = surface
// immediately):
//
//   reason            transient  retries  backoff      rotate-profile  notes
//   ───────────────────────────────────────────────────────────────────────
//   rate_limit         yes        2        5s+jitter    yes             409 / 429
//   overloaded         yes        3        2s+jitter    yes             503 / 529
//   timeout            yes        3        1s+jitter    yes             econn*, deadline
//   unknown            yes        2        1s+jitter    yes             collapse-into-retry
//   billing            no         0        n/a          rotate-model    402 → failover chain / surface
//   subscription_limit no         0        n/a          rotate-model    plan window exhausted → failover chain / surface
//   format             no         0        n/a          n/a             same body re-fails
//   model_not_found    no         0        n/a          rotate-model    fallback chain
//   auth               no         0        n/a          yes             try other profile
//   auth_permanent     no         0        n/a          n/a             surface to user
//   session_expired    no         0        n/a          n/a             upstream needs re-auth

import { setTimeout as delay } from "node:timers/promises";

import {
  classifyErrorReason,
  isBrigadeRetryError,
  summariseError,
  type ClassificationContext,
  type RetryReason,
} from "./error-classifier.js";

export interface RetryPolicy {
  reason: RetryReason;
  transient: boolean;            // false → fail fast at the policy layer
  maxRetries: number;            // attempts AFTER the first try
  baseBackoffMs: number;         // base backoff before jitter
  rotateAuthProfile: boolean;    // try a different profile if available
  rotateModel: boolean;          // try a different (provider, model) pair
  // Whether this category should consume one of the per-provider transient
  // probe slots. Probe slots are limited so a chain of rate-limited fallbacks
  // doesn't burn through every profile cooling all of them at once.
  consumesProbeSlot: boolean;
}

export function getRetryPolicy(reason: RetryReason): RetryPolicy {
  switch (reason) {
    case "rate_limit":
      return {
        reason,
        transient: true,
        maxRetries: 2,
        baseBackoffMs: 5_000,
        rotateAuthProfile: true,
        rotateModel: false,
        consumesProbeSlot: true,
      };
    case "overloaded":
      return {
        reason,
        transient: true,
        maxRetries: 3,
        baseBackoffMs: 2_000,
        rotateAuthProfile: true,
        rotateModel: false,
        consumesProbeSlot: true,
      };
    case "timeout":
      return {
        reason,
        transient: true,
        maxRetries: 3,
        baseBackoffMs: 1_000,
        rotateAuthProfile: true,
        rotateModel: false,
        consumesProbeSlot: true,
      };
    case "unknown":
      return {
        reason,
        transient: true,
        maxRetries: 2,
        baseBackoffMs: 1_000,
        rotateAuthProfile: true,
        rotateModel: false,
        consumesProbeSlot: true,
      };
    case "billing":
      // billing (402 insufficient credits) is a FAILOVER reason, never a
      // same-model retry. The same model on the same account has the
      // same credits — re-poking it just wastes a round-trip. So fail
      // fast at the policy layer (no same-model retry) and let the model
      // fallback chain try a different (provider, model); if none is
      // configured, the error surfaces immediately. Same shape as
      // model_not_found ("fallback chain", not "probe again").
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: true,
        consumesProbeSlot: false,
      };
    case "subscription_limit":
      // The subscription plan's usage window (e.g. Claude Max 5-hour /
      // weekly) is exhausted. Same-model retry is guaranteed to re-fail
      // until the window resets on its own wall clock — hours, not seconds
      // — and rotating auth profiles doesn't help (same account, same
      // window). Fail fast and let the model fallback chain try a
      // different (provider, model); with no fallback configured the error
      // surfaces immediately with the reset hint (see RetryExhaustedError).
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: true,
        consumesProbeSlot: false,
      };
    case "format":
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: false,
        consumesProbeSlot: false,
      };
    case "model_not_found":
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: true,
        consumesProbeSlot: false,
      };
    case "auth":
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: true,
        rotateModel: false,
        consumesProbeSlot: false,
      };
    case "auth_permanent":
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: false,
        consumesProbeSlot: false,
      };
    case "session_expired":
      return {
        reason,
        transient: false,
        maxRetries: 0,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: false,
        consumesProbeSlot: false,
      };
    case "context_overflow":
      // Context overflow is recoverable on the SAME model, but the recovery
      // is "run smart compaction" — not "retry with the same body". The loop
      // owns the compaction step; this policy just signals "don't burn a
      // probe slot, don't rotate, give the loop one shot to compact + retry".
      // baseBackoffMs=0 because compaction is the gate, not wall-clock.
      return {
        reason,
        transient: true,
        maxRetries: 1,
        baseBackoffMs: 0,
        rotateAuthProfile: false,
        rotateModel: false,
        consumesProbeSlot: false,
      };
  }
}

// Backoff with full jitter — bounded exponential between [0, base * 2^attempt],
// capped at 60s so a long-running rate-limit retry doesn't appear hung.
const BACKOFF_MAX_MS = 60_000;
// Cap the exponent before evaluating 2 ** attemptIndex. The Math.min cap on
// the multiplied value already clamps to BACKOFF_MAX_MS, but a paranoid
// future tweak that lowers BACKOFF_MAX_MS would no longer mask an overflow
// from an attemptIndex past 30 (2 ** 30 = ~1B). 20 is plenty given
// maxRetries tops out at 3 in the policy table.
const BACKOFF_EXPONENT_CAP = 20;

export function computeBackoffMs(policy: RetryPolicy, attemptIndex: number): number {
  if (policy.baseBackoffMs <= 0) return 0;
  const safeAttempt = Math.max(0, Math.min(attemptIndex, BACKOFF_EXPONENT_CAP));
  const exp = Math.min(BACKOFF_MAX_MS, policy.baseBackoffMs * 2 ** safeAttempt);
  return Math.floor(Math.random() * exp);
}

// Scale max retry iterations of the outer loop (model fallback) by the count
// of available auth profiles. More profiles = more headroom to rotate before
// a hard failure surfaces. Floor of 32 keeps single-profile setups workable;
// ceiling of 160 prevents a 20-profile rate-storm from spinning forever.
const RETRY_BASE = 24;
const RETRY_PER_PROFILE = 8;
const RETRY_MIN = 32;
const RETRY_MAX = 160;

export function resolveMaxRunRetryIterations(profileCount: number): number {
  const scaled = RETRY_BASE + Math.max(1, profileCount) * RETRY_PER_PROFILE;
  return Math.min(RETRY_MAX, Math.max(RETRY_MIN, scaled));
}

// ─────────────────────────────────────────────────────────────────────────────
// runWithRetry — single-model retry orchestrator.
//
// Outer model fallback (different provider/model) lives in model-fallback.ts.
// This function only retries within the SAME (provider, model, profile). It's
// the inner loop that the fallback orchestrator wraps.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunWithRetryArgs<T> {
  // The work to perform. Re-invoked once per attempt.
  attempt: (attemptIndex: number, signal?: AbortSignal) => Promise<T>;
  // Contextual metadata for classification (provider/model name).
  ctx?: ClassificationContext;
  // External cancel signal. Aborting it short-circuits the loop.
  signal?: AbortSignal;
  // Observation hook — called once per failure with the classified reason
  // and the chosen action (retry vs fail). May be async; the orchestrator
  // awaits it so persistence-side-effects (e.g. profile-cooldown writes)
  // finish before the next attempt starts.
  onAttemptFailed?: (info: AttemptFailedInfo) => void | Promise<void>;
}

export interface AttemptFailedInfo {
  attemptIndex: number;
  reason: RetryReason;
  policy: RetryPolicy;
  willRetry: boolean;
  backoffMs: number;
  errorSummary: string;
  error: unknown;
}

export class RetryExhaustedError extends Error {
  readonly attempts: AttemptFailedInfo[];
  readonly lastReason: RetryReason;

  constructor(attempts: AttemptFailedInfo[], lastError: unknown) {
    const last = attempts[attempts.length - 1];
    const lastReason: RetryReason = last?.reason ?? "unknown";
    const summary =
      last?.errorSummary ?? (lastError instanceof Error ? lastError.message : String(lastError));
    // Operator-facing hint: a subscription-window error otherwise reads like
    // "buy credits", which sends the operator to the wrong fix (topping up an
    // API account) when the real state is "plan window used up, resets soon".
    const hint =
      lastReason === "subscription_limit"
        ? "\nYour subscription's usage window is used up — it resets on its own (check /usage or claude.ai/settings/usage). This is the plan limit, not missing API credits."
        : "";
    // Chain the underlying error as `cause`. Recipient-facing classification
    // walks `.cause` to find a known reason; without this, a 402 OpenRouter
    // billing error wrapped in a retry-exhausted shell was being classified
    // as `unknown` and recipients got the generic "Sorry I hit an error"
    // reply instead of the friendly "I'm out of credits" message.
    super(
      `Retry exhausted after ${attempts.length} attempt(s); last reason=${lastReason}: ${summary}${hint}`,
      lastError instanceof Error ? { cause: lastError } : undefined,
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastReason = lastReason;
  }
}

/** Type predicate — checks for the structured `RetryExhaustedError` shape so
 *  callers can read `.lastReason` directly without re-classifying. */
export function isRetryExhaustedError(value: unknown): value is RetryExhaustedError {
  if (!value || typeof value !== "object") return false;
  const v = value as { name?: unknown; lastReason?: unknown };
  return v.name === "RetryExhaustedError" && typeof v.lastReason === "string";
}

export async function runWithRetry<T>(args: RunWithRetryArgs<T>): Promise<T> {
  const attempts: AttemptFailedInfo[] = [];
  let attemptIndex = 0;

  while (true) {
    if (args.signal?.aborted) {
      // Surface abort directly rather than wrapping it — callers expect to
      // see an AbortError with the original reason.
      throw args.signal.reason ?? new Error("Aborted");
    }

    try {
      return await args.attempt(attemptIndex, args.signal);
    } catch (err) {
      // Bare AbortError from a downstream fetch maps to abort, never retry.
      if (isAbortError(err)) throw err;
      // Belt-and-suspenders: if the abort fired while the attempt was
      // running (e.g. a wrapped AbortError that lost its `name` going up
      // the cause chain), surface the abort instead of misclassifying it
      // as `unknown` and burning another retry. The signal.reason is
      // preferred when set so the user sees the abort cause they passed
      // (e.g. "Interrupted by user"), not the inner error.
      if (args.signal?.aborted) throw args.signal.reason ?? err;

      const reason = classifyErrorReason(err, args.ctx);
      const policy = getRetryPolicy(reason);
      const remaining = policy.maxRetries - attemptIndex;
      const willRetry = policy.transient && remaining > 0 && !args.signal?.aborted;
      const backoffMs = willRetry ? computeBackoffMs(policy, attemptIndex) : 0;

      const info: AttemptFailedInfo = {
        attemptIndex,
        reason,
        policy,
        willRetry,
        backoffMs,
        errorSummary: summariseError(err),
        error: err,
      };
      attempts.push(info);
      const observerResult = args.onAttemptFailed?.(info);
      if (observerResult && typeof (observerResult as Promise<void>).then === "function") {
        try {
          await observerResult;
        } catch {
          // Observer errors must never abort the retry decision below.
        }
      }

      if (!willRetry) {
        if (isBrigadeRetryError(err)) throw err;
        throw new RetryExhaustedError(attempts, err);
      }

      if (backoffMs > 0) {
        try {
          await delay(backoffMs, undefined, { signal: args.signal });
        } catch {
          // delay rejects on abort — propagate as abort, not retry exhaustion.
          throw args.signal?.reason ?? err;
        }
      }

      attemptIndex++;
    }
  }
}

function isAbortError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as { name?: unknown; code?: unknown };
  return v.name === "AbortError" || v.code === "ABORT_ERR" || v.code === 20;
}
