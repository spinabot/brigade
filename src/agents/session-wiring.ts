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

import type { GroupToolPolicyConfig } from "./channels/access-control/index.js";
import type { ChannelApprovalRoute } from "./channels/approval-router.js";
import type { MemoryCapability } from "./extensions/types.js";
import { DEFAULT_SUBAGENT_TIMEOUT_SECONDS } from "./subagent-policy.js";
import { makeCmdIsmGuard } from "./cmd-ism-guard.js";
import { makeConfigWriteGuard } from "./config-write-guard.js";
import { makeExecGate } from "./exec-gate.js";
import { makePathWriteGuard } from "./path-write-guard.js";
import type { SessionContext } from "./session-context.js";
import { type BrigadeBeforeToolCallHook, makeUnknownToolGuard } from "./tool-guard.js";
import { makeToolLoopDetector } from "./tool-loop-detector.js";
import { wrapOwnerOnlyToolExecution, wrapToolExecutionTimeout } from "./tools/common.js";
import { createBrigadeTools } from "./tools/registry.js";
import type { AnyBrigadeTool } from "./tools/types.js";

/**
 * Pi built-in tools Brigade enables by name (vs Pi's default 4).
 *
 * `find` is deliberately ABSENT: Pi's builtin shells out to `fd`, whose
 * `--glob --full-path` mode (used for any pattern containing `/`) matches
 * nothing on Windows — every `**`-style search silently returned "No files
 * found" on real trees. Brigade registers its own walker-based `find` (same
 * name, same schema) via the tool registry instead — see
 * `tools/find-tool.ts` for the full forensic note.
 */
const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "ls"] as const;

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
 * Build a pure tool-name predicate from a per-group / per-sender tool policy.
 *
 * Semantics (see `channels/access-control/group-tool-policy.ts`):
 *   - When `allow` is defined, ONLY tools whose name is in `allow ∪ alsoAllow`
 *     survive; when `allow` is undefined, every tool is allowed by default
 *     (and `alsoAllow` is inert — it only widens an explicit allowlist).
 *   - Any name in `deny` is then removed (deny always wins, even over `allow`).
 *
 * The returned predicate is the additional name-based narrowing layer applied
 * to the per-turn toolset for GROUP messages that carry a policy. It can only
 * REMOVE tools from the surface — it never adds a tool and never un-gates one
 * (the `ownerOnly` wrapping is applied first and is independent of this).
 * Names are matched verbatim against the tool's registered `name`.
 *
 * Exported for unit tests + reuse by `assembleBrigadeToolset`.
 */
