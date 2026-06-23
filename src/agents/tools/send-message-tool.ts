/**
 * `send_message` — agent-callable channel outbound.
 *
 * Lets the agent send a text message via any started channel adapter mid-
 * turn. Before this tool existed, the only way for the agent to "send
 * a contact a WhatsApp" was to schedule a cron — which is the wrong
 * primitive for "do it right now". This tool covers the immediate path;
 * `cron` covers the scheduled path.
 *
 * Ownership: per-call gate, NOT a blanket refusal.
 *   - Workspace owner (TUI / `connect` / CLI) keeps full access including
 *     cross-channel and cross-conversation sends.
 *   - Channel-routed peer (e.g. an approved WhatsApp DM): may send only to
 *     their own chat. Explicit `channel`/`to` that match the inbound are
 *     allowed; anything pointing elsewhere is refused. Omitting both
 *     auto-routes back to the same chat. Mirrors the `send_media`
 *     posture.
 *
 * Defaults:
 *   - When `channel`/`to` aren't passed AND the calling turn came from a
 *     channel-routed inbound (the channel manager wired up
 *     `channelContext`), this tool auto-fills both fields with the
 *     originating chat. That means in a WhatsApp DM the agent can call
 *     `send_message({text: "..."})` to reply IN-PLACE without needing to
 *     remember the peer id. This matches the cron tool's same auto-fill
 *     behaviour.
 *   - When EITHER `channel` or `to` is explicitly set, BOTH must be set;
 *     mismatched auto-fill (e.g. channel from context + operator-supplied
 *     to) would silently cross wires.
 *
 * Validation:
 *   - `channel` must match a STARTED adapter (typo refusal via the channel
 *     manager's `adapter(id)` lookup — `whatapp` returns undefined and the
 *     tool refuses with a clear message including the started-channel
 *     list).
 *   - Sub-agents do not currently get this tool — they reply via the
 *     parent's spawn_agent return path. (If we ever expose `send_message`
 *     to sub-agents, the same per-call gate above applies.)
 *
 * Pattern note: the reference has a single polymorphic `message` tool with many
 * actions (send/react/poll/sendAttachment/...). Brigade ships with just
 * `send` today; future actions (react, edit, poll) get added as separate
 * tools (`react_to_message`, `edit_message`, etc.) rather than inflating
 * one tool's schema with action-mode branches — simpler for the model
 * to reason about, and lets us add ownerOnly granularity per action.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import { getActiveChannelManager } from "../channels/active-manager.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import { resolveOutboundTarget } from "../channels/channel-messaging-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { failedTextResult, payloadTextResult, readStringParam } from "./common.js";
import type { BrigadeTool } from "./types.js";

const log = createSubsystemLogger("brigade/send-message");

const SendMessageParams = Type.Object({
	text: Type.String({
		description:
			"Message body. Plaintext or markdown — channel adapters render their " +
			"native syntax (WhatsApp uses *bold*/_italic_/~strike~ etc.).",
	}),
	channel: Type.Optional(
		Type.String({
			description:
				"Channel id to send through (e.g. `whatsapp`, `slack`, `telegram`). " +
				"Must match a STARTED adapter. Auto-filled from the current turn's " +
				"originating channel when omitted (so replying in-place doesn't " +
				"require restating the channel).",
		}),
	),
	to: Type.Optional(
		Type.String({
			description:
				"Destination conversation id — phone number (WhatsApp), chat id " +
				"(Telegram), channel id (Slack), etc. Auto-filled from the current " +
				"turn's originating conversation when omitted.",
		}),
	),
	threadId: Type.Optional(
		Type.String({
			description:
				"Optional thread/topic id (Slack thread_ts, Telegram topic, Discord " +
				"thread). Channels without threading ignore it.",
		}),
	),
	accountId: Type.Optional(
		Type.String({
			description:
				"Multi-account channels (Slack with 2 workspaces, WhatsApp with 2 " +
				"linked numbers) use this to pick which account sends. Leave " +
				"unset for the default account.",
		}),
	),
});

type SendMessageDetails = {
	channel: string;
	to: string;
	textPreview: string;
	threadId?: string;
};

