/**
 * Tests for the central channel approval-router's inline-button (callback) path
 * and the native-prompt dispatch, plus a regression that the text-reply path is
 * unchanged.
 *
 * Covers:
 *   - a button press (codec callback payload) resolves the SAME approval bridge;
 *   - a non-authorized callback is REFUSED and leaves the pending entry intact
 *     (so the real operator can still answer);
 *   - a foreign / stale callback payload is ignored (matched:false);
 *   - `dispatchChannelApproval` renders via the adapter's native
 *     `sendApprovalPrompt` when the dispatcher carries an approvalCapability,
 *     and falls back to text otherwise;
 *   - the existing text-reply approval still resolves the bridge unchanged.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { ApprovalDecision, ApprovalRequest } from "../approval-bridge.js";
import { encodeApprovalCallback } from "./approval-callback-codec.js";
import {
	type ChannelApprovalRoute,
	dispatchChannelApproval,
	registerChannelApprovalDispatcher,
	resetChannelApprovalRouterForTests,
	tryConsumeChannelApprovalCallback,
	tryConsumeChannelApprovalReply,
} from "./approval-router.js";

afterEach(() => {
	resetChannelApprovalRouterForTests();
});

/** Build a minimal pending approval request. */
function makeRequest(id: string, command = "rm -rf /tmp/x"): ApprovalRequest {
	return {
		id,
		command,
		toolName: "bash",
		timeoutMs: 60_000,
		decisions: ["allow-once", "allow-always", "deny"],
	};
}

const ROUTE: ChannelApprovalRoute = {
	channelId: "fake",
	conversationId: "conv-1",
	agentId: "main",
};

/** Register a text-only dispatcher; capture sends. */
function mountTextDispatcher(): { sends: Array<{ text: string }> } {
	const sends: Array<{ text: string }> = [];
	registerChannelApprovalDispatcher("fake", undefined, {
		sendText: async (_conversationId, text) => {
			sends.push({ text });
		},
		prettyName: "Fake",
	});
	return { sends };
}

describe("approval-router — inline-button callback path", () => {
	it("a button press resolves the SAME bridge with the decoded decision", async () => {
		mountTextDispatcher();
		const req = makeRequest("exec:approval-1");
		let resolved: ApprovalDecision | undefined;
		const dispatched = await dispatchChannelApproval({
			request: req,
			route: ROUTE,
			resolveOnBridge: (d) => {
				resolved = d;
			},
		});
		assert.equal(dispatched, true, "prompt dispatched");

		const data = encodeApprovalCallback({ approvalId: req.id, decision: "allow-always" });
		assert.ok(data, "codec produced a payload");
		const out = tryConsumeChannelApprovalCallback({
			channelId: "fake",
			conversationId: "conv-1",
			callbackData: data,
		});
		assert.deepEqual(out, { matched: true, decision: "allow-always", approvalId: req.id });
		assert.deepEqual(resolved, { kind: "allow-always" }, "bridge settled with allow-always");
	});

	it("each decision code resolves to the right bridge kind", async () => {
		const cases = [
			{ decision: "allow-once" as const, kind: "allow-once" },
			{ decision: "allow-always" as const, kind: "allow-always" },
			{ decision: "deny" as const, kind: "deny" },
		];
		for (const c of cases) {
			resetChannelApprovalRouterForTests();
			mountTextDispatcher();
			const req = makeRequest(`exec:${c.decision}`);
			let resolved: ApprovalDecision | undefined;
			await dispatchChannelApproval({ request: req, route: ROUTE, resolveOnBridge: (d) => (resolved = d) });
			const data = encodeApprovalCallback({ approvalId: req.id, decision: c.decision })!;
			const out = tryConsumeChannelApprovalCallback({
				channelId: "fake",
				conversationId: "conv-1",
				callbackData: data,
			});
			assert.equal(out.matched, true);
			assert.deepEqual(resolved, { kind: c.kind }, `${c.decision} -> ${c.kind}`);
		}
	});

	it("a non-authorized callback is REFUSED and leaves the pending entry intact", async () => {
		mountTextDispatcher();
		const req = makeRequest("exec:approval-2");
		let resolveCount = 0;
		await dispatchChannelApproval({
			request: req,
			route: ROUTE,
			resolveOnBridge: () => {
				resolveCount += 1;
			},
		});
		const data = encodeApprovalCallback({ approvalId: req.id, decision: "allow-once" })!;

		// A stranger's press — authorizeApprover refuses.
		const refused = tryConsumeChannelApprovalCallback({
			channelId: "fake",
			conversationId: "conv-1",
			callbackData: data,
			senderId: "stranger",
			authorizeApprover: () => ({ authorized: false, reason: "Only the operator can approve." }),
		});
		assert.equal(refused.matched, false);
		assert.equal((refused as { refused?: boolean }).refused, true);
		assert.match(String((refused as { reason?: string }).reason), /operator/i);
		assert.equal(resolveCount, 0, "bridge must NOT be settled by a refused press");

		// The real operator can still answer — the entry survived the refusal.
		const ok = tryConsumeChannelApprovalCallback({
			channelId: "fake",
			conversationId: "conv-1",
			callbackData: data,
			senderId: "operator",
			authorizeApprover: () => ({ authorized: true }),
		});
		assert.equal(ok.matched, true, "operator press settles after a refused stranger press");
		assert.equal(resolveCount, 1, "bridge settled exactly once, by the operator");
	});

	it("a foreign / malformed callback payload is ignored (matched:false, not refused)", async () => {
		mountTextDispatcher();
		const req = makeRequest("exec:approval-3");
		await dispatchChannelApproval({ request: req, route: ROUTE, resolveOnBridge: () => {} });
		const out = tryConsumeChannelApprovalCallback({
			channelId: "fake",
			conversationId: "conv-1",
			callbackData: "garbage-not-a-codec-payload",
		});
		assert.deepEqual(out, { matched: false });
	});

	it("a callback whose decoded id does not match the pending approval is ignored", async () => {
		mountTextDispatcher();
		const req = makeRequest("exec:approval-4");
		await dispatchChannelApproval({ request: req, route: ROUTE, resolveOnBridge: () => {} });
		// Encode a DIFFERENT approval id — peer matches but id doesn't.
		const data = encodeApprovalCallback({ approvalId: "exec:some-other-id", decision: "deny" })!;
		const out = tryConsumeChannelApprovalCallback({
			channelId: "fake",
			conversationId: "conv-1",
			callbackData: data,
		});
		assert.deepEqual(out, { matched: false });
	});
});

