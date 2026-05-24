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
 * clients of) runs it once per turn. These helpers are factored out of
 * that one path so the tool set + guards stay legible and unit-testable;
 * per-provider behaviour lives in the stream-fn wrappers (see
 * `stream-wrappers.ts`), never per-model loop branching. The shape is
 * deliberately "one loop + provider adapters".
 */

import type { MemoryCapability } from "./extensions/types.js";
import { makeExecGate } from "./exec-gate.js";
import { type BrigadeBeforeToolCallHook, makeUnknownToolGuard } from "./tool-guard.js";
import { makeToolLoopDetector } from "./tool-loop-detector.js";
import { wrapOwnerOnlyToolExecution } from "./tools/common.js";
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
	capabilities: { memory: boolean; subAgents: boolean };
}

/**
 * Assemble Brigade's full tool surface for a session. Pure + cheap — safe
 * to call once per session build. `createBrigadeTools` constructs the
 * memory tools rooted at `workspaceDir`.
 *
 * `senderIsOwner` defaults to `true` so all existing CLI / TUI / gateway
 * callers (which today ARE the workspace owner) keep their behaviour
 * unchanged — the moment a channel adapter routes a non-owner DM through
 * the per-turn path it MUST pass `senderIsOwner: false` explicitly so any
 * `ownerOnly: true` tool refuses the call with `BrigadeToolAuthorizationError`
 * before its body runs. The wrapper is a no-op for non-ownerOnly tools so
 * applying it to the full custom-tool list is cheap.
 */
export function assembleBrigadeToolset(opts: {
	workspaceDir: string;
	agentId: string;
	cwd: string;
	/**
	 * Whether the sender driving this turn is the workspace owner. Defaults
	 * to `true` — every direct-from-operator surface (TUI / `brigade agent` /
	 * gateway-from-CLI) is the owner. Channel-routed turns MUST pass `false`
	 * for non-owner senders so `ownerOnly` tools refuse with a 403-class
	 * `BrigadeToolAuthorizationError`.
	 */
	senderIsOwner?: boolean;
	/**
	 * Active memory backend for the turn. The agent loop resolves this via
	 * `resolveActiveMemoryCapability(...)` and threads it through; when
	 * omitted the tool registry builds the built-in file-based default.
	 */
	memoryCapability?: MemoryCapability;
	/**
	 * Sub-agent context — Primitive #6. When provided, the registry adds
	 * `spawn_agent` to the surface UNLESS the would-be child would land at
	 * leaf depth (`callerDepth + 1 >= maxDepth`), in which case it's dropped
	 * automatically. The parent session key drives child-key derivation +
	 * the concurrent-children map; the abort signal propagates cancellation.
	 */
	subagentContext?: {
		parentSessionKey: string;
		callerDepth: number;
		parentRunId?: string;
		parentSignal?: AbortSignal;
		/** Parent's resolved provider + modelId — child inherits unless caller
		 *  overrides via `spawn_agent`'s `model` param. */
		parentProvider?: string;
		parentModelId?: string;
	};
	/**
	 * Cron-mode tool allowlist. When set, the resulting toolset (built-ins
	 * AND brigade custom tools) is filtered down to ONLY these names.
	 * Stacks AFTER the `senderIsOwner` ownerOnly filter — both layers
	 * compose, with allowlist applied last. Empty array means "no tools";
	 * undefined means "no filter, full surface".
	 */
	toolsAllow?: string[];
}): BrigadeToolset {
	const rawCustomTools = createBrigadeTools({
		workspaceDir: opts.workspaceDir,
		agentId: opts.agentId,
		cwd: opts.cwd,
		...(opts.memoryCapability ? { memoryCapability: opts.memoryCapability } : {}),
		...(opts.subagentContext ? { subagentContext: opts.subagentContext } : {}),
	});
	const senderIsOwner = opts.senderIsOwner ?? true;
	// Wrap every tool — `wrapOwnerOnlyToolExecution` is a no-op for the owner
	// AND for non-ownerOnly tools, so the cost is one identity-check per tool.
	const wrappedCustomTools = rawCustomTools.map((t) =>
		wrapOwnerOnlyToolExecution(t, senderIsOwner),
	);
	// Per-job toolsAllow filter (cron). When omitted, every tool flows
	// through. When supplied, only the named tools survive — both for the
	// custom-tool array AND for the builtinToolNames allowlist below.
	const allow = opts.toolsAllow;
	const customTools = allow === undefined
		? wrappedCustomTools
		: wrappedCustomTools.filter((t) => allow.includes(t.name));
	const builtinNames = allow === undefined
		? [...BUILTIN_TOOL_NAMES]
		: BUILTIN_TOOL_NAMES.filter((n) => allow.includes(n));
	const brigadeToolNames = customTools.map((t) => t.name);
	return {
		builtinToolNames: builtinNames,
		brigadeToolNames,
		enabledToolNames: [...builtinNames, ...brigadeToolNames],
		customTools,
		capabilities: {
			memory: brigadeToolNames.includes("recall_memory"),
			subAgents: brigadeToolNames.includes("spawn_agent"),
		},
	};
}

/** Live correlation-id bag the guards read for `tool-blocked` bus events. */
export interface GuardContextRef {
	value: {
		runId?: string;
		agentId?: string;
		sessionKey?: string;
		/** Sub-agent attribution surfaced to approval prompts (Primitive #6). */
		subagentDepth?: number;
		subagentLabel?: string;
		parentRunId?: string;
	};
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
