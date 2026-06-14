// src/storage/convex/session-store.ts
//
// ConvexSessionStore — sessions.json equivalent backed by the `sessions`
// table. The filesystem shape (src/sessions/session-store.ts SessionEntry)
// and the Convex row shape differ in two load-bearing ways, so every read
// and write goes through the marshalling pair below:
//
//   • timestamps — filesystem entries carry ISO-8601 STRINGS
//     (`createdAt: "2026-06-08T05:14:46.065Z"`); the table stores epoch-ms
//     NUMBERS. Sending a string at the mutation boundary fails Convex's
//     `v.number()` validator outright.
//   • open fields — SessionEntry is `[key: string]: unknown`; operators and
//     subsystems hang extra fields off entries (compactionCount,
//     authProfileSource, …). The mutation validator declares exactly the
//     known columns, so unknown keys are packed into the `extra` bytes
//     column (sealed) and unpacked on read. Nothing is dropped.

import { randomUUID } from "node:crypto";

import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { openJson, sealJson } from "../encryption.js";
import { getReactiveConvexClient } from "./client.js";

import type {
	ResolvedSession,
	SessionEntry,
	SessionStore,
	SubagentSessionMetadata,
	Unsub,
} from "../store.js";

interface Deps { client: ConvexHttpClient }

/** Entry fields with dedicated columns; everything else rides `extra`. */
const KNOWN_FIELDS = new Set([
	"sessionId",
	"createdAt",
	"lastUsedAt",
	"provider",
	"modelId",
	"authProfile",
	"thinkingLevel",
	"subagent",
]);

function isoToMs(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return ms;
	}
	return undefined;
}

function msToIso(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value).toISOString();
	}
	if (typeof value === "string") return value;
	return new Date(0).toISOString();
}

/** Filesystem-shaped entry (or partial patch) → upsertEntry mutation args. */
function entryToMutationArgs(patch: Partial<SessionEntry>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const createdAt = isoToMs(patch.createdAt);
	if (createdAt !== undefined) out.createdAt = createdAt;
	const lastUsedAt = isoToMs(patch.lastUsedAt);
	if (lastUsedAt !== undefined) out.lastUsedAt = lastUsedAt;
	if (patch.provider !== undefined) out.provider = patch.provider;
	if (patch.modelId !== undefined) out.modelId = patch.modelId;
	if (patch.authProfile !== undefined) out.authProfile = patch.authProfile;
	if (patch.thinkingLevel !== undefined) out.thinkingLevel = patch.thinkingLevel;
	if (patch.subagent !== undefined) out.subagent = patch.subagent;
	const extras: Record<string, unknown> = {};
	let hasExtras = false;
	for (const [key, value] of Object.entries(patch)) {
		if (KNOWN_FIELDS.has(key) || value === undefined) continue;
		extras[key] = value;
		hasExtras = true;
	}
	if (hasExtras) out.extra = sealJson(extras);
	return out;
}

/** Convex row → filesystem-shaped SessionEntry. */
function rowToEntry(row: Record<string, unknown>): SessionEntry {
	const entry: SessionEntry = {
		sessionId: row.sessionId as string,
		createdAt: msToIso(row.createdAt),
		lastUsedAt: msToIso(row.lastUsedAt),
	};
	if (row.provider !== undefined) entry.provider = row.provider as string;
	if (row.modelId !== undefined) entry.modelId = row.modelId as string;
	if (row.authProfile !== undefined) entry.authProfile = row.authProfile as string;
	if (row.thinkingLevel !== undefined) entry.thinkingLevel = row.thinkingLevel as string;
	if (row.subagent !== undefined) {
		entry.subagent = row.subagent as unknown as SessionEntry["subagent"];
	}
	if (row.extra !== undefined) {
		const extras = openJson<Record<string, unknown>>(row.extra as ArrayBuffer);
		if (extras) {
			for (const [key, value] of Object.entries(extras)) {
				if (!KNOWN_FIELDS.has(key)) entry[key] = value;
			}
		}
	}
	return entry;
}

export class ConvexSessionStore implements SessionStore {
	constructor(private readonly deps: Deps) {}

