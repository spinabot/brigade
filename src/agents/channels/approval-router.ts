/**
 * Channel approval router — bridges Brigade's per-turn exec-gate to channel
 * adapters so an approval prompt raised by a channel-routed turn lands IN
 * the same conversation, not on the gateway WebSocket where nobody is
 * watching.
 *
 * Why this exists. Connect-mode TUI works because the operator is sitting
 * at the WebSocket consumer. Channel-routed turns (WhatsApp / Slack /
 * Discord DMs into Brigade) raise the same approval prompts through the
 * same bridge — but the operator is on their phone, not in the TUI. The
 * default path broadcasts on WS and hangs for the full 5-minute timeout.
 * This module re-routes those prompts back to the channel: send the prompt
 * as an outbound message, intercept the next inbound from the same peer
 * for a yes/no answer, resolve the bridge with the matching decision.
 *
 * Wiring at boot (in `startChannels`):
 *
 *   for each adapter:
 *     registerChannelApprovalDispatcher(adapter.id, {
 *       sendText: adapter.sendText,
 *       prettyName: adapter.label,
 *     });
 *
 * On every channel inbound, BEFORE the normal turn-dispatch path:
 *
 *   if (tryConsumeChannelApprovalReply({channelId, conversationId, text})) {
 *     return; // handled — bridge resolved, prompt acknowledged
 *   }
 *
 * On every channel-routed turn, the inbound carries an `ChannelApprovalRoute`
 * through `runGatewayTurn` → `runResilientTurn` → `runSingleTurn` →
 * `gateCtxRef.value.channelRoute`. The exec-gate then includes that route on
 * its `bridge.requestApproval(...)` call, and `InMemoryApprovalBridge.requestApproval`
 * — when it sees the route — calls `dispatchChannelApproval(...)` to send
 * the prompt as outbound text instead of (well, in addition to) the WS
 * broadcast.
 *
 * Process-wide singleton because there is exactly one channel manager per
 * gateway process and the exec-gate / approval-bridge live module-level —
 * threading a registry through 8 layers of args is the same fight as
 * the bridge itself (see `approval-bridge.ts` for the same rationale).
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { ApprovalDecision, ApprovalDecisionKind, ApprovalRequest } from "../approval-bridge.js";

const log = createSubsystemLogger("brigade/channel-approvals");

/** A pending approval the channel router is waiting on a yes/no for. */
export interface ChannelApprovalRoute {
	channelId: string;
	conversationId: string;
	threadId?: string;
	/** Channel-specific account id when the channel supports multi-account. */
	accountId?: string;
	/** Resolved agent id (route-resolver output) so concurrent agents sharing one peer don't collide on the pending-approval slot. */
	agentId?: string;
}

/**
 * Per-adapter dispatcher capability surface — minimal, exactly the bits
 * `dispatchChannelApproval` needs to ask the operator and the bits that
 * make the log lines useful. The channel manager constructs these at
 * `startChannels` boot from each adapter's outbound surface.
 */
export interface ChannelApprovalDispatcher {
	/** Send the approval prompt to the conversation. */
	sendText: (
		conversationId: string,
		text: string,
		opts?: { threadId?: string; accountId?: string },
	) => Promise<void>;
	/** Human-readable label for log lines + the prompt header (e.g. "WhatsApp"). */
	prettyName: string;
}

/** Entry stored per pending approval. The router owns the lifecycle. */
interface PendingChannelApproval {
	request: ApprovalRequest;
	route: ChannelApprovalRoute;
	/** Called by `tryConsumeChannelApprovalReply` to settle the bridge. */
	resolveOnBridge: (decision: ApprovalDecision) => void;
	/** Per-pending watchdog that cleans up the slot if the operator goes silent. */
	timer: ReturnType<typeof setTimeout>;
	createdAtMs: number;
}

/** All three approval-router maps are pinned via global-singleton so a hot-reload / dual-build run shares one routing state. */
const APPROVAL_ROUTER_DISPATCHERS_KEY = Symbol.for("brigade.approvalRouter.dispatchers");
const APPROVAL_ROUTER_PENDING_BY_PEER_KEY = Symbol.for("brigade.approvalRouter.pendingByPeer");
const APPROVAL_ROUTER_PENDING_BY_ID_KEY = Symbol.for("brigade.approvalRouter.pendingById");

