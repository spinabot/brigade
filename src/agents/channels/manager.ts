/**
 * Channel manager — boots configured channels and wires inbound → turn → reply.
 *
 * The gateway owns exactly one of these. At boot it hands over the channel
 * adapters the extension registry collected, plus a `runTurn` that funnels
 * through the gateway's serialized turn queue (so a channel turn never overlaps
 * a TUI turn or another channel turn). For each configured channel the manager:
 *   1. starts the adapter, giving it an `onInbound` callback;
 *   2. on every inbound message, runs an agent turn keyed by the conversation;
 *   3. sends the reply back through the same adapter.
 *
 * Failure isolation: a channel that fails to start is logged and skipped (the
 * others still come up); an inbound message that throws is logged and dropped
 * (the channel stays connected). Nothing here can crash the gateway.
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { BrigadeConfig } from "../../config/io.js";
import type { ChannelAdapter, ChannelCommand, ChannelStartContext, InboundMessage } from "../extensions/types.js";
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
import {
	type ChannelApprovalRoute,
	registerChannelApprovalDispatcher,
	removeChannelApprovalDispatcher,
	tryConsumeChannelApprovalReply,
} from "./approval-router.js";
import { recordLastChannelForAgent } from "./last-channel.js";
import { channelSessionKey } from "./session-key.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveLinkedPeerIdFromConfig } from "../identity-links.js";
import { sanitizeReplyForChannel } from "./reply-sanitizer.js";
import { classifyErrorReason, isBrigadeRetryError } from "../error-classifier.js";
import { isRetryExhaustedError } from "../retry-policy.js";

const log = createSubsystemLogger("channels/manager");

/**
 * Pairing-challenge grace window for queued-during-downtime DMs.
 *
 * After Brigade reconnects, the platform replays every inbound it queued while
 * we were offline. Without this guard, every stranger who DM'd during that
 * window would get a pairing code in a burst — looks like spam and trips
 * anti-abuse on some channels. Messages stamped MORE than this many ms
 * before our latest connection are treated as history: we still record the
 * pairing request so the operator can approve by code, but we don't send the
 * stranger a reply. 30s is the same grace window the reference implementation
 * uses; tuned to be larger than typical clock skew but small enough that a
 * stranger who messaged ~10s before our restart still gets a live reply.
 */
const PAIRING_REPLY_HISTORY_GRACE_MS = 30_000;

/** Per-channel access-control config (DM + group policy + declarative allow-from). */
interface ChannelAccessConfig {
	dmPolicy?: string;
	groupPolicy?: string;
	allowFrom?: string[];
	groupAllowFrom?: string[];
	/**
	 * When >0, coalesce inbound messages from the same conversation that arrive
	 * within this window into ONE agent turn. Off by default (every message
	 * triggers a turn) — turn on for chatty users to save tokens. Recommended
	 * range: 800-2000ms.
	 */
	debounceMs?: number;
}
function channelAccessCfg(cfg: BrigadeConfig, channelId: string): ChannelAccessConfig {
	return (cfg as { channels?: Record<string, ChannelAccessConfig> }).channels?.[channelId] ?? {};
}
function isValidPolicy(s: unknown): s is DmPolicy {
	return s === "open" || s === "disabled" || s === "allowlist" || s === "pairing";
}
/** Resolve `channels.<id>.dmPolicy` from config; defaults to "pairing" (safe). */
function resolveDmPolicy(cfg: BrigadeConfig, channelId: string): DmPolicy {
	const raw = channelAccessCfg(cfg, channelId).dmPolicy;
	return isValidPolicy(raw) ? raw : "pairing";
}
/** Resolve `channels.<id>.groupPolicy`; falls back to "allowlist" (groups are stricter than DMs). */
function resolveGroupPolicy(cfg: BrigadeConfig, channelId: string): DmPolicy {
	const raw = channelAccessCfg(cfg, channelId).groupPolicy;
	return isValidPolicy(raw) ? raw : "allowlist";
}
/** Sanitize a config-supplied id list (drop empties, normalize whitespace). */
function configIds(list: string[] | undefined): string[] {
	return (list ?? []).map((x) => String(x).trim()).filter(Boolean);
}

/**
 * Build a human-readable failure reply for a channel recipient. Classifies the
 * underlying error into one of the policy categories and renders a sentence
 * the recipient can act on. Falls back to a polite generic message when the
 * classifier can't pin the cause down.
 *
 * Deliberately framed for the *recipient* (a friend / coworker DMing the bot),
 * not the operator: it never names model ids, providers, HTTP statuses, or
 * stack frames. The operator sees those in the gateway log; the recipient
 * sees a clean human sentence.
 */
