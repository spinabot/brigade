/**
 * Sub-agent spawn engine (Step 20).
 *
 * Brand-scrubbed analogue of upstream's `src/agents/subagent-spawn.ts`,
 * scoped to the operations Brigade can perform at this milestone. The
 * upstream engine is 900+ LOC and references modules Brigade does not
 * yet have (sandbox runtime status, ACP child runtime, attachment
 * materialiser, thread-binding hooks, model-and-thinking plan resolver).
 * Brigade's slim engine focuses on the LOAD-BEARING parts:
 *
 *   1. Validate target agent id + reject malformed ids before normalisation.
 *   2. Enforce depth cap + max-children cap (read from Step 9's session
 *      store metadata).
 *   3. Generate the child session key (`agent:<targetAgentId>:subagent:<UUID>`).
 *   4. Register the run in Step 10's subagent-registry.
 *   5. Emit a `subagent_lifecycle:subagent_started` agent event (Step 18).
 *   6. Hand off the initial child turn to the gateway via Step 18's
 *      `callGateway` (`method: "agent"`, `lane: AGENT_LANE_SUBAGENT`).
 *   7. On gateway error → registry cleanup + structured error result.
 *
 * What this engine DOES NOT do (deferred):
 *
 *   - Sandbox-mode validation (Brigade has no sandbox runtime yet).
 *   - ACP runtime branching (Brigade is sub-agent-only per the locked
 *     design's R2 Leak #10).
 *   - Attachment materialisation (per-file copy into child workspace).
 *   - Thread-binding hook fire-order (waits for Step 25's gateway).
 *   - Model + thinking-level plan resolution (passes through to gateway).
 *
 * Adding any of those is additive — none of the public APIs here need to
 * change for the deferred layers to slot in later.
 */

import crypto from "node:crypto";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { emitAgentEvent } from "./agent-events.js";
import { callGateway } from "./gateway-call.js";
import { subagentLane } from "../process/lanes.js";
import { withSubagentSlot } from "./subagent-budget.js";
import {
	isValidAgentId,
	normalizeAgentId,
	resolveAgentIdFromSessionKey,
} from "./routing/session-key.js";
import {
	countActiveRunsForSession,
	registerSubagentRun,
	releaseSubagentRun,
} from "./subagent-registry.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import type {
	SpawnSubagentMode,
	SpawnSubagentSandboxMode,
} from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-spawn");

const DEFAULT_MAX_SPAWN_DEPTH = 3;
const DEFAULT_MAX_CHILDREN_PER_AGENT = 5;
/**
 * Wave N4 — default per-call wall-clock cap for a gateway-routed sub-agent
 * run when the caller (typically the `sessions_spawn` tool) does NOT
 * supply `runTimeoutSeconds`. Pre-Wave-N4 the engine forwarded
 * `runTimeoutSeconds: undefined` straight to the gateway `agent` handler,
 * which then ran the child with NO enforced cap — three of five parallel
 * children were observed timing out at 60s elsewhere in the stack while
 * the harness sat idle waiting on the missing reply, masking the real
 * timeout. 180s is generous (above the slow-path tail of any realistic
 * tool-using turn but well below "model is hung forever") and matches the
 * documented `agents.defaults.subagents.defaultTimeoutSeconds` knob's
 * intent of "model can take its time but never pins a slot indefinitely".
 *
 * Operators override per-call by passing `runTimeoutSeconds` on the
 * `sessions_spawn` call; the `cfg.agents.defaults.subagents.defaultTimeoutSeconds`
 * knob in `brigade.json` is honoured by the in-process `spawn_agent`
 * path through `resolveSubagentLimits`. The two paths read different
 * surfaces today; an operator who genuinely wants longer-running children
 * sets BOTH.
 */
export const DEFAULT_SUBAGENT_RUN_TIMEOUT_SECONDS = 180;

export interface SpawnSubagentParams {
	task: string;
	label?: string;
	agentId?: string;
	model?: string;
	thinking?: string;
	runTimeoutSeconds?: number;
	thread?: boolean;
	mode?: SpawnSubagentMode;
	cleanup?: "delete" | "keep";
	sandbox?: SpawnSubagentSandboxMode;
	lightContext?: boolean;
	expectsCompletionMessage?: boolean;
}

export interface SpawnSubagentContext {
	agentSessionKey?: string;
	agentChannel?: string;
	agentAccountId?: string;
	agentTo?: string;
	agentThreadId?: string | number;
	requesterAgentIdOverride?: string;
	workspaceDir?: string;
	/**
	 * Per-call depth cap override (defaults to 3). Pass at most the
	 * config-resolved max-spawn-depth from the gateway.
	 */
	maxSpawnDepth?: number;
	/** Per-call children-per-agent cap override (defaults to 5). */
	maxChildrenPerAgent?: number;
	/** Caller's current depth (resolved from session store; defaults to 0). */
	callerDepth?: number;
}

