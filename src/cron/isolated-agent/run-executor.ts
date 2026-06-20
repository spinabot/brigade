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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveAgentWorkspaceDir } from "../../config/paths.js";
import { readConfigOrInit, type BrigadeConfig } from "../../config/io.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { extractSessionTargetId, isSessionTargetWithId } from "../session-target.js";
import type {
	CronIsolatedRunArgs,
	CronIsolatedRunOutcome,
} from "../service/state.js";
import type { CronJob, CronPayloadAgentTurn, CronPayloadScript } from "../types.js";

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

/** Pull the per-agent override block out of `config.agents.<agentId>` (when
 *  present), with permissive shape so we don't drift away from the actual
 *  config type's surface. */
function readAgentOverride(
	config: BrigadeConfig,
	agentId: string,
): { provider?: unknown; model?: { primary?: unknown } } | undefined {
	const agents = config.agents as Record<string, unknown> | undefined;
	if (!agents) return undefined;
	const ov = agents[agentId];
	if (!ov || typeof ov !== "object") return undefined;
	return ov as { provider?: unknown; model?: { primary?: unknown } };
}

/** Per-agent provider — `cfg.agents.<agentId>.provider` wins, then the
 *  workspace's `defaults.provider`, then "anthropic". */
export function resolveAgentProvider(config: BrigadeConfig, agentId: string): string {
	const ov = readAgentOverride(config, agentId);
	if (ov && typeof ov.provider === "string" && ov.provider.length > 0) {
		return ov.provider;
	}
	return resolveDefaultProvider(config);
}

/** Per-agent model — `cfg.agents.<agentId>.model.primary` wins, then the
 *  workspace's `defaults.model.primary`, then "claude-opus-4-7". */
export function resolveAgentModel(config: BrigadeConfig, agentId: string): string {
	const ov = readAgentOverride(config, agentId);
	if (ov?.model && typeof ov.model.primary === "string" && ov.model.primary.length > 0) {
		return ov.model.primary;
	}
	return resolveDefaultModel(config);
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
	// Self-identification prefix — lift from reference run-executor so the
	// isolated turn's input clearly carries the cron id + name. Without this
	// the model sees a bare prompt and may treat it as a normal operator
	// turn, losing the "I am a scheduled job" context.
	const cronPrefix = `[cron:${job.id} ${job.name}]\n`;
	const messageWithPrefix = `${cronPrefix}${payload.message}`;
	// Per-agent provider/model resolution — `cfg.agents.<agentId>` wins over
	// `cfg.agents.defaults`. Without this multi-agent installs would always
	// run cron fires under the default agent's model even when the cron was
	// scheduled by a non-default agent.
	const provider = resolveAgentProvider(config, agentId);
	const modelId = payload.model ?? resolveAgentModel(config, agentId);
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
			message: messageWithPrefix,
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
		const errorKind = classifyAgentRunError(message);
		return {
			status: "error",
			error: message,
			...(errorKind ? { errorKind } : {}),
		};
	}
}

/**
 * Map a runtime error message to a retry classification. Returns
 * `"permanent"` for well-known unrecoverable shapes (model spec invalid,
 * unknown provider, malformed config) so the scheduler disables the job
 * rather than thrashing on backoff. Undefined falls back to the default
 * `"transient"` retry path.
 */
function classifyAgentRunError(message: string): "permanent" | undefined {
	const m = message.toLowerCase();
	if (m.includes("unknown provider")) return "permanent";
	if (m.includes("invalid model")) return "permanent";
	if (m.includes("model not found")) return "permanent";
	if (m.includes("no such agent")) return "permanent";
	return undefined;
}

/* ───────────────────────── script payload (cost-saver) ───────────────────────── */

const SCRIPT_OUTPUT_CAP_BYTES = 64 * 1024;

interface ShellResult {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
}

/** Run a shell command, bounded by time + output size. Never rejects — a spawn
 *  error resolves as a non-zero exit. The command is OWNER-authored (script cron
 *  jobs are owner-only), so a shell is acceptable here, like a crontab line. */
function runShellCommand(
	command: string,
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ShellResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(command, { cwd: opts.cwd, shell: true });
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener?.("abort", onAbort);
			resolve({ stdout, stderr, code, timedOut });
		};
		const onAbort = (): void => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			onAbort();
			finish(124);
		}, opts.timeoutMs);
		timer.unref?.();
		opts.signal?.addEventListener?.("abort", onAbort, { once: true });
		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < SCRIPT_OUTPUT_CAP_BYTES) stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < SCRIPT_OUTPUT_CAP_BYTES) stderr += d.toString("utf8");
		});
		child.on("error", (e: Error) => {
			stderr += String(e?.message ?? e);
			finish(1);
		});
		child.on("close", (code: number | null) => finish(code ?? 0));
	});
}