function buildOperatorFacingErrorReply(err: unknown): string {
	// Reason resolution prefers (in order): the structured `BrigadeRetryError`
	// carrying `.reason`, then `RetryExhaustedError` carrying `.lastReason`
	// (the retry-loop's final classification), then a re-classification of
	// the raw error walking `.cause` recursively. Without the
	// `isRetryExhaustedError` branch, a 402 OpenRouter billing error wrapped
	// in a retry-exhausted shell was being classified as `unknown` and
	// recipients got the generic apology instead of the "out of credits"
	// message — that's the user-reported regression this branch fixes.
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

/**
 * The challenge reply addresses a non-technical recipient on the other side of
 * a private B2B assistant. Tone: friendly, polished, zero jargon. Emojis are
 * used as section anchors only (not littered) so the message scans cleanly
 * in WhatsApp/Slack/Telegram. The code and CLI command sit in monospace blocks
 * so they're visually distinct and copy-pastable.
 *
 * Channel-aware wording: when the adapter's `pairing.idLabel` is set, the
 * label follows it explicitly (`"phone"` → "Your number", `"username"` →
 * "Your username", `"account"` → "Your account"). When the adapter has no
 * pairing slot, falls back to the legacy heuristic (mostly-digits → phone,
 * else account).
 */
type PairingIdLabel = "phone" | "username" | "account";

/** Legacy heuristic — used when the adapter declares no `pairing.idLabel`. */
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
		// Operators DM the bot with formatted numbers (`+1 555-000-0001`);
		// strip non-digits and re-prefix with `+` so the line looks like
		// the canonical international form.
		const digits = senderId.replace(/\D/g, "");
		const rendered = digits.length >= 7 ? `+${digits}` : senderId;
		return `📞  *Your number:*  ${rendered}`;
	}
	if (resolved === "username") return `@  *Your username:*  ${senderId}`;
	return `👤  *Your account:*  ${senderId}`;
}

function buildChallengeReply(args: { code: string; senderId: string; channelLabel: string; idLabel?: PairingIdLabel }): string {
	void args.channelLabel; // reserved for future per-channel salutation variants
	// WhatsApp formatting cheat-sheet used here:
	//   *Word*       → bold
	//   _Word_       → italic
	//   ```…```      → monospace code block (code + CLI sit inside these so
	//                  they read as distinct, copy-pastable artifacts)
	//   ━━━━…        → renders as a thin horizontal divider in every modern
	//                  client; the cheapest "card-like" visual separation
	// `markdownToWhatsApp` deliberately leaves single-asterisk bold, single-
	// underscore italic, and backticks untouched, so this passes through.
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

/**
 * Built-in channel commands an operator can DM the bot to admin it without
 * leaving chat: `/help`, `/status`, `/allowlist [list|add|remove]`. Bound
 * per-adapter so `selfId()` and access-control state are correct.
 *
 * Authorization: `/allowlist` is operator-only (sender must equal the channel's
 * linked self-id). `/help` and `/status` are info-only and unauthenticated.
 */
function buildBundledCommands(adapter: ChannelAdapter): ChannelCommand[] {
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
					// Per-channel normalization — adapter may strip an `@` prefix
					// or `<@U…>` mention syntax before the entry is persisted.
					// Channels without `pairing.normalizeAllowEntry` see identity.
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
	];
}

/** Result of running one agent turn — only the reply text matters to a channel. */
export interface ChannelTurnResult {
	reply: string;
}

