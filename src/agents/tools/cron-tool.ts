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
	maybeAttachReminderContext,
	REMINDER_CONTEXT_MESSAGES_MAX,
} from "../../cron/reminder-context.js";
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
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import {
	failedTextResult,
	payloadTextResult,
	readNumberParam,
	readStringParam,
} from "./common.js";
import type { BrigadeTool } from "./types.js";

/**
 * Top-level keys the cron tool will accept on the flat surface and pull
 * back into a synthetic `job` (or `patch`) object when the model emits
 * them at the call's top level instead of nesting under `job` / `patch`.
 *
 * Non-frontier models (Grok, smaller local models) sometimes flatten
 * structured params into the tool's outer object — we recover defensively
 * so a clearly-intended cron-add doesn't fail with "job required".
 */
const CRON_FLAT_PAYLOAD_KEYS = [
	"message",
	"text",
	"model",
	"fallbacks",
	"toolsAllow",
	"thinking",
	"timeoutSeconds",
	"lightContext",
	"allowUnsafeExternalContent",
] as const;

const CRON_RECOVERABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
	"name",
	"schedule",
	"sessionTarget",
	"wakeMode",
	"payload",
	"delivery",
	"enabled",
	"description",
	"deleteAfterRun",
	"agentId",
	"sessionKey",
	"failureAlert",
	...CRON_FLAT_PAYLOAD_KEYS,
]);

/**
 * Per-turn context the cron tool reads during `add` to auto-fill delivery
 * targets. When the operator schedules a cron from a channel-routed turn
 * (e.g. WhatsApp DM), the active channel + conversation + thread are
 * threaded here so the resulting job's `delivery.channel/to/threadId`
 * default to "reply back into THIS chat" without the model needing to
 * specify the target explicitly.
 *
 * The model can still override per-call by passing explicit `delivery`
 * params (e.g. "schedule X to message me on Slack instead even though
 * I'm asking from WhatsApp now") — auto-fill skips when an explicit
 * channel/to is already set.
 */
export interface MakeCronToolOptions {
	channelContext?: ChannelApprovalRoute;
	/** Active agent id — defaulted onto `job.agentId` when the caller omits it,
	 *  so cron fires routes back to the agent that scheduled them. */
	agentId?: string;
	/**
	 * Caller's session key — used to resolve `sessionTarget: "current"`
	 * into the persisted `session:<sessionKey>` form, and to fetch the
	 * caller's recent messages when `contextMessages` > 0. Omit in TUI /
	 * standalone CLI paths (the "current" alias then falls back to
	 * `"isolated"` and `contextMessages` becomes a no-op).
	 */
	agentSessionKey?: string;
}

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
	contextMessages: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: REMINDER_CONTEXT_MESSAGES_MAX,
			description:
				"For `action: \"add\"` with a `systemEvent` payload — number of " +
				"recent operator messages (0-10) to append as `Recent context:` " +
				"after the reminder text. Lets the fire-time consumer see what " +
				"the operator was just talking about. No-op for `agentTurn` " +
				"payloads (their `message` is the model's prompt; mixing in " +
				"random recent chat would pollute the isolated run). Default 0.",
		}),
	),
});

type CronToolDetails =
	| { action: "status"; status: unknown }
	| { action: "list"; result: unknown }
	| { action: "add"; job: unknown }
	| { action: "update"; job: unknown }
	| { action: "remove"; removed: boolean; jobId: string }
	| { action: "run"; jobId: string; mode: string; latestRun?: unknown }
	| { action: "runs"; jobId: string; entries: unknown[] }
	| { action: "wake"; mode: CronWakeMode };

/**
 * Build the `cron` tool. Caller is the registry — when the cron service is
 * active, the tool registers; otherwise it stays out of the surface.
 *
 * `opts.channelContext` is the active channel route for this turn (set by
 * the channel manager → agent-loop pipeline). When present, the tool's
 * `add` action auto-fills `delivery.channel/to/threadId` on agentTurn
 * payloads so the scheduled job's announce replies into the SAME chat
 * the operator created it from.
 */
