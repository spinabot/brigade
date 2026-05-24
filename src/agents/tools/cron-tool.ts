/**
 * `cron` — agent-callable scheduler control tool. Owner-only.
 *
 * Lets the operator (via the chat/connect TUI) manage scheduled jobs:
 *   - `status`  — service-level snapshot (job count, next wake, running).
 *   - `list`    — paginated job list.
 *   - `add`     — create a new job. Schedule + payload + delivery in one call.
 *   - `update`  — patch one job by id.
 *   - `remove`  — delete one job by id.
 *   - `run`     — fire one job NOW (force or only-if-due).
 *   - `runs`    — fetch run history for one job.
 *   - `wake`    — inject a system-event string into the operator's main session.
 *
 * Reaches the cron service via the process-wide `getActiveCronService()`
 * singleton. The tool refuses politely if the daemon hasn't been booted
 * (so unit tests + standalone CLI invocations get a clear error rather
 * than a confusing exception).
 *
 * Ownership: `ownerOnly: true` — sub-agents and non-operator senders cannot
 * mutate the cron set. Their `cron` calls return a 403-class refusal at
 * the ownership wrapper layer, before the action even runs.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { getActiveCronService } from "../../cron/active-service.js";
import {
	add as cronAdd,
	enqueueRun as cronEnqueueRun,
	listPage as cronListPage,
	remove as cronRemove,
	run as cronRun,
	runs as cronRuns,
	status as cronStatus,
	update as cronUpdate,
	wake as cronWake,
} from "../../cron/service/ops.js";
import type {
	CronJobCreate,
	CronJobPatch,
	CronWakeMode,
} from "../../cron/types.js";
import {
	failedTextResult,
	payloadTextResult,
	readNumberParam,
	readStringParam,
} from "./common.js";
import type { BrigadeTool } from "./types.js";

/**
 * Schema is purposefully permissive (`Type.Any()` on the payload-style
 * subfields) — the cron service's `assertSupportedJobSpec` does the real
 * validation. Pushing strict TypeBox here would force us to mirror the
 * cron types one layer up the stack, and any drift between the two would
 * be a permanent bug-hunt source.
 */
const CronToolParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("list"),
			Type.Literal("add"),
			Type.Literal("update"),
			Type.Literal("remove"),
			Type.Literal("run"),
			Type.Literal("runs"),
			Type.Literal("wake"),
		],
		{
			description:
				"Which cron operation to perform. " +
				"`status` = service snapshot; `list` = paginated job list; `add` = create job; " +
				"`update` = patch job by id; `remove` = delete job; `run` = fire now; " +
				"`runs` = history; `wake` = inject system-event into main session.",
		},
	),
	job: Type.Optional(
		Type.Any({
			description:
				"For `action: \"add\"` — the full `CronJobCreate` object " +
				"(name, schedule, payload, sessionTarget, etc.).",
		}),
	),
	patch: Type.Optional(
		Type.Any({
			description:
				"For `action: \"update\"` — partial fields to apply to the job.",
		}),
	),
	jobId: Type.Optional(
		Type.String({
			description:
				"Target job id. Required for update / remove / run / runs.",
		}),
	),
	runMode: Type.Optional(
		Type.Union([Type.Literal("due"), Type.Literal("force")], {
			description:
				"For `action: \"run\"` — `due` only if the job is past its " +
				"next-fire, `force` regardless. Default `force`.",
		}),
	),
	includeDisabled: Type.Optional(
		Type.Boolean({
			description:
				"For `action: \"list\"` — include disabled jobs. Default false.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Pagination cap for `list` and `runs`. Default 50, max 200.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Pagination offset for `list` and `runs`. Default 0.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Free-text filter for `list` — matches name/description/id.",
		}),
	),
	wakeMode: Type.Optional(
		Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")], {
			description:
				"For `action: \"wake\"` — `now` forces a heartbeat; `next-heartbeat` " +
				"waits for the next natural cycle. Default `next-heartbeat`.",
		}),
	),
	text: Type.Optional(
		Type.String({
			description: "Wake-action system-event text payload.",
		}),
	),
});

type CronToolDetails =
	| { action: "status"; status: unknown }
	| { action: "list"; result: unknown }
	| { action: "add"; job: unknown }
	| { action: "update"; job: unknown }
	| { action: "remove"; removed: boolean; jobId: string }
	| { action: "run"; jobId: string; mode: string }
	| { action: "runs"; jobId: string; entries: unknown[] }
	| { action: "wake"; mode: CronWakeMode };

