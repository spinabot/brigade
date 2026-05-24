/**
 * `spawn_agent` tool — Primitive #6.
 *
 * The model calls this to delegate a self-contained task to a sub-agent.
 * The sub-agent runs its own Brigade session with the same persona but a
 * minimal system prompt (Commit 2), and returns its final reply as the
 * tool result. Heavy lifting — depth/concurrency limits, abort linking,
 * timeout enforcement — lives in `subagent-runner.ts` + `subagent-policy.ts`.
 *
 * The registry passes a `MakeSpawnAgentToolOptions` closure at construction
 * time so the tool's `execute` has the parent's session key + run id + abort
 * signal without needing to re-look them up at call time. That's the same
 * pattern memory tools use (capability injected at factory time).
 *
 * The runner module is loaded dynamically inside `execute` to break the
 * registry → tool → runner → agent-loop → session-wiring → registry static-
 * import cycle. By call time `agent-loop.js` is fully evaluated, so the
 * dynamic import resolves from cache.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
	DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
	SubagentLimitError,
} from "../subagent-policy.js";
import { readNumberParam, readStringParam, textResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const SpawnAgentParams = Type.Object({
	task: Type.String({
		description:
			"What you want the sub-agent to do. Phrase it as a self-contained instruction — " +
			"the sub-agent doesn't see this conversation, so include any context it needs " +
			"(file paths, prior decisions, constraints, success criteria).",
	}),
	label: Type.Optional(
		Type.String({
			description:
				"Short label for the sub-agent (3-5 words, e.g. 'audit auth flow'). Shown in " +
				"TUI logs and approval prompts. Defaults to 'sub-agent'.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Override the model id for the sub-agent (e.g. 'claude-haiku-4-5'). " +
				"Defaults to the workspace's resolved default model.",
		}),
	),
	thinking: Type.Optional(
		Type.Union(
			[Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
			{
				description:
					"Override the thinking level for the sub-agent. Defaults to 'off' so cheap " +
					"sub-tasks run cheap; raise to 'high' for harder reasoning.",
			},
		),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				`Wall-clock timeout in seconds. Defaults to ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s. ` +
				`Use a smaller value (60-120s) for quick lookups, larger (600-1800s) for ` +
				`heavier research tasks.`,
		}),
	),
	cleanup: Type.Optional(
		Type.Union(
			[Type.Literal("keep"), Type.Literal("delete")],
			{
				description:
					"Transcript-file retention after the sub-agent settles. " +
					"`keep` (default) leaves the child's transcript on disk so the operator " +
					"can inspect it later. `delete` removes the transcript once the run " +
					"completes — use this for short-lived research tasks where the parent's " +
					"tool result is the only meaningful artefact.",
			},
		),
	),
});

interface SpawnAgentDetails {
	/** ok = child returned a reply; aborted / timed-out = abort fired; limit-refused = policy block. */
	status: "ok" | "aborted" | "timed-out" | "limit-refused";
	label: string;
	childSessionKey?: string;
	durationMs?: number;
	/** Populated on `limit-refused` to expose the underlying SubagentLimitError.kind. */
	reason?: string;
}

export interface MakeSpawnAgentToolOptions {
	/** Parent's session key — drives the child's derived key + concurrency map. */
	parentSessionKey: string;
	/** Parent's agent id — sub-agent inherits unless we add an override later. */
	parentAgentId: string;
	/** Parent's run id (optional today, used for event correlation in Commit 4). */
	parentRunId?: string;
	/** Parent's abort signal — linked into the child's combined signal. */
	parentSignal?: AbortSignal;
	/**
	 * Parent's RESOLVED provider + modelId. The child inherits these unless
	 * the `spawn_agent` call's `model` param explicitly overrides. Without
	 * this seam, the runner would fall back to a hardcoded "anthropic" /
	 * "claude-opus-4-7" default — which crashes an Ollama-only operator
	 * with "Model not registered". Threading the parent's actual values
	 * through means the child always uses whatever the parent is using.
	 */
	parentProvider?: string;
	parentModelId?: string;
}

