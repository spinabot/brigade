import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	readSessionStore,
	resolveOrCreateSession,
	type SessionEntry,
	upsertSessionEntry,
	writeSessionStore,
} from "../sessions/session-store.js";
import { __resetBootForTests } from "./boot.js";
import { __sessionMarshalling } from "./convex/session-store.js";
import {
	__resetSessionCacheForTests,
	awaitSessionFlush,
	primeSessionCache,
} from "./session-cache.js";
import { __resetRuntimeContextForTests, setRuntimeContext } from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

// Convex-mode dispatch for the sessions.json helpers: reads from the
// boot-hydrated cache, write-through diffs to the store. Filesystem mode is
// covered by the existing sessions tests (the dispatch falls through).

interface RecordedOp {
	kind: "upsert" | "delete";
	agentId: string;
	sessionKey: string;
	patch?: Partial<SessionEntry>;
}

class FakeSessionsApi {
	ops: RecordedOp[] = [];
	async upsertEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry> {
		this.ops.push({ kind: "upsert", agentId, sessionKey, patch });
		return patch as SessionEntry;
	}
	async deleteEntry(agentId: string, sessionKey: string): Promise<boolean> {
		this.ops.push({ kind: "delete", agentId, sessionKey });
		return true;
	}
}

function installConvexContext(fake: FakeSessionsApi, stateDir: string): void {
	const store = {
		mode: "convex",
		sessions: fake,
	} as unknown as BrigadeStore;
	setRuntimeContext(
		Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
	);
}

describe("session dispatcher (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeSessionsApi;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-sess-dispatch-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeSessionsApi();
	});

	afterEach(async () => {
		await awaitSessionFlush().catch(() => {});
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetSessionCacheForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("readSessionStore serves a clone from the primed cache", () => {
		installConvexContext(fake, stateDir);
		primeSessionCache("main", {
			version: 1,
			sessions: {
				"agent:main:main": {
					sessionId: "s-1",
					createdAt: "2026-06-08T05:14:46.065Z",
					lastUsedAt: "2026-06-08T05:14:46.065Z",
				},
			},
		});
		const file = readSessionStore("main");
		assert.equal(file.sessions["agent:main:main"]?.sessionId, "s-1");
		// Mutating the returned object must not poison the cache.
		delete file.sessions["agent:main:main"];
		assert.equal(
			readSessionStore("main").sessions["agent:main:main"]?.sessionId,
			"s-1",
		);
	});

	it("unprimed agent reads as the empty shape (brand-new agent)", () => {
		installConvexContext(fake, stateDir);
		const file = readSessionStore("brand-new-agent");
		assert.deepEqual(file, { version: 1, sessions: {} });
	});

	it("writeSessionStore diffs against the cache and enqueues upserts + deletes", async () => {
		installConvexContext(fake, stateDir);
		primeSessionCache("main", {
			version: 1,
			sessions: {
				keep: { sessionId: "k", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z" },
				drop: { sessionId: "d", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z" },
			},
		});
		writeSessionStore("main", {
			version: 1,
			sessions: {
				keep: { sessionId: "k", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z" },
				added: { sessionId: "a", createdAt: "2026-01-02T00:00:00.000Z", lastUsedAt: "2026-01-02T00:00:00.000Z" },
			},
		});
		await awaitSessionFlush();
		// `keep` unchanged → no op; `added` upserted; `drop` deleted.
		assert.deepEqual(
			fake.ops.map((o) => `${o.kind}:${o.sessionKey}`).sort(),
			["delete:drop", "upsert:added"],
		);
	});

	it("dropping subagent metadata realises as delete + reinsert (merge mutation can't clear)", async () => {
		installConvexContext(fake, stateDir);
		primeSessionCache("main", {
			version: 1,
			sessions: {
				rolled: {
					sessionId: "old",
					createdAt: "2026-01-01T00:00:00.000Z",
					lastUsedAt: "2026-01-01T00:00:00.000Z",
					subagent: { spawnDepth: 1, spawnedBy: "main", spawnedAt: "2026-01-01T00:00:00.000Z" },
				},
			},
		});
		writeSessionStore("main", {
			version: 1,
			sessions: {
				rolled: {
					sessionId: "new",
					createdAt: "2026-01-03T00:00:00.000Z",
					lastUsedAt: "2026-01-03T00:00:00.000Z",
				},
			},
		});
		await awaitSessionFlush();
		assert.deepEqual(
			fake.ops.map((o) => `${o.kind}:${o.sessionKey}`),
			["delete:rolled", "upsert:rolled"],
		);
	});

	it("the high-level helpers ride the dispatch — upsertSessionEntry + resolveOrCreateSession", async () => {
		installConvexContext(fake, stateDir);
		primeSessionCache("main", { version: 1, sessions: {} });

		const resolved = resolveOrCreateSession({ agentId: "main", sessionKey: "agent:main:test" });
		assert.equal(resolved.isNew, true);
		assert.ok(resolved.sessionId.length > 0);

		upsertSessionEntry("main", "agent:main:test", { thinkingLevel: "high" });
		await awaitSessionFlush();

		const upserts = fake.ops.filter((o) => o.kind === "upsert");
		assert.ok(upserts.length >= 2);
		// Cache reflects both writes.
		const file = readSessionStore("main");
		assert.equal(file.sessions["agent:main:test"]?.thinkingLevel, "high");
	});

	it("filesystem mode is untouched — no context installed, disk path runs", () => {
		const file = readSessionStore("main");
		assert.deepEqual(file, { version: 1, sessions: {} });
		assert.equal(fake.ops.length, 0);
	});
});

describe("convex session marshalling", () => {
	it("round-trips ISO timestamps and packs unknown fields into extra", () => {
		const { entryToMutationArgs, rowToEntry } = __sessionMarshalling;
		const entry: SessionEntry = {
			sessionId: "s-9",
			createdAt: "2026-06-08T05:14:46.065Z",
			lastUsedAt: "2026-06-09T01:00:00.000Z",
			provider: "openrouter",
			thinkingLevel: "high",
			compactionCount: 3,
			authProfileSource: "override",
		};
		const args = entryToMutationArgs(entry);
		assert.equal(args.createdAt, Date.parse(entry.createdAt));
		assert.equal(args.lastUsedAt, Date.parse(entry.lastUsedAt));
		assert.equal(args.provider, "openrouter");
		assert.ok(args.extra instanceof ArrayBuffer, "unknown fields packed as bytes");

		const back = rowToEntry({
			sessionId: "s-9",
			createdAt: args.createdAt,
			lastUsedAt: args.lastUsedAt,
			provider: "openrouter",
			thinkingLevel: "high",
			extra: args.extra,
		});
		assert.equal(back.createdAt, entry.createdAt);
		assert.equal(back.lastUsedAt, entry.lastUsedAt);
		assert.equal(back.compactionCount, 3);
		assert.equal(back.authProfileSource, "override");
	});

	it("subagent metadata passes through both directions", () => {
		const { entryToMutationArgs, rowToEntry } = __sessionMarshalling;
		const subagent = {
			spawnDepth: 2,
			spawnedBy: "main",
			spawnedAt: "2026-06-08T00:00:00.000Z",
			cleanup: "keep" as const,
		};
		const args = entryToMutationArgs({ subagent } as Partial<SessionEntry>);
		assert.deepEqual(args.subagent, subagent);
		const back = rowToEntry({ sessionId: "x", createdAt: 0, lastUsedAt: 0, subagent });
		assert.deepEqual(back.subagent, subagent);
	});
});