export interface SpawnSubagentResult {
	status: "accepted" | "forbidden" | "error";
	childSessionKey?: string;
	runId?: string;
	mode?: SpawnSubagentMode;
	note?: string;
	error?: string;
}

function resolveSpawnMode(params: {
	requestedMode?: SpawnSubagentMode;
	threadRequested: boolean;
}): SpawnSubagentMode {
	if (params.requestedMode === "session") return "session";
	if (params.threadRequested) return "session";
	return "run";
}

/**
 * Build a `DeliveryContext` from the loose channel/account/to/thread
 * params the caller has at hand. Returns `undefined` when every field is
 * empty (matches upstream's `normalizeDeliveryContext` for the empty-
 * input case).
 */
function buildRequesterOrigin(ctx: SpawnSubagentContext): DeliveryContext | undefined {
	const channel = ctx.agentChannel?.trim();
	const accountId = ctx.agentAccountId?.trim();
	const peer = ctx.agentTo?.trim();
	const threadId =
		ctx.agentThreadId != null && String(ctx.agentThreadId).trim()
			? String(ctx.agentThreadId).trim()
			: undefined;
	if (!channel && !accountId && !peer && !threadId) return undefined;
	return {
		...(channel ? { channel } : {}),
		...(accountId ? { accountId } : {}),
		...(peer ? { peer } : {}),
		...(threadId ? { threadId } : {}),
	};
}

function summarizeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
}

/**
 * Main spawn entry point. Returns a structured result so the
 * `sessions_spawn` tool can render success / forbidden / error cleanly.
 *
 * The engine NEVER throws — every failure path returns
 * `{ status: "error" | "forbidden", error }` plus optional `childSessionKey`
 * / `runId` if the failure happened after either was minted.
 */