export function makeToolPolicyPredicate(policy: GroupToolPolicyConfig): (toolName: string) => boolean {
	const allowSet =
		policy.allow !== undefined
			? new Set<string>([...policy.allow, ...(policy.alsoAllow ?? [])])
			: undefined;
	const denySet = policy.deny && policy.deny.length > 0 ? new Set<string>(policy.deny) : undefined;
	return (toolName: string): boolean => {
		if (allowSet !== undefined && !allowSet.has(toolName)) return false;
		if (denySet !== undefined && denySet.has(toolName)) return false;
		return true;
	};
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
	/**
	 * Per-group / per-sender tool policy for THIS turn (group messages only).
	 * Resolved by the channel inbound pipeline via
	 * `resolveChannelGroupToolsPolicy(...)` and threaded down through the turn.
	 * Applied as a pure NAME filter AFTER the `ownerOnly` wrapping and AFTER
	 * the cron `toolsAllow` filter, so it composes with both and can only
	 * REMOVE tools (allow ∪ alsoAllow, then deny wins — see
	 * `makeToolPolicyPredicate`). Undefined for TUI / cron / sub-agent / RPC /
	 * DM turns and any group without a configured policy — those get the exact
	 * same toolset as before (the filter never runs when this is absent).
	 */
	toolPolicy?: GroupToolPolicyConfig;
	/**
	 * Active channel context for this turn — set when the inbound came from
	 * a channel adapter. Threaded into the cron tool so a `cron add` from
	 * mid-chat auto-routes the eventual announce back to the same chat.
	 * Undefined for TUI / direct-RPC turns (the cron's announce falls back
	 * to the operator's main session via `enqueueSystemEvent`).
	 */
	channelContext?: ChannelApprovalRoute;
	/**
	 * Per-turn session metadata. When provided, the cron tool resolves
	 * `sessionTarget: "current"` to `session:<sessionKey>` (otherwise it
	 * falls back to `"isolated"`); the sessions tools surface here too.
	 * The agent loop builds this from the resolved per-turn session key
	 * + agent id so a TUI operator's "remind me here in 30 mins" cron
	 * binds to THIS conversation, not a fresh isolated run.
	 */
	sessionContext?: SessionContext;
	/**
	 * Sandbox flag for the sessions tools — when true, `sessions_list`
	 * clamps visibility to the spawned-tree only. Forwarded to the tool
	 * registry; ignored when `sessionContext` is unset.
	 */
	sandboxedSessionTools?: boolean;
	/**
	 * Per-turn session-tool access guard — visibility + A2A policy +
	 * spawned-tree containment. Threaded through to `createBrigadeTools`
	 * so the four sessions tools fail-closed BEFORE dispatching when
	 * the caller is not allowed to reach the target session.
	 */
	sessionToolAccess?: {
		visibility?: import("./tools/sessions/shared.js").SessionToolsVisibility;
		a2aPolicy?: import("./tools/sessions/shared.js").AgentToAgentPolicy;
		spawnedKeys?: ReadonlySet<string>;
	};
	/**
	 * Resolved turn-model context — provider + modelId of the model driving
	 * this turn. Threaded into `analyze_media` so it can decide whether
	 * returning an IMAGE block is meaningful for the active model. Optional;
	 * omitted on legacy / test call sites.
	 */
	modelContext?: {
		provider?: string;
		modelId?: string;
		imageInput?: boolean;
	};
}): BrigadeToolset {
	const senderIsOwner = opts.senderIsOwner ?? true;
	const rawCustomTools = createBrigadeTools({
		workspaceDir: opts.workspaceDir,
		agentId: opts.agentId,
		cwd: opts.cwd,
		// Pass senderIsOwner so tools like send_media that need a
		// narrower-than-blanket gate (allow same-chat replies for
		// non-owners, refuse cross-conversation sends) can self-check.
		senderIsOwner,
		...(opts.memoryCapability ? { memoryCapability: opts.memoryCapability } : {}),
		...(opts.subagentContext ? { subagentContext: opts.subagentContext } : {}),
		...(opts.channelContext ? { channelContext: opts.channelContext } : {}),
		...(opts.sessionContext ? { sessionContext: opts.sessionContext } : {}),
		...(opts.sandboxedSessionTools !== undefined
			? { sandboxedSessionTools: opts.sandboxedSessionTools }
			: {}),
		...(opts.sessionToolAccess !== undefined
			? { sessionToolAccess: opts.sessionToolAccess }
			: {}),
		...(opts.modelContext !== undefined ? { modelContext: opts.modelContext } : {}),
	});
	// Wrap every tool — `wrapOwnerOnlyToolExecution` is a no-op for the owner
	// AND for non-ownerOnly tools, so the cost is one identity-check per tool.
	// Then ALSO wrap with `wrapToolExecutionTimeout` so a tool whose promise
	// never resolves (e.g. a runaway file lock, a hung dependency) can't
	// wedge the agent loop forever — the model gets a `BrigadeToolTimeoutError`
	// after ~60s and can tell the operator instead of spinning indefinitely.
	//
	// EXCEPTION — the spawn tools AWAIT their children by contract
	// (Primitive #6: result-as-tool-result), and each child may legitimately
	// run up to its own `timeoutSeconds` (default 300s). The blanket 60s
	// watchdog was killing every longer fan-out with a misleading "assume
	// the call hung" while the children kept running and later announced via
	// the completion bridge (observed in production 2026-06-11). Their budget
	// is sized per call: the call's own per-child timeout + dispatch/settle
	// slack — children run concurrently, so the max child budget bounds the
	// whole call.
	const wrappedCustomTools = rawCustomTools.map((t) => {
		const ownerWrapped = wrapOwnerOnlyToolExecution(t, senderIsOwner);
		if (t.name === "spawn_agent" || t.name === "spawn_agents") {
			return wrapToolExecutionTimeout(ownerWrapped, undefined, resolveSpawnToolTimeoutMs);
		}
		// Image generation runs 1-2 minutes per call (the tool bounds its own
		// HTTP requests at 150s) — the 60s blanket budget would kill every
		// legitimate generation.
		if (t.name === "generate_image") {
			return wrapToolExecutionTimeout(ownerWrapped, 200_000);
		}
		// sessions_send WAITS for the peer's run up to its own
		// `timeoutSeconds` (default 90s) + a 10s final-text flush poll — the
		// blanket 60s watchdog killed every legitimate wait mid-flight
		// (tool_end ✗ while the peer was still working; observed in
		// production 2026-06-12, same class as the spawn-tool kill). Budget
		// per call: the call's own wait window + flush + slack.
		if (t.name === "sessions_send") {
			return wrapToolExecutionTimeout(ownerWrapped, undefined, resolveSessionsSendTimeoutMs);
		}
		// oauth_authorize `await` blocks until the operator clicks the link —
		// up to its own `waitSeconds` (default 240). The blanket 60s watchdog
		// would kill that legitimate wait; size the budget from the call's
		// waitSeconds + slack (same pattern as spawn / sessions_send).
		if (t.name === "oauth_authorize") {
			return wrapToolExecutionTimeout(ownerWrapped, undefined, resolveOAuthAuthorizeTimeoutMs);
		}
		return wrapToolExecutionTimeout(ownerWrapped);
	});
	// Per-job toolsAllow filter (cron). When omitted, every tool flows
	// through. When supplied, only the named tools survive — both for the
	// custom-tool array AND for the builtinToolNames allowlist below.
	const allow = opts.toolsAllow;
	const allowedCustomTools = allow === undefined
		? wrappedCustomTools
		: wrappedCustomTools.filter((t) => allow.includes(t.name));
	const allowedBuiltinNames = allow === undefined
		? [...BUILTIN_TOOL_NAMES]
		: BUILTIN_TOOL_NAMES.filter((n) => allow.includes(n));
	// Per-group / per-sender tool-policy filter. Stacks AFTER the cron
	// toolsAllow filter and AFTER the ownerOnly wrapping — a pure NAME
	// narrowing that can only REMOVE tools (allow ∪ alsoAllow, then deny
	// wins). When no policy is present the predicate is skipped entirely so
	// the toolset is byte-identical to today for TUI / cron / sub-agent /
	// RPC / DM turns and any group without a configured policy.
	const policyAllows = opts.toolPolicy !== undefined ? makeToolPolicyPredicate(opts.toolPolicy) : undefined;
	const customTools = policyAllows === undefined
		? allowedCustomTools
		: allowedCustomTools.filter((t) => policyAllows(t.name));
	const builtinNames = policyAllows === undefined
		? allowedBuiltinNames
		: allowedBuiltinNames.filter((n) => policyAllows(n));
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

/**
 * Per-call watchdog budget for the spawn tools. The call's own
 * `timeoutSeconds` (per child, children run concurrently) bounds the
 * legitimate runtime; 30s of slack covers dispatch + settle + announce.
 * Exported for tests.
 */
export function resolveSpawnToolTimeoutMs(toolArgs: unknown): number {
	const bag = toolArgs as
		| { timeoutSeconds?: unknown; tasks?: ReadonlyArray<{ timeoutSeconds?: unknown }> }
		| undefined;
	const readPositive = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
	// spawn_agent carries a TOP-LEVEL timeoutSeconds; spawn_agents carries it
	// PER-TASK (tasks[].timeoutSeconds). Children run concurrently, so the
	// call's legitimate runtime is bounded by the SLOWEST child — take the max
	// across whichever shape is present. Audit P1 (F4, 2026-06-11): reading
	// only the top-level field left every spawn_agents call on the 300s
	// default, so a per-task timeout above 300s was still watchdog-killed at
	// 330s while the child ran on — the exact bug this budget existed to fix.
	let perChildSeconds = readPositive(bag?.timeoutSeconds);
	if (Array.isArray(bag?.tasks)) {
		for (const task of bag.tasks) {
			const t = readPositive(task?.timeoutSeconds);
			if (t !== undefined && (perChildSeconds === undefined || t > perChildSeconds)) {
				perChildSeconds = t;
			}
		}
	}
	return (perChildSeconds ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS) * 1000 + 30_000;
}

/**
 * Per-call watchdog budget for `sessions_send`. The tool's legitimate
 * runtime = its own wait window (`timeoutSeconds`, default 90s — the
 * settle race in send.ts) + the 10s final-text flush poll + slack for
 * dispatch/history reads. Without this, the blanket 60s watchdog killed
 * every wait longer than a minute while the peer kept working.
 * Exported for tests.
 */
export function resolveSessionsSendTimeoutMs(toolArgs: unknown): number {
	const bag = toolArgs as { timeoutSeconds?: unknown } | undefined;
	const waitSeconds =
		typeof bag?.timeoutSeconds === "number" &&
		Number.isFinite(bag.timeoutSeconds) &&
		bag.timeoutSeconds > 0
			? bag.timeoutSeconds
			: 90;
	return waitSeconds * 1000 + 10_000 + 30_000;
}

/**
 * Per-call watchdog budget for `oauth_authorize`. The `await` action blocks
 * until the operator clicks the authorization link — up to its own
 * `waitSeconds` (default 240). `start` / `cancel` are fast but harmlessly
 * inherit the same generous budget. Exported for tests.
 */
export function resolveOAuthAuthorizeTimeoutMs(toolArgs: unknown): number {
	const bag = toolArgs as { waitSeconds?: unknown } | undefined;
	const waitSeconds =
		typeof bag?.waitSeconds === "number" && Number.isFinite(bag.waitSeconds) && bag.waitSeconds > 0
			? bag.waitSeconds
			: 240;
	return waitSeconds * 1000 + 20_000;
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
		/** Channel routing — when set, exec-gate routes approval prompts into
		 *  the originating chat. Set per-turn by the agent loop from
		 *  `RunSingleTurnArgs.channelApprovalRoute`; cleared in `finally`. */
		channelRoute?: ChannelApprovalRoute;
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
 *   decodeArgs → unknown-tool guard → path-write guard → cmd-ism guard → loop detector → exec-gate → userHook
 *
 * - **decodeArgs** (optional): provider arg cleanup before anything reads them.
 * - **unknown-tool guard**: refuse hallucinated names + malformed args.
 * - **path-write guard**: refuse `write`/`edit` to protected roots
 *   (install dir's `skills/`, `~/.brigade/brigade.json`,
 *   `~/.brigade/agents/<id>/agent/` internals) and redirect the model to
 *   the right tool (`manage_skill` / `manage_agent`). Strict gate ahead
 *   of the loop detector + exec-gate — those are downstream of "is the
 *   destination even legal".
 * - **cmd-ism guard**: refuse bash commands that redirect into a reserved
 *   DOS device name (`2>nul` etc.) — in the POSIX shell those create a
 *   real `nul` file that Windows then cannot delete.
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
	// Thread the SESSION cwd so the guard resolves relative / `~` paths the
	// SAME way Pi's write/edit/bash tools do (audit P0 F-guards, 2026-06-11).
	// Without this the guard resolved against the gateway process.cwd() and a
	// model could reach the real config via `edit({path:"~/.brigade/brigade.json"})`
	// or a workspace-relative `../brigade.json`.
	const pathGuard = makePathWriteGuard({ cwd: opts.displayCwd });
	const cmdIsmGuard = makeCmdIsmGuard();
	const configWriteGuard = makeConfigWriteGuard();
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
		const pathBlock = await pathGuard(ctx, signal);
		if (pathBlock?.block) return pathBlock;
		const cmdIsm = await cmdIsmGuard(ctx, signal);
		if (cmdIsm?.block) return cmdIsm;
		// Config-write boundary BEFORE the exec-gate, so the operator is never
		// asked to approve a shell mutation of Brigade's own state files.
		const cfgWrite = await configWriteGuard(ctx, signal);
		if (cfgWrite?.block) return cfgWrite;
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
