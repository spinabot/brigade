/**
 * Brigade memory tools — Primitive #4. Three tools:
 *
 *   - `recall_memory` — recall (hybrid BM25 + vector) over the structured
 *     fact store (memory/facts.jsonl, via FactStore), plus lexical search
 *     over MEMORY.md / memory/*.md daily notes (markdown, via BrigadeStorage).
 *   - `read_memory`   — bounded excerpt read of one memory file.
 *   - `write_memory`  — persist a structured durable fact: one sentence +
 *     segment + importance. Recall hits bump the fact's accessCount (decay
 *     reinforcement); the post-turn extraction subagent writes through
 *     the same store.
 *
 * Search + persistence are routed through a `MemoryCapability` — the SDK seam
 * (`extension-sdk` → `b.memory(...)`). When a plugin pins
 * `extensions.slots.memory` to its id, `recall_memory` / `write_memory`
 * delegate to that plugin's backend (vector DB, knowledge graph, etc.). When
 * unset, the bundled default backend wraps the file-based `FactStore` +
 * `FileMemoryStore` and renders the same rich notes+facts output the tool
 * has always produced — back-compat is total.
 *
 * `read_memory` reads MEMORY.md / memory/*.md by path; it's a filesystem
 * concern (not part of the memory-capability contract) so it stays bound to
 * the `BrigadeStorage` view.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { MemoryCapability } from "../extensions/types.js";
import {
	BrigadeMemoryPathError,
	type BrigadeStorage,
	type MemoryReadResult,
	type MemorySearchResult,
} from "../memory/storage.js";
import {
	type FactStore,
	MEMORY_SEGMENTS,
	type MemorySegment,
	type MemoryRecordOrigin,
	type RecordOriginFilter,
} from "../memory/records.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import {
	createDefaultMemoryCapability,
	type DefaultMemoryHit,
	isDefaultMemoryCapability,
} from "../memory/plugin-runtime.js";
import { readNumberParam, readStringParam, textResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

/**
 * Per-turn caller scope threaded into every memory tool. Mirrors the
 * shape used by the cron tool's per-call gate — the registry stamps
 * these onto each tool factory so the tool body can compute the right
 * `MemoryRecordOrigin` for writes + the matching recall filter.
 *
 * `senderIsOwner` defaults to `true` (legacy / TUI / tests). When the
 * gateway routes an approved channel peer's turn, it sets
 * `senderIsOwner: false`, supplies the `channelContext`, and threads
 * the channel-derived `sessionKey` so writes get stamped with the
 * peer's session-scoped origin and recalls filter to the same.
 */
export interface MemoryToolScope {
	senderIsOwner?: boolean;
	channelContext?: ChannelApprovalRoute;
	sessionKey?: string;
}

/**
 * Compute the {@link MemoryRecordOrigin} the per-call gate should stamp
 * onto every new fact for this turn. Owner turns produce `{ kind:
 * "owner" }`; channel-routed peer turns produce a session-scoped
 * channel origin. A non-owner turn without a `channelContext` is a
 * malformed path — we return `undefined` so the caller can refuse the
 * write with a clear message rather than silently writing an
 * unattributable record.
 */
export function resolveWriterOrigin(
	scope: MemoryToolScope,
): MemoryRecordOrigin | undefined {
	if (scope.senderIsOwner !== false) return { kind: "owner" };
	const ctx = scope.channelContext;
	if (!ctx || !scope.sessionKey) return undefined;
	return {
		kind: "channel",
		channelId: ctx.channelId,
		conversationId: ctx.conversationId,
		sessionKey: scope.sessionKey,
		...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
	};
}

/**
 * Compute the recall-side {@link RecordOriginFilter} for this turn.
 * Owners recall ONLY owner-origin records (peer state is invisible to
 * the operator's auto-recall by design — keeps the operator's view of
 * memory clean of peer-written content). Non-owners recall only their
 * own session's records.
 *
 * `undefined` means the caller is in a state where we can't safely
 * decide a filter (non-owner without channelContext) — callers treat
 * this as "no results" rather than leaking the whole store.
 */
