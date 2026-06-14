import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetBootForTests } from "../storage/boot.js";
import {
	__resetRuntimeContextForTests,
	setRuntimeContext,
} from "../storage/runtime-context.js";
import type { BrigadeStore, PiTranscriptRecord } from "../storage/store.js";
import {
	__resetTranscriptQueueForTests,
	awaitTranscriptFlush,
	openSessionManagerForAgent,
} from "./session-manager-factory.js";

// The Pi SessionManager seam: filesystem mode is a passthrough to
// SessionManager.open; convex mode returns an inMemory() manager seeded
// from the store with appends routed to the write-behind queue.

interface BatchCall {
	agentId: string;
	sessionId: string;
	records: PiTranscriptRecord[];
}

class FakeMessagesApi {
	batches: BatchCall[] = [];
	replaces: BatchCall[] = [];
	seed: PiTranscriptRecord[] = [];
	async readTranscript(): Promise<PiTranscriptRecord[]> {
		return structuredClone(this.seed);
	}
	async appendRecordsBatch(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		this.batches.push({ agentId, sessionId, records: structuredClone(records) });
	}
	async replaceTranscript(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		this.replaces.push({ agentId, sessionId, records: structuredClone(records) });
	}
}

function installConvexContext(fake: FakeMessagesApi, stateDir: string): void {
	const store = { mode: "convex", messages: fake } as unknown as BrigadeStore;
	setRuntimeContext(
		Object.freeze({ mode: "convex" as const, store, clock: Date.now, stateDir }),
	);
}

describe("session-manager factory (convex mode)", () => {
	let stateDir: string;
	let savedStateDir: string | undefined;
	let fake: FakeMessagesApi;

	beforeEach(() => {
		stateDir = mkdtempSync(path.join(tmpdir(), "brigade-smf-"));
		savedStateDir = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		fake = new FakeMessagesApi();
	});

	afterEach(async () => {
		await awaitTranscriptFlush().catch(() => {});
		__resetRuntimeContextForTests();
		__resetBootForTests();
		__resetTranscriptQueueForTests();
		if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = savedStateDir;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("appends flow to the store and NOTHING lands on disk", async () => {
		installConvexContext(fake, stateDir);
		const sm = await openSessionManagerForAgent({
			agentId: "main",
			sessionId: "s-1",
			transcriptPath: path.join(stateDir, "agents", "main", "sessions", "s-1.jsonl"),
		});
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello crew" }],
		} as never);
		sm.appendThinkingLevelChange("high");

		await awaitTranscriptFlush();
		assert.equal(fake.batches.length, 1);
		const batch = fake.batches[0];
		assert.equal(batch?.agentId, "main");
		assert.equal(batch?.sessionId, "s-1");
		assert.deepEqual(
			batch?.records.map((r) => r.type),
			["message", "thinking_level_change"],
		);
		// Pi minted ids + parent chain live inside the records.
		assert.ok(typeof batch?.records[0]?.id === "string");
		assert.equal(batch?.records[1]?.parentId, batch?.records[0]?.id);
		// Strict-zero: no JSONL anywhere under the state dir.
		assert.deepEqual(readdirSync(stateDir), []);
	});

	it("seeds history from the store — context + leaf chain reconstruct", async () => {
		installConvexContext(fake, stateDir);
		fake.seed = [
			{ type: "session", version: 3, id: "hdr-1", timestamp: "2026-06-08T05:14:46.065Z", cwd: "F:\\Brigade" },
			{
				type: "message",
				id: "aaaa1111",
				parentId: null,
				timestamp: "2026-06-08T05:15:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "prior turn" }] },
			},
		] as unknown as PiTranscriptRecord[];

		const sm = await openSessionManagerForAgent({
			agentId: "main",
			sessionId: "s-2",
			transcriptPath: path.join(stateDir, "agents", "main", "sessions", "s-2.jsonl"),
		});
		assert.equal(sm.getLeafId(), "aaaa1111");
		const ctx = sm.buildSessionContext();
		assert.equal(ctx.messages.length, 1);

		// A new append chains onto the seeded leaf.
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }] } as never);
		await awaitTranscriptFlush();
		assert.equal(fake.batches[0]?.records[0]?.parentId, "aaaa1111");
	});

	it("filesystem mode is a passthrough — JSONL lands on disk as today", async () => {
		// No context installed → filesystem path.
		const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "s-3.jsonl");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(path.dirname(transcriptPath), { recursive: true });
		const sm = await openSessionManagerForAgent({
			agentId: "main",
			sessionId: "s-3",
			transcriptPath,
		});
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "disk" }] } as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
		} as never);
		const { existsSync } = await import("node:fs");
		assert.ok(existsSync(transcriptPath), "filesystem mode writes the JSONL");
		assert.equal(fake.batches.length, 0);
	});
});