/** Keyed by `${channelId}::${accountId ?? '*'}` — multi-account adapters register one dispatcher per account. */
const dispatchers = resolveGlobalSingleton<Map<string, ChannelApprovalDispatcher>>(
	APPROVAL_ROUTER_DISPATCHERS_KEY,
	() => new Map<string, ChannelApprovalDispatcher>(),
);
/**
 * Keyed by `${channelId}::${accountId ?? '*'}::${threadId ?? '*'}::${conversationId}::${agentId ?? '*'}`.
 * Disambiguates per (channel, account, thread, conversation, agent) so an
 * approval prompt raised by one agent on one thread can't be matched by
 * another agent's yes/no on a sibling thread / second account.
 */
const pendingByPeer = resolveGlobalSingleton<Map<string, PendingChannelApproval>>(
	APPROVAL_ROUTER_PENDING_BY_PEER_KEY,
	() => new Map<string, PendingChannelApproval>(),
);
/** Keyed by approval-request id — for `cancelChannelApprovalById` cleanup. */
const pendingById = resolveGlobalSingleton<Map<string, PendingChannelApproval>>(
	APPROVAL_ROUTER_PENDING_BY_ID_KEY,
	() => new Map<string, PendingChannelApproval>(),
);

function dispatcherKey(channelId: string, accountId?: string | null): string {
	return `${channelId}::${accountId && accountId.trim() ? accountId.trim() : "*"}`;
}

function peerKey(args: {
	channelId: string;
	accountId?: string;
	threadId?: string;
	conversationId: string;
	agentId?: string;
}): string {
	const account = args.accountId && args.accountId.trim() ? args.accountId.trim() : "*";
	const thread = args.threadId && args.threadId.trim() ? args.threadId.trim() : "*";
	const agent = args.agentId && args.agentId.trim() ? args.agentId.trim() : "*";
	return `${args.channelId}::${account}::${thread}::${args.conversationId}::${agent}`;
}

function peerKeyFromRoute(route: ChannelApprovalRoute): string {
	return peerKey({
		channelId: route.channelId,
		conversationId: route.conversationId,
		...(route.accountId !== undefined ? { accountId: route.accountId } : {}),
		...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
		...(route.agentId !== undefined ? { agentId: route.agentId } : {}),
	});
}

/**
 * Register an adapter's outbound surface so the bridge can route prompts
 * through it. Called by `startChannels` for every adapter that started
 * successfully. Idempotent — re-registering replaces the previous entry
 * (channel hot-reload friendly). `accountId` lets multi-account adapters
 * (one Slack workspace per account, two linked WhatsApp numbers, …)
 * register one dispatcher per account; pass `undefined` for single-account
 * adapters and the default-account slot is taken.
 */
export function registerChannelApprovalDispatcher(
	channelId: string,
	accountIdOrDispatcher: string | undefined | ChannelApprovalDispatcher,
	maybeDispatcher?: ChannelApprovalDispatcher,
): void {
	// Back-compat: keep the 2-arg call shape working for callers that don't
	// (yet) thread an accountId — single-account adapters land on the default
	// dispatcher slot via accountId === undefined.
	if (typeof accountIdOrDispatcher === "object" && accountIdOrDispatcher !== null) {
		dispatchers.set(dispatcherKey(channelId), accountIdOrDispatcher);
		return;
	}
	if (!maybeDispatcher) {
		throw new Error("registerChannelApprovalDispatcher: missing dispatcher arg");
	}
	dispatchers.set(dispatcherKey(channelId, accountIdOrDispatcher ?? null), maybeDispatcher);
}

/**
 * Drop a channel's dispatcher. Channel manager's `stop()` calls this for
 * every started adapter so a torn-down WhatsApp can't be asked to send
 * messages after the socket is gone. When `accountId` is omitted, drops
 * every dispatcher belonging to the channel (multi-account-aware stop).
 */
export function removeChannelApprovalDispatcher(channelId: string, accountId?: string): void {
	if (accountId !== undefined) {
		dispatchers.delete(dispatcherKey(channelId, accountId));
	} else {
		const prefix = `${channelId}::`;
		for (const key of [...dispatchers.keys()]) {
			if (key === channelId || key.startsWith(prefix)) dispatchers.delete(key);
		}
	}
	// Also reject any in-flight prompts the channel was carrying — the
	// operator can't reply through a torn-down adapter, so we deny rather
	// than leak.
	for (const [key, entry] of pendingByPeer.entries()) {
		if (entry.route.channelId !== channelId) continue;
		if (accountId !== undefined && (entry.route.accountId ?? "") !== accountId) continue;
		clearTimeout(entry.timer);
		pendingByPeer.delete(key);
		pendingById.delete(entry.request.id);
		entry.resolveOnBridge({ kind: "deny", timedOut: true });
	}
}

