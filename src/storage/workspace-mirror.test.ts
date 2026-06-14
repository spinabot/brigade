import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetBootForTests, bootRuntimeContext } from "./boot.js";
import { __resetConfigCacheForTests } from "./config-cache.js";
import { __resetSessionCacheForTests } from "./session-cache.js";
import { __resetCronCacheForTests } from "./cron-cache.js";
import { __resetFactsCacheForTests } from "./facts-cache.js";
import { __resetAuthCachesForTests } from "../auth/profiles.js";
import { __resetProfileStateCacheForTests } from "../auth/profile-cooldown.js";
import { _resetApprovalsCacheForTests } from "../core/exec-approvals.js";
import { __resetAccessCacheForTests } from "../agents/channels/access-control/store.js";
import { __resetRuntimeContextForTests } from "./runtime-context.js";
import type { BrigadeStore, ContextFile, PersonaName } from "./store.js";

// Boot-time two-way workspace mirror: disk pushes to Convex while present;
// Convex materialises to disk when the file is missing (fresh machine).
// The workspace directory itself stays local in both modes by design.

class FakeWorkspaceApi {
	rows = new Map<string, Map<PersonaName, string>>(); // agentId -> name -> content
	pushes: Array<{ agentId: string; name: PersonaName }> = [];
	states = new Map<string, { bootstrapSeededAt?: string; setupCompletedAt?: string }>();

	async listPersona(agentId: string): Promise<ContextFile[]> {
		const byName = this.rows.get(agentId) ?? new Map<PersonaName, string>();
		return Array.from(byName, ([name, content]) => ({
			name,
			path: `convex://${agentId}/${name}`,
			content,
			updatedAt: Date.now(),
		}));
	}
	deletes: Array<{ agentId: string; name: PersonaName }> = [];
	async writePersona(agentId: string, name: PersonaName, content: string): Promise<{ created: boolean }> {
		const byName = this.rows.get(agentId) ?? new Map<PersonaName, string>();
		const created = !byName.has(name);
		byName.set(name, content);
		this.rows.set(agentId, byName);
		this.pushes.push({ agentId, name });
		return { created };
	}
	async deletePersona(agentId: string, name: PersonaName): Promise<boolean> {
		const had = this.rows.get(agentId)?.delete(name) ?? false;
		this.deletes.push({ agentId, name });
		return had;
	}
	async readState(agentId: string): Promise<{ version: number; bootstrapSeededAt?: string; setupCompletedAt?: string }> {
		return { version: 1, ...(this.states.get(agentId) ?? {}) };
	}
	async markBootstrapSeeded(agentId: string): Promise<void> {
		this.states.set(agentId, { ...this.states.get(agentId), bootstrapSeededAt: new Date().toISOString() });
	}
	async markSetupCompleted(agentId: string): Promise<void> {
		this.states.set(agentId, { ...this.states.get(agentId), setupCompletedAt: new Date().toISOString() });
	}
}

/** Minimal store stub satisfying everything bootRuntimeContext hydrates. */
function makeStubStore(workspace: FakeWorkspaceApi, cfg: Record<string, unknown>): BrigadeStore {
	return {
		mode: "convex",
		async init() {},
		async close() {},
		async healthcheck() {
			return { ok: true, details: {} };
		},
		config: {
			async read() {
				return { value: cfg, rev: "r0" };
			},
			subscribe() {
				return () => {};
			},
		},
		sessions: { async listEntries() { return []; } },
		execApprovals: { async list() { return { commands: [], patterns: [] }; } },
		channels: { async listAllAccessRows() { return []; } },
		cron: { async listJobs() { return []; } },
		memory: { async listAllFactRecordsRaw() { return []; } },
		auth: {
			async listProfiles() { return []; },
			async readAuthFileBlob() { return undefined; },
		},
		workspace,
	} as unknown as BrigadeStore;
}