/**
 * Build the `spawn_agent` tool. Pure factory: captures the parent context in
 * a closure and returns a Brigade tool object. The body is the only place
 * Brigade tool code dynamically imports the runner, which is what keeps the
 * registry → runner cycle from biting at module-load time.
 */
export function makeSpawnAgentTool(
	opts: MakeSpawnAgentToolOptions,
): BrigadeTool<typeof SpawnAgentParams, SpawnAgentDetails> {
	return {
		name: "spawn_agent",
		label: "spawn sub-agent",
		displaySummary: "spawning sub-agent",
		description:
			"Delegate a self-contained task to a sub-agent. The sub-agent runs its own " +
			"Brigade session, inherits the workspace persona but starts with a minimal " +
			"system prompt, and returns its final reply as this tool's result. Use this " +
			"for bounded subtasks (research a file, summarise a long document, run a " +
			"focused audit) — NOT for long open-ended conversations that need shared " +
			"context with the operator. Sub-agents cannot spawn further sub-agents " +
			"(depth limit 1 in v1). The parent can cancel a running sub-agent via the " +
			"normal turn-abort path.",
		parameters: SpawnAgentParams,
		async execute(
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<SpawnAgentDetails>> {
			const task = readStringParam(params, "task", { required: true });
			const label = readStringParam(params, "label") ?? "sub-agent";
			const model = readStringParam(params, "model");
			const thinkingRaw = readStringParam(params, "thinking");
			const thinking =
				thinkingRaw === "off" ||
				thinkingRaw === "low" ||
				thinkingRaw === "medium" ||
				thinkingRaw === "high"
					? thinkingRaw
					: undefined;
			const timeoutSeconds = readNumberParam(params, "timeoutSeconds", { integer: true });
			const cleanupRaw = readStringParam(params, "cleanup");
			const cleanup =
				cleanupRaw === "delete" || cleanupRaw === "keep" ? cleanupRaw : undefined;

			const combinedSignal = combineSignals(opts.parentSignal, signal);

			try {
				const { runSubagent } = await import("../subagent-runner.js");
				// Resolve provider + modelId: caller-supplied `model` wins; else
				// the parent's resolved values; else the runner falls back to
				// the workspace default. We pass `provider` ONLY when we know
				// it (always known if parent's values were threaded) so we
				// never set provider to undefined explicitly.
				const inheritedProvider = opts.parentProvider;
				const effectiveModel = model ?? opts.parentModelId;
				const result = await runSubagent({
					parentSessionKey: opts.parentSessionKey,
					parentAgentId: opts.parentAgentId,
					...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
					task,
					label,
					...(inheritedProvider !== undefined ? { provider: inheritedProvider } : {}),
					...(effectiveModel !== undefined ? { modelId: effectiveModel } : {}),
					...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
					...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
					...(combinedSignal !== undefined ? { parentSignal: combinedSignal } : {}),
					...(cleanup !== undefined ? { cleanup } : {}),
				});
				if (result.aborted) {
					return textResult(result.reply, {
						status: result.timedOut ? "timed-out" : "aborted",
						label,
						childSessionKey: result.childSessionKey,
						durationMs: result.durationMs,
					});
				}
				return textResult(result.reply, {
					status: "ok",
					label,
					childSessionKey: result.childSessionKey,
					durationMs: result.durationMs,
				});
			} catch (err) {
				if (err instanceof SubagentLimitError) {
					return textResult(err.message, {
						status: "limit-refused",
						label,
						reason: err.kind,
					});
				}
				throw err;
			}
		},
	};
}

/**
 * Combine the tool's per-call abort signal (from Pi) with the parent's
 * captured signal so cancellation flows down to the child whether it
 * originates from the turn-level abort OR the tool-level abort.
 */
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
