// src/storage/convex/exec-approval-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { getReactiveConvexClient } from "./client.js";

import { NotImplementedYet } from "../store.js";
import type { ApprovalsSnapshot, ExecApprovalStore } from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

interface CachedRows { commands: Set<string>; patterns: Array<{ raw: string; re: RegExp | null }> }

const cache = new Map<string, CachedRows>();

function cacheKey(ownerId: string, agentId: string): string {
	return `${ownerId}::${agentId}`;
}

function normaliseCommand(cmd: string): string {
	return cmd.trim().replace(/\s+/g, " ");
}

export class ConvexExecApprovalStore implements ExecApprovalStore {
	constructor(private readonly deps: Deps) {}

	// Sync — Pi SDK's bash tool gate is sync. Convex mode satisfies this
	// from a process-local cache that `watch` keeps fresh.
	decideSync(command: string, agentId: string): "allow" | "deny" | "prompt" {
		const cmd = normaliseCommand(command);
		if (!cmd) return "prompt";
		const rows = cache.get(cacheKey(this.deps.ownerId, agentId));
		if (!rows) return "prompt";
		if (rows.commands.has(cmd)) return "allow";
		for (const { re } of rows.patterns) {
			if (re && re.test(command)) return "allow";
		}
		return "prompt";
	}

	async recordApproval(args: { agentId: string; value: string; kind: "exact" | "pattern" }): Promise<void> {
		await this.deps.client.mutation(api.execApprovals.insert, {
			ownerId: this.deps.ownerId,
			agentId: args.agentId,
			kind: args.kind,
			value: args.value,
			valueNormalised: normaliseCommand(args.value),
		});
		await this._refreshCache(args.agentId);
	}

	async removeApproval(
		agentId: string,
		value: string,
	): Promise<{ removedCommands: number; removedPatterns: number }> {
		const result = (await this.deps.client.mutation(api.execApprovals.remove, {
			ownerId: this.deps.ownerId,
			agentId,
			valueNormalised: normaliseCommand(value),
		})) as { removedCommands: number; removedPatterns: number };
		await this._refreshCache(agentId);
		return result;
	}

	async readSummary(
		agentId: string,
	): Promise<{ commandCount: number; patternCount: number; error?: string }> {
		const rows = (await this.deps.client.query(api.execApprovals.list, {
			ownerId: this.deps.ownerId,
			agentId,
		})) as Array<{ kind: "exact" | "pattern" }>;
		let commandCount = 0;
		let patternCount = 0;
		for (const r of rows) {
			if (r.kind === "exact") commandCount += 1;
			else patternCount += 1;
		}
		return { commandCount, patternCount };
	}

	/** Full allowlist contents, ordered by insertion time so re-reads are
	 *  deterministic (filesystem arrays preserve append order; Convex query
	 *  order is undefined without an explicit sort). */
	async list(agentId: string): Promise<{ commands: string[]; patterns: string[] }> {
		const rows = (await this.deps.client.query(api.execApprovals.list, {
			ownerId: this.deps.ownerId,
			agentId,
		})) as Array<{
			kind: "exact" | "pattern";
			value: string;
			createdAt?: number;
		}>;
		const sorted = [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
		const commands: string[] = [];
		const patterns: string[] = [];
		for (const r of sorted) {
			if (r.kind === "exact") commands.push(r.value);
			else patterns.push(r.value);
		}
		return { commands, patterns };
	}

	watch(agentId: string, onChange: (snap: ApprovalsSnapshot) => void): () => void {
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.execApprovals.list,
			{ ownerId: this.deps.ownerId, agentId },
			(rows) => {
				const list = rows as Array<{ kind: "exact" | "pattern"; valueNormalised: string; value: string }>;
				const commands = new Set<string>();
				const patterns: CachedRows["patterns"] = [];
				for (const r of list) {
					if (r.kind === "exact") commands.add(r.valueNormalised);
					else {
						try {
							patterns.push({ raw: r.value, re: new RegExp(r.value) });
						} catch {
							patterns.push({ raw: r.value, re: null });
						}
					}
				}
				cache.set(cacheKey(this.deps.ownerId, agentId), { commands, patterns });
				try {
					onChange({
						commandCount: commands.size,
						patternCount: patterns.length,
					} as ApprovalsSnapshot);
				} catch {
					// Subscriber threw — stay alive.
				}
			},
		);
		return () => {
			try {
				unsub();
			} catch {
				// Idempotent.
			}
		};
	}

	private async _refreshCache(agentId: string): Promise<void> {
		const rows = (await this.deps.client.query(api.execApprovals.list, {
			ownerId: this.deps.ownerId,
			agentId,
		})) as Array<{ kind: "exact" | "pattern"; valueNormalised: string; value: string }>;
		const commands = new Set<string>();
		const patterns: CachedRows["patterns"] = [];
		for (const r of rows) {
			if (r.kind === "exact") commands.add(r.valueNormalised);
			else {
				try {
					patterns.push({ raw: r.value, re: new RegExp(r.value) });
				} catch {
					patterns.push({ raw: r.value, re: null });
				}
			}
		}
		cache.set(cacheKey(this.deps.ownerId, agentId), { commands, patterns });
	}

	__unused = NotImplementedYet;
}
