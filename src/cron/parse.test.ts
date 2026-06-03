import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
	it("returns null for empty / whitespace input", () => {
		assert.equal(parseAbsoluteTimeMs(""), null);
		assert.equal(parseAbsoluteTimeMs("   "), null);
	});

	it("parses digit-only strings as epoch ms", () => {
		assert.equal(parseAbsoluteTimeMs("1735689600000"), 1735689600000);
	});

	it("rejects pure-digit '0' as epoch ms (then falls through to Date.parse)", () => {
		// Mirrors reference: `0` fails the `n > 0` guard in the digit branch
		// and falls through; Date.parse may interpret "0" via JS engine
		// heuristics, so we only assert the value is NOT exactly 0.
		const out = parseAbsoluteTimeMs("0");
		assert.notEqual(out, 0);
	});

	it("parses ISO-8601 with explicit Z timezone", () => {
		const ms = parseAbsoluteTimeMs("2026-12-31T23:59:00Z");
		assert.equal(typeof ms, "number");
		assert.equal(ms, Date.UTC(2026, 11, 31, 23, 59, 0));
	});

	it("parses ISO-8601 with explicit +HH:MM timezone", () => {
		const ms = parseAbsoluteTimeMs("2026-12-31T23:59:00+05:30");
		assert.equal(typeof ms, "number");
		assert.equal(ms, Date.UTC(2026, 11, 31, 18, 29, 0));
	});

	it("treats bare date YYYY-MM-DD as UTC midnight", () => {
		const ms = parseAbsoluteTimeMs("2026-12-31");
		assert.equal(ms, Date.UTC(2026, 11, 31, 0, 0, 0));
	});

	it("treats naive date-time YYYY-MM-DDTHH:MM:SS as UTC (no tz suffix)", () => {
		const ms = parseAbsoluteTimeMs("2026-12-31T23:59:00");
		assert.equal(ms, Date.UTC(2026, 11, 31, 23, 59, 0));
	});

	it("returns null for malformed input", () => {
		assert.equal(parseAbsoluteTimeMs("not-a-date"), null);
		assert.equal(parseAbsoluteTimeMs("2026-13-99"), null);
	});

	it("trims leading + trailing whitespace before parsing", () => {
		const ms = parseAbsoluteTimeMs("  2026-12-31T23:59:00Z  ");
		assert.equal(ms, Date.UTC(2026, 11, 31, 23, 59, 0));
	});
});
