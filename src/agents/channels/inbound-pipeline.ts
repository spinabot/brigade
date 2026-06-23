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
import { getActiveRegistry } from "../extensions/active-registry.js";
import {
	type AccessDecision,
	addAllowFrom,
	approvePairingCode,
	type DmPolicy,
	evaluateAccess,
	formatAllowFrom,
	readAllowFrom,
	readChannelOwner,
	readGroupAllowFrom,
	readPendingPairings,
	removeAllowFrom,
	revokePairingCode,
	upsertPairingRequest,
} from "./access-control/index.js";
import { isAbortTrigger } from "./abort-triggers.js";
import { buildAgentSwitchCommands } from "./agent-switch-command.js";
import { decodeGeneralCallbackData, isGeneralCallbackData } from "./general-callback.js";
import {
	type ChannelApprovalRoute,
	tryConsumeChannelApprovalCallback,
	tryConsumeChannelApprovalReply,
} from "./approval-router.js";
import { recordLastChannelForAgent } from "./last-channel.js";
import { recordLastSentMessage } from "./last-sent-message.js";
import { buildMediaNote } from "./media-capture.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { resolveLinkedPeerIdFromConfig } from "../identity-links.js";
import { resolveInboundConversation } from "./channel-messaging-registry.js";
import { consultChannelDmPolicy } from "./channel-security-registry.js";
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

