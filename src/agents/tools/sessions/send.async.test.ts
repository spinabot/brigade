/**
 * sessions_send async contract tests (2026-06-12 rework).
 *
 * Pins the run-settle contract that replaced the first-text polling bug:
 *
 *   1. SETTLE-BEFORE-TEXT — an intermediate assistant text that lands while
 *      the peer run is still in flight is NEVER returned as the reply; the
 *      tool waits for the run to settle and returns the FINAL reply.
 *   2. ACCEPTED + LATE DELIVERY — a run outliving the wait window returns
 *      status "accepted" immediately; when the run settles, the final reply
 *      is enqueued into the REQUESTER's session inbox and a heartbeat wake
 *      is requested (the ping-back the operator demanded).
 *   3. DISPATCH FAILURE SURFACES — an {ok:false} settled outcome returns
 *      status "error" AND withdraws the just-enqueued A2A attribution event
 *      from the peer's inbox (no ghost event on its next unrelated turn).
 *
 * The gateway is stubbed via setGlobalGatewayCaller; the inbox and the
 * heartbeat-wake state are the real modules (reset per test).
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setGlobalGatewayCaller, resetGatewayCallerForTests } from "../../gateway-call.js";
import {
	peekSystemEventEntries,
	resetSessionInboxForTest,
} from "../../session-inbox.js";
import {
	hasPendingHeartbeatWake,
	resetHeartbeatWakeStateForTests,
} from "../../heartbeat-wake.js";
import { recordLastChannelForAgent } from "../../channels/last-channel.js";
import { createSessionsSendTool } from "./send.js";
import { createAgentToAgentPolicy } from "./shared.js";

const REQUESTER = "agent:accountant:main";
const PEER = "agent:eng-lead:main";

function permissiveTool() {
	return createSessionsSendTool({
		agentSessionKey: REQUESTER,
		visibility: "all",
		a2aPolicy: createAgentToAgentPolicy({ enabled: true, allow: ["*"] }),
	});
}

/** Deferred the tests resolve to simulate the peer run settling. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

interface StubState {
	/** Mutable list the sessions.history stub serves. */
	messages: Array<{ role: string; content: unknown }>;
	/** The pending agent-run settle the test controls. */
	settle: ReturnType<typeof deferred<Record<string, unknown>>>;
	agentCalls: Array<Record<string, unknown>>;
}

function installStubGateway(): StubState {
	const state: StubState = {
		messages: [],
		settle: deferred<Record<string, unknown>>(),
		agentCalls: [],
	};
	setGlobalGatewayCaller({
		call: async <T,>(req: { method: string; params?: unknown }): Promise<T> => {
			if (req.method === "sessions.history") {
				return { messages: state.messages.slice() } as T;
			}
			if (req.method === "agent") {
				state.agentCalls.push((req.params ?? {}) as Record<string, unknown>);
				// wait:true contract — the handler responds at run-settle.
				return (await state.settle.promise) as T;
			}
			throw new Error(`unexpected gateway method ${req.method}`);
		},
	});
	return state;
}

