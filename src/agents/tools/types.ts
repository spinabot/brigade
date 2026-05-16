/**
 * Brigade tool framework — type aliases.
 *
 * Brigade tools are Pi `AgentTool` objects with a thin Brigade-native
 * extension. We re-export Pi's `AgentToolResult` and `AgentToolUpdateCallback`
 * unchanged because they're already the right shape (`{content, details}`
 * plus an `onUpdate` callback for streaming tools). The extension fields
 * (`ownerOnly`, `displaySummary`) carry Brigade-specific metadata used by
 * the TUI / gateway / future channels.
 *
 * Mirrors OpenClaw's pattern at `src/agents/tools/common.ts:9-22`
 * (`AgentToolWithMeta`, `AnyAgentTool`) with Brigade-native naming.
 *
 * Pi's `AgentTool<TParameters, TDetails>` already requires:
 *   - `name: string`
 *   - `description: string`
 *   - `parameters: TSchema` (a TypeBox schema; Pi runs validation via
 *     `@sinclair/typebox` before calling `execute`)
 *   - `execute(toolCallId, params, signal?, onUpdate?) → Promise<AgentToolResult<TDetails>>`
 *   - `label: string`
 *
 * Plus Pi optionally exposes `prepareArguments` (pre-validation shim) and
 * a per-tool execution-mode override ("sequential" vs "parallel"). Brigade
 * inherits all of these — no Brigade-specific overrides at the Pi layer.
 *
 * No AJV. Pi's TypeBox-driven validation is the schema layer; tool
 * `execute` bodies use the `read*Param` helpers in `./common.ts` for any
 * post-schema coercion / labelling that's nicer than catching AJV errors.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
// Pi re-exports TypeBox under the package name `typebox` (not the upstream
// `@sinclair/typebox`). Importing from the same source Pi uses guarantees
// schema types line up and avoids version drift between Brigade tools and
// Pi's internal validator.
import type { TSchema } from "typebox";

export type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";

/**
 * Brigade-native extension of Pi's `AgentTool`. Adds two metadata fields
 * the chat-surface uses:
 *
 *   - `ownerOnly` — when true, the tool refuses calls from non-owner
 *     senders. Today (single-user v1) every sender is the owner, so this
 *     is a no-op flag; reserved for Phase 2 (multi-user / channels).
 *   - `displaySummary` — short one-liner shown in the TUI when the
 *     tool dispatches, e.g. "reading <path>" or "running shell". When
 *     omitted, the TUI falls back to the tool's `name`.
 */
export interface BrigadeTool<
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> extends AgentTool<TParameters, TDetails> {
	ownerOnly?: boolean;
	displaySummary?: string;
}

/**
 * Existential-wrapped tool type for registries and arrays. Pi accepts
 * `AgentTool<any, any>` in its `customTools` slot; the registry helpers
 * use this alias to round-trip without dragging generics through every
 * call site.
 *
 * Mirrors OpenClaw's `AnyAgentTool` at `src/agents/tools/common.ts:22`.
 * The `any` is documented and isolated — tools opt in via `BrigadeTool`
 * at definition time, then collapse to `AnyBrigadeTool` for storage.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBrigadeTool = BrigadeTool<any, unknown>;