/**
 * Build the `cron` tool. Caller is the registry — when the cron service is
 * active, the tool registers; otherwise it stays out of the surface.
 */
export function makeCronTool(): BrigadeTool<typeof CronToolParams, CronToolDetails> {
	return {
		name: "cron",
		label: "cron",
		displaySummary: "managing cron jobs",
		description:
			"Schedule + manage cron jobs (recurring or one-shot). Add jobs with `add`, " +
			"list with `list`, fire one immediately with `run`, see history with `runs`, " +
			"inject a wake message into the main session with `wake`. Operator-only — " +
			"sub-agents can't touch this.",
		parameters: CronToolParams,
		ownerOnly: true,
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<CronToolDetails>> {
			const state = getActiveCronService();
			if (!state) {
				return failedTextResult(
					"cron service is not running — start the gateway (`brigade gateway`) first",
					{ action: "status", status: { error: "not-initialised" } } as never,
				);
			}
			const action = readStringParam(params, "action", { required: true }) as
				| "status" | "list" | "add" | "update" | "remove" | "run" | "runs" | "wake";
			switch (action) {
				case "status": {
					const status = await cronStatus(state);
					return payloadTextResult({ action, status });
				}
				case "list": {
					const includeDisabled = (params as { includeDisabled?: unknown }).includeDisabled === true;
					const limit = readNumberParam(params, "limit", { integer: true });
					const offset = readNumberParam(params, "offset", { integer: true });
					const query = readStringParam(params, "query");
					const result = await cronListPage(state, {
						enabled: includeDisabled ? "all" : "enabled",
						...(limit !== undefined ? { limit } : {}),
						...(offset !== undefined ? { offset } : {}),
						...(query !== undefined ? { query } : {}),
					});
					return payloadTextResult({ action, result });
				}
				case "add": {
					const jobInput = (params as { job?: unknown }).job;
					if (!jobInput || typeof jobInput !== "object") {
						return failedTextResult(
							"`job` parameter required for cron add",
							{ action, job: null } as never,
						);
					}
					const created = await cronAdd(state, jobInput as CronJobCreate);
					return payloadTextResult({ action, job: created });
				}
				case "update": {
					const jobId = readStringParam(params, "jobId", { required: true });
					const patch = (params as { patch?: unknown }).patch;
					if (!patch || typeof patch !== "object") {
						return failedTextResult(
							"`patch` parameter required for cron update",
							{ action, job: null } as never,
						);
					}
					const updated = await cronUpdate(state, jobId, patch as CronJobPatch);
					return payloadTextResult({ action, job: updated });
				}
				case "remove": {
					const jobId = readStringParam(params, "jobId", { required: true });
					const removed = await cronRemove(state, jobId);
					return payloadTextResult({ action, removed, jobId });
				}
				case "run": {
					const jobId = readStringParam(params, "jobId", { required: true });
					const runModeRaw = readStringParam(params, "runMode") ?? "force";
					const mode = runModeRaw === "due" ? "due" : "force";
					// Enqueue (non-blocking) so the agent's turn doesn't sit waiting.
					await cronEnqueueRun(state, jobId, mode);
					// Suppress unused-import on cronRun for now — it's referenced for
					// the parallel inline-execute path callers can adopt later.
					void cronRun;
					return payloadTextResult({ action, jobId, mode });
				}
				case "runs": {
					const jobId = readStringParam(params, "jobId", { required: true });
					const limit = readNumberParam(params, "limit", { integer: true });
					const offset = readNumberParam(params, "offset", { integer: true });
					const entries = await cronRuns(state, jobId, {
						...(limit !== undefined ? { limit } : {}),
						...(offset !== undefined ? { offset } : {}),
					});
					return payloadTextResult({ action, jobId, entries });
				}
				case "wake": {
					const text = readStringParam(params, "text", { required: true });
					const wakeModeRaw = readStringParam(params, "wakeMode");
					const mode: CronWakeMode = wakeModeRaw === "now" ? "now" : "next-heartbeat";
					cronWake(state, text, mode);
					return payloadTextResult({ action, mode });
				}
			}
		},
	};
}
