/**
 * `brigade update` warned about a stale PATH install on every SUCCESSFUL
 * update.
 *
 * `--version` prints a banner — `Brigade 1.35.2 (28f1d17, built …)` — and the
 * check compared that whole string against the bare `1.35.2`. They can never
 * be equal, so "a stale install is shadowing the new one" fired every time,
 * one line below a banner reporting the correct version.
 *
 * A warning that always fires is worse than none: it trains people to ignore
 * the real case it exists for — an `npm i -g` into one Node installation while
 * PATH resolves another.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractSemver } from "./update.js";

test("pulls the version out of the real --version banner", () => {
	assert.equal(extractSemver("Brigade 1.35.2 (28f1d17, built 2026-09-01 01:19)"), "1.35.2");
});

test("the parsed version equals the installed one, so no warning fires", () => {
	// The exact regression: these two must compare equal after parsing.
	const installed = "1.35.2";
	const banner = "Brigade 1.35.2 (1b89c93, built 2026-09-01 01:08)";
	assert.equal(extractSemver(banner), installed);
});

test("a genuinely stale install is still detected", () => {
	// The case the warning exists for must keep working.
	assert.notEqual(extractSemver("Brigade 1.34.0 (abc1234, built 2026-08-30)"), "1.35.2");
});

test("a prerelease version is read whole", () => {
	assert.equal(extractSemver("Brigade 2.0.0-rc.1 (deadbee)"), "2.0.0-rc.1");
});

test("an unreadable banner returns undefined, so the check stays silent", () => {
	// "I could not read it" is not evidence of a stale install.
	for (const junk of ["", "command not found", "Brigade (dev build)"]) {
		assert.equal(extractSemver(junk), undefined, JSON.stringify(junk));
	}
});
