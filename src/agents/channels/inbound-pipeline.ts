/**
 * Shared inbound pipeline — one function every channel path (legacy
 * `startChannels` manager AND multi-account plugin `dispatchInbound`)
 * uses to handle one inbound message end-to-end.
 *
 * Stages (in order):
 *   1. Media + reply-context note synthesis.
 *   2. Access-control gate (DM/group policy + pairing challenge).
 *   3. Mark-read + composing-typing cosmetic.
 *   4. Channel-routed approval-reply intercept (yes/no settles gate).
 *   5. Abort trigger ("stop"/"cancel"/multilingual).
 *   6. Channel command (/help, /status, /allowlist, user-registered).
 *   7. Route resolve (8-tier) + session-key + identity-link.
 *   8. Last-channel pin (AFTER ACL only — never for stranger DMs).
 *   9. Optional debounce coalesce.
 *   10. dispatchTurn → reply send.
 *
 * Both surfaces share this contract:
 *
 *   - `startChannels` builds one per-adapter `commandMap` + `inflight` +
 *     `pendingDispatches` + `runTurn` closure.
 *   - The WhatsApp multi-account plugin builds one per-account variant
 *     (empty command map for now; per-account inflight + debounce slots).
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { BrigadeConfig } from "../../config/io.js";
import type { ChannelAdapter, ChannelCommand, InboundMessage } from "../extensions/types.js";
import {
	addAllowFrom,
	type DmPolicy,
	evaluateAccess,
	readAllowFrom,
	readGroupAllowFrom,
	removeAllowFrom,
	upsertPairingRequest,
} from "./access-control/index.js";
import { isAbortTrigger } from "./abort-triggers.js";
import { buildAgentSwitchCommands } from "./agent-switch-command.js";
import {
	type ChannelApprovalRoute,
	tryConsumeChannelApprovalReply,
} from "./approval-router.js";
import { recordLastChannelForAgent } from "./last-channel.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { resolveLinkedPeerIdFromConfig } from "../identity-links.js";
import { sanitizeReplyForChannel } from "./reply-sanitizer.js";
import { classifyErrorReason, isBrigadeRetryError } from "../error-classifier.js";
import { isRetryExhaustedError } from "../retry-policy.js";

const log = createSubsystemLogger("channels/inbound-pipeline");

/** Same grace window the legacy manager applied (queued-during-downtime suppress). */
const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000;

/** Per-channel access-control config slice (DM/group policy + declarative allow-from). */
interface ChannelAccessConfig {
	dmPolicy?: string;
	groupPolicy?: string;
	allowFrom?: string[];
	groupAllowFrom?: string[];
	/** Group room ids (…@g.us JIDs) the crew is fully active in — responds there
	 *  WITHOUT an @-mention, any sender. Empty by default. `*` = every group. */
	groupAllowJids?: string[];
	/** Active-conversation follow-up window (ms). After a member addresses the
	 *  crew (mention / reply-to-bot), their untagged follow-ups within this window
	 *  keep counting as addressed — so they don't re-tag every message. 0/unset =
	 *  off (strict per-message tagging, today's behavior). */
	groupFollowUpWindowMs?: number;
	debounceMs?: number;
}

function channelAccessCfg(cfg: BrigadeConfig, channelId: string): ChannelAccessConfig {
	return (cfg as { channels?: Record<string, ChannelAccessConfig> }).channels?.[channelId] ?? {};
}

function isValidPolicy(s: unknown): s is DmPolicy {
	return s === "open" || s === "disabled" || s === "allowlist" || s === "pairing";
}

function resolveDmPolicy(cfg: BrigadeConfig, channelId: string): DmPolicy {
	const raw = channelAccessCfg(cfg, channelId).dmPolicy;
	return isValidPolicy(raw) ? raw : "pairing";
}

function resolveGroupPolicy(cfg: BrigadeConfig, channelId: string): DmPolicy {
	const raw = channelAccessCfg(cfg, channelId).groupPolicy;
	return isValidPolicy(raw) ? raw : "allowlist";
}

