// src/storage/convex/subagent-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	SubagentLifecycleEndedReason,
	SubagentRunOutcome,
	SubagentRunRecord,
	SubagentStore,
} from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

export class ConvexSubagentStore implements SubagentStore {
	constructor(private readonly deps: Deps) {}

	async put(record: SubagentRunRecord): Promise<void> {
		await this.deps.client.mutation(api.subagents.put, {
			ownerId: this.deps.ownerId,
			record: record as never,
		});
	}

	async get(runId: string): Promise<SubagentRunRecord | undefined> {
		const row = (await this.deps.client.query(api.subagents.get, {
			ownerId: this.deps.ownerId,
			runId,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as SubagentRunRecord) : undefined;
	}

	async getByChildSessionKey(childSessionKey: string): Promise<SubagentRunRecord | undefined> {
		const row = (await this.deps.client.query(api.subagents.getByChildSessionKey, {
			ownerId: this.deps.ownerId,
			childSessionKey,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as SubagentRunRecord) : undefined;
	}

	async listByRequester(requesterSessionKey: string): Promise<SubagentRunRecord[]> {
		const rows = (await this.deps.client.query(api.subagents.listByRequester, {
			ownerId: this.deps.ownerId,
			requesterSessionKey,
		})) as Array<Record<string, unknown>>;
		return rows as unknown as SubagentRunRecord[];
	}

	async listActiveByController(_controllerSessionKey: string): Promise<SubagentRunRecord[]> {
		throw new NotImplementedYet("subagents.listActiveByController (follow-up)");
	}

	async countActiveByRequester(requesterSessionKey: string): Promise<number> {
		const rows = await this.listByRequester(requesterSessionKey);
		return rows.filter((r) => (r as { endedAt?: number }).endedAt === undefined).length;
	}

	async spawnedKeysFor(parentSessionKey: string): Promise<Set<string>> {
		const out = new Set<string>();
		const queue = [parentSessionKey];
		let depth = 0;
		while (queue.length > 0 && depth < 32) {
			const next: string[] = [];
			for (const requester of queue) {
				const children = await this.listByRequester(requester);
				for (const c of children) {
					const key = (c as { childSessionKey?: string }).childSessionKey;
					if (key && !out.has(key)) {
						out.add(key);
						next.push(key);
					}
				}
			}
			queue.length = 0;
			queue.push(...next);
			depth += 1;
		}
		return out;
	}

	async markCompleted(args: {
		runId: string;
		outcome: SubagentRunOutcome;
		reason: SubagentLifecycleEndedReason;
		endedAt: number;
		error?: string;
		endedHookEmittedAt?: number;
	}): Promise<SubagentRunRecord | undefined> {
		const row = (await this.deps.client.mutation(api.subagents.markCompleted, {
			ownerId: this.deps.ownerId,
			runId: args.runId,
			endedAt: args.endedAt,
			outcome: args.outcome as never,
			reason: args.reason as string,
			...(args.error !== undefined ? { error: args.error } : {}),
			...(args.endedHookEmittedAt !== undefined ? { endedHookEmittedAt: args.endedHookEmittedAt } : {}),
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as SubagentRunRecord) : undefined;
	}

	async delete(runId: string): Promise<boolean> {
		return (await this.deps.client.mutation(api.subagents.remove, {
			ownerId: this.deps.ownerId,
			runId,
		})) as boolean;
	}
}
