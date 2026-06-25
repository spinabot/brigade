/**
 * Tests for the disk-backed media result cache (TIER 4 #8).
 *
 * All I/O is pinned to a per-test temp dir (passed via `dir`) so nothing touches
 * the real cache. Covers: key stability, hit/miss, TTL expiry, and LRU eviction.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { mediaCacheKey, readMediaCache, writeMediaCache } from "./media-cache.js";

describe("media-cache — key", () => {
	it("is stable for identical inputs and changes when any part changes", () => {
		const base = {
			bytes: Buffer.from("hello world"),
			question: "what is this?",
			provider: "google",
			model: "gemini-2.5-flash",
			maxTokens: 1024,
			kind: "image",
		};
		const k1 = mediaCacheKey(base);
		const k2 = mediaCacheKey({ ...base, bytes: Buffer.from("hello world") });
		assert.equal(k1, k2, "same inputs → same key");
		assert.notEqual(k1, mediaCacheKey({ ...base, bytes: Buffer.from("different") }), "bytes change");
		assert.notEqual(k1, mediaCacheKey({ ...base, question: "other" }), "question change");
		assert.notEqual(k1, mediaCacheKey({ ...base, provider: "anthropic" }), "provider change");
		assert.notEqual(k1, mediaCacheKey({ ...base, model: "other" }), "model change");
		assert.notEqual(k1, mediaCacheKey({ ...base, maxTokens: 2048 }), "maxTokens change");
		assert.notEqual(k1, mediaCacheKey({ ...base, kind: "pdf" }), "kind change");
		assert.match(k1, /^[0-9a-f]{64}$/, "sha256 hex");
	});
});

describe("media-cache — read/write", () => {
	let dir: string;
	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mcache-"));
	});
	after(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("returns undefined on a miss", async () => {
		assert.equal(await readMediaCache("deadbeef", { dir }), undefined);
	});

	it("round-trips a written value", async () => {
		const key = mediaCacheKey({ bytes: Buffer.from("X"), question: "q", provider: "google", kind: "pdf" });
		await writeMediaCache(key, { text: "the answer", provider: "google", model: "gemini-2.5-flash" }, { dir });
		const hit = await readMediaCache(key, { dir });
		assert.ok(hit);
		assert.equal(hit?.text, "the answer");
		assert.equal(hit?.provider, "google");
		assert.equal(hit?.model, "gemini-2.5-flash");
	});

	it("expires an entry older than the TTL (and cleans it)", async () => {
		const key = "ttltest";
		await writeMediaCache(key, { text: "stale", provider: "p", model: "m" }, { dir });
		// Age the file by back-dating its mtime well beyond the tiny TTL we pass.
		const file = path.join(dir, `${key}.json`);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(file, old, old);
		assert.equal(await readMediaCache(key, { dir, ttlMs: 1 }), undefined, "expired → miss");
		// The expired-entry cleanup is fire-and-forget; give it a tick to settle.
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(fs.existsSync(file), false, "expired entry unlinked");
	});

	it("evicts the oldest entries when over the cap", async () => {
		const evDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mcache-ev-"));
		try {
			// Seed 5 entries under a HIGH cap (no eviction yet), then stagger mtimes
			// so "oldest" is well-defined (k0 oldest … k4 newest).
			for (let i = 0; i < 5; i++) {
				await writeMediaCache(`k${i}`, { text: `t${i}`, provider: "p", model: "m" }, { dir: evDir, maxEntries: 100 });
				const file = path.join(evDir, `k${i}.json`);
				const t = new Date(Date.now() - (5 - i) * 10_000);
				fs.utimesSync(file, t, t);
			}
			assert.equal(fs.readdirSync(evDir).filter((n) => n.endsWith(".json")).length, 5);
			// One write under a cap of 3 triggers a single eviction down to 3.
			await writeMediaCache("k5", { text: "t5", provider: "p", model: "m" }, { dir: evDir, maxEntries: 3 });
			const remaining = fs.readdirSync(evDir).filter((n) => n.endsWith(".json"));
			assert.equal(remaining.length, 3, `kept exactly the cap (got ${remaining.length})`);
			// The oldest three (k0, k1, k2) should be gone; k5 (just written) stays.
			assert.equal(remaining.includes("k0.json"), false, "oldest evicted");
			assert.equal(remaining.includes("k5.json"), true, "newest kept");
		} finally {
			fs.rmSync(evDir, { recursive: true, force: true });
		}
	});

	it("never throws on a bad directory (best-effort)", async () => {
		// A path whose parent is a FILE → mkdir/write fail, but the API must not throw.
		const fileAsDir = path.join(dir, "notadir.json");
		fs.writeFileSync(fileAsDir, "x");
		const badDir = path.join(fileAsDir, "sub");
		assert.equal(await readMediaCache("k", { dir: badDir }), undefined);
		await writeMediaCache("k", { text: "t", provider: "p", model: "m" }, { dir: badDir });
	});
});
