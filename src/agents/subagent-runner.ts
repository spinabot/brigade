/**
 * Sub-agent runner — Primitive #6.
 *
 * Drives a CHILD `runSingleTurn` for an ephemeral session keyed off the
 * parent. The child gets:
 *
 *   - Its own session key — `agent:<id>:subagent:<uuid>` — which lands its
 *     transcript in a separate JSONL file, isolates its message history, and
 *     trips the system-prompt assembler's minimal-mode switch (Commit 2).
 *   - The parent's persona dir (single-user → shared SOUL/IDENTITY/USER).
 *   - A linked abort signal that fires from EITHER the parent's cancellation
 *     OR a wall-clock timeout (default 300s, override per call).
 *   - The same hardened loop (auth, model registry, exec-gate, retry,
 *     stream wrappers) the parent runs — by recursing into `runSingleTurn`
 *     rather than rebuilding session wiring.
 *
 * Slot accounting + race-safe reservation lives in `subagent-policy.ts`;
 * this module orchestrates: reserve → mark started → run → release → optional
 * transcript delete → report.
 *
 * Pi 0.70.6 was verified safe for nested AgentSessions (per-Agent activeRun
 * check, no global locks, per-session event subscriptions). The child's Pi
 * session is created inside `runSingleTurn`, which always builds a fresh
 * Agent + AgentSession — so the parent's session is never reused.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { readConfigOrInit, type BrigadeConfig } from "../config/io.js";
import { resolveSessionTranscriptPath } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import {
	deleteSessionEntry,
	type SubagentSessionMetadata,
} from "../sessions/session-store.js";
import {
	buildChildSessionKey,
	getSubagentDepthFromSessionKey,
	markSubagentRunStarted,
	releaseSubagentSlot,
	reserveSubagentSlot,
	resolveSubagentLimits,
} from "./subagent-policy.js";

const log = createSubsystemLogger("subagent/run");

export interface RunSubagentArgs {
	/** Parent session key. Used to derive the child key + track concurrency. */
	parentSessionKey: string;
	/** Parent agent id. Child inherits unless `childAgentId` is explicit. */
	parentAgentId: string;
	/** Parent's runId — forwarded for event correlation + approval attribution. */
	parentRunId?: string;
	/** Task the child should perform. Delivered as the child's first user message
	 *  (with `[Sub-agent Context]` + `[Sub-agent Task]:` framing prepended). */
	task: string;
	/** Short human label (TUI + approval prompts). Defaults to `"sub-agent"`. */
	label?: string;
	/** Provider override; defaults to the workspace's resolved default. */
	provider?: string;
	/** Model id override; defaults to the workspace's resolved default. */
	modelId?: string;
	/** Thinking level override; defaults to `"off"`. */
	thinkingLevel?: "off" | "low" | "medium" | "high";
	/** Wall-clock timeout in seconds. Defaults to `subagents.defaultTimeoutSeconds`. */
	timeoutSeconds?: number;
	/** Parent's abort signal — propagates cancellation downward. */
	parentSignal?: AbortSignal;
	/**
	 * Cleanup policy. `"keep"` (default) leaves the child transcript on disk
	 * so the operator can inspect it via `brigade sessions show <key>`.
	 * `"delete"` removes the JSONL file once the run settles (success OR
	 * failure) — useful for short-lived research tasks where the parent's
	 * tool result is the only meaningful artefact.
	 */
	cleanup?: "delete" | "keep";
}

export interface RunSubagentResult {
	childSessionKey: string;
	reply: string;
	durationMs: number;
	/** True when the child was aborted (timeout OR parent cancellation). */
	aborted: boolean;
	/** True when the timeout (rather than parent cancel) fired the abort. */
	timedOut: boolean;
}

/**
 * Combine an arbitrary number of optional AbortSignals into one. Uses
 * `AbortSignal.any` when the runtime exposes it (Node 22+ — Brigade's target),
 * with a manual fallback for older runtimes. Returning the input directly when
 * only one signal is present avoids an unnecessary controller allocation.
 */
function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return new AbortController().signal;
	if (live.length === 1) return live[0]!;
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn(live);
	const controller = new AbortController();
	const onAbort = (reason: unknown): void => controller.abort(reason);
	for (const s of live) {
		if (s.aborted) {
			controller.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => onAbort(s.reason), { once: true });
	}
	return controller.signal;
}

function resolveDefaultProvider(config: BrigadeConfig): string {
	const provider = (
		config.agents as { defaults?: { provider?: unknown } } | undefined
	)?.defaults?.provider;
	if (typeof provider === "string" && provider.length > 0) return provider;
	return "anthropic";
}

function resolveDefaultModel(config: BrigadeConfig): string {
	const model = (
		config.agents as { defaults?: { model?: { primary?: unknown } } } | undefined
	)?.defaults?.model?.primary;
	if (typeof model === "string" && model.length > 0) return model;
	return "claude-opus-4-7";
}

