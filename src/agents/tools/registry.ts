/**
 * Brigade tool registry.
 *
 * Factory that builds the array of Brigade-native custom tools passed to
 * Pi's `createAgentSession({customTools})` slot. Today (Primitive #3 v1)
 * the registry is empty — Pi's 5 built-in tools (`read`, `bash`, `edit`,
 * `write`, `grep`) cover the v1 surface, and the 3 Brigade-native tools
 * (`write_memory`, `recall_memory`, `spawn_agent`) ship in Primitives
 * #4-6 alongside their respective primitives.
 *
 * The factory is plumbed through to `agent-loop.ts` and `core/agent.ts`
 * now so that adding a tool later is a one-line change in
 * `createBrigadeTools` rather than a multi-file rewire.
 *
 * Mirrors OpenClaw's pattern at `src/agents/openclaw-tools.ts:51-114`
 * (`createOpenClawTools` factory) with Brigade-native naming + a much
 * narrower scope (no plugins, no channels, no MCP).
 */

import type { AnyBrigadeTool } from "./types.js";

/**
 * Options threaded through to every Brigade-native tool. Each tool
 * picks the fields it needs; the rest are ignored.
 *
 * Per-field rationale:
 *   - `workspaceDir` — the absolute path to `~/.brigade/workspace/`.
 *     Persona-mutating tools (write_memory, recall_memory) resolve
 *     their target files under this root. Already enforced by the
 *     workspace-jail `beforeToolCall` hook for Pi's built-ins; passed
 *     here so Brigade-native tools can use the same root explicitly.
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
export function createBrigadeTools(
	_opts: CreateBrigadeToolsOptions,
): AnyBrigadeTool[] {
	// Primitive #3 v1: empty list. Pi's 5 built-ins are the v1 tool
	// surface and they're already enabled via the `tools: string[]`
	// allowlist in `agent-loop.ts:enabledToolNames`. Brigade-native
	// tools land here in subsequent primitives.
	//
	// When adding a tool:
	//   1. Build it in `src/agents/tools/<name>-tool.ts` exposing a
	//      `make<Name>Tool(opts: CreateBrigadeToolsOptions) →
	//      BrigadeTool<TParams, TDetails>` factory.
	//   2. Append `make<Name>Tool(opts)` to the array below.
	//   3. Add a TUI render handler in `tool-renderer.ts` (Phase 6 will
	//      formalise this; for now the existing TUI tool_result render
	//      handles the `content` text block uniformly).
	//   4. Add `<name>` to the system-prompt `## Tooling` block via the
	//      assembler's `toolDescriptions` array.
	return [];
}

/**
 * Names of Brigade-native tools shipped today. Empty list — Primitive
 * #3 v1 ships the framework only. Used by the system-prompt assembler
 * to advertise tools by name in the `## Tooling` section.
 */
export function listBrigadeToolNames(): string[] {
	return [];
}
