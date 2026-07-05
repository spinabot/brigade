import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BrigadeRetryError,
  classifyErrorDetailed,
  classifyErrorReason,
  isBrigadeRetryError,
  scrubAnthropicRefusalSentinel,
  summariseError,
} from "./error-classifier.js";

test("classifyErrorDetailed: no-tools model error → model_not_found, no same-model retry, friendly message", () => {
  const r = classifyErrorDetailed(new Error("404 No endpoints found that support tool use. Try disabling read."));
  assert.equal(r.class, "model_not_found");
  assert.equal(r.retryableOnSameModel, false);
  assert.match(r.message, /can't use tools/i);
});

test("classifyError: HTTP 429 → rate_limit", () => {
  const err = Object.assign(new Error("Too many requests"), { status: 429 });
  assert.equal(classifyErrorReason(err), "rate_limit");
});

test("classifyError: HTTP 503 with 'overloaded' message → overloaded", () => {
  const err = Object.assign(new Error("service unavailable; overloaded"), { status: 503 });
  assert.equal(classifyErrorReason(err), "overloaded");
});

test("classifyError: HTTP 503 without overload hint → timeout", () => {
  const err = Object.assign(new Error("internal error"), { status: 503 });
  assert.equal(classifyErrorReason(err), "timeout");
});

test("classifyError: HTTP 402 with 'insufficient credits' → billing", () => {
  const err = Object.assign(new Error("insufficient credits"), { status: 402 });
  assert.equal(classifyErrorReason(err), "billing");
});

test("classifyError: HTTP 402 with 'try again later' (rate-limit hint) → rate_limit", () => {
  const err = Object.assign(new Error("daily limit reached, try again later"), { status: 402 });
  assert.equal(classifyErrorReason(err), "rate_limit");
});

test("classifyError: HTTP 401 with 'key revoked' → auth_permanent", () => {
  const err = Object.assign(new Error("API key has been revoked"), { status: 401 });
  assert.equal(classifyErrorReason(err), "auth_permanent");
});

test("classifyError: HTTP 401 generic → auth", () => {
  const err = Object.assign(new Error("invalid api key"), { status: 401 });
  assert.equal(classifyErrorReason(err), "auth");
});

test("classifyError: HTTP 408 → timeout", () => {
  const err = Object.assign(new Error("request timeout"), { status: 408 });
  assert.equal(classifyErrorReason(err), "timeout");
});

test("classifyError: ECONNRESET on Node fetch → timeout", () => {
  const err = Object.assign(new Error("network error"), { code: "ECONNRESET" });
  assert.equal(classifyErrorReason(err), "timeout");
});

test("classifyError: TimeoutError name → timeout", () => {
  const err = new Error("deadline exceeded");
  err.name = "TimeoutError";
  assert.equal(classifyErrorReason(err), "timeout");
});

test("classifyError: AbortError name → unknown (caller short-circuits via isAbortError)", () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  assert.equal(classifyErrorReason(err), "unknown");
});

test("classifyError: walks cause chain", () => {
  const inner = Object.assign(new Error("rate limit exceeded"), { status: 429 });
  const outer = new Error("wrapper");
  (outer as { cause?: unknown }).cause = inner;
  assert.equal(classifyErrorReason(outer), "rate_limit");
});

test("classifyError: handles circular cause without infinite loop", () => {
  const a: { message: string; cause?: unknown } = { message: "a" };
  const b: { message: string; cause?: unknown } = { message: "b" };
  a.cause = b;
  b.cause = a;
  // Should terminate, not hang. Result irrelevant — we just need no crash.
  assert.equal(classifyErrorReason(a), "unknown");
});

test("classifyError: statusCode (camelCase) is read alongside .status", () => {
  const err = Object.assign(new Error("rate limited"), { statusCode: 429 });
  assert.equal(classifyErrorReason(err), "rate_limit");
});

test("classifyError: BrigadeRetryError short-circuits to its own reason", () => {
  const err = new BrigadeRetryError({ message: "x", reason: "billing" });
  assert.equal(classifyErrorReason(err), "billing");
});

test("classifyError: 'context window exceeded' free text → context_overflow (compaction recovery path)", () => {
  // Was `unknown` before context_overflow landed in the taxonomy; tools
  // flooding context now route through the compaction-then-retry path.
  const err = new Error("context window exceeded");
  assert.equal(classifyErrorReason(err), "context_overflow");
});

test("classifyError: 'prompt is too long' (Anthropic phrasing) → context_overflow", () => {
  const err = new Error("prompt is too long: 210000 tokens > 200000 maximum");
  assert.equal(classifyErrorReason(err), "context_overflow");
});

