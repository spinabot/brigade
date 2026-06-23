/**
 * `message_action` tool tests.
 *
 * Covers:
 *   - owner-gating: a non-owner turn is refused wholesale (no adapter call);
 *   - edit / delete / react dispatch reaches the adapter's handleAction with the
 *     right typed action + conversation id;
 *   - capability-flag PRE-CHECK: a channel with `edit:false` returns unsupported
 *     cleanly WITHOUT calling the adapter;
 *   - edit text is run through the reply sanitizer (no <think> leak);
 *   - a channel with no handleAction reports the action unsupported.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { ChannelAdapter } from "../extensions/types.js";
import type { ChannelCapabilities } from "../channels/types.core.js";
import type {
	ChannelManager,
	StartChannelResult,
	StopChannelResult,
} from "../channels/manager.js";

const { makeMessageActionTool } = await import("./message-action-tool.js");
const { setActiveChannelManager } = await import("../channels/active-manager.js");
const { recordLastSentMessage, resetLastSentMessageRegistryForTests } = await import(
	"../channels/last-sent-message.js"
);

afterEach(() => {
	setActiveChannelManager(null);
	resetLastSentMessageRegistryForTests();
});

interface HandleCall {
	conversationId: string;
	action: { kind: string; messageId?: string; text?: string; emoji?: string };
	accountId?: string;
}

/** Mount a fake manager whose single adapter records handleAction calls. */
function mountAdapter(opts: {
	capabilities?: ChannelCapabilities;
	withHandleAction?: boolean;
	result?: { ok: boolean; messageId?: string; error?: string };
}): { calls: HandleCall[] } {
	const calls: HandleCall[] = [];
	const adapter: ChannelAdapter = {
		id: "telegram",
		label: "Telegram",
		isConfigured: () => true,
		async start() {},
		async stop() {},
		async sendText() {},
		health: () => ({ ok: true }),
		...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
		...(opts.withHandleAction === false
			? {}
			: {
					handleAction: async (params) => {
						calls.push({
							conversationId: params.conversationId,
							action: params.action as HandleCall["action"],
							...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
						});
						return opts.result ?? { ok: true, messageId: "m-1" };
					},
				}),
	} as ChannelAdapter;

	const manager: ChannelManager = {
		get started() {
			return ["telegram"];
		},
		adapter(id: string) {
			return id === "telegram" ? adapter : undefined;
		},
		async startChannel(): Promise<StartChannelResult> {
			return { ok: true, started: true };
		},
		async stopChannel(): Promise<StopChannelResult> {
			return { ok: true, stopped: true };
		},
		async stop() {},
	};
	setActiveChannelManager(manager);
	return { calls };
}

const ALL_CAPS: ChannelCapabilities = {
	chatTypes: ["direct", "group"],
	reactions: true,
	edit: true,
	unsend: true,
	reply: true,
	threads: true,
};

function parse(result: { details: unknown }): Record<string, unknown> {
	return result.details as Record<string, unknown>;
}

describe("message_action — owner gating", () => {
	it("a non-owner turn is refused wholesale (adapter never called)", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: false });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "delete", messageId: "m-9" },
		} as never);
		const d = parse(res);
		assert.equal(d.ok, false);
		assert.match(String(d.error), /owner-only/i);
		assert.equal(calls.length, 0, "refused call must not reach the adapter");
	});
});

