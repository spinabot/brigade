/**
 * `restart()` must report what actually happened.
 *
 * It returned `ok: true` unconditionally, so on macOS `brigade gateway restart`
 * always printed "Brigade gateway restarted." — including when it restarted
 * nothing. The two sibling adapters (`systemd`, `schtasks`) have always checked
 * the exit code; macOS was the sole outlier, and macOS is where iMessage lives.
 *
 * The cost is worse than a wrong message. Restarting exists to pick up new
 * code, so a false success means an operator verifies a fix against the very
 * build they were trying to replace, and concludes the fix does not work.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { launchdAdapter } from "./launchd.js";

const realHome = process.env.HOME;
// Track and remove the temp homes: the review flagged that this leaked one
// mkdtemp directory per test, which is small but accumulates across CI runs.
const madeDirs: string[] = [];
function tempHome(): void {
	const d = mkdtempSync(path.join(os.tmpdir(), "brigade-launchd-"));
	madeDirs.push(d);
	process.env.HOME = d;
}
afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	while (madeDirs.length > 0) {
		try {
			rmSync(madeDirs.pop()!, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

describe("launchd restart — reports the truth", () => {
	it("fails, and says why, when no service is installed", async () => {
		// A gateway started by hand in a terminal has no plist. That is the
		// common case this reported success for.
		tempHome();
		const res = await launchdAdapter().restart();
		assert.equal(res.ok, false, "must not claim success when nothing was restarted");
		assert.match(res.message, /nothing to restart/i);
		// Actionable, not just negative: the operator needs to know what to do.
		assert.match(res.message, /gateway install|stop and start/i);
	});

	it("never returns the success message on that path", async () => {
		tempHome();
		const res = await launchdAdapter().restart();
		assert.doesNotMatch(res.message, /Brigade gateway restarted\./);
	});
});
