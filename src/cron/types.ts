/**
 * Brigade cron — shared type definitions.
 *
 * Mirrors the reference architecture's three-kind schedule model:
 *   - `cron` — cron expression + optional timezone + per-job stagger window
 *   - `every` — fixed interval, optionally anchored to a base timestamp
 *   - `at` — one-shot at an absolute timestamp (auto-deletes by default)
 *
 * Two payload kinds:
 *   - `systemEvent` — text injected into the operator's active session
 *     (must pair with `sessionTarget: "main"`)
 *   - `agentTurn` — a full agent run in its own session (must pair with
 *     `sessionTarget: "isolated"` or `session:<id>`)
 *
 * Validation invariants live in `assertSupportedJobSpec` in `service/jobs.ts`.
 * Defaults + coercion live in `normalize.ts`.
 */

/** Cron expression schedule with optional timezone + stagger band. */
export interface CronScheduleCron {
	kind: "cron";
	expr: string;
	tz?: string;
	staggerMs?: number;
}

/** Fixed-interval schedule. `anchorMs` defaults to job creation time. */
export interface CronScheduleEvery {
	kind: "every";
	everyMs: number;
	anchorMs?: number;
}

/** One-shot schedule at an absolute timestamp (ms-epoch). */
export interface CronScheduleAt {
	kind: "at";
	at: number;
}

export type CronSchedule = CronScheduleCron | CronScheduleEvery | CronScheduleAt;

/** Inject this text into the target session as a system message. */
export interface CronPayloadSystemEvent {
	kind: "systemEvent";
	text: string;
}

/** Run a full agent turn with this message. */
export interface CronPayloadAgentTurn {
	kind: "agentTurn";
	message: string;
	model?: string;
	thinking?: "off" | "low" | "medium" | "high";
	timeoutSeconds?: number;
	/** Filter the tool surface — only these names are exposed to the model. */
	toolsAllow?: string[];
	/** Drop ALL workspace bootstrap files from the system prompt to save tokens. */
	lightContext?: boolean;
}

export type CronPayload = CronPayloadSystemEvent | CronPayloadAgentTurn;

/**
 * Where the resulting work lands.
 *
 * `"current"` is a CREATE-TIME alias: when supplied by the caller, the
 * normalizer rewrites it to `session:<currentSessionKey>` using the active
 * session context (or falls back to `"isolated"` when no session is active —
 * CLI / headless paths). Persisted `CronJob.sessionTarget` values are
 * therefore always one of `"main" | "isolated" | "session:<id>"`. The literal
 * `"current"` only appears on the input surface so the agent tool and RPC
 * can accept it; downstream timer + executor never see it after normalize.
 */
export type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;

/** "now" forces a heartbeat; "next-heartbeat" waits for the natural cycle. */
export type CronWakeMode = "now" | "next-heartbeat";

/** Where the cron's reply gets sent when it finishes. */
export interface CronDelivery {
	/** `none` = silent; `announce` = post to channel; `webhook` = HTTP POST. */
	mode: "none" | "announce" | "webhook";
	channel?: string;
	to?: string;
	accountId?: string;
	threadId?: string;
	/** When true, delivery errors are logged but don't fail the job. */
	bestEffort?: boolean;
	/** Webhook target URL (only when mode === "webhook"). */
	webhookUrl?: string;
}

/** Per-job operator-alert config. `false` disables alerts entirely. */
export type CronFailureAlert =
	| false
	| {
			/** Fire after N consecutive failures (default 2). */
			after?: number;
			/** Cooldown between alerts for the same job (default 1 hour). */
			cooldownMs?: number;
			channel?: string;
			to?: string;
			accountId?: string;
			mode?: "announce" | "webhook";
			webhookUrl?: string;
	  };

/**
 * Run-time state mutated by the scheduler. Persisted alongside the static
 * config so a restart can resume tracking failure counts + last-fire time.
 */
export interface CronJobState {
	lastRunAtMs?: number;
	nextRunAtMs?: number;
	/** Set when the job starts running, cleared when it finishes / on stuck-clear. */
	runningAtMs?: number;
	lastStatus?: "ok" | "error" | "skipped";
	lastError?: string;
	/** Consecutive failures computing the schedule (auto-disables after 3). */
	scheduleErrorCount?: number;
	/** Consecutive execution failures (drives failure-alert + backoff). */
	consecutiveErrorCount?: number;
	/** Last failure-alert send time (drives cooldown). */
	lastFailureAlertAtMs?: number;
	/** Did the most recent successful run's announce delivery land? */
	lastDelivered?: boolean;
	/** Resolved delivery status for the most recent run — `delivered` / `not-delivered` / `unknown` / `not-requested`. */
	lastDeliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
	/** Error string from the most recent failed delivery attempt. */
	lastDeliveryError?: string;
}

export interface CronJob {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	agentId?: string;
	sessionKey?: string;
	schedule: CronSchedule;
	sessionTarget: CronSessionTarget;
	wakeMode?: CronWakeMode;
	payload: CronPayload;
	delivery?: CronDelivery;
	failureAlert?: CronFailureAlert;
	/** Auto-delete after `status: "ok"`. Defaults to `true` for `kind: "at"`. */
	deleteAfterRun?: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	state: CronJobState;
}

/** Disk-persisted store shape. */
export interface CronStoreFile {
	version: 1;
	jobs: CronJob[];
}

/** One line in `~/.brigade/cron/runs/<jobId>.jsonl`. */
export interface CronRunLogEntry {
	ts: number;
	jobId: string;
	action: "finished";
	status?: "ok" | "error" | "skipped";
	error?: string;
	summary?: string;
	delivered?: boolean;
	deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
	deliveryError?: string;
	sessionId?: string;
	sessionKey?: string;
	runAtMs?: number;
	durationMs?: number;
	nextRunAtMs?: number;
	model?: string;
	provider?: string;
	usage?: CronUsageSummary;
}

export interface CronUsageSummary {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costUsd?: number;
}

/** Event emitted from `state.deps.onEvent` for every cron lifecycle change. */
export type CronEvent =
	| { action: "added"; jobId: string; nextRunAtMs?: number }
	| { action: "updated"; jobId: string; nextRunAtMs?: number }
	| { action: "removed"; jobId: string }
	| { action: "started"; jobId: string; runAtMs: number }
	| {
			action: "finished";
			jobId: string;
			status: "ok" | "error" | "skipped";
			error?: string;
			summary?: string;
			delivered?: boolean;
			deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
			deliveryError?: string;
			sessionId?: string;
			sessionKey?: string;
			runAtMs: number;
			durationMs: number;
			nextRunAtMs?: number;
			model?: string;
			provider?: string;
			usage?: CronUsageSummary;
	  };

/** Partial inputs accepted by `ops.add` — defaults filled by `createJob`. */
export interface CronJobCreate {
	name: string;
	description?: string;
	enabled?: boolean;
	agentId?: string;
	sessionKey?: string;
	schedule: CronSchedule;
	sessionTarget: CronSessionTarget;
	wakeMode?: CronWakeMode;
	payload: CronPayload;
	delivery?: CronDelivery;
	failureAlert?: CronFailureAlert;
	deleteAfterRun?: boolean;
}

/** Patch shape accepted by `ops.update`. */
export type CronJobPatch = Partial<Omit<CronJobCreate, "schedule">> & {
	schedule?: CronSchedule;
};