describe("message_action — dispatch", () => {
	it("edit dispatches a typed edit action with the conversation id", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "edit", messageId: "m-2", text: "fixed text" },
		} as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.conversationId, "chat-1");
		assert.deepEqual(calls[0]?.action, { kind: "edit", messageId: "m-2", text: "fixed text" });
	});

	it("delete dispatches a typed delete action", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "delete", messageId: "m-3" },
		} as never);
		assert.deepEqual(calls[0]?.action, { kind: "delete", messageId: "m-3" });
	});

	it("react dispatches a typed react action with the emoji", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "react", messageId: "m-4", emoji: "👍" },
		} as never);
		assert.deepEqual(calls[0]?.action, { kind: "react", messageId: "m-4", emoji: "👍" });
	});

	it("react with an empty emoji (clear reaction) still dispatches", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "react", messageId: "m-5", emoji: "" },
		} as never);
		assert.equal(parse(res).ok, true);
		assert.deepEqual(calls[0]?.action, { kind: "react", messageId: "m-5", emoji: "" });
	});

	it("surfaces the adapter's returned messageId + ok flag", async () => {
		mountAdapter({ capabilities: ALL_CAPS, result: { ok: true, messageId: "edited-77" } });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "edit", messageId: "m-6", text: "hi" },
		} as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(d.messageId, "edited-77");
	});

	it("topic-create dispatches a typed topic-create action (no messageId required)", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS, result: { ok: true, messageId: "thread-101" } });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "-100999",
			action: { kind: "topic-create", name: "Roadmap" },
		} as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(d.messageId, "thread-101");
		assert.deepEqual(calls[0]?.action, { kind: "topic-create", name: "Roadmap" });
	});

	it("buttons dispatches a typed buttons action with the grid (no messageId required)", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS, result: { ok: true, messageId: "msg-55" } });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: {
				kind: "buttons",
				text: "Pick one",
				buttons: [[{ text: "Yes", data: "yes" }, { text: "No", data: "no" }]],
			},
		} as never);
		const d = parse(res);
		assert.equal(d.ok, true);
		assert.equal(d.messageId, "msg-55");
		assert.equal(calls.length, 1);
		const action = calls[0]?.action as { kind: string; text: string; buttons: unknown };
		assert.equal(action.kind, "buttons");
		assert.equal(action.text, "Pick one");
		assert.deepEqual(action.buttons, [[{ text: "Yes", data: "yes" }, { text: "No", data: "no" }]]);
	});

	it("buttons is refused before the adapter when the grid is empty", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "buttons", text: "hi", buttons: [] },
		} as never);
		assert.equal(parse(res).ok, false);
		assert.equal(calls.length, 0);
	});

	it("buttons is refused when the message body is missing", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "buttons", buttons: [[{ text: "Yes", data: "yes" }]] },
		} as never);
		assert.equal(parse(res).ok, false);
		assert.equal(calls.length, 0);
	});

	it("topic-create without a name is refused before the adapter", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "-100999",
			action: { kind: "topic-create" },
		} as never);
		assert.equal(parse(res).ok, false);
		assert.equal(calls.length, 0);
	});

	it("topic-create is refused when the channel lacks threads capability", async () => {
		const { calls } = mountAdapter({
			capabilities: { chatTypes: ["group"], threads: false },
		});
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "-100999",
			action: { kind: "topic-create", name: "X" },
		} as never);
		assert.equal(parse(res).ok, false);
		assert.match(String(parse(res).error), /threads|does not support/i);
		assert.equal(calls.length, 0);
	});

	it("runs edit text through the reply sanitizer (strips <think>)", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "edit", messageId: "m-7", text: "<think>secret reasoning</think>visible answer" },
		} as never);
		const sentText = String((calls[0]?.action as { text?: string }).text ?? "");
		assert.ok(!/secret reasoning/.test(sentText), "reasoning must be scrubbed from edit text");
		assert.match(sentText, /visible answer/);
	});
});

