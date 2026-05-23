import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
	it("claim returns true for a fresh id, false for a repeat", () => {
		const cache = createDedupeCache();
		assert.equal(cache.claim("a"), true);
		assert.equal(cache.claim("a"), false);
		assert.equal(cache.claim("b"), true);
		assert.equal(cache.claim("b"), false);
	});

	it("an empty id is never deduped (let it through)", () => {
		const cache = createDedupeCache();
		assert.equal(cache.claim(""), true);
		assert.equal(cache.claim(""), true);
	});

	it("LRU-evicts oldest when maxEntries exceeded", () => {
		const cache = createDedupeCache({ maxEntries: 3 });
		cache.claim("a");
		cache.claim("b");
		cache.claim("c");
		cache.claim("d"); // evicts "a"
		assert.equal(cache.size, 3);
		assert.equal(cache.claim("a"), true, "evicted id should be treated as fresh");
	});

	it("expires entries past the TTL window", async () => {
		const cache = createDedupeCache({ ttlMs: 10 });
		cache.claim("x");
		assert.equal(cache.claim("x"), false);
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(cache.claim("x"), true, "expired id should be treated as fresh again");
	});

	it("clear() drops every entry", () => {
		const cache = createDedupeCache();
		cache.claim("a");
		cache.claim("b");
		cache.clear();
		assert.equal(cache.size, 0);
		assert.equal(cache.claim("a"), true);
	});
});
