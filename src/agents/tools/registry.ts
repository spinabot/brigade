/**
 * Brigade tool registry.
 *
 * Factory that builds the array of Brigade-native custom tools passed to
 * Pi's `createAgentSession({customTools})` slot. Today it returns the three
 * Primitive #4 memory tools — `recall_memory` (lexical search across markdown
 * notes + the structured fact store), `read_memory` (fetch a specific note),
 * and `write_memory` (persist a structured fact) — alongside Pi's built-in
 * tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`). `spawn_agent`
 * ships with Primitive #6 (sub-agents).
 *
 * The factory is plumbed through `session-wiring.ts` (the single
 * tool-assembly seam) so adding a tool later is a one-line change in
 * `createBrigadeTools` rather than a multi-file rewire.
 *
 * Tool-factory pattern with Brigade-native naming and a deliberately
 * narrow scope (no plugins, no channels, no MCP).
 */

import type { MemoryCapability } from "../extensions/types.js";
import { FileMemoryStore } from "../memory/storage.js";
import {
	createDefaultMemoryCapability,
	isDefaultMemoryCapability,
} from "../memory/plugin-runtime.js";
import {
	DEFAULT_SUBAGENT_MAX_DEPTH,
	filterToolsForSubagentDepth,
} from "../subagent-policy.js";
import { getActiveCronService } from "../../cron/active-service.js";
import { makeCronTool } from "./cron-tool.js";
import { makeReadMemoryTool, makeRecallMemoryTool, makeWriteMemoryTool } from "./memory-tools.js";
import { makeSpawnAgentTool } from "./spawn-agent-tool.js";
import type { AnyBrigadeTool } from "./types.js";

/**
 * Options threaded through to every Brigade-native tool. Each tool
 * picks the fields it needs; the rest are ignored.
 *
 * Per-field rationale:
 *   - `workspaceDir` — the absolute path to `~/.brigade/workspace/`.
 *     Persona-mutating tools (write_memory, recall_memory) resolve
 *     their target files under this root. The agent's session cwd
 *     defaults to this dir so Pi's built-in write/edit/read resolve
 *     relative paths into it naturally; Brigade-native tools take it
 *     as an explicit parameter so they're not coupled to that default.
 *   - `agentId` — the active agent id (default `"main"`). Sub-agent
 *     tools (`spawn_agent`) use this to scope nested sessions.
 *   - `cwd` — process cwd. Tools that need to resolve relative paths
 *     for read-only operations (grep / ls equivalents) can choose to
 *     resolve against cwd OR workspaceDir depending on intent.
 */
export interface CreateBrigadeToolsOptions {
	workspaceDir: string;
	agentId: string;
	cwd: string;
	/**
	 * Active memory backend. The agent loop resolves this via
	 * `resolveActiveMemoryCapability(...)` so a plugin pinned through
	 * `extensions.slots.memory` automatically owns recall + write. Omitted →
	 * the registry builds the built-in file-backed default (back-compat with
	 * pre-SDK call sites + tests).
	 */
	memoryCapability?: MemoryCapability;
	/**
	 * Sub-agent spawn context — Primitive #6. When provided, `spawn_agent` is
	 * registered so the model can delegate sub-tasks. When omitted, the tool is
	 * dropped (tests, unit-test paths, and any caller that doesn't want a
	 * `spawn_agent` surface get the legacy three-tool set).
	 *
	 * The depth at which the CHILD will run is `callerDepth + 1`. When that
	 * already equals `subagentMaxDepth`, the tool is also dropped — a leaf
	 * sub-agent cannot recursively spawn further sub-agents.
	 */
	subagentContext?: {
		/** Parent session key — drives the child key + the concurrency map. */
		parentSessionKey: string;
		/** Caller's depth (0 = top-level operator-driven turn). */
		callerDepth: number;
		/** Parent's run id (event correlation). */
		parentRunId?: string;
		/** Parent's abort signal — propagates cancellation to the child. */
		parentSignal?: AbortSignal;
		/**
		 * Parent's RESOLVED provider + modelId. The child inherits these unless
		 * the `spawn_agent` call explicitly overrides via the `model` param.
		 */
		parentProvider?: string;
		parentModelId?: string;
	};
	/** Max sub-agent depth — defaults to `DEFAULT_SUBAGENT_MAX_DEPTH` (1). */
	subagentMaxDepth?: number;
}

