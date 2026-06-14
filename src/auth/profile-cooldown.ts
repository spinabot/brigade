// Auth-profile cooldown + ordering.
//
// Tracks per-profile failure state in `<authDir>/profile-state.json` so that:
//
//   • A profile that hit a transient failure (rate_limit / overloaded /
//     timeout) goes on cooldown for an escalating duration (30s → 1m → 5m)
//     based on its recent error count, and is skipped during selection
//     until the cooldown expires.
//
//   • A profile that hit a permanent failure (billing / auth_permanent) goes
//     on a longer "disabled" backoff (10m base for auth_permanent, 5h base
//     for billing, doubling per repeated failure, capped at 60m / 24h).
//
//   • Profile selection prefers most-recently-successful (`lastUsed`-asc
//     round-robin) and pushes cooled / disabled profiles to the bottom of
//     the order, sorted by soonest-expiry first (so a probe at expiry has
//     a fresh slot).
//
//   • Error counts decay: if a profile hasn't failed in 24h, the next failure
//     starts the count fresh rather than escalating off the old number. A
//     profile with one failure last week shouldn't be treated like one with
//     ten failures in the last hour.
//
// The state file is JSON, atomically written via PID-suffixed tmp + rename.
// Failure to read or write the state file is a soft failure — profile
// selection falls back to "pick first matching" (current Brigade behaviour)
// rather than blocking the run on observability state.

import fs from "node:fs";
import path from "node:path";

import type { RetryReason } from "../agents/error-classifier.js";
import { ensureDir, resolveAuthDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { tryGetRuntimeContext } from "../storage/runtime-context.js";

const log = createSubsystemLogger("auth/cooldown");

// ─────────────────────────────────────────────────────────────────────────────
// Schema. Loose at the boundary; strict in the helper functions.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileUsageStats {
  lastUsed?: number;          // ms since epoch on last success
  cooldownUntil?: number;     // transient lane (rate_limit / overloaded / timeout / unknown)
  cooldownReason?: RetryReason;
  cooldownModel?: string;     // optional model-scoped rate limit
  disabledUntil?: number;     // permanent lane (billing / auth_permanent)
  disabledReason?: RetryReason;
  errorCount?: number;        // attenuates over the failure window
  failureCounts?: Partial<Record<RetryReason, number>>;
  lastFailureAt?: number;
}