describe("sessions_send: run-settle contract", () => {
	beforeEach(() => {
		resetSessionInboxForTest();
		resetHeartbeatWakeStateForTests();
	});
	afterEach(() => {
		resetGatewayCallerForTests();
		resetSessionInboxForTest();
		resetHeartbeatWakeStateForTests();
	});

	it("never returns an intermediate text — waits for settle, returns the FINAL reply", async () => {
		const stub = installStubGateway();
		const tool = permissiveTool();

		const pending = tool.execute({
			sessionKey: PEER,
			message: "research leads",
			timeoutSeconds: 30,
		});

		// Intermediate progress text lands while the run is still in flight —
		// the OLD code returned this as the reply ("On it, let me hit the
		// directories…") and the requester relayed an empty promise.
		stub.messages.push({ role: "assistant", content: "On it. Let me hit the directories…" });
		await new Promise((r) => setTimeout(r, 700));

		// Now the run settles with the real deliverable.
		stub.messages.push({ role: "assistant", content: "RESULTS: 12 leads — …" });
		stub.settle.resolve({ ok: true, reply: "RESULTS: 12 leads — …" });

		const result = await pending;
		const parsed = JSON.parse(result.content) as { status: string; reply?: string };
		assert.equal(parsed.status, "ok");
		assert.equal(parsed.reply, "RESULTS: 12 leads — …", "final reply, not the intermediate text");
	});

	it("accepted + late delivery: reply lands in the requester inbox with a heartbeat wake", async () => {
		const stub = installStubGateway();
		const tool = permissiveTool();

		const pending = tool.execute({
			sessionKey: PEER,
			message: "long research",
			timeoutSeconds: 1, // wait window expires before the run settles
		});

		const result = await pending;
		const parsed = JSON.parse(result.content) as { status: string; note?: string };
		assert.equal(parsed.status, "accepted");
		assert.match(parsed.note ?? "", /DELIVERED into your session automatically/);

		// The peer keeps working… then finishes.
		stub.messages.push({ role: "assistant", content: "DONE: full lead list…" });
		stub.settle.resolve({ ok: true, reply: "DONE: full lead list…" });
		// Allow the .then() delivery chain to run.
		await new Promise((r) => setTimeout(r, 100));

		const inbox = peekSystemEventEntries(REQUESTER);
		assert.equal(inbox.length, 1, "exactly ONE delivery (no double-path)");
		assert.match(inbox[0]!.text, /^A2A reply from agent:eng-lead:main: DONE: full lead list…/);
		assert.match(inbox[0]!.text, /relay this result to the user NOW/);
		assert.equal(hasPendingHeartbeatWake(), true, "wake requested so the requester relays promptly");
	});

	it("P0-2: late delivery stamps the requester's channel as deliveryContext (so the relay can reach WhatsApp, not just the TUI)", async () => {
		// The requester (accountant) was last active on WhatsApp — record it.
		recordLastChannelForAgent("accountant", {
			channelId: "whatsapp",
			conversationId: "123@s.whatsapp.net",
			accountId: "acct1",
		});
		const stub = installStubGateway();
		const tool = permissiveTool();

		const pending = tool.execute({ sessionKey: PEER, message: "long research", timeoutSeconds: 1 });
		await pending; // status "accepted"

		stub.messages.push({ role: "assistant", content: "DONE: lead list" });
		stub.settle.resolve({ ok: true, reply: "DONE: lead list" });
		await new Promise((r) => setTimeout(r, 100));

		const inbox = peekSystemEventEntries(REQUESTER);
		assert.equal(inbox.length, 1);
		// The heartbeat dispatcher reads this and delivers the woken reply to the channel.
		assert.deepEqual(inbox[0]!.deliveryContext, {
			channel: "whatsapp",
			accountId: "acct1",
			to: "123@s.whatsapp.net",
		});
	});

	it("failed dispatch surfaces as status error AND withdraws the ghost A2A event from the peer inbox", async () => {
		const stub = installStubGateway();
		const tool = permissiveTool();

		const pending = tool.execute({
			sessionKey: PEER,
			message: "do something",
			timeoutSeconds: 30,
		});

		// Mid-flight, the attribution event sits in the peer's inbox (correct:
		// the dispatched turn drains it at turn-start).
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(peekSystemEventEntries(PEER).length, 1, "attribution event enqueued pre-dispatch");

		stub.settle.resolve({ ok: false, error: "agent forbidden" });
		const result = await pending;
		const parsed = JSON.parse(result.content) as { status: string; error?: string };
		assert.equal(parsed.status, "error");
		assert.match(parsed.error ?? "", /agent forbidden/);
		assert.equal(
			peekSystemEventEntries(PEER).length,
			0,
			"ghost event withdrawn — the peer's next unrelated turn won't act on it",
		);
	});

	it("late settle with ok:false delivers an HONEST failure event, not a fake reply", async () => {
		const stub = installStubGateway();
		const tool = permissiveTool();

		const pending = tool.execute({
			sessionKey: PEER,
			message: "long research",
			timeoutSeconds: 1,
		});
		const result = await pending;
		assert.equal(
			(JSON.parse(result.content) as { status: string }).status,
			"accepted",
		);

		stub.settle.resolve({ ok: false, error: "model exploded" });
		await new Promise((r) => setTimeout(r, 100));

		const inbox = peekSystemEventEntries(REQUESTER);
		assert.equal(inbox.length, 1);
		assert.match(inbox[0]!.text, /turn FAILED \(model exploded\)/);
		assert.match(inbox[0]!.text, /did not complete/);
	});
});