/**
 * Build Brigade's custom tool array — the THREE Primitive #4 memory tools
 * today (recall_memory, read_memory, write_memory); skills (#5) and
 * sub-agents (#6) add more later. Callers pass the result to Pi's
 * `customTools` option — Pi merges it with the `tools` allowlist (built-ins
 * by name) to form the full tool surface.
 *
 * The function takes options eagerly rather than late-binding so tests can
 * construct a deterministic registry without touching the filesystem.
 */
export function createBrigadeTools(opts: CreateBrigadeToolsOptions): AnyBrigadeTool[] {
	// Primitive #4 (Memory): the active backend is a `MemoryCapability` — bundled
	// default (file-based FactStore + FileMemoryStore) when no plugin is pinned,
	// or a registered plugin (vector DB, KG, …) when `extensions.slots.memory`
	// selects one. The agent loop resolves and passes `memoryCapability`; tests
	// and legacy call sites omit it and get the default.
	const capability =
		opts.memoryCapability ?? createDefaultMemoryCapability({
			workspaceDir: opts.workspaceDir,
			agentId: opts.agentId,
		});
	// `read_memory` is filesystem-only (bounded read of MEMORY.md /
	// memory/<name>.md), so it always binds to the file store. When the active
	// capability IS the bundled default we reuse its store; otherwise we
	// construct one over the same workspaceDir so the read tool keeps
	// working alongside a plugin-backed search.
	const fileStore = isDefaultMemoryCapability(capability)
		? capability.fileStore
		: new FileMemoryStore(opts.workspaceDir);
	const tools: AnyBrigadeTool[] = [
		// recall routes through the capability (rich render for the default,
		// minimal SDK render for plugins).
		makeRecallMemoryTool(capability),
		makeReadMemoryTool(fileStore),
		// write_memory persists distilled structured facts through the capability.
		makeWriteMemoryTool(capability),
	];
	// Primitive #6 — register `spawn_agent` only when the caller supplied a
	// parent context AND the child wouldn't be a leaf. `filterToolsForSubagentDepth`
	// owns the leaf check so the rule lives in one place; the registry just
	// passes the candidate tool array through it.
	if (opts.subagentContext) {
		const spawnAgentTool = makeSpawnAgentTool({
			parentSessionKey: opts.subagentContext.parentSessionKey,
			parentAgentId: opts.agentId,
			...(opts.subagentContext.parentRunId !== undefined
				? { parentRunId: opts.subagentContext.parentRunId }
				: {}),
			...(opts.subagentContext.parentSignal !== undefined
				? { parentSignal: opts.subagentContext.parentSignal }
				: {}),
			...(opts.subagentContext.parentProvider !== undefined
				? { parentProvider: opts.subagentContext.parentProvider }
				: {}),
			...(opts.subagentContext.parentModelId !== undefined
				? { parentModelId: opts.subagentContext.parentModelId }
				: {}),
		});
		const filtered = filterToolsForSubagentDepth({
			tools: [spawnAgentTool],
			callerDepth: opts.subagentContext.callerDepth,
			maxDepth: opts.subagentMaxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
		});
		tools.push(...filtered);
	}
	// Cron primitive — register the `cron` tool when the gateway daemon's
	// cron service is up. The agent uses it to add/list/run/wake jobs from
	// inside chat. `ownerOnly: true` ensures non-operator senders can't
	// mutate the cron set; the ownership wrapper at session-wiring rejects
	// their calls before they reach the action handler.
	const cronService = getActiveCronService();
	if (cronService) {
		tools.push(makeCronTool());
	}
	return tools;
}

/**
 * Names of Brigade-native tools shipped today. Used by the system-prompt
 * assembler to advertise tools by name in the `## Tooling` section AND by
 * `agent-loop.ts` to flip on the memory-capability prompt block.
 */
export function listBrigadeToolNames(): string[] {
	return ["recall_memory", "read_memory", "write_memory"];
}
