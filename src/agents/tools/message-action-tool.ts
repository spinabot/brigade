/**
 * `message_action` — agent-callable edit / delete / react on a channel message.
 *
 * Companion to `send_message` (which creates messages) and `connect_channel`
 * (which wires up channels). Where `send_message` sends NEW text, this tool acts
 * on an EXISTING message the agent already sent or received: edit its text,
 * delete it, react to it with an emoji, or pin/unpin it. It is the one central
 * surface for every channel's message-action capability — a channel opts in by
 * implementing `ChannelAdapter.handleAction` + advertising the matching
 * `capabilities` flag; this tool dispatches through the active channel manager
 * and PRE-CHECKS that flag so an unsupported action fails cleanly without ever
 * touching the adapter.
 *
 * Ownership: BLANKET owner-only. Editing or deleting an arbitrary message is a
 * privileged act — a channel-routed peer must NEVER reach into the operator's
 * conversations and mutate or remove messages. Unlike `send_message` (which a
 * peer may use to reply to their OWN chat), there is no safe peer subset here,
 * so the whole tool is refused for non-owner turns via a per-call gate (kept as
 * a per-call gate, not a registration-time `ownerOnly`, so the refusal carries
 * a clear actionable message instead of the tool silently vanishing).
 *
 * Text safety: `edit` text is run through the central `sanitizeReplyForChannel`
 * (the same reasoning-leak scrubber every outbound reply uses) before it reaches
 * the adapter, so an edited message can't leak `<think>` content either.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { getActiveChannelManager } from "../channels/active-manager.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import { getLastSentMessage } from "../channels/last-sent-message.js";
import { sanitizeReplyForChannel } from "../channels/reply-sanitizer.js";
import type {
	ChannelMessageAction,
	ChannelMessageActionResult,
} from "../channels/types.adapters.js";
import type { ChannelCapabilities } from "../channels/types.core.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { jsonResult, readStringParam } from "./common.js";
import type { BrigadeTool } from "./types.js";

const log = createSubsystemLogger("brigade/message-action");

const ActionKind = Type.Union(
	[
		Type.Literal("edit"),
		Type.Literal("delete"),
		Type.Literal("react"),
		Type.Literal("pin"),
		Type.Literal("unpin"),
	],
	{
		description:
			"What to do to the target message: edit its text, delete it, react with an emoji, or pin/unpin it.",
	},
);

const MessageActionParams = Type.Object({
	channel: Type.String({
		description:
			"Channel id the message lives on (e.g. `telegram`, `whatsapp`). Must match a STARTED adapter.",
		minLength: 1,
		maxLength: 64,
	}),
	to: Type.String({
		description:
			"Conversation id the message is in (chat id / phone number / channel id) — the same `to` you would pass to `send_message`.",
		minLength: 1,
	}),
	action: Type.Object({
		kind: ActionKind,
		messageId: Type.Optional(
			Type.String({
				description:
					"Native id of the target message (required for edit / delete / react / pin / unpin). For your own sent messages this is the id `send_message` returned.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "New message body — required for `edit`. Ignored for other kinds.",
			}),
		),
		emoji: Type.Optional(
			Type.String({
				description: "Emoji to react with — required for `react`. Pass an empty string to clear a reaction.",
			}),
		),
	}),
	accountId: Type.Optional(
		Type.String({
			description:
				"Multi-account channels: which account the message belongs to. Leave unset for the default account.",
		}),
	),
});

interface MessageActionDetails {
	channel: string;
	to: string;
	kind: string;
	ok: boolean;
	messageId?: string;
	error?: string;
}

export interface MakeMessageActionToolOptions {
	/** Active channel context for this turn (unused for routing today; kept for parity + future auto-fill). */
	channelContext?: ChannelApprovalRoute;
	/**
	 * Whether the calling turn is the workspace owner. Defaults to `true` so
	 * legacy paths (TUI / tests) keep access. A non-owner turn is refused
	 * wholesale — there is no safe peer subset for message mutation.
	 */
	senderIsOwner?: boolean;
	/**
	 * The calling agent's id — used to resolve "my last message" when the
	 * action omits `messageId` (the pipeline records the agent's last sent id
	 * per conversation). When omitted, the last-sent fallback is unavailable
	 * and an action with no `messageId` is refused as before.
	 */
	agentId?: string;
}

/**
 * The boolean capability flags `message_action` can pre-check. Derived from
 * `ChannelCapabilities` (minus the non-boolean `chatTypes`) so adding a flag to
 * the contract surfaces here at compile time rather than silently skipping a
 * pre-check.
 */
type BooleanCapabilityFlag = Extract<keyof ChannelCapabilities, "edit" | "unsend" | "reactions" | "reply">;

/**
 * Map an action `kind` to the `ChannelCapabilities` flag that gates it. `pin`/
 * `unpin` have no dedicated capability flag in the contract today, so they are
 * gated on the generic presence of `handleAction` rather than a flag (returned
 * as `undefined` here → "no flag to pre-check, defer to the adapter").
 */
function capabilityFlagForKind(
	kind: ChannelMessageAction["kind"],
): BooleanCapabilityFlag | undefined {
	switch (kind) {
		case "edit":
			return "edit";
		case "delete":
			return "unsend";
		case "react":
			return "reactions";
		case "reply":
			return "reply";
		default:
			return undefined; // pin / unpin — no flag in the contract
	}
}