/** Diagnostic — used by tests + gateway `/health` checks. */
export function listChannelApprovalDispatchers(): string[] {
	return [...dispatchers.keys()];
}

/** Diagnostic — pending entries snapshot (returns shallow clones). */
export function listPendingChannelApprovals(): Array<{
	id: string;
	channelId: string;
	conversationId: string;
	threadId?: string;
	accountId?: string;
	agentId?: string;
	command: string;
	ageMs: number;
}> {
	const now = Date.now();
	return [...pendingByPeer.values()].map((p) => ({
		id: p.request.id,
		channelId: p.route.channelId,
		conversationId: p.route.conversationId,
		...(p.route.threadId !== undefined ? { threadId: p.route.threadId } : {}),
		...(p.route.accountId !== undefined ? { accountId: p.route.accountId } : {}),
		...(p.route.agentId !== undefined ? { agentId: p.route.agentId } : {}),
		command: p.request.command,
		ageMs: now - p.createdAtMs,
	}));
}

/**
 * Build the human-readable approval prompt the operator sees in the
 * channel. Kept short because some channels (Telegram captions, WhatsApp
 * note-cards) impose length limits — the model's command preview is the
 * informative part; the reply menu is the operator's actionable line.
 *
 * The 🦁 mark is the Brigade mascot — same brand-stamp used elsewhere in
 * channel surfaces so the operator recognises this as a Brigade prompt and
 * not an arbitrary chat partner asking for shell access.
 */
function buildPromptText(args: {
	command: string;
	subagentLabel?: string;
	agentId?: string;
}): string {
	const flat = args.command
		.replace(/[\r\n]+/g, " ")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const preview = flat.length <= 180 ? flat : `${flat.slice(0, 177)}…`;
	const agentSuffix =
		args.agentId && args.agentId.trim() && args.agentId.trim() !== "main"
			? ` [${args.agentId.trim()}]`
			: "";
	const who = args.subagentLabel
		? `Sub-agent "${args.subagentLabel}"${agentSuffix}`
		: `🦁 Brigade${agentSuffix}`;
	return [
		`${who} wants to run a shell command:`,
		`\`${preview}\``,
		"",
		"Reply *yes* to allow this once,",
		"*always* to allowlist this exact command,",
		"or *no* to deny.",
		"",
		"Times out in 5 minutes.",
	].join("\n");
}

/**
 * Decode an operator's text reply into a decision kind. Liberal in what
 * it accepts so the operator can type the obvious shapes without thinking:
 *   yes / y / ok / allow / sure  → allow-once
 *   always / save / remember     → allow-always
 *   no / n / deny / cancel / nah → deny
 *
 * `null` means "couldn't decide — fall through to normal turn dispatch."
 * That lets the operator change the subject mid-prompt (a fresh question
 * they typed in the same chat) rather than have it eaten by the gate.
 */
function decodeReply(text: string): ApprovalDecisionKind | null {
	const t = text.trim().toLowerCase();
	if (!t) return null;
	// Strip leading "/" so "/yes" works too — operators with slash-command
	// muscle memory from Slack/Telegram won't be surprised.
	const stripped = t.startsWith("/") ? t.slice(1) : t;
	const first = stripped.split(/\s+/, 1)[0] ?? stripped;
	switch (first) {
		case "yes":
		case "y":
		case "ok":
		case "okay":
		case "sure":
		case "allow":
		case "approve":
		case "approved":
			return "allow-once";
		case "always":
		case "save":
		case "remember":
		case "allow-always":
		case "allowalways":
			return "allow-always";
		case "no":
		case "n":
		case "nope":
		case "nah":
		case "deny":
		case "denied":
		case "cancel":
		case "stop":
		case "reject":
			return "deny";
		default:
			return null;
	}
}