export function makeCronTool(
	opts: MakeCronToolOptions = {},
): BrigadeTool<typeof CronToolParams, CronToolDetails> {
	const channelContext = opts.channelContext;
	const callerAgentId = opts.agentId;
	const agentSessionKey = opts.agentSessionKey;
	return {
		name: "cron",
		label: "cron",
		displaySummary: "managing cron jobs",
		description:
			"Schedule + manage cron jobs (recurring, interval, or one-shot). " +
			"Use this for reminders, 'check back later' tasks, delayed follow-ups, " +
			"and recurring routines. Do NOT emulate scheduling by sleeping in a " +
			"shell command — use this tool.\n\n" +
			"Actions: `add` (create), `list` / `runs` (read), `update` / `remove` " +
			"(modify), `run` (fire now), `status` (service snapshot), `wake` " +
			"(inject system-event text into the main session). Operator-only — " +
			"sub-agents can't touch this.\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"SCHEDULE KIND — pick by user intent:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
			"### `at` — ONE-SHOT at a future moment ###\n" +
			"USE THIS for:\n" +
			"  • \"in N minutes/hours\" / \"in 2 mins\" / \"30 minutes from now\"\n" +
			"  • \"tomorrow at 9am\" / \"next Tuesday\" / specific future moment\n" +
			"  • Any reminder that fires EXACTLY ONCE and then auto-deletes\n" +
			"Shape: `{kind: \"at\", at: <epoch_ms>}` OR `{kind: \"at\", atMs: <epoch_ms>}`\n" +
			"For \"in 2 minutes\": calculate `Date.now() + 2 * 60 * 1000` and pass as `at`.\n" +
			"NEVER use a 5-field cron expression for a relative reminder — cron expressions\n" +
			"match absolute calendar slots and may resolve a year out (e.g. `43 13 1 6 *`\n" +
			"interpreted on June 1 at 13:45 fires June 1 NEXT YEAR, not the 13:43 that\n" +
			"already passed). For one-shots, ALWAYS use `at`.\n\n" +
			"### `every` — RECURRING fixed interval ###\n" +
			"USE THIS for:\n" +
			"  • \"every N minutes/hours\" / \"check in every 10 minutes\"\n" +
			"  • Repeating reminders at a constant gap (NOT calendar-aligned)\n" +
			"Shape: `{kind: \"every\", everyMs: <interval_ms>, anchorMs?: <epoch_ms>}`\n" +
			"Example: every 5 min → `{kind: \"every\", everyMs: 300000}`.\n\n" +
			"### `cron` — CALENDAR-aligned recurring ###\n" +
			"USE THIS for:\n" +
			"  • \"daily at 9am\" / \"every Monday at 8am\" / \"first of the month\"\n" +
			"  • Anything where the user names a specific clock time or weekday\n" +
			"Shape: `{kind: \"cron\", expr: \"<5-field cron>\", tz: \"<IANA tz>\"}`\n" +
			"5-field syntax: `minute hour day-of-month month day-of-week` (`* * * * *`).\n\n" +
			"TIMEZONE RULE — CRITICAL:\n" +
			"  - ALWAYS set `tz` to a full IANA zone name (e.g. `\"Asia/Kolkata\"` for IST,\n" +
			"    `\"America/Los_Angeles\"` for PT, `\"Europe/London\"` for UK).\n" +
			"  - WRITE `expr` IN THE OPERATOR'S LOCAL TIME — `tz` does the conversion.\n" +
			"  - DO NOT manually convert to UTC, EVER. Writing `\"30 3 * * *\"` because\n" +
			"    \"9am IST is 03:30 UTC\" is WRONG — DST shifts, ambiguous winter slots,\n" +
			"    and operator-config drift all break manual conversion. If they say\n" +
			"    \"9am IST\", write `{expr: \"0 9 * * *\", tz: \"Asia/Kolkata\"}`.\n" +
			"  - Abbreviations like `\"IST\"`, `\"EST\"`, `\"PT\"`, `\"GMT\"` are NOT IANA\n" +
			"    zone names and will be rejected — use the full `Region/City` form.\n\n" +
			"Examples (always pair operator's local time + their IANA zone):\n" +
			"  • 9am daily IST:       `{kind: \"cron\", expr: \"0 9 * * *\", tz: \"Asia/Kolkata\"}`\n" +
			"  • 8am weekdays IST:    `{kind: \"cron\", expr: \"0 8 * * 1-5\", tz: \"Asia/Kolkata\"}`\n" +
			"  • 6:30pm Mon IST:      `{kind: \"cron\", expr: \"30 18 * * 1\", tz: \"Asia/Kolkata\"}`\n" +
			"  • 9am daily LA:        `{kind: \"cron\", expr: \"0 9 * * *\", tz: \"America/Los_Angeles\"}`\n" +
			"  • 7am daily NY:        `{kind: \"cron\", expr: \"0 7 * * *\", tz: \"America/New_York\"}`\n" +
			"  • 8am daily London:    `{kind: \"cron\", expr: \"0 8 * * *\", tz: \"Europe/London\"}`\n" +
			"  • 10am Tokyo:          `{kind: \"cron\", expr: \"0 10 * * *\", tz: \"Asia/Tokyo\"}`\n" +
			"  • First-of-month 9am:  `{kind: \"cron\", expr: \"0 9 1 * *\", tz: \"Asia/Kolkata\"}`\n" +
			"  • Every 15 min (any tz): `{kind: \"cron\", expr: \"*/15 * * * *\"}`\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"PAYLOAD — `payload.kind`:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  - `agentTurn`   — `{kind: \"agentTurn\", message: \"...\"}` (run a full\n" +
			"    agent turn at fire time; default sessionTarget=\"isolated\"). Optional\n" +
			"    `model`, `thinking`, `timeoutSeconds`, `toolsAllow`, `lightContext`.\n" +
			"  - `systemEvent` — `{kind: \"systemEvent\", text: \"...\"}` (inject text\n" +
			"    into the operator's main session at fire time; pairs with\n" +
			"    sessionTarget=\"main\").\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"DELIVERY (`delivery`) — where the reply lands (agentTurn only):\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  - `{mode: \"announce\", channel?, to?, threadId?, accountId?, bestEffort?}` —\n" +
			"    send the reply via a channel adapter (WhatsApp / Slack / …).\n" +
			"  - `{mode: \"webhook\", webhookUrl}` — HTTP POST to a URL.\n" +
			"  - `{mode: \"none\"}` — silent; run still happens but reply is discarded.\n\n" +
			"AUTO-ROUTING — when `add` is called from a channel-routed turn (operator\n" +
			"is messaging from WhatsApp / Slack / …) and you DON'T set `delivery.channel`\n" +
			"or `delivery.to`, the tool auto-fills them from the originating chat so the\n" +
			"cron's reply lands back in THIS chat automatically. Override by passing\n" +
			"explicit channel/to to target a DIFFERENT chat (e.g. \"schedule X to message\n" +
			"me on Slack at 6pm\" from a WhatsApp turn).\n\n" +
			"For TUI / connect-mode turns (no originating channel) the reply lands as\n" +
			"a system event in the operator's main session — they'll see `[cron \"X\"]\n" +
			"<reply>` in the chat surface they're connected to.\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"DELIVERY ROUTING — DO NOT call messaging tools inside the cron run:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  If the scheduled job should send its reply to a specific chat or\n" +
			"  recipient, set `delivery.channel` and `delivery.to` on the JOB at\n" +
			"  schedule time. The cron service's delivery dispatcher routes the\n" +
			"  reply once when the run finishes. Do NOT call `send_message` /\n" +
			"  channel tools INSIDE the agentTurn run — doing so burns extra\n" +
			"  tokens, may double-send (delivery THEN the inline send), and\n" +
			"  defeats the cron's announce-once semantics.\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"SESSION TARGETS — `sessionTarget` (resolved at CREATE time):\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  - `\"main\"`            — Run in the operator's primary session.\n" +
			"                          REQUIRES `payload.kind: \"systemEvent\"`.\n" +
			"                          Main-session crons enqueue system events\n" +
			"                          for the next heartbeat to consume.\n" +
			"  - `\"isolated\"`        — Run in a fresh ephemeral session per fire.\n" +
			"                          REQUIRES `payload.kind: \"agentTurn\"`.\n" +
			"                          Isolated/current crons create background\n" +
			"                          task runs that produce their own assistant\n" +
			"                          turns; the delivery block decides where\n" +
			"                          the result lands.\n" +
			"  - `\"current\"`         — Bind to the caller's current session\n" +
			"                          (resolved at CREATE time to\n" +
			"                          `session:<currentSessionKey>`; falls back\n" +
			"                          to `\"isolated\"` when no session is active).\n" +
			"                          REQUIRES `payload.kind: \"agentTurn\"`.\n" +
			"                          Use this when the cron should pick up\n" +
			"                          context from THIS conversation.\n" +
			"  - `\"session:<id>\"`    — Run in a persistent named session.\n" +
			"                          REQUIRES `payload.kind: \"agentTurn\"`.\n\n" +
			"  Defaults (kept stable for back-compat):\n" +
			"    - `payload.kind: \"systemEvent\"` → `sessionTarget: \"main\"`\n" +
			"    - `payload.kind: \"agentTurn\"`   → `sessionTarget: \"isolated\"`\n" +
			"  Explicitly set `\"current\"` or `\"session:<id>\"` only when the\n" +
			"  operator's intent is custom session binding.\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"CONTEXT MESSAGES — `contextMessages` (systemEvent reminders only):\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  For `action: \"add\"` with a `systemEvent` payload, set\n" +
			"  `contextMessages: <N>` (0-10) to append the operator's last N\n" +
			"  messages as a `Recent context:` block after the reminder text.\n" +
			"  Lets the fire-time heartbeat consumer see what the operator was\n" +
			"  just discussing. Capped at 700 total chars across all lines; each\n" +
			"  line is at most 220 chars (truncated with `...`). No-op for\n" +
			"  agentTurn payloads — their `message` is the prompt for the\n" +
			"  isolated run, and mixing in random recent chat would pollute it.\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"WAKE MODES — `wakeMode` (for `action: \"wake\"` and on the job):\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  - `\"next-heartbeat\"` (DEFAULT) — Queue the event and let the\n" +
			"      natural heartbeat cycle deliver it. Less disruptive; use for\n" +
			"      passive reminders / non-urgent context drops where the\n" +
			"      operator can afford to wait for the next tick (≤30s).\n" +
			"  - `\"now\"`                       — Force a heartbeat tick to fire\n" +
			"      immediately so the system event is consumed without waiting.\n" +
			"      Use for urgent reminders where latency matters (operator is\n" +
			"      actively engaged and the cron should interrupt promptly).\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"CONSTRAINTS:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  - `sessionTarget: \"main\"` MUST pair with `payload.kind: \"systemEvent\"`\n" +
			"  - `sessionTarget: \"isolated\"` / `\"current\"` / `\"session:<id>\"` MUST\n" +
			"    pair with `payload.kind: \"agentTurn\"`\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"WORKED EXAMPLES:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"User: \"remind me to drink water in 2 minutes\"\n" +
			"  → {action: \"add\", job: {\n" +
			"      name: \"water-reminder\",\n" +
			"      schedule: {kind: \"at\", at: <Date.now() + 120000>},\n" +
			"      payload: {kind: \"agentTurn\", message: \"Remind the operator: drink water.\"}\n" +
			"    }}\n\n" +
			"User: \"ping me every 30 minutes to stretch\"\n" +
			"  → {action: \"add\", job: {\n" +
			"      name: \"stretch-ping\",\n" +
			"      schedule: {kind: \"every\", everyMs: 1800000},\n" +
			"      payload: {kind: \"agentTurn\", message: \"Remind the operator: take a stretch break.\"}\n" +
			"    }}\n\n" +
			"User: \"every weekday at 8am send a morning checklist\" (operator in IST)\n" +
			"  → {action: \"add\", job: {\n" +
			"      name: \"morning-checklist\",\n" +
			"      schedule: {kind: \"cron\", expr: \"0 8 * * 1-5\", tz: \"Asia/Kolkata\"},\n" +
			"      payload: {kind: \"agentTurn\", message: \"Render today's morning checklist.\"}\n" +
			"    }}",
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
					// Flat-params recovery: non-frontier models (e.g. Grok, smaller
					// local models) sometimes flatten job fields to the top level
					// alongside `action` instead of nesting them under `job`. When
					// `params.job` is missing or an empty `{}`, recover by pulling
					// recognised top-level keys into a synthetic job — but only
					// promote it when at least one MEANINGFUL signal is present
					// (schedule, payload, message, or text). Without that
					// minimum-signal gate, a malformed call that happens to
					// include only `name` or `enabled` would be silently hijacked
					// into a bogus job.
					const recParams = params as Record<string, unknown>;
					const existingJob = recParams.job;
					const jobIsEmptyObject =
						typeof existingJob === "object" &&
						existingJob !== null &&
						!Array.isArray(existingJob) &&
						Object.keys(existingJob as Record<string, unknown>).length === 0;
					if (existingJob === undefined || existingJob === null || jobIsEmptyObject) {
						const synthetic: Record<string, unknown> = {};
						let found = false;
						for (const key of Object.keys(recParams)) {
							if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && recParams[key] !== undefined) {
								synthetic[key] = recParams[key];
								found = true;
							}
						}
						if (
							found &&
							(synthetic.schedule !== undefined ||
								synthetic.payload !== undefined ||
								synthetic.message !== undefined ||
								synthetic.text !== undefined)
						) {
							recParams.job = synthetic;
						}
					}
					const jobInput = recParams.job;
					if (!jobInput || typeof jobInput !== "object") {
						return failedTextResult(
							"`job` parameter required for cron add",
							{ action, job: null } as never,
						);
					}
					// Auto-fill delivery.channel/to/threadId from the active channel
					// context when the operator scheduled this from a channel-routed
					// turn (e.g. WhatsApp). The model can override by passing
					// explicit delivery params — autofill only kicks in when the
					// caller left the target unset AND the payload is an agentTurn
					// (system-event payloads default to mode "none" and don't
					// announce). See `applyChannelContextToCronAdd` for the rules.
					const jobWithDelivery = applyChannelContextToCronAdd(
						jobInput as Record<string, unknown>,
						channelContext,
					);
					// Default `job.agentId` onto the input so the cron service
					// remembers which agent scheduled the job — drives heartbeat
					// routing + per-agent model resolution + the announce-fallback
					// session key. Caller-supplied `agentId` always wins.
					const jobWithAgent: Record<string, unknown> =
						callerAgentId && typeof jobWithDelivery.agentId !== "string"
							? { ...jobWithDelivery, agentId: callerAgentId }
							: jobWithDelivery;
					// `contextMessages` is a top-level cron-tool param (NOT a job
					// field). For systemEvent reminders, append the caller's last
					// N messages to payload.text. Silent no-op for agentTurn,
					// empty text, or 0/missing contextMessages.
					const contextMessages =
						typeof (params as { contextMessages?: unknown }).contextMessages === "number" &&
						Number.isFinite((params as { contextMessages: number }).contextMessages)
							? (params as { contextMessages: number }).contextMessages
							: 0;
					const finalJob = await maybeAttachReminderContext({
						job: jobWithAgent,
						contextMessages,
						...(agentSessionKey !== undefined ? { agentSessionKey } : {}),
					});
					// Thread `sessionContext` so `defaultCronJobCreate` can resolve
					// `sessionTarget: "current"` to `session:<sessionKey>` (or fall
					// back to `"isolated"` when the caller has no session key).
					const created = await cronAdd(
						state,
						finalJob as unknown as CronJobCreate,
						agentSessionKey !== undefined
							? { sessionContext: { sessionKey: agentSessionKey } }
							: undefined,
					);
					return payloadTextResult({ action, job: created });
				}
				case "update": {
					const jobId = readStringParam(params, "jobId", { required: true });
					// Flat-params recovery for `patch` — same shape as the `add`
					// branch, but WITHOUT the minimum-signal gate. Patches can
					// legitimately be tiny (`{enabled: false}` is a one-key
					// patch), so any recoverable key found at top level is a
					// valid synthetic patch.
					const recParams = params as Record<string, unknown>;
					const existingPatch = recParams.patch;
					const patchIsEmptyObject =
						typeof existingPatch === "object" &&
						existingPatch !== null &&
						!Array.isArray(existingPatch) &&
						Object.keys(existingPatch as Record<string, unknown>).length === 0;
					if (existingPatch === undefined || existingPatch === null || patchIsEmptyObject) {
						const synthetic: Record<string, unknown> = {};
						let found = false;
						for (const key of Object.keys(recParams)) {
							if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && recParams[key] !== undefined) {
								synthetic[key] = recParams[key];
								found = true;
							}
						}
						if (found) {
							recParams.patch = synthetic;
						}
					}
					const patch = recParams.patch;
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
					// `force` runs INLINE so the agent sees what fired (status,
					// summary, delivery outcome) and can tell the operator in
					// the same turn — otherwise the agent says "fired it!" with
					// zero evidence it actually ran. `due` stays enqueued for
					// the next tick.
					if (mode === "force") {
						await cronRun(state, jobId, mode);
						// Read the most recent run-log entry so the agent has the
						// summary + delivery status in hand without a follow-up
						// `cron runs` call.
						let latest: unknown = null;
						try {
							const entries = await cronRuns(state, jobId, { limit: 1 });
							latest = entries[0] ?? null;
						} catch {
							latest = null;
						}
						return payloadTextResult({ action, jobId, mode, latestRun: latest });
					}
					await cronEnqueueRun(state, jobId, mode);
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
					// Route the wake to the agent that called the tool — without
					// this the wake lands on the gateway's boot default agent
					// even when the caller is a non-default routed agent.
					cronWake(
						state,
						text,
						mode,
						callerAgentId !== undefined ? { agentId: callerAgentId } : {},
					);
					return payloadTextResult({ action, mode });
				}
			}
		},
	};
}

