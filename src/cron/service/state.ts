/**
 * `CronServiceState` + `CronServiceDeps` — the per-instance container for the
 * scheduler. Every public function in `ops.ts` takes a `state` arg; every
 * internal helper takes a `state` arg too. There is no module-level
 * singleton — multiple service instances can coexist (test harness sets up
 * a fresh state per case; production has one for the gateway daemon).
 *
 * Two layers of customisation:
 *
 *   - `CronServiceDeps` — INJECTED at construction time. Time, logging, the
 *     event callback, the failure-alert sender, the "run an isolated agent"
 *     dependency, and the system-event/heartbeat hooks. Tests fake these;
 *     production wires them to Brigade's real subsystems.
 *
 *   - `CronServiceConfig` — operator-tunable from `brigade.json`. Limits
 *     (max concurrent runs, max missed jobs per restart, run-log byte/line
 *     caps, retention duration), failure-alert defaults, the storePath.
 *
 * State lives in plain objects (no class). All mutation goes through the
 * per-instance promise chain (see `service/locked.ts`).
 */

import type { SubsystemLogger } from "../../logging/subsystem-logger.js";
import { resolveStateDir } from "../../config/paths.js";
import path from "node:path";
import { newPerInstanceChain, type PerInstanceChain } from "./locked.js";
import type {
	CronEvent,
	CronJob,
	CronRunLogEntry,
	CronStoreFile,
	CronWakeMode,
} from "../types.js";
import type { CronRunLogLimits } from "../run-log.js";

/**
 * Outcome handed to `runIsolatedAgentJob` callers when a cron's child run
 * finishes. Carries the bits the timer needs to write a run-log entry +
 * decide retry/backoff.
 */
export interface CronIsolatedRunOutcome {
	status: "ok" | "error" | "skipped";
	error?: string;
	/** Short text the operator sees in the run log + announce delivery. */
	summary?: string;
	sessionId?: string;
	sessionKey?: string;
	model?: string;
	provider?: string;
	usage?: CronRunLogEntry["usage"];
}

/** Args the cron service hands to its isolated-agent runner dependency. */
export interface CronIsolatedRunArgs {
	job: CronJob;
	runAtMs: number;
	abortSignal?: AbortSignal;
}

/** Args the cron service hands to its system-event injector. */
export interface CronSystemEventArgs {
	text: string;
	agentId?: string;
	sessionKey?: string;
	/** Cron job id whose announce text this carries (display only). */
	jobId?: string;
	/** Cron job name whose announce text this carries (display only). */
	jobName?: string;
}

/** Args the cron service hands to its failure-alert sender. */
export interface CronFailureAlertSendArgs {
	job: CronJob;
	text: string;
	channel?: string;
	to?: string;
	accountId?: string;
	mode: "announce" | "webhook";
	webhookUrl?: string;
}

/**
 * Args the cron service hands to its announce-delivery dispatcher when a
 * successful run's reply should be surfaced to the operator.
 *
 *   - `channel` + `to` set → send via the named channel adapter's outbound
 *     (e.g. WhatsApp `sendText(to, text)`).
 *   - both unset → caller's responsibility to fall back to a default
 *     surface (typically `enqueueSystemEvent` into the operator's main
 *     session) so the user sees the result somewhere.
 */
export interface CronAnnounceDeliverArgs {
	job: CronJob;
	text: string;
	channel?: string;
	to?: string;
	accountId?: string;
	threadId?: string;
}

/**
 * Everything the scheduler needs from the OUTSIDE — time, logging, event
 * emission, and the five big delegation points (run an agent, inject a
 * system event, send a failure alert, request a heartbeat, deliver a
 * successful run's announce). All are optional: missing → the scheduler
 * logs a warning and degrades gracefully (e.g., no failure alert sent if
 * the callback isn't wired). Test harnesses supply fakes; production wires
 * reals.
 */
