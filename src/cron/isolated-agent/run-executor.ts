/**
 * Cron isolated-agent executor — bridges a `CronJob` to `runSingleTurn`.
 *
 * Called by `service/timer.ts` via the `runIsolatedAgentJob` dep when a
 * cron job's `sessionTarget` is `"isolated"` or `"session:<id>"`. For
 * `"main"` targets the timer path uses `enqueueSystemEvent` directly and
 * never reaches here.
 *
 * What this layer adds on top of `runSingleTurn`:
 *   - `senderIsOwner: false` — owner-only tools (bash) are pre-filtered out
 *     of the cron's tool surface, so an approval prompt the operator can't
 *     answer never gets queued.
 *   - `cronMode: true` capability — the assembler picks the right
 *     `## Cron` opener and gates operator-only sections.
 *   - `lightContext` honoured — when on, every workspace bootstrap file is
 *     dropped from the system prompt (token-cheap automation runs).
 *   - `toolsAllow` enforced — the model only sees the explicitly-allowlisted
 *     tools. Layered AFTER `senderIsOwner` so both filters compose.
 *   - Per-cron `provider` + `modelId` + `thinkingLevel` + `timeoutSeconds`
 *     resolved with sensible fallbacks (operator's defaults from config).
 *   - Session-key derivation: isolated → fresh uuid each run; session:<id>
 *     → stable per-name (preserves history across fires).
 */

import { randomUUID } from "node:crypto";

import { readConfigOrInit, type BrigadeConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { extractSessionTargetId, isSessionTargetWithId } from "../session-target.js";
import type {
	CronIsolatedRunArgs,
	CronIsolatedRunOutcome,
} from "../service/state.js";
import type { CronJob, CronPayloadAgentTurn } from "../types.js";

const log = createSubsystemLogger("cron/run-executor");

const DEFAULT_AGENT_ID = "main";

function resolveDefaultProvider(config: BrigadeConfig): string {
	const provider = (config.agents as { defaults?: { provider?: unknown } } | undefined)
		?.defaults?.provider;
	if (typeof provider === "string" && provider.length > 0) return provider;
	return "anthropic";
}

function resolveDefaultModel(config: BrigadeConfig): string {
	const model = (config.agents as { defaults?: { model?: { primary?: unknown } } } | undefined)
		?.defaults?.model?.primary;
	if (typeof model === "string" && model.length > 0) return model;
	return "claude-opus-4-7";
}

/**
 * Derive the child session key for this cron's run.
 *   - `"isolated"`     → fresh per-fire: `cron:<jobId>:run:<uuid>`
 *   - `"session:<id>"` → stable per name: `cron:<jobId>:<id>`
 *
 * `"main"` targets don't reach here (handled by the systemEvent path).
 */
function deriveCronSessionKey(job: CronJob): string {
	if (isSessionTargetWithId(job.sessionTarget)) {
		const id = extractSessionTargetId(job.sessionTarget);
		return `cron:${job.id}:${id}`;
	}
	// "isolated" — fresh uuid each run so per-fire transcripts don't collide.
	return `cron:${job.id}:run:${randomUUID()}`;
}

/**
 * Extract a short summary string from the assistant's final reply. The
 * caller (timer's `runDueJob`) uses this for the run-log entry + optional
 * delivery announcement. We collapse whitespace and cap at 240 chars so
 * the audit log stays scannable even for very long replies.
 */
function summariseReply(reply: string): string {
	const flat = reply.replace(/\s+/g, " ").trim();
	return flat.length <= 240 ? flat : `${flat.slice(0, 237)}…`;
}

/**
 * Execute one cron job as an isolated agent turn. Returns a uniform
 * `CronIsolatedRunOutcome` shape regardless of how the underlying run
 * resolved or threw.
 */
export async function executeCronAgentRun(
	args: CronIsolatedRunArgs,
): Promise<CronIsolatedRunOutcome> {
	const { job, abortSignal } = args;
	if (job.payload.kind !== "agentTurn") {
		return {
			status: "error",
			error: "executeCronAgentRun called with non-agentTurn payload",
		};
	}
	const payload = job.payload as CronPayloadAgentTurn;
	const config = readConfigOrInit();
	const agentId = job.agentId ?? DEFAULT_AGENT_ID;
	const provider = resolveDefaultProvider(config);
	const modelId = payload.model ?? resolveDefaultModel(config);
	const sessionKey = deriveCronSessionKey(job);

	log.info("cron run starting", {
		jobId: job.id,
		name: job.name,
		sessionKey,
		provider,
		modelId,
		lightContext: payload.lightContext === true,
		toolsAllowCount: payload.toolsAllow?.length ?? 0,
	});

	try {
		// Lazy import to keep this module decoupled from the agent loop at
		// module-load time. The dynamic import resolves from the cache on
		// every subsequent call, so the cost is one-time.
		const { runSingleTurn } = await import("../../agents/agent-loop.js");

		const result = await runSingleTurn({
			agentId,
			provider,
			modelId,
			message: payload.message,
			sessionKey,
			...(payload.thinking !== undefined ? { thinkingLevel: payload.thinking } : {}),
			...(abortSignal ? { signal: abortSignal } : {}),
			// Cron turns NEVER act as the operator. Owner-only tools (bash) get
			// pre-filtered out by `applyOwnerOnlyToolPolicy` so the model never
			// sees them — no possibility of an unanswerable approval prompt.
			senderIsOwner: false,
			// Cron-mode flag — flips the assembler into the "# Scheduled Task
			// Context" banner + gates operator-only sections. Without this the
			// cron run would render as a normal operator turn, which is the bug
			// the dedicated executor exists to prevent.
			cronMode: true,
			// Optional per-job lightContext — when set, drops EVERY workspace
			// bootstrap file from the persona prompt for a minimal token spend.
			...(payload.lightContext === true ? { lightContext: true } : {}),
			// Optional per-job tool allowlist — stacks AFTER the senderIsOwner
			// ownerOnly filter to give the model only the named tools.
			...(payload.toolsAllow && payload.toolsAllow.length > 0
				? { toolsAllow: payload.toolsAllow }
				: {}),
		});

		const reply = result.reply ?? "";
		return {
			status: "ok",
			summary: summariseReply(reply),
			sessionId: result.sessionId,
			sessionKey: result.sessionKey,
			...(result.servedBy?.provider !== undefined ? { provider: result.servedBy.provider } : { provider }),
			...(result.servedBy?.modelId !== undefined ? { model: result.servedBy.modelId } : { model: modelId }),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// AbortError → cron-side called this an abort; surface as a non-permanent
		// error so the failure-alert path applies the normal backoff schedule.
		log.warn("cron run threw", { jobId: job.id, error: message });
		return {
			status: "error",
			error: message,
		};
	}
}
