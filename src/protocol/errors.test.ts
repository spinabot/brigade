import assert from "node:assert/strict";
import { test } from "node:test";

import { BrigadeRequestError, describeRetry, isBrigadeRequestError, sameErrorCode } from "./errors.js";

test("the server's structured error survives the reject", () => {
	// The client used to collapse this into `new Error(message)`, so no renderer
	// could tell a transient rate limit from a permanent auth failure.
	const err = new BrigadeRequestError({
		code: "rate-limited",
		message: "too many requests",
		retryable: true,
		retryAfterMs: 30_000,
		details: { bucket: "tokens" },
	});
	assert.equal(err.code, "rate-limited");
	assert.equal(err.retryable, true);
	assert.equal(err.retryAfterMs, 30_000);
	assert.deepEqual(err.details, { bucket: "tokens" });
});

test("it stays a plain Error, so existing catch sites are untouched", () => {
	const err = new BrigadeRequestError({ code: "internal", message: "boom" });
	assert.ok(err instanceof Error);
	assert.equal(err.message, "boom");
	assert.ok(isBrigadeRequestError(err));
	assert.equal(isBrigadeRequestError(new Error("plain")), false);
});

test("a missing message falls back to naming the code", () => {
	assert.equal(new BrigadeRequestError({ code: "forbidden" }).message, "request failed (forbidden)");
	assert.equal(new BrigadeRequestError({}).message, "request failed (unknown)");
});

test("retry guidance is turned into words a person can act on", () => {
	assert.equal(describeRetry(new BrigadeRequestError({ retryAfterMs: 30_000 })), "retry in 30s");
	assert.equal(describeRetry(new BrigadeRequestError({ retryable: true })), "retryable");
	assert.equal(describeRetry(new BrigadeRequestError({ retryable: false })), "not retryable");
	assert.equal(describeRetry(new BrigadeRequestError({ code: "internal" })), undefined, "no guidance, no claim");
	assert.equal(describeRetry(new Error("plain")), undefined);
});

test("a sub-second retryAfter still reads as at least a second", () => {
	assert.equal(describeRetry(new BrigadeRequestError({ retryAfterMs: 200 })), "retry in 1s");
});

test("not-retryable outranks a stale retryAfter", () => {
	// A server that says "don't bother" must not be overridden by a leftover delay.
	assert.equal(
		describeRetry(new BrigadeRequestError({ retryable: false, retryAfterMs: 30_000 })),
		"not retryable",
	);
});

test("code comparison ignores the catalogue's spelling drift", () => {
	// The codes are historically inconsistent — SCREAMING_SNAKE and kebab-case
	// both appear — so grouping by raw string splits the same condition in two.
	assert.equal(sameErrorCode("rate-limited", "RATE_LIMITED"), true);
	assert.equal(sameErrorCode("NOT_LINKED", "notlinked"), true);
	assert.equal(sameErrorCode("internal", "forbidden"), false);
	assert.equal(sameErrorCode(undefined, undefined), false, "unknown never matches unknown");
});
