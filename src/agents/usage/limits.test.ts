/**
 * This module had no test file, and it is the one that decides whether the
 * operator is told "you have 12k requests left" or "EXHAUSTED". Every branch
 * below is a place where being wrong produces a confident false statement
 * rather than a visible failure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	getLimitsForProvider,
	parseResetAt,
	recordLimitsFromHeaders,
	resetLimitsForTest,
} from "./limits.js";

const NOW = 1_770_000_000_000; // fixed clock

test("reads Anthropic's header dialect", () => {
	resetLimitsForTest();
	recordLimitsFromHeaders(
		"anthropic",
		{
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "250",
			"anthropic-ratelimit-tokens-limit": "80000",
			"anthropic-ratelimit-tokens-remaining": "0",
		},
		NOW,
	);
	const windows = getLimitsForProvider("anthropic");
	const requests = windows.find((w) => w.kind === "requests");
	const tokens = windows.find((w) => w.kind === "tokens");

	assert.equal(requests?.remaining, 250);
	assert.equal(requests?.limit, 1000);
	assert.equal(requests?.usedFraction, 0.75);
	// Zero remaining is the one status a UI must never soften.
	assert.equal(tokens?.status, "exhausted");
});

test("reads OpenAI's INVERTED header dialect", () => {
	// `x-ratelimit-limit-tokens`, not `...-tokens-limit`. Getting the word order
	// wrong reads every value as absent, which renders as "no data" — a silent
	// downgrade rather than an error.
	resetLimitsForTest();
	recordLimitsFromHeaders(
		"openai",
		{
			"x-ratelimit-limit-requests": "500",
			"x-ratelimit-remaining-requests": "499",
		},
		NOW,
	);
	const w = getLimitsForProvider("openai").find((x) => x.kind === "requests");
	assert.equal(w?.limit, 500);
	assert.equal(w?.remaining, 499);
});

test("an absent family is skipped, never recorded as zero", () => {
	// "no data" and "none left" are opposites; recording an absent family as 0
	// would render a full bar as an empty one.
	resetLimitsForTest();
	recordLimitsFromHeaders("anthropic", { "anthropic-ratelimit-requests-limit": "10" }, NOW);
	const windows = getLimitsForProvider("anthropic");
	assert.equal(windows.find((w) => w.kind === "tokens"), undefined);
});

test("header lookup is case-insensitive", () => {
	// Node lowercases incoming headers, but a provider adapter may not.
	resetLimitsForTest();
	recordLimitsFromHeaders("anthropic", { "Anthropic-RateLimit-Requests-Remaining": "7" }, NOW);
	assert.equal(getLimitsForProvider("anthropic")[0]?.remaining, 7);
});

test("windows are scoped per provider", () => {
	resetLimitsForTest();
	recordLimitsFromHeaders("anthropic", { "anthropic-ratelimit-requests-remaining": "1" }, NOW);
	recordLimitsFromHeaders("openai", { "x-ratelimit-remaining-requests": "2" }, NOW);
	assert.equal(getLimitsForProvider("anthropic")[0]?.remaining, 1);
	assert.equal(getLimitsForProvider("openai")[0]?.remaining, 2);
	assert.deepEqual(getLimitsForProvider("mistral"), []);
});

test("every recorded window is stamped with observedAt, so it can be aged out", () => {
	// The renderer drops stale windows; without this an `exhausted` reading
	// would stay on screen forever, since the only thing that refreshes it is
	// another call to the provider the operator has stopped calling.
	resetLimitsForTest();
	recordLimitsFromHeaders("anthropic", { "anthropic-ratelimit-requests-remaining": "5" }, NOW);
	assert.equal(getLimitsForProvider("anthropic")[0]?.observedAt, NOW);
});

test("parseResetAt splits epoch SECONDS from MILLISECONDS", () => {
	// Confusing the two puts the reset ~50,000 years out or in 1970.
	assert.equal(parseResetAt(1_770_000_000, NOW), 1_770_000_000_000);
	assert.equal(parseResetAt(1_770_000_000_000, NOW), 1_770_000_000_000);
});

test("parseResetAt understands OpenAI's duration grammar", () => {
	assert.equal(parseResetAt("1s", NOW), NOW + 1000);
	assert.equal(parseResetAt("6m0s", NOW), NOW + 360_000);
	assert.equal(parseResetAt("1h2m3s", NOW), NOW + 3_723_000);
	// `ms` must not be read as minutes — the `(?!s)` lookahead exists for this.
	assert.equal(parseResetAt("250ms", NOW), NOW + 250);
});

test("parseResetAt accepts ISO-8601 and rejects junk", () => {
	assert.equal(parseResetAt("2026-01-01T00:00:00.000Z", NOW), Date.parse("2026-01-01T00:00:00.000Z"));
	for (const junk of ["", "   ", "soon", null, undefined, {}, Number.NaN, -1, 0]) {
		assert.equal(parseResetAt(junk as never, NOW), undefined, `${String(junk)} must not parse`);
	}
});

test("malformed header values never throw and never invent numbers", () => {
	resetLimitsForTest();
	assert.doesNotThrow(() =>
		recordLimitsFromHeaders(
			"anthropic",
			{
				"anthropic-ratelimit-requests-remaining": "not-a-number",
				"anthropic-ratelimit-requests-limit": undefined,
				"anthropic-ratelimit-tokens-remaining": ["12", "34"] as unknown as string,
			},
			NOW,
		),
	);
	const requests = getLimitsForProvider("anthropic").find((w) => w.kind === "requests");
	assert.equal(requests?.remaining, undefined, "junk must not become a count");
});