export function resolveRecallFilter(
	scope: MemoryToolScope,
): RecordOriginFilter | "no-results" {
	if (scope.senderIsOwner !== false) return { kind: "owner" };
	const ctx = scope.channelContext;
	if (!ctx || !scope.sessionKey) return "no-results";
	return {
		kind: "channel",
		channelId: ctx.channelId,
		conversationId: ctx.conversationId,
		sessionKey: scope.sessionKey,
		...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
	};
}

/* ───────────────────────── recall_memory (search) ───────────────────────── */

const RecallMemoryParams = Type.Object({
	query: Type.String({
		description:
			"What to look for in memory. Free text — keywords or a phrase. " +
			"Searches MEMORY.md plus the daily notes under memory/.",
	}),
	maxResults: Type.Optional(
		Type.Number({
			description: "Maximum number of memory snippets to return (default 8).",
		}),
	),
});

interface RecalledFact {
	memoryId: string;
	content: string;
	segment: string;
	importance: number;
	score: number;
	/** The single-valued attribute slot, if any — surfaced so a correction can
	 *  reuse the SAME subjectKey and auto-supersede this value. */
	subjectKey?: string;
}

/**
 * Plugin-shaped hit row surfaced when a non-default `MemoryCapability` is
 * active. Mirrors the public SDK contract so consumers can render either
 * the rich default layout or the minimal plugin layout from one details
 * shape.
 */
interface PluginRecalledItem {
	id: string;
	content: string;
	score: number;
	source: "memory" | "session";
}

interface RecallMemoryDetails {
	query: string;
	resultCount: number;
	/** File:line note hits (default backend only). */
	results: MemorySearchResult[];
	/** Structured fact hits (default backend only). */
	facts: RecalledFact[];
	/** Plugin-backend hits when a non-default capability handled the call. */
	pluginHits?: PluginRecalledItem[];
	/** Active backend id (`brigade.memory.default` or a plugin id). */
	backend: string;
}

/**
 * Build the `recall_memory` tool. Searches go through the active
 * `MemoryCapability` — bundled default (FactStore + FileMemoryStore) when
 * no plugin is pinned, or a registered plugin backend (vector DB / KG / …)
 * when `extensions.slots.memory` selects one.
 *
 * Back-compat: when no `capability` is supplied OR a `factStore` is supplied
 * directly, the tool builds a default-backed capability over the same stores
 * — the existing tests + the registry's pre-capability call sites keep
 * working unchanged.
 */
