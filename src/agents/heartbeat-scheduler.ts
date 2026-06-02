/**
 * Per-agent heartbeat interval scheduler.
 *
 * Brigade-native analogue of upstream's wall-clock heartbeat scheduler.
 * Reads `cfg.agents.<id>.heartbeat.intervalMs` (and the `defaults` fallback)
 * to build a `Map<agentId, AgentSchedule>` of agents that opt into
 * periodic heartbeats. On each tick the scheduler invokes the supplied
 * `onInterval(agentId)` callback for every agent whose `nextDueMs` has
 * elapsed; the callback is expected to call into Step 13's
 * `requestHeartbeatNow(...)` which the runner picks up.
 *
 * Phase offsets are deterministic per agent (SHA-256 of a fixed seed +
 * the agent id, mod intervalMs) so a Brigade restart resumes its agents
 * on the same phase rather than thundering at the same instant. The
 * seed defaults to a stable string; tests can override via
 * `BRIGADE_HEARTBEAT_SEED` env to nail down phase positions.
 *
 * Lifecycle:
 *
 *   const sched = createHeartbeatScheduler({ onInterval });
 *   sched.updateConfig(cfg);     // seed the per-agent map
 *   sched.start();               // arm the wall-clock timer
 *   // ... gateway runs ...
 *   sched.stop();                // clear the timer
 *
 * Hot config reload is supported: `updateConfig(cfg)` recomputes the
 * agent map. Agents whose interval changed get a new `nextDueMs`;
 * agents whose interval stayed the same keep their existing schedule
 * so the phase doesn't reset.
 */

import { createHash } from "node:crypto";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { BrigadeConfig } from "../config/types.js";

const log = createSubsystemLogger("agents/heartbeat-scheduler");

interface QuietHoursWindow {
	/** Minutes-since-midnight of the start of the quiet window (local TZ). */
	startMinutes: number;
	/** Minutes-since-midnight of the end of the quiet window (local TZ). */
	endMinutes: number;
	/** IANA timezone or `undefined` for system-local. */
	timezone?: string;
}

interface AgentSchedule {
	agentId: string;
	intervalMs: number;
	phaseMs: number;
	nextDueMs: number;
	sessionKey?: string;
	quietHours?: QuietHoursWindow;
}

export interface HeartbeatSchedulerDeps {
	/**
	 * Invoked when an agent's `nextDueMs` elapses. Implementation should
	 * call `requestHeartbeatNow({reason: "interval", agentId, sessionKey})`
	 * from Step 13's wake layer so the runner picks up the intent.
	 */
	onInterval: (params: { agentId: string; sessionKey?: string }) => void;
}

export interface HeartbeatScheduler {
	start: () => void;
	stop: () => void;
	updateConfig: (cfg: BrigadeConfig) => void;
	getScheduleSnapshot: () => Array<{ agentId: string; intervalMs: number; nextDueMs: number }>;
}

type SchedulerState = {
	agents: Map<string, AgentSchedule>;
	timer: NodeJS.Timeout | null;
	stopped: boolean;
};

const SCHEDULER_STATE_KEY = Symbol.for("brigade.heartbeatScheduler.state");

function createState(): SchedulerState {
	return { agents: new Map(), timer: null, stopped: false };
}

function getState(): SchedulerState {
	return resolveGlobalSingleton<SchedulerState>(SCHEDULER_STATE_KEY, createState);
}

function resolvePhaseMs(agentId: string, intervalMs: number): number {
	const seed = process.env.BRIGADE_HEARTBEAT_SEED?.trim() || "brigade";
	const digest = createHash("sha256").update(`${seed}:${agentId}`).digest();
	return digest.readUInt32BE(0) % Math.max(1, intervalMs);
}

function computeNextDueMs(now: number, intervalMs: number, phaseMs: number): number {
	const offsetIntoCycle = (now - phaseMs) % intervalMs;
	const delta = offsetIntoCycle <= 0 ? -offsetIntoCycle : intervalMs - offsetIntoCycle;
	return now + (delta || intervalMs);
}

/**
 * Parse an "HH:MM" string into minutes-since-midnight. Returns `null` on
 * anything malformed (the scheduler skips quiet-hours config that doesn't
 * parse — fail-open rather than refusing to fire).
 */
function parseHHMM(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = /^([0-2]?\d):([0-5]\d)$/.exec(value.trim());
	if (!match) return null;
	const hours = Number.parseInt(match[1] ?? "", 10);
	const minutes = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(hours) || hours < 0 || hours > 23) return null;
	if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/**
 * Minutes-since-midnight for `nowMs` in the supplied IANA timezone (or
 * system-local when `timezone` is undefined). Used by quiet-hours to
 * decide whether the agent is currently inside its do-not-disturb window.
 *
 * Intl.DateTimeFormat does the heavy lifting — TZ-aware without pulling
 * a heavy library. Falls back to local when the timezone arg is invalid.
 */
