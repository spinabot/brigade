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
import { channelSessionKey } from "./session-key.js";

const log = createSubsystemLogger("channels/manager");

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
 * The challenge reply addresses a non-technical recipient on the other side of
 * a private B2B assistant. Tone: friendly, polished, zero jargon. Emojis are
 * used as section anchors only (not littered) so the message scans cleanly
 * in WhatsApp/Slack/Telegram. The code and CLI command sit in monospace blocks
 * so they're visually distinct and copy-pastable.
 *
 * Channel-aware wording: numeric ids (phone numbers) get "Your number: +…";
 * other shapes (Slack `U01ABC`, Discord usernames) get "Your account: …".
 */
function senderLineFor(senderId: string): string {
	if (!senderId) return "👤  *Your account:*  (unknown)";
	// "Mostly digits" → display as a phone number. Operators DM the bot with
	// formatted numbers (`+1 555-000-0001`) too; only true non-numeric ids
	// (Slack `U01ABC`, Discord usernames) fall into the account branch.
	const digits = senderId.replace(/\D/g, "");
	const hasLetters = /[A-Za-z]/.test(senderId);
	if (!hasLetters && digits.length >= 7) return `📞  *Your number:*  +${digits}`;
	return `👤  *Your account:*  ${senderId}`;
}