export function makeRecallMemoryTool(
	storeOrCapability: BrigadeStorage | MemoryCapability,
	factStoreOrNothing?: FactStore,
	scope: MemoryToolScope = {},
): BrigadeTool<typeof RecallMemoryParams, RecallMemoryDetails> {
	// Resolve the capability up front. Three calling shapes:
	//   1. `(capability)`              — production path (registry passes one).
	//   2. `(store)`                   — legacy: notes-only default backend
	//                                    synthesized over the supplied store.
	//   3. `(store, factStore)`        — legacy: full default backend over the
	//                                    supplied stores (memory-tools.test.ts).
	const capability = resolveToolCapability(storeOrCapability, factStoreOrNothing);
	return {
		name: "recall_memory",
		label: "recall memory",
		displaySummary: "searching memory",
		description:
			"Search your durable memory — structured facts plus MEMORY.md and memory/*.md daily " +
			"notes — for relevant remembered context. Use this for questions about prior work, " +
			"decisions, dates, people, preferences, or todos. Do NOT use this for live inventory " +
			"(which agents/channels/skills/cron jobs/files exist) — that comes from `agents_list`, " +
			"`ls`, etc. Returns matching facts and scored note snippets " +
			"(with file + line range); follow up with read_memory to pull the full surrounding " +
			"text of a note.",
		parameters: RecallMemoryParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<RecallMemoryDetails>> {
			const query = readStringParam(params as Record<string, unknown>, "query", {
				required: true,
				label: "query",
			});
			const maxResults = readNumberParam(params as Record<string, unknown>, "maxResults", {
				integer: true,
				label: "maxResults",
			});
			// Resolve the per-turn recall scope BEFORE searching. A non-
			// owner caller with no channelContext returns "no-results" — we
			// must not leak the whole store, but we also don't want to
			// surface this as a hard error (the LLM might fall back to
			// asking the user). Empty result + a neutral message.
			const recallFilter = resolveRecallFilter(scope);
			if (recallFilter === "no-results") {
				const details: RecallMemoryDetails = {
					query,
					resultCount: 0,
					results: [],
					facts: [],
					backend: capability.id,
				};
				return textResult(
					`No memory matched "${query}". Nothing is visible to this turn — ` +
						"the turn doesn't have an approved channel context, so peer-scoped " +
						"memory can't be searched.",
					details,
				);
			}
			// Default backend → render the rich notes+facts layout (file:line
			// citations, segment + importance). Plugin backend → render the
			// minimal SDK shape (id / content / score / source).
			if (isDefaultMemoryCapability(capability)) {
				const { notes: rawNotes, facts } = await capability.searchRich(
					query,
					{
						...(maxResults !== undefined ? { limit: maxResults } : {}),
						origin: recallFilter,
					},
				);
				// Markdown NOTES (MEMORY.md + memory/*.md) are OPERATOR-authored
				// workspace content with no per-peer scoping — they are owner-only.
				// `facts` are origin-filtered inside searchRich, but notes are not (and
				// can't be — they're the operator's files), so a channel-peer turn must
				// never see them. Gate the whole notes lane on owner origin here, in the
				// tool, so it holds regardless of which capability is wired.
				const notes = recallFilter?.kind === "owner" ? rawNotes : [];
				const factHits = facts.map((f) => ({
					memoryId: f.memoryId,
					content: f.content,
					segment: f.segment,
					importance: f.importance,
					score: f.score,
					...(f.subjectKey ? { subjectKey: f.subjectKey } : {}),
				}));
				const details: RecallMemoryDetails = {
					query,
					resultCount: notes.length + factHits.length,
					results: notes,
					facts: factHits,
					backend: capability.id,
				};
				if (notes.length === 0 && factHits.length === 0) {
					return textResult(
						`No memory matched "${query}". Nothing has been noted about this yet — ` +
							`if it's worth remembering, use write_memory (or jot it in memory/<today>.md).`,
						details,
					);
				}
				const sections: string[] = [];
				if (factHits.length > 0) {
					sections.push(
						"Facts:\n" +
							factHits
								.map(
									(f) =>
										`- [id ${f.memoryId}${f.subjectKey ? ` · slot ${f.subjectKey}` : ""} · ${f.segment}] ${f.content} (importance ${f.importance.toFixed(2)})`,
								)
								.join("\n") +
							"\nTo correct one of these: re-write with the SAME subjectKey shown (slot …) to auto-supersede it, or pass its id in supersedes.",
					);
				}
				if (notes.length > 0) {
					sections.push(
						"Notes:\n" +
							notes
								.map((r, i) => {
									const loc = `${r.relPath}:${r.startLine}-${r.endLine}`;
									return `[${i + 1}] ${loc} (score ${r.score.toFixed(1)})\n${r.snippet}`;
								})
								.join("\n\n"),
					);
				}
				return textResult(
					`Found ${details.resultCount} memory match${details.resultCount === 1 ? "" : "es"} for "${query}":\n\n${sections.join("\n\n")}`,
					details,
				);
			}

			// Plugin backend — minimal SDK shape. The plugin owns ranking +
			// scoring; we render id / content / score / source so the model
			// still sees actionable context (and the plugin's id, so a debug
			// transcript shows which backend handled the call).
			// Thread the per-origin sessionKey into the plugin search the SAME way
			// auto-recall does — without it a channel-routed peer's recall is
			// unscoped and the plugin returns the operator's + other peers' facts
			// (a cross-origin leak). An owner origin intentionally omits sessionKey.
			const channelSessionKey =
				recallFilter?.kind === "channel" ? recallFilter.sessionKey : undefined;
			const hits = await capability.search(query, {
				...(maxResults !== undefined ? { limit: maxResults } : {}),
				...(channelSessionKey ? { sessionKey: channelSessionKey } : {}),
			});
			const pluginHits: PluginRecalledItem[] = hits.map((h) => ({
				id: h.id,
				content: h.content,
				score: h.score,
				source: h.source,
			}));
			const details: RecallMemoryDetails = {
				query,
				resultCount: pluginHits.length,
				results: [],
				facts: [],
				pluginHits,
				backend: capability.id,
			};
			if (pluginHits.length === 0) {
				return textResult(
					`No memory matched "${query}". Nothing has been noted about this yet — ` +
						`if it's worth remembering, use write_memory (or jot it in memory/<today>.md).`,
					details,
				);
			}
			const lines = pluginHits
				.map((h, i) => `[${i + 1}] (${h.source}, score ${h.score.toFixed(2)}) ${h.content}`)
				.join("\n");
			return textResult(
				`Found ${pluginHits.length} memory match${pluginHits.length === 1 ? "" : "es"} for "${query}" via ${capability.id}:\n\n${lines}`,
				details,
			);
		},
	};
}