	async resolveOrCreate(args: {
		agentId: string;
		sessionKey: string;
		overrides?: Partial<SessionEntry>;
		freshnessMs?: number;
	}): Promise<ResolvedSession> {
		const existingRow = (await this.deps.client.query(api.sessions.getEntry, {
			agentId: args.agentId,
			sessionKey: args.sessionKey,
		})) as Record<string, unknown> | null;

		const now = Date.now();
		const overrideArgs = entryToMutationArgs(args.overrides ?? {});

		if (existingRow && args.freshnessMs && args.freshnessMs > 0) {
			const lastUsedAt = (existingRow.lastUsedAt as number | undefined) ?? 0;
			if (now - lastUsedAt > args.freshnessMs) {
				// Stale — roll a new sessionId. Mirrors the filesystem path:
				// subagent metadata is deliberately dropped on roll (the merge
				// mutation only ADDS subagent when the row has none, so a roll
				// must delete + reinsert to clear it).
				await this.deps.client.mutation(api.sessions.deleteEntry, {
					agentId: args.agentId,
					sessionKey: args.sessionKey,
				});
				const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
					agentId: args.agentId,
					sessionKey: args.sessionKey,
					sessionId: randomUUID(),
					createdAt: now,
					lastUsedAt: now,
					...overrideArgs,
				})) as Record<string, unknown>;
				return { entry: rowToEntry(row), created: true };
			}
		}
		if (existingRow) {
			const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
				agentId: args.agentId,
				sessionKey: args.sessionKey,
				sessionId: existingRow.sessionId as string,
				lastUsedAt: now,
				...overrideArgs,
			})) as Record<string, unknown>;
			return { entry: rowToEntry(row), created: false };
		}
		const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
			agentId: args.agentId,
			sessionKey: args.sessionKey,
			sessionId: randomUUID(),
			createdAt: now,
			lastUsedAt: now,
			...overrideArgs,
		})) as Record<string, unknown>;
		return { entry: rowToEntry(row), created: true };
	}

	async getEntry(agentId: string, sessionKey: string): Promise<SessionEntry | undefined> {
		const row = (await this.deps.client.query(api.sessions.getEntry, {
			agentId,
			sessionKey,
		})) as Record<string, unknown> | null;
		return row ? rowToEntry(row) : undefined;
	}

	async upsertEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry> {
		const existing = await this.getEntry(agentId, sessionKey);
		const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
			agentId,
			sessionKey,
			sessionId:
				(patch.sessionId as string | undefined) ??
				(existing as { sessionId?: string } | undefined)?.sessionId ??
				randomUUID(),
			...entryToMutationArgs(patch),
		})) as Record<string, unknown>;
		return rowToEntry(row);
	}

	async updateEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry | null> {
		const existing = await this.getEntry(agentId, sessionKey);
		if (!existing) return null;
		return this.upsertEntry(agentId, sessionKey, patch);
	}

	async deleteEntry(agentId: string, sessionKey: string): Promise<boolean> {
		return (await this.deps.client.mutation(api.sessions.deleteEntry, {
			agentId,
			sessionKey,
		})) as boolean;
	}

	async listEntries(
		agentId: string,
		filter?: { isolatedCronRunOlderThanMs?: number; subagentOnly?: boolean },
	): Promise<Array<{ sessionKey: string; entry: SessionEntry }>> {
		const rows = (await this.deps.client.query(api.sessions.listEntries, {
			agentId,
			...(filter?.subagentOnly !== undefined ? { subagentOnly: filter.subagentOnly } : {}),
		})) as Array<Record<string, unknown>>;
		const now = Date.now();
		const cutoff =
			filter?.isolatedCronRunOlderThanMs !== undefined
				? now - filter.isolatedCronRunOlderThanMs
				: undefined;
		return rows
			.filter((r) => {
				if (cutoff === undefined) return true;
				const sk = r.sessionKey as string;
				if (!sk.startsWith("isolated:cron:")) return false;
				const last = (r.lastUsedAt as number | undefined) ?? 0;
				return last < cutoff;
			})
			.map((r) => ({ sessionKey: r.sessionKey as string, entry: rowToEntry(r) }));
	}

	async readSubagentMetadata(
		agentId: string,
		sessionKey: string,
	): Promise<SubagentSessionMetadata | undefined> {
		const entry = await this.getEntry(agentId, sessionKey);
		const subagent = (entry as { subagent?: unknown } | undefined)?.subagent;
		return subagent ? (subagent as unknown as SubagentSessionMetadata) : undefined;
	}

	async listSubagentEntries(
		agentId: string,
	): Promise<
		Array<{ sessionKey: string; entry: SessionEntry; subagent: SubagentSessionMetadata }>
	> {
		const rows = (await this.deps.client.query(api.sessions.listEntries, {
			agentId,
			subagentOnly: true,
		})) as Array<Record<string, unknown>>;
		return rows.map((r) => {
			const entry = rowToEntry(r);
			return {
				sessionKey: r.sessionKey as string,
				entry,
				subagent: (entry.subagent ?? {}) as unknown as SubagentSessionMetadata,
			};
		});
	}

	subscribe(agentId: string, cb: (entries: SessionEntry[]) => void): Unsub {
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.sessions.listEntries,
			{ agentId },
			(rows) => {
				try {
					cb((rows as Array<Record<string, unknown>>).map(rowToEntry));
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
}

/** Exported for the session-cache dispatcher + tests. */
export const __sessionMarshalling = { entryToMutationArgs, rowToEntry };
