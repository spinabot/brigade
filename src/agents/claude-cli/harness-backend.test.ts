import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeCliHarnessBackend as backend } from "./harness-backend.js";
import { NOOP_HARNESS_HANDLE, type HarnessTurn } from "../harness/types.js";
import { readClaudeCliToolPlane } from "./tool-plane.js";
import { setActiveMcpToolPlaneHost, type McpTurnContext } from "../mcp/tool-plane-host.js";

const TOKEN_URL = /^http:\/\/127\.0\.0\.1:7777\/mcp\/[0-9a-f]{64}$/;

function turn(over: Partial<HarnessTurn> = {}): HarnessTurn {
	return {
		agentId: "main",
		provider: "claude-cli",
		modelId: "claude-opus-4-8",
		cwd: process.cwd(),
		sessionKey: "agent:main:main",
		runId: "run-1",
		session: { messages: [], isStreaming: false, sessionManager: { appendMessage: () => {} } },
		senderIsOwner: true,
		customTools: [],
		builtinToolNames: ["read", "bash"],
		guard: async () => undefined,
		...over,
	};
}

/** A fake host that captures whatever the backend registers. */
function fakeHost() {
	const state: { registered?: McpTurnContext; disposed: number; tokens: number } = { disposed: 0, tokens: 0 };
	const registry = {
		register: (ctx: McpTurnContext) => {
			state.registered = ctx;
			state.tokens += 1;
			return { token: "a".repeat(64), dispose: () => (state.disposed += 1) };
		},
		lookup: () => undefined,
		size: () => state.tokens - state.disposed,
	};
	setActiveMcpToolPlaneHost({ baseUrl: "http://127.0.0.1:7777", registry: registry as never });
	return state;
}

function noHost() {
	setActiveMcpToolPlaneHost(null);
}

/* ───────────────────────────── identity / scope ───────────────────────────── */

test("owns() claims claude-cli and NOTHING else — loop backends never reach installTurn", () => {
	assert.equal(backend.owns({ provider: "claude-cli" }), true);
	assert.equal(backend.owns({ provider: "x", api: "claude-cli" }), true);
	for (const provider of ["anthropic", "openai", "google", "ollama", "openrouter"]) {
		assert.equal(backend.owns({ provider }), false, `${provider} must not be claimed`);
	}
});

test("installTurn on a foreign provider returns the shared NOOP handle", () => {
	const h = backend.installTurn(turn({ provider: "anthropic" }));
	assert.equal(h, NOOP_HARNESS_HANDLE, "identity — nothing installed, nothing to undo");
	assert.equal(h.hadToolActivity(), false);
});

test("declares its capabilities honestly", () => {
	assert.deepEqual(backend.capabilities, {
		servesOwnLoop: true,
		managesOwnContext: false,
		needsBuiltinsServed: true,
	});
	assert.deepEqual(backend.apis, ["claude-cli"]);
	assert.equal(backend.authSentinel?.provider, "claude-cli");
});

test("createStreamFn is memoized (one transport per process)", () => {
	assert.equal(backend.createStreamFn(), backend.createStreamFn());
});

/* ───────────────────────── owner turn: full tool-plane ───────────────────────── */

test("an OWNER turn registers the guarded surface and stamps the HTTP url", () => {
	const host = fakeHost();
	try {
		const h = backend.installTurn(turn({ builtinToolNames: ["read", "bash", "grep"] }));

		const names = (host.registered?.customTools ?? []).map((t) => t.name).sort();
		assert.deepEqual(names, ["bash", "grep", "read"], "builtins served — Pi's loop can't build them here");
		assert.equal(host.registered?.runId, "run-1", "runId threaded so the route can mint TUI events");
		assert.equal(typeof host.registered?.recordToolCall, "function", "transcript sink wired");

		const ctx: Record<string, unknown> = {};
		h.stampContext(ctx);
		const plane = readClaudeCliToolPlane(ctx);
		assert.equal(plane?.senderIsOwner, true);
		assert.match(plane?.mcpHttpUrl ?? "", TOKEN_URL);

		h.dispose();
		assert.equal(host.disposed, 1, "token cannot outlive the turn");
		h.dispose();
		assert.equal(host.disposed, 1, "dispose is idempotent");
	} finally {
		noHost();
	}
});

