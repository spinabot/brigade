/**
 * `spawn_agents` tool — Primitive #6, Wave P1 parallel fan-out.
 *
 * The model calls this to delegate N self-contained sub-tasks IN PARALLEL.
 * Each task becomes its own sub-agent run with the same persona but a
 * minimal system prompt (mirroring `spawn_agent`). The tool blocks the
 * parent turn until every child has settled (ok / aborted / timed-out /
 * limit-refused / error) and returns an AGGREGATED result envelope so the
 * model can synthesise across all replies in the next assistant turn.
 *
 * Use this when:
 *   - The work decomposes cleanly into independent sub-tasks (research N
 *     topics, audit M files, summarise K documents).
 *   - You want parallel wall-clock — N children run concurrently up to
 *     `maxChildrenPerParent`.
 *   - You'd otherwise call `spawn_agent` sequentially in a tight loop.
 *
 * Sequential `spawn_agent` calls are fine for "must finish step 1 before
 * step 2"; that's not what this is for.
 *
 * Implementation: each task is dispatched via the SAME runner as
 * `spawn_agent` (`runSubagent`) inside `Promise.allSettled`. We do NOT
 * implement batching for >maxChildrenPerParent — instead, we refuse the
 * whole call up-front with a clear error so the model knows to split
 * into multiple spawn_agents calls (or chunk its work). Batching is a
 * future enhancement when we see the need.
 *
 * Cleanup is operator-controlled (same as `spawn_agent`) — never exposed
 * in the schema.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
	DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
	SubagentLimitError,
	resolveSubagentLimits,
} from "../subagent-policy.js";
import { loadConfig } from "../../core/config.js";
import { jsonResult } from "./common.js";
import {
	checkSessionToolAccess,
	type AgentToAgentPolicy,
	type SessionToolsVisibility,
} from "./sessions/shared.js";
import type { BrigadeTool } from "./types.js";

const ThinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
]);

const SpawnAgentsTask = Type.Object({
	task: Type.String({
		description:
			"What this sub-agent should do. Self-contained — it can't see the parent conversation or its siblings.",
		minLength: 1,
	}),
	label: Type.Optional(
		Type.String({
			description: "Short label (3-5 words). Shown in logs + the aggregated result envelope.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Model override for this child. Defaults to the parent's model." }),
	),
	thinking: Type.Optional(ThinkingLevel),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: `Per-child timeout in seconds. Default ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s. Applies independently to each task.`,
		}),
	),
});

const SpawnAgentsParams = Type.Object({
	tasks: Type.Array(SpawnAgentsTask, {
		description:
			"List of independent tasks. Each one becomes its own sub-agent that runs in parallel. The total count must be ≤ maxChildrenPerParent (default 5).",
		minItems: 1,
	}),
});

interface SpawnAgentsChildResult {
	label: string;
	/** ok = child returned a reply; aborted / timed-out = abort fired; limit-refused = policy block; error = unexpected throw. */
	status: "ok" | "aborted" | "timed-out" | "limit-refused" | "error";
	childSessionKey?: string;
	durationMs?: number;
	reply?: string;
	error?: string;
	/** Populated on `limit-refused`: "depth" | "concurrent" | "access-denied". */
	reason?: string;
}

interface SpawnAgentsResult {
	total: number;
	succeeded: number;
	failed: number;
	totalDurationMs: number;
	results: SpawnAgentsChildResult[];
}

export interface MakeSpawnAgentsToolOptions {
	parentSessionKey: string;
	parentAgentId: string;
	parentRunId?: string;
	parentSignal?: AbortSignal;
	parentProvider?: string;
	parentModelId?: string;
	visibility?: SessionToolsVisibility;
	a2aPolicy?: AgentToAgentPolicy;
	spawnedKeys?: ReadonlySet<string>;
	bypassAccessGuard?: boolean;
}