function minutesSinceMidnightInTz(nowMs: number, timezone?: string): number {
	const date = new Date(nowMs);
	const options: Intl.DateTimeFormatOptions = {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	};
	if (timezone) options.timeZone = timezone;
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
	} catch {
		// Bad TZ string — drop back to system-local. The operator still gets
		// quiet hours; they just don't get TZ-shifted ones.
		parts = new Intl.DateTimeFormat("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
		}).formatToParts(date);
	}
	const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
	const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
	// Intl returns "24" at midnight on some engines — normalise to 0.
	const hoursNum = Number.parseInt(hour, 10);
	const minutesNum = Number.parseInt(minute, 10);
	const safeHours = Number.isFinite(hoursNum) ? hoursNum % 24 : 0;
	const safeMinutes = Number.isFinite(minutesNum) ? minutesNum : 0;
	return safeHours * 60 + safeMinutes;
}

/**
 * `true` when `nowMs` falls inside the quiet window. Windows that wrap
 * midnight (start > end, e.g. "22:00" → "07:00") are handled — both halves
 * count as quiet.
 */
function isInQuietWindow(nowMs: number, window: QuietHoursWindow): boolean {
	const current = minutesSinceMidnightInTz(nowMs, window.timezone);
	if (window.startMinutes === window.endMinutes) return false;
	if (window.startMinutes < window.endMinutes) {
		return current >= window.startMinutes && current < window.endMinutes;
	}
	// Wraps midnight: e.g. 22:00 → 07:00.
	return current >= window.startMinutes || current < window.endMinutes;
}

/**
 * Compute the wall-clock ms for the END of the quiet window relative to
 * `nowMs`. Used to defer `nextDueMs` until the operator's wake window
 * opens.
 */
function endOfQuietWindowMs(nowMs: number, window: QuietHoursWindow): number {
	const current = minutesSinceMidnightInTz(nowMs, window.timezone);
	let minutesUntilEnd: number;
	if (window.startMinutes < window.endMinutes) {
		// Same-day window: defer to today's end.
		minutesUntilEnd = window.endMinutes - current;
	} else {
		// Wraps midnight. We're inside iff current >= start OR current < end.
		if (current >= window.startMinutes) {
			minutesUntilEnd = 24 * 60 - current + window.endMinutes;
		} else {
			minutesUntilEnd = window.endMinutes - current;
		}
	}
	return nowMs + Math.max(60_000, minutesUntilEnd * 60_000);
}

function readQuietHours(raw: unknown): QuietHoursWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as { start?: unknown; end?: unknown; timezone?: unknown; tz?: unknown };
	const startMinutes = parseHHMM(obj.start);
	const endMinutes = parseHHMM(obj.end);
	if (startMinutes === null || endMinutes === null) return undefined;
	const tz = typeof obj.timezone === "string"
		? obj.timezone.trim()
		: typeof obj.tz === "string"
			? obj.tz.trim()
			: "";
	return {
		startMinutes,
		endMinutes,
		...(tz ? { timezone: tz } : {}),
	};
}

interface ResolvedHeartbeatConfig {
	intervalMs?: number;
	sessionKey?: string;
	/** `undefined` defaults to enabled (back-compat); `false` skips this agent. */
	enabled?: boolean;
	quietHours?: QuietHoursWindow;
}

function readHeartbeatBlock(raw: unknown): ResolvedHeartbeatConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const hb = raw as {
		intervalMs?: unknown;
		sessionKey?: unknown;
		enabled?: unknown;
		quietHours?: unknown;
	};
	const intervalMs = typeof hb.intervalMs === "number" ? hb.intervalMs : undefined;
	const sessionKey = typeof hb.sessionKey === "string" ? hb.sessionKey : undefined;
	const enabled = typeof hb.enabled === "boolean" ? hb.enabled : undefined;
	const quietHours = readQuietHours(hb.quietHours);
	return {
		...(intervalMs !== undefined ? { intervalMs } : {}),
		...(sessionKey !== undefined ? { sessionKey } : {}),
		...(enabled !== undefined ? { enabled } : {}),
		...(quietHours ? { quietHours } : {}),
	};
}

function readAgentHeartbeatConfig(
	cfg: BrigadeConfig,
	agentId: string,
): ResolvedHeartbeatConfig | undefined {
	const agents = cfg.agents as
		| Record<string, { heartbeat?: unknown } | undefined>
		| undefined;
	const agentEntry = agents?.[agentId];
	const agentHb = agentEntry && typeof agentEntry === "object" && "heartbeat" in agentEntry
		? readHeartbeatBlock((agentEntry as { heartbeat?: unknown }).heartbeat)
		: undefined;
	const defaults = agents?.defaults as { heartbeat?: unknown } | undefined;
	const defaultHb = readHeartbeatBlock(defaults?.heartbeat);
	// Per-agent overrides per-key; defaults fill the gaps. This matches how
	// every other agents.defaults consumer in the codebase works.
	if (!agentHb && !defaultHb) return undefined;
	const merged: ResolvedHeartbeatConfig = {};
	const intervalMs = agentHb?.intervalMs ?? defaultHb?.intervalMs;
	if (intervalMs !== undefined) merged.intervalMs = intervalMs;
	const sessionKey = agentHb?.sessionKey ?? defaultHb?.sessionKey;
	if (sessionKey !== undefined) merged.sessionKey = sessionKey;
	const enabled = agentHb?.enabled ?? defaultHb?.enabled;
	if (enabled !== undefined) merged.enabled = enabled;
	const quietHours = agentHb?.quietHours ?? defaultHb?.quietHours;
	if (quietHours) merged.quietHours = quietHours;
	return merged;
}