/**
 * Apply per-turn channel context to a `cron add` job input so a job created
 * from a channel-routed turn (WhatsApp / Slack / Telegram / …) replies
 * back into the SAME chat by default.
 *
 * Rules — matched on these conditions, ANY missing condition skips:
 *   1. `channelContext` is set (turn came from a channel adapter)
 *   2. `payload.kind === "agentTurn"` (system-event jobs default to mode
 *      "none" and aren't announced; channel autofill is meaningless there)
 *   3. The job's `delivery` block has either:
 *      - no `mode` set at all, OR
 *      - `mode === "announce"` (the autofill default for agentTurn)
 *   4. NEITHER `delivery.channel` NOR `delivery.to` is explicitly set
 *      (operator either omitted delivery entirely OR specified mode but
 *      not the targeting — we treat both as "use my current chat")
 *
 * Caller-supplied delivery params always win — passing
 * `{delivery: {channel: "slack", to: "U123"}}` from a WhatsApp turn
 * targets Slack, not WhatsApp. This is how the operator says "schedule
 * X to ping me on Slack at 6pm" while chatting on WhatsApp.
 *
 * Returns a new job object with the autofilled fields (or the input
 * unchanged when any rule above fails). Never mutates the input.
 */
export function applyChannelContextToCronAdd(
	jobInput: Record<string, unknown>,
	channelContext: ChannelApprovalRoute | undefined,
): Record<string, unknown> {
	if (!channelContext) return jobInput;
	const payload = jobInput.payload as { kind?: unknown } | undefined;
	if (!payload || typeof payload !== "object") return jobInput;
	if (payload.kind !== "agentTurn") return jobInput;
	const deliveryRaw = jobInput.delivery;
	const delivery =
		deliveryRaw && typeof deliveryRaw === "object" && !Array.isArray(deliveryRaw)
			? (deliveryRaw as Record<string, unknown>)
			: undefined;
	const mode = typeof delivery?.mode === "string" ? delivery.mode.trim() : "";
	// Only auto-fill the default ("announce") flow. Operator explicitly
	// asking for "none" / "webhook" wins.
	if (mode && mode !== "announce") return jobInput;
	const hasExplicitTarget =
		(typeof delivery?.channel === "string" && delivery.channel.trim().length > 0) ||
		(typeof delivery?.to === "string" && delivery.to.trim().length > 0);
	if (hasExplicitTarget) return jobInput;
	// Build the autofilled delivery block. We preserve any other delivery
	// fields the model set (e.g. `bestEffort: true`) so the model can
	// combine partial overrides with channel autofill.
	const autofilled: Record<string, unknown> = {
		...(delivery ?? {}),
		mode: "announce",
		channel: channelContext.channelId,
		to: channelContext.conversationId,
		...(channelContext.threadId !== undefined ? { threadId: channelContext.threadId } : {}),
		...(channelContext.accountId !== undefined ? { accountId: channelContext.accountId } : {}),
	};
	return {
		...jobInput,
		delivery: autofilled,
	};
}
