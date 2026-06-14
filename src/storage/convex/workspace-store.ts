// src/storage/convex/workspace-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	BootstrapResult,
	ContextFile,
	PersonaName,
	Unsub,
	WorkspaceState,
	WorkspaceStore,
	WriteResult,
} from "../store.js";

import { open as openSealed, sealString } from "../encryption.js";

import { getReactiveConvexClient } from "./client.js";

interface Deps { client: ConvexHttpClient }

function bytesToString(b: ArrayBuffer | null | undefined): string {
	if (!b) return "";
	return openSealed(b).toString("utf8");
}
function stringToBytes(s: string): ArrayBuffer {
	return sealString(s);
}

export class ConvexWorkspaceStore implements WorkspaceStore {
	constructor(private readonly deps: Deps) {}

	async listPersona(agentId: string): Promise<ContextFile[]> {
		const rows = (await this.deps.client.query(api.workspace.listPersona, { agentId })) as Array<{
			name: PersonaName;
			content: ArrayBuffer;
			updatedAt: number;
		}>;
		// Graceful degradation: skip rows we can't decrypt (e.g. written by
		// a different operator or before a key rotation we don't have the
		// old key for). Single-row reads still throw — only the list path
		// filters.
		const out: ContextFile[] = [];
		for (const r of rows) {
			try {
				out.push({
					name: r.name,
					path: `convex://workspace/${agentId}/${r.name}`,
					content: bytesToString(r.content),
					updatedAt: r.updatedAt,
				});
			} catch {
				// Skip undecryptable row.
			}
		}
		return out;
	}

	async getHeartbeat(agentId: string): Promise<ContextFile | undefined> {
		const row = (await this.deps.client.query(api.workspace.getPersona, {
			agentId,
			name: "HEARTBEAT.md",
		})) as { name: PersonaName; content: ArrayBuffer; updatedAt: number } | null;
		if (!row) return undefined;
		return {
			name: row.name,
			path: `convex://workspace/${agentId}/${row.name}`,
			content: bytesToString(row.content),
			updatedAt: row.updatedAt,
		};
	}

	async writePersona(
		agentId: string,
		name: PersonaName,
		content: string,
		opts?: { createOnly?: boolean },
	): Promise<WriteResult & { created: boolean }> {
		if (opts?.createOnly) {
			const existing = await this.deps.client.query(api.workspace.getPersona, { agentId, name });
			if (existing) {
				return { rev: "" as never, writtenAt: Date.now(), created: false };
			}
		}
		const result = (await this.deps.client.mutation(api.workspace.writePersona, {
			agentId,
			name,
			content: stringToBytes(content),
		})) as { created: boolean };
		return { rev: "" as never, writtenAt: Date.now(), created: result.created };
	}

	async deletePersona(agentId: string, name: PersonaName): Promise<boolean> {
		return (await this.deps.client.mutation(api.workspace.deletePersona, {
			agentId,
			name,
		})) as boolean;
	}

	async readState(agentId: string): Promise<WorkspaceState> {
		const row = (await this.deps.client.query(api.workspace.getState, { agentId })) as {
			version?: number;
			bootstrapSeededAt?: string;
			setupCompletedAt?: string;
		} | null;
		return {
			version: row?.version ?? 1,
			...(row?.bootstrapSeededAt !== undefined ? { bootstrapSeededAt: row.bootstrapSeededAt } : {}),
			...(row?.setupCompletedAt !== undefined ? { setupCompletedAt: row.setupCompletedAt } : {}),
		};
	}

	async markBootstrapSeeded(agentId: string): Promise<void> {
		await this.deps.client.mutation(api.workspace.setBootstrapSeeded, { agentId });
	}

	async markSetupCompleted(agentId: string): Promise<void> {
		await this.deps.client.mutation(api.workspace.setSetupCompleted, { agentId });
	}

	async isBrandNewWorkspace(agentId: string): Promise<boolean> {
		const state = await this.readState(agentId);
		if (state.bootstrapSeededAt || state.setupCompletedAt) return false;
		const rows = (await this.deps.client.query(api.workspace.listPersona, { agentId })) as Array<unknown>;
		return rows.length === 0;
	}

	async ensureScaffold(_agentId: string): Promise<BootstrapResult> {
		// Persona seeding happens at first agent turn from the template loader
		// — same convention as filesystem mode. The Convex adapter doesn't
		// duplicate that path; callers seed via `writePersona` per file.
		throw new NotImplementedYet("workspace.ensureScaffold (use writePersona per file in convex mode)");
	}

	subscribePersona(agentId: string, cb: (files: ContextFile[]) => void): Unsub {
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.workspace.listPersona,
			{ agentId },
			(rows) => {
				const out = (rows as Array<{ name: PersonaName; content: ArrayBuffer; updatedAt: number }>).map(
					(r) => ({
						name: r.name,
						path: `convex://workspace/${agentId}/${r.name}`,
						content: bytesToString(r.content),
						updatedAt: r.updatedAt,
					}),
				);
				try {
					cb(out);
				} catch {
					// Subscriber threw — keep the stream alive.
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
}