export async function spawnSubagentDirect(
	params: SpawnSubagentParams,
	ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
	const task = params.task.trim();
	if (!task) {
		return { status: "error", error: "spawn task must be a non-empty string" };
	}
	const label = params.label?.trim() ?? "";
	const requestedAgentId = params.agentId?.trim();

	// Reject malformed agentId before normalizeAgentId mangles it
	// (mirroring upstream's gh#31311 fix).
	if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
		return {
			status: "error",
			error: `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}.`,
		};
	}

	const requestThreadBinding = params.thread === true;
	const spawnMode = resolveSpawnMode({
		requestedMode: params.mode,
		threadRequested: requestThreadBinding,
	});
	if (spawnMode === "session" && !requestThreadBinding) {
		return {
			status: "error",
			error: 'mode="session" requires thread=true so the sub-agent can stay bound to a thread.',
		};
	}
	const cleanup =
		spawnMode === "session"
			? "keep"
			: params.cleanup === "delete" || params.cleanup === "keep"
				? params.cleanup
				: "keep";

	const maxSpawnDepth = ctx.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
	const maxChildren = ctx.maxChildrenPerAgent ?? DEFAULT_MAX_CHILDREN_PER_AGENT;
	const callerDepth = ctx.callerDepth ?? 0;
	// Wave N4 — apply a sane default per-call run timeout when the caller
	// omits one. Without this, the engine forwards `undefined` to the gateway
	// `agent` handler and the child runs uncapped (parent waits forever on a
	// hung tool call). 180s is the documented default — override per-call via
	// `runTimeoutSeconds`, or by setting `agents.defaults.subagents.defaultTimeoutSeconds`
	// in `brigade.json` (the in-process `spawn_agent` path reads that knob).
	const effectiveRunTimeoutSeconds =
		typeof params.runTimeoutSeconds === "number" && params.runTimeoutSeconds > 0
			? params.runTimeoutSeconds
			: DEFAULT_SUBAGENT_RUN_TIMEOUT_SECONDS;

	const requesterAgentId = ctx.requesterAgentIdOverride
		? normalizeAgentId(ctx.requesterAgentIdOverride)
		: resolveAgentIdFromSessionKey(ctx.agentSessionKey);
	const targetAgentId = requestedAgentId
		? normalizeAgentId(requestedAgentId)
		: requesterAgentId;

	if (callerDepth >= maxSpawnDepth) {
		return {
			status: "forbidden",
			error: `sessions_spawn not allowed at this depth (current=${callerDepth}, max=${maxSpawnDepth})`,
		};
	}

	if (ctx.agentSessionKey) {
		const activeChildren = countActiveRunsForSession(ctx.agentSessionKey);
		if (activeChildren >= maxChildren) {
			return {
				status: "forbidden",
				error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
			};
		}
	}

	const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
	const childDepth = callerDepth + 1;
	const requesterDisplayKey = ctx.agentSessionKey ?? "main";
	const requesterOrigin = buildRequesterOrigin(ctx);

	const runId = crypto.randomUUID();

	// Register the run BEFORE the gateway handoff so a fast completion
	// can stamp the entry as ended without racing the registration.
	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: ctx.agentSessionKey,
		requesterSessionKey: ctx.agentSessionKey ?? "main",
		requesterOrigin,
		requesterDisplayKey,
		task,
		cleanup,
		label: label || undefined,
		model: params.model,
		workspaceDir: ctx.workspaceDir,
		runTimeoutSeconds: effectiveRunTimeoutSeconds,
		expectsCompletionMessage: params.expectsCompletionMessage !== false,
		spawnMode,
		createdAt: Date.now(),
	});

	// Persist spawn metadata to the per-agent session store BEFORE the
	// gateway handoff so post-crash forensics can reconstruct the spawn
	// tree (depth, parent, workspace, label). Without this the registry
	// entry is in-memory only and the next spawn's depth check (which
	// reads from store) reads 0 regardless of nesting.
	//
	// Cross-agent workspace inheritance: when the child runs as a DIFFERENT
	// agent than the parent (per `agentId` override), suppress the parent's
	// `workspaceDir` so the child resolves its target agent's native
	// workspace (`~/.brigade/agents/<targetAgentId>/workspace/`). Same-agent
	// spawns inherit the parent's workspace.
	const inheritedWorkspaceDir =
		targetAgentId === requesterAgentId ? ctx.workspaceDir : undefined;
	try {
		await callGateway({
			method: "sessions.patch",
			params: {
				sessionKey: childSessionKey,
				patch: {
					subagent: {
						spawnDepth: childDepth,
						spawnedBy: ctx.agentSessionKey ?? "main",
						label: label || undefined,
						cleanup,
						spawnedAt: new Date(Date.now()).toISOString(),
						...(inheritedWorkspaceDir
							? { spawnedWorkspaceDir: inheritedWorkspaceDir }
							: {}),
					},
					...(inheritedWorkspaceDir
						? { spawnedWorkspaceDir: inheritedWorkspaceDir }
						: {}),
					...(params.model ? { modelId: params.model } : {}),
				},
			},
			timeoutMs: 5_000,
		});
	} catch (err) {
		// Patch failure is non-fatal — the registry entry is still
		// authoritative for the lifetime of this process. Log + continue.
		log.warn("sub-agent sessions.patch failed (continuing)", {
			runId,
			childSessionKey,
			error: summarizeError(err),
		});
	}

	// Emit lifecycle event so Step 18 listeners (control-UI WS, hook
	// fan-out, channel announcers) can react to the spawn.
	emitAgentEvent({
		runId,
		stream: "subagent_lifecycle",
		sessionKey: ctx.agentSessionKey,
		data: {
			kind: "subagent_started",
			childSessionKey,
			requesterSessionKey: ctx.agentSessionKey,
			runId,
			label: label || undefined,
			spawnMode,
		},
	});

	try {
		await withSubagentSlot(() => callGateway({
			method: "agent",
			params: {
				message: task,
				sessionKey: childSessionKey,
				channel: ctx.agentChannel,
				to: ctx.agentTo,
				accountId: ctx.agentAccountId,
				threadId: ctx.agentThreadId,
				idempotencyKey: runId,
				deliver: false,
				// Per-parent FIFO lane so spawns from different parents run in
				// parallel; the global semaphore in `subagent-budget.ts` caps
				// total in-flight spawns process-wide.
				lane: subagentLane(ctx.agentSessionKey),
				thinking: params.thinking,
				timeout: effectiveRunTimeoutSeconds,
				label: label || undefined,
				spawnedBy: ctx.agentSessionKey ?? "main",
				...(params.model ? { model: params.model } : {}),
				// Per cross-agent workspace inheritance rule: only forward the
				// parent's `workspaceDir` if the child runs as the SAME agent.
				// Cross-agent spawns let the target agent resolve its own
				// workspace via `resolveAgentWorkspaceDir(targetAgentId)`.
				...(inheritedWorkspaceDir ? { workspaceDir: inheritedWorkspaceDir } : {}),
				...(params.lightContext
					? { bootstrapContextMode: "lightweight" as const }
					: {}),
			},
			timeoutMs: 10_000,
		}));
	} catch (err) {
		// Roll back the registration so the registry doesn't grow phantom
		// entries. Best-effort: a concurrent reader might still see the
		// entry briefly, which is fine because `endedAt` will be set by
		// the next completion path or by the sweeper.
		try {
			releaseSubagentRun(runId);
		} catch {
			// best-effort cleanup
		}
		const message = summarizeError(err);
		log.warn("sub-agent gateway handoff failed", {
			runId,
			childSessionKey,
			error: message,
		});
		return {
			status: "error",
			error: message,
			childSessionKey,
			runId,
		};
	}

	return {
		status: "accepted",
		childSessionKey,
		runId,
		mode: spawnMode,
		note:
			spawnMode === "session"
				? "Sub-agent session ready; further messages can target it via sessions_send."
				: "Sub-agent run started; result will announce when the run completes.",
	};
}