/**
 * Send the approval prompt via the channel and register a pending entry
 * the next inbound from the same peer will consume.
 *
 * Returns:
 *   - `true`  → prompt dispatched, channel route owns this approval; the
 *               bridge MUST wait for `tryConsumeChannelApprovalReply` (or
 *               its watchdog timeout) to settle.
 *   - `false` → no dispatcher registered for `channelId`, or `sendText`
 *               threw. Caller (the approval-bridge) falls back to the
 *               default WS-broadcast path so the prompt still goes
 *               somewhere instead of vanishing.
 */
export async function dispatchChannelApproval(args: {
	request: ApprovalRequest;
	route: ChannelApprovalRoute;
	resolveOnBridge: (decision: ApprovalDecision) => void;
}): Promise<boolean> {
	const { request, route, resolveOnBridge } = args;
	// Prefer the per-account dispatcher when one is registered; fall back to
	// the channel's default-account dispatcher so single-account adapters
	// (registered without an accountId) keep working unchanged.
	const dispatcher =
		dispatchers.get(dispatcherKey(route.channelId, route.accountId ?? null)) ??
		dispatchers.get(dispatcherKey(route.channelId));
	if (!dispatcher) {
		log.warn("no dispatcher for channel — falling back to WS broadcast", {
			channelId: route.channelId,
			conversationId: route.conversationId,
			accountId: route.accountId,
		});
		return false;
	}
	const key = peerKeyFromRoute(route);
	// If there's already a pending entry for this peer, deny the previous
	// one. A second prompt overlapping the same peer means we'd be asking
	// two questions at once — the operator can only answer one, the other
	// would hang. Deny-the-older is the safer disposition: the model that
	// raised the older prompt gets a clean "no" and can ask again, rather
	// than a stale "deny on timeout" five minutes later.
	const existing = pendingByPeer.get(key);
	if (existing) {
		clearTimeout(existing.timer);
		pendingByPeer.delete(key);
		pendingById.delete(existing.request.id);
		existing.resolveOnBridge({ kind: "deny", timedOut: false });
	}
	const prompt = buildPromptText({
		command: request.command,
		...(request.subagentLabel !== undefined ? { subagentLabel: request.subagentLabel } : {}),
		...(route.agentId !== undefined ? { agentId: route.agentId } : {}),
	});
	// Wave L P2#9 — reserve the peer slot SYNCHRONOUSLY before awaiting
	// sendText. Two `dispatchChannelApproval` calls racing on the same
	// peer-key would otherwise both pass the `pendingByPeer.get(key)` check
	// above (since neither has set the slot yet) and both `pendingByPeer.set`
	// after the await — silently losing one of the resolveOnBridge handles.
	// Placeholder is replaced with the real entry below; on sendText failure
	// the placeholder is removed so the caller falls back to the WS path.
	const reservationToken: PendingChannelApproval = {
		request,
		route,
		resolveOnBridge,
		timer: setTimeout(() => undefined, 0),
		createdAtMs: Date.now(),
	};
	clearTimeout(reservationToken.timer);
	pendingByPeer.set(key, reservationToken);
	try {
		const sendOpts: { threadId?: string; accountId?: string } = {};
		if (route.threadId) sendOpts.threadId = route.threadId;
		if (route.accountId) sendOpts.accountId = route.accountId;
		await dispatcher.sendText(
			route.conversationId,
			prompt,
			Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
		);
	} catch (err) {
		// Release the reserved slot so the WS-fallback path can run cleanly.
		if (pendingByPeer.get(key) === reservationToken) {
			pendingByPeer.delete(key);
		}
		log.warn("approval prompt send failed — falling back to WS broadcast", {
			channelId: route.channelId,
			conversationId: route.conversationId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
	// Internal watchdog independent of the bridge's own timeout: the bridge
	// timer fires at `request.timeoutMs` and resolves the in-flight promise;
	// when that happens we still need to clean OUR maps so a late operator
	// reply doesn't intercept the next turn's text by mistake. We run a
	// matching timer at the same horizon — whichever fires first wins, and
	// the loser is a no-op because the entry is already gone.
	const watchdog = setTimeout(() => {
		const entry = pendingByPeer.get(key);
		if (!entry || entry.request.id !== request.id) return;
		pendingByPeer.delete(key);
		pendingById.delete(request.id);
		// The bridge will fire its own timeout at the same moment; we don't
		// need to call `resolveOnBridge` here because the bridge's timer
		// already does. Setting our entry aside is enough.
	}, request.timeoutMs);
	if (typeof watchdog.unref === "function") watchdog.unref();
	const entry: PendingChannelApproval = {
		request,
		route,
		resolveOnBridge,
		timer: watchdog,
		createdAtMs: Date.now(),
	};
	pendingByPeer.set(key, entry);
	pendingById.set(request.id, entry);
	log.info("approval prompt sent via channel", {
		channelId: route.channelId,
		conversationId: route.conversationId,
		approvalId: request.id,
		via: dispatcher.prettyName,
	});
	return true;
}

/**
 * Try to consume `text` as a yes/no reply to a pending approval for this
 * peer. Returns:
 *   - `true`  → text WAS a yes/no answer + bridge has been resolved; the
 *               caller (channel inbound handler) should `return` and NOT
 *               dispatch a turn for this message.
 *   - `false` → no pending approval for this peer, OR text wasn't a
 *               yes/no shape. Caller proceeds with normal dispatch.
 *
 * Notes for the channel inbound:
 *   - Must be called AFTER the access-policy check (we only intercept
 *     trusted peers — strangers can't accidentally answer an approval).
 *   - Must be called BEFORE the abort-trigger check (the abort word "stop"
 *     overlaps the "no" vocabulary; pending-approval intent wins).
 *   - The channel adapter's `sendText` for the acknowledgement is the
 *     caller's responsibility — the router only does the bridge plumbing.
 *     This keeps the router test-friendly (no I/O side effects on the
 *     intercept path) and lets per-channel formatting differ.
 */
export function tryConsumeChannelApprovalReply(args: {
	channelId: string;
	conversationId: string;
	text: string;
	threadId?: string;
	accountId?: string;
	agentId?: string;
}): { matched: true; decision: ApprovalDecisionKind; approvalId: string } | { matched: false } {
	// First, try the exact-route key (covers thread + account + agent
	// disambiguation). If nothing matches AND the caller didn't pin all
	// dimensions, scan for any pending entry whose route's pinned dimensions
	// agree with the caller — that handles the WhatsApp-style flat-DM case
	// where the inbound carries no threadId but the approval was raised on
	// the same channel+conversation.
	const exactKey = peerKey({
		channelId: args.channelId,
		conversationId: args.conversationId,
		...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
		...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
		...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
	});
	let entry = pendingByPeer.get(exactKey);
	let entryKey = exactKey;
	if (!entry) {
		// Fall back to a per-channel + per-conversation scan that matches when
		// the caller didn't pin every dimension (e.g. WhatsApp inbound has no
		// thread/account). Stops on the first agreeing route to preserve the
		// "one prompt per peer at a time" invariant.
		for (const [k, candidate] of pendingByPeer.entries()) {
			const r = candidate.route;
			if (r.channelId !== args.channelId || r.conversationId !== args.conversationId) continue;
			if (args.threadId !== undefined && r.threadId !== undefined && r.threadId !== args.threadId) continue;
			if (args.accountId !== undefined && r.accountId !== undefined && r.accountId !== args.accountId) continue;
			if (args.agentId !== undefined && r.agentId !== undefined && r.agentId !== args.agentId) continue;
			entry = candidate;
			entryKey = k;
			break;
		}
	}
	if (!entry) return { matched: false };
	const kind = decodeReply(args.text);
	if (kind === null) return { matched: false };
	pendingByPeer.delete(entryKey);
	pendingById.delete(entry.request.id);
	clearTimeout(entry.timer);
	const decision: ApprovalDecision = { kind };
	entry.resolveOnBridge(decision);
	log.info("approval resolved via channel reply", {
		channelId: args.channelId,
		conversationId: args.conversationId,
		approvalId: entry.request.id,
		decision: kind,
	});
	return { matched: true, decision: kind, approvalId: entry.request.id };
}

/**
 * Cancel a pending approval by request id (e.g. on session abort).
 * Bridge already cleans its own maps; this clears ours so a late reply
 * doesn't get mis-routed to a different turn.
 */
export function cancelChannelApprovalById(approvalId: string): void {
	const entry = pendingById.get(approvalId);
	if (!entry) return;
	const key = peerKeyFromRoute(entry.route);
	clearTimeout(entry.timer);
	pendingByPeer.delete(key);
	pendingById.delete(approvalId);
}

/** Test-only — clear every registration + pending entry. */
export function resetChannelApprovalRouterForTests(): void {
	for (const entry of pendingByPeer.values()) clearTimeout(entry.timer);
	pendingByPeer.clear();
	pendingById.clear();
	dispatchers.clear();
}