export interface ProfileStateFile {
  version: 1;
  // Optional explicit ordering per provider.
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  // Per-profileId stats.
  usageStats?: Record<string, ProfileUsageStats>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants. The established defaults are configurable here so
// brigade.json can override later without an API change.
// ─────────────────────────────────────────────────────────────────────────────

const COOLDOWN_MS_TIER_1 = 30_000;        // first transient failure
const COOLDOWN_MS_TIER_2 = 60_000;        // second
const COOLDOWN_MS_TIER_MAX = 5 * 60_000;  // third+
const DISABLED_BACKOFF_AUTH_BASE_MS = 10 * 60_000;
const DISABLED_BACKOFF_AUTH_MAX_MS = 60 * 60_000;
const DISABLED_BACKOFF_BILLING_BASE_MS = 5 * 60 * 60_000;
const DISABLED_BACKOFF_BILLING_MAX_MS = 24 * 60 * 60_000;
const FAILURE_WINDOW_MS = 24 * 60 * 60_000;

const TRANSIENT_REASONS: ReadonlySet<RetryReason> = new Set<RetryReason>([
  "rate_limit",
  "overloaded",
  "timeout",
  "unknown",
]);
const DISABLED_REASONS: ReadonlySet<RetryReason> = new Set<RetryReason>([
  "billing",
  "auth_permanent",
]);

// Per-key jitter (±10% of the base, uniform) so N profiles that hit a
// quota cap in the same second don't all expire their cooldowns at exactly
// the same future second and stampede the provider again. Without this, 5
// keys behind a single quota retry-storm on every cooldown boundary.
const COOLDOWN_JITTER_RATIO = 0.20; // 20% range = ±10% from base

export function calculateCooldownMs(errorCount: number): number {
  const n = Math.max(1, errorCount);
  let base: number;
  if (n <= 1) base = COOLDOWN_MS_TIER_1;
  else if (n <= 2) base = COOLDOWN_MS_TIER_2;
  else base = COOLDOWN_MS_TIER_MAX;
  // (random - 0.5) * 0.20 → uniform on [-0.10, +0.10) of base. Floor the
  // multiplied milliseconds so we don't return fractional ms.
  const jitter = Math.floor((Math.random() - 0.5) * base * COOLDOWN_JITTER_RATIO);
  return base + jitter;
}

export function calculateDisabledMs(reason: RetryReason, errorCount: number): number {
  const base = reason === "billing" ? DISABLED_BACKOFF_BILLING_BASE_MS : DISABLED_BACKOFF_AUTH_BASE_MS;
  const max = reason === "billing" ? DISABLED_BACKOFF_BILLING_MAX_MS : DISABLED_BACKOFF_AUTH_MAX_MS;
  const exp = Math.min(15, Math.max(0, errorCount - 1));
  return Math.min(max, base * 2 ** exp);
}

// ─────────────────────────────────────────────────────────────────────────────
// State file IO. Soft failures everywhere — we never want a corrupted state
// file to block a real `brigade agent` run.
// ─────────────────────────────────────────────────────────────────────────────

// Per-agentId FIFO lock chain. Protects the read-modify-write sequence that
// `markProfileFailure` / `markProfileSuccess` perform — two concurrent
// `brigade agent` turns for the same agent would otherwise interleave their
// in-memory snapshots and clobber each other's mark on save. Same shape as
// `withCronStoreLock`: a per-key promise chain that each holder awaits before
// running. Process-local — across processes, the file's PID-tagged atomic
// rename keeps the rename itself safe but cannot prevent the inner snapshot
// drift; the wave-c counterpart is a future file lock if we ever see
// gateway+cron contend on the same agent.
/** Pinned via global-singleton so hot-reload / dual-build keep one chain per agentId. */
const COOLDOWN_LOCKS_KEY = Symbol.for("brigade.profileCooldown.locks");
const cooldownLocks = resolveGlobalSingleton<Map<string, Promise<unknown>>>(
  COOLDOWN_LOCKS_KEY,
  () => new Map<string, Promise<unknown>>(),
);

/**
 * Run `work` under the per-agent cooldown lock. The lock is process-local
 * and FIFO; callers within the same process serialise per agentId. Returns
 * the work's result. A previous holder's rejection does not block us — the
 * chain swallows the error so the next holder runs.
 */
export function withProfileCooldownLock<T>(
  agentId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = agentId || "main";
  const previous = (cooldownLocks.get(key) ?? Promise.resolve()) as Promise<unknown>;
  const next = previous.catch(() => undefined).then(() => work());
  cooldownLocks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** Test-only — clear every per-agent cooldown lock chain. */
export function clearProfileCooldownLocksForTests(): void {
  cooldownLocks.clear();
}

export function resolveProfileStatePath(agentId: string): string {
  return path.join(resolveAuthDir(agentId), "profile-state.json");
}

// Convex-mode cache + flush for profile-state.json. The whole file rides
// the authFiles blob table VERBATIM (sealed) so cooldown stats, failure
// histograms, and the failover order array round-trip without semantic
// drift. The per-agent FIFO lock above still serialises read-modify-write
// in-process; Convex linearises across processes.
const convexProfileStateCache = new Map<string, ProfileStateFile>();
let profileStateFlushChain: Promise<void> = Promise.resolve();

/** Convex-mode boot hydration — install an agent's profile-state blob. */
export function primeProfileStateCache(agentId: string, state: ProfileStateFile): void {
  convexProfileStateCache.set(agentId, structuredClone(state));
}

/** Resolves when every profile-state write enqueued so far reached the
 *  backend (convex mode). */
export function awaitProfileStateFlush(): Promise<void> {
  return profileStateFlushChain;
}

/** Test-only. */
export function __resetProfileStateCacheForTests(): void {
  convexProfileStateCache.clear();
  profileStateFlushChain = Promise.resolve();
}

export function loadProfileState(agentId: string): ProfileStateFile {
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    const cached = convexProfileStateCache.get(agentId);
    if (cached) return structuredClone(cached);
    const empty: ProfileStateFile = { version: 1, usageStats: {} };
    convexProfileStateCache.set(agentId, empty);
    return structuredClone(empty);
  }

  const p = resolveProfileStatePath(agentId);
  if (!fs.existsSync(p)) return { version: 1, usageStats: {} };
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as ProfileStateFile;
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return { ...parsed, version: 1 };
    }
  } catch (err) {
    log.warn("failed to load profile state; falling back to empty", {
      path: p,
      error: (err as Error).message,
    });
  }
  return { version: 1, usageStats: {} };
}

