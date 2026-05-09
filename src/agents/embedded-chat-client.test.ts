import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { makeEmbeddedChatClient } from "./embedded-chat-client.js";

// We don't construct a real Pi AgentSession in unit tests — Pi's session
// has heavy dependencies (auth, model registry, file I/O for transcripts).
// Instead, we stub the methods/getters the wrapper actually touches and
// verify the wrapper:
//   1. forwards every call to the right session method
//   2. translates types where the public ChatClient API differs from
//      Pi's signature (e.g. steer's image shape)
//   3. doesn't smuggle Pi-specific quirks through

interface StubLogEntry {
	method: string;
	args?: unknown;
}

interface StubSession {
	__log: StubLogEntry[];
	__handlers: Set<(ev: unknown) => void>;
	messages: unknown[];
	model: { id: string } | undefined;
	thinkingLevel: string;
	supportsThinking(): boolean;
	getAvailableThinkingLevels(): string[];
	getContextUsage(): unknown;
	subscribe(listener: (ev: unknown) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	steer(text: string, images?: unknown): Promise<void>;
	setModel(model: unknown): Promise<void>;
	setThinkingLevel(level: string): void;
	compact(): Promise<unknown>;
}

function makeStubSession(overrides: Partial<StubSession> = {}): StubSession {
	const log: StubLogEntry[] = [];
	const handlers = new Set<(ev: unknown) => void>();
	const stub: StubSession = {
		__log: log,
		__handlers: handlers,
		messages: [],
		model: { id: "openai/gpt-5.4" },
		thinkingLevel: "off",
		supportsThinking: () => true,
		getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
		getContextUsage: () => ({ used: 0, total: 200000 }),
		subscribe(listener) {
			handlers.add(listener);
			return () => {
				handlers.delete(listener);
			};
		},
		async prompt(text) {
			log.push({ method: "prompt", args: text });
		},
		async abort() {
			log.push({ method: "abort" });
		},
		async steer(text, images) {
			log.push({ method: "steer", args: { text, images } });
		},
		async setModel(model) {
			log.push({ method: "setModel", args: model });
		},
		setThinkingLevel(level) {
			log.push({ method: "setThinkingLevel", args: level });
		},
		async compact() {
			log.push({ method: "compact" });
			return { previousMessageCount: 0, summaryMessageCount: 0 };
		},
		...overrides,
	};
	return stub;
}

describe("makeEmbeddedChatClient — read-only metadata", () => {
	it("exposes messages, model, thinkingLevel, supportsThinking, getAvailableThinkingLevels", () => {
		const session = makeStubSession({ thinkingLevel: "low" });
		const client = makeEmbeddedChatClient({ session: session as never });

		assert.deepEqual(client.messages, []);
		assert.deepEqual(client.model, { id: "openai/gpt-5.4" });
		assert.equal(client.thinkingLevel, "low");
		assert.equal(client.supportsThinking(), true);
		assert.deepEqual(client.getAvailableThinkingLevels(), ["off", "low", "medium", "high"]);
	});

	it("model getter returns null when Pi's model is undefined", () => {
		const session = makeStubSession({ model: undefined });
		const client = makeEmbeddedChatClient({ session: session as never });
		assert.equal(client.model, null);
	});
});

describe("makeEmbeddedChatClient — subscribe", () => {
	it("forwards events from Pi to the listener", () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		const seen: unknown[] = [];
		client.subscribe((ev) => seen.push(ev));

		// Fire an event into the stub's listeners directly
		for (const h of session.__handlers) h({ type: "agent_start" });
		assert.deepEqual(seen, [{ type: "agent_start" }]);
	});

	it("disposer removes the listener and is idempotent", () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		const seen: unknown[] = [];
		const dispose = client.subscribe((ev) => seen.push(ev));

		dispose();
		dispose(); // idempotent — no throw

		for (const h of session.__handlers) h({ type: "agent_end" });
		assert.equal(seen.length, 0, "after dispose, no events should arrive");
	});
});

describe("makeEmbeddedChatClient — turn control", () => {
	it("prompt forwards to session.prompt", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		await client.prompt("hey");
		assert.deepEqual(session.__log, [{ method: "prompt", args: "hey" }]);
	});

	it("prompt with already-aborted signal calls session.abort and returns early", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		const ctl = new AbortController();
		ctl.abort();
		await client.prompt("hey", { signal: ctl.signal });
		assert.deepEqual(
			session.__log.map((e) => e.method),
			["abort"],
			"only abort should fire — prompt skipped because signal already fired",
		);
	});

	it("prompt with later-aborted signal triggers session.abort mid-flight", async () => {
		// Slow stub prompt so the abort fires while it's pending
		const session = makeStubSession({
			async prompt() {
				await new Promise((r) => setTimeout(r, 30));
			},
		});
		const client = makeEmbeddedChatClient({ session: session as never });
		const ctl = new AbortController();
		const p = client.prompt("hey", { signal: ctl.signal });
		setTimeout(() => ctl.abort(), 5);
		await p;
		assert.ok(
			session.__log.some((e) => e.method === "abort"),
			"signal abort should have triggered session.abort()",
		);
	});

	it("abort forwards to session.abort", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		await client.abort();
		assert.deepEqual(session.__log, [{ method: "abort" }]);
	});

	it("steer translates {text, images} to Pi's positional + adds type:image", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		await client.steer({
			text: "wait, also try this",
			images: [{ data: "base64...", mimeType: "image/png" }],
		});
		const entry = session.__log.find((e) => e.method === "steer");
		assert.ok(entry);
		assert.deepEqual(entry?.args, {
			text: "wait, also try this",
			images: [{ type: "image", data: "base64...", mimeType: "image/png" }],
		});
	});

	it("steer with no images forwards undefined", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		await client.steer({ text: "no images" });
		const entry = session.__log.find((e) => e.method === "steer");
		assert.deepEqual(entry?.args, { text: "no images", images: undefined });
	});

	it("steer surfaces async errors from the underlying session", async () => {
		const session = makeStubSession({
			async steer() {
				throw new Error("invalid image encoding");
			},
		});
		const client = makeEmbeddedChatClient({ session: session as never });
		await assert.rejects(
			() => client.steer({ text: "x" }),
			/invalid image encoding/,
		);
	});
});

describe("makeEmbeddedChatClient — config mutations", () => {
	it("setModel forwards to Pi", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		await client.setModel({ id: "anthropic/claude-opus-4-7" } as never);
		const entry = session.__log.find((e) => e.method === "setModel");
		assert.deepEqual(entry?.args, { id: "anthropic/claude-opus-4-7" });
	});

	it("setThinkingLevel forwards to Pi", () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		client.setThinkingLevel("high");
		assert.deepEqual(session.__log, [{ method: "setThinkingLevel", args: "high" }]);
	});
});

describe("makeEmbeddedChatClient — context + compaction", () => {
	it("getContextUsage forwards to Pi", () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		assert.deepEqual(client.getContextUsage(), { used: 0, total: 200000 });
	});

	it("compact forwards but discards Pi's CompactionResult (returns void)", async () => {
		const session = makeStubSession();
		const client = makeEmbeddedChatClient({ session: session as never });
		const result = await client.compact();
		assert.equal(result, undefined);
		const entry = session.__log.find((e) => e.method === "compact");
		assert.ok(entry, "compact should have been called");
	});
});
