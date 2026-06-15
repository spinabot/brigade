import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__resetEncryptionKeyCacheForTests,
	encryptionKeyFileExists,
	encryptionKeySource,
	encryptionStatus,
	isEncryptionEnabled,
	openToString,
	retireEncryptionKeyFile,
	saveEncryptionKeyToFile,
	sealString,
} from "./encryption.js";
import { classifyInstanceState, resetConvexInstance } from "./instance-admin.js";

// Onboarding key auto-gen: the key persists to a FILE outside ~/.brigade
// (survives the wipe convex mode is designed for), the env var always wins,
// existing keys are never silently overwritten, and a retired key is set
// aside — never destroyed. These tests pin all of that.

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("encryption key file (auto-gen persistence)", () => {
	let dir: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "brigade-keyfile-"));
		savedEnv = {
			BRIGADE_ENCRYPTION_KEY: process.env.BRIGADE_ENCRYPTION_KEY,
			BRIGADE_ENCRYPTION_KEY_OLD: process.env.BRIGADE_ENCRYPTION_KEY_OLD,
			BRIGADE_ENCRYPTION_KEY_FILE: process.env.BRIGADE_ENCRYPTION_KEY_FILE,
		};
		delete process.env.BRIGADE_ENCRYPTION_KEY;
		delete process.env.BRIGADE_ENCRYPTION_KEY_OLD;
		process.env.BRIGADE_ENCRYPTION_KEY_FILE = path.join(dir, "encryption.key");
		__resetEncryptionKeyCacheForTests();
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		__resetEncryptionKeyCacheForTests();
		rmSync(dir, { recursive: true, force: true });
	});

	it("no env + no file → encryption off, source none", () => {
		assert.equal(isEncryptionEnabled(), false);
		assert.equal(encryptionKeySource(), "none");
	});

	it("key file alone activates encryption (source: file) and round-trips", () => {
		saveEncryptionKeyToFile(KEY_A);
		assert.equal(encryptionKeyFileExists(), true);
		assert.equal(isEncryptionEnabled(), true);
		assert.equal(encryptionKeySource(), "file");
		const sealed = sealString("hello from the key file");
		assert.equal(openToString(sealed), "hello from the key file");
		// File is the hex + newline, 0600-intent.
		assert.equal(readFileSync(path.join(dir, "encryption.key"), "utf8").trim(), KEY_A);
	});

	it("the env var WINS over the key file", () => {
		saveEncryptionKeyToFile(KEY_A);
		process.env.BRIGADE_ENCRYPTION_KEY = KEY_B;
		__resetEncryptionKeyCacheForTests();
		assert.equal(encryptionKeySource(), "env");
		// Sealed with env key B — removing env and falling back to file key A
		// must NOT decrypt it (proves B was active).
		const sealed = sealString("sealed-with-env");
		delete process.env.BRIGADE_ENCRYPTION_KEY;
		__resetEncryptionKeyCacheForTests();
		assert.equal(encryptionKeySource(), "file");
		assert.throws(() => openToString(sealed), /failed to decrypt/);
	});

	it("refuses to overwrite an existing key file", () => {
		saveEncryptionKeyToFile(KEY_A);
		assert.throws(() => saveEncryptionKeyToFile(KEY_B), /refusing to overwrite/);
		assert.equal(readFileSync(path.join(dir, "encryption.key"), "utf8").trim(), KEY_A);
	});

	it("backupExisting sets the old key aside and activates the new one", () => {
		saveEncryptionKeyToFile(KEY_A);
		const sealedWithA = sealString("old data");
		const result = saveEncryptionKeyToFile(KEY_B, { backupExisting: true });
		assert.ok(result.backedUpTo && existsSync(result.backedUpTo));
		assert.equal(readFileSync(result.backedUpTo as string, "utf8").trim(), KEY_A);
		assert.equal(readFileSync(path.join(dir, "encryption.key"), "utf8").trim(), KEY_B);
		// New key active; old ciphertext no longer opens (B ≠ A)…
		assert.throws(() => openToString(sealedWithA), /failed to decrypt/);
		// …but new sealing round-trips.
		assert.equal(openToString(sealString("new data")), "new data");
	});

	it("retireEncryptionKeyFile renames (never deletes) and disables encryption", () => {
		saveEncryptionKeyToFile(KEY_A);
		const { backedUpTo } = retireEncryptionKeyFile();
		assert.ok(backedUpTo && existsSync(backedUpTo));
		assert.equal(encryptionKeyFileExists(), false);
		assert.equal(isEncryptionEnabled(), false);
		// Exactly one .bak file holding the original key.
		const baks = readdirSync(dir).filter((f) => f.startsWith("encryption.key.bak-"));
		assert.equal(baks.length, 1);
		assert.equal(readFileSync(path.join(dir, baks[0]!), "utf8").trim(), KEY_A);
	});

	it("retire on a missing file is a no-op", () => {
		assert.deepEqual(retireEncryptionKeyFile(), {});
	});

	it("a malformed key file is ignored (encryption stays off, no crash)", () => {
		writeFileSync(path.join(dir, "encryption.key"), "not-a-key\n", "utf8");
		__resetEncryptionKeyCacheForTests();
		assert.equal(isEncryptionEnabled(), false);
		assert.equal(encryptionKeySource(), "none");
	});

	it("encryptionStatus reports the source", () => {
		saveEncryptionKeyToFile(KEY_A);
		const status = encryptionStatus();
		assert.equal(status.enabled, true);
		assert.equal(status.source, "file");
		assert.match(status.primaryKeyFingerprint ?? "", /^[0-9a-f]{8}$/);
	});
});

