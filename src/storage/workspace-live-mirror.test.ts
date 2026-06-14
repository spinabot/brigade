import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__resetWorkspaceLiveMirrorForTests,
	awaitWorkspaceMirrorFlush,
	enqueueWorkspaceMirrorOp,
	ensureAgentInWorkspaceLiveMirror,
	startWorkspaceLiveMirror,
} from "./workspace-live-mirror.js";
import { markBootstrapSeeded, markSetupCompleted } from "../workspace/state.js";
import { __resetConfigCacheForTests, primeConfigCache } from "./config-cache.js";
import { __resetRuntimeContextForTests, setRuntimeContext } from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

// The fix this file pins: mid-session persona edits, lifecycle stamps, and
// manage_skill writes used to reach Convex only at the NEXT gateway boot
// (boot-time mirror reconcile) — everything since the last boot died with a
// `rm -rf ~/.brigade`. The live mirror pushes them as they happen, and the
// drain (awaitWorkspaceMirrorFlush) force-sweeps so even an edit inside the
// watcher debounce window is captured at exit. These tests use the forced
// sweep, not fs.watch timing, so they're deterministic.

class FakeStore {
	personaWrites: Array<{ agentId: string; name: string; content: string }> = [];
	personaRows: Array<{ name: string; content: string }> = [];
	bootstrapSeededFor: string[] = [];
	setupCompletedFor: string[] = [];
	skillWrites: Array<Record<string, unknown>> = [];
	skillRemoves: Array<Record<string, unknown>> = [];

	workspace = {
		listPersona: async (_agentId: string) =>
			this.personaRows.map((r) => ({ ...r, path: "convex://x", updatedAt: 1 })),
		writePersona: async (agentId: string, name: string, content: string) => {
			this.personaWrites.push({ agentId, name, content });
			return { rev: "r", writtenAt: 1, created: true };
		},
		markBootstrapSeeded: async (agentId: string) => {
			this.bootstrapSeededFor.push(agentId);
		},
		markSetupCompleted: async (agentId: string) => {
			this.setupCompletedFor.push(agentId);
		},
	};

	skills = {
		write: async (args: Record<string, unknown>) => {
			this.skillWrites.push(args);
			return { ref: String(args.name), created: true };
		},
		remove: async (args: Record<string, unknown>) => {
			this.skillRemoves.push(args);
			return { removed: true };
		},
	};
}

function installConvexContext(stateDir: string, fake: FakeStore): void {
	setRuntimeContext(
		Object.freeze({
			mode: "convex" as const,
			store: fake as unknown as BrigadeStore,
			clock: Date.now,
			stateDir,
		}),
	);
}

