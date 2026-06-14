import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	awaitConfigFlush,
	type BrigadeConfig,
	mutateConfigAtomic,
	readConfigOrInit,
	writeConfigSafe,
	writeConfigSafeAsync,
} from "../config/io.js";
import { __resetBootForTests } from "./boot.js";
import { __resetConfigCacheForTests, primeConfigCache } from "./config-cache.js";
import {
	__resetRuntimeContextForTests,
	createRuntimeContext,
	setRuntimeContext,
} from "./runtime-context.js";
import type { BrigadeStore, ConfigStore, RevToken, WriteResult } from "./store.js";

// The dispatcher under test: readConfigOrInit / writeConfigSafe route through
// the convex store when the RuntimeContext says mode === "convex", and stay
// byte-identical to today's disk path in filesystem mode (covered by the
// existing config/io tests — these tests cover the convex branch).

/** Minimal in-memory ConfigStore standing in for the convex adapter. */
class FakeConfigStore implements ConfigStore {
	value: BrigadeConfig = { agents: {} };
	writes: BrigadeConfig[] = [];
	subscribers: Array<(cfg: BrigadeConfig, rev: RevToken) => void> = [];

	async read(): Promise<{ value: BrigadeConfig; rev: RevToken }> {
		return { value: structuredClone(this.value), rev: "r0" as RevToken };
	}
	async write(cfg: BrigadeConfig): Promise<WriteResult> {
		this.value = structuredClone(cfg);
		this.writes.push(structuredClone(cfg));
		return { rev: "r1" as RevToken, writtenAt: Date.now() };
	}
	async mutate(
		fn: (current: BrigadeConfig) => BrigadeConfig | Promise<BrigadeConfig>,
	): Promise<BrigadeConfig> {
		const next = await fn(structuredClone(this.value));
		await this.write(next);
		return next;
	}
	subscribe(cb: (cfg: BrigadeConfig, rev: RevToken) => void): () => void {
		this.subscribers.push(cb);
		return () => {
			this.subscribers = this.subscribers.filter((s) => s !== cb);
		};
	}
	async listBackups(): Promise<Array<{ slot: number; sha256: string; mtimeMs: number; bytes: number }>> {
		return [];
	}
	async restoreBackup(): Promise<BrigadeConfig> {
		throw new Error("not wired");
	}
}

function installConvexContext(configStore: FakeConfigStore, stateDir: string): void {
	// Only the config sub-store is exercised by the dispatcher; the rest of
	// the BrigadeStore surface is intentionally absent (a test that reaches
	// it should fail loudly).
	const store = {
		mode: "convex",
		config: configStore,
		async init() {},
		async close() {},
		async healthcheck() {
			return { ok: true, details: {} };
		},
	} as unknown as BrigadeStore;
	void createRuntimeContext; // mode comes from the injected store
	setRuntimeContext(
		Object.freeze({
			mode: "convex" as const,
			store,
			clock: Date.now,
			stateDir,
		}),
	);
}