export function makeSpawnAgentsTool(
	opts: MakeSpawnAgentsToolOptions,
): BrigadeTool<typeof SpawnAgentsParams, SpawnAgentsResult> {
	return {
		name: "spawn_agents",
		label: "spawn sub-agents (parallel)",
		displaySummary: "spawning sub-agents in parallel",
		description:
			"SYNC blocking parallel fan-out. Dispatches N sub-agents in parallel, blocks until every child settles, " +
			"and returns an aggregated envelope `{total, succeeded, failed, totalDurationMs, results: [{label, status, reply, ...}]}` " +
			"so the next assistant turn can synthesise across replies. Use when the work decomposes into independent " +
			"sub-tasks. Total tasks must be ≤ maxChildrenPerParent (default 5). For ONE child use spawn_agent; for fire-and-forget use sessions_spawn.",
		parameters: SpawnAgentsParams,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<SpawnAgentsResult>> {
			const tasks = Array.isArray(params.tasks) ? params.tasks : [];
			if (tasks.length === 0) {
				return jsonResult({
					total: 0,
					succeeded: 0,
					failed: 0,
					totalDurationMs: 0,
					results: [],
				} satisfies SpawnAgentsResult) as AgentToolResult<SpawnAgentsResult>;
			}

			// Resolve limits up-front so we can refuse oversize fan-outs with a
			// concrete error message that names the operator's actual cap.
			const cfg = loadConfig();
			const limits = resolveSubagentLimits(cfg);
			if (tasks.length > limits.maxChildrenPerParent) {
				return jsonResult({
					total: tasks.length,
					succeeded: 0,
					failed: tasks.length,
					totalDurationMs: 0,
					results: tasks.map((t) => ({
						label: typeof t.label === "string" && t.label.trim() ? t.label : "sub-agent",
						status: "limit-refused" as const,
						reason: "concurrent",
						error: `spawn_agents refused: ${tasks.length} tasks exceeds maxChildrenPerParent=${limits.maxChildrenPerParent}. Split into ≤${limits.maxChildrenPerParent}-task batches.`,
					})),
				} satisfies SpawnAgentsResult) as AgentToolResult<SpawnAgentsResult>;
			}

			// Fail-closed access guard — same posture as spawn_agent. Unwired
			// callers refuse every spawn unless `bypassAccessGuard:true` is set
			// for trusted internal pathways (boot / cron / heartbeat).
			if (opts.bypassAccessGuard !== true) {
				if (!opts.visibility || !opts.a2aPolicy) {
					return jsonResult({
						total: tasks.length,
						succeeded: 0,
						failed: tasks.length,
						totalDurationMs: 0,
						results: tasks.map((t) => ({
							label: typeof t.label === "string" && t.label.trim() ? t.label : "sub-agent",
							status: "limit-refused" as const,
							reason: "access-denied",
							error: "spawn_agents forbidden: session access policy not configured",
						})),
					} satisfies SpawnAgentsResult) as AgentToolResult<SpawnAgentsResult>;
				}
				const verdict = checkSessionToolAccess({
					action: "send",
					requesterSessionKey: opts.parentSessionKey,
					targetSessionKey: opts.parentSessionKey,
					visibility: opts.visibility,
					a2aPolicy: opts.a2aPolicy,
					...(opts.spawnedKeys ? { spawnedKeys: opts.spawnedKeys } : {}),
				});
				if (!verdict.allowed) {
					return jsonResult({
						total: tasks.length,
						succeeded: 0,
						failed: tasks.length,
						totalDurationMs: 0,
						results: tasks.map((t) => ({
							label: typeof t.label === "string" && t.label.trim() ? t.label : "sub-agent",
							status: "limit-refused" as const,
							reason: "access-denied",
							error: verdict.error,
						})),
					} satisfies SpawnAgentsResult) as AgentToolResult<SpawnAgentsResult>;
				}
			}

			const combinedSignal = combineSignals(opts.parentSignal, signal);
			const { runSubagent } = await import("../subagent-runner.js");
			const t0 = Date.now();

			// Promise.allSettled is the right primitive here — one child's
			// crash must not bring down the others; each result lands in the
			// aggregated envelope independently.
			const settled = await Promise.allSettled(
				tasks.map(async (t): Promise<SpawnAgentsChildResult> => {
					const label = typeof t.label === "string" && t.label.trim() ? t.label : "sub-agent";
					const task = typeof t.task === "string" ? t.task : "";
					const thinkingRaw = typeof t.thinking === "string" ? t.thinking : undefined;
					const thinking =
						thinkingRaw === "off" ||
						thinkingRaw === "low" ||
						thinkingRaw === "medium" ||
						thinkingRaw === "high"
							? thinkingRaw
							: undefined;
					const modelOverride = typeof t.model === "string" && t.model.trim() ? t.model : undefined;
					const timeoutSeconds =
						typeof t.timeoutSeconds === "number" && Number.isFinite(t.timeoutSeconds)
							? Math.floor(t.timeoutSeconds)
							: undefined;
					const effectiveModel = modelOverride ?? opts.parentModelId;
					try {
						const result = await runSubagent({
							parentSessionKey: opts.parentSessionKey,
							parentAgentId: opts.parentAgentId,
							...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
							task,
							label,
							...(opts.parentProvider !== undefined ? { provider: opts.parentProvider } : {}),
							...(effectiveModel !== undefined ? { modelId: effectiveModel } : {}),
							...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
							...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
							...(combinedSignal !== undefined ? { parentSignal: combinedSignal } : {}),
						});
						return {
							label,
							status: result.aborted ? (result.timedOut ? "timed-out" : "aborted") : "ok",
							childSessionKey: result.childSessionKey,
							durationMs: result.durationMs,
							reply: result.reply,
						};
					} catch (err) {
						if (err instanceof SubagentLimitError) {
							return {
								label,
								status: "limit-refused",
								reason: err.kind,
								error: err.message,
							};
						}
						return {
							label,
							status: "error",
							error: err instanceof Error ? err.message : String(err),
						};
					}
				}),
			);

			// allSettled never rejects — but pluck `value` for fulfilled and
			// synthesise an error envelope for the rejected case (which can
			// only happen if our own mapper above throws, which it shouldn't
			// because everything is wrapped in try/catch).
			const results: SpawnAgentsChildResult[] = settled.map((s, i) => {
				if (s.status === "fulfilled") return s.value;
				const label =
					typeof tasks[i]?.label === "string" && tasks[i]!.label!.trim()
						? tasks[i]!.label!
						: "sub-agent";
				return {
					label,
					status: "error" as const,
					error: s.reason instanceof Error ? s.reason.message : String(s.reason),
				};
			});

			const succeeded = results.filter((r) => r.status === "ok").length;
			const failed = results.length - succeeded;
			return jsonResult({
				total: results.length,
				succeeded,
				failed,
				totalDurationMs: Date.now() - t0,
				results,
			} satisfies SpawnAgentsResult) as AgentToolResult<SpawnAgentsResult>;
		},
	};
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return undefined;
	if (live.length === 1) return live[0];
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn(live);
	const controller = new AbortController();
	for (const s of live) {
		if (s.aborted) {
			controller.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
	}
	return controller.signal;
}
