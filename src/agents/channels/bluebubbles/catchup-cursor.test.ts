import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { capFailureRetriesMap, resolveCatchupCursorPath, sanitizeFailureRetries } from "./catchup-cursor.js";

describe("catchup-cursor — path + sanitisation", () => {
	it("derives a per-account cursor path under the channel state dir", () => {
		const p = resolveCatchupCursorPath("home");
		assert.match(p.replace(/\\/g, "/"), /bluebubbles\/accounts\/home\/catchup-cursor\.json$/);
	});

	it("sanitises a filesystem-unsafe account id in the path", () => {
		const p = resolveCatchupCursorPath("a/b:c");
		assert.match(p.replace(/\\/g, "/"), /bluebubbles\/accounts\/a_b_c\/catchup-cursor\.json$/);
	});

	it("drops non-positive / non-numeric retry entries", () => {
		const out = sanitizeFailureRetries({ ok: 3, zero: 0, neg: -1, str: "x", frac: 2.9 });
		assert.deepEqual(out, { ok: 3, frac: 2 });
	});

	it("returns {} for a non-object", () => {
		assert.deepEqual(sanitizeFailureRetries(null), {});
		assert.deepEqual(sanitizeFailureRetries("nope"), {});
	});
});

describe("catchup-cursor — capFailureRetriesMap", () => {
	it("keeps the highest-count entries when over the cap", () => {
		const capped = capFailureRetriesMap({ a: 1, b: 5, c: 3, d: 2 }, 2);
		assert.deepEqual(Object.keys(capped).sort(), ["b", "c"]);
	});

	it("returns the map unchanged when within the cap", () => {
		const m = { a: 1, b: 2 };
		assert.equal(capFailureRetriesMap(m, 5), m);
	});
});