/* ───────────────────────── read_memory (get) ───────────────────────── */

const ReadMemoryParams = Type.Object({
	path: Type.String({
		description:
			'Memory file to read. Either "MEMORY.md" or "memory/<name>.md" ' +
			"(e.g. a daily note like memory/2026-05-21.md). Relative to the workspace.",
	}),
	from: Type.Optional(
		Type.Number({ description: "1-based line to start reading from (default 1)." }),
	),
	lines: Type.Optional(
		Type.Number({ description: "Number of lines to read (default 200, max 1000)." }),
	),
});

interface ReadMemoryDetails {
	read?: MemoryReadResult;
	status: "ok" | "failed";
	error?: string;
}

/**
 * Build the `read_memory` tool bound to a storage instance. Filesystem-only
 * (reads `MEMORY.md` / `memory/<name>.md`) — NOT routed through the memory
 * capability, because alternative backends (vector DB, KG) may not have a
 * literal file path to read from. Keep this on the file store.
 */
export function makeReadMemoryTool(
	store: BrigadeStorage,
): BrigadeTool<typeof ReadMemoryParams, ReadMemoryDetails> {
	return {
		name: "read_memory",
		label: "read memory",
		displaySummary: "reading memory",
		ownerOnly: true,
		description:
			"Read a bounded excerpt of a memory file (MEMORY.md or a memory/<name>.md daily " +
			"note). Use after recall_memory to pull the full context around a snippet. " +
			"Reads are line-windowed; if the result is truncated, read again from the " +
			"reported next line.",
		parameters: ReadMemoryParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadMemoryDetails>> {
			const relPath = readStringParam(params as Record<string, unknown>, "path", {
				required: true,
				label: "path",
			});
			const from = readNumberParam(params as Record<string, unknown>, "from", {
				integer: true,
				label: "from",
			});
			const lines = readNumberParam(params as Record<string, unknown>, "lines", {
				integer: true,
				label: "lines",
			});
			try {
				const result = await store.read(relPath, {
					...(from !== undefined ? { from } : {}),
					...(lines !== undefined ? { lines } : {}),
				});
				const header = result.truncated
					? `${result.relPath} (lines ${result.from}-${result.from + result.lines - 1}, more from line ${result.nextFrom}):`
					: `${result.relPath} (lines ${result.from}-${result.from + result.lines - 1}):`;
				return textResult(`${header}\n\n${result.text}`, {
					status: "ok",
					read: result,
				});
			} catch (err) {
				// Path-scope violations + missing files surface as a clear
				// tool-result the model can act on (search instead, or write
				// the file). Re-throw anything unexpected so Pi logs it.
				if (err instanceof BrigadeMemoryPathError) {
					return textResult(err.message, { status: "failed", error: err.message });
				}
				throw err;
			}
		},
	};
}

/* ───────────────────────── write_memory ───────────────────────── */

