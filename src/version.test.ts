import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { formatVersion, getBuildInfo } from "./version.js";

describe("version", () => {
	it("reports the real package.json version, not the hardcoded fallback", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		// In a dev/source tree (no build stamp) getBuildInfo falls back to reading
		// package.json — which must be the actual published version, never the
		// stale `VERSION = "0.1.0"` constant. A regression that re-hardcodes the
		// version (or breaks the package.json read) trips this immediately.
		assert.equal(getBuildInfo().version, pkg.version);
		assert.ok(
			formatVersion().startsWith(pkg.version),
			`formatVersion() should lead with the real version (${pkg.version}), got "${formatVersion()}"`,
		);
	});
});
