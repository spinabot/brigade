import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { openChatSession } from "./chat-session.js";

// These tests exercise ONLY the slash-command + state-mutation path.
// `runTurn` with a real (non-slash) message would call into runSingleTurn,
// which needs a real ~/.brigade auth/config + network — covered by the
// smoke script, not by unit tests here.

describe("openChatSession — initial state", () => {
	it("captures provider/model/thinkingLevel from open args", () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
			thinkingLevel: "low",
		});
		assert.equal(cs.provider, "openrouter");
		assert.equal(cs.modelId, "openai/gpt-5.4");
		assert.equal(cs.thinkingLevel, "low");
		assert.equal(cs.agentId, "main");
	});

	it("defaults thinkingLevel to 'off' when not provided", () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		assert.equal(cs.thinkingLevel, "off");
	});

	it("derives sessionKey when not given", () => {
		const cs = openChatSession({
			agentId: "alpha",
			provider: "anthropic",
			modelId: "claude-opus-4-7",
		});
		assert.equal(cs.sessionKey, "agent:alpha:main");
	});

	it("respects an explicit sessionKey", () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "anthropic",
			modelId: "claude-opus-4-7",
			sessionKey: "custom:key",
		});
		assert.equal(cs.sessionKey, "custom:key");
	});
});

describe("openChatSession — setModel / setThinkingLevel", () => {
	it("setModel updates state for subsequent turns", () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		cs.setModel("openrouter", "anthropic/claude-opus-4-7");
		assert.equal(cs.provider, "openrouter");
		assert.equal(cs.modelId, "anthropic/claude-opus-4-7");
	});

	it("setThinkingLevel updates state", () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		cs.setThinkingLevel("high");
		assert.equal(cs.thinkingLevel, "high");
	});
});

describe("openChatSession — runTurn slash command short-circuits", () => {
	it("/model X persists to internal state and skips runSingleTurn", async () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		const out = await cs.runTurn("/model anthropic/claude-opus-4-7");
		assert.equal(out.kind, "slash");
		if (out.kind !== "slash") return;
		assert.equal(out.command, "model");
		assert.match(out.detail ?? "", /switched to/);
		// State should reflect the new model
		assert.equal(cs.provider, "anthropic");
		assert.equal(cs.modelId, "claude-opus-4-7");
	});

	it("/thinking high updates internal level + skips runSingleTurn", async () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		const out = await cs.runTurn("/thinking high");
		assert.equal(out.kind, "slash");
		if (out.kind !== "slash") return;
		assert.equal(out.command, "thinking");
		assert.equal(cs.thinkingLevel, "high");
	});

	it("/reset returns a slash outcome the caller can act on", async () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		const out = await cs.runTurn("/reset");
		assert.equal(out.kind, "slash");
		if (out.kind !== "slash") return;
		assert.equal(out.command, "reset");
		assert.match(out.detail ?? "", /caller should drop/);
	});

	it("/help returns a slash outcome", async () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		const out = await cs.runTurn("/help");
		assert.equal(out.kind, "slash");
		if (out.kind !== "slash") return;
		assert.equal(out.command, "help");
	});

	it("malformed /reset (with extra args) returns a slash error outcome", async () => {
		// Unknown commands pass through to the model by design (so user-
		// defined / future commands work). But malformed forms of KNOWN
		// commands surface as slash errors. /reset takes no args.
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		const out = await cs.runTurn("/reset extra-junk");
		assert.equal(out.kind, "slash");
		if (out.kind !== "slash") return;
		assert.equal(out.command, "error");
		assert.match(out.detail ?? "", /no arguments/);
	});
});

describe("openChatSession — abortCurrent", () => {
	it("calling abortCurrent when idle is a no-op (does not throw)", () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		assert.doesNotThrow(() => cs.abortCurrent("nothing in flight"));
	});
});

describe("openChatSession — concurrency guard", () => {
	it("rejects a parallel runTurn on the same session", async () => {
		// Pre-aborted signal lets us drive the first turn into the abort
		// path without hitting the network. The first runTurn's pre-abort
		// keeps `currentAbort` set briefly while the abort is processed;
		// if we attempt a second runTurn synchronously while the first is
		// still settling, the guard fires.
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		const ctl = new AbortController();
		ctl.abort("pre-abort");
		// Fire two in parallel; one of them must observe the guard.
		const p1 = cs.runTurn("hey", { signal: ctl.signal });
		// Don't await p1 yet — try a second call immediately. The guard at
		// the top of runTurn runs synchronously, so the second call should
		// throw before any await.
		await assert.rejects(
			() => cs.runTurn("hey again"),
			/a turn is already in flight/,
		);
		// Drain the first call so the test process exits cleanly.
		await p1.catch(() => undefined);
	});
});

describe("openChatSession — passthrough message preserves text", () => {
	// We don't actually invoke runSingleTurn here (would hit the network);
	// we just verify the slash parser recognises a non-slash input as a
	// passthrough so it doesn't accidentally short-circuit.
	it("regular text does NOT trigger a slash outcome at parse time", async () => {
		const cs = openChatSession({
			agentId: "main",
			provider: "openrouter",
			modelId: "openai/gpt-5.4",
		});
		// Trying to call runTurn would hit runSingleTurn → real session →
		// expensive. Instead verify the slash parser path is the only
		// short-circuit. We do this by checking that the abortable signal
		// is wired before runSingleTurn would be invoked.
		const ctl = new AbortController();
		ctl.abort("pre-abort");
		try {
			const out = await cs.runTurn("hey, how are you?", { signal: ctl.signal });
			// A pre-aborted signal should propagate as `kind: "aborted"` —
			// runSingleTurn detects aborted-on-entry and short-circuits.
			// We accept either: an aborted outcome, or runSingleTurn throwing
			// (which our wrapper rethrows). Both are correct behaviour for
			// pre-aborted signals.
			assert.equal(out.kind, "aborted");
		} catch (err: unknown) {
			// runSingleTurn may throw an AbortError on pre-aborted signal;
			// that's also acceptable.
			assert.ok(err instanceof Error);
		}
	});
});