function listAgentIds(cfg: BrigadeConfig): string[] {
	const agents = cfg.agents as Record<string, unknown> | undefined;
	if (!agents || typeof agents !== "object") return [];
	const out: string[] = [];
	for (const key of Object.keys(agents)) {
		if (key === "defaults") continue;
		if (!key.trim()) continue;
		out.push(key.trim());
	}
	return out;
}

export function createHeartbeatScheduler(deps: HeartbeatSchedulerDeps): HeartbeatScheduler {
	function scheduleNext(): void {
		const state = getState();
		if (state.stopped) {
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
			return;
		}
		if (state.agents.size === 0) {
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
			return;
		}
		const now = Date.now();
		let earliest = Number.POSITIVE_INFINITY;
		for (const agent of state.agents.values()) {
			if (agent.nextDueMs < earliest) earliest = agent.nextDueMs;
		}
		if (!Number.isFinite(earliest)) return;
		const delay = Math.max(0, earliest - now);
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			void onTimerFire();
		}, delay);
		state.timer.unref?.();
	}

	async function onTimerFire(): Promise<void> {
		const state = getState();
		state.timer = null;
		if (state.stopped) return;
		const now = Date.now();
		for (const agent of state.agents.values()) {
			if (now < agent.nextDueMs) continue;
			// Quiet-hours suppression. When we wake inside the window, skip the
			// fire and defer `nextDueMs` until the window's end — the operator
			// gets one heartbeat at "wake up" time, not a backlog of suppressed
			// fires hammering when they unsilence.
			if (agent.quietHours && isInQuietWindow(now, agent.quietHours)) {
				agent.nextDueMs = endOfQuietWindowMs(now, agent.quietHours);
				log.debug("heartbeat suppressed (quiet hours)", {
					agentId: agent.agentId,
					nextDueMs: agent.nextDueMs,
				});
				continue;
			}
			try {
				deps.onInterval({ agentId: agent.agentId, sessionKey: agent.sessionKey });
			} catch (err) {
				log.warn("heartbeat interval callback threw", {
					agentId: agent.agentId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			// Advance using the agent's phase so the schedule stays anchored
			// rather than drifting on each tick.
			agent.nextDueMs = computeNextDueMs(now + 1, agent.intervalMs, agent.phaseMs);
		}
		scheduleNext();
	}

	const scheduler: HeartbeatScheduler = {
		start: () => {
			const state = getState();
			state.stopped = false;
			scheduleNext();
		},
		stop: () => {
			const state = getState();
			state.stopped = true;
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
		},
		updateConfig: (cfg: BrigadeConfig) => {
			const state = getState();
			const now = Date.now();
			const nextAgents = new Map<string, AgentSchedule>();
			for (const agentId of listAgentIds(cfg)) {
				const hb = readAgentHeartbeatConfig(cfg, agentId);
				const intervalMs = hb?.intervalMs;
				if (!intervalMs || !Number.isFinite(intervalMs) || intervalMs <= 0) continue;
				// Audit 9 gap: per-agent kill-switch. Explicit `enabled: false`
				// suppresses the agent's schedule entirely — useful for parking
				// an agent without losing its interval config, and for the
				// agents.defaults pattern where the default is to enable but
				// one agent opts out.
				if (hb?.enabled === false) continue;
				const phaseMs = resolvePhaseMs(agentId, intervalMs);
				const prev = state.agents.get(agentId);
				const preserveSchedule =
					prev && prev.intervalMs === intervalMs && prev.phaseMs === phaseMs;
				const nextDueMs = preserveSchedule
					? prev.nextDueMs
					: computeNextDueMs(now, intervalMs, phaseMs);
				nextAgents.set(agentId, {
					agentId,
					intervalMs,
					phaseMs,
					nextDueMs,
					...(hb?.sessionKey ? { sessionKey: hb.sessionKey } : {}),
					...(hb?.quietHours ? { quietHours: hb.quietHours } : {}),
				});
			}
			state.agents.clear();
			for (const [id, schedule] of nextAgents) state.agents.set(id, schedule);
			scheduleNext();
		},
		getScheduleSnapshot: () => {
			const state = getState();
			return Array.from(state.agents.values()).map((agent) => ({
				agentId: agent.agentId,
				intervalMs: agent.intervalMs,
				nextDueMs: agent.nextDueMs,
			}));
		},
	};

	return scheduler;
}

/** Test-only — clear scheduler state. */
export function resetHeartbeatSchedulerForTests(): void {
	const state = getState();
	if (state.timer) clearTimeout(state.timer);
	state.agents.clear();
	state.timer = null;
	state.stopped = false;
}