export interface StartChannelsArgs {
	/** Channel adapters collected from the extension registry. */
	adapters: ChannelAdapter[];
	/** The active Brigade config (channel adapters read their settings from it). */
	config: BrigadeConfig;
	/** Agent id whose workspace + transcripts these conversations belong to. */
	agentId: string;
	/**
	 * Run one agent turn. The gateway supplies this bound to its serialized turn
	 * queue, so channel turns interleave safely with TUI turns. Resolves with the
	 * reply text to send back to the conversation.
	 */
	runTurn: (args: {
		text: string;
		sessionKey: string;
		/**
		 * Agent id this turn routes to. Multi-agent gateways resolve this
		 * per-inbound via the 8-tier route resolver; single-agent gateways
		 * supply `args.agentId` (the fallback default). Channels that want
		 * the inbound to run as a specific agent — e.g. operator binds
		 * `whatsapp:+91…` to `agent:ops` — let the resolver pick `"ops"`
		 * here so the agent-loop loads ops's workspace + model + persona.
		 */
		agentId: string;
		signal?: AbortSignal;
		/**
		 * `true` when the inbound came from the operator's OWN linked-channel
		 * id (self-chat or — for groups — a self-mention). `false` for every
		 * approved peer. Used by the agent loop to suppress the operator-
		 * onboarding bootstrap nudge for non-owners.
		 */
		senderIsOwner?: boolean;
		/**
		 * Channel routing for approval prompts. When set, the exec-gate
		 * routes "want to run <command>?" prompts INTO this conversation
		 * instead of (only) the gateway WS — the operator on WhatsApp /
		 * Slack / Discord sees the prompt where they're already chatting,
		 * and the next inbound from the same peer ("yes" / "no") resolves
		 * the approval. Always set for channel-routed inbounds (the channel
		 * manager populates it from `adapter.id` + `conversationId` +
		 * `threadId`); never set for TUI / sub-agent / cron turns.
		 */
		channelApprovalRoute?: ChannelApprovalRoute;
	}) => Promise<ChannelTurnResult>;
	/** Channel commands (`/name`) handled before the LLM. */
	commands?: ChannelCommand[];
	/** Injected env for gating (tests); defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Surface a pairing code / QR to the operator (e.g. WhatsApp first-link). */
	onPairing?: (channelId: string, info: { kind: "qr" | "code"; value: string }) => void;
}

export interface ChannelManager {
	/** Ids of channels that started successfully. */
	readonly started: string[];
	/** Stop every started channel + abort their listeners. Idempotent. */
	stop(): Promise<void>;
	/**
	 * Look up a started channel adapter by id. Returns `undefined` when the
	 * channel never started (config disabled, env missing, start threw).
	 * Used by the cron service to fan out announce deliveries through the
	 * channel that originally took the add-cron message.
	 */
	adapter(id: string): ChannelAdapter | undefined;
}

/**
 * Start every configured channel adapter. Returns a handle whose `stop()` tears
 * them all down. Channels that aren't configured (missing keys/settings) are
 * skipped silently — only configured channels spin up a listener.
 */