/* ─────────────────────── fail-open: no plane, still usable ─────────────────────── */

test("a PEER turn registers nothing but still stamps (memory-only stdio path)", () => {
	const host = fakeHost();
	try {
		const h = backend.installTurn(turn({ senderIsOwner: false }));
		assert.equal(host.registered, undefined, "a peer must never reach the guarded plane");

		const ctx: Record<string, unknown> = {};
		h.stampContext(ctx);
		const plane = readClaudeCliToolPlane(ctx);
		assert.equal(plane?.senderIsOwner, false, "the isolation signal survives");
		assert.equal(plane?.mcpHttpUrl, undefined, "no full plane");
	} finally {
		noHost();
	}
});

test("no gateway host (cold `brigade agent`) → no registration, still stamps, no crash", () => {
	noHost();
	const h = backend.installTurn(turn());
	const ctx: Record<string, unknown> = {};
	h.stampContext(ctx);
	assert.equal(readClaudeCliToolPlane(ctx)?.mcpHttpUrl, undefined);
	assert.doesNotThrow(() => h.afterTurn());
	assert.doesNotThrow(() => h.dispose());
	assert.equal(h.hadToolActivity(), false);
});

test("no guard composed → no registration (fail-open)", () => {
	const host = fakeHost();
	try {
		const h = backend.installTurn(turn({ guard: undefined }));
		assert.equal(host.registered, undefined);
		assert.doesNotThrow(() => h.dispose());
	} finally {
		noHost();
	}
});

/* ─────────────────── transcript reconcile + the double-run guard ─────────────────── */

function runOneTool(host: ReturnType<typeof fakeHost>, name = "bash"): void {
	host.registered?.recordToolCall?.({
		toolCallId: `mcp-${name}`,
		toolName: name,
		args: { command: "echo hi" },
		content: [{ type: "text", text: "hi" }],
		isError: false,
	});
}

test("afterTurn merges the recorded pair into the session, behind the final reply", () => {
	const host = fakeHost();
	try {
		const finalText = { role: "assistant", content: [{ type: "text", text: "done" }] };
		const appended: unknown[] = [];
		const messages: unknown[] = [{ role: "user", content: "go" }];
		const session = {
			messages,
			isStreaming: false,
			sessionManager: { appendMessage: (m: unknown) => appended.push(m) },
		};

		const h = backend.installTurn(turn({ session }));
		runOneTool(host); // the binary called a tool mid-stream
		assert.equal(appended.length, 2, "written to the JSONL as it happened");

		messages.push(finalText); // Pi persists the final assistant on message_end
		h.afterTurn();

		assert.deepEqual(
			messages.map((m: any) => m.role),
			["user", "assistant", "toolResult", "assistant"],
			"pair inserted where it ran — before the model's reply",
		);
		assert.equal(messages.at(-1), finalText);
	} finally {
		noHost();
	}
});

test("afterTurn DRAINS: a second call cannot duplicate the pair", () => {
	const host = fakeHost();
	try {
		const messages: unknown[] = [{ role: "user", content: "go" }];
		const session = { messages, isStreaming: false, sessionManager: { appendMessage: () => {} } };
		const h = backend.installTurn(turn({ session }));
		runOneTool(host);

		h.afterTurn();
		const afterFirst = messages.length;
		h.afterTurn(); // the max_tokens continuation flushes before re-prompting
		assert.equal(messages.length, afterFirst, "idempotent — no duplicate tool history");
	} finally {
		noHost();
	}
});

test("hadToolActivity survives the drain — the content-quality gate must not re-prompt", () => {
	// THE BUG THIS GUARDS: a harness assistant message never carries toolCall blocks,
	// so the recovery heuristics read "never acted". Re-prompting respawns the binary
	// and re-runs the deploy. The gate consults this instead.
	const host = fakeHost();
	try {
		const session = { messages: [], isStreaming: false, sessionManager: { appendMessage: () => {} } };
		const h = backend.installTurn(turn({ session }));
		assert.equal(h.hadToolActivity(), false, "nothing ran yet");

		runOneTool(host);
		assert.equal(h.hadToolActivity(), true);

		h.afterTurn(); // records drained…
		assert.equal(h.hadToolActivity(), true, "…but the turn still ACTED");
	} finally {
		noHost();
	}
});
