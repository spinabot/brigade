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

const log = createSubsystemLogger("brigade/approvals");

/** Decisions the operator can pick. Aligned with protocol.ts. */
export type ApprovalDecisionKind = "allow-once" | "allow-always" | "allow-pattern" | "deny";

export interface ApprovalDecision {
	kind: ApprovalDecisionKind;
	/** Required when `kind === "allow-pattern"`. */
	pattern?: string;
	/** When falsy, the bridge timed out instead of getting a real reply. */
	timedOut?: boolean;
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
}

/**
 * In-memory bridge with timeout safety. The gateway constructs exactly
 * one of these at boot and wires `broadcast` to its WS event broadcaster.
 */
export class InMemoryApprovalBridge implements ApprovalBridge {
	private readonly pending = new Map<string, PendingEntry>();
	constructor(private readonly broadcast: ApprovalBroadcaster) {}

	requestApproval(
		req: Omit<ApprovalRequest, "id"> & { id?: string },
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
		};
		return new Promise<ApprovalDecision>((resolve) => {
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				if (!entry) return;
				this.pending.delete(id);
				log.warn("approval timed out", { id, command: request.command, timeoutMs: request.timeoutMs });
				entry.resolve({ kind: "deny", timedOut: true });
			}, request.timeoutMs);
			if (typeof timer.unref === "function") timer.unref();
			this.pending.set(id, { request, resolve, timer });
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
		});
	}

	resolveApproval(id: string, decision: ApprovalDecision): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.resolve(decision);
		return true;
	}

	listPending(): ApprovalRequest[] {
		return [...this.pending.values()].map((p) => p.request);
	}
}

let activeBridge: ApprovalBridge | null = null;

/** Set the process-wide bridge. Gateway calls this at boot. */
export function setActiveApprovalBridge(bridge: ApprovalBridge | null): void {
	activeBridge = bridge;
}

/** Read the active bridge. Exec-gate calls this on every prompt branch. */
export function getActiveApprovalBridge(): ApprovalBridge | null {
	return activeBridge;
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
}): "allow" | "deny" {
	const { command, decision } = args;
	switch (decision.kind) {
		case "deny":
			return "deny";
		case "allow-once":
			return "allow";
		case "allow-always":
			recordApproval(command, "exact");
			return "allow";
		case "allow-pattern": {
			const pattern = decision.pattern?.trim();
			if (pattern) {
				recordApproval(pattern, "pattern");
			}
			// Even if no pattern was provided, this call IS allowed — the
			// operator picked an "allow" disposition. Future calls miss the
			// allowlist, which is the right behaviour for a malformed input.
			return "allow";
		}
	}
}