describe("workspace live mirror (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeStore;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-live-mirror-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeStore();
	});

	afterEach(() => {
		__resetWorkspaceLiveMirrorForTests();
		__resetRuntimeContextForTests();
		__resetConfigCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("an agent CREATED mid-session is mirrored immediately (ensureAgentInWorkspaceLiveMirror)", async () => {
		// Production gap (2026-06-12): a 20-agent org created mid-session had
		// all its persona files on disk but ZERO rows in personaFiles — the
		// mirror's watch set was built at boot from the config, so new agents
		// were invisible until the next gateway restart (a wipe in that window
		// lost their personas). bootstrapWorkspace now registers the agent +
		// pushes the seeded files right away.
		startWorkspaceLiveMirror(fake as unknown as BrigadeStore, { agents: {} });

		// Simulate org-init seeding a brand-new agent AFTER boot.
		const newWs = path.join(stateDir, "agents", "growth-lead", "workspace");
		mkdirSync(newWs, { recursive: true });
		writeFileSync(path.join(newWs, "IDENTITY.md"), "# Growth Lead\nrole: growth", "utf8");
		ensureAgentInWorkspaceLiveMirror("growth-lead");
		await awaitWorkspaceMirrorFlush();

		assert.deepEqual(fake.personaWrites, [
			{ agentId: "growth-lead", name: "IDENTITY.md", content: "# Growth Lead\nrole: growth" },
		]);

		// Idempotent: re-registering neither duplicates the watcher nor re-pushes.
		fake.personaWrites.length = 0;
		ensureAgentInWorkspaceLiveMirror("growth-lead");
		await awaitWorkspaceMirrorFlush();
		assert.deepEqual(fake.personaWrites, [], "unchanged files are not re-pushed");
	});

	it("a mid-session persona edit reaches convex at the next drain (not next boot)", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		startWorkspaceLiveMirror(fake as unknown as BrigadeStore, { agents: {} });

		writeFileSync(path.join(wsDir, "SOUL.md"), "# Soul v2\nbe bold", "utf8");
		await awaitWorkspaceMirrorFlush();

		assert.deepEqual(fake.personaWrites, [
			{ agentId: "main", name: "SOUL.md", content: "# Soul v2\nbe bold" },
		]);
	});

	it("priming from convex absorbs unchanged files (no redundant push)", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(path.join(wsDir, "AGENTS.md"), "same content", "utf8");
		fake.personaRows = [{ name: "AGENTS.md", content: "same content" }];

		startWorkspaceLiveMirror(fake as unknown as BrigadeStore, { agents: {} });
		await awaitWorkspaceMirrorFlush();

		assert.equal(fake.personaWrites.length, 0);
	});

	it("a pushed file is not re-pushed on the next drain", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		startWorkspaceLiveMirror(fake as unknown as BrigadeStore, { agents: {} });

		writeFileSync(path.join(wsDir, "USER.md"), "v1", "utf8");
		await awaitWorkspaceMirrorFlush();
		await awaitWorkspaceMirrorFlush();
		assert.equal(fake.personaWrites.length, 1);

		writeFileSync(path.join(wsDir, "USER.md"), "v2", "utf8");
		await awaitWorkspaceMirrorFlush();
		assert.equal(fake.personaWrites.length, 2);
		assert.equal(fake.personaWrites[1]?.content, "v2");
	});

	it("non-persona files are ignored", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		startWorkspaceLiveMirror(fake as unknown as BrigadeStore, { agents: {} });

		writeFileSync(path.join(wsDir, "scratch.txt"), "not a persona", "utf8");
		await awaitWorkspaceMirrorFlush();

		assert.equal(fake.personaWrites.length, 0);
	});

	it("covers per-agent workspaces from the config", async () => {
		const wsDir = path.join(stateDir, "agents", "researcher", "workspace");
		mkdirSync(wsDir, { recursive: true });
		startWorkspaceLiveMirror(fake as unknown as BrigadeStore, {
			agents: { researcher: {} },
		});

		writeFileSync(path.join(wsDir, "IDENTITY.md"), "# Researcher", "utf8");
		await awaitWorkspaceMirrorFlush();

		assert.deepEqual(fake.personaWrites, [
			{ agentId: "researcher", name: "IDENTITY.md", content: "# Researcher" },
		]);
	});

	it("enqueueWorkspaceMirrorOp rides the same drained chain", async () => {
		let ran = false;
		enqueueWorkspaceMirrorOp(async () => {
			ran = true;
		});
		await awaitWorkspaceMirrorFlush();
		assert.equal(ran, true);
	});
});