describe("config dispatcher (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let savedMode: string | undefined;
	let savedConvexUrl: string | undefined;
	let fake: FakeConfigStore;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-cfg-dispatch-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		// Hermeticity: a stray BRIGADE_MODE/BRIGADE_CONVEX_URL in the dev shell
		// would make peekConvexMode see convex during the no-context phases and
		// the config writer fail closed. Same isolation as boot.test.ts.
		savedMode = process.env.BRIGADE_MODE;
		savedConvexUrl = process.env.BRIGADE_CONVEX_URL;
		delete process.env.BRIGADE_MODE;
		delete process.env.BRIGADE_CONVEX_URL;
		fake = new FakeConfigStore();
	});

	afterEach(async () => {
		// Drain any in-flight convex flush before tearing down so a later
		// test doesn't observe this test's write landing.
		await awaitConfigFlush().catch(() => {});
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetConfigCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		if (savedMode === undefined) delete process.env.BRIGADE_MODE;
		else process.env.BRIGADE_MODE = savedMode;
		if (savedConvexUrl === undefined) delete process.env.BRIGADE_CONVEX_URL;
		else process.env.BRIGADE_CONVEX_URL = savedConvexUrl;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("readConfigOrInit serves from the primed cache, never disk", () => {
		installConvexContext(fake, stateDir);
		primeConfigCache({ agents: { defaults: { provider: "openrouter" } } } as BrigadeConfig);
		const cfg = readConfigOrInit();
		assert.equal(
			(cfg as { agents?: { defaults?: { provider?: string } } }).agents?.defaults?.provider,
			"openrouter",
		);
	});

	it("readConfigOrInit throws when the cache was never primed", () => {
		installConvexContext(fake, stateDir);
		assert.throws(() => readConfigOrInit(), /config cache not primed/);
	});

	it("returned config is a private copy — caller mutations don't poison the cache", () => {
		installConvexContext(fake, stateDir);
		primeConfigCache({ agents: {} } as BrigadeConfig);
		const a = readConfigOrInit() as Record<string, unknown>;
		a.gateway = { port: 9999 };
		const b = readConfigOrInit() as { gateway?: unknown };
		assert.equal(b.gateway, undefined);
	});

	it("resolves ${VAR} secret refs on read, mirroring the disk path", () => {
		installConvexContext(fake, stateDir);
		process.env.BRIGADE_TEST_SECRET_X = "sk-resolved-value";
		try {
			primeConfigCache({
				agents: {},
				gateway: { auth: { token: "${BRIGADE_TEST_SECRET_X}" } },
			} as unknown as BrigadeConfig);
			const cfg = readConfigOrInit() as {
				gateway?: { auth?: { token?: string } };
			};
			assert.equal(cfg.gateway?.auth?.token, "sk-resolved-value");
		} finally {
			delete process.env.BRIGADE_TEST_SECRET_X;
		}
	});

	it("writeConfigSafe updates the cache synchronously and persists to the store", async () => {
		installConvexContext(fake, stateDir);
		primeConfigCache({ agents: {} } as BrigadeConfig);
		writeConfigSafe({ agents: {}, meta: { lastTouchedVersion: "9.9.9" } } as BrigadeConfig);

		// Cache visible immediately (sync), before the store write settles.
		const reread = readConfigOrInit() as { meta?: { lastTouchedVersion?: string } };
		assert.equal(reread.meta?.lastTouchedVersion, "9.9.9");

		await awaitConfigFlush();
		assert.equal(fake.writes.length, 1);
		assert.equal(
			(fake.writes[0] as { meta?: { lastTouchedVersion?: string } }).meta?.lastTouchedVersion,
			"9.9.9",
		);
	});

	it("restores ${VAR} refs before persisting — resolved secrets never reach the store", async () => {
		installConvexContext(fake, stateDir);
		process.env.BRIGADE_TEST_SECRET_Y = "sk-super-secret";
		try {
			primeConfigCache({
				agents: {},
				gateway: { auth: { token: "${BRIGADE_TEST_SECRET_Y}" } },
			} as unknown as BrigadeConfig);
			// Read resolves the ref; write the SAME (resolved) object back —
			// the round-trip every wizard step performs.
			const cfg = readConfigOrInit();
			writeConfigSafe(cfg);
			await awaitConfigFlush();
			const persisted = fake.writes[0] as {
				gateway?: { auth?: { token?: string } };
			};
			assert.equal(persisted.gateway?.auth?.token, "${BRIGADE_TEST_SECRET_Y}");
		} finally {
			delete process.env.BRIGADE_TEST_SECRET_Y;
		}
	});

	it("writeConfigSafeAsync resolves only after the store write landed", async () => {
		installConvexContext(fake, stateDir);
		primeConfigCache({ agents: {} } as BrigadeConfig);
		await writeConfigSafeAsync({ agents: {}, meta: { lastTouchedAt: "now" } } as BrigadeConfig);
		assert.equal(fake.writes.length, 1);
	});

	it("mutateConfigAtomic round-trips through cache + store", async () => {
		installConvexContext(fake, stateDir);
		primeConfigCache({ agents: {} } as BrigadeConfig);
		const out = (await mutateConfigAtomic((current) => ({
			...current,
			meta: { lastTouchedVersion: "1.2.3" },
		}))) as { meta?: { lastTouchedVersion?: string } };
		assert.equal(out.meta?.lastTouchedVersion, "1.2.3");
		assert.equal(fake.writes.length, 1);
		const reread = readConfigOrInit() as { meta?: { lastTouchedVersion?: string } };
		assert.equal(reread.meta?.lastTouchedVersion, "1.2.3");
	});

	it("filesystem mode is untouched — no context installed, disk path runs", () => {
		// No RuntimeContext installed at all (pre-boot state): the dispatcher
		// must fall through to the disk body, which inits `{agents:{}}` for a
		// missing brigade.json under the tempdir state dir.
		const cfg = readConfigOrInit() as { agents?: unknown };
		assert.deepEqual(cfg.agents, {});
	});
});