export interface MakeSendMessageToolOptions {
	/** Active channel context for this turn — used for auto-fill defaults. */
	channelContext?: ChannelApprovalRoute;
	/**
	 * Whether the calling turn is the workspace owner. When `false`, the
	 * turn was routed in from an approved channel peer — they can still
	 * `send_message` BUT only with target = their own chat (same shape as
	 * `send_media`). Cross-conversation / cross-channel sends require
	 * workspace-owner privilege. Defaults to `true` when omitted so legacy
	 * paths (TUI, tests) keep full access without opting in.
	 */
	senderIsOwner?: boolean;
}

/**
 * Build the `send_message` tool. Caller is the registry — it only registers
 * the tool when the gateway's channel manager is mounted; otherwise the
 * tool stays out of the surface (no point offering a send tool when there
 * are no channels to send through).
 */
export function makeSendMessageTool(
	opts: MakeSendMessageToolOptions = {},
): BrigadeTool<typeof SendMessageParams, SendMessageDetails> {
	const channelContext = opts.channelContext;
	const senderIsOwner = opts.senderIsOwner !== false;
	return {
		name: "send_message",
		label: "send_message",
		displaySummary: "sending a message",
		description:
			"Send a text message through a connected channel (WhatsApp / Slack / " +
			"Telegram / Discord / etc.) RIGHT NOW. Use this when the operator " +
			"asks you to message someone immediately — for scheduled / delayed " +
			"sends use the `cron` tool with a future `at` schedule instead.\n\n" +
			"Auto-routing: when called from a channel-routed turn (operator is " +
			"chatting from a channel), `channel` and `to` default to the " +
			"originating conversation — so a 'reply with hi' becomes " +
			"`{text: 'hi'}` without needing channel/to. Override by passing " +
			"explicit `channel` + `to` to target a DIFFERENT chat (e.g. 'tell " +
			"Alex on WhatsApp I'm in a meeting' from a TUI turn).\n\n" +
			"Validation: `channel` MUST match a started channel adapter. The " +
			"`## Channels` section of your system prompt lists what's available.",
		parameters: SendMessageParams,
		// NOTE: no blanket `ownerOnly: true`. Same shape as `send_media` —
		// a non-owner-routed turn (approved channel peer) may still call
		// this tool but the per-call gate below pins their target to their
		// own chat. Cross-channel / cross-conversation sends require the
		// workspace-owner privilege.
		async execute(_toolCallId, params): Promise<AgentToolResult<SendMessageDetails>> {
			const manager = getActiveChannelManager();
			if (!manager) {
				return failedTextResult(
					"send_message: the gateway has no channel manager mounted (no channels are configured). " +
						"Configure a channel in brigade.json first, then restart the gateway.",
					{ channel: "", to: "", textPreview: "" } as never,
				);
			}
			const text = readStringParam(params, "text", { required: true });
			const channelRaw = readStringParam(params, "channel");
			const toRaw = readStringParam(params, "to");
			const threadIdParam = readStringParam(params, "threadId");
			const accountId = readStringParam(params, "accountId");
			// Per-call non-owner gate. A channel-routed peer may only
			// reply-to-their-own-chat: BOTH `channel` and `to` either
			// (a) unset (auto-fill from channelContext below), OR
			// (b) set explicitly but EQUAL to channelContext's channelId +
			//     conversationId (so the LLM can request the same chat
			//     explicitly without it being a refusal).
			// Anything else — cross-channel, cross-conversation, or any
			// non-owner call with NO channelContext — is refused. Owners
			// (TUI / connect / CLI) bypass this gate entirely.
			if (!senderIsOwner) {
				if (!channelContext) {
					return failedTextResult(
						"send_message: as a non-owner-routed turn you must be reached through an approved channel.",
						{ channel: channelRaw ?? "", to: toRaw ?? "", textPreview: text.slice(0, 80) } as never,
					);
				}
				const channelMatchesCtx =
					channelRaw === undefined || channelRaw === channelContext.channelId;
				const toMatchesCtx =
					toRaw === undefined || toRaw === channelContext.conversationId;
				if (!channelMatchesCtx || !toMatchesCtx) {
					return failedTextResult(
						"send_message: as a non-owner-routed turn you may only send to your own chat. " +
							"Cross-conversation sends require workspace-owner privilege. " +
							"Omit `channel`/`to` to auto-route back to the inbound's own chat.",
						{ channel: channelRaw ?? "", to: toRaw ?? "", textPreview: text.slice(0, 80) } as never,
					);
				}
			}
			// Auto-fill from the active channel context when EITHER target field
			// is missing AND we have one. Strict pairing: if the caller set
			// `channel` but not `to`, we DON'T auto-fill just `to` from context
			// — that would silently mix a caller-supplied channel with a
			// context-derived peer, which is almost always wrong. The auto-fill
			// path only kicks in when BOTH are missing.
			let channel = channelRaw;
			let to = toRaw;
			let threadId = threadIdParam;
			let resolvedAccountId = accountId;
			if (!channel && !to && channelContext) {
				channel = channelContext.channelId;
				to = channelContext.conversationId;
				threadId ??= channelContext.threadId;
				// Inherit the routed inbound's accountId so a multi-account
				// install's reply lands on the SAME socket the request arrived
				// on. Caller-supplied `accountId` wins (operator may target a
				// specific account explicitly).
				resolvedAccountId ??= channelContext.accountId;
			}
			if (!channel || !to) {
				const started = manager.started;
				const targetHint =
					started.length > 0
						? `available channels: ${started.join(", ")}.`
						: "no channels are started; configure one in brigade.json + restart the gateway.";
				return failedTextResult(
					`send_message: \`channel\` and \`to\` are both required (no channel-routed turn context to auto-fill from). ${targetHint}`,
					{ channel: channel ?? "", to: to ?? "", textPreview: text.slice(0, 80) } as never,
				);
			}
			// OUTBOUND addressing (FIX #2). When the SEND channel's plugin
			// registered a `messaging` adapter (via channel-messaging-registry),
			// turn the agent's loose `to` ("Alex", "@alex", "telegram:123") into a
			// concrete conversation id: parse an explicit target → resolve a human
			// name via the channel's contact directory (if it ships one) →
			// normalize. This runs AFTER the non-owner gate above (which compared
			// the RAW `to`/`channel` against channelContext) so a channel peer
			// can't smuggle a cross-chat hop through an explicit-target string.
			//
			// BACK-COMPAT: a channel with NO messaging adapter, or a `to` that's
			// already a concrete id, comes back byte-for-byte unchanged — the raw
			// value flows straight to sendText exactly as before this fix.
			const resolvedTarget = await resolveOutboundTarget({ channelId: channel, to });
			to = resolvedTarget.to;
			const adapter = manager.adapter(channel, resolvedAccountId);
			if (!adapter) {
				const started = manager.started.join(", ") || "(none)";
				const accountHint = resolvedAccountId
					? ` (account "${resolvedAccountId}" not started for "${channel}")`
					: "";
				return failedTextResult(
					`send_message: channel "${channel}" is not a started adapter${accountHint} — typo? available channels: ${started}.`,
					{ channel, to, textPreview: text.slice(0, 80) } as never,
				);
			}
			// Pre-flight health check. The adapter may have STARTED successfully
			// hours ago but its underlying socket has since gone away — most
			// commonly because the operator unlinked WhatsApp from their phone,
			// or a Slack token expired, etc. Calling sendText() against a dead
			// socket either silently drops the message or fails with an opaque
			// error far from the operator's mental model. Refusing here gives
			// the model a clear, actionable error it can pass back: "the
			// channel is logged out, here's the CLI to re-pair."
			if (typeof adapter.health === "function") {
				const status = adapter.health();
				if (!status.ok) {
					const remediation = status.remediation
						? ` Remediation: ${status.remediation}`
						: "";
					return failedTextResult(
						`send_message: channel "${channel}" is currently unavailable (${status.kind}). ${status.reason}${remediation}`,
						{ channel, to, textPreview: text.slice(0, 80) } as never,
					);
				}
			}
			const opts2: { threadId?: string; accountId?: string } = {};
			if (threadId) opts2.threadId = threadId;
			if (resolvedAccountId) opts2.accountId = resolvedAccountId;
			try {
				await adapter.sendText(to, text, Object.keys(opts2).length > 0 ? opts2 : undefined);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.warn("send_message dispatch threw", {
					channel,
					to,
					error: errMsg,
				});
				return failedTextResult(
					`send_message: dispatch failed via ${channel} adapter — ${errMsg}. The recipient may not have received the message; consider trying again or telling the operator.`,
					{ channel, to, textPreview: text.slice(0, 80) } as never,
				);
			}
			log.info("send_message dispatched", {
				channel,
				to,
				threadId,
				accountId,
				textPreview: text.slice(0, 80),
			});
			return payloadTextResult({
				channel,
				to,
				textPreview: text.slice(0, 120),
				...(threadId !== undefined ? { threadId } : {}),
			});
		},
	};
}
