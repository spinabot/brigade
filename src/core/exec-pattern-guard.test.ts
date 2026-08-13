/**
 * Tests for the approval-pattern guard — the shared bar every writer of an
 * exec-approval regex has to clear.
 *
 * Two properties matter and they pull in opposite directions:
 *   1. A pattern the gate would re-run on every bash call must be bounded.
 *   2. A realistic allowlist entry must NEVER be refused — wrongly rejecting
 *      `^git (status|diff|log)( |$)` is a worse bug than missing an exotic
 *      catastrophic construct.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	describeApprovalPatternRefusal,
	MAX_APPROVAL_PATTERN_LENGTH,
	validateApprovalPattern,
} from "./exec-pattern-guard.js";

/** Patterns an operator would plausibly type. All must survive the guard. */
const REALISTIC = [
	"^git (status|diff|log)( |$)",
	"^cat package\\.json$",
	"^npm (run|ci|test)\\b.*",
	"^ls( -[a-zA-Z]+)*( |$)",
	"^echo ",
	"^node scripts/[a-z0-9-]+\\.mjs$",
	"^docker (ps|logs)( |$)",
	"^(ab+c)+$",
];

/** Doubly-nested / alternation-ambiguous quantifiers — the ReDoS shapes. */
const CATASTROPHIC = ["^git (a+)+$", "^(a|a)*$", "^([a-z]+)+#$", "(a+)+$", "^(a*)*$"];

test("realistic allowlist patterns are accepted and compiled", () => {
	for (const pattern of REALISTIC) {
		const checked = validateApprovalPattern(pattern);
		assert.equal(checked.ok, true, `refused a realistic pattern: ${pattern}`);
		// `recordApproval` trims before storing, so the guard trims too.
		if (checked.ok) assert.equal(checked.regex.source, new RegExp(pattern.trim()).source);
	}
});

test("catastrophically backtracking patterns are refused as pattern-too-slow", () => {
	for (const pattern of CATASTROPHIC) {
		const checked = validateApprovalPattern(pattern);
		assert.equal(checked.ok, false, `accepted a catastrophic pattern: ${pattern}`);
		if (!checked.ok) assert.equal(checked.refusal.code, "pattern-too-slow");
	}
});

test("the literal head of an anchored pattern is carried into the probes", () => {
	// Without the literal prefix the probes fail at `^git ` and never reach the
	// ambiguous tail, so this pattern would look fast and slip through.
	const checked = validateApprovalPattern("^git (a+)+$");
	assert.equal(checked.ok, false);
});

test("invalid regex syntax is refused with the engine's own message", () => {
	const checked = validateApprovalPattern("[unclosed");
	assert.equal(checked.ok, false);
	if (checked.ok) return;
	assert.equal(checked.refusal.code, "invalid-regex");
	assert.match(checked.refusal.message, /invalid regex pattern:/);
	assert.match(checked.refusal.syntaxError ?? "", /character class/i);
});

test("a pattern past the length cap is refused before it is compiled", () => {
	const pattern = `^${"a".repeat(MAX_APPROVAL_PATTERN_LENGTH)}$`;
	const checked = validateApprovalPattern(pattern);
	assert.equal(checked.ok, false);
	if (checked.ok) return;
	assert.equal(checked.refusal.code, "pattern-too-long");
	assert.match(checked.refusal.message, /pattern is too long/);
	// A pattern exactly at the cap is fine — the bound is inclusive.
	assert.equal(validateApprovalPattern("a".repeat(MAX_APPROVAL_PATTERN_LENGTH)).ok, true);
});

test("the check stays bounded even on a pattern designed to hang", () => {
	const started = Date.now();
	validateApprovalPattern("^(a+)+(b+)+(c+)+$");
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2000, `guard took ${elapsed}ms — the budget should have cut it short`);
});

test("the whole realistic corpus costs well under a millisecond each", () => {
	const started = Date.now();
	for (const pattern of REALISTIC) validateApprovalPattern(pattern);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 100, `healthy patterns took ${elapsed}ms for ${REALISTIC.length} entries`);
});

test("input is trimmed so every surface agrees on what the pattern is", () => {
	const checked = validateApprovalPattern("  ^git status$  ");
	assert.equal(checked.ok, true);
	if (checked.ok) assert.equal(checked.regex.source, "^git status$");
});

test("describeApprovalPatternRefusal folds the hint lines into one sentence", () => {
	const checked = validateApprovalPattern("^(a|a)*$");
	assert.equal(checked.ok, false);
	if (checked.ok) return;
	const described = describeApprovalPatternRefusal(checked.refusal);
	assert.match(described, /backtracks catastrophically/);
	assert.match(described, /quantifier inside a quantified group/);
});