describe("lifecycle stamp dual-write (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeStore;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-stamp-mirror-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeStore();
		installConvexContext(stateDir, fake);
	});

	afterEach(() => {
		__resetWorkspaceLiveMirrorForTests();
		__resetRuntimeContextForTests();
		__resetConfigCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("markSetupCompleted stamps disk AND convex immediately", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });

		await markSetupCompleted(wsDir);
		await awaitWorkspaceMirrorFlush();

		// Disk stays the local source of truth.
		const raw = readFileSync(path.join(wsDir, ".brigade", "workspace-state.json"), "utf8");
		assert.match(raw, /setupCompletedAt/);
		// Convex no longer waits for the next boot.
		assert.deepEqual(fake.setupCompletedFor, ["main"]);
	});

	it("markBootstrapSeeded derives the per-agent id from the workspace path", async () => {
		const wsDir = path.join(stateDir, "agents", "researcher", "workspace");
		mkdirSync(wsDir, { recursive: true });

		await markBootstrapSeeded(wsDir);
		await awaitWorkspaceMirrorFlush();

		assert.deepEqual(fake.bootstrapSeededFor, ["researcher"]);
	});

	it("an already-stamped state does not re-mirror (idempotent short-circuit)", async () => {
		const wsDir = path.join(stateDir, "workspace");
		mkdirSync(wsDir, { recursive: true });
		await markSetupCompleted(wsDir);
		await markSetupCompleted(wsDir);
		await awaitWorkspaceMirrorFlush();

		assert.equal(fake.setupCompletedFor.length, 1);
	});
});

describe("manage_skill dual-write (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeStore;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-skill-mirror-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeStore();
		installConvexContext(stateDir, fake);
		// loadConfig() inside the tool serves from the primed cache in convex
		// mode (no brigade.json on disk).
		primeConfigCache({ agents: {} } as never);
	});

	afterEach(() => {
		__resetWorkspaceLiveMirrorForTests();
		__resetRuntimeContextForTests();
		__resetConfigCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("create writes the SKILL.md on disk AND upserts the convex table immediately", async () => {
		const { makeManageSkillTool } = await import("../agents/tools/manage-skill-tool.js");
		const tool = makeManageSkillTool({ requesterAgentId: "main" });

		const result = await tool.execute("t1", {
			action: "create",
			name: "weather-fetcher",
			description: "fetches weather",
		} as never);
		const details = (result as { details: { ok: boolean; skillFile: string } }).details;
		assert.equal(details.ok, true);
		assert.equal(existsSync(details.skillFile), true);

		await awaitWorkspaceMirrorFlush();
		assert.equal(fake.skillWrites.length, 1);
		const write = fake.skillWrites[0]!;
		assert.equal(write.scope, "workspace");
		assert.equal(write.agentId, "main");
		assert.equal(write.name, "weather-fetcher");
		assert.match(String(write.content), /^---\nname: weather-fetcher/);
	});

	it("delete removes the dir on disk AND the convex row immediately", async () => {
		const { makeManageSkillTool } = await import("../agents/tools/manage-skill-tool.js");
		const tool = makeManageSkillTool({ requesterAgentId: "main" });

		await tool.execute("t1", { action: "create", name: "tmp-skill" } as never);
		const result = await tool.execute("t2", { action: "delete", name: "tmp-skill" } as never);
		const details = (result as { details: { ok: boolean; skillDir: string } }).details;
		assert.equal(details.ok, true);
		assert.equal(existsSync(details.skillDir), false);

		await awaitWorkspaceMirrorFlush();
		assert.equal(fake.skillRemoves.length, 1);
		assert.equal(fake.skillRemoves[0]?.name, "tmp-skill");
		assert.equal(fake.skillRemoves[0]?.scope, "workspace");
	});

	it("filesystem mode does NOT touch the table (no runtime context)", async () => {
		__resetRuntimeContextForTests(); // back to no-context = filesystem behaviour
		const { makeManageSkillTool } = await import("../agents/tools/manage-skill-tool.js");
		const tool = makeManageSkillTool({ requesterAgentId: "main" });

		const result = await tool.execute("t1", { action: "create", name: "local-only" } as never);
		const details = (result as { details: { ok: boolean } }).details;
		assert.equal(details.ok, true);

		await awaitWorkspaceMirrorFlush();
		assert.equal(fake.skillWrites.length, 0);
	});
});