function buildChallengeReply(args: {
	code: string;
	senderId: string;
	channelId: string;
	channelLabel: string;
	idLabel?: PairingIdLabel;
}): string {
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
		"Send this code to your admin. They approve you by either:",
		`  •  replying  *\`/approve ${args.code}\`*  to this bot, or`,
		`  •  running this on the server:`,
		"```",
		`brigade pairing approve ${args.code} --channel ${args.channelId}`,
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
	/**
	 * OPTIONAL live-streaming delta sink. When the pipeline wants progressive
	 * delivery (the adapter advertises `beginReplyStream` AND the channel is
	 * configured to stream), it passes this; the gateway forwards the
	 * accumulating answer text on each model update. Undefined → final-only
	 * delivery (unchanged). The final reply is ALWAYS still returned, so the
	 * non-streaming fallback stays authoritative.
	 */
	onReplyDelta?: (accumulatedText: string) => void;
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
	const norm = (s: string): string => s.replace(/\s+/g, "");
	const isOperator = (senderId: string, accountId?: string | null): boolean => {
		const id = norm(senderId);
		// The linked-self id (WhatsApp: the bot runs AS the operator).
		const self = adapter.selfId?.();
		if (self && norm(self) === id) return true;
		// The recorded channel owner (Telegram: bot ≠ operator, owner is claimed
		// via first /start). accountId scopes multi-account installs.
		const owner = readChannelOwner(adapter.id, accountId ?? null);
		return !!owner && norm(owner) === id;
	};
	return [
		{
			name: "help",
			description: "Show available commands.",
			handler: () =>
				[
					"Brigade channel commands:",
					"  /help            — show this list",
					"  /start           — welcome + how to use this bot",
					"  /status          — show your access state on this channel",
					"  /pending         — operator-only: list people waiting for approval",
					"  /approve <code>  — operator-only: approve a waiting person by their code",
					"  /deny <code>     — operator-only: reject a pending request",
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
			name: "start",
			description: "Welcome message + how to use this bot.",
			handler: (ctx) => {
				if (isOperator(ctx.from, ctx.accountId ?? null)) {
					return [
						"🦁 *Brigade* — your private AI crew is online.",
						"",
						"Just send a message to chat with your crew.",
						"Admin: /pending, /approve <code>, /allowlist, /agents, /org.",
						"Type /help for the full list.",
					].join("\n");
				}
				return [
					"🦁 *Brigade* — your private AI crew.",
					"",
					"Send a message and your crew will reply.",
					"Type /help to see what you can do, or /whoami to see who answers you.",
				].join("\n");
			},
		},
		{
			name: "pending",
			description: "Operator-only: list people waiting for approval.",
			handler: (ctx) => {
				if (!isOperator(ctx.from, ctx.accountId ?? null))
					return "This command can only be run by the operator (the linked account).";
				const pending = readPendingPairings(ctx.channel, ctx.accountId ?? null);
				if (pending.length === 0) return "No one is waiting for approval right now.";
				const lines = pending.map((r) => {
					const who = r.senderName ? `${r.senderName} (${r.senderId})` : r.senderId;
					return `  ${r.code}  —  ${who}`;
				});
				return [
					`${pending.length} waiting for approval:`,
					...lines,
					"",
					"Approve with /approve <code>, or reject with /deny <code>.",
				].join("\n");
			},
		},
		{
			name: "approve",
			description: "Operator-only: approve a waiting person by their pairing code.",
			handler: (ctx) => {
				if (!isOperator(ctx.from, ctx.accountId ?? null))
					return "This command can only be run by the operator (the linked account).";
				const code = ctx.args.trim().split(/\s+/)[0] ?? "";
				if (!code) return "Usage: /approve <code>   (see waiting codes with /pending)";
				const approved = approvePairingCode(ctx.channel, code, ctx.accountId ?? null);
				if (!approved) return `No pending request with code "${code}". Check /pending.`;
				const who = approved.senderName
					? `${approved.senderName} (${approved.senderId})`
					: approved.senderId;
				return `✅ Approved ${who}. They can chat now — no restart needed.`;
			},
		},
		{
			name: "deny",
			description: "Operator-only: reject a pending request by its pairing code.",
			handler: (ctx) => {
				if (!isOperator(ctx.from, ctx.accountId ?? null))
					return "This command can only be run by the operator (the linked account).";
				const code = ctx.args.trim().split(/\s+/)[0] ?? "";
				if (!code) return "Usage: /deny <code>   (see waiting codes with /pending)";
				return revokePairingCode(ctx.channel, code, ctx.accountId ?? null)
					? `⛔ Rejected request ${code}.`
					: `No pending request with code "${code}".`;
			},
		},
		{
			name: "status",
			description: "Show your access state on this channel.",
			handler: (ctx) => {
				const op = isOperator(ctx.from, ctx.accountId ?? null);
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
				if (!isOperator(ctx.from, ctx.accountId ?? null)) return "This command can only be run by the operator (the linked account).";
				const parts = ctx.args.trim().split(/\s+/);
				const sub = (parts[0] ?? "list").toLowerCase();
				if (sub === "list" || !sub) {
					const allow = readAllowFrom(ctx.channel);
					// Shared display formatter so the in-chat `/allowlist list` and the
					// `brigade channels allow list` CLI render the list identically.
					return formatAllowFrom(allow);
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
	opts: { threadId?: string; accountId?: string; replyToId?: string } | undefined,
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

/**
 * Build the opts object the adapter expects, omitting undefined keys.
 *
 * `replyToId` is OPTIONAL and additive: pass the inbound message's id ONLY at a
 * genuine reply-to-inbound send site so the adapter quotes the message it
 * answers (WhatsApp quote / Telegram `reply_parameters`). Omit it everywhere
 * else — a build with no `replyToId` produces a byte-identical opts object to
 * before this field existed, so non-reply sends are unchanged.
 */
function buildSendOpts(
	threadId?: string,
	accountId?: string,
	replyToId?: string,
): { threadId?: string; accountId?: string; replyToId?: string } | undefined {
	const out: { threadId?: string; accountId?: string; replyToId?: string } = {};
	if (threadId) out.threadId = threadId;
	if (accountId) out.accountId = accountId;
	if (replyToId) out.replyToId = replyToId;
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
		// An inline-button press (`callbackQuery`) carries no text/media but
		// MUST still flow through to the post-gate approval-callback intercept,
		// so it is explicitly exempt from this empty-content bail.
		if (
			!msg.text?.trim() &&
			!(msg.media && msg.media.length > 0) &&
			!msg.resolveMedia &&
			!msg.callbackQuery
		) {
			return;
		}

		// Plugin hook: `inbound_claim` (CLAIMING). A plugin may take ownership of
		// this raw inbound BEFORE Brigade's access-control gate runs — the first
		// handler to return `{ handled: true }` claims it and we abandon the
		// inbound entirely (no gate, no command, no dispatch). Fires only when a
		// registry is mounted (gateway boot); a non-gateway path skips it.
		{
			const registry = getActiveRegistry();
			if (registry) {
				const claim = await registry.fireHook("inbound_claim", {
					channel: adapter.id,
					msg,
				});
				if (claim.handled) {
					log.debug("inbound claimed by plugin hook", {
						channel: adapter.id,
						conversationId: msg.conversationId,
						by: claim.by,
					});
					return;
				}
			}
		}

		// Access-control gate.
		const isGroup = msg.isGroup === true || msg.chatType === "group";
		// Central config-read policy (AUTHORITATIVE). A channel plugin MAY also
		// register a SUPPLEMENTARY security adapter; we consult it right here and
		// reconcile under a strict TIGHTEN-ONLY rule — the adapter can make the
		// effective DM policy stricter (owner-only > allowlist > open > the config)
		// but can NEVER loosen it, and a channel that doesn't opt in leaves
		// `dmPolicy` byte-identical to the local read. Never throws.
		const localDmPolicy = resolveDmPolicy(cfg, adapter.id);
		const dmPolicy = consultChannelDmPolicy({
			channelId: adapter.id,
			base: localDmPolicy,
			ctx: {
				account: undefined,
				accountId: msg.accountId?.trim() || "",
				cfg,
				...(msg.from?.trim() ? { peerId: msg.from.trim() } : {}),
				peerKind: isGroup ? "group" : "direct",
			},
		});
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
		const fromId = msg.from.trim();
		// On WhatsApp the bot runs AS the operator, so selfId === operator. On a
		// separate-bot channel (Telegram) the operator is the RECORDED owner —
		// established securely by the first CLI `pairing approve` (gateway-machine
		// access is the proof), NOT by anyone who merely texts /start.
		const isSelfOperator = !!(selfId && selfId.trim() === fromId);
		const channelOwner = readChannelOwner(adapter.id, aclAccountId);
		const senderIsOwner = isSelfOperator || (!!channelOwner && channelOwner === fromId);
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
		// The owner is ALWAYS admitted — skip the pairing/allowlist gate entirely
		// (covers the just-claimed Telegram owner, whose id isn't selfId).
		const decision: AccessDecision = senderIsOwner
			? { kind: "allow", reason: "owner" }
			: evaluateAccess({
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
					channelId: adapter.id,
					channelLabel: adapter.label,
					idLabel: adapter.pairing?.idLabel,
				}),
				// Genuine reply-to-inbound: quote the message that triggered the
				// challenge so the requester sees what they're being asked to verify.
				buildSendOpts(msg.threadId, msg.accountId, msg.messageId),
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
		// Inline-button approval callback (BEFORE the text-reply path).
		// A native button press (Telegram callback_query, etc.) arrives as
		// `msg.callbackQuery` and usually carries NO text, so it must be
		// consumed here, after the access gate admits the sender but before the
		// `if (!text) return;` empty-text bail below would silently drop it.
		// Decode then resolve the SAME approval bridge centrally; authorization
		// is routed through the channel's own `authorizeApprover` so a
		// non-operator press is refused centrally.
		if (msg.callbackQuery) {
			const capAuthorize = adapter.approvalCapability?.authorizeApprover;
			const authorizeApprover = capAuthorize
				? (p: { accountId?: string; senderId?: string; approvalKind: "exec" | "plugin" }) =>
						capAuthorize({
							cfg,
							...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
							...(p.senderId !== undefined ? { senderId: p.senderId } : {}),
							action: "approve" as const,
							approvalKind: p.approvalKind,
						})
				: undefined;
			const cbResult = tryConsumeChannelApprovalCallback({
				channelId: adapter.id,
				conversationId: msg.conversationId,
				callbackData: msg.callbackQuery.data,
				...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
				...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
				...(msg.from !== undefined ? { senderId: msg.from } : {}),
				...(authorizeApprover ? { authorizeApprover } : {}),
			});
			if (cbResult.matched) {
				const ack =
					cbResult.decision === "allow-once"
						? "Allowed once. 🦁"
						: cbResult.decision === "allow-always"
							? "Allowed and saved to the allowlist. 🦁"
							: "Denied. 🦁";
				await safeSendText(adapter, msg.conversationId, ack, buildSendOpts(msg.threadId, msg.accountId));
				return;
			}
			if (cbResult.refused) {
				await safeSendText(
					adapter,
					msg.conversationId,
					cbResult.reason ?? "Not authorized to answer that approval.",
					buildSendOpts(msg.threadId, msg.accountId),
				);
				return;
			}
			// GENERAL (agent-attached) button: not an approval. Decode the
			// app-defined token and route it through the pipeline as a synthetic
			// turn so the agent that attached the button can react to the tap.
			// We rewrite `msg.text` and FALL THROUGH to the normal routing +
			// dispatch path below (instead of returning).
			if (isGeneralCallbackData(msg.callbackQuery.data)) {
				const token = decodeGeneralCallbackData(msg.callbackQuery.data);
				if (token) {
					// Synthetic inbound text the agent sees for the tap. Kept short +
					// explicit so the agent can branch on the token it set.
					msg.text = `[button] ${token}`;
					// Clear the callbackQuery so the downstream path treats this as a
					// normal text turn (and doesn't re-enter this block).
					msg.callbackQuery = undefined;
					// fall through ↓
				} else {
					return;
				}
			} else {
				// A callback that matched no pending approval (stale / foreign
				// button) is dropped silently, there is nothing to dispatch.
				return;
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
		// Audio/voice attachments are TRANSCRIBED (when a provider is configured) and the
		// transcript is folded into the note, so the agent reads what was said AND the existing
		// post-turn extraction captures it as memory. Best-effort — falls back to a path stub
		// on any failure, so a flaky STT provider can't break ingest. (See media-capture.ts.)
		const mediaNote =
			msg.media && msg.media.length > 0
				? await buildMediaNote(msg.media, { registry: getActiveRegistry(), config: cfg })
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
		// INBOUND conversation resolution (the inverse of the outbound
		// `resolveOutboundTarget`): canonicalise the incoming peer id via the
		// channel's registered `messaging` adapter so a name-addressed inbound
		// collapses onto the SAME conversation/session outbound resolves to. When
		// the channel doesn't opt in, this returns `msg.from` unchanged, so the
		// config-link resolve + routing below are byte-identical to before.
		const inboundPeerId = resolveInboundConversation({ channelId: adapter.id, peerId: msg.from });
		const canonicalPeerId =
			resolveLinkedPeerIdFromConfig({
				config: cfg,
				channel: adapter.id,
				peerId: inboundPeerId,
			}) ?? inboundPeerId;
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
		// Plugin hook: `before_dispatch` (CLAIMING). A plugin may claim the turn
		// just before it dispatches to the agent — claim → skip dispatch entirely
		// (no reply). Fired for the immediate path here; the debounced path fires
		// the same hook inside `flushDispatch` before its own dispatch.
		{
			const registry = getActiveRegistry();
			if (registry) {
				const claim = await registry.fireHook("before_dispatch", {
					channel: adapter.id,
					agentId: resolvedAgentId,
					sessionKey,
					text,
					conversationId: msg.conversationId,
					...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
					...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
				});
				if (claim.handled) {
					log.debug("dispatch claimed by plugin hook", {
						channel: adapter.id,
						conversationId: msg.conversationId,
						by: claim.by,
					});
					return;
				}
			}
		}
		// Immediate dispatch. Pass the inbound's id as the reply target so the
		// agent's answer NATIVELY quotes the message it answers.
		await dispatchTurn(ctx, {
			text,
			sessionKey,
			agentId: resolvedAgentId,
			conversationId: msg.conversationId,
			...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
			...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
			...(msg.messageId !== undefined ? { replyToId: msg.messageId } : {}),
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
			/**
			 * Channel-native id of the inbound message this turn answers. When
			 * present it is threaded into every reply send below (stream open,
			 * reasoning, final answer) so the reply NATIVELY quotes the message it
			 * answers. Undefined → no quote (byte-identical to before).
			 */
			replyToId?: string;
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
		// Live-streaming: if the adapter advertises `beginReplyStream` AND it
		// returns a stream (the adapter gates on its own config), open it and
		// feed the gateway's accumulating answer text into it as tokens arrive.
		// The stream is best-effort UX — the FINAL reply below is still sent
		// authoritatively (or skipped when the stream already delivered it).
		let replyStream: ReturnType<NonNullable<ChannelAdapter["beginReplyStream"]>> = null;
		if (typeof c.adapter.beginReplyStream === "function") {
			try {
				replyStream = c.adapter.beginReplyStream(
					a.conversationId,
					buildSendOpts(a.threadId, a.accountId, a.replyToId),
				);
			} catch {
				replyStream = null;
			}
		}
		// Only forward deltas when a stream is actually open; the sink sanitizes
		// upstream, but a closed/aborted stream must drop late deltas.
		const onReplyDelta = replyStream
			? (text: string) => {
					if (controller.signal.aborted) return;
					try {
						replyStream?.update(text);
					} catch {
						/* stream hiccup never breaks the turn */
					}
				}
			: undefined;
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
				...(onReplyDelta ? { onReplyDelta } : {}),
			});
		} catch (err) {
			replyStream?.stop();
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
		if (controller.signal.aborted) {
			replyStream?.stop();
			return;
		}
		const reply = sanitizeReplyForChannel(result.reply?.trim() ?? "");
		if (reply) {
			// Reasoning lane (OPTIONAL, default OFF): when the adapter opts in, hand
			// it the RAW reply so it can deliver a `<think>` trace as a separate
			// prefixed message BEFORE the answer. The adapter gates on its own
			// config; a no-op adapter (or disabled config) sends nothing. Runs for
			// BOTH streaming + non-streaming paths so reasoning always precedes the
			// answer. Best-effort — never blocks the answer below.
			if (typeof c.adapter.deliverReasoning === "function") {
				try {
					await c.adapter.deliverReasoning(
						a.conversationId,
						result.reply ?? "",
						buildSendOpts(a.threadId, a.accountId, a.replyToId),
					);
				} catch (err) {
					log.warn("deliverReasoning failed (non-fatal)", {
						channel: c.adapter.id,
						conversationId: a.conversationId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			// STREAMING path: when a live stream is open, FINALIZE it with the
			// complete reply (it edits the in-progress message to the full text +
			// rolls overflow into new messages). This replaces the single
			// `sendText` below — the stream is now authoritative for delivery.
			if (replyStream) {
				try {
					const sent = await replyStream.finalize(reply);
					recordLastSentMessage({
						agentId: a.agentId,
						channelId: c.adapter.id,
						conversationId: a.conversationId,
						messageId: sent && typeof sent === "object" ? sent.messageId : undefined,
						...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
						...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
					});
					return;
				} catch (err) {
					// Stream finalize failed — fall through to the non-streaming
					// sendText so the recipient still gets the complete reply.
					log.warn("reply stream finalize failed; falling back to sendText", {
						channel: c.adapter.id,
						conversationId: a.conversationId,
						error: err instanceof Error ? err.message : String(err),
					});
					try {
						replyStream.stop();
					} catch {
						/* best-effort */
					}
				}
			}
			// Plugin hook: `reply_dispatch` (CLAIMING). A plugin may suppress /
			// take over the outgoing reply just before it is sent — if a handler
			// claims (`{ handled: true }`), it owns delivery and Brigade does NOT
			// call its own `sendText` (and records no last-sent message). Fires
			// only when a registry is mounted.
			const replyRegistry = getActiveRegistry();
			if (replyRegistry) {
				const claim = await replyRegistry.fireHook("reply_dispatch", {
					channel: c.adapter.id,
					agentId: a.agentId,
					conversationId: a.conversationId,
					reply,
					...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
					...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
				});
				if (claim.handled) {
					log.debug("reply suppressed by plugin hook", {
						channel: c.adapter.id,
						conversationId: a.conversationId,
						by: claim.by,
					});
					return;
				}
			}
			// Capture the sent id (additive `{ messageId }` return) so the agent
			// can later reference "my last message" via `message_action` without
			// having to track ids itself. Channels that return void simply leave
			// the last-sent record unset.
			const sent = await c.adapter.sendText(
				a.conversationId,
				reply,
				buildSendOpts(a.threadId, a.accountId, a.replyToId),
			);
			recordLastSentMessage({
				agentId: a.agentId,
				channelId: c.adapter.id,
				conversationId: a.conversationId,
				messageId: sent && typeof sent === "object" ? sent.messageId : undefined,
				...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
				...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
			});
			// Plugin hook: `message_sent` (VOID) — fire-and-forget telemetry after a
			// reply lands. Awaited (so a handler's async work is flushed) but the
			// result is ignored; void handlers can never alter or block delivery.
			if (replyRegistry) {
				await replyRegistry.fireHook("message_sent", {
					channel: c.adapter.id,
					agentId: a.agentId,
					conversationId: a.conversationId,
					text: reply,
					messageId: sent && typeof sent === "object" ? sent.messageId : undefined,
					...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
					...(a.accountId !== undefined ? { accountId: a.accountId } : {}),
				});
			}
		} else {
			// No reply text but a stream may have been opened (and possibly already
			// sent a placeholder) — stop it so it doesn't leak.
			replyStream?.stop();
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
		// Coalesced turn: quote the FIRST message of the debounce window (the one
		// that opened the slot) as the reply target.
		const replyToId = slot.baseMsg.messageId;
		// Plugin hook: `before_dispatch` (CLAIMING) — debounced path. Same hook
		// as the immediate path above; a claim here skips the coalesced dispatch.
		{
			const registry = getActiveRegistry();
			if (registry) {
				const claim = await registry.fireHook("before_dispatch", {
					channel: c.adapter.id,
					agentId: slot.agentId,
					sessionKey: slot.sessionKey,
					text: combined,
					conversationId,
					...(threadId !== undefined ? { threadId } : {}),
					...(accountId !== undefined ? { accountId } : {}),
				});
				if (claim.handled) {
					log.debug("debounced dispatch claimed by plugin hook", {
						channel: c.adapter.id,
						conversationId,
						by: claim.by,
					});
					return;
				}
			}
		}
		try {
			await dispatchTurn(c, {
				text: combined,
				sessionKey: slot.sessionKey,
				agentId: slot.agentId,
				conversationId,
				...(threadId !== undefined ? { threadId } : {}),
				...(accountId !== undefined ? { accountId } : {}),
				...(replyToId !== undefined ? { replyToId } : {}),
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