describe("message_action — capability pre-check", () => {
	it("a channel with edit:false returns unsupported WITHOUT calling the adapter", async () => {
		const { calls } = mountAdapter({
			capabilities: { chatTypes: ["direct"], edit: false, reactions: true, unsend: true },
		});
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "edit", messageId: "m-8", text: "nope" },
		} as never);
		const d = parse(res);
		assert.equal(d.ok, false);
		assert.match(String(d.error), /does not support|capabilities\.edit/i);
		assert.equal(calls.length, 0, "pre-check must short-circuit before the adapter");
	});

	it("react is refused when reactions:false (pre-check)", async () => {
		const { calls } = mountAdapter({
			capabilities: { chatTypes: ["direct"], edit: true, reactions: false, unsend: true },
		});
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "react", messageId: "m-9", emoji: "👍" },
		} as never);
		assert.equal(parse(res).ok, false);
		assert.equal(calls.length, 0);
	});

	it("falls back to the agent's last-sent message id when messageId is omitted", async () => {
		const { calls } = mountAdapter({ capabilities: ALL_CAPS });
		recordLastSentMessage({
			agentId: "main",
			channelId: "telegram",
			conversationId: "chat-1",
			messageId: "last-42",
		});
		const tool = makeMessageActionTool({ senderIsOwner: true, agentId: "main" });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "delete" }, // no messageId
		} as never);
		assert.equal(parse(res).ok, true);
		assert.deepEqual(calls[0]?.action, { kind: "delete", messageId: "last-42" });
	});

	it("refuses when messageId is omitted and there is no last-sent message", async () => {
		mountAdapter({ capabilities: ALL_CAPS });
		const tool = makeMessageActionTool({ senderIsOwner: true, agentId: "main" });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "delete" },
		} as never);
		assert.equal(parse(res).ok, false);
		assert.match(String(parse(res).error), /messageId/i);
	});

	it("a channel with no handleAction reports the action unsupported", async () => {
		mountAdapter({ capabilities: ALL_CAPS, withHandleAction: false });
		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-1",
			action: { kind: "delete", messageId: "m-10" },
		} as never);
		const d = parse(res);
		assert.equal(d.ok, false);
		assert.match(String(d.error), /does not support message actions/i);
	});
});

/**
 * FIX 3 — message actions flow through the runtime `ChannelAdapter.handleAction`
 * ({ conversationId, … }) and NOT through the (now-deprecated, dead)
 * `ChannelPlugin.actions` typed adapter ({ cfg, runtime, target, … }). These
 * tests pin the canonical dispatch contract so a future refactor can't silently
 * resurrect the dual-`handleAction` author trap.
 */
describe("message_action — canonical runtime handleAction path (FIX 3)", () => {
	it("dispatches via the `{ conversationId }` runtime shape, not the `{ target }` plugin shape", async () => {
		// Capture the RAW params object the tool hands the adapter to prove the
		// shape: it must carry `conversationId` (runtime ChannelAdapter contract)
		// and must NOT carry a `target` (the dead ChannelMessageActionAdapter shape).
		let rawParams: Record<string, unknown> | undefined;
		const adapter: ChannelAdapter = {
			id: "telegram",
			label: "Telegram",
			isConfigured: () => true,
			async start() {},
			async stop() {},
			async sendText() {},
			health: () => ({ ok: true }),
			capabilities: ALL_CAPS,
			handleAction: async (params) => {
				rawParams = params as unknown as Record<string, unknown>;
				return { ok: true, messageId: "ok-1" };
			},
		} as ChannelAdapter;
		const manager: ChannelManager = {
			get started() {
				return ["telegram"];
			},
			adapter(id: string) {
				return id === "telegram" ? adapter : undefined;
			},
			async startChannel(): Promise<StartChannelResult> {
				return { ok: true, started: true };
			},
			async stopChannel(): Promise<StopChannelResult> {
				return { ok: true, stopped: true };
			},
			async stop() {},
		};
		setActiveChannelManager(manager);

		const tool = makeMessageActionTool({ senderIsOwner: true });
		const res = await tool.execute("c1", {
			channel: "telegram",
			to: "chat-77",
			action: { kind: "delete", messageId: "m-77" },
		} as never);

		assert.equal(parse(res).ok, true);
		assert.ok(rawParams, "adapter.handleAction must have been called");
		assert.equal(rawParams?.conversationId, "chat-77", "canonical shape uses conversationId");
		assert.equal("target" in (rawParams ?? {}), false, "must NOT use the dead { target } plugin shape");
	});
});