const WriteMemoryParams = Type.Object({
	content: Type.String({
		description:
			"One clear declarative sentence to remember durably. " +
			'E.g. "The user prefers spaces over tabs." Keep it self-contained.',
	}),
	segment: Type.Union(
		MEMORY_SEGMENTS.map((s) => Type.Literal(s)),
		{
			description:
				"What kind of fact: identity (who they are) · preference (how they like things) · " +
				"correction (fixing a prior belief — set supersedes) · relationship (people) · " +
				"project (work/conventions) · knowledge (durable facts) · context (ongoing state).",
		},
	),
	importance: Type.Optional(
		Type.Number({ description: "0..1 importance. Omit to use the segment's default." }),
	),
	supersedes: Type.Optional(
		Type.Array(Type.String(), {
			description: "memoryIds this fact replaces (use for corrections/updates).",
		}),
	),
	subjectKey: Type.Optional(
		Type.String({
			description:
				"For a SINGLE-VALUED attribute that has one current value — where they live, " +
				'their deploy day, a setting — pass a short stable snake_case slot name (e.g. "deploy_day", ' +
				'"home_city", "ui_theme"). A new fact with the SAME subjectKey AUTOMATICALLY supersedes the ' +
				"old value (no need to recall its id). Reuse the exact subjectKey shown in recall results. " +
				"OMIT for additive facts that should coexist (pets, skills, people).",
		}),
	),
});

interface WriteMemoryDetails {
	memoryId: string;
	segment: string;
	/**
	 * Importance the backend persisted. The default backend always resolves a
	 * concrete value (segment default when omitted), so it's a number there.
	 * A plugin backend owns its own importance handling and may not surface
	 * one — when the caller omitted `importance`, this stays `undefined`
	 * rather than reporting a misleading `0` the plugin never persisted.
	 */
	importance?: number;
	backend: string;
}

/**
 * Build the `write_memory` tool. Routes through the active memory capability
 * — default backend (file `FactStore`) for back-compat, OR a plugin's
 * `recordFact` when `extensions.slots.memory` pins one.
 *
 * Default backend → preserves the existing rich return (segment / importance
 * with two-decimal formatting) because we know we're talking to `FactStore`.
 * Plugin backend → uses the SDK `recordFact` contract and reports the
 * plugin's returned id.
 *
 * Legacy callers that pass a raw `FactStore` still work — we wrap it in a
 * default capability internally so the tool body is one path.
 */
