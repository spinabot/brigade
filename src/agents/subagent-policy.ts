/**
 * Sub-agent runtime policy + run registry — Primitive #6.
 *
 * Three concerns live here:
 *
 *   1. **Depth detection from the session key.** We encode "this session IS a
 *      sub-agent" in the key shape itself — `agent:<id>:subagent:<uuid>`.
 *      Counting the `":subagent:"` markers in the key tells us the depth
 *      without a process-global Map that could leak across crashes / restarts.
 *      Top-level sessions (`agent:<id>:main`) have depth 0; a first-level
 *      child has depth 1; a grandchild would have depth 2 (but the runner
 *      refuses to spawn one because the leaf-filter drops `spawn_agent`
 *      from the child's tools).
 *
 *   2. **Run registry with lifecycle timings + outcomes.** A process-scoped
 *      Map keyed by parent session key tracks every child run with
 *      createdAt / startedAt / endedAt / outcome / error / label / cleanup
 *      policy — not just "is this child active?". Lets the gateway answer
 *      "what's running right now?" and "what was the last child's outcome?"
 *      without spelunking through transcript files. Persisted to disk is a
 *      v2 concern; in-memory is enough for the single-user / single-process
 *      v1 footprint.
 *
 *   3. **Race-safe slot reservation.** Two concurrent `spawn_agent` calls
 *      from the same parent must NOT both pass the limit check and then
 *      both register, blowing past `maxChildrenPerParent`. `reserveSubagentSlot`
 *      does the count check and the registration in one synchronous step,
 *      closing the TOCTOU window that an "assert then register" pair leaves
 *      open. The reserved slot starts in `"reserved"` state and transitions
 *      to `"running"` once the child's run actually begins.
 *
 * Limits resolve from config (`agents.defaults.subagents`) with hardcoded
 * defaults (max depth 1, max children per parent 5, default timeout 300s).
 * All three are individually overridable.
 *
 * `SubagentLimitError` is a typed exception the spawn tool catches and
 * converts to a tool-result with `status: "limit-refused"` so the model
 * sees a clear refusal it can self-correct from, instead of an opaque throw.
 */

import type { BrigadeConfig } from "../config/io.js";
import type { AnyBrigadeTool } from "./tools/types.js";

export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT = 5;
export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 300;

/**
 * The marker we splice into a sub-agent's session key so depth can be derived
 * from the key alone. `agent:main:main` → 0 markers → depth 0 (parent).
 * `agent:main:subagent:abc` → 1 marker → depth 1.
 */
const SUBAGENT_SESSION_MARKER = ":subagent:";

export interface SubagentLimits {
	maxDepth: number;
	maxChildrenPerParent: number;
	defaultTimeoutSeconds: number;
}

/**
 * Read the `agents.defaults.subagents` block from brigade.json, fall back to
 * the hardcoded defaults for any missing or invalid field. Always returns a
 * fully-populated struct so the caller never has to null-check.
 */