describe("approval-router — native prompt dispatch", () => {
	it("renders via the adapter's sendApprovalPrompt when the dispatcher carries an approvalCapability", async () => {
		const promptCalls: Array<{ approvalId: string; command: string; approvalKind: string }> = [];
		const textSends: string[] = [];
		registerChannelApprovalDispatcher("fake", undefined, {
			sendText: async (_c, text) => {
				textSends.push(text);
			},
			prettyName: "Fake",
			approvalCapability: {
				sendApprovalPrompt: async (params) => {
					promptCalls.push({
						approvalId: params.approvalId,
						command: params.command,
						approvalKind: params.approvalKind,
					});
				},
			},
			getApprovalContext: () => ({ runtime: {}, cfg: {} as never }),
		});
		const req = makeRequest("exec:native-1", "ls -la");
		const dispatched = await dispatchChannelApproval({ request: req, route: ROUTE, resolveOnBridge: () => {} });
		assert.equal(dispatched, true);
		assert.equal(promptCalls.length, 1, "native sendApprovalPrompt was called");
		assert.equal(promptCalls[0]?.approvalId, "exec:native-1");
		assert.equal(promptCalls[0]?.command, "ls -la");
		assert.equal(promptCalls[0]?.approvalKind, "exec");
		assert.equal(textSends.length, 0, "text prompt NOT used when native render is available");
	});

	it("infers approvalKind=plugin for a plugin:-prefixed approval id", async () => {
		const kinds: string[] = [];
		registerChannelApprovalDispatcher("fake", undefined, {
			sendText: async () => {},
			prettyName: "Fake",
			approvalCapability: { sendApprovalPrompt: async (p) => void kinds.push(p.approvalKind) },
		});
		await dispatchChannelApproval({
			request: makeRequest("plugin:abc"),
			route: ROUTE,
			resolveOnBridge: () => {},
		});
		assert.deepEqual(kinds, ["plugin"]);
	});

	it("falls back to the text prompt when no approvalCapability is registered", async () => {
		const { sends } = mountTextDispatcher();
		await dispatchChannelApproval({ request: makeRequest("exec:text-1"), route: ROUTE, resolveOnBridge: () => {} });
		assert.equal(sends.length, 1, "text prompt used");
		assert.match(sends[0]!.text, /Reply/i);
	});
});

describe("approval-router — text-reply path is unchanged", () => {
	it("a 'yes' text reply still resolves the bridge with allow-once", async () => {
		mountTextDispatcher();
		const req = makeRequest("exec:text-reply-1");
		let resolved: ApprovalDecision | undefined;
		await dispatchChannelApproval({ request: req, route: ROUTE, resolveOnBridge: (d) => (resolved = d) });
		const out = tryConsumeChannelApprovalReply({
			channelId: "fake",
			conversationId: "conv-1",
			text: "yes",
		});
		assert.deepEqual(out, { matched: true, decision: "allow-once", approvalId: req.id });
		assert.deepEqual(resolved, { kind: "allow-once" });
	});

	it("a non-approval text reply is left for normal dispatch (matched:false)", async () => {
		mountTextDispatcher();
		await dispatchChannelApproval({ request: makeRequest("exec:text-reply-2"), route: ROUTE, resolveOnBridge: () => {} });
		const out = tryConsumeChannelApprovalReply({
			channelId: "fake",
			conversationId: "conv-1",
			text: "what's the weather",
		});
		assert.deepEqual(out, { matched: false });
	});
});