/** The script can opt OUT of waking the agent at runtime: a final stdout line
 *  `{"wakeAgent":false}` means "nothing to act on — don't spend a model turn". */
function scriptRequestsNoWake(stdout: string): boolean {
	const lines = stdout.trimEnd().split("\n");
	const last = lines[lines.length - 1]?.trim();
	if (!last || !last.startsWith("{")) return false;
	try {
		return (JSON.parse(last) as { wakeAgent?: unknown }).wakeAgent === false;
	} catch {
		return false;
	}
}

/**
 * Execute a `script` cron job. By default delivers the command's stdout with NO
 * model turn (zero tokens — the cost saver). When `wakeAgent` is set AND the
 * script didn't veto it AND there's output, runs an agent turn with the stdout
 * injected. OWNER-ONLY at the execution boundary (defense-in-depth; createJob
 * also rejects channel-origin script jobs).
 */
export async function executeCronScriptRun(
	args: CronIsolatedRunArgs,
): Promise<CronIsolatedRunOutcome> {
	const { job, abortSignal } = args;
	if (job.payload.kind !== "script") {
		return { status: "error", error: "executeCronScriptRun called with non-script payload" };
	}
	if (job.createdBy && job.createdBy.kind !== "owner") {
		return { status: "error", error: "script cron jobs are owner-only", errorKind: "permanent" };
	}
	const payload = job.payload as CronPayloadScript;
	const agentId = job.agentId ?? DEFAULT_AGENT_ID;
	const cwd = payload.cwd && payload.cwd.trim() ? payload.cwd : resolveAgentWorkspaceDir(agentId);
	const timeoutMs = (payload.timeoutSeconds && payload.timeoutSeconds > 0 ? payload.timeoutSeconds : 60) * 1000;
	log.info("cron script starting", { jobId: job.id, name: job.name, cwd, timeoutMs, wakeAgent: payload.wakeAgent === true });

	const res = await runShellCommand(payload.command, {
		cwd,
		timeoutMs,
		...(abortSignal ? { signal: abortSignal } : {}),
	});

	const wake = payload.wakeAgent === true && !scriptRequestsNoWake(res.stdout) && res.stdout.trim() !== "";
	if (!wake) {
		// NO MODEL TURN — deliver the script output directly. Zero tokens.
		if (res.timedOut) return { status: "error", error: `script timed out after ${timeoutMs}ms` };
		if (res.code !== 0) {
			// Redact BOTH streams at the source so the downstream run-log +
			// failure-alert never carry a token / key / phone number. Include a
			// bounded stdout slice alongside stderr — many scripts log their
			// diagnostics to stdout, so a bare `script exited N` is useless when
			// the watchdog itself breaks.
			const errStderr = redactSensitiveText(res.stderr).slice(0, 200);
			const errStdout = redactSensitiveText(res.stdout).slice(0, 200);
			return {
				status: "error",
				error: `script exited ${res.code}${errStderr ? `: ${errStderr}` : ""}${errStdout ? `; stdout: ${errStdout}` : ""}`,
			};
		}
		// Redact stdout before it becomes the run outcome — the summary flows
		// verbatim to the persistent run-log AND (for announce-delivery jobs) to
		// a chat channel, so secrets must be scrubbed at the source.
		return { status: "ok", summary: summariseReply(redactSensitiveText(res.stdout) || "(no output)") };
	}

	// WAKE — run an agent turn over the script's output via the existing path.
	const derived: CronPayloadAgentTurn = {
		kind: "agentTurn",
		// Redact the injected stdout — when the wake agent's reply summarises or
		// echoes the script output it would otherwise carry secrets onward to the
		// run-log + announce sinks, so scrub at the source here too.
		message: `${payload.agentMessage?.trim() || "React to this scheduled script's output."}\n\n## Script Output\n\`\`\`\n${redactSensitiveText(res.stdout).slice(0, 8000)}\n\`\`\``,
		...(payload.timeoutSeconds ? { timeoutSeconds: payload.timeoutSeconds } : {}),
	};
	return executeCronAgentRun({ ...args, job: { ...job, payload: derived } });
}

/** Dispatch an isolated/session cron run by payload kind (the timer's
 *  `runIsolatedAgentJob` dep points here). */
export async function executeCronIsolatedRun(
	args: CronIsolatedRunArgs,
): Promise<CronIsolatedRunOutcome> {
	if (args.job.payload.kind === "script") return executeCronScriptRun(args);
	return executeCronAgentRun(args);
}
