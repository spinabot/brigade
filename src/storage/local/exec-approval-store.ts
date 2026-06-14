// src/storage/local/exec-approval-store.ts
//
// LocalExecApprovalStore — filesystem-mode wrapper around
// `src/core/exec-approvals.ts`. Implements `ExecApprovalStore`.
//
// Behaviour rule (additive): every method calls today's existing functions
// byte-for-byte. The hard-deny patterns + concurrent-write safety
// (fresh-from-disk read-modify-write) live in the wrapped module; we just
// surface them through a typed interface so primitive code can stop reaching
// into core/exec-approvals.ts directly.
//
// Why the sync `decideSync`: Pi SDK's bash tool gate is synchronous — it
// can't await between "agent emits tool_use" and "supervisor decides
// allow/deny/prompt". Filesystem mode reads from an mtime-checked in-memory
// cache that the existing `decideApproval` already maintains; convex mode
// (later PR) will hold a snapshot kept fresh via a Convex subscription.

import {
	decideApproval,
	listApprovals,
	readApprovalsSummary,
	recordApproval,
	removeApproval,
	resolveExecApprovalsPath,
} from "../../core/exec-approvals.js";

import { watchFile } from "./file-watcher.js";

import type { ApprovalsSnapshot, ExecApprovalStore } from "../store.js";

export class LocalExecApprovalStore implements ExecApprovalStore {
	constructor(private readonly _stateDir: string) {}

	/** Sync — returns "allow" | "deny" | "prompt" against the per-agent file. */
	decideSync(command: string, agentId: string): "allow" | "deny" | "prompt" {
		return decideApproval(command, agentId);
	}

	async recordApproval(args: {
		agentId: string;
		value: string;
		kind: "exact" | "pattern";
	}): Promise<void> {
		// Existing recordApproval is sync — it does fresh-from-disk read-
		// modify-write internally. Wrap in a Promise to satisfy the interface.
		recordApproval(args.value, args.kind, args.agentId);
	}

	async removeApproval(
		agentId: string,
		value: string,
	): Promise<{ removedCommands: number; removedPatterns: number }> {
		return removeApproval(value, agentId);
	}

	async readSummary(
		agentId: string,
	): Promise<{ commandCount: number; patternCount: number; error?: string }> {
		const summary = readApprovalsSummary(agentId);
		return {
			commandCount: summary.commandCount,
			patternCount: summary.patternCount,
			...(summary.error !== undefined ? { error: summary.error } : {}),
		};
	}

	/** Full allowlist contents (interface surface). */
	async list(agentId: string): Promise<{ commands: string[]; patterns: string[] }> {
		return listApprovals(agentId);
	}

	/** Enumerate approvals — used by `brigade store migrate` to copy entries
	 *  (not just the count) into the destination store. */
	async listAll(agentId: string): Promise<{ commands: string[]; patterns: string[] }> {
		return listApprovals(agentId);
	}

	/**
	 * fs.watch on the per-agent exec-approvals.json with the standard 500 ms
	 * debounce. On change we emit a summary snapshot (commandCount /
	 * patternCount). The decideApproval path has its own mtime cache that
	 * also rereads — this listener is for callers that want push-style
	 * notifications (e.g. a TUI status pane).
	 */
	watch(agentId: string, onChange: (snap: ApprovalsSnapshot) => void): () => void {
		const filePath = resolveExecApprovalsPath(agentId);
		return watchFile(filePath, () => {
			try {
				const summary = readApprovalsSummary(agentId);
				onChange({
					commandCount: summary.commandCount,
					patternCount: summary.patternCount,
					...(summary.error !== undefined ? { error: summary.error } : {}),
				} as ApprovalsSnapshot);
			} catch {
				// Mid-write / unparseable — skip this firing; next stable
				// write will trigger again.
			}
		});
	}
}
