/**
 * `cron` — agent-callable scheduler control tool.
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
 * Ownership model (per-action, not blanket):
 *   - Workspace owner (TUI / `connect` / CLI) gets full access to every
 *     action.
 *   - Channel-routed callers (e.g. an approved WhatsApp peer) can `add`
 *     reminders that fire back to THEIR OWN chat, plus read `status` /
 *     `list` / `runs`. Mutating / firing / waking another agent's jobs
 *     refuses with a 403-class error.
 *
 * The narrow surface for non-owner callers means an operator-allowed peer
 * can ask "remind me to call mom in 1 hour" over WhatsApp and the cron
 * fires back into THEIR DM, but can't reach the operator's main session
 * or other peers' chats.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { getActiveCronService } from "../../cron/active-service.js";
import {
	maybeAttachReminderContext,
	REMINDER_CONTEXT_MESSAGES_MAX,
} from "../../cron/reminder-context.js";
import { computeJobStaggerOffsetMs } from "../../cron/stagger.js";
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
import { checkSessionToolAccess } from "./sessions/shared.js";
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
 * Stringified-object recovery. Some model/provider stacks (observed with
 * Sonnet via OpenRouter) JSON-encode a nested tool arg, so a perfectly valid
 * `job` arrives as the STRING '{"name": …}'. The TypeBox schema can't reject
 * it (`job`/`patch` are Any), and bouncing it with "parameter required"
 * misleads the model into retrying the identical call. Parse a string that
 * holds a JSON object; anything else passes through untouched.
 */
