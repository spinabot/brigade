/**
 * Brigade session-wiring — the single source of truth for the tool surface
 * + the `beforeToolCall` guard chain that EVERY Brigade agent session gets.
 *
 * History: Brigade briefly had two divergent session builders — a long-lived
 * `buildAgent` (TUI + gateway) and the per-turn `runSingleTurn` (`brigade
 * agent`). They drifted: the interactive path was missing the memory tools
 * (Primitive #4), the exec-gate + loop-detector (Primitive #3), and the full
 * tool list — so the surfaces the operator actually used ran a gutted agent
 * loop with UNGATED bash and no memory.
 *
 * That divergence is gone. There is now exactly ONE construction path —
 * `agents/agent-loop.ts:runSingleTurn` → a single `createAgentSession` — and
 * every surface funnels through it: `brigade agent` calls it directly, and
 * the gateway (which `brigade chat` / `brigade connect` are thin WebSocket
 * clients of) runs it once per turn. This mirrors OpenClaw's single
 * `runEmbeddedAttempt`. These helpers are factored out of that one path so
 * the tool set + guards stay legible and unit-testable; per-provider
 * behaviour lives in the stream-fn wrappers (see `stream-wrappers.ts`),
 * never per-model loop branching — OpenClaw's "one loop + provider adapters".
 */

import { makeExecGate } from "./exec-gate.js";
import { type BrigadeBeforeToolCallHook, makeUnknownToolGuard } from "./tool-guard.js";
import { makeToolLoopDetector } from "./tool-loop-detector.js";
import { createBrigadeTools } from "./tools/registry.js";
import type { AnyBrigadeTool } from "./tools/types.js";

/** Pi built-in tools Brigade enables by name (vs Pi's default 4). */
const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;

export interface BrigadeToolset {
	/** Pi built-in tool names (passed to Pi's `tools` allowlist). */
	builtinToolNames: string[];
	/** Brigade-native custom tool names (recall_memory, read_memory, …). */
	brigadeToolNames: string[];
	/** builtins + brigade — the allowlist the unknown-tool guard checks against. */
	enabledToolNames: string[];
	/** Brigade-native tool objects (passed to Pi's `customTools`). */
	customTools: AnyBrigadeTool[];
	/** Capability gates for the system-prompt assembler (## Memory, etc.). */
	capabilities: { memory: boolean };
}

/**
 * Assemble Brigade's full tool surface for a session. Pure + cheap — safe
 * to call once per session build. `createBrigadeTools` constructs the
 * memory tools rooted at `workspaceDir`.
 */
export function assembleBrigadeToolset(opts: {
	workspaceDir: string;
	agentId: string;
	cwd: string;
}): BrigadeToolset {
	const customTools = createBrigadeTools(opts);
	const brigadeToolNames = customTools.map((t) => t.name);
	return {
		builtinToolNames: [...BUILTIN_TOOL_NAMES],
		brigadeToolNames,
		enabledToolNames: [...BUILTIN_TOOL_NAMES, ...brigadeToolNames],
		customTools,
		capabilities: { memory: brigadeToolNames.includes("recall_memory") },
	};
}

/** Live correlation-id bag the guards read for `tool-blocked` bus events. */
export interface GuardContextRef {
	value: { runId?: string; agentId?: string; sessionKey?: string };
}

export interface ComposeGuardsOptions {
	/** The unknown-tool guard's allowlist — builtins + brigade tools. */
	enabledToolNames: string[];
	/** Live runId/agentId/sessionKey bag for bus-event correlation. */
	gateCtxRef: GuardContextRef;
	/** Cwd label for the exec-gate's workdir-refusal message. */
	displayCwd: string;
	/**
	 * Optional in-place argument decoder run BEFORE the guards (e.g. xAI
	 * HTML-entity decode). Mutates `ctx.toolCall.arguments`.
	 */
	decodeArgs?: (ctx: unknown) => void;
	/**
	 * Optional operator/policy hook run AFTER the built-in guards pass
	 * (approval workflows, audit). Only invoked when nothing blocked first.
	 */
	userBeforeHook?: BrigadeBeforeToolCallHook;
}

/**
 * Compose Brigade's canonical `beforeToolCall` chain. Order, fixed:
 *
 *   decodeArgs → unknown-tool guard → loop detector → exec-gate → userHook
 *
 * - **decodeArgs** (optional): provider arg cleanup before anything reads them.
 * - **unknown-tool guard**: refuse hallucinated names + malformed args.
 * - **loop detector**: block a model stuck repeating the same call.
 * - **exec-gate**: bash/exec/shell/sh approval + workdir/env refusal.
 * - **userHook** (optional): operator policy, only if nothing blocked.
 *
 * A thrown guard/hook is converted to a block (fail-closed) so a bug never
 * lets a destructive call through.
 */
export function composeBrigadeBeforeToolCall(
	opts: ComposeGuardsOptions,
): BrigadeBeforeToolCallHook {
	const nameGuard = makeUnknownToolGuard(opts.enabledToolNames);
	const loopDetector = makeToolLoopDetector({ ctxRef: opts.gateCtxRef });
	const execGate = makeExecGate({ ctxRef: opts.gateCtxRef, displayCwd: opts.displayCwd });
	return async (ctx, signal) => {
		if (opts.decodeArgs) {
			try {
				opts.decodeArgs(ctx);
			} catch {
				// A decode failure shouldn't block the call — the guards below
				// still validate; a malformed arg surfaces there.
			}
		}
		const named = await nameGuard(ctx, signal);
		if (named?.block) return named;
		const loop = await loopDetector(ctx, signal);
		if (loop?.block) return loop;
		const gate = await execGate(ctx, signal);
		if (gate?.block) return gate;
		if (!opts.userBeforeHook) return undefined;
		try {
			return await opts.userBeforeHook(ctx, signal);
		} catch (err) {
			return {
				block: true,
				reason: `policy hook error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	};
}
