/**
 * Approval bridge — seam between Brigade's per-turn exec-gate and any
 * surface that can ask an operator "do you want to allow this?".
 *
 * The gateway plugs in an `InMemoryApprovalBridge` at boot and broadcasts
 * `approval-request` events via the gateway WS to connected TUI clients.
 * The TUI renders an inline prompt (Y/A/P/N keys) and replies via the
 * `approval-resolve` request; the bridge resolves the corresponding
 * pending Promise so the exec-gate can return `allow`/`deny` to Pi.
 *
 * Why a module-level singleton — not threading the bridge through every
 * function arg: the gateway is one process, the bridge is one instance,
 * every per-turn `makeExecGate` call needs the SAME object. Threading it
 * through 8 layers of args (server → resilientTurn → singleTurn →
 * composeBrigadeBeforeToolCall → makeExecGate) doubles the surface for
 * zero added correctness. Tests can `setActiveApprovalBridge(null)` in
 * afterEach to restore the default (no-op) bridge.
 *
 * Default bridge is null → exec-gate falls back to the legacy "refuse +
 * tell the model to ask the user" path, matching pre-2026-05-24 behaviour
 * for anything that boots without a gateway (CLI `brigade agent`, tests).
 */

import * as crypto from "node:crypto";

import { recordApproval } from "../core/exec-approvals.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
	type ChannelApprovalRoute,
	cancelChannelApprovalById,
	dispatchChannelApproval,
} from "./channels/approval-router.js";

const log = createSubsystemLogger("brigade/approvals");

export type { ChannelApprovalRoute } from "./channels/approval-router.js";

/** Decisions the operator can pick. Aligned with protocol.ts.
 *  `allow-session` allows THIS call AND arms session-scoped allow-all (the
 *  exec-gate stops prompting for the rest of the session) — the in-prompt
 *  equivalent of `/allow-all on`. The gate performs the arming (it owns the
 *  session key); persistence-wise it's ephemeral, never written to disk. */
export type ApprovalDecisionKind =
	| "allow-once"
	| "allow-always"
	| "allow-pattern"
	| "allow-session"
	| "deny";

export interface ApprovalDecision {
	kind: ApprovalDecisionKind;
	/** Required when `kind === "allow-pattern"`. */
	pattern?: string;
	/** When falsy, the bridge timed out instead of getting a real reply. */
	timedOut?: boolean;
	/**
	 * The awaiting turn was aborted before the operator answered — a Pi abort, or
	 * the claude-cli child dying so the MCP route's per-call controller fired.
	 * Distinct from `timedOut` on purpose: a timeout is an operator-visible 5-minute
	 * event with its own message and log line, an abort is a turn-lifecycle event
	 * that may happen in milliseconds. `kind` stays "deny" so the gate fails closed
	 * even if the abort branch is ever bypassed.
	 */
	aborted?: boolean;
}

export interface ApprovalRequest {
	id: string;
	command: string;
	toolName: string;
	cwd?: string;
	timeoutMs: number;
	decisions: ReadonlyArray<ApprovalDecisionKind>;
	/**
	 * Sub-agent attribution (Primitive #6). When set, the TUI surfaces a
	 * "Sub-agent '<label>' wants to run …" title instead of the default
	 * "Brigade wants to run …", so the operator knows whose tool call they
	 * are about to approve. Top-level (operator-driven) turns leave these
	 * undefined.
	 */
	subagentLabel?: string;
	subagentDepth?: number;
	parentRunId?: string;
	/** P1#3 (Wave H) — agent whose turn requested approval; lets the gateway route the WS broadcast to the right operator. */
	agentId?: string;
	/** P1#3 (Wave H) — session the approval belongs to; pairs with `agentId` for filtered fan-out. */
	sessionId?: string;
	/**
	 * Channel routing — when set, the bridge sends the approval prompt to
	 * the channel conversation (via the per-channel approval-router
	 * dispatcher) AND broadcasts on WS for diagnostics. The channel inbound
	 * intercepts the operator's yes/no reply and resolves the bridge. When
	 * unset, only the WS broadcast path runs — the legacy connect-mode TUI
	 * flow. Both paths share the same 5-minute deny-on-timeout safety net.
	 */
	channelRoute?: ChannelApprovalRoute;
}

