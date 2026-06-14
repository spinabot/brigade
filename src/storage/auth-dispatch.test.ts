import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__resetAuthCachesForTests,
	awaitAuthFlush,
	initAuthProfiles,
	primeAuthCaches,
	readProfiles,
	readState,
	upsertApiKeyProfile,
	writeState,
} from "../auth/profiles.js";
import {
	__resetProfileStateCacheForTests,
	awaitProfileStateFlush,
	loadProfileState,
	saveProfileState,
} from "../auth/profile-cooldown.js";
import { __resetBootForTests } from "./boot.js";
import { __resetRuntimeContextForTests, setRuntimeContext } from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

// Convex-mode dispatch for the auth files: profiles diff to row mutations
// (the adapter seals key→keyEnc before bytes leave the process); the two
// state files ride the authFiles blob table VERBATIM so the failover order
// array + lastGood map round-trip without semantic drift. Filesystem mode
// covered by the existing auth tests.

interface RecordedOp {
	kind: "upsertProfile" | "deleteProfile" | "writeBlob";
	agentId: string;
	detail: string;
}

class FakeAuthApi {
	ops: RecordedOp[] = [];
	blobs = new Map<string, Record<string, unknown>>();
	async upsertProfile(agentId: string, profile: { profileId?: string }): Promise<string> {
		this.ops.push({
			kind: "upsertProfile",
			agentId,
			detail: profile.profileId ?? "?",
		});
		return profile.profileId ?? "?";
	}
	async deleteProfile(agentId: string, profileId: string): Promise<void> {
		this.ops.push({ kind: "deleteProfile", agentId, detail: profileId });
	}
	async writeAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state",
		payload: Record<string, unknown>,
	): Promise<void> {
		this.ops.push({ kind: "writeBlob", agentId, detail: kind });
		this.blobs.set(`${agentId}|${kind}`, structuredClone(payload));
	}
	async readAuthFileBlob(
		agentId: string,
		kind: "auth-state" | "profile-state",
	): Promise<Record<string, unknown> | undefined> {
		return this.blobs.get(`${agentId}|${kind}`);
	}
	async listProfiles(): Promise<never[]> {
		return [];
	}
}

function installConvexContext(fake: FakeAuthApi, stateDir: string): void {
	const store = { mode: "convex", auth: fake } as unknown as BrigadeStore;
	setRuntimeContext(
		Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
	);
}

describe("auth dispatcher (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeAuthApi;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-auth-dispatch-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeAuthApi();
	});

	afterEach(async () => {
		await awaitAuthFlush().catch(() => {});
		await awaitProfileStateFlush().catch(() => {});
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetAuthCachesForTests();
		__resetProfileStateCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("initAuthProfiles creates NOTHING on disk in convex mode", () => {
		installConvexContext(fake, stateDir);
		initAuthProfiles("main");
		assert.deepEqual(readdirSync(stateDir), []);
		assert.deepEqual(readProfiles("main").profiles, {});
	});

	it("upsertApiKeyProfile lands in the cache + store mutation, never disk", async () => {
		installConvexContext(fake, stateDir);
		initAuthProfiles("main");
		const id = upsertApiKeyProfile("main", {
			provider: "openrouter",
			key: "sk-or-v1-test-secret",
		});
		assert.equal(id, "openrouter:default");

		// Read-back from cache sees it.
		const profiles = readProfiles("main");
		assert.equal(profiles.profiles["openrouter:default"]?.key, "sk-or-v1-test-secret");

		await awaitAuthFlush();
		assert.deepEqual(fake.ops, [
			{ kind: "upsertProfile", agentId: "main", detail: "openrouter:default" },
		]);
		// Strict-zero: the API key never touched ~/.brigade.
		assert.deepEqual(readdirSync(stateDir), []);
	});

	it("auth-state blob round-trips the failover order array VERBATIM", async () => {
		installConvexContext(fake, stateDir);
		writeState("main", {
			version: 1,
			order: { openrouter: ["openrouter:fast", "openrouter:default"] },
			lastGood: { openrouter: "openrouter:fast" },
			usageStats: {},
		});
		await awaitAuthFlush();

		const blob = fake.blobs.get("main|auth-state");
		assert.deepEqual((blob as { order?: unknown }).order, {
			openrouter: ["openrouter:fast", "openrouter:default"],
		});
		// The cache serves the same shape back.
		const state = readState("main");
		assert.deepEqual(state.order?.openrouter, ["openrouter:fast", "openrouter:default"]);
		assert.equal(state.lastGood?.openrouter, "openrouter:fast");
	});

	it("profile-state (cooldowns) rides its own blob with full fidelity", async () => {
		installConvexContext(fake, stateDir);
		saveProfileState("main", {
			version: 1,
			lastGood: { openrouter: "openrouter:default" },
			usageStats: {
				"openrouter:default": {
					lastUsed: 1780897322869,
					errorCount: 2,
					failureCounts: { rate_limit: 2 },
					cooldownUntil: 1780897999999,
					cooldownReason: "rate_limit",
				},
			},
		} as never);
		await awaitProfileStateFlush();

		const blob = fake.blobs.get("main|profile-state") as {
			usageStats?: Record<string, { failureCounts?: Record<string, number> }>;
		};
		assert.equal(blob.usageStats?.["openrouter:default"]?.failureCounts?.rate_limit, 2);

		const loaded = loadProfileState("main");
		assert.equal(
			(loaded.usageStats?.["openrouter:default"] as { cooldownReason?: string })
				?.cooldownReason,
			"rate_limit",
		);
		assert.deepEqual(readdirSync(stateDir), []);
	});

	it("hydration primes the caches the gate reads from", () => {
		installConvexContext(fake, stateDir);
		primeAuthCaches(
			"main",
			{
				version: 1,
				profiles: {
					"openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-x" },
				},
			},
			{ version: 1, order: {}, lastGood: { openrouter: "openrouter:default" }, usageStats: {} },
		);
		const profiles = readProfiles("main");
		assert.equal(profiles.profiles["openrouter:default"]?.provider, "openrouter");
		assert.equal(readState("main").lastGood?.openrouter, "openrouter:default");
	});

	it("filesystem mode untouched — files land on disk as today", () => {
		initAuthProfiles("main");
		upsertApiKeyProfile("main", { provider: "openrouter", key: "sk-disk" });
		assert.ok(readdirSync(stateDir).length > 0);
		assert.equal(readProfiles("main").profiles["openrouter:default"]?.key, "sk-disk");
		assert.equal(fake.ops.length, 0);
	});
});