export function makeMessageActionTool(
	opts: MakeMessageActionToolOptions = {},
): BrigadeTool<typeof MessageActionParams, MessageActionDetails> {
	const senderIsOwner = opts.senderIsOwner !== false;
	return {
		name: "message_action",
		label: "message_action",
		displaySummary: "acting on a message",
		description:
			"Act on an EXISTING channel message — edit its text, delete it, react with an emoji, or pin/unpin it. " +
			"Use this to amend or remove something already sent (e.g. 'fix that typo in my last message', 'delete that', " +
			"'react with 👍'). For sending a NEW message use `send_message`. " +
			"OWNER-ONLY: a channel peer cannot edit or delete arbitrary messages. " +
			"The target channel must support the action (e.g. some channels can't edit) — unsupported actions are reported cleanly.",
		parameters: MessageActionParams,
		// Per-call gate (not registration-time ownerOnly) so the refusal message
		// is actionable; mutation of arbitrary messages is never peer-safe.
		async execute(_toolCallId, params): Promise<AgentToolResult<MessageActionDetails>> {
			const channel = (readStringParam(params, "channel") ?? "").trim().toLowerCase();
			const to = (readStringParam(params, "to") ?? "").trim();
			const accountId = readStringParam(params, "accountId");
			const rawAction = (params as { action?: Record<string, unknown> }).action ?? {};
			const kind = String(rawAction.kind ?? "") as ChannelMessageAction["kind"];
			let messageId = typeof rawAction.messageId === "string" ? rawAction.messageId.trim() : "";
			const emoji = typeof rawAction.emoji === "string" ? rawAction.emoji : "";
			const rawText = typeof rawAction.text === "string" ? rawAction.text : "";

			const fail = (error: string): AgentToolResult<MessageActionDetails> =>
				jsonResult({
					channel,
					to,
					kind,
					ok: false,
					error,
				} satisfies MessageActionDetails) as AgentToolResult<MessageActionDetails>;

			if (!senderIsOwner) {
				return fail(
					"message_action is owner-only — a channel peer cannot edit, delete, or react to arbitrary messages. Ask the operator to do this from the TUI.",
				);
			}

			const manager = getActiveChannelManager();
			if (!manager) {
				return fail(
					"the gateway has no channel manager mounted (no channels are configured). Configure a channel first, then restart the gateway.",
				);
			}
			if (!channel || !to) {
				return fail("`channel` and `to` are both required.");
			}
			const adapter = manager.adapter(channel, accountId ?? undefined);
			if (!adapter) {
				const started = manager.started.join(", ") || "(none)";
				return fail(`channel "${channel}" is not a started adapter — typo? available channels: ${started}.`);
			}
			if (typeof adapter.handleAction !== "function") {
				return fail(`channel "${channel}" does not support message actions.`);
			}

			// "My last message" fallback: when no explicit messageId was given,
			// resolve the agent's most-recently-sent message on THIS conversation
			// (recorded by the pipeline from the additive sendText id). Lets the
			// operator say "edit my last message" / "delete that" without an id.
			if (!messageId && kind !== "reply" && opts.agentId) {
				const last = getLastSentMessage(opts.agentId, channel, to);
				if (last) messageId = last.messageId;
			}

			// Per-kind required-arg validation.
			if (kind === "edit" && !rawText.trim()) return fail("edit requires `action.text`.");
			if (kind === "react" && rawAction.emoji === undefined) {
				return fail("react requires `action.emoji` (pass an empty string to clear a reaction).");
			}
			if (kind !== "reply" && !messageId) {
				return fail(
					`${kind} requires action.messageId (and no prior sent message was found on this chat to default to).`,
				);
			}

			// Capability PRE-CHECK: refuse cleanly when the channel advertises the
			// action as unsupported, BEFORE calling the adapter.
			const flag = capabilityFlagForKind(kind);
			if (flag) {
				const supported = adapter.capabilities?.[flag] === true;
				if (!supported) {
					return fail(
						`channel "${channel}" does not support the "${kind}" action (capabilities.${String(flag)} is not enabled).`,
					);
				}
			}

			// Build the typed action. Edit text runs through the central reply
			// sanitizer so an edited message can't leak <think> content.
			let action: ChannelMessageAction;
			switch (kind) {
				case "edit":
					action = { kind: "edit", messageId, text: sanitizeReplyForChannel(rawText) };
					break;
				case "delete":
					action = { kind: "delete", messageId };
					break;
				case "react":
					action = { kind: "react", messageId, emoji };
					break;
				case "pin":
					action = { kind: "pin", messageId };
					break;
				case "unpin":
					action = { kind: "unpin", messageId };
					break;
				default:
					return fail(`unknown action kind "${kind}".`);
			}

			let result: ChannelMessageActionResult;
			try {
				result = await adapter.handleAction({
					conversationId: to,
					action,
					...(accountId ? { accountId } : {}),
				});
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.warn("message_action dispatch threw", { channel, to, kind, error: errMsg });
				return fail(`dispatch failed via ${channel} adapter — ${errMsg}.`);
			}

			log.info("message_action dispatched", {
				channel,
				to,
				kind,
				ok: result.ok,
				messageId: result.messageId,
			});
			return jsonResult({
				channel,
				to,
				kind,
				ok: result.ok,
				...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
				...(result.error !== undefined ? { error: result.error } : {}),
			} satisfies MessageActionDetails) as AgentToolResult<MessageActionDetails>;
		},
	};
}
