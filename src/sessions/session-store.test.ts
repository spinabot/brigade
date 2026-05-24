import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	deleteSessionEntry,
	listSubagentSessionEntries,
	readSessionStore,
	readSubagentMetadata,
	resolveOrCreateSession,
} from "./session-store.js";

let tmpStateDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
	tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-session-store-"));
	prevEnv = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = tmpStateDir;
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevEnv;
	try {
		fs.rmSync(tmpStateDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("session-store — sub-agent metadata persistence (Primitive #6)", () => {
	it("persists `subagent` block when overrides include it", () => {
		const resolved = resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:abc",
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: "agent:main:main",
					parentRunId: "run-123",
					label: "audit",
					cleanup: "keep",
					spawnedAt: "2026-05-24T10:00:00.000Z",
				},
			},
		});
		assert.equal(resolved.entry.subagent?.spawnDepth, 1);
		assert.equal(resolved.entry.subagent?.spawnedBy, "agent:main:main");
		assert.equal(resolved.entry.subagent?.label, "audit");
		assert.equal(resolved.entry.subagent?.cleanup, "keep");

		// Round-trip via the readers: simulate a "crash + restart" by re-reading
		// from disk.
		const reread = readSubagentMetadata("main", "agent:main:main:subagent:abc");
		assert.deepEqual(reread, {
			spawnDepth: 1,
			spawnedBy: "agent:main:main",
			parentRunId: "run-123",
			label: "audit",
			cleanup: "keep",
			spawnedAt: "2026-05-24T10:00:00.000Z",
		});
	});

	it("leaves top-level sessions without sub-agent metadata", () => {
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main",
		});
		const metadata = readSubagentMetadata("main", "agent:main:main");
		assert.equal(metadata, undefined);
	});

	it("listSubagentSessionEntries returns only sub-agent entries, sorted by spawnedAt", () => {
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main",
		});
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:second",
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: "agent:main:main",
					label: "later",
					cleanup: "keep",
					spawnedAt: "2026-05-24T12:00:00.000Z",
				},
			},
		});
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:first",
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: "agent:main:main",
					label: "earlier",
					cleanup: "delete",
					spawnedAt: "2026-05-24T11:00:00.000Z",
				},
			},
		});
		const list = listSubagentSessionEntries("main");
		assert.equal(list.length, 2);
		assert.equal(list[0]?.subagent.label, "earlier");
		assert.equal(list[1]?.subagent.label, "later");
		// Top-level session (no `subagent` field) is correctly excluded.
		const keys = list.map((r) => r.sessionKey);
		assert.ok(!keys.includes("agent:main:main"));
	});

	it("treats `subagent` metadata as write-once (Object.assign won't overwrite it)", () => {
		// First write — creates the entry with the original metadata.
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:abc",
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: "agent:main:main",
					label: "original",
					cleanup: "keep",
					spawnedAt: "2026-05-24T10:00:00.000Z",
				},
			},
		});
		// Second resolve on the SAME key — with a different subagent payload.
		// The contract says metadata is written ONCE at creation; subsequent
		// resolves must not overwrite it.
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:abc",
			overrides: {
				provider: "anthropic",
				subagent: {
					spawnDepth: 9,
					spawnedBy: "agent:main:other",
					label: "OVERWRITE-ATTEMPT",
					cleanup: "delete",
					spawnedAt: "2099-01-01T00:00:00.000Z",
				},
			},
		});
		const metadata = readSubagentMetadata("main", "agent:main:main:subagent:abc");
		// Original metadata preserved despite the attempted re-write.
		assert.equal(metadata?.label, "original");
		assert.equal(metadata?.cleanup, "keep");
		assert.equal(metadata?.spawnDepth, 1);
		assert.equal(metadata?.spawnedAt, "2026-05-24T10:00:00.000Z");
	});

	it("deleteSessionEntry removes the entry + returns true on hit, false otherwise", () => {
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:abc",
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: "agent:main:main",
					label: "delete-me",
					cleanup: "delete",
					spawnedAt: "2026-05-24T10:00:00.000Z",
				},
			},
		});
		assert.equal(deleteSessionEntry("main", "agent:main:main:subagent:abc"), true);
		// Entry gone — readSubagentMetadata returns undefined now.
		assert.equal(
			readSubagentMetadata("main", "agent:main:main:subagent:abc"),
			undefined,
		);
		// Idempotent: second delete is a no-op + returns false.
		assert.equal(deleteSessionEntry("main", "agent:main:main:subagent:abc"), false);
		// Unrelated keys: no-op + false.
		assert.equal(deleteSessionEntry("main", "agent:main:main:subagent:nonexistent"), false);
	});

	it("survives a write+read cycle (atomic tmp+rename)", () => {
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: "agent:main:main:subagent:abc",
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: "agent:main:main",
					label: "audit",
					cleanup: "delete",
					spawnedAt: "2026-05-24T10:00:00.000Z",
				},
			},
		});
		// Read back via the raw store accessor (not the convenience helper) to
		// confirm the JSON shape lands on disk as expected.
		const store = readSessionStore("main");
		const entry = store.sessions["agent:main:main:subagent:abc"];
		assert.ok(entry);
		assert.equal(entry?.subagent?.label, "audit");
		assert.equal(entry?.subagent?.cleanup, "delete");
	});
});
