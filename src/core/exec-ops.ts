/**
 * Exec-approval operations behind the `exec.*` gateway RPCs — the
 * `brigade exec <list|allow|allow-pattern|remove|deny-test>` surface, reachable
 * from a remote client.
 *
 * OPERATOR-SCOPED, per-agent: manages an agent's bash approval allowlist. NOT
 * session-targeted — the operator manages exec trust for their OWN agents, the
 * same posture as the already-allowlisted `exec-grant-skill` / `exec-allow-all`
 * RPCs. No per-session access guard is needed (and the guard-sweep allowlists
 * these by name for that reason).
 *
 * All structured returns (no console I/O) so the gateway can hand them straight
 * back to a WS client. The underlying primitives in `exec-approvals.ts` are the
 * SAME ones the CLI calls, so `brigade exec allow` and `exec.allow` over the
 * wire behave identically — including the hard-deny safety net.
 */

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import {
	type ApprovalDecision,
	BrigadeApprovalRefusedError,
	decideApproval,
	getApprovalsFilePath,
	listApprovals,
	recordApproval,
	removeApproval,
} from "./exec-approvals.js";

function resolveAgentId(agentId?: string): string {
	const t = (agentId ?? "").trim();
	return t.length > 0 ? t : DEFAULT_AGENT_ID;
}

export interface ExecListResult {
	agentId: string;
	filePath: string;
	commands: string[];
	patterns: string[];
}
export function handleExecList(params: unknown): ExecListResult {
	const p = (params ?? {}) as { agentId?: string };
	const agentId = resolveAgentId(p.agentId);
	const { commands, patterns } = listApprovals(agentId);
	return { agentId, filePath: getApprovalsFilePath(agentId), commands, patterns };
}

export interface ExecMutateResult {
	ok: boolean;
	agentId: string;
	kind?: "exact" | "pattern";
	value?: string;
	reason?: string;
}
export function handleExecAllow(params: unknown): ExecMutateResult {
	const p = (params ?? {}) as { command?: string; agentId?: string };
	const agentId = resolveAgentId(p.agentId);
	const cmd = (p.command ?? "").trim();
	if (!cmd) return { ok: false, agentId, reason: "command is empty" };
	if (decideApproval(cmd, agentId) === "deny") {
		return { ok: false, agentId, value: cmd, reason: "matches a hard-deny pattern and cannot be allowlisted" };
	}
	try {
		recordApproval(cmd, "exact", agentId);
	} catch (err) {
		if (err instanceof BrigadeApprovalRefusedError) return { ok: false, agentId, value: cmd, reason: err.message };
		throw err;
	}
	return { ok: true, agentId, kind: "exact", value: cmd };
}

export function handleExecAllowPattern(params: unknown): ExecMutateResult {
	const p = (params ?? {}) as { pattern?: string; agentId?: string };
	const agentId = resolveAgentId(p.agentId);
	const pat = (p.pattern ?? "").trim();
	if (!pat) return { ok: false, agentId, reason: "pattern is empty" };
	try {
		new RegExp(pat);
	} catch (err) {
		return { ok: false, agentId, value: pat, reason: `invalid regex: ${(err as Error).message}` };
	}
	try {
		recordApproval(pat, "pattern", agentId);
	} catch (err) {
		if (err instanceof BrigadeApprovalRefusedError) return { ok: false, agentId, value: pat, reason: err.message };
		throw err;
	}
	return { ok: true, agentId, kind: "pattern", value: pat };
}

export interface ExecRemoveResult {
	ok: boolean;
	agentId: string;
	removedCommands: number;
	removedPatterns: number;
	reason?: string;
}
export function handleExecRemove(params: unknown): ExecRemoveResult {
	const p = (params ?? {}) as { value?: string; agentId?: string };
	const agentId = resolveAgentId(p.agentId);
	const value = (p.value ?? "").trim();
	if (!value) return { ok: false, agentId, removedCommands: 0, removedPatterns: 0, reason: "value is empty" };
	let res: { removedCommands: number; removedPatterns: number };
	try {
		res = removeApproval(value, agentId);
	} catch (err) {
		if (err instanceof BrigadeApprovalRefusedError) {
			return { ok: false, agentId, removedCommands: 0, removedPatterns: 0, reason: err.message };
		}
		throw err;
	}
	const ok = res.removedCommands > 0 || res.removedPatterns > 0;
	return {
		ok,
		agentId,
		removedCommands: res.removedCommands,
		removedPatterns: res.removedPatterns,
		...(ok ? {} : { reason: `"${value}" not found in commands or patterns` }),
	};
}

export interface ExecDenyTestResult {
	agentId: string;
	command: string;
	decision: ApprovalDecision;
}
export function handleExecDenyTest(params: unknown): ExecDenyTestResult {
	const p = (params ?? {}) as { command?: string; agentId?: string };
	const agentId = resolveAgentId(p.agentId);
	const cmd = (p.command ?? "").trim();
	return { agentId, command: cmd, decision: cmd ? decideApproval(cmd, agentId) : "deny" };
}