describe("classifyInstanceState (onboarding restore-or-fresh routing)", () => {
	const base = {
		createdAtMs: 1,
		counts: { memories: 1, sessions: 1, cronJobs: 0, personas: 8 },
		whatsappLinked: false,
	};

	it("empty backend → fresh", () => {
		assert.equal(
			classifyInstanceState(
				{ ...base, hasData: false, storedKeyFingerprint: null, counts: { memories: 0, sessions: 0, cronJobs: 0, personas: 0 } },
				"aaaaaaaa",
			),
			"fresh",
		);
	});

	it("data + matching fingerprint → restorable", () => {
		assert.equal(
			classifyInstanceState({ ...base, hasData: true, storedKeyFingerprint: "aaaaaaaa" }, "aaaaaaaa"),
			"restorable",
		);
	});

	it("data + no pinned fingerprint → restorable (never-sealed data)", () => {
		assert.equal(
			classifyInstanceState({ ...base, hasData: true, storedKeyFingerprint: null }, "aaaaaaaa"),
			"restorable",
		);
	});

	it("data + different fingerprint → key-mismatch", () => {
		assert.equal(
			classifyInstanceState({ ...base, hasData: true, storedKeyFingerprint: "bbbbbbbb" }, "aaaaaaaa"),
			"key-mismatch",
		);
	});

	it("data + mismatch + NO active key → key-mismatch (not silently restorable)", () => {
		assert.equal(
			classifyInstanceState({ ...base, hasData: true, storedKeyFingerprint: "bbbbbbbb" }, undefined),
			"key-mismatch",
		);
	});
});

describe("resetConvexInstance (server-scheduled erase)", () => {
	it("kicks off the reset and polls status, summing deletions and reporting per-table progress", async () => {
		// Simulated backend: the server-side workers drain each table over time;
		// every resetStatus poll advances each not-yet-done table by one batch.
		const tables = [
			{ table: "big", total: 450, deleted: 0 },
			{ table: "small", total: 10, deleted: 0 },
		];
		let started = false;
		let startCalls = 0;
		const client = {
			async query() {
				// resetStatus — null until the run has been started.
				if (!started) return null;
				for (const t of tables) t.deleted = Math.min(t.total, t.deleted + 200);
				const deletedTotal = tables.reduce((s, t) => s + t.deleted, 0);
				const tablesDone = tables.filter((t) => t.deleted >= t.total).length;
				return {
					done: tablesDone >= tables.length,
					deletedTotal,
					tablesTotal: tables.length,
					tablesDone,
					tables: tables.map((t) => ({
						table: t.table,
						deleted: t.deleted,
						done: t.deleted >= t.total,
					})),
					updatedAt: 1,
				};
			},
			async mutation(_ref: unknown, args: Record<string, unknown>) {
				// resetStart
				started = true;
				startCalls += 1;
				return { runId: String(args.runId), tablesTotal: tables.length };
			},
		};
		const progress: Array<{ table: string; n: number }> = [];
		const { deletedTotal } = await resetConvexInstance("http://fake", {
			clientOverride: client,
			pollMs: 0,
			onProgress: (table, n) => progress.push({ table, n }),
		});
		assert.equal(deletedTotal, 460);
		assert.equal(startCalls, 1); // started exactly once, then polled
		// big drains over 3 polls (200 → 400 → 450); small in 1 (10).
		assert.ok(progress.some((p) => p.table === "big" && p.n === 450));
		assert.ok(progress.some((p) => p.table === "small" && p.n === 10));
	});

	it("throws when the reset stalls (a worker died) instead of polling forever", async () => {
		// Status never advances — a worker was killed mid-table and can't
		// reschedule. The client must give up after the stall window, not hang.
		let started = false;
		const client = {
			async query() {
				if (!started) return null;
				return {
					done: false,
					deletedTotal: 0,
					tablesTotal: 1,
					tablesDone: 0,
					tables: [{ table: "big", deleted: 0, done: false }],
					updatedAt: 1,
				};
			},
			async mutation() {
				started = true;
				return {};
			},
		};
		await assert.rejects(
			resetConvexInstance("http://fake", {
				clientOverride: client,
				pollMs: 0,
				stallTimeoutMs: 5,
			}),
			/stalled/,
		);
	});
});