/**
 * Build the child's first user message. Wraps the raw task in structured
 * prefixes so the model can distinguish framing-from-system vs the actual
 * instruction it must execute:
 *
 *   [Sub-agent Context] You are running as a sub-agent (depth N/M)...
 *   [Sub-agent Task]: <verbatim task>
 *
 * Mirrors the proven shape: separating context from task improves task
 * adherence on smaller models that otherwise blur the boundary.
 */
function buildChildFirstUserMessage(args: {
	task: string;
	childDepth: number;
	maxDepth: number;
	label: string;
}): string {
	const lines = [
		`[Sub-agent Context] You are running as a sub-agent (depth ${args.childDepth}/${args.maxDepth}). ` +
			`Your final assistant reply becomes the parent's tool result; the operator will not see ` +
			`any of your intermediate output. Do NOT poll, do NOT busy-wait — just do the task and reply once.`,
		`[Sub-agent Task]: ${args.task}`,
	];
	void args.label; // reserved for future "labeled context" expansion
	return lines.join("\n\n");
}

/**
 * Best-effort transcript file deletion. Called when `cleanup === "delete"`
 * after the run settles. Swallows errors (missing file, permission issues)
 * because the run already settled — failing here would obscure the real
 * outcome with a cleanup throw, and the operator can always `rm` it manually.
 *
 * Takes the resolved `sessionId` (UUID) rather than the sessionKey, because
 * `resolveSessionTranscriptPath` derives `<sessionsDir>/<sessionId>.jsonl`
 * from the UUID — the sessionId is whatever `runSingleTurn` returned in its
 * `result.sessionId`, so we delete the exact file the run wrote to.
 */