/** Broadcaster the bridge calls when a new request lands. */
export type ApprovalBroadcaster = (request: ApprovalRequest) => void;

export interface ApprovalBridge {
	/**
	 * Request an approval decision. Resolves when the operator replies, or
	 * with `{kind: "deny", timedOut: true}` after `timeoutMs` (default 5
	 * minutes) — a hung TUI must not freeze the agent loop forever.
	 */
	requestApproval(
		req: Omit<ApprovalRequest, "id"> & { id?: string },
		signal?: AbortSignal,
	): Promise<ApprovalDecision>;
	/**
	 * Resolve a pending request (called by the WS request handler).
	 * Returns true if a pending request was found, false otherwise (timed
	 * out + already cleaned up, or operator double-clicked).
	 */
	resolveApproval(id: string, decision: ApprovalDecision): boolean;
	/**
	 * List currently pending requests — diagnostic only. Used by gateway
	 * `/health` so the operator can spot a wedged approval.
	 */
	listPending(): ApprovalRequest[];
}

interface PendingEntry {
	request: ApprovalRequest;
	resolve: (decision: ApprovalDecision) => void;
	timer: ReturnType<typeof setTimeout>;
	/** Removes the abort listener. Called on EVERY settle path so a long-lived
	 *  turn signal never accumulates one listener per approval. */
	detachAbort: () => void;
}

/**
 * In-memory bridge with timeout safety. The gateway constructs exactly
 * one of these at boot and wires `broadcast` to its WS event broadcaster.
 */
export class InMemoryApprovalBridge implements ApprovalBridge {
	private readonly pending = new Map<string, PendingEntry>();
	constructor(private readonly broadcast: ApprovalBroadcaster) {}

	/** Single exit for every settle path: drop the entry, clear the timer, detach
	 *  the abort listener, resolve once. Idempotent — an absent id returns false. */
	private settle(id: string, decision: ApprovalDecision): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.detachAbort();
		entry.resolve(decision);
		return true;
	}

	requestApproval(
		req: Omit<ApprovalRequest, "id"> & { id?: string },
		signal?: AbortSignal,
	): Promise<ApprovalDecision> {
		const id = req.id ?? crypto.randomUUID();
		const request: ApprovalRequest = {
			id,
			command: req.command,
			toolName: req.toolName,
			cwd: req.cwd,
			timeoutMs: req.timeoutMs,
			decisions: req.decisions,
			...(req.subagentLabel !== undefined ? { subagentLabel: req.subagentLabel } : {}),
			...(req.subagentDepth !== undefined ? { subagentDepth: req.subagentDepth } : {}),
			...(req.parentRunId !== undefined ? { parentRunId: req.parentRunId } : {}),
			...(req.agentId !== undefined ? { agentId: req.agentId } : {}),
			...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
			...(req.channelRoute !== undefined ? { channelRoute: req.channelRoute } : {}),
		};
		return new Promise<ApprovalDecision>((resolve) => {
			// Already dead on arrival: never register, never broadcast. Prompting the
			// operator about a turn that no longer exists is pure noise.
			if (signal?.aborted) {
				resolve({ kind: "deny", aborted: true });
				return;
			}
			const timer = setTimeout(() => {
				if (!this.pending.has(id)) return;
				log.warn("approval timed out", { id, command: request.command, timeoutMs: request.timeoutMs });
				this.settle(id, { kind: "deny", timedOut: true });
			}, request.timeoutMs);
			if (typeof timer.unref === "function") timer.unref();

			// Abort => withdraw the prompt. Without this the entry lingers for the
			// full 5-minute window: it keeps showing in `listPending()` (so a
			// reconnecting client re-renders a dead prompt), and a channel-routed
			// prompt keeps its own watchdog armed — meaning the operator's NEXT
			// unrelated WhatsApp/Telegram message would be consumed as a yes/no.
			let detachAbort = (): void => {};
			if (signal) {
				const onAbort = (): void => {
					if (request.channelRoute) cancelChannelApprovalById(id);
					this.settle(id, { kind: "deny", aborted: true });
				};
				signal.addEventListener("abort", onAbort, { once: true });
				detachAbort = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.set(id, { request, resolve, timer, detachAbort });
			// WS broadcast ALWAYS fires — even on the channel-routed path,
			// because a connect-mode TUI watching the gateway should still
			// see the prompt (diagnostic + a power user might prefer to
			// answer it there). The channel dispatch path adds the
			// in-conversation prompt on top.
			try {
				this.broadcast(request);
			} catch (err) {
				// Broadcaster failed (e.g. no clients) — keep the pending entry
				// so an in-flight client that arrives moments later can still
				// resolve. The timer guarantees we never hang forever.
				log.warn("approval broadcast failed", {
					id,
					err: err instanceof Error ? err.message : String(err),
				});
			}
			// Channel routing — send the prompt INTO the originating chat so
			// the operator (who is on WhatsApp / Slack / Discord, NOT the
			// TUI) sees it where they're actually looking. Fire-and-forget
			// from the bridge's perspective: the router handles its own
			// errors + falls back silently when no dispatcher is registered
			// (in which case the WS broadcast above is the only path, same
			// as legacy behaviour).
			if (request.channelRoute) {
				void dispatchChannelApproval({
					request,
					route: request.channelRoute,
					resolveOnBridge: (decision) => {
						this.resolveApproval(id, decision);
					},
				});
			}
		});
	}

	resolveApproval(id: string, decision: ApprovalDecision): boolean {
		// Still returns false for an absent id — the WS handler relies on that to
		// silently no-op when the operator answers a prompt we already withdrew.
		return this.settle(id, decision);
	}

	listPending(): ApprovalRequest[] {
		return [...this.pending.values()].map((p) => p.request);
	}
}