function configIds(list: string[] | undefined): string[] {
	return (list ?? []).map((x) => String(x).trim()).filter(Boolean);
}

// Group follow-up window: once a member addresses the crew (mention / reply-to-
// bot) in a group, their untagged follow-ups within the configured window keep
// counting as addressed, so they don't re-tag every message. Keyed per
// (channel, account, group, speaker); in-memory + crudely capped.
const groupFollowUpAt = new Map<string, number>();
const GROUP_FOLLOWUP_MAX_KEYS = 5000;
function groupFollowUpKey(channel: string, account: string | undefined, group: string, speaker: string): string {
	return `${channel}::${account || "*"}::${group}::${speaker}`;
}
function withinGroupFollowUp(key: string, windowMs: number): boolean {
	if (windowMs <= 0) return false;
	const at = groupFollowUpAt.get(key);
	return at !== undefined && Date.now() - at < windowMs;
}
function stampGroupFollowUp(key: string): void {
	if (groupFollowUpAt.size > GROUP_FOLLOWUP_MAX_KEYS) groupFollowUpAt.clear();
	groupFollowUpAt.set(key, Date.now());
}

/** Classify the underlying error into a recipient-facing reply line. */
function buildOperatorFacingErrorReply(err: unknown): string {
	const reason = isBrigadeRetryError(err)
		? err.reason
		: isRetryExhaustedError(err)
			? err.lastReason
			: classifyErrorReason(err);
	switch (reason) {
		case "billing":
			return [
				"🦁  I'm tapped out — my model provider account just ran dry.",
				"",
				"The owner needs to top it up before I can answer. Back the moment they do.",
			].join("\n");
		case "auth":
		case "auth_permanent":
			return [
				"🦁  My credentials need a refresh — I can't reach the model until the owner sorts them out.",
				"",
				"Usually a quick fix. Try me again in a few minutes.",
			].join("\n");
		case "rate_limit":
		case "overloaded":
			return "⏳  Catching my breath — give me 30 seconds and send that again.";
		case "context_overflow":
			return "🧠  Our chat's gotten too long for me to hold the whole thread. Say 'new chat' and we'll start fresh.";
		case "model_not_found":
			return "🦁  The model I usually use isn't reachable. The owner needs to pick a different one — back as soon as they do.";
		case "timeout":
			return "⏳  My reply timed out — give it one more shot, it usually works the second time.";
		case "format":
		case "session_expired":
		case "unknown":
		default:
			return "⚠️  Hit a snag replying to that. Give it another try — if it keeps happening, let the owner know.";
	}
}

type PairingIdLabel = "phone" | "username" | "account";

function heuristicLabel(senderId: string): PairingIdLabel {
	if (!senderId) return "account";
	const digits = senderId.replace(/\D/g, "");
	const hasLetters = /[A-Za-z]/.test(senderId);
	return !hasLetters && digits.length >= 7 ? "phone" : "account";
}

function senderLineFor(senderId: string, idLabel?: PairingIdLabel): string {
	if (!senderId) return "👤  *Your account:*  (unknown)";
	const resolved = idLabel ?? heuristicLabel(senderId);
	if (resolved === "phone") {
		const digits = senderId.replace(/\D/g, "");
		const rendered = digits.length >= 7 ? `+${digits}` : senderId;
		return `📞  *Your number:*  ${rendered}`;
	}
	if (resolved === "username") return `@  *Your username:*  ${senderId}`;
	return `👤  *Your account:*  ${senderId}`;
}

function buildChallengeReply(args: { code: string; senderId: string; channelLabel: string; idLabel?: PairingIdLabel }): string {
	void args.channelLabel;
	return [
		"🦁  *Brigade* — your private AI crew",
		"╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
		"👋  *Welcome!*  An admin needs to approve you before we can chat.",
		senderLineFor(args.senderId, args.idLabel),
		"🔐  *Your one-time code*",
		"```",
		args.code,
		"```",
		"Share it with your admin — they'll approve you by running:",
		"```",
		`brigade pairing approve ${args.code}`,
		"```",
		"✨  Once approved, just send your next message.",
		"⏱️  _Expires in 1 hour._",
		"╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
		"_powered by_ ✨ *Spinabot*",
	].join("\n");
}