export interface CronServiceDeps {
	/** Wall-clock time provider. Defaults to `Date.now`. */
	nowMs?: () => number;
	/** Subsystem-tagged logger for diagnostic output. */
	log: SubsystemLogger;
	/** Lifecycle callback — `added`, `updated`, `removed`, `started`, `finished`. */
	onEvent?: (event: CronEvent) => void;
	/** Run an `agentTurn` payload as an isolated child session. */
	runIsolatedAgentJob?: (args: CronIsolatedRunArgs) => Promise<CronIsolatedRunOutcome>;
	/** Inject text as a system event into the operator's main session. */
	enqueueSystemEvent?: (args: CronSystemEventArgs) => void;
	/**
	 * Force a heartbeat tick (for `wakeMode: "now"`).
	 *
	 * Multi-agent: `opts.agentId` + `opts.sessionKey` route the heartbeat
	 * to a specific agent's session. When a cron job carries its own
	 * `agentId` (set when the job was added), the timer passes it
	 * through so the fire lands on the right session rather than the
	 * gateway's boot default. Omit both for legacy single-agent jobs.
	 */
	requestHeartbeatNow?: (opts?: {
		reason?: string;
		agentId?: string;
		sessionKey?: string;
	}) => void;
	/** Send a failure-alert message via the configured channel/webhook. */
	sendCronFailureAlert?: (args: CronFailureAlertSendArgs) => Promise<void>;
	/**
	 * Deliver the SUCCESSFUL run's reply to the operator when the job's
	 * `delivery.mode === "announce"`. Receives the resolved channel/to
	 * tuple (which may be unset — caller decides whether to fall back to
	 * the system-event injector for the operator's main session). Returns
	 * `true` when delivery actually went somewhere; `false` when neither a
	 * channel target nor a fallback was usable (the scheduler logs).
	 */
	deliverCronAnnounce?: (args: CronAnnounceDeliverArgs) => Promise<boolean>;
	/**
	 * Return the ids of channels currently STARTED (configured + env-present
	 * + adapter.start() didn't throw). Used by `assertSupportedJobSpec` to
	 * fail-fast on a typoed `delivery.channel` at `cron add` time rather
	 * than silently persisting a job that would error every fire. Returning
	 * `undefined` (or an empty array) disables the check — useful for tests
	 * + standalone CLI invocations where no channel manager is wired.
	 */
	listKnownChannelIds?: () => readonly string[];
}

/** Tunable knobs the operator can set in `brigade.json`. */
export interface CronServiceConfig {
	enabled?: boolean;
	/** Max in-flight cron runs across all jobs. Default 1. */
	maxConcurrentRuns?: number;
	/** Max overdue jobs replayed at start(). Default 5. */
	maxMissedJobsPerRestart?: number;
	/** Spacing between missed-job replays on start. Default 5_000. */
	missedJobStaggerMs?: number;
	/** Caps for the per-job runs.jsonl. */
	runLog?: CronRunLogLimits;
	/** Isolated cron run session retention. `false` disables. Default "24h". */
	sessionRetention?: string | false;
	/** Global failure-alert defaults (per-job overrides win). */
	failureAlert?: {
		enabled?: boolean;
		after?: number;
		cooldownMs?: number;
		mode?: "announce" | "webhook";
		accountId?: string;
	};
}

/**
 * Live state for one cron service instance. Mutated under the per-instance
 * lock. Disk is the source of truth for `store` — we reload before any
 * finalise step to avoid stale-in-memory writes.
 */
export interface CronServiceState {
	storePath: string;
	store: CronStoreFile;
	config: CronServiceConfig;
	deps: Required<Pick<CronServiceDeps, "log">> & CronServiceDeps;
	op: PerInstanceChain;
	/** Active scheduler timer. Cleared by `stop()`. */
	timer: ReturnType<typeof setTimeout> | null;
	/** True while `onTimer()` is mid-tick (used by the watchdog rearm). */
	running: boolean;
	/** Wake reasons in flight — drains as heartbeats consume them. */
	pendingSystemEvents: Array<{ text: string; mode: CronWakeMode }>;
	/**
	 * Last time the session-reaper ran for this store. Throttled via
	 * `shouldRunSweep` to MIN_SWEEP_INTERVAL_MS so the reaper doesn't
	 * hammer the filesystem on every tick — it only fires every ~5 min.
	 */
	lastReapAtMs?: number;
}

/** Resolve the canonical store path: `~/.brigade/cron.json`. */
export function defaultCronStorePath(): string {
	return path.join(resolveStateDir(), "cron.json");
}

/**
 * Construct a fresh in-memory state. The `store` field starts empty; the
 * service's `start()` loads it from disk before doing anything else.
 */
export function createCronServiceState(args: {
	storePath?: string;
	config?: CronServiceConfig;
	deps: CronServiceDeps;
}): CronServiceState {
	return {
		storePath: args.storePath ?? defaultCronStorePath(),
		store: { version: 1, jobs: [] },
		config: args.config ?? {},
		deps: {
			...args.deps,
			log: args.deps.log,
			nowMs: args.deps.nowMs ?? (() => Date.now()),
		},
		op: newPerInstanceChain(),
		timer: null,
		running: false,
		pendingSystemEvents: [],
	};
}