describe("workspace mirror sync (convex mode boot)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeWorkspaceApi;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-ws-mirror-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeWorkspaceApi();
	});

	afterEach(() => {
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetConfigCacheForTests();
		__resetSessionCacheForTests();
		__resetCronCacheForTests();
		__resetFactsCacheForTests();
		__resetAuthCachesForTests();
		__resetProfileStateCacheForTests();
		_resetApprovalsCacheForTests();
		__resetAccessCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	async function bootWith(cfg: Record<string, unknown>): Promise<void> {
		const { createRuntimeContext, setRuntimeContext } = await import("./runtime-context.js");
		void createRuntimeContext;
		void setRuntimeContext;
		const { primeConfigCache } = await import("./config-cache.js");
		void primeConfigCache;
		// Use bootRuntimeContext's injected-store path by pre-setting env to
		// convex via a store: createRuntimeContext({store}) skips sentinel
		// resolution. bootRuntimeContext doesn't take args, so install the
		// context manually mirroring its convex branch — by calling the real
		// boot against a store override isn't possible; instead reproduce by
		// calling createRuntimeContext + the hydration path via boot.
		// Simplest: set BRIGADE_MODE=convex is not viable (real client).
		// So: call the internal path by importing boot and letting it use a
		// a test store through createRuntimeContext's opts — boot doesn't
		// expose opts, so we directly exercise syncWorkspaceMirrors via a
		// crafted bootRuntimeContext substitute below.
	}
	void bootWith;

	it("pushes disk personas to convex and materialises missing ones from convex", async () => {
		// Disk: main workspace has a customised SOUL.md; convex has an
		// IDENTITY.md the disk lost.
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(path.join(wsDir, "SOUL.md"), "# Custom Soul\nbe kind", "utf8");
		fake.rows.set(
			"main",
			new Map([["IDENTITY.md" as PersonaName, "# Restored Identity\nname: Pride"]]),
		);

		const cfg = { agents: {} };
		const store = makeStubStore(fake, cfg);
		const { setRuntimeContext } = await import("./runtime-context.js");
		setRuntimeContext(
			Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
		);
		// Exercise the sync directly through the boot module's exported-for-
		// boot path: bootRuntimeContext would re-create a real store, so call
		// the underlying sync via a fresh boot import is not possible —
		// instead we re-import boot and use its test hook.
		const boot = await import("./boot.js");
		await (boot as unknown as { __syncWorkspaceMirrorsForTests: (s: BrigadeStore, c: Record<string, unknown>) => Promise<void> }).__syncWorkspaceMirrorsForTests(store, cfg);

		// Push direction: SOUL.md landed in convex.
		assert.equal(fake.rows.get("main")?.get("SOUL.md" as PersonaName), "# Custom Soul\nbe kind");
		// Materialise direction: IDENTITY.md restored to disk.
		assert.ok(existsSync(path.join(wsDir, "IDENTITY.md")));
		assert.equal(
			readFileSync(path.join(wsDir, "IDENTITY.md"), "utf8"),
			"# Restored Identity\nname: Pride",
		);
	});

	it("agents with neither disk dir nor convex rows are untouched", async () => {
		const cfg = { agents: { researcher: {} } };
		const store = makeStubStore(fake, cfg);
		const { setRuntimeContext } = await import("./runtime-context.js");
		setRuntimeContext(
			Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
		);
		const boot = await import("./boot.js");
		await (boot as unknown as { __syncWorkspaceMirrorsForTests: (s: BrigadeStore, c: Record<string, unknown>) => Promise<void> }).__syncWorkspaceMirrorsForTests(store, cfg);

		assert.equal(existsSync(path.join(stateDir, "agents", "researcher", "workspace")), false);
		assert.equal(fake.pushes.length, 0);
	});

	it("consumed BOOTSTRAP.md is NOT restored and its mirror row is reaped", async () => {
		// First-run completed (setupCompletedAt set) and BOOTSTRAP.md was
		// deleted from disk — but a stale row still sits in convex. The sync
		// must NOT resurrect it on disk and must delete the stale row.
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(path.join(wsDir, "SOUL.md"), "soul", "utf8");
		fake.rows.set(
			"main",
			new Map([
				["SOUL.md" as PersonaName, "soul"],
				["BOOTSTRAP.md" as PersonaName, "# First run\nWho am I?"],
			]),
		);
		fake.states.set("main", { setupCompletedAt: "2026-06-10T00:00:00.000Z" });

		const cfg = { agents: {} };
		const store = makeStubStore(fake, cfg);
		const { setRuntimeContext } = await import("./runtime-context.js");
		setRuntimeContext(
			Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
		);
		const boot = await import("./boot.js");
		await (boot as unknown as { __syncWorkspaceMirrorsForTests: (s: BrigadeStore, c: Record<string, unknown>) => Promise<void> }).__syncWorkspaceMirrorsForTests(store, cfg);

		// Not resurrected on disk.
		assert.equal(existsSync(path.join(wsDir, "BOOTSTRAP.md")), false);
		// Stale convex row reaped.
		assert.equal(fake.rows.get("main")?.has("BOOTSTRAP.md" as PersonaName), false);
		assert.ok(fake.deletes.some((d) => d.name === ("BOOTSTRAP.md" as PersonaName)));
	});

	it("unchanged disk content does not re-push", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(path.join(wsDir, "AGENTS.md"), "same", "utf8");
		fake.rows.set("main", new Map([["AGENTS.md" as PersonaName, "same"]]));

		const cfg = { agents: {} };
		const store = makeStubStore(fake, cfg);
		const { setRuntimeContext } = await import("./runtime-context.js");
		setRuntimeContext(
			Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
		);
		const boot = await import("./boot.js");
		await (boot as unknown as { __syncWorkspaceMirrorsForTests: (s: BrigadeStore, c: Record<string, unknown>) => Promise<void> }).__syncWorkspaceMirrorsForTests(store, cfg);

		assert.equal(fake.pushes.length, 0);
	});
});