type ActiveApprovalBridgeState = { activeBridge: ApprovalBridge | null };

const ACTIVE_APPROVAL_BRIDGE_KEY = Symbol.for("brigade.approval.activeBridge");

function getActiveBridgeState(): ActiveApprovalBridgeState {
	return resolveGlobalSingleton<ActiveApprovalBridgeState>(ACTIVE_APPROVAL_BRIDGE_KEY, () => ({
		activeBridge: null,
	}));
}

/**
 * Set the process-wide bridge. Gateway calls this at boot.
 *
 * P1#9 (Wave H) — backed by `resolveGlobalSingleton` so dual-loaded
 * Brigade modules share ONE slot. Without the pin an exec-gate importing
 * a different copy of this module than the gateway boot path would see
 * `null` even after a real bridge was set.
 */
export function setActiveApprovalBridge(bridge: ApprovalBridge | null): void {
	getActiveBridgeState().activeBridge = bridge;
}

/** Read the active bridge. Exec-gate calls this on every prompt branch. */
export function getActiveApprovalBridge(): ApprovalBridge | null {
	return getActiveBridgeState().activeBridge;
}

/**
 * Apply an operator's decision: persist if it's a long-lived approval,
 * then return `true` for allow / `false` for deny. Pure-logic split out
 * so the exec-gate stays focused on tool dispatch.
 *
 * Persistence:
 *   - `"allow-once"`     → no write
 *   - `"allow-always"`   → `recordApproval(command, "exact")`
 *   - `"allow-pattern"`  → `recordApproval(pattern, "pattern")` if pattern is provided;
 *                          falls back to "allow-once" semantics otherwise
 *   - `"deny"`           → no write
 *
 * Persistence errors (hard-deny conflict, symlink at the file path) bubble
 * up — the caller decides whether to refuse the tool call or treat the
 * decision as allow-once.
 */
export function applyApprovalDecision(args: {
	command: string;
	decision: ApprovalDecision;
	/** Per-agent allowlist scope — defaults to the canonical agent. */
	agentId?: string;
}): "allow" | "deny" {
	const { command, decision, agentId } = args;
	switch (decision.kind) {
		case "deny":
			return "deny";
		case "allow-once":
			return "allow";
		case "allow-session":
			// Allow THIS call. Arming session allow-all happens in the exec-gate
			// (it owns the session key); nothing is persisted here.
			return "allow";
		case "allow-always":
			recordApproval(command, "exact", agentId);
			return "allow";
		case "allow-pattern": {
			const pattern = decision.pattern?.trim();
			if (pattern) {
				recordApproval(pattern, "pattern", agentId);
			}
			// Even if no pattern was provided, this call IS allowed — the
			// operator picked an "allow" disposition. Future calls miss the
			// allowlist, which is the right behaviour for a malformed input.
			return "allow";
		}
	}
}