function coerceJsonObjectParam(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("{")) return value;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: value;
	} catch {
		return value;
	}
}

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
	/**
	 * Wave O0.6 — caller's visibility scope + A2A policy. When the caller
	 * tries to schedule a cron whose `job.agentId` targets a DIFFERENT
	 * agent than the caller itself AND the caller is not a sub-agent of
	 * that target, refuse unless the A2A policy allows it. Unwired
	 * bundles fall through the existing behaviour (no cross-agent guard)
	 * because the tool already runs `ownerOnly: true`, but threading the
	 * policy makes the cross-agent path explicit.
	 */
	visibility?: import("./sessions/shared.js").SessionToolsVisibility;
	a2aPolicy?: import("./sessions/shared.js").AgentToAgentPolicy;
	spawnedKeys?: ReadonlySet<string>;
	/**
	 * Whether the caller of this turn is the workspace owner (operator on
	 * the TUI / `connect` / a CLI path). When `false`, the turn was routed
	 * in from an approved channel peer — they may still schedule reminders
	 * that fire back to THEIR OWN chat, but the tool refuses any action
	 * that would mutate, run, or read someone else's jobs.
	 *
	 * Defaults to `true` when omitted so legacy callers (TUI, tests) keep
	 * the previous full-access behaviour without having to opt in.
	 */
	senderIsOwner?: boolean;
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
				'REQUIRED for `action:"add"`. A nested JSON OBJECT — never a quoted/' +
				"stringified object, never flat top-level fields. Shape: " +
				'{"name":"<kebab-case>","schedule":{"kind":"in"|"at"|"every"|"cron",…},' +
				'"payload":{"kind":"agentTurn","message":"…"} or {"kind":"systemEvent","text":"…"},' +
				'"delivery"?,"sessionTarget"?}. Copy a TEMPLATE from the tool description ' +
				"and fill only the ⟨slots⟩.",
		}),
	),
	patch: Type.Optional(
		Type.Any({
			description:
				'REQUIRED for `action:"update"`. A nested JSON OBJECT (never a quoted/' +
				"stringified object) holding only the fields to change, e.g. " +
				'{"enabled":false} or {"schedule":{"kind":"every","everyMs":600000}}.',
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
	| { action: "add"; job: unknown; firesAtLocal?: string; staggerNote?: string }
	| { action: "update"; job: unknown; firesAtLocal?: string; staggerNote?: string }
	| { action: "remove"; removed: boolean; jobId: string }
	| { action: "run"; jobId: string; mode: string; latestRun?: unknown }
	| { action: "runs"; jobId: string; entries: unknown[] }
	| { action: "wake"; mode: CronWakeMode };

/**
 * Result-side stagger surfacing for `add` / `update`. When the persisted
 * job's schedule carries a non-zero `staggerMs`, the result includes a
 * ready-to-say note so the model GROUNDS what it tells the operator instead
 * of improvising. Observed in production without this: the model read
 * `staggerMs: 300000` out of the raw job JSON and told the operator the
 * offset is "random" (it's deterministic per job) and "can't be disabled"
 * (it can — explicit `staggerMs: 0`). `firesAtLocal` already covers WHEN;
 * this covers WHY and how to opt out, in language fit for a human.
 */
function staggerHint(job: {
	id: string;
	schedule: { kind: string; staggerMs?: number };
}): { staggerNote?: string } {
	if (job.schedule.kind !== "cron") return {};
	const window = job.schedule.staggerMs;
	if (typeof window !== "number" || window <= 0) return {};
	const offsetSec = Math.round(computeJobStaggerOffsetMs(job.id, window) / 1000);
	const mins = Math.floor(offsetSec / 60);
	const secs = `${offsetSec % 60}`.padStart(2, "0");
	return {
		staggerNote:
			`Heads-up to relay to the operator IN PLAIN LANGUAGE: this job fires ${mins}m${secs}s ` +
			"after each scheduled slot (already included in firesAtLocal). That spread is an " +
			"anti-pile-up default for on-the-hour schedules, it is the SAME offset every fire (not " +
			"random), and it CAN be removed — if the operator wants the exact slot time, update the " +
			"job's schedule with staggerMs: 0. Do not quote internal field names to the operator; " +
			'say something like "I spread scheduled jobs by a few minutes so they don\'t pile up — ' +
			'want it exactly on the hour?"',
	};
}

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
	const callerVisibility = opts.visibility;
	const callerA2aPolicy = opts.a2aPolicy;
	const callerSpawnedKeys = opts.spawnedKeys;
	// Default to owner-access when omitted so legacy paths (TUI/tests) keep
	// the previous full-access behaviour. Channel-routed callers must set
	// this explicitly to `false` to opt into the narrow surface below.
	const senderIsOwner = opts.senderIsOwner !== false;
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
			"TEMPLATES — READ FIRST. Copy the matching template VERBATIM and fill\n" +
			"only the ⟨slots⟩. `job` and `patch` are nested JSON OBJECTS — never a\n" +
			"quoted/stringified object, never flat top-level fields.\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			'T1 · One-shot, relative — "remind me in N minutes/hours":\n' +
			'  {"action":"add","job":{"name":"⟨kebab-name⟩",\n' +
			'    "schedule":{"kind":"in","inMinutes":⟨N⟩},\n' +
			'    "payload":{"kind":"agentTurn","message":"⟨what to tell the operator at fire time⟩"}}}\n\n' +
			'T2 · One-shot, clock time — "tomorrow at 9am" / "at 6:50":\n' +
			'  {"action":"add","job":{"name":"⟨kebab-name⟩",\n' +
			'    "schedule":{"kind":"at","at":"⟨ISO-8601 WITH offset, e.g. 2026-06-12T09:00:00+05:30⟩"},\n' +
			'    "payload":{"kind":"agentTurn","message":"⟨…⟩"}}}\n\n' +
			'T3 · Recurring interval — "every 30 minutes":\n' +
			'  {"action":"add","job":{"name":"⟨kebab-name⟩",\n' +
			'    "schedule":{"kind":"every","everyMs":⟨interval in ms⟩},\n' +
			'    "payload":{"kind":"agentTurn","message":"⟨…⟩"}}}\n\n' +
			'T4 · Calendar recurring — "daily at 9am" / "weekdays at 8":\n' +
			'  {"action":"add","job":{"name":"⟨kebab-name⟩",\n' +
			'    "schedule":{"kind":"cron","expr":"⟨0 9 * * *⟩","tz":"⟨Asia/Kolkata⟩","staggerMs":0},\n' +
			'    "payload":{"kind":"agentTurn","message":"⟨…⟩"}}}\n' +
			"  `\"staggerMs\":0` matters: top-of-hour expressions otherwise get an\n" +
			"  automatic anti-stampede offset of up to 5 min (deterministic per job),\n" +
			"  so a \"7 PM\" reminder would land at e.g. 7:04 EVERY day. When the\n" +
			"  operator names an exact clock time, ALWAYS set `staggerMs: 0`; to fix\n" +
			'  an existing late-firing job: {"action":"update","jobId":"⟨id⟩",\n' +
			'  "patch":{"schedule":{"kind":"cron","expr":"⟨same⟩","tz":"⟨same⟩","staggerMs":0}}}\n\n' +
			'T5 · Update / pause / resume an existing job:\n' +
			'  {"action":"update","jobId":"⟨id from list/add⟩","patch":{"enabled":⟨true|false⟩}}\n\n' +
			"DELIVERY SLOT — WHERE must the reminder arrive? Decide BEFORE adding:\n" +
			"  • Same channel chat you're in (WhatsApp/Slack…)? Add NOTHING —\n" +
			"    the reply auto-routes back to this chat.\n" +
			"  • A channel you are NOT currently in (e.g. operator is in the TUI\n" +
			'    and says "remind me ON WHATSAPP")? You MUST add\n' +
			'    "delivery":{"mode":"announce","channel":"⟨id⟩","to":"⟨recipient-id⟩"}\n' +
			"    — the cron service sends your run's reply text verbatim to that\n" +
			"    chat when the run finishes. Write `message` as instructions to\n" +
			"    produce the reminder text (the reply IS what gets delivered).\n" +
			"  • NEVER instruct the scheduled run to call send_message itself —\n" +
			"    unattended cron runs are BLOCKED from messaging tools by the\n" +
			"    security gate; the delivery block is the sanctioned path.\n" +
			"  • TUI-only nudge (no channel involved)? `systemEvent` + main — the\n" +
			"    fire wakes your main session and you act on the text there.\n\n" +
			"THE TWO MISTAKES THAT BREAK THE CALL:\n" +
			'  ✗ "job": "{\\"name\\": …}"        — object wrapped in a STRING. Pass the object raw.\n' +
			'  ✗ {"action":"add","name":…,…}   — job fields flattened to the top level.\n\n' +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"SCHEDULE KIND — pick by user intent:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
			"### `in` / `at` — ONE-SHOT at a future moment ###\n" +
			"USE THIS for:\n" +
			"  • \"in N minutes/hours\" / \"in 2 mins\" / \"30 minutes from now\"\n" +
			"  • \"tomorrow at 9am\" / \"next Tuesday\" / specific future moment\n" +
			"  • Any reminder that fires EXACTLY ONCE and then auto-deletes\n" +
			"RELATIVE (\"in N minutes/hours\") -- STRONGLY PREFERRED. Pass the OFFSET and\n" +
			"let the SERVER compute the exact fire time against the real clock. DO NOT\n" +
			"compute epoch milliseconds yourself: you have no reliable clock and WILL get\n" +
			"the arithmetic wrong (a real \"5 minutes\" reminder once landed ~14 minutes\n" +
			"out, and the operator never got it on time). Shapes:\n" +
			"  `{kind: \"in\", inMinutes: 5}` -- also `inSeconds` / `inHours` / `inDays` / `inMs`;\n" +
			"  combine units, e.g. `{kind: \"in\", inHours: 1, inMinutes: 30}` = 90 minutes.\n" +
			"ABSOLUTE moment (\"tomorrow at 9am\"): `{kind: \"at\", at: \"<ISO-8601>\"}` -- pass\n" +
			"an ISO-8601 STRING with the operator's timezone offset (e.g.\n" +
			"`\"2026-06-03T16:31:00+05:30\"`), NOT raw epoch milliseconds. A bare\n" +
			"`YYYY-MM-DD` or naive `YYYY-MM-DDTHH:mm:ss` (no offset) is read as UTC.\n" +
			"NEVER use a 5-field cron expression for a relative reminder — cron expressions\n" +
			"match absolute calendar slots and may resolve a year out (e.g. `43 13 1 6 *`\n" +
			"interpreted on June 1 at 13:45 fires June 1 NEXT YEAR, not the 13:43 that\n" +
			"already passed). For one-shots, ALWAYS use `in` (relative) or `at` (ISO).\n\n" +
			"#### AM/PM + CLOCK TIME RULE — CRITICAL ####\n" +
			"When the user names a clock time without an explicit DATE (e.g. \"12:27 AM\",\n" +
			"\"9pm\", \"tomorrow at 8\"), compute the NEXT FUTURE instance of that time. If\n" +
			"the named time has already passed today, the user means TOMORROW (or the\n" +
			"next valid date). NEVER use a timestamp that's in the past or in the current\n" +
			"minute. If you're uncertain whether 12:27 means AM or PM in the current\n" +
			"operator timezone, ASK before scheduling — do NOT guess.\n\n" +
			"Concrete worked example: at 12:27 PM, user says \"remind me at 12:27 AM\" →\n" +
			"that already passed 12 hours ago → schedule for TOMORROW 12:27 AM (NOT today;\n" +
			"add 24h to today's 12:27 AM).\n\n" +
			"The scheduler validator REJECTS any `at` timestamp that's at or before now\n" +
			"(or within 5 seconds of now). If you see an error like \"`at` schedule must\n" +
			"be at least 5 seconds in the FUTURE; got <time> which is <delta> in the\n" +
			"past\", you misinterpreted the clock time — recompute the NEXT future\n" +
			"instance (almost always +24h) and retry.\n\n" +
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
			"Shape: `{kind: \"cron\", expr: \"<5-field cron>\", tz: \"<IANA tz>\", staggerMs?: <ms>}`\n" +
			"5-field syntax: `minute hour day-of-month month day-of-week` (`* * * * *`).\n" +
			"STAGGER: minute-field `0` expressions default to `staggerMs: 300000` —\n" +
			"an anti-stampede offset (up to 5 min, deterministic per job) added to\n" +
			"every fire. Operator named an exact clock time? Set `staggerMs: 0` so\n" +
			"it fires on the dot. Explicit values always win over the default.\n\n" +
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
			"DISPLAYING TIMES TO THE USER -- CRITICAL:\n" +
			"  The `add` / `update` result includes `firesAtLocal` -- the EXACT fire\n" +
			"  time the server computed in the operator's local timezone (e.g.\n" +
			"  \"Tue, Jun 3, 4:57 PM GMT+5:30\"). When telling the user WHEN a job\n" +
			"  fires, QUOTE `firesAtLocal` -- do NOT compute, add, or convert any\n" +
			"  time yourself (you have no reliable clock and WILL get it wrong; a\n" +
			"  \"5 minutes\" reminder was once announced for a time already in the\n" +
			"  past). You may render it naturally (\"4:57 PM IST\") but the clock\n" +
			"  time and date MUST match `firesAtLocal`. NEVER state UTC times.\n\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"PAYLOAD — `payload.kind`:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  - `agentTurn`   — `{kind: \"agentTurn\", message: \"...\"}` (run a full\n" +
			"    agent turn at fire time; default sessionTarget=\"isolated\"). Optional\n" +
			"    `model`, `thinking`, `timeoutSeconds`, `toolsAllow`, `lightContext`.\n" +
			"  - `systemEvent` — `{kind: \"systemEvent\", text: \"...\"}` (wake the\n" +
			"    operator's main session at fire time: the text arrives as a system\n" +
			"    event and a turn starts so YOU act on it with full main-session\n" +
			"    context. For \"nudge me / kick off work at time T\" — NOT for\n" +
			"    delivering a message to a channel (that's `agentTurn` + `delivery`).\n" +
			"    Pairs with sessionTarget=\"main\").\n\n" +
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
			"                          The fire WAKES the main session: the event\n" +
			"                          text starts a turn there (immediately with\n" +
			"                          wakeMode \"now\", else within ≤30s).\n" +
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
			"WHEN A CALL FAILS:\n" +
			"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
			"  Do NOT retry the same arguments. Re-read the TEMPLATES section at\n" +
			"  the top, pick the matching template, and rebuild the call from it.",
		parameters: CronToolParams,
		// NOTE: no blanket `ownerOnly: true`. The cron surface is gated per-
		// action below so an approved channel peer (e.g. a WhatsApp DM the
		// operator allow-listed) can still schedule reminders that fire
		// back to THEIR OWN chat — anything cross-chat / cross-agent /
		// mutating-someone-else's-jobs is refused individually instead.
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

			// Per-call non-owner gate. The workspace owner (TUI / connect /
			// CLI paths) keeps full access. A channel-routed caller (e.g.
			// approved WhatsApp peer) can schedule reminders for their own
			// chat AND manage the reminders they previously created — but
			// can't touch the operator's jobs, fire jobs they didn't
			// schedule, or inject system-events into the operator's main
			// session.
			//
			// Ownership is tracked via `CronJob.createdBy`. The first time
			// a non-owner adds a job, this gate stamps a `channel` origin
			// onto the create input; subsequent update/remove/run calls
			// look up the job and match its origin against the calling
			// channel + conversation. Jobs predating ownership tracking
			// (createdBy undefined) are treated as owner-created — the
			// safe default that preserves legacy behaviour.
			//
			// `wake` stays owner-only because its target IS the operator's
			// main session by definition; there's no per-peer wake.
			const callerOrigin =
				!senderIsOwner && channelContext
					? ({
							kind: "channel" as const,
							channelId: channelContext.channelId,
							conversationId: channelContext.conversationId,
							...(channelContext.accountId !== undefined
								? { accountId: channelContext.accountId }
								: {}),
						})
					: undefined;
			/**
			 * Does the given persisted job belong to the non-owner caller
			 * that's making this turn? Used to gate update/remove/run/runs.
			 * Operators bypass this entirely and the helper is never called
			 * for them.
			 */
			const jobIsOwnedByCaller = (job: {
				createdBy?: import("../../cron/types.js").CronJobOrigin;
			}): boolean => {
				if (!callerOrigin) return false;
				const origin = job.createdBy;
				if (!origin || origin.kind === "owner") return false;
				return (
					origin.kind === "channel" &&
					origin.channelId === callerOrigin.channelId &&
					origin.conversationId === callerOrigin.conversationId
				);
			};
			if (!senderIsOwner) {
				if (!channelContext) {
					// Defensive — a non-owner caller with no channelContext is
					// an unrecognised path. Refuse rather than guess.
					return failedTextResult(
						"cron: a non-owner-routed turn must arrive via an approved channel.",
						{ action } as never,
					);
				}
				if (action === "wake") {
					// `wake` injects into the OPERATOR's main session — there
					// is no per-peer wake target, so this is unconditionally
					// owner-only.
					return failedTextResult(
						"cron: action \"wake\" requires workspace-owner privilege — " +
							"it injects system events into the operator's main session and has no per-peer equivalent.",
						{ action } as never,
					);
				}
				if (action === "update" || action === "remove" || action === "run" || action === "runs") {
					// Per-job ownership check: read the target job from the
					// in-memory store and verify the caller created it. The
					// store is a small Array.find — cheap. Reading does NOT
					// race with concurrent mutation because the per-instance
					// lock serialises writes; the worst we'd see is a stale
					// `createdBy` on a job that's about to be removed, which
					// the downstream op call handles cleanly.
					const jobId = readStringParam(params, "jobId", { required: true });
					if (typeof jobId !== "string" || jobId.length === 0) {
						return failedTextResult(
							`cron: action "${action}" requires a jobId parameter`,
							{ action } as never,
						);
					}
					const target = state.store.jobs.find((j) => j.id === jobId);
					if (!target) {
						return failedTextResult(
							`cron: no job with id ${jobId}`,
							{ action } as never,
						);
					}
					if (!jobIsOwnedByCaller(target)) {
						return failedTextResult(
							`cron: action "${action}" refused — that job was not scheduled by this chat.`,
							{ action } as never,
						);
					}
				}
				if (action === "add") {
					// For `add`: pin the delivery target to the caller's own
					// channel/conversation. If the LLM tried to specify a
					// different channel or `to`, refuse — that's a
					// cross-chat escape attempt. Missing delivery is fine;
					// the auto-fill helper below will set it from the
					// channelContext.
					const jobIn = (params as { job?: unknown }).job;
					const delivery =
						jobIn && typeof jobIn === "object"
							? ((jobIn as { delivery?: { channel?: unknown; to?: unknown } }).delivery ?? undefined)
							: undefined;
					const channelMatchesCtx =
						delivery?.channel === undefined || delivery.channel === channelContext.channelId;
					const toMatchesCtx =
						delivery?.to === undefined || delivery.to === channelContext.conversationId;
					if (!channelMatchesCtx || !toMatchesCtx) {
						return failedTextResult(
							"cron: as a non-owner-routed turn you may only schedule reminders that fire back to your own chat. " +
								"Cross-conversation delivery requires workspace-owner privilege.",
							{ action } as never,
						);
					}
					// Also pin the job's agentId: a non-owner caller may not
					// schedule jobs against a DIFFERENT agent than the one
					// answering them now. Mirrors the per-action gate above.
					const jobAgentId =
						jobIn && typeof jobIn === "object"
							? (jobIn as { agentId?: unknown }).agentId
							: undefined;
					if (
						typeof jobAgentId === "string" &&
						callerAgentId !== undefined &&
						jobAgentId !== callerAgentId
					) {
						return failedTextResult(
							"cron: as a non-owner-routed turn you may only schedule jobs for the agent answering you now.",
							{ action } as never,
						);
					}
				}
			}
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
					// Non-owner callers see only the jobs they scheduled
					// from this chat — never the operator's jobs nor jobs
					// scheduled from other peers' chats. Keeps cron a
					// per-chat surface for approved peers.
					if (!senderIsOwner) {
						const ownJobs = result.jobs.filter((j) => jobIsOwnedByCaller(j));
						return payloadTextResult({
							action,
							result: {
								...result,
								jobs: ownJobs,
								// Re-derive `total` so the page footer doesn't
								// imply other people's jobs are visible-just-
								// paginated-elsewhere. The store-wide total is
								// for owners only.
								total: ownJobs.length,
							},
						});
					}
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
					// Stringified-object recovery: some model/provider stacks
					// JSON-encode nested tool args (the job arrives as the STRING
					// '{"name": …}'). The schema can't catch it (`job` is Any) and
					// the old "`job` parameter required" reply misled the model
					// into retrying the identical call. Parse it instead.
					recParams.job = coerceJsonObjectParam(recParams.job);
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
							"cron add needs `job` as an inline OBJECT (not a JSON string, not flat top-level fields). " +
								'Example: {"action":"add","job":{"name":"gym-reminder","schedule":{"kind":"in","inMinutes":5},' +
								'"payload":{"kind":"agentTurn","message":"…"}}}',
							{ action, job: null } as never,
						);
					}
					// Wave O0.6 — cross-agent cron guard. When the model
					// schedules a job whose `job.agentId` differs from the
					// caller's own agentId AND the caller is not a sub-agent
					// of that target, refuse unless the A2A policy allows
					// it. The same-key fast-path covers in-agent scheduling
					// (callerAgentId === jobAgentId) without surfacing the
					// guard. The check is best-effort when policy is unset
					// (legacy / unwired bundles) — the tool is ownerOnly so
					// the broader gate still applies.
					const jobAgentIdRaw =
						typeof (jobInput as { agentId?: unknown }).agentId === "string"
							? ((jobInput as { agentId: string }).agentId.trim())
							: "";
					if (
						jobAgentIdRaw.length > 0 &&
						callerAgentId &&
						jobAgentIdRaw !== callerAgentId &&
						callerVisibility &&
						callerA2aPolicy
					) {
						// Synthesised target key: the canonical default
						// session for the cross-agent target. The cron will
						// land on this session at fire time, so it's the
						// right thing to evaluate the access check against.
						const targetKey = `agent:${jobAgentIdRaw}:main`;
						const requesterKey =
							agentSessionKey ?? `agent:${callerAgentId}:main`;
						const verdict = checkSessionToolAccess({
							action: "send",
							requesterSessionKey: requesterKey,
							targetSessionKey: targetKey,
							visibility: callerVisibility,
							a2aPolicy: callerA2aPolicy,
							...(callerSpawnedKeys ? { spawnedKeys: callerSpawnedKeys } : {}),
						});
						if (!verdict.allowed) {
							return failedTextResult(
								verdict.error,
								{ action, job: null } as never,
							);
						}
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
					// Stamp `createdBy` so future `update` / `remove` / `run`
					// calls from THIS channel + conversation are recognised
					// as the legitimate owner of the job. Operator-routed
					// turns omit it (defaults to owner). Caller-supplied
					// `createdBy` is ignored — the gate is the only source
					// of truth, otherwise a non-owner could lie their way
					// into impersonating the operator.
					const jobWithOrigin: Record<string, unknown> = callerOrigin
						? { ...jobWithAgent, createdBy: callerOrigin }
						: senderIsOwner
							? { ...jobWithAgent, createdBy: { kind: "owner" } }
							: jobWithAgent;
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
						job: jobWithOrigin,
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
					return payloadTextResult({
						action,
						job: created,
						firesAtLocal: describeFireTime(created.state.nextRunAtMs),
						...staggerHint(created),
					});
				}
				case "update": {
					const jobId = readStringParam(params, "jobId", { required: true });
					// Flat-params recovery for `patch` — same shape as the `add`
					// branch, but WITHOUT the minimum-signal gate. Patches can
					// legitimately be tiny (`{enabled: false}` is a one-key
					// patch), so any recoverable key found at top level is a
					// valid synthetic patch.
					const recParams = params as Record<string, unknown>;
					// Stringified-object recovery — same provider quirk as `add`.
					recParams.patch = coerceJsonObjectParam(recParams.patch);
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
							"cron update needs `patch` as an inline OBJECT (not a JSON string, not flat top-level fields). " +
								'Example: {"action":"update","jobId":"…","patch":{"enabled":false}}',
							{ action, job: null } as never,
						);
					}
					const updated = await cronUpdate(state, jobId, patch as CronJobPatch);
					return payloadTextResult({
						action,
						job: updated,
						firesAtLocal: describeFireTime(updated.state.nextRunAtMs),
						...staggerHint(updated),
					});
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

/**
 * Format a fire-time epoch (ms) into a ready-to-quote local-time string in the
 * operator's host timezone, e.g. "Tue, Jun 3, 4:57 PM GMT+5:30". Handed back on
 * `add`/`update` so the MODEL never converts an epoch to local time itself --
 * it gets that wrong (it once announced a 5-minute reminder for a time already
 * in the past). The model is told to quote `firesAtLocal` verbatim. `tzOverride`
 * exists for tests; production uses the host timezone. Returns undefined for a
 * missing / non-finite time (e.g. a recurring job between fires).
 */
export function describeFireTime(
	epochMs: number | undefined,
	tzOverride?: string,
): string | undefined {
	if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined;
	try {
		const tz = tzOverride || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		return new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
			timeZoneName: "short",
		}).format(new Date(epochMs));
	} catch {
		return new Date(epochMs).toISOString();
	}
}