export function saveProfileState(agentId: string, state: ProfileStateFile): void {
  const rctx = tryGetRuntimeContext();
  if (rctx?.mode === "convex") {
    convexProfileStateCache.set(agentId, structuredClone(state));
    const store = rctx.store;
    const frozen = structuredClone(state) as unknown as Record<string, unknown>;
    profileStateFlushChain = profileStateFlushChain
      .then(() => store.auth.writeAuthFileBlob(agentId, "profile-state", frozen))
      .catch((err) => {
        log.warn("profile state write to convex failed", {
          agentId,
          error: (err as Error).message,
        });
      });
    return;
  }

  const p = resolveProfileStatePath(agentId);
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
    log.warn("failed to save profile state", { path: p, error: (err as Error).message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read paths. Eligibility + ordering. Pure functions over the loaded state.
// ─────────────────────────────────────────────────────────────────────────────

export interface CooldownStatus {
  cooled: boolean;
  disabled: boolean;
  cooldownUntil?: number;
  disabledUntil?: number;
  reason?: RetryReason;
}

export function getCooldownStatus(
  stats: ProfileUsageStats | undefined,
  options: { now?: number; forModel?: string } = {},
): CooldownStatus {
  const now = options.now ?? Date.now();
  if (!stats) return { cooled: false, disabled: false };
  const status: CooldownStatus = { cooled: false, disabled: false };

  if (typeof stats.disabledUntil === "number" && stats.disabledUntil > now) {
    status.disabled = true;
    status.disabledUntil = stats.disabledUntil;
    status.reason = stats.disabledReason;
  }

  if (typeof stats.cooldownUntil === "number" && stats.cooldownUntil > now) {
    // Model-scoped rate limit only counts when we're asking about that model.
    if (
      stats.cooldownModel &&
      options.forModel &&
      stats.cooldownModel !== options.forModel
    ) {
      // Different model — cooldown doesn't apply.
    } else {
      status.cooled = true;
      status.cooldownUntil = stats.cooldownUntil;
      status.reason = stats.cooldownReason;
    }
  }

  return status;
}

export function isProfileEligible(
  state: ProfileStateFile,
  profileId: string,
  options: { now?: number; forModel?: string } = {},
): boolean {
  const stats = state.usageStats?.[profileId];
  const status = getCooldownStatus(stats, options);
  return !status.cooled && !status.disabled;
}

export interface ProfileOrderArgs {
  state: ProfileStateFile;
  provider: string;
  profileIds: string[];
  preferredProfile?: string;
  now?: number;
  forModel?: string;
}

// Sort profileIds: eligible first (lastUsed asc — fairer round-robin), then
// cooled/disabled appended in soonest-expiry-first order so a probe can
// hit a profile right at its cooldown boundary.
export function orderProfilesForSelection(args: ProfileOrderArgs): string[] {
  const now = args.now ?? Date.now();
  const usageStats = args.state.usageStats ?? {};
  const explicitOrder = args.state.order?.[args.provider];

  const seen = new Set<string>();
  const eligible: string[] = [];
  const cooled: string[] = [];

  // Honour preferredProfile by floating it to the head of its bucket.
  const orderedSource: string[] = [];
  if (args.preferredProfile && args.profileIds.includes(args.preferredProfile)) {
    orderedSource.push(args.preferredProfile);
  }
  if (explicitOrder) {
    for (const id of explicitOrder) {
      if (args.profileIds.includes(id)) orderedSource.push(id);
    }
  }
  for (const id of args.profileIds) orderedSource.push(id);

  for (const id of orderedSource) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (isProfileEligible(args.state, id, { now, forModel: args.forModel })) {
      eligible.push(id);
    } else {
      cooled.push(id);
    }
  }

  // Round-robin: eligible profiles sorted by lastUsed asc (oldest first) so
  // we don't keep hammering the same profile turn after turn. The
  // preferredProfile, when supplied AND eligible, is pulled to the head
  // *after* the sort so the caller's preference wins over rotation.
  eligible.sort((a, b) => {
    const aUsed = usageStats[a]?.lastUsed ?? 0;
    const bUsed = usageStats[b]?.lastUsed ?? 0;
    return aUsed - bUsed;
  });
  if (args.preferredProfile) {
    const idx = eligible.indexOf(args.preferredProfile);
    if (idx > 0) {
      eligible.splice(idx, 1);
      eligible.unshift(args.preferredProfile);
    }
  }

  // Cooled: soonest-expiry first.
  cooled.sort((a, b) => {
    const ax = expiryOf(usageStats[a], now);
    const bx = expiryOf(usageStats[b], now);
    return ax - bx;
  });

  return [...eligible, ...cooled];
}

function expiryOf(stats: ProfileUsageStats | undefined, now: number): number {
  if (!stats) return now;
  const c = typeof stats.cooldownUntil === "number" && stats.cooldownUntil > now ? stats.cooldownUntil : Infinity;
  const d = typeof stats.disabledUntil === "number" && stats.disabledUntil > now ? stats.disabledUntil : Infinity;
  const e = Math.min(c, d);
  return e === Infinity ? now : e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation paths. All return the next state by value (immutable update) and
// then save it. Callers that want to batch mutations can pass `{ save:false }`
// and call saveProfileState themselves.
// ─────────────────────────────────────────────────────────────────────────────

export interface MarkSuccessArgs {
  agentId: string;
  state: ProfileStateFile;
  profileId: string;
  provider: string;
  save?: boolean;
}

export function markProfileSuccess(args: MarkSuccessArgs): ProfileStateFile {
  const next = cloneState(args.state);
  const stats = readStats(next, args.profileId);
  stats.lastUsed = Date.now();
  // Clear ALL failure state on success. The profile is healthy.
  delete stats.cooldownUntil;
  delete stats.cooldownReason;
  delete stats.cooldownModel;
  delete stats.disabledUntil;
  delete stats.disabledReason;
  delete stats.errorCount;
  delete stats.failureCounts;
  delete stats.lastFailureAt;
  writeStats(next, args.profileId, stats);
  next.lastGood = { ...(next.lastGood ?? {}), [args.provider]: args.profileId };
  if (args.save !== false) saveProfileState(args.agentId, next);
  return next;
}

export interface MarkFailureArgs {
  agentId: string;
  state: ProfileStateFile;
  profileId: string;
  reason: RetryReason;
  modelId?: string;
  save?: boolean;
}

export function markProfileFailure(args: MarkFailureArgs): ProfileStateFile {
  const next = cloneState(args.state);
  const stats = readStats(next, args.profileId);
  const now = Date.now();

  // Decay error count if the last failure was outside the rolling window.
  const lastFailureAt = stats.lastFailureAt ?? 0;
  const decay = lastFailureAt > 0 && now - lastFailureAt > FAILURE_WINDOW_MS;
  const baseErrorCount = decay ? 0 : stats.errorCount ?? 0;
  const nextErrorCount = baseErrorCount + 1;

  stats.errorCount = nextErrorCount;
  stats.lastFailureAt = now;
  stats.failureCounts = {
    ...(decay ? {} : stats.failureCounts ?? {}),
    [args.reason]: ((decay ? 0 : stats.failureCounts?.[args.reason]) ?? 0) + 1,
  };

  if (DISABLED_REASONS.has(args.reason)) {
    const dur = calculateDisabledMs(args.reason, nextErrorCount);
    stats.disabledUntil = now + dur;
    stats.disabledReason = args.reason;
    log.warn("profile disabled", {
      profileId: args.profileId,
      reason: args.reason,
      disabledForMs: dur,
      errorCount: nextErrorCount,
    });
  } else if (TRANSIENT_REASONS.has(args.reason)) {
    const dur = calculateCooldownMs(nextErrorCount);
    stats.cooldownUntil = now + dur;
    stats.cooldownReason = args.reason;
    if (args.modelId && args.reason === "rate_limit") {
      stats.cooldownModel = args.modelId;
    } else {
      delete stats.cooldownModel;
    }
    log.info("profile cooled", {
      profileId: args.profileId,
      reason: args.reason,
      cooldownMs: dur,
      modelId: args.modelId,
      errorCount: nextErrorCount,
    });
  } else {
    // format / model_not_found / auth / session_expired — record but no cooldown.
    log.debug("profile failure recorded (no cooldown)", {
      profileId: args.profileId,
      reason: args.reason,
      errorCount: nextErrorCount,
    });
  }

  writeStats(next, args.profileId, stats);
  if (args.save !== false) saveProfileState(args.agentId, next);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactional wrappers — load FRESH from disk under the lock, apply the
// mark, then save. Use these on every concurrent surface (agent-loop +
// cron). The non-transactional `markProfileFailure` / `markProfileSuccess`
// still exist for callers that hold the state already (tests, single-shot
// flows) — they remain race-prone if called concurrently.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a profile-failure mark transactionally: under the per-agent cooldown
 * lock, re-load fresh state from disk, merge `markProfileFailure` against
 * THAT snapshot, then save. Returns the merged state so the caller can keep
 * its in-memory copy aligned with what just landed on disk.
 *
 * `args.state` is the caller's last-known snapshot — used only to satisfy
 * the function signature; the merged result is built from disk to defeat
 * cross-process drift.
 */
export async function recordProfileFailureLocked(args: MarkFailureArgs): Promise<ProfileStateFile> {
  return withProfileCooldownLock(args.agentId, async () => {
    const fresh = loadProfileState(args.agentId);
    return markProfileFailure({ ...args, state: fresh });
  });
}

/**
 * Apply a profile-success mark transactionally — same shape as
 * `recordProfileFailureLocked`. Used on every successful turn so a sibling
 * write that flipped the profile into cooldown 50ms ago doesn't get
 * silently overwritten by our stale "everything's fine" snapshot.
 */
export async function recordProfileSuccessLocked(args: MarkSuccessArgs): Promise<ProfileStateFile> {
  return withProfileCooldownLock(args.agentId, async () => {
    const fresh = loadProfileState(args.agentId);
    return markProfileSuccess({ ...args, state: fresh });
  });
}

/**
 * Load + sweep expired windows transactionally. Used at turn start so the
 * read isn't racing against a concurrent peer's success-save.
 */
export async function loadProfileStateLocked(agentId: string): Promise<ProfileStateFile> {
  return withProfileCooldownLock(agentId, async () => {
    const fresh = loadProfileState(agentId);
    return clearExpiredCooldowns(fresh);
  });
}

// Sweep expired cooldowns/disabled windows in-place. Cheap to call before
// a selection so the order computed above doesn't include slots that have
// already aged out.
export function clearExpiredCooldowns(state: ProfileStateFile, now: number = Date.now()): ProfileStateFile {
  let mutated = false;
  const next = cloneState(state);
  const stats = next.usageStats ?? {};
  for (const id of Object.keys(stats)) {
    const s = stats[id];
    if (!s) continue;
    if (typeof s.cooldownUntil === "number" && s.cooldownUntil <= now) {
      delete s.cooldownUntil;
      delete s.cooldownReason;
      delete s.cooldownModel;
      // Cooldown expired — half-open the breaker by zeroing recent error count.
      s.errorCount = 0;
      mutated = true;
    }
    if (typeof s.disabledUntil === "number" && s.disabledUntil <= now) {
      delete s.disabledUntil;
      delete s.disabledReason;
      mutated = true;
    }
  }
  return mutated ? next : state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny helpers.
// ─────────────────────────────────────────────────────────────────────────────

function cloneState(state: ProfileStateFile): ProfileStateFile {
  return {
    version: 1,
    order: state.order ? { ...state.order } : undefined,
    lastGood: state.lastGood ? { ...state.lastGood } : undefined,
    usageStats: state.usageStats
      ? Object.fromEntries(
          Object.entries(state.usageStats).map(([k, v]) => [k, { ...v }]),
        )
      : {},
  };
}

function readStats(state: ProfileStateFile, profileId: string): ProfileUsageStats {
  state.usageStats = state.usageStats ?? {};
  state.usageStats[profileId] = state.usageStats[profileId] ?? {};
  return { ...state.usageStats[profileId] };
}

function writeStats(state: ProfileStateFile, profileId: string, stats: ProfileUsageStats): void {
  state.usageStats = state.usageStats ?? {};
  state.usageStats[profileId] = stats;
}