export function makeWriteMemoryTool(
	capabilityOrFactStore: MemoryCapability | FactStore,
	scope: MemoryToolScope = {},
): BrigadeTool<typeof WriteMemoryParams, WriteMemoryDetails> {
	const capability = resolveWriteCapability(capabilityOrFactStore);
	const senderIsOwner = scope.senderIsOwner !== false;
	return {
		name: "write_memory",
		label: "write memory",
		displaySummary: "saving to memory",
		description:
			"Persist a durable fact to long-term memory. Prefer aggressive writing — memory is " +
			"cheap, forgetting is expensive. Save the user's identity, preferences, corrections, " +
			"project conventions, relationships, and ongoing context. Skip transient things " +
			'("I\'m tired right now"). One clear sentence per fact. CORRECTING something the ' +
			"user already told you? Use segment=correction — the new fact AUTOMATICALLY supersedes " +
			"the same-subject belief you had saved (no need to recall its id). For extra precision on " +
			"a single-valued attribute (where they live, deploy day, a setting) also pass a stable " +
			"subjectKey (e.g. deploy_day); or pass the prior fact's id in supersedes for an explicit replace.",
		parameters: WriteMemoryParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<WriteMemoryDetails>> {
			const p = params as Record<string, unknown>;
			const content = readStringParam(p, "content", { required: true, label: "content" });
			const segment = readStringParam(p, "segment", {
				required: true,
				label: "segment",
			}) as MemorySegment;
			const importance = readNumberParam(p, "importance", { label: "importance" });
			const supersedes = Array.isArray(p.supersedes)
				? (p.supersedes as unknown[]).filter((x): x is string => typeof x === "string")
				: undefined;
			const subjectKey = readStringParam(p, "subjectKey", { label: "subjectKey" });

			// Resolve the writer's origin BEFORE touching the store. A
			// non-owner turn without a channelContext or sessionKey is a
			// malformed routing path — refuse rather than silently writing
			// an unattributable record that no one could ever recall.
			const writerOrigin = resolveWriterOrigin(scope);
			if (!senderIsOwner && !writerOrigin) {
				return textResult(
					"write_memory: as a non-owner-routed turn you must be reached through an approved channel.",
					{
						memoryId: "",
						segment,
						importance: 0,
						backend: capability.id,
					},
				);
			}

			// Default backend → speak directly to FactStore so we keep the rich
			// per-segment defaults + supersedes archiving + the new
			// session-scoped origin stamp. Plugin backend → route through
			// the SDK contract; pass segment / importance / supersedes via
			// the `meta` bag, and stringify `createdBy` so plugins that
			// want to honour it can.
			if (isDefaultMemoryCapability(capability)) {
				const rec = capability.factStore.write({
					content,
					segment,
					...(importance !== undefined ? { importance } : {}),
					...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
					...(subjectKey ? { subjectKey } : {}),
					...(writerOrigin !== undefined ? { createdBy: writerOrigin } : {}),
				});
				return textResult(
					`Remembered [${rec.segment}, importance ${rec.importance.toFixed(2)}]: ${rec.content}`,
					{
						memoryId: rec.memoryId,
						segment: rec.segment,
						importance: rec.importance,
						backend: capability.id,
					},
				);
			}

			// Plugin backend — `meta` keys are string-typed by the SDK
			// contract; stringify numerics / arrays so any plugin can read them.
			const meta: Record<string, string> = { segment };
			if (importance !== undefined) meta.importance = String(importance);
			if (supersedes && supersedes.length > 0) meta.supersedes = supersedes.join(",");
			if (subjectKey) meta.subjectKey = subjectKey;
			if (writerOrigin !== undefined) {
				// Plugins that want to honour origin can parse this JSON;
				// the bundled FactStore does it natively via `createdBy`.
				meta.createdBy = JSON.stringify(writerOrigin);
			}
			const { id } = await capability.recordFact(content, { meta });
			return textResult(
				`Remembered [${segment}] via ${capability.id}: ${content}`,
				{
					memoryId: id,
					segment,
					// Report what the caller supplied (undefined when omitted) —
					// the plugin owns importance and we must not invent a `0` it
					// never persisted.
					...(importance !== undefined ? { importance } : {}),
					backend: capability.id,
				},
			);
		},
	};
}

/* ───────────────────────── helpers ───────────────────────── */

/**
 * Resolve a `MemoryCapability` from the recall-tool factory's overloaded
 * arguments. The three legacy shapes — `(capability)`, `(store)`,
 * `(store, factStore)` — all collapse to one capability instance for the
 * tool body to consume.
 */
