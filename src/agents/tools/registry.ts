/**
 * Brigade tool registry.
 *
 * Factory that builds the array of Brigade-native custom tools passed to
 * Pi's `createAgentSession({customTools})` slot. Today it returns the two
 * Primitive #4 memory read tools — `recall_memory` (lexical search across
 * memory files) and `read_memory` (fetch a specific file) — alongside Pi's
 * built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`).
 * The remaining Brigade-native tools (`write_memory`, `spawn_agent`) ship
 * with their primitives (#4 write path, #6 sub-agents).
 *
 * The factory is plumbed through `session-wiring.ts` (the single
 * tool-assembly seam) so adding a tool later is a one-line change in
 * `createBrigadeTools` rather than a multi-file rewire.
 *
 * Mirrors OpenClaw's pattern at `src/agents/openclaw-tools.ts:51-114`
 * (`createOpenClawTools` factory) with Brigade-native naming + a much
 * narrower scope (no plugins, no channels, no MCP).
 */

import { FileMemoryStore } from "../memory/storage.js";
import { makeReadMemoryTool, makeRecallMemoryTool } from "./memory-tools.js";
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
}

/**
 * Build Brigade's custom tool array. Returns an empty array today;
 * tools are added in Primitives #4 (memory), #5 (skills), #6
 * (sub-agents). Callers should pass the result directly to Pi's
 * `customTools` option — Pi merges it with the `tools` allowlist
 * (Pi's built-ins selected by name) to form the full tool surface
 * visible to the model.
 *
 * The function takes options eagerly rather than late-binding so
 * tests can construct a deterministic registry without touching the
 * filesystem.
 */
export function createBrigadeTools(opts: CreateBrigadeToolsOptions): AnyBrigadeTool[] {
	// Primitive #4 (Memory): two READ tools backed by a filesystem-rooted
	// BrigadeStorage. Writing memory is NOT a tool — the agent appends to
	// `memory/<today>.md` with its ordinary `write`/`edit` tool (cwd is
	// the workspace dir). Mirrors OpenClaw's memory_search + memory_get.
	//
	// The store is constructed per-turn from the workspace dir; it's
	// stateless (filesystem-backed), so there's no lifecycle to manage.
	// Phase 2 swaps `FileMemoryStore` for a DB-backed `BrigadeStorage`
	// here without touching the tools or the prompt.
	const memoryStore = new FileMemoryStore(opts.workspaceDir);
	return [
		makeRecallMemoryTool(memoryStore),
		makeReadMemoryTool(memoryStore),
	];
}

/**
 * Names of Brigade-native tools shipped today. Used by the system-prompt
 * assembler to advertise tools by name in the `## Tooling` section AND by
 * `agent-loop.ts` to flip on the memory-capability prompt block.
 */
export function listBrigadeToolNames(): string[] {
	return ["recall_memory", "read_memory"];
}