/** Result returned by every channel turn — only the reply text matters. */
export interface ChannelTurnResult {
	reply: string;
}

/** runTurn signature shared by the legacy manager and the plugin path. */
export type RunChannelTurnFn = (args: {
	text: string;
	sessionKey: string;
	agentId: string;
	signal?: AbortSignal;
	senderIsOwner?: boolean;
	channelApprovalRoute?: ChannelApprovalRoute;
}) => Promise<ChannelTurnResult>;

/** Pending debounce slot — accumulated text waiting to dispatch. */
export interface PendingDispatch {
	timer: ReturnType<typeof setTimeout>;
	parts: string[];
	baseMsg: InboundMessage;
	sessionKey: string;
	agentId: string;
	senderIsOwner: boolean;
	channelApprovalRoute: ChannelApprovalRoute;
}

/** Bundled built-in channel commands an operator can DM to admin the bot. */
export function buildBundledCommands(adapter: ChannelAdapter): ChannelCommand[] {
	const isOperator = (senderId: string): boolean => {
		const self = adapter.selfId?.();
		if (!self) return false;
		return self.replace(/\s+/g, "") === senderId.replace(/\s+/g, "");
	};
	return [
		{
			name: "help",
			description: "Show available commands.",
			handler: () =>
				[
					"Brigade channel commands:",
					"  /help            — show this list",
					"  /status          — show your access state on this channel",
					"  /allowlist list  — operator-only: show approved senders",
					"  /allowlist add <id> | /allowlist remove <id> — operator-only",
					"  /agent <id>      — pin future messages from you to that agent",
					"  /agent main      — clear the pin",
					"  /agents          — list peer pins on this channel",
					"  /whoami          — show which agent answers you right now",
					"  /org             — show the Pride hierarchy chart (Higher Office / Departments)",
					"  /org <agent-id>  — show a sub-tree of the chart",
					"  /org --departments — chart minus the Higher Office block",
					"  /org --explain <from> <to> — why this edge exists (or doesn't)",
					"  stop / cancel / abort — kill the current turn",
				].join("\n"),
		},
		{
			name: "status",
			description: "Show your access state on this channel.",
			handler: (ctx) => {
				const op = isOperator(ctx.from);
				const allow = readAllowFrom(ctx.channel);
				const role = op ? "operator (self)" : allow.includes(ctx.from) ? "approved" : "unapproved";
				return [
					`Channel: ${ctx.channel}`,
					`Your id: ${ctx.from}`,
					`Role:    ${role}`,
					`Allow-list size: ${allow.length}`,
				].join("\n");
			},
		},
		{
			name: "allowlist",
			description: "Operator-only: list / add / remove approved senders.",
			handler: (ctx) => {
				if (!isOperator(ctx.from)) return "This command can only be run by the operator (the linked account).";
				const parts = ctx.args.trim().split(/\s+/);
				const sub = (parts[0] ?? "list").toLowerCase();
				if (sub === "list" || !sub) {
					const allow = readAllowFrom(ctx.channel);
					return allow.length === 0
						? "Allow-from list is empty."
						: `Allow-from (${allow.length}):\n  ${allow.join("\n  ")}`;
				}
				const target = parts[1];
				if (sub === "add" && target) {
					const normalized = adapter.pairing?.normalizeAllowEntry?.(target) ?? target;
					return addAllowFrom(ctx.channel, normalized)
						? `Added "${normalized}" to the allow-from list.`
						: `"${normalized}" was already on the list.`;
				}
				if (sub === "remove" && target) {
					return removeAllowFrom(ctx.channel, target)
						? `Removed "${target}" from the allow-from list.`
						: `"${target}" was not on the list.`;
				}
				return "Usage: /allowlist [list | add <id> | remove <id>]";
			},
		},
		// Channel direct-talk pinning: `/agent <id>` lets the sender pin
		// future messages from THIS peer on THIS channel+account to a
		// specific agent. Brigade-personal-first → no authorize gate; the
		// sender of the message owns the pin (the binding records `boundBy`
		// for the future multi-tenant cut).
		...buildAgentSwitchCommands(),
	];
}