function buildChallengeReply(args: { code: string; senderId: string; channelLabel: string }): string {
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
		"━━━━━━━━━━━━━━━━━━━━━━",
		"",
		"👋  *Welcome!*",
		"An administrator needs to approve your access before we can chat. It only takes a moment.",
		"",
		senderLineFor(args.senderId),
		"",
		"🔐  *Your one-time code*",
		"```",
		args.code,
		"```",
		"",
		"Share this code with the person who set up Brigade. They'll approve you by running:",
		"",
		"```",
		`brigade pairing approve ${args.code}`,
		"```",
		"",
		"✨  Once approved, send your next message and we're off.",
		"",
		"⏱️  _This code expires in 1 hour._",
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
					return addAllowFrom(ctx.channel, target)
						? `Added "${target}" to the allow-from list.`
						: `"${target}" was already on the list.`;
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
	runTurn: (args: { text: string; sessionKey: string; signal?: AbortSignal }) => Promise<ChannelTurnResult>;
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
		 * `flushDispatch` can share identical behavior.
		 */
		const dispatchTurn = async (a: { text: string; sessionKey: string; conversationId: string }): Promise<void> => {
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
				result = await args.runTurn({ text: a.text, sessionKey: a.sessionKey, signal: controller.signal });
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
			const reply = result.reply?.trim();
			if (reply) await adapter.sendText(a.conversationId, reply);
		};

		/** Flush a pending debounce slot — combine parts, dispatch. */
		const flushDispatch = async (conversationId: string): Promise<void> => {
			const slot = pendingDispatches.get(conversationId);
			if (!slot) return;
			pendingDispatches.delete(conversationId);
			const combined = slot.parts.join("\n\n");
			try {
				await dispatchTurn({ text: combined, sessionKey: slot.sessionKey, conversationId });
			} catch (err) {
				log.warn("debounced dispatch failed", {
					channel: adapter.id,
					conversationId,
					error: err instanceof Error ? err.message : String(err),
				});
				try {
					await adapter.sendText(
						conversationId,
						"Sorry, I hit an error processing that — please try again in a moment.",
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
					const allowFrom = [
						...new Set([...readAllowFrom(adapter.id), ...configIds(cfgEntry.allowFrom)]),
					];
					const groupAllowFrom = [
						...new Set([...readGroupAllowFrom(adapter.id), ...configIds(cfgEntry.groupAllowFrom)]),
					];
					const selfId = adapter.selfId?.();
					const mentioned = !!(selfId && msg.mentions?.includes(selfId));
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
						const { code, isNew } = upsertPairingRequest({
							channelId: adapter.id,
							senderId: challengeSenderId,
							senderName: msg.fromName,
						});
						log.info("issued pairing challenge", { channel: adapter.id, sender: challengeSenderId, isNew });
						await adapter.sendText(
							msg.conversationId,
							buildChallengeReply({ code, senderId: challengeSenderId, channelLabel: adapter.label }),
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
					// decision.kind === "allow" → continue to channel commands + turn
					// Abort trigger ("stop" / "cancel" / "/stop" / multilingual variants)
					// — kill an in-flight turn for this conversation and acknowledge.
					// Recognized BEFORE channel commands so the operator can always
					// cancel even if the channel registered a "/stop" command.
					if (isAbortTrigger(text)) {
						// Cancel any pending debounce slot too — a stop should erase
						// queued-but-not-yet-dispatched text, not let it slip through.
						const pending = pendingDispatches.get(msg.conversationId);
						if (pending) {
							clearTimeout(pending.timer);
							pendingDispatches.delete(msg.conversationId);
						}
						const active = inflight.get(msg.conversationId);
						if (active || pending) {
							active?.abort();
							if (active) inflight.delete(msg.conversationId);
							await adapter.sendText(msg.conversationId, "Stopped.");
						} else {
							await adapter.sendText(msg.conversationId, "Nothing was running — try again with a fresh message.");
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
							if (command.authorize && !command.authorize(cmdCtx)) {
								await adapter.sendText(msg.conversationId, "Not authorized to run that command.");
								return;
							}
							const out = await command.handler(cmdCtx);
							if (typeof out === "string" && out.trim()) await adapter.sendText(msg.conversationId, out.trim());
							return; // command handled — no turn
						}
					}
					// Thread-aware session key: when a channel carries a thread id
					// (Slack/Discord), scope the session per thread so a busy room
					// doesn't pool every thread's history into one transcript.
					const convScope = msg.threadId
						? `${msg.conversationId}#${msg.threadId}`
						: msg.conversationId;
					const sessionKey = channelSessionKey(args.agentId, adapter.id, convScope);
					// Optional debounce — coalesce rapid-fire DMs into a single turn.
					// Off by default (`channels.<id>.debounceMs <= 0` ⇒ immediate).
					const debounceMs = Math.max(0, Number(cfgEntry.debounceMs ?? 0)) | 0;
					if (debounceMs > 0) {
						const existing = pendingDispatches.get(msg.conversationId);
						if (existing) {
							clearTimeout(existing.timer);
							existing.parts.push(text);
							existing.timer = setTimeout(() => void flushDispatch(msg.conversationId), debounceMs);
						} else {
							pendingDispatches.set(msg.conversationId, {
								parts: [text],
								baseMsg: msg,
								sessionKey,
								timer: setTimeout(() => void flushDispatch(msg.conversationId), debounceMs),
							});
						}
						return;
					}
					// Immediate path: register the abort controller + run.
					await dispatchTurn({ text, sessionKey, conversationId: msg.conversationId });
				} catch (err) {
					// An inbound failure must never tear down the listener.
					const errMsg = err instanceof Error ? err.message : String(err);
					log.warn("inbound handling failed", {
						channel: adapter.id,
						conversationId: msg.conversationId,
						error: errMsg,
					});
					// Tell the sender something went wrong — silent failure looks like
					// the bot's ignoring them. Best-effort: if THIS sendText also fails
					// (e.g. the socket is the actual problem) we just log and move on;
					// the listener stays up either way.
					try {
						await adapter.sendText(
							msg.conversationId,
							"Sorry, I hit an error processing that message — please try again in a moment.",
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
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			// Cancel any pending debounce slots so a flush can't fire post-stop.
			for (const slot of pendingDispatches.values()) clearTimeout(slot.timer);
			pendingDispatches.clear();
			abort.abort();
			for (const { id, adapter } of started) {
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