export async function startChannels(args: StartChannelsArgs): Promise<ChannelManager> {
	const env = args.env ?? process.env;
	const abort = new AbortController();
	const started: { id: string; adapter: ChannelAdapter }[] = [];
	// User-registered commands (from `b.channelCommand(...)`) — global across
	// adapters. Bundled commands (`/help`, `/status`, `/allowlist`) are layered
	// per-adapter inside the loop below so they can close over `adapter.selfId()`.
	const userCommands = args.commands ?? [];
	// Per-conversation AbortControllers for in-flight turns — used so a sender
	// can DM "stop" / "cancel" / "/stop" to kill a long-running turn. Stays
	// inside one channel manager (each conversation has at most one active
	// turn at a time, gated by the gateway's serialized turn queue).
	const inflight = new Map<string, AbortController>();
	// Pending debounce slots — accumulated text waiting to be dispatched. One
	// slot per conversation. Off by default (`channels.<id>.debounceMs <= 0`).
	interface PendingDispatch {
		timer: ReturnType<typeof setTimeout>;
		parts: string[];
		baseMsg: InboundMessage;
		sessionKey: string;
		/** Resolved agent id for this inbound (route-resolver output, falls
		 *  back to `args.agentId` when no binding matches). Carried through
		 *  the debounce so the eventual turn uses the same agent. */
		agentId: string;
		/** Cached `senderIsOwner` from when the slot was opened — carried into
		 *  the eventual dispatch so the agent loop's bootstrap gate works
		 *  even across the debounce window. */
		senderIsOwner: boolean;
		/** Cached channel-approval route — carried through the debounce so a
		 *  gated tool call inside the eventual turn still routes its prompt
		 *  back to THIS conversation. */
		channelApprovalRoute: ChannelApprovalRoute;
	}
	const pendingDispatches = new Map<string, PendingDispatch>();

	for (const adapter of args.adapters) {
		// Gate: required env present AND the adapter says it's configured.
		const envMissing = adapter.requiresEnv?.some((v) => !env[v] || env[v]?.trim() === "");
		if (envMissing) {
			log.info("channel skipped — required env missing", { channel: adapter.id, requiresEnv: adapter.requiresEnv });
			continue;
		}
		let configured = false;
		try {
			configured = adapter.isConfigured(args.config, env);
		} catch (err) {
			log.warn("channel isConfigured threw — skipping", {
				channel: adapter.id,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		if (!configured) {
			log.info("channel skipped — not configured", { channel: adapter.id });
			continue;
		}

		// Per-adapter command map: user-registered commands + bundled
		// `/help` `/status` `/allowlist`. Bundled commands win on collision so an
		// operator can always reach `/help` even if a user module shadowed it.
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of userCommands) commandMap.set(c.name.toLowerCase(), c);
		for (const c of buildBundledCommands(adapter)) commandMap.set(c.name.toLowerCase(), c);

		/**
		 * Run one agent turn, handle the abort-signal lifecycle, and reply.
		 * Extracted so both the immediate-dispatch path and the debounce
		 * `flushDispatch` can share identical behavior. `threadId` is the
		 * Slack/Discord thread routing hint carried through to `sendText`;
		 * channels without threading silently ignore it.
		 */
		const dispatchTurn = async (a: {
			text: string;
			sessionKey: string;
			agentId: string;
			conversationId: string;
			threadId?: string;
			senderIsOwner?: boolean;
			channelApprovalRoute?: ChannelApprovalRoute;
		}): Promise<void> => {
			const controller = new AbortController();
			inflight.set(a.conversationId, controller);
			// Show "typing…" while the LLM thinks — fires HERE (and not earlier)
			// so abort triggers and channel commands don't briefly flash it.
			// Cosmetic — failures are swallowed.
			if (adapter.setComposing) {
				try {
					await adapter.setComposing(a.conversationId, "composing");
				} catch {
					/* cosmetic */
				}
			}
			let result: ChannelTurnResult;
			try {
				result = await args.runTurn({
					text: a.text,
					sessionKey: a.sessionKey,
					agentId: a.agentId,
					signal: controller.signal,
					senderIsOwner: a.senderIsOwner,
					...(a.channelApprovalRoute !== undefined
						? { channelApprovalRoute: a.channelApprovalRoute }
						: {}),
				});
			} finally {
				if (inflight.get(a.conversationId) === controller) inflight.delete(a.conversationId);
				// Clear the typing indicator no matter how the turn ended.
				if (adapter.setComposing) {
					try {
						await adapter.setComposing(a.conversationId, "paused");
					} catch {
						/* cosmetic */
					}
				}
			}
			if (controller.signal.aborted) return; // operator already saw "Stopped."
			// Strip `<think>…</think>` reasoning blocks BEFORE sending. WhatsApp/
			// Slack/Telegram clients render the raw XML tags to the recipient,
			// which leaks the model's internal monologue and looks broken. The
			// TUI handles reasoning in its own folded-panel renderer; channels
			// see only the final answer.
			const reply = sanitizeReplyForChannel(result.reply?.trim() ?? "");
			if (reply) {
				// Thread-aware outbound: when the inbound carried a `threadId`
				// (Slack thread_ts, Discord thread id, Telegram topic), pass it
				// through so the reply lands in the same thread instead of the
				// channel root. Channels without threading silently ignore
				// `opts.threadId`.
				await adapter.sendText(
					a.conversationId,
					reply,
					a.threadId ? { threadId: a.threadId } : undefined,
				);
			}
		};

		/**
		 * Flush a pending debounce slot — combine parts, dispatch. `dispatchKey`
		 * is the map key (`conversationId` for DMs, `conversationId#senderId`
		 * for group rooms); we read the slot, then dispatch to the slot's
		 * actual `baseMsg.conversationId` so the reply lands in the room.
		 */
		const flushDispatch = async (dispatchKey: string): Promise<void> => {
			const slot = pendingDispatches.get(dispatchKey);
			if (!slot) return;
			pendingDispatches.delete(dispatchKey);
			const combined = slot.parts.join("\n\n");
			const conversationId = slot.baseMsg.conversationId;
			const threadId = slot.baseMsg.threadId;
			try {
				await dispatchTurn({
					text: combined,
					sessionKey: slot.sessionKey,
					agentId: slot.agentId,
					conversationId,
					threadId,
					senderIsOwner: slot.senderIsOwner,
					channelApprovalRoute: slot.channelApprovalRoute,
				});
			} catch (err) {
				log.warn("debounced dispatch failed", {
					channel: adapter.id,
					conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
				try {
					// Reuse the error-class-aware reply so the recipient sees the
					// same friendly billing/auth/rate-limit messaging across both
					// the immediate and the debounced dispatch paths.
					await adapter.sendText(
						conversationId,
						buildOperatorFacingErrorReply(err),
						threadId ? { threadId } : undefined,
					);
				} catch {
					/* best-effort */
				}
			}
		};

		const ctx: ChannelStartContext = {
			signal: abort.signal,
			log: (msg, meta) => log.info(`[${adapter.id}] ${msg}`, meta),
			onPairing: args.onPairing ? (info) => args.onPairing?.(adapter.id, info) : undefined,
			onInbound: async (msg: InboundMessage) => {
				try {
					// Surface attached media + quoted-reply context as plain-text notes
					// prepended to the user's text; the agent's `read` tool can open
					// any media path. Keeps the manager LLM-shape-agnostic until the
					// per-agent contract grows real attachment/threading slots.
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
					if (!text) return; // truly nothing to answer (system event with no media + no text)
					// ── Access control gate (runs BEFORE channel commands + LLM) ──
					// Default policy is `pairing` for DMs (stranger → pairing code).
					// Groups default to `allowlist` + require an @-mention — that way a
					// bot in a 50-member group doesn't answer every line of chat.
					// Declarative `channels.<id>.allowFrom`/`.groupAllowFrom` from
					// brigade.json merges with the on-disk store, so an operator can
					// pre-allow themselves before the gateway ever runs.
					const isGroup = msg.isGroup === true || msg.chatType === "group";
					const dmPolicy = resolveDmPolicy(args.config, adapter.id);
					const groupPolicy = resolveGroupPolicy(args.config, adapter.id);
					const cfgEntry = channelAccessCfg(args.config, adapter.id);
					// Allow-from sources merge: config (declarative `allowFrom`) +
					// persisted store (where `pairing approve` and `allow add`
					// write). Reference behaviour: `allowlist` mode IGNORES the
					// persisted store — only the declarative `allowFrom` from
					// config counts. The reasoning: `allowlist` is the strict
					// "operator hand-curates this list" mode; a pairing approval
					// shouldn't auto-bypass it. `pairing` mode is the opt-in
					// "anyone can request, operator approves" mode and merges
					// both. (`open` / `disabled` skip the list entirely below.)
					const storeAllow = dmPolicy === "allowlist" ? [] : readAllowFrom(adapter.id);
					const allowFrom = [
						...new Set([...storeAllow, ...configIds(cfgEntry.allowFrom)]),
					];
					const groupAllowFrom = [
						...new Set([...readGroupAllowFrom(adapter.id), ...configIds(cfgEntry.groupAllowFrom)]),
					];
					const selfId = adapter.selfId?.();
					const mentioned = !!(selfId && msg.mentions?.includes(selfId));
					// `senderIsOwner` says whether this inbound came from the
					// operator's own linked-channel id (a self-chat DM, or the
					// operator typing on a linked device into a group/peer DM
					// — though `fromMe + !selfChat` is already dropped earlier
					// in connection.ts). The agent loop uses this to gate the
					// BOOTSTRAP "who am I / who are you" onboarding nudge: that
					// ritual is operator-only; approved peers must never see it.
					const senderIsOwner = !!(selfId && selfId.trim() === msg.from.trim());
					const decision = evaluateAccess({
						policy: dmPolicy,
						groupPolicy,
						senderId: msg.from,
						selfId,
						allowFrom,
						groupAllowFrom,
						isGroup,
						mentioned,
					});
					if (decision.kind === "block") {
						log.info("inbound dropped by policy", {
							channel: adapter.id,
							sender: msg.from,
							reason: decision.reason,
						});
						return; // no read receipt, no composing — stranger doesn't see the bot
					}
					if (decision.kind === "challenge") {
						// `msg.from` is the canonical phone (already LID-resolved in the
						// adapter). If it's empty we DROP — pairing requests keyed on a
						// conversationId masquerading as a phone would corrupt the
						// allow-list and never match a real `pairing approve` lookup.
						const challengeSenderId = msg.from?.trim();
						if (!challengeSenderId) {
							log.warn("inbound dropped — no usable sender id for challenge", {
								channel: adapter.id,
								conversationId: msg.conversationId,
							});
							return;
						}
						// Pairing-grace window — if the inbound was platform-stamped
						// BEFORE the channel's most recent connection (minus a 30s
						// jitter buffer), treat it as queued-during-downtime history
						// and suppress the REPLY. We still record the pairing
						// request so an operator can approve by code later, but we
						// don't burst-spam strangers the moment Brigade reconnects.
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
						});
						log.info("issued pairing challenge", {
							channel: adapter.id,
							sender: challengeSenderId,
							isNew,
							skipReply: isHistorical || !isNew,
						});
						// Reply ONLY on first sight. If the stranger already has a
						// pending code (isNew=false) every subsequent message would
						// otherwise re-send the same challenge card — turning a
						// stranger's normal chat into a wall of identical "your
						// one-time code" replies. Same shape as the upstream reference's
						// upstream `issuePairingChallenge` (bails when `!created`). The
						// upsertPairingRequest above already RECORDED the request
						// so the operator can still approve via the CLI; we're just
						// not spamming the stranger with duplicates.
						if (isHistorical || !isNew) return;
						await adapter.sendText(
							msg.conversationId,
							buildChallengeReply({
								code,
								senderId: challengeSenderId,
								channelLabel: adapter.label,
								idLabel: adapter.pairing?.idLabel,
							}),
							msg.threadId ? { threadId: msg.threadId } : undefined,
						);
						// Mark the stranger's challenge message as read — they've now
						// seen our reply, so the blue tick is honest. Best-effort.
						if (msg.messageId && adapter.markRead) {
							try {
								await adapter.markRead(msg.conversationId, msg.messageId, msg.participantId);
							} catch {
								/* cosmetic */
							}
						}
						return;
					}
					// decision.kind === "allow" — engage. Mark read now so the sender
					// sees the bot acknowledged. Composing fires later, only when we
					// know we're about to call the LLM (not on abort triggers or
					// channel commands which complete instantly).
					if (msg.messageId && adapter.markRead) {
						try {
							await adapter.markRead(msg.conversationId, msg.messageId, msg.participantId);
						} catch {
							/* cosmetic */
						}
					}
					// Channel-routed approval reply intercept. When the previous
					// turn raised a gated tool (bash) and the exec-gate routed the
					// approval prompt INTO this conversation, the next inbound from
					// the same peer ("yes" / "always" / "no") settles the bridge
					// here — we never dispatch a fresh turn for that text. Runs
					// AFTER the access gate (only trusted peers can answer an
					// approval) and BEFORE the abort-trigger check (the abort
					// vocabulary overlaps "no"/"stop" — a pending-approval intent
					// wins because the operator is answering Brigade's question,
					// not cancelling a turn).
					const approvalIntercept = tryConsumeChannelApprovalReply({
						channelId: adapter.id,
						conversationId: msg.conversationId,
						text,
					});
					if (approvalIntercept.matched) {
						const ackThreadOpts = msg.threadId ? { threadId: msg.threadId } : undefined;
						const ack =
							approvalIntercept.decision === "allow-once"
								? "Allowed once. 🦁"
								: approvalIntercept.decision === "allow-always"
									? "Allowed and saved to the allowlist. 🦁"
									: "Denied. 🦁";
						try {
							await adapter.sendText(msg.conversationId, ack, ackThreadOpts);
						} catch {
							/* cosmetic */
						}
						return;
					}
					// decision.kind === "allow" → continue to channel commands + turn
					// Abort trigger ("stop" / "cancel" / "/stop" / multilingual variants)
					// — kill an in-flight turn for this conversation and acknowledge.
					// Recognized BEFORE channel commands so the operator can always
					// cancel even if the channel registered a "/stop" command.
					if (isAbortTrigger(text)) {
						// Cancel EVERY pending debounce slot for this conversation
						// (a group can have N slots, one per speaker — a single
						// "stop" should clear them all, not just the speaker's own).
						let cancelledAny = false;
						for (const [key, slot] of pendingDispatches) {
							if (slot.baseMsg.conversationId !== msg.conversationId) continue;
							clearTimeout(slot.timer);
							pendingDispatches.delete(key);
							cancelledAny = true;
						}
						const threadOpts = msg.threadId ? { threadId: msg.threadId } : undefined;
						const active = inflight.get(msg.conversationId);
						if (active || cancelledAny) {
							active?.abort();
							if (active) inflight.delete(msg.conversationId);
							await adapter.sendText(msg.conversationId, "Stopped.", threadOpts);
						} else {
							await adapter.sendText(msg.conversationId, "Nothing was running — try again with a fresh message.", threadOpts);
						}
						return;
					}
					// Channel command (`/name ...`) — handled before the LLM. Unknown
					// commands fall through to a normal turn so plain "/" text isn't eaten.
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
								config: args.config,
							};
							const threadOpts = msg.threadId ? { threadId: msg.threadId } : undefined;
							if (command.authorize && !command.authorize(cmdCtx)) {
								await adapter.sendText(msg.conversationId, "Not authorized to run that command.", threadOpts);
								return;
							}
							const out = await command.handler(cmdCtx);
							if (typeof out === "string" && out.trim()) await adapter.sendText(msg.conversationId, out.trim(), threadOpts);
							return; // command handled — no turn
						}
					}
					// Route the inbound through the 8-tier resolver to pick the
					// right agent. The resolver consults `cfg.bindings.entries[]`
					// in waterfall order (peer → peer-parent → guild+roles →
					// guild → team → account → channel → default) and falls back
					// to `args.agentId` if no binding matches. Multi-agent gateways
					// rely on this to dispatch e.g. WhatsApp DMs from `+919876…`
					// to `agent:ops` while Slack messages to `#engineering` go to
					// `agent:work`. Single-agent installs simply land on
					// `args.agentId` via the default tier.
					//
					// Account-id source: prefer the adapter-supplied `msg.accountId`
					// (set by multi-account adapters like WhatsApp personal+work);
					// fall back to `msg.conversationId` for single-account
					// adapters. Normalized to canonical form for cache + binding
					// match.
					const rawAccountId = msg.accountId?.trim() || msg.conversationId;
					const normalizedAccountId = normalizeAccountId(rawAccountId);
					const peerKind = isGroup ? "group" : "direct";
					// Cross-channel peer alias resolution (Step 5). If the operator
					// configured `session.identityLinks: { kartheek: ["whatsapp:+91…",
					// "telegram:111"] }`, the same human DMing from either channel
					// collapses to one canonical peer id (and therefore one
					// session). When no link matches, the raw `msg.from` is used.
					const canonicalPeerId =
						resolveLinkedPeerIdFromConfig({
							config: args.config,
							channel: adapter.id,
							peerId: msg.from,
						}) ?? msg.from;
					const route = resolveAgentRoute({
						cfg: args.config,
						channel: adapter.id,
						accountId: normalizedAccountId,
						peer: canonicalPeerId
							? { id: canonicalPeerId, kind: peerKind }
							: undefined,
						// Tiers 4-6 fields. Channel adapters populate these on
						// inbounds that originated from a guild/team — Discord
						// adapters fill `guildId` + `memberRoleIds`, Slack fills
						// `teamId`. Undefined for channels without these
						// concepts (WhatsApp, SMS, etc.), in which case the
						// resolver's `enabled` flag suppresses those tiers and
						// dispatch falls through to peer/account/channel/default.
						...(msg.guildId ? { guildId: msg.guildId } : {}),
						...(msg.teamId ? { teamId: msg.teamId } : {}),
						...(msg.memberRoleIds?.length
							? { memberRoleIds: msg.memberRoleIds }
							: {}),
					});
					const resolvedAgentId = route.agentId || args.agentId;
					// Debug log: which tier actually matched. Useful when an
					// operator's binding doesn't seem to fire — `route.matchedBy`
					// tells us whether peer/guild/team/account/channel/default
					// won the cascade. Always logged; cheap one-liner.
					log.debug("inbound routed", {
						channel: adapter.id,
						from: msg.from,
						agentId: resolvedAgentId,
						matchedBy: route.matchedBy,
					});
					// Session-key shape: respect `cfg.session.dmScope` when it's
					// set so an operator can opt into OC's per-peer /
					// per-channel-peer / per-account-channel-peer / main shapes.
					// Without a config opt-in, Brigade keeps its v1 per-
					// conversation `channelSessionKey()` shape (each conversation
					// gets its own JSONL transcript) — that's the default that
					// has shipped from day one.
					const sessionScopeCfg = (args.config as {
						session?: { dmScope?: string };
					}).session;
					const dmScope = sessionScopeCfg?.dmScope?.trim();
					const sessionKey =
						dmScope && dmScope !== "" && dmScope !== "default"
							? route.sessionKey || channelSessionKey(
									resolvedAgentId,
									adapter.id,
									msg.threadId
										? `${msg.conversationId}#${msg.threadId}`
										: msg.conversationId,
								)
							: channelSessionKey(
									resolvedAgentId,
									adapter.id,
									msg.threadId
										? `${msg.conversationId}#${msg.threadId}`
										: msg.conversationId,
								);
					// Channel routing for approval prompts — exec-gate sends "want
					// to run <cmd>?" prompts into THIS conversation instead of
					// (only) the gateway WS, and the next inbound from the same
					// peer ("yes" / "no") resolves the approval. Built once here
					// and threaded through both the debounce + immediate paths.
					const channelApprovalRoute: ChannelApprovalRoute = {
						channelId: adapter.id,
						conversationId: msg.conversationId,
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
					};
					// Pin THIS channel as the operator's most-recently-active so
					// a future cron firing with `delivery.mode:"announce"` but no
					// explicit channel target falls back to this peer. Only fires
					// for access-allowed inbounds (we're past the policy gate) so
					// a stranger DM can't accidentally redirect future crons.
					// Uses the RESOLVED agent id so multi-agent gateways pin the
					// last-channel per-agent (e.g. ops's last channel separately
					// from work's).
					recordLastChannelForAgent(resolvedAgentId, channelApprovalRoute);
					// Optional debounce — coalesce rapid-fire messages into a single
					// turn. Off by default (`channels.<id>.debounceMs <= 0` ⇒
					// immediate). For groups we key per-speaker so different
					// participants typing in the same room don't accidentally get
					// their distinct messages glued into one combined turn.
					const debounceMs = Math.max(0, Number(cfgEntry.debounceMs ?? 0)) | 0;
					if (debounceMs > 0) {
						const dispatchKey = isGroup ? `${msg.conversationId}#${msg.from}` : msg.conversationId;
						const existing = pendingDispatches.get(dispatchKey);
						if (existing) {
							clearTimeout(existing.timer);
							existing.parts.push(text);
							existing.timer = setTimeout(() => void flushDispatch(dispatchKey), debounceMs);
						} else {
							pendingDispatches.set(dispatchKey, {
								parts: [text],
								baseMsg: msg,
								sessionKey,
								agentId: resolvedAgentId,
								senderIsOwner,
								channelApprovalRoute,
								timer: setTimeout(() => void flushDispatch(dispatchKey), debounceMs),
							});
						}
						return;
					}
					// Immediate path: register the abort controller + run.
					await dispatchTurn({
						text,
						sessionKey,
						agentId: resolvedAgentId,
						conversationId: msg.conversationId,
						threadId: msg.threadId,
						senderIsOwner,
						channelApprovalRoute,
					});
				} catch (err) {
					// An inbound failure must never tear down the listener.
					const errMsg = err instanceof Error ? err.message : String(err);
					log.warn("inbound handling failed", {
						channel: adapter.id,
						conversationId: msg.conversationId,
						error: errMsg,
					});
					// Tell the sender what kind of trouble we hit. Classifying the
					// error means the recipient sees a useful message instead of a
					// generic "something broke" — out-of-credits, model busy, and
					// auth failures all look different to the end user.
					try {
						await adapter.sendText(
							msg.conversationId,
							buildOperatorFacingErrorReply(err),
							msg.threadId ? { threadId: msg.threadId } : undefined,
						);
					} catch (sendErr) {
						log.warn("failed to send error reply", {
							channel: adapter.id,
							conversationId: msg.conversationId,
							error: sendErr instanceof Error ? sendErr.message : String(sendErr),
						});
					}
				}
			},
		};

		try {
			await adapter.start(ctx);
			started.push({ id: adapter.id, adapter });
			// Register the adapter's outbound surface with the approval
			// router so a gated tool call inside a channel-routed turn can
			// surface its approval prompt INTO this conversation (instead
			// of vanishing into the gateway WS the operator isn't watching).
			// `sendText` is bound so the router doesn't need to capture
			// `adapter` itself (no leak if the adapter is later replaced).
			registerChannelApprovalDispatcher(adapter.id, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, opts),
				prettyName: adapter.label,
			});
			log.info("channel started", { channel: adapter.id, label: adapter.label });
		} catch (err) {
			log.warn("channel failed to start — skipping", {
				channel: adapter.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	let stopped = false;
	return {
		started: started.map((s) => s.id),
		adapter(id: string): ChannelAdapter | undefined {
			const entry = started.find((s) => s.id === id);
			return entry?.adapter;
		},
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			// Cancel any pending debounce slots so a flush can't fire post-stop.
			for (const slot of pendingDispatches.values()) clearTimeout(slot.timer);
			pendingDispatches.clear();
			abort.abort();
			for (const { id, adapter } of started) {
				// Drop the approval router's dispatcher BEFORE adapter.stop()
				// so an in-flight bridge can't ask a torn-down channel to send
				// a prompt mid-shutdown. The router also denies any pending
				// channel-routed approvals so callers don't wait the full
				// 5-minute timeout against a dead adapter.
				removeChannelApprovalDispatcher(id);
				try {
					await adapter.stop();
				} catch (err) {
					log.warn("channel stop failed", {
						channel: id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		},
	};
}