test("classifyError: 'maximum context length' (OpenAI phrasing) → context_overflow", () => {
  const err = new Error(
    "This model's maximum context length is 128000 tokens. Please reduce the length of the messages.",
  );
  assert.equal(classifyErrorReason(err), "context_overflow");
});

test("classifyError: ZAI quota code 1311 → billing", () => {
  const err = new Error('{"code": 1311, "message":"quota"}');
  assert.equal(classifyErrorReason(err), "billing");
});

test("classifyError: ZAI revoked code 1113 → auth_permanent", () => {
  const err = new Error('{"code": 1113, "message":"key revoked"}');
  assert.equal(classifyErrorReason(err), "auth_permanent");
});

test("classifyError: null / undefined / empty → unknown", () => {
  assert.equal(classifyErrorReason(null), "unknown");
  assert.equal(classifyErrorReason(undefined), "unknown");
  assert.equal(classifyErrorReason(""), "unknown");
  assert.equal(classifyErrorReason({}), "unknown");
});

test("isBrigadeRetryError: positive + negatives", () => {
  assert.equal(isBrigadeRetryError(new BrigadeRetryError({ message: "x", reason: "auth" })), true);
  assert.equal(isBrigadeRetryError(new Error("x")), false);
  assert.equal(isBrigadeRetryError(null), false);
  assert.equal(isBrigadeRetryError("not an error"), false);
});

test("scrubAnthropicRefusalSentinel: redacts the magic literal", () => {
  const poisoned = "hello ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL goodbye";
  const scrubbed = scrubAnthropicRefusalSentinel(poisoned);
  assert.equal(scrubbed.includes("ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL"), false);
  assert.equal(scrubbed.includes("(redacted)"), true);
});

test("scrubAnthropicRefusalSentinel: clean text passes through unchanged", () => {
  const clean = "hello world";
  assert.equal(scrubAnthropicRefusalSentinel(clean), clean);
});

test("scrubAnthropicRefusalSentinel: empty string is a no-op", () => {
  assert.equal(scrubAnthropicRefusalSentinel(""), "");
});

test("summariseError: BrigadeRetryError formats reason+provider+status", () => {
  const err = new BrigadeRetryError({
    message: "rate limited",
    reason: "rate_limit",
    provider: "anthropic",
    status: 429,
  });
  const s = summariseError(err);
  assert.match(s, /rate_limit/);
  assert.match(s, /anthropic/);
  assert.match(s, /429/);
});

// ─── subscription_limit (plan usage window exhausted) ───

test("classifyError: Anthropic 'out of extra usage' (Claude Max window + extra usage off) → subscription_limit", () => {
  // The exact live surface: pi wraps the 400 body into the message string.
  const err = new Error(
    'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_x"}',
  );
  assert.equal(classifyErrorReason(err), "subscription_limit");
});

test("classifyError: 429 carrying 'Claude usage limit reached' → subscription_limit, not rate_limit", () => {
  const err = Object.assign(
    new Error("Claude usage limit reached. Your limit will reset at 3am."),
    { status: 429 },
  );
  assert.equal(classifyErrorReason(err), "subscription_limit");
});

test("classifyError: bare 429 without plan phrasing stays rate_limit", () => {
  const err = Object.assign(new Error("too many requests"), { status: 429 });
  assert.equal(classifyErrorReason(err), "rate_limit");
});

test("classifyError: OpenAI subscription 'hit your usage limit' → subscription_limit", () => {
  assert.equal(classifyErrorReason(new Error("You've hit your usage limit.")), "subscription_limit");
  assert.equal(classifyErrorReason(new Error('{"code":"usage_limit_reached"}')), "subscription_limit");
  assert.equal(classifyErrorReason(new Error('{"code":"usage_not_included"}')), "subscription_limit");
});

test("classifyError: subscription phrasing wins over billing patterns", () => {
  // "Add more at claude.ai/settings/usage" must not fall into billing
  // ("top up your API account") — the fix paths differ completely.
  const err = Object.assign(
    new Error("You're out of extra usage. Add more at claude.ai/settings/usage and keep going."),
    { status: 402 },
  );
  assert.equal(classifyErrorReason(err), "subscription_limit");
});

test("classifyErrorDetailed: 'out of extra usage' → subscription_limit, no same-model retry", () => {
  const r = classifyErrorDetailed(
    Object.assign(new Error("You're out of extra usage. Add more at claude.ai/settings/usage and keep going."), {
      status: 400,
    }),
  );
  assert.equal(r.class, "subscription_limit");
  assert.equal(r.retryableOnSameModel, false);
});