async function maybeDeleteChildTranscript(args: {
	parentAgentId: string;
	sessionId: string;
}): Promise<void> {
	try {
		const transcriptPath = resolveSessionTranscriptPath(args.parentAgentId, args.sessionId);
		await fs.rm(transcriptPath, { force: true });
	} catch (err) {
		log.warn("transcript cleanup failed", {
			sessionId: args.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Run a sub-agent end-to-end:
 *
 *   1. Resolve limits + caller depth (from the parent's session key shape).
 *   2. `reserveSubagentSlot` — atomic check + register; throws
 *      `SubagentLimitError` on violation; the caller (the `spawn_agent` tool)
 *      converts that to a refusal result.
 *   3. Mark the slot started, arm the timeout.
 *   4. Recurse into `runSingleTurn` with the child key + framed task. The
 *      dynamic import breaks the registry → tool → runner → agent-loop →
 *      session-wiring → registry cycle that a static import would create.
 *   5. Catch abort / timeout → return a synthetic reply describing what
 *      happened so the parent's tool result is never empty.
 *   6. Always `releaseSubagentSlot` in `finally` with the resolved outcome
 *      + clear the timeout. Optionally delete the child's transcript.
 */
export async function runSubagent(args: RunSubagentArgs): Promise<RunSubagentResult> {
	const config = readConfigOrInit();
	const limits = resolveSubagentLimits(config);
	const callerDepth = getSubagentDepthFromSessionKey(args.parentSessionKey);
	const label = args.label ?? "sub-agent";
	const cleanup = args.cleanup ?? "keep";

	const childSessionKey = buildChildSessionKey(args.parentSessionKey, randomUUID());

	// Race-safe atomic reserve. Throws SubagentLimitError on depth /
	// concurrency violation; the spawn tool's catch converts that to a
	// refusal tool-result.
	reserveSubagentSlot({
		parentSessionKey: args.parentSessionKey,
		childSessionKey,
		...(args.parentRunId !== undefined ? { parentRunId: args.parentRunId } : {}),
		label,
		callerDepth,
		limits,
		cleanup,
	});

	// `timeoutSeconds <= 0` is a footgun: setTimeout(...,0) fires on the next
	// tick, aborting the child before runSingleTurn can do anything useful.
	// Clamp to a 1-second floor so a misconfigured `timeoutSeconds: 0` becomes
	// a hard-but-survivable cap instead of an instant kill. A real "no timeout"
	// API would be a separate flag — we deliberately don't support it because
	// runaway child runs are the worst failure mode for an autonomous loop.
	const requestedTimeout = args.timeoutSeconds ?? limits.defaultTimeoutSeconds;
	const timeoutSeconds = requestedTimeout > 0 ? requestedTimeout : 1;
	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => {
		timeoutController.abort(new Error(`sub-agent timed out after ${timeoutSeconds}s`));
	}, timeoutSeconds * 1000);
	// Don't keep the event loop alive solely for this timer — the parent's
	// pending promise already keeps the process alive while the child runs.
	if (typeof (timeoutHandle as { unref?: () => unknown }).unref === "function") {
		(timeoutHandle as { unref?: () => unknown }).unref?.();
	}

	const combinedSignal = combineAbortSignals(args.parentSignal, timeoutController.signal);

	const provider = args.provider ?? resolveDefaultProvider(config);
	const modelId = args.modelId ?? resolveDefaultModel(config);
	const startMs = Date.now();
	const childDepth = callerDepth + 1;

	log.info("sub-agent starting", {
		parentSessionKey: args.parentSessionKey,
		childSessionKey,
		label,
		depth: childDepth,
		maxDepth: limits.maxDepth,
		timeoutSeconds,
		provider,
		modelId,
		cleanup,
	});

	const framedTask = buildChildFirstUserMessage({
		task: args.task,
		childDepth,
		maxDepth: limits.maxDepth,
		label,
	});

	// Primitive #6 — metadata persisted on the child's session-store entry so
	// post-crash forensics + `brigade sessions list` can identify children +
	// walk the ancestry chain via `spawnedBy`. Written ONCE at session
	// creation by runSingleTurn → resolveOrCreateSession.
	const subagentMetadata: SubagentSessionMetadata = {
		spawnDepth: childDepth,
		spawnedBy: args.parentSessionKey,
		...(args.parentRunId !== undefined ? { parentRunId: args.parentRunId } : {}),
		label,
		cleanup,
		spawnedAt: new Date().toISOString(),
	};

	let reply = "";
	let aborted = false;
	let timedOut = false;
	let runError: string | undefined;
	let childSessionId: string | undefined;

	try {
		// Lazy import severs the static-import cycle:
		//   subagent-runner → agent-loop → session-wiring → registry → spawn-agent-tool
		// At call time `agent-loop.js` has long since finished evaluating, so the
		// dynamic import resolves instantly from the module cache.
		const { runSingleTurn } = await import("./agent-loop.js");
		markSubagentRunStarted(args.parentSessionKey, childSessionKey);
		const result = await runSingleTurn({
			agentId: args.parentAgentId,
			provider,
			modelId,
			message: framedTask,
			sessionKey: childSessionKey,
			...(args.thinkingLevel !== undefined ? { thinkingLevel: args.thinkingLevel } : {}),
			signal: combinedSignal,
			senderIsOwner: true,
			// Primitive #6 — surface attribution to exec-gate so any bash call
			// the child makes shows "Sub-agent '<label>' wants to run …" to the
			// operator instead of the default "Brigade wants to run …".
			subagentLabel: label,
			...(args.parentRunId !== undefined ? { parentRunId: args.parentRunId } : {}),
			// Primitive #6 — persist sub-agent metadata on the child's session
			// entry so a `cat ~/.brigade/agents/<id>/sessions/sessions.json`
			// after a crash shows what the child was, who spawned it, and what
			// cleanup policy it ran under.
			subagentMetadata,
		});
		reply = result.reply;
		childSessionId = result.sessionId;
	} catch (err) {
		aborted = combinedSignal.aborted;
		timedOut = timeoutController.signal.aborted;
		if (!aborted) {
			runError = err instanceof Error ? err.message : String(err);
		}
		if (!aborted) {
			// Genuine error from the child run — re-throw so the spawn tool can
			// surface a "sub-agent crashed" message instead of swallowing silently.
			// Cleanup (clearTimeout + releaseSubagentSlot + optional transcript
			// delete) happens in the `finally` block below.
			throw err;
		}
		reply = timedOut
			? `Sub-agent "${label}" timed out after ${timeoutSeconds}s before producing a reply.`
			: `Sub-agent "${label}" was cancelled before producing a reply.`;
	} finally {
		clearTimeout(timeoutHandle);
		const outcome = runError
			? "error"
			: timedOut
				? "timed-out"
				: aborted
					? "aborted"
					: "ok";
		releaseSubagentSlot({
			parentSessionKey: args.parentSessionKey,
			childSessionKey,
			outcome,
			...(runError !== undefined ? { error: runError } : {}),
		});
		// Only delete the transcript when we actually obtained a sessionId
		// from runSingleTurn — a child that crashed BEFORE the session was
		// opened has no file to delete and `childSessionId` stays undefined.
		// Also drop the session-store entry so a phantom record doesn't
		// outlive its transcript and clutter `brigade sessions list`. The
		// helper is idempotent: a fresh-then-crashed run that wrote the
		// entry but no JSONL still gets the entry pruned here.
		if (cleanup === "delete") {
			if (childSessionId !== undefined) {
				await maybeDeleteChildTranscript({
					parentAgentId: args.parentAgentId,
					sessionId: childSessionId,
				});
			}
			try {
				deleteSessionEntry(args.parentAgentId, childSessionKey);
			} catch (err) {
				log.warn("session-entry cleanup failed", {
					childSessionKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	const durationMs = Date.now() - startMs;
	log.info("sub-agent settled", {
		parentSessionKey: args.parentSessionKey,
		childSessionKey,
		label,
		durationMs,
		aborted,
		timedOut,
		replyChars: reply.length,
	});

	return {
		childSessionKey,
		reply,
		durationMs,
		aborted,
		timedOut,
	};
}