/**
 * Lane key for inflight + pending maps. Disambiguates by
 * (adapter, account, conversation, thread) so a stop in one lane never
 * accidentally aborts a sibling turn.
 */
export function laneKey(a: {
	adapterId: string;
	conversationId: string;
	accountId?: string;
	threadId?: string;
}): string {
	const account = a.accountId && a.accountId.trim() ? a.accountId.trim() : "*";
	const thread = a.threadId && a.threadId.trim() ? a.threadId.trim() : "*";
	return `${a.adapterId}::${account}::${a.conversationId}::${thread}`;
}

/** Per-channel-instance pipeline context — captures every dispatch-time dep. */
export interface InboundPipelineContext {
	adapter: ChannelAdapter;
	config: BrigadeConfig;
	agentId: string;
	runTurn: RunChannelTurnFn;
	commandMap: Map<string, ChannelCommand>;
	inflight: Map<string, AbortController>;
	pendingDispatches: Map<string, PendingDispatch>;
	/** Outer abort (e.g. channel-stop or account-stop) — narrows turn signals. */
	parentAbort?: AbortSignal;
}

/** Send via adapter, swallowing errors so a flaky network can't tear down the listener. */
async function safeSendText(
	adapter: ChannelAdapter,
	conversationId: string,
	text: string,
	opts: { threadId?: string; accountId?: string } | undefined,
): Promise<void> {
	try {
		await adapter.sendText(conversationId, text, opts);
	} catch (err) {
		log.warn("sendText failed", {
			channel: adapter.id,
			conversationId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Build the opts object the adapter expects, omitting undefined keys. */
function buildSendOpts(threadId?: string, accountId?: string): { threadId?: string; accountId?: string } | undefined {
	const out: { threadId?: string; accountId?: string } = {};
	if (threadId) out.threadId = threadId;
	if (accountId) out.accountId = accountId;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Run one inbound through the shared pipeline. Never throws — every error is
 * logged + surfaced to the recipient as a friendly classifier-aware reply.
 */
export async function runChannelInboundPipeline(
	ctx: InboundPipelineContext,
	msg: InboundMessage,
): Promise<void> {
	const { adapter, config: cfg, agentId, runTurn, commandMap, inflight, pendingDispatches } = ctx;
	try {
		// Cheap empty-message fast-path. Media synthesis happens AFTER the
		// access gate now (media may be a deferred download — see below), so
		// this only needs presence checks: text, eager media, or a deferral.
		if (!msg.text?.trim() && !(msg.media && msg.media.length > 0) && !msg.resolveMedia) {
			return;
		}

		// Access-control gate.
		const isGroup = msg.isGroup === true || msg.chatType === "group";
		const dmPolicy = resolveDmPolicy(cfg, adapter.id);
		const groupPolicy = resolveGroupPolicy(cfg, adapter.id);
		const cfgEntry = channelAccessCfg(cfg, adapter.id);
		// Per-account ACL — multi-account WhatsApp installs partition the
		// allow-from + pairing files under `accounts/<accountId>/`. Legacy
		// (single-account / no accountId) inputs collapse to the channel-wide
		// file via the path resolver's default branch.
		const aclAccountId = msg.accountId?.trim() || undefined;
		const storeAllow = dmPolicy === "allowlist" ? [] : readAllowFrom(adapter.id, aclAccountId);
		const allowFrom = [...new Set([...storeAllow, ...configIds(cfgEntry.allowFrom)])];
		const groupAllowFrom = [
			...new Set([...readGroupAllowFrom(adapter.id, aclAccountId), ...configIds(cfgEntry.groupAllowFrom)]),
		];
		// Per-group full-trust list (respond untagged in these groups). Config-only.
		const groupAllowJids = configIds(cfgEntry.groupAllowJids);
		const selfId = adapter.selfId?.();
		const mentioned = !!(selfId && msg.mentions?.includes(selfId));
		const senderIsOwner = !!(selfId && selfId.trim() === msg.from.trim());
		// "Addressed" superset for groups: mention OR a reply/quote to one of the
		// bot's OWN messages OR within the active follow-up window for this speaker.
		// Lets a member tag once / reply to the bot and keep the thread going
		// untagged (window is config-gated; 0 = strict per-message tagging).
		const groupFollowUpWindowMs =
			typeof cfgEntry.groupFollowUpWindowMs === "number" && cfgEntry.groupFollowUpWindowMs > 0
				? cfgEntry.groupFollowUpWindowMs
				: 0;
		const fuKey = groupFollowUpKey(adapter.id, aclAccountId, msg.conversationId, msg.from);
		const isReplyToBot = !!(selfId && msg.replyTo?.from && selfId.trim() === msg.replyTo.from.trim());
		const addressed = isGroup
			? mentioned || isReplyToBot || withinGroupFollowUp(fuKey, groupFollowUpWindowMs)
			: mentioned;
		const decision = evaluateAccess({
			policy: dmPolicy,
			groupPolicy,
			senderId: msg.from,
			...(msg.senderLid !== undefined ? { senderLid: msg.senderLid } : {}),
			selfId,
			allowFrom,
			groupAllowFrom,
			groupAllowJids,
			groupId: msg.conversationId,
			isGroup,
			mentioned,
			addressed,
		});
		// Keep the active-conversation window alive on every admitted group turn,
		// so an ongoing back-and-forth doesn't require re-tagging.
		if (isGroup && decision.kind === "allow") stampGroupFollowUp(fuKey);
		if (decision.kind === "block") {
			log.info("inbound dropped by policy", {
				channel: adapter.id,
				sender: msg.from,
				reason: decision.reason,
				// Surface the group room id on group drops so the operator can copy it
				// into `channels.<ch>.groupAllowJids` to make the crew live there.
				...(isGroup ? { group: msg.conversationId } : {}),
			});
			return;
		}
		if (decision.kind === "challenge") {
			const challengeSenderId = msg.from?.trim();
			if (!challengeSenderId) {
				log.warn("inbound dropped — no usable sender id for challenge", {
					channel: adapter.id,
					conversationId: msg.conversationId,
				});
				return;
			}
			const connectedAt = adapter.connectedAt?.() ?? null;
			const historicalCutoff =
				connectedAt !== null ? connectedAt - PAIRING_REPLY_HISTORY_GRACE_MS : null;
			const isHistorical =
				historicalCutoff !== null &&
				msg.messageTimestampMs !== undefined &&
				msg.messageTimestampMs < historicalCutoff;
			const { code, isNew } = upsertPairingRequest({
				channelId: adapter.id,
				senderId: challengeSenderId,
				senderName: msg.fromName,
				accountId: aclAccountId ?? null,
			});
			log.info("issued pairing challenge", {
				channel: adapter.id,
				sender: challengeSenderId,
				isNew,
				skipReply: isHistorical || !isNew,
			});
			if (isHistorical || !isNew) return;
			await safeSendText(
				adapter,
				msg.conversationId,
				buildChallengeReply({
					code,
					senderId: challengeSenderId,
					channelLabel: adapter.label,
					idLabel: adapter.pairing?.idLabel,
				}),
				buildSendOpts(msg.threadId, msg.accountId),
			);
			if (msg.messageId && adapter.markRead) {
				try {
					await adapter.markRead(msg.conversationId, msg.messageId, msg.participantId);
				} catch {
					/* cosmetic */
				}
			}
			return;
		}
		// Mark read — sender sees acknowledgement.
		if (msg.messageId && adapter.markRead) {
			try {
				await adapter.markRead(msg.conversationId, msg.messageId, msg.participantId);
			} catch {
				/* cosmetic */
			}
		}
		// ── Sender ADMITTED — only now pay for media. ──────────────────────
		// Deferred downloads (msg.resolveMedia) run here, after the access
		// gate, so a blocked stranger's group video is never fetched from
		// WhatsApp, never sealed, never archived to the backend. Before this
		// reorder, media was downloaded at the socket layer and ~17 MB of
		// strangers' group videos landed in storage within minutes even
		// though every one of their messages was dropped by policy.
		if (msg.resolveMedia && (!msg.media || msg.media.length === 0)) {
			try {
				msg.media = await msg.resolveMedia();
			} catch (err) {
				log.warn("deferred media download failed", {
					channel: adapter.id,
					sender: msg.from,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// Media + reply-context note synthesis (moved from pre-gate — the
		// gate never reads `text`, and synthesis must wait for the deferred
		// media above).
		const mediaNote =
			msg.media && msg.media.length > 0
				? msg.media
						.map((m) => {
							const caption = m.caption ? `: "${m.caption}"` : "";
							const name = m.fileName ? ` (${m.fileName})` : "";
							return `[attached ${m.kind}${name}${caption} → ${m.path}]`;
						})
						.join("\n")
				: "";
		const replyNote = msg.replyTo?.body
			? `> ${msg.replyTo.body.replace(/\n/g, " ").slice(0, 200)}\n`
			: "";
		const text = [replyNote + mediaNote, msg.text?.trim() ?? ""]
			.filter(Boolean)
			.join("\n")
			.trim();
		// Media-only message whose deferred download failed → nothing usable.
		if (!text) return;
		// Approval-reply intercept (AFTER access gate, BEFORE abort triggers).
		const approvalIntercept = tryConsumeChannelApprovalReply({
			channelId: adapter.id,
			conversationId: msg.conversationId,
			text,
			...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
			...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
		});
		if (approvalIntercept.matched) {
			const ack =
				approvalIntercept.decision === "allow-once"
					? "Allowed once. 🦁"
					: approvalIntercept.decision === "allow-always"
						? "Allowed and saved to the allowlist. 🦁"
						: "Denied. 🦁";
			await safeSendText(adapter, msg.conversationId, ack, buildSendOpts(msg.threadId, msg.accountId));
			return;
		}
		// Abort trigger — kill in-flight turn + clear pending slots.
		if (isAbortTrigger(text)) {
			let cancelledAny = false;
			for (const [key, slot] of pendingDispatches) {
				if (slot.baseMsg.conversationId !== msg.conversationId) continue;
				if (msg.threadId !== undefined && slot.baseMsg.threadId !== undefined && slot.baseMsg.threadId !== msg.threadId) continue;
				if (msg.accountId !== undefined && slot.baseMsg.accountId !== undefined && slot.baseMsg.accountId !== msg.accountId) continue;
				clearTimeout(slot.timer);
				pendingDispatches.delete(key);
				cancelledAny = true;
			}
			const opts = buildSendOpts(msg.threadId, msg.accountId);
			const inflightPrefix = `${adapter.id}::${msg.accountId && msg.accountId.trim() ? msg.accountId.trim() : "*"}::${msg.conversationId}::`;
			const threadSuffix = msg.threadId && msg.threadId.trim() ? msg.threadId.trim() : null;
			let abortedAny = false;
			for (const [key, controller] of [...inflight.entries()]) {
				if (!key.startsWith(inflightPrefix)) continue;
				if (threadSuffix !== null && !key.endsWith(`::${threadSuffix}`)) continue;
				controller.abort();
				inflight.delete(key);
				abortedAny = true;
			}
			if (abortedAny || cancelledAny) {
				await safeSendText(adapter, msg.conversationId, "Stopped.", opts);
			} else {
				await safeSendText(
					adapter,
					msg.conversationId,
					"Nothing was running — try again with a fresh message.",
					opts,
				);
			}
			return;
		}
		// Channel command (`/name ...`).
		if (text.startsWith("/") && commandMap.size > 0) {
			const space = text.indexOf(" ");
			const name = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
			const command = commandMap.get(name);
			if (command) {
				const cmdCtx = {
					channel: adapter.id,
					conversationId: msg.conversationId,
					from: msg.from,
					fromName: msg.fromName,
					args: space === -1 ? "" : text.slice(space + 1).trim(),
					config: cfg,
					// Additive scope: handlers like `/agent` need accountId +
					// isGroup to build a peer-scoped binding. Legacy handlers
					// (`/help`, `/status`, `/allowlist`) ignore these fields.
					...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
					isGroup,
				};
				const opts = buildSendOpts(msg.threadId, msg.accountId);
				if (command.authorize && !command.authorize(cmdCtx)) {
					await safeSendText(adapter, msg.conversationId, "Not authorized to run that command.", opts);
					return;
				}
				const out = await command.handler(cmdCtx);
				if (typeof out === "string" && out.trim()) {
					await safeSendText(adapter, msg.conversationId, out.trim(), opts);
				}
				return;
			}
		}
		// Route through the 8-tier resolver.
		const rawAccountId = msg.accountId?.trim() || msg.conversationId;
		const normalizedAccountId = normalizeAccountId(rawAccountId);
		const peerKind = isGroup ? "group" : "direct";
		const canonicalPeerId =
			resolveLinkedPeerIdFromConfig({
				config: cfg,
				channel: adapter.id,
				peerId: msg.from,
			}) ?? msg.from;
		const route = resolveAgentRoute({
			cfg,
			channel: adapter.id,
			accountId: normalizedAccountId,
			peer: canonicalPeerId ? { id: canonicalPeerId, kind: peerKind } : undefined,
			...(msg.guildId ? { guildId: msg.guildId } : {}),
			...(msg.teamId ? { teamId: msg.teamId } : {}),
			...(msg.memberRoleIds?.length ? { memberRoleIds: msg.memberRoleIds } : {}),
		});
		const resolvedAgentId = route.agentId || agentId;
		log.debug("inbound routed", {
			channel: adapter.id,
			from: msg.from,
			agentId: resolvedAgentId,
			matchedBy: route.matchedBy,
		});
		const sessionKey = resolveThreadSessionKeys({
			baseSessionKey: route.sessionKey,
			...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
			useSuffix: true,
		}).sessionKey;
		const channelApprovalRoute: ChannelApprovalRoute = {
			channelId: adapter.id,
			conversationId: msg.conversationId,
			...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
			...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
			agentId: resolvedAgentId,
		};
		// Pin THIS channel as the operator's most-recently-active. AFTER the
		// access gate so a stranger DM can never redirect future
		// announce-mode crons.
		recordLastChannelForAgent(resolvedAgentId, channelApprovalRoute);
		// Optional debounce coalesce.
		const debounceMs = Math.max(0, Number(cfgEntry.debounceMs ?? 0)) | 0;
		if (debounceMs > 0) {
			const dispatchKey = isGroup ? `${msg.conversationId}#${msg.from}` : msg.conversationId;
			const existing = pendingDispatches.get(dispatchKey);
			if (existing) {
				clearTimeout(existing.timer);
				existing.parts.push(text);
				existing.timer = setTimeout(
					() => void flushDispatch(ctx, dispatchKey),
					debounceMs,
				);
			} else {
				pendingDispatches.set(dispatchKey, {
					parts: [text],
					baseMsg: msg,
					sessionKey,
					agentId: resolvedAgentId,
					senderIsOwner,
					channelApprovalRoute,
					timer: setTimeout(() => void flushDispatch(ctx, dispatchKey), debounceMs),
				});
			}
			return;
		}
		// Immediate dispatch.
		await dispatchTurn(ctx, {
			text,
			sessionKey,
			agentId: resolvedAgentId,
			conversationId: msg.conversationId,
			...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
			...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
			senderIsOwner,
			channelApprovalRoute,
		});
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.warn("inbound handling failed", {
			channel: adapter.id,
			conversationId: msg.conversationId,
			error: errMsg,
		});
		await safeSendText(
			adapter,
			msg.conversationId,
			buildOperatorFacingErrorReply(err),
			buildSendOpts(msg.threadId, msg.accountId),
		);
	}

	// Run one agent turn + reply through the adapter.
	async function dispatchTurn(
		c: InboundPipelineContext,
		a: {
			text: string;
			sessionKey: string;
			agentId: string;
			conversationId: string;
			threadId?: string;
			accountId?: string;
			senderIsOwner?: boolean;
			channelApprovalRoute?: ChannelApprovalRoute;
		},
	): Promise<void> {
		const controller = new AbortController();
		// Cascade the outer parent abort (channel-stop / account-stop) into
		// this turn so a plugin's `stopAccount` cancels in-flight turns
		// instead of letting them complete against a torn-down socket.
		const parent = c.parentAbort;
		if (parent) {
			if (parent.aborted) controller.abort();
			else parent.addEventListener("abort", () => controller.abort(), { once: true });
		}
		const ilKey = laneKey({
			adapterId: c.adapter.id,
			conversationId: a.conversationId,
			...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
			...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
		});
		c.inflight.set(ilKey, controller);
		if (c.adapter.setComposing) {
			try {
				await c.adapter.setComposing(a.conversationId, "composing");
			} catch {
				/* cosmetic */
			}
		}
		let result: ChannelTurnResult;
		try {
			result = await c.runTurn({
				text: a.text,
				sessionKey: a.sessionKey,
				agentId: a.agentId,
				signal: controller.signal,
				senderIsOwner: a.senderIsOwner,
				...(a.channelApprovalRoute !== undefined
					? { channelApprovalRoute: a.channelApprovalRoute }
					: {}),
			});
		} catch (err) {
			if (c.inflight.get(ilKey) === controller) c.inflight.delete(ilKey);
			if (c.adapter.setComposing) {
				try {
					await c.adapter.setComposing(a.conversationId, "paused");
				} catch {
					/* cosmetic */
				}
			}
			throw err;
		}
		if (c.inflight.get(ilKey) === controller) c.inflight.delete(ilKey);
		if (c.adapter.setComposing) {
			try {
				await c.adapter.setComposing(a.conversationId, "paused");
			} catch {
				/* cosmetic */
			}
		}
		if (controller.signal.aborted) return;
		const reply = sanitizeReplyForChannel(result.reply?.trim() ?? "");
		if (reply) {
			await c.adapter.sendText(
				a.conversationId,
				reply,
				buildSendOpts(a.threadId, a.accountId),
			);
		}
	}

	// Flush a debounce slot.
	async function flushDispatch(c: InboundPipelineContext, dispatchKey: string): Promise<void> {
		const slot = c.pendingDispatches.get(dispatchKey);
		if (!slot) return;
		c.pendingDispatches.delete(dispatchKey);
		const combined = slot.parts.join("\n\n");
		const conversationId = slot.baseMsg.conversationId;
		const threadId = slot.baseMsg.threadId;
		const accountId = slot.baseMsg.accountId;
		try {
			await dispatchTurn(c, {
				text: combined,
				sessionKey: slot.sessionKey,
				agentId: slot.agentId,
				conversationId,
				...(threadId !== undefined ? { threadId } : {}),
				...(accountId !== undefined ? { accountId } : {}),
				senderIsOwner: slot.senderIsOwner,
				channelApprovalRoute: slot.channelApprovalRoute,
			});
		} catch (err) {
			log.warn("debounced dispatch failed", {
				channel: c.adapter.id,
				conversationId,
				error: err instanceof Error ? err.message : String(err),
			});
			await safeSendText(
				c.adapter,
				conversationId,
				buildOperatorFacingErrorReply(err),
				buildSendOpts(threadId, accountId),
			);
		}
	}
}

/** Build a fresh per-channel pipeline context. */
export function createInboundPipelineContext(args: {
	adapter: ChannelAdapter;
	config: BrigadeConfig;
	agentId: string;
	runTurn: RunChannelTurnFn;
	commandMap?: Map<string, ChannelCommand>;
	parentAbort?: AbortSignal;
}): InboundPipelineContext {
	return {
		adapter: args.adapter,
		config: args.config,
		agentId: args.agentId,
		runTurn: args.runTurn,
		commandMap: args.commandMap ?? new Map(),
		inflight: new Map(),
		pendingDispatches: new Map(),
		...(args.parentAbort !== undefined ? { parentAbort: args.parentAbort } : {}),
	};
}