function resolveToolCapability(
	storeOrCapability: BrigadeStorage | MemoryCapability,
	factStoreOrNothing: FactStore | undefined,
): MemoryCapability {
	if (isMemoryCapability(storeOrCapability)) {
		return storeOrCapability;
	}
	// Legacy `(store)` / `(store, factStore)` — build a default capability
	// that reuses the supplied stores. We can't construct one through
	// `createDefaultMemoryCapability` (which makes its own stores from a
	// workspaceDir), so we synthesize the same shape inline with the
	// caller's stores. `workspaceDir` is unknown here, so we ALSO need to
	// keep the supplied stores reachable — store + factStore are the
	// underlying state, full stop.
	const fileStore = storeOrCapability as BrigadeStorage;
	const factStore = factStoreOrNothing;
	return {
		id: "brigade.memory.default",
		label: "Brigade file-based memory (built-in)",
		// Cast to the rich extended shape so isDefaultMemoryCapability(…)
		// finds the searchRich/fileStore/factStore fields when this synthetic
		// capability comes back through resolveToolCapability.
		fileStore,
		factStore: factStore ?? undefinedFactStoreSentinel(),
		async searchRich(query: string, opts?: { limit?: number; origin?: RecordOriginFilter }) {
			const limit = opts?.limit;
			const origin = opts?.origin;
			const notes = await fileStore.search(query, limit !== undefined ? { maxResults: limit } : {});
			const factOpts: { limit?: number; origin?: RecordOriginFilter } = {};
			if (limit !== undefined) factOpts.limit = limit;
			if (origin !== undefined) factOpts.origin = origin;
			const facts = factStore?.recall(query, factOpts) ?? [];
			return { notes, facts };
		},
		async search(query: string, opts?: { limit?: number }) {
			const limit = opts?.limit;
			const notes = await fileStore.search(query, limit !== undefined ? { maxResults: limit } : {});
			const facts = factStore?.recall(query, limit !== undefined ? { limit } : {}) ?? [];
			const factHits: DefaultMemoryHit[] = facts.map((f) => ({
				id: f.memoryId,
				content: f.content,
				score: f.score,
				source: "memory",
				kind: "fact",
				segment: f.segment,
				importance: f.importance,
				accessCount: f.accessCount,
			}));
			const noteHits: DefaultMemoryHit[] = notes.map((n) => ({
				id: `${n.relPath}:${n.startLine}-${n.endLine}`,
				content: n.snippet,
				score: n.score,
				source: "session",
				kind: "note",
				relPath: n.relPath,
				startLine: n.startLine,
				endLine: n.endLine,
				snippet: n.snippet,
			}));
			return [...factHits, ...noteHits];
		},
		async recordFact(content: string, opts?: { meta?: Record<string, string> }) {
			if (!factStore) {
				throw new Error(
					"recordFact called on recall-only memory backend (no factStore wired)",
				);
			}
			const meta = opts?.meta ?? {};
			const segment = (meta.segment as string | undefined) ?? "context";
			const rec = factStore.write({ content, segment: segment as never });
			return { id: rec.memoryId };
		},
		async status() {
			const itemCount = factStore?.list({ lifecycle: "active" }).length ?? 0;
			return { ready: true, itemCount };
		},
	} as MemoryCapability;
}

/**
 * Resolve a capability from the write-tool's overloaded argument — accepts
 * either a `MemoryCapability` (production path) or a raw `FactStore`
 * (legacy tests). The FactStore case is wrapped in a default-shaped
 * capability so the tool body has one code path.
 */
function resolveWriteCapability(
	capabilityOrFactStore: MemoryCapability | FactStore,
): MemoryCapability {
	if (isMemoryCapability(capabilityOrFactStore)) {
		return capabilityOrFactStore;
	}
	const factStore = capabilityOrFactStore;
	// `searchRich` / `fileStore` are stubbed because write_memory only ever
	// touches `factStore.write` on the default branch. Tests that build a
	// write tool from a raw FactStore never call search through it.
	return {
		id: "brigade.memory.default",
		label: "Brigade file-based memory (built-in)",
		factStore,
		async searchRich(_query: string, _opts?: { limit?: number }) {
			return { notes: [], facts: [] };
		},
		async search(_query: string, _opts?: { limit?: number }) {
			return [];
		},
		async recordFact(content: string, opts?: { meta?: Record<string, string> }) {
			const meta = opts?.meta ?? {};
			const segment = (meta.segment as string | undefined) ?? "context";
			const rec = factStore.write({ content, segment: segment as never });
			return { id: rec.memoryId };
		},
		async status() {
			return { ready: true, itemCount: factStore.list({ lifecycle: "active" }).length };
		},
	} as MemoryCapability;
}

/** Duck-type check — a capability has `search` AND `recordFact`. */
function isMemoryCapability(x: unknown): x is MemoryCapability {
	return (
		!!x &&
		typeof x === "object" &&
		typeof (x as { search?: unknown }).search === "function" &&
		typeof (x as { recordFact?: unknown }).recordFact === "function"
	);
}

/**
 * Sentinel used when the legacy `makeRecallMemoryTool(store)` shape is built
 * WITHOUT a factStore — recordFact on the synthesized capability would throw,
 * but the tool only ever calls search through it. Returning a never-touched
 * placeholder keeps the type system happy without sneaking a usable
 * FactStore into the shape.
 */
function undefinedFactStoreSentinel(): FactStore {
	return undefined as unknown as FactStore;
}