export function resolveSubagentLimits(config: BrigadeConfig | undefined): SubagentLimits {
	const block = (
		config?.agents as { defaults?: { subagents?: Record<string, unknown> } } | undefined
	)?.defaults?.subagents;
	// `maxDepth: 0` is a footgun — the reservation check `callerDepth >= maxDepth`
	// would refuse top-level spawns too (since callerDepth=0). An operator who
	// genuinely wants "no sub-agents" should disable the tool, not set the depth
	// to zero. Floor to 1 so a misconfigured value degrades to "single level"
	// rather than "broken". `maxChildrenPerParent: 0` and `defaultTimeoutSeconds:
	// 0` are similarly forbidden — both make spawn impossible in practice.
	const maxDepth = Math.max(1, readNonNegInt(block?.maxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH);
	const maxChildrenPerParent = Math.max(
		1,
		readNonNegInt(block?.maxChildrenPerParent) ?? DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT,
	);
	const defaultTimeoutSeconds = Math.max(
		1,
		readNonNegInt(block?.defaultTimeoutSeconds) ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
	);
	return { maxDepth, maxChildrenPerParent, defaultTimeoutSeconds };
}

function readNonNegInt(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
	return Math.floor(v);
}

/**
 * True if the session key indicates a sub-agent session. Used by the system-
 * prompt assembler (to switch to minimal mode) and the registry (to drop the
 * `spawn_agent` tool at leaf depth).
 */
export function isSubagentSessionKey(sessionKey: string | undefined): boolean {
	return typeof sessionKey === "string" && sessionKey.includes(SUBAGENT_SESSION_MARKER);
}

/**
 * Count the `:subagent:` markers in the key to get the depth. Top-level
 * sessions return 0; nested sub-agents would return ≥ 1.
 */
export function getSubagentDepthFromSessionKey(sessionKey: string | undefined): number {
	if (typeof sessionKey !== "string" || sessionKey.length === 0) return 0;
	const segments = sessionKey.split(SUBAGENT_SESSION_MARKER);
	return Math.max(segments.length - 1, 0);
}

/**
 * Derive a child session key from the parent's. Same algorithm regardless of
 * whether the parent is itself a sub-agent — we always append `":subagent:"`
 * plus a fresh uuid. Depth is then `parentDepth + 1` (which the leaf-filter
 * rejects beyond `maxDepth`, so a grandchild key is never actually built).
 */
export function buildChildSessionKey(parentSessionKey: string, uuid: string): string {
	if (!parentSessionKey) {
		throw new Error("buildChildSessionKey: parentSessionKey required");
	}
	return `${parentSessionKey}${SUBAGENT_SESSION_MARKER}${uuid}`;
}

/* ─────────────────────── run registry + atomic reserve ─────────────────── */

/** Lifecycle states a child run moves through. */
export type ChildRunState = "reserved" | "running" | "ended";

/** Outcome the parent's spawn tool surfaces in the tool result. */
export type ChildRunOutcome = "ok" | "aborted" | "timed-out" | "error";

/**
 * Everything we know about a single sub-agent run. Lifetime: created by
 * `reserveSubagentSlot()`, mutated by `markSubagentRunStarted()` /
 * `releaseSubagentSlot()`, removed from the active map once `releaseSubagentSlot`
 * fires. Snapshots remain queryable via `listRecentlyCompletedChildren()`
 * for a bounded ring of recent results.
 */
export interface ChildRunRecord {
	parentSessionKey: string;
	childSessionKey: string;
	parentRunId?: string;
	label: string;
	/** Caller's depth at spawn time. Child's own depth = callerDepth + 1. */
	callerDepth: number;
	/** "delete" → transcript file removed after settle. "keep" → preserved. */
	cleanup: "delete" | "keep";
	state: ChildRunState;
	/** ms-epoch — set when slot is reserved (before run starts). */
	createdAt: number;
	/** ms-epoch — set when `markSubagentRunStarted` fires (Pi run begun). */
	startedAt?: number;
	/** ms-epoch — set when `releaseSubagentSlot` fires (settle, abort, timeout, error). */
	endedAt?: number;
	outcome?: ChildRunOutcome;
	/** Set when outcome is "error" (unexpected throw). Otherwise undefined. */
	error?: string;
}

const activeChildren = new Map<string, Map<string, ChildRunRecord>>();

/**
 * Bounded ring of recently-ended child runs, oldest first. Survives the
 * `releaseSubagentSlot` cleanup so consumers (gateway `/status`, future TUI
 * "recent sub-agents" view) can answer "what just finished?".
 */
const RECENT_HISTORY_CAP = 32;
const recentlyEnded: ChildRunRecord[] = [];

export class SubagentLimitError extends Error {
	readonly kind: "depth" | "concurrent";
	constructor(message: string, kind: "depth" | "concurrent") {
		super(message);
		this.name = "SubagentLimitError";
		this.kind = kind;
	}
}

export interface ReserveSubagentSlotArgs {
	parentSessionKey: string;
	childSessionKey: string;
	parentRunId?: string;
	label: string;
	callerDepth: number;
	limits: SubagentLimits;
	cleanup: "delete" | "keep";
}

/**
 * Atomically validate limits + register the child. This is the ONLY entry
 * point — callers must not pre-check via `countActiveChildren()` and then
 * register later (that's the TOCTOU window we close here). Throws
 * `SubagentLimitError` if depth or concurrency caps would be exceeded;
 * returns the freshly-registered `ChildRunRecord` otherwise.
 *
 * The function is fully synchronous: Node's single-threaded event loop
 * gives us the atomicity we need — no two `reserveSubagentSlot` calls
 * can interleave once the function is entered.
 */
export function reserveSubagentSlot(args: ReserveSubagentSlotArgs): ChildRunRecord {
	// Depth check first — cheaper than the map lookup and the rule is the
	// same regardless of concurrent count.
	if (args.callerDepth >= args.limits.maxDepth) {
		throw new SubagentLimitError(
			`spawn_agent refused: this session is already at sub-agent depth ${args.callerDepth} ` +
				`(max ${args.limits.maxDepth}). Sub-agents at the leaf cannot spawn further ` +
				`sub-agents — finish the work in this session and return the answer.`,
			"depth",
		);
	}
	// Single-statement get-or-create — Node's event loop never preempts mid-
	// expression, so two near-simultaneous callers can't both insert a fresh
	// Map for the same parent (the earlier audit caught a multi-statement
	// version where caller A's read-undefined + caller B's read-undefined +
	// both `.set(new Map())` could clobber A's record). Combining the lookup
	// + insert + read of `.size` into one synchronous chain closes that
	// window without needing a lock.
	const runs =
		activeChildren.get(args.parentSessionKey) ??
		(() => {
			const fresh = new Map<string, ChildRunRecord>();
			activeChildren.set(args.parentSessionKey, fresh);
			return fresh;
		})();
	const activeCount = runs.size;
	if (activeCount >= args.limits.maxChildrenPerParent) {
		throw new SubagentLimitError(
			`spawn_agent refused: this session already has ${activeCount} active sub-agent(s) ` +
				`(max ${args.limits.maxChildrenPerParent}). Wait for one to finish, or ` +
				`combine the new request into an existing sub-agent's task.`,
			"concurrent",
		);
	}
	if (runs.has(args.childSessionKey)) {
		// Duplicate childSessionKey shouldn't happen (uuid v4) but if it does,
		// fail closed rather than silently overwriting the previous record.
		throw new Error(
			`reserveSubagentSlot: childSessionKey already registered: ${args.childSessionKey}`,
		);
	}
	const record: ChildRunRecord = {
		parentSessionKey: args.parentSessionKey,
		childSessionKey: args.childSessionKey,
		...(args.parentRunId !== undefined ? { parentRunId: args.parentRunId } : {}),
		label: args.label,
		callerDepth: args.callerDepth,
		cleanup: args.cleanup,
		state: "reserved",
		createdAt: Date.now(),
	};
	runs.set(args.childSessionKey, record);
	return record;
}

/**
 * Transition a reserved slot to `"running"` and stamp `startedAt`. Called
 * by the runner immediately before delegating to `runSingleTurn`. Safe to
 * call once per slot; subsequent calls are no-ops (so a retry that re-enters
 * the runner doesn't double-stamp the timing).
 */
export function markSubagentRunStarted(
	parentSessionKey: string,
	childSessionKey: string,
): void {
	const record = activeChildren.get(parentSessionKey)?.get(childSessionKey);
	if (!record) return;
	if (record.state !== "reserved") return;
	record.state = "running";
	record.startedAt = Date.now();
}

/**
 * Release the slot + record the outcome. Moves the record into
 * `recentlyEnded` (capped ring) so listings can still surface it briefly.
 * Idempotent — calling twice for the same slot is a no-op so the runner's
 * `finally` block can fire safely even when the catch block already
 * settled the record.
 */
export function releaseSubagentSlot(args: {
	parentSessionKey: string;
	childSessionKey: string;
	outcome: ChildRunOutcome;
	error?: string;
}): ChildRunRecord | undefined {
	const runs = activeChildren.get(args.parentSessionKey);
	const record = runs?.get(args.childSessionKey);
	if (!record || !runs) return undefined;
	if (record.state === "ended") return record;
	record.state = "ended";
	record.endedAt = Date.now();
	record.outcome = args.outcome;
	if (args.error !== undefined) record.error = args.error;
	runs.delete(args.childSessionKey);
	if (runs.size === 0) activeChildren.delete(args.parentSessionKey);
	recentlyEnded.push(record);
	while (recentlyEnded.length > RECENT_HISTORY_CAP) recentlyEnded.shift();
	return record;
}

/** Count children in `"reserved"` or `"running"` state for a parent. */
export function countActiveChildren(parentSessionKey: string): number {
	return activeChildren.get(parentSessionKey)?.size ?? 0;
}

/** Snapshot of every active child run for a parent (cloned — safe to mutate). */
export function listActiveChildren(parentSessionKey: string): ChildRunRecord[] {
	const runs = activeChildren.get(parentSessionKey);
	if (!runs) return [];
	return [...runs.values()].map((r) => ({ ...r }));
}

/** Single-record lookup. Returns undefined if the slot has already ended. */
export function getChildRunRecord(
	parentSessionKey: string,
	childSessionKey: string,
): ChildRunRecord | undefined {
	const record = activeChildren.get(parentSessionKey)?.get(childSessionKey);
	return record ? { ...record } : undefined;
}

/** Last N ended records (oldest first). Cloned. */
export function listRecentlyEndedChildren(): ChildRunRecord[] {
	return recentlyEnded.map((r) => ({ ...r }));
}

/* ───────────────────────── tool filtering ─────────────────────── */

/**
 * Drop `spawn_agent` from a tool list when the CALLER's depth would already
 * make `reserveSubagentSlot` refuse — the rule is `callerDepth >= maxDepth
 * → refuse` — so the tool surface never offers a tool that can't legally be
 * called. With the default `maxDepth = 1`:
 *
 *   callerDepth = 0 (top-level operator turn) → spawn_agent registered
 *   callerDepth = 1 (running INSIDE a sub-agent) → spawn_agent dropped
 *
 * With `maxDepth = 2`, depth-1 sub-agents keep the tool and can spawn one more
 * level deep; only depth-2 grandchildren see it dropped. Recursion is bounded
 * by depth rather than by any process-global state.
 */
export function filterToolsForSubagentDepth(args: {
	tools: AnyBrigadeTool[];
	/** Depth of the session that would CALL `spawn_agent`. */
	callerDepth: number;
	maxDepth: number;
}): AnyBrigadeTool[] {
	const wouldRefuse = args.callerDepth >= args.maxDepth;
	if (!wouldRefuse) return args.tools;
	return args.tools.filter((t) => t.name !== "spawn_agent");
}

/** Test-only hook: clear the active-children registry + recent history between cases. */
export function clearSubagentRegistryForTests(): void {
	activeChildren.clear();
	recentlyEnded.length = 0;
}
