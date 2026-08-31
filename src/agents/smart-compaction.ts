// Smart compaction support for Brigade.
//
// THREE responsibilities, all centred on keeping the context window healthy:
//
// 1. Tool-result truncation — bound any single tool's output to a safe share
//    of the model's context window. A 10 MB grep result that lands in the
//    transcript verbatim will OOM a small-context model on the next turn;
//    head+tail truncation with a clear notice keeps the transcript usable
//    while preserving the output's beginning and (if it looks important) end.
//    [resolveToolResultMaxChars / truncateToolResultText — Brigade-native,
//    primitive #1 era, has its own tests in smart-compaction.test.ts]
//
// 2. Compaction-window math — given the active model's context budget plus
//    the running token usage, decide whether the next turn should compact
//    before issuing the prompt. Pi 0.70.x manages compaction internally
//    when a session is configured for it; this module provides the
//    threshold + safe-floor helpers that the wrapper uses to decide
//    whether to *recommend* a compaction up front.
//    [evaluateCompactionDecision — Brigade-native, primitive #1 era]
//
// 3. Two-tier message-history compaction — walk the full message history,
//    shrink oversized tool results (Pass 1), then if the aggregate sum still
//    exceeds budget, shrink newest→oldest until under the cap (Pass 2).
//    Used by the lifted v0.1.3 agent loop's transformContext hook.
//    [smartCompactToolResults — folded in from src/core/smart-compaction.ts
//    on 2026-05-08; the previous parallel implementation lived alongside the
//    lifted v0.1.3 bundle. This file is now the single source of truth for
//    all compaction concerns.]
//
// All limits are configurable via brigade.json
// (`agents.defaults.contextLimits`); the defaults below are tuned to the
// observed sweet spot across Anthropic / OpenAI / Google / Ollama models.

// ─────────────────────────────────────────────────────────────────────────────
// Tool-result truncation constants.
//
// A tool result is bounded by the smaller of:
//   • a hard cap (`DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS`)
//   • a context-share cap (`MAX_TOOL_RESULT_CONTEXT_SHARE` × context window)
// with a floor of `MIN_KEEP_CHARS` so 8k-context models still see something
// useful from a tool that returned less than 2 KiB.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.30;
export const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16_000;
export const MIN_KEEP_CHARS = 2_000;

// Approx. chars per token across modern tokenizers (BPE-flavoured) — close
// enough for budgeting; the exact rate doesn't matter for "should we
// truncate" decisions, only for sizing the bucket.
const APPROX_CHARS_PER_TOKEN = 4;

const HEAD_TAIL_SPLIT_TAIL_RATIO = 0.30;          // up to 30% of budget for tail
const HEAD_TAIL_TAIL_BUDGET_CAP = 4_000;          // never spend more than 4k chars on the tail
const HEAD_TAIL_OMISSION_MARKER =
  "\n\n[… middle content omitted — head and tail preserved …]\n\n";

// Matchers for "this tool result has an important tail" — error blocks,
// summary lines, JSON-end braces, etc. When matched we use the head+tail
// strategy; otherwise we keep the head only and discard the rest.
const IMPORTANT_TAIL_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /summary\s*:/i,
  /\}\s*$/, // JSON object close near the end
  /\]\s*$/, // JSON array close near the end
];

export interface ResolveToolResultLimitArgs {
  // Total context window in tokens (from the model registry). Required so the
  // share cap can scale with model size.
  contextWindowTokens: number;
  // Optional override (config-driven). When set, this is the hard cap; the
  // share-based cap still applies.
  hardCharOverride?: number;
}

export function resolveToolResultMaxChars(args: ResolveToolResultLimitArgs): number {
  const sharedCap = Math.floor(
    args.contextWindowTokens * APPROX_CHARS_PER_TOKEN * MAX_TOOL_RESULT_CONTEXT_SHARE,
  );
  const hardCap = args.hardCharOverride ?? DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  // Floor — even at 8k context (~32k chars), a 30% share is ~9.6k. We want
  // tools to surface at least 2k of useful output even on a tiny window.
  return Math.max(MIN_KEEP_CHARS, Math.min(hardCap, sharedCap));
}

export interface TruncateToolResultArgs {
  text: string;
  maxChars: number;
  /** Tool that produced this output, so the marker can name what to re-run. */
  toolName?: string;
}

export interface TruncationOutcome {
  text: string;
  truncated: boolean;
  droppedChars: number;
}

export function truncateToolResultText(args: TruncateToolResultArgs): TruncationOutcome {
  const { text, maxChars, toolName } = args;
  if (typeof text !== "string" || text.length <= maxChars) {
    return { text, truncated: false, droppedChars: 0 };
  }

  // Reserve room for the truncation suffix so the suffix itself doesn't push
  // us back over the limit.
  const suffixSample = formatTruncationSuffix(text.length, toolName); // worst-case length
  const budget = Math.max(MIN_KEEP_CHARS, maxChars - suffixSample.length);

  if (hasImportantTail(text)) {
    const tailBudget = Math.min(
      Math.floor(budget * HEAD_TAIL_SPLIT_TAIL_RATIO),
      HEAD_TAIL_TAIL_BUDGET_CAP,
    );
    const headBudget = Math.max(0, budget - tailBudget - HEAD_TAIL_OMISSION_MARKER.length);
    const head = text.slice(0, headBudget);
    const tail = text.slice(text.length - tailBudget);
    const droppedChars = text.length - head.length - tail.length;
    const out = head + HEAD_TAIL_OMISSION_MARKER + tail + formatTruncationSuffix(droppedChars, toolName);
    return { text: out, truncated: true, droppedChars };
  }

  // No important tail signal: keep the head only.
  const head = text.slice(0, budget);
  const droppedChars = text.length - head.length;
  return {
    text: head + formatTruncationSuffix(droppedChars, toolName),
    truncated: true,
    droppedChars,
  };
}

/**
 * The marker left in place of dropped tool output.
 *
 * Names the TOOL when we know it, so the elision is a reference rather than a
 * hole: the model can re-run `read` or `bash` to recover what was cut instead
 * of only learning that something is missing. This is the difference between
 * compaction (reversible — the content is reconstructible from a handle we
 * kept) and summarization (irreversible), and it is the property that makes
 * evicting tool output the cheap first tier: nothing is truly lost, because
 * the command that produced it is still in the transcript above.
 *
 * Without a handle a truncation marker just tells the model to distrust its own
 * context, which is worse than useless — it invites a re-read it cannot aim.
 */
/**
 * Longest tool name we will echo into a model-facing marker.
 *
 * Real tool names are short. A long one is either a bug or an attack, and the
 * marker must never become a vehicle for either.
 */
const MAX_TOOL_NAME_CHARS = 64;

/**
 * Make a tool name safe to embed in prompt text.
 *
 * The name is NOT trusted input. For an MCP tool it is supplied by the MCP
 * server; for a hallucinated call it is supplied by the model. Echoed raw, a
 * name containing a backtick closes the code span the marker puts it in, and
 * everything after it — a `##` heading, an instruction — lands as ordinary
 * model-facing prompt text inside what is supposed to be an inert notice.
 *
 * Unbounded, it is also an amplifier: a 50 KB name turned a 20 KB tool result
 * into a 52 KB one while the compactor reported a successful truncation.
 *
 * So: identifier characters only, hard length cap.
 */
function safeToolName(toolName?: string): string {
  const trimmed = toolName?.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[^\w.:-]/g, "").slice(0, MAX_TOOL_NAME_CHARS);
}

export function formatTruncationSuffix(droppedChars: number, toolName?: string): string {
  // Plain integer, never `toLocaleString()`: this string is MODEL-facing and
  // goes into the prompt, so a locale-dependent separator would make the same
  // transcript render differently on different machines — non-reproducible,
  // and a prompt-cache miss for no benefit.
  const n = Math.max(1, Math.floor(droppedChars));
  const safe = safeToolName(toolName);
  const how = safe ? ` — re-run \`${safe}\` for the full output` : "";
  return `\n\n[… ${n} more characters truncated${how} …]`;
}

function hasImportantTail(text: string): boolean {
  // Cheap test: only inspect the trailing 1 KiB. A "summary" or "error" block
  // an entire context window away from the end isn't an important *tail*.
  const sample = text.slice(Math.max(0, text.length - 1024));
  for (const p of IMPORTANT_TAIL_PATTERNS) if (p.test(sample)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction-window math. Pi triggers compaction internally when context
// usage breaches its own threshold; this helper lets the wrapper *anticipate*
// the trigger so a "we're going to compact next" log/heartbeat fires before
// the user sees a multi-second pause.
// ─────────────────────────────────────────────────────────────────────────────

// Below this prompt-budget floor we refuse to compact and warn instead — at
// 8k tokens of headroom there isn't enough room for the system prompt + a
// summarisation instruction + a useful summary, so the right move is to
// surface the overflow rather than blunder a compaction.
export const MIN_PROMPT_BUDGET_TOKENS = 8_000;
// What fraction of context must be free post-compaction to be worth doing?
// Below this the compaction "succeeds" but the next turn immediately tips
// over again.
export const MIN_PROMPT_BUDGET_RATIO = 0.5;
// Compaction is recommended once usage crosses this share of the window.
export const COMPACTION_TRIGGER_RATIO = 0.85;

export interface CompactionDecisionArgs {
  contextWindowTokens: number;
  estimatedUsageTokens: number;
}

export interface CompactionDecision {
  shouldRecommendCompaction: boolean;
  triggerThresholdTokens: number;
  promptBudgetTokens: number;
  reason: "below-threshold" | "headroom-tight" | "headroom-too-tight" | "ready";
}

export function evaluateCompactionDecision(args: CompactionDecisionArgs): CompactionDecision {
  const triggerThresholdTokens = Math.floor(args.contextWindowTokens * COMPACTION_TRIGGER_RATIO);
  const promptBudgetTokens = Math.max(0, args.contextWindowTokens - args.estimatedUsageTokens);

  if (args.estimatedUsageTokens < triggerThresholdTokens) {
    return {
      shouldRecommendCompaction: false,
      triggerThresholdTokens,
      promptBudgetTokens,
      reason: "below-threshold",
    };
  }
  if (promptBudgetTokens < MIN_PROMPT_BUDGET_TOKENS) {
    return {
      shouldRecommendCompaction: false,
      triggerThresholdTokens,
      promptBudgetTokens,
      reason: "headroom-too-tight",
    };
  }
  const targetFreeTokens = Math.floor(args.contextWindowTokens * MIN_PROMPT_BUDGET_RATIO);
  if (promptBudgetTokens < targetFreeTokens) {
    return {
      shouldRecommendCompaction: true,
      triggerThresholdTokens,
      promptBudgetTokens,
      reason: "headroom-tight",
    };
  }
  return {
    shouldRecommendCompaction: true,
    triggerThresholdTokens,
    promptBudgetTokens,
    reason: "ready",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot-resolution shim for the COMPACTION provider extension slot.
//
// Lane J of the plugin-SDK parity work. Shape-only today — Brigade's default
// behaviour is the two-tier head+tail truncation below; when an operator
// pins `extensions.slots.compaction = "<plugin-id>"` in brigade.json AND a
// `compactionProvider` plugin with that id has loaded, the resolver routes
// `summarize()` to the plugin and the caller decides whether to use the
// returned string. When no slot is pinned (or the pinned id isn't registered),
// the caller falls back to its built-in compaction path — Brigade today does
// not change behaviour, so this function returning `{fallback: true}` is
// the steady-state.
//
// The function intentionally takes the registry rather than reaching for a
// process-global so tests can inject a fresh registry per case and callers
// from the per-turn path stay explicit about where the registry came from.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrigadeConfig } from "../config/io.js";
import { PI_TEXT, PI_TOOL_RESULT } from "./pi-dialect.js";
import type { BrigadeExtensionRegistry } from "./extensions/registry.js";

export interface CompactWithSlotResolutionArgs {
  /** Messages handed to the slot-resolved compactor (caller-owned shape). */
  messages: ReadonlyArray<unknown>;
  /** 0..1 target compression ratio. Smaller = more aggressive. */
  compressionRatio: number;
  /** Extension registry — when omitted the resolver short-circuits to fallback. */
  registry?: BrigadeExtensionRegistry;
  /** Active brigade.json. The resolver reads `extensions.slots.compaction`. */
  config: BrigadeConfig;
  /** Optional abort signal passed through to the provider's summarize call. */
  signal?: AbortSignal;
}

/**
 * Resolve the active compaction provider via the slot config and call its
 * `summarize` if pinned + registered; otherwise return `{fallback: true}`
 * so the caller can fall back to the built-in head+tail truncation.
 *
 * No behaviour change today — Brigade ships no compaction-provider plugin
 * and the in-tree compactor (`smartCompactToolResults` below) remains the
 * single source of truth. This shim is the seam a future plugin slots into.
 */
export async function compactWithSlotResolution(
  args: CompactWithSlotResolutionArgs,
): Promise<string | { fallback: true }> {
  const resolved = args.registry?.resolveSlot(
    "compaction",
    args.config,
    args.registry.compactionProviders,
  );
  if (!resolved) return { fallback: true };
  return resolved.summarize({
    messages: args.messages,
    compressionRatio: args.compressionRatio,
    signal: args.signal,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier message-history compaction (folded in from src/core/smart-compaction.ts).
//
// The recommender above tells you "should we compact?". This function does
// the actual work — walks the message history, finds tool-result text blocks,
// and shrinks them in two passes:
//
//   PASS 1 — Oversized singles: any block over `maxCharsPerResult` is capped.
//   PASS 2 — Aggregate sum: if the post-pass-1 sum still exceeds the
//            aggregate budget, walk newest→oldest and shrink each by what's
//            needed, leaving a `minKeepChars` floor.
//
// When a result contains error / traceback / "FAIL" patterns,
// `preserveImportantTail` keeps the first ~60% AND the last ~40% so a
// stack trace at the bottom survives. Otherwise head-only truncation.
//
// Pure function. Caller wires it via transformContext.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SmartCompactionOptions {
  /**
   * Hard cap per individual tool-result text block. Defaults to
   * 30% of `contextWindowTokens × 4` (rough chars-per-token), then
   * capped at 16KB. Pass an explicit number to override.
   */
  maxCharsPerResult?: number;
  /**
   * Total budget across ALL tool results combined. Defaults to
   * 50% of the context window in chars, then capped at 64KB.
   */
  aggregateBudgetChars?: number;
  /** Minimum chars kept per result after truncation. Default 2000. */
  minKeepChars?: number;
  /**
   * Context window size in tokens (used to derive the defaults above).
   * Defaults to 32_000 (conservative open-source baseline) when unknown.
   */
  contextWindowTokens?: number;
  /**
   * If true, when a result contains error / traceback / "FAIL" patterns,
   * preserve the LAST ~40% of the text so the diagnostic survives. Default true.
   */
  preserveImportantTail?: boolean;
}

export interface CompactionStats {
  oversizedCount: number;
  aggregateReducibleChars: number;
  totalSavedChars: number;
}

const DEFAULT_OVERSIZED_CAP = 16_000;
const DEFAULT_AGGREGATE_CAP = 64_000;
const CHARS_PER_TOKEN_ROUGH = 4;

/**
 * Minimum reclaim before Pass 2 rewrites anything.
 *
 * Shrinking an old tool result changes the prompt PREFIX, which invalidates the
 * provider's cache — on Anthropic, trading a 10%-of-input cache read for a 125%
 * cache write. Doing that to reclaim a few hundred characters is a bad trade
 * every time. Below this threshold the transcript is left alone and allowed to
 * grow until the reclaim is worth one invalidation.
 *
 * This is what makes oldest-first eviction affordable. Cline reached the same
 * number independently (`DEFAULT_MIN_OUTDATED_REWRITE_BYTES = 65_536`,
 * "batch stale-read rewrites to avoid breaking provider prefix caches on every
 * re-read"); Hermes expresses it in tokens (`proactive_prune_min_reclaim_tokens
 * = 4096`, "to avoid breaking the provider prompt-cache prefix on every turn").
 */
const MIN_AGGREGATE_RECLAIM_CHARS = 16_000;

/**
 * Aggregate ceiling as a LADDER over the context window, not a constant.
 *
 * The old flat 64 KB meant the `ctxChars * 0.5` branch only ever bound below
 * ~32k tokens of context; at or above that the ceiling won and the budget was
 * frozen forever. On a 1M-token model the formula wanted ~2 MB and we clamped
 * to 64 KB — 3.2% of it — so past the trigger the pass was effectively "delete
 * all tool output" on exactly the models with the most room to spare.
 *
 * The ladder follows OpenClaw's shape (16K/32K/64K by window) extended upward,
 * and keeps a hard ceiling so a huge window cannot produce an unbounded
 * re-sent payload: a naive `0.5 × window` on 1M would put ~2 MB of tool output
 * on the wire every turn, which costs real money and hurts time-to-first-token
 * long before the model runs out of room. Cline's 6 MB aggregate is the other
 * extreme and is over-generous for the same reason.
 */
function aggregateCapForContext(ctxTokens: number): number {
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) return DEFAULT_AGGREGATE_CAP;
  if (ctxTokens >= 500_000) return 512_000;
  if (ctxTokens >= 200_000) return 192_000;
  if (ctxTokens >= 100_000) return 128_000;
  return DEFAULT_AGGREGATE_CAP;
}
/**
 * Sane FLOORS so the per-result and aggregate budgets never collapse to
 * effectively-zero on tiny-context models (Cerebras 8K, Groq Llama-3.1-8B
 * 8K). Without these, a 4K context window would derive a 1.2KB per-result
 * cap and a 2KB aggregate budget — every tool result would shrink to almost
 * nothing on every transformContext pass, destroying the model's working
 * memory.
 */
const MIN_OVERSIZED_CAP = 2_000;
const MIN_AGGREGATE_CAP = 4_000;
/**
 * Default context window assumption when the caller didn't pass one. We use
 * a CONSERVATIVE 32K instead of "Anthropic Sonnet's 200K" so a missing
 * value doesn't grant pathological budgets on a small model.
 */
const SAFE_DEFAULT_CONTEXT_TOKENS = 32_000;

// Wider error-tail pattern set than `IMPORTANT_TAIL_PATTERNS` above —
// includes Python tracebacks, segfault, panic, pytest summary lines.
// Both pattern sets coexist so behaviour of the older
// truncateToolResultText path is unchanged.
const ERROR_TAIL_PATTERNS = [
  /error\b/i,
  /exception\b/i,
  /traceback/i,
  /\bfail(?:ed|ure)?\b/i,
  /stack\s*trace/i,
  /\bsegfault/i,
  /panic\b/i,
  /^.*(\d+\s+passed.*\d+\s+failed)/im, // pytest-style summary
];

/**
 * Walk message history, shrinking tool-result text blocks per the two-tier
 * algorithm. Returns a new array; never mutates the input.
 *
 * Image / non-text content blocks pass through untouched (truncating base64
 * would corrupt them).
 *
 * `transformContext` callers should run this BEFORE sanitizeMessages so
 * truncation markers added here don't get a surrogate-strip pass over them.
 */
export function smartCompactToolResults(
  messages: AgentMessage[],
  options: SmartCompactionOptions = {},
): { messages: AgentMessage[]; stats: CompactionStats } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, stats: { oversizedCount: 0, aggregateReducibleChars: 0, totalSavedChars: 0 } };
  }

  // Defensive: a missing or non-positive contextWindow falls to a SAFE
  // 32K default, not the previous 200K. Otherwise an 8K-context Groq /
  // Cerebras model would inherit Anthropic-Sonnet-sized budgets and never
  // compact. Negative / zero / NaN all collapse to the safe default.
  const requestedCtx = options.contextWindowTokens;
  const ctxTokens =
    typeof requestedCtx === "number" && Number.isFinite(requestedCtx) && requestedCtx > 0
      ? requestedCtx
      : SAFE_DEFAULT_CONTEXT_TOKENS;
  const ctxChars = ctxTokens * CHARS_PER_TOKEN_ROUGH;
  // Per-result cap: 30% of context, capped at the oversized ceiling AND
  // floored at MIN_OVERSIZED_CAP so a 4K model still gets ~2KB per result
  // (enough to keep one bash output + one read result legible).
  const maxCharsPerResult =
    options.maxCharsPerResult ??
    Math.max(MIN_OVERSIZED_CAP, Math.min(Math.floor(ctxChars * 0.3), DEFAULT_OVERSIZED_CAP));
  // Aggregate: 50% of context, floored, and ceilinged by a ladder that scales
  // with the window instead of freezing at 64 KB above ~32k tokens.
  const aggregateBudget =
    options.aggregateBudgetChars ??
    Math.max(
      MIN_AGGREGATE_CAP,
      Math.min(Math.floor(ctxChars * 0.5), aggregateCapForContext(ctxTokens)),
    );
  // minKeep clamped so it can never EXCEED maxCharsPerResult — that would
  // cause Pass 2 to try to shrink a result BELOW its already-applied cap,
  // hitting an infinite "no progress" loop or, worse, growing it back.
  const requestedMinKeep = options.minKeepChars ?? 2_000;
  const minKeep = Math.min(maxCharsPerResult, Math.max(200, requestedMinKeep));
  const preserveTail = options.preserveImportantTail ?? true;

  // Find every tool-result text block with its (msgIndex, blockIndex, length).
  type Slot = { mi: number; bi: number; len: number };
  const slots: Slot[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi] as any;
    if (m?.role !== PI_TOOL_RESULT || !Array.isArray(m.content)) continue;
    for (let bi = 0; bi < m.content.length; bi++) {
      const block = m.content[bi];
      if (block?.type === PI_TEXT && typeof block.text === "string") {
        slots.push({ mi, bi, len: block.text.length });
      }
    }
  }

  if (slots.length === 0) {
    return { messages, stats: { oversizedCount: 0, aggregateReducibleChars: 0, totalSavedChars: 0 } };
  }

  // Plan reductions per slot (slot key → target length).
  const targetLength = new Map<string, number>();
  const slotKey = (s: Slot): string => `${s.mi}:${s.bi}`;

  // PASS 1 — oversized singles get capped to maxCharsPerResult.
  let oversizedCount = 0;
  for (const s of slots) {
    if (s.len > maxCharsPerResult) {
      oversizedCount++;
      targetLength.set(slotKey(s), maxCharsPerResult);
    }
  }

  // PASS 2 — aggregate. If the SUM (using post-pass-1 lengths) still exceeds
  // the aggregate budget, shrink OLDEST FIRST, protecting the most recent
  // results.
  //
  // ─────────────────────────────────────────────────────────────────────────
  // WHY OLDEST-FIRST, HAVING PREVIOUSLY BEEN NEWEST-FIRST
  // ─────────────────────────────────────────────────────────────────────────
  // Newest-first was chosen for prompt-cache stability: mutating an OLD result
  // changes the prefix and invalidates the provider's cache, while mutating
  // the tail does not. That reasoning is sound, but the accounting is wrong —
  // it pays a GUARANTEED comprehension cost on every turn (the model reasons
  // over a shredded copy of the output it just asked for, while output from the
  // top of the session survives verbatim) to avoid an OCCASIONAL cache miss.
  //
  // Every other harness surveyed — opencode, Cline, Hermes, OpenClaw, Gemini
  // CLI, DeepSeek's harness — evicts oldest-first and protects the newest.
  // Brigade was alone.
  //
  // The cache concern is handled where it belongs, by AMORTISING: see
  // `MIN_AGGREGATE_RECLAIM_CHARS` below. Cline and Hermes independently
  // arrived at the same answer (~64 KB and ~4k tokens respectively) — eat one
  // invalidation per batch of reclaimed bytes rather than one per turn.
  const lengthAfterPass1 = (s: Slot): number => targetLength.get(slotKey(s)) ?? s.len;
  let aggregate = slots.reduce((sum, s) => sum + lengthAfterPass1(s), 0);
  const aggregateReducibleChars = Math.max(0, aggregate - aggregateBudget);

  // AMORTISE THE CACHE INVALIDATION. Shrinking an old result rewrites the
  // prompt prefix, so doing it for a trivial saving buys nothing and costs a
  // full cache miss. Below this threshold, leave the transcript alone and let
  // it grow until the reclaim is worth paying for.
  const worthReclaiming = aggregateReducibleChars >= MIN_AGGREGATE_RECLAIM_CHARS;

  if (aggregate > aggregateBudget && worthReclaiming) {
    // Oldest first (lower message index first), so the newest tool output —
    // the output the model is about to reason about — is the last thing cut.
    const ordered = [...slots].sort((a, b) => a.mi - b.mi || a.bi - b.bi);
    for (const s of ordered) {
      if (aggregate <= aggregateBudget) break;
      const current = lengthAfterPass1(s);
      const reducible = Math.max(0, current - minKeep);
      if (reducible === 0) continue;
      const need = aggregate - aggregateBudget;
      const cut = Math.min(reducible, need);
      targetLength.set(slotKey(s), current - cut);
      aggregate -= cut;
    }
  }

  // Apply the plan. If no slot was changed, return the input unchanged.
  if (targetLength.size === 0) {
    return {
      messages,
      stats: { oversizedCount: 0, aggregateReducibleChars, totalSavedChars: 0 },
    };
  }

  let totalSaved = 0;
  const changedMsgIndices = new Set([...targetLength.keys()].map((k) => Number(k.split(":")[0])));
  const out = messages.map((msg, mi) => {
    if (!changedMsgIndices.has(mi)) return msg;
    const m = msg as any;
    const newContent = m.content.map((block: any, bi: number) => {
      const target = targetLength.get(`${mi}:${bi}`);
      if (target === undefined) return block;
      if (block?.type !== PI_TEXT || typeof block.text !== "string") return block;
      if (block.text.length <= target) return block;
      const original = block.text;
      // Name the tool in the marker so the elision stays recoverable.
      const producedBy = typeof m.toolName === "string" ? m.toolName : undefined;
      const truncated = preserveTail && hasErrorPattern(original)
        ? headAndTail(original, target, producedBy)
        : headOnly(original, target, producedBy);
      totalSaved += original.length - truncated.length;
      return { ...block, text: truncated };
    });
    return { ...m, content: newContent };
  });

  return {
    messages: out,
    stats: { oversizedCount, aggregateReducibleChars, totalSavedChars: totalSaved },
  };
}

/* ─────────── helpers for two-tier compaction (smartCompactToolResults) ─────────── */

function hasErrorPattern(text: string): boolean {
  // Cheap check first — only scan the LAST 4KB where errors typically live.
  const slice = text.length > 4_000 ? text.slice(-4_000) : text;
  return ERROR_TAIL_PATTERNS.some((p) => p.test(slice));
}

/** How to re-obtain what was cut, when we know which tool produced it. */
function recoveryHint(toolName?: string): string {
  const safe = safeToolName(toolName);
  return safe ? ` — re-run \`${safe}\` for the full output` : "";
}

/**
 * Never return something LONGER than what it replaces.
 *
 * A "truncation" that grows the payload is not a truncation, and the aggregate
 * `totalSavedChars` guard cannot catch it per-result — one inflated result
 * inside a batch that nets positive is still applied.
 *
 * UNREACHABLE UNDER CURRENT LIMITS, deliberately kept. Reaching it needs the
 * constructed output to exceed the ORIGINAL, i.e. `original.length` below the
 * marker's ~79 chars while simultaneously above `targetLen` — and `targetLen`
 * is floored at 200 by `resolveToolResultMaxChars`. The one input that used to
 * reach it, a 50 KB tool name inflating a 20 KB result to 52 KB, is now cut off
 * upstream by `safeToolName`'s 64-char cap.
 *
 * A mutation test cannot kill this line, and that is the point: it is a
 * last-resort assertion of an invariant the callers are supposed to maintain,
 * not a load-bearing branch. If a future caller lowers the floor or grows the
 * marker, this is what stops a silent 2.6x payload amplification from shipping
 * again. Treat it as a guard rail, and do not build behaviour on top of it.
 */
function neverGrow(original: string, truncated: string, targetLen: number): string {
  if (truncated.length <= original.length) return truncated;
  return original.slice(0, Math.max(0, Math.min(targetLen, original.length)));
}

function headOnly(text: string, targetLen: number, toolName?: string): string {
  const hint = recoveryHint(toolName);
  const marker = `\n\n⚠️ [...truncated${hint}...]\n`;
  // The suffix " (N chars removed)" is part of the output and must be paid for
  // out of the budget too, or the result overshoots `targetLen` every time —
  // which is why pass 2's aggregate target was never actually met.
  const cutNote = (n: number) => ` (${n} chars removed)`;
  const overhead = marker.length + cutNote(text.length).length;
  const head = Math.max(0, targetLen - overhead);
  const cut = text.length - head;
  return neverGrow(text, `${text.slice(0, head)}${marker}${cutNote(cut)}`, targetLen);
}

function headAndTail(text: string, targetLen: number, toolName?: string): string {
  const hint = recoveryHint(toolName);
  const marker = `\n\n⚠️ [...middle truncated, tail preserved${hint}...]\n\n`;
  // 60% head, 40% tail (after marker overhead). The "(N chars removed)" note
  // and its blank lines are output too, so they come out of the budget — not
  // doing so overshot `targetLen` on every call and left pass 2's aggregate
  // target unmet.
  const cutNote = (n: number) => `(${n} chars removed)\n\n`;
  const overhead = marker.length + cutNote(text.length).length;
  const usable = Math.max(0, targetLen - overhead);
  const headLen = Math.floor(usable * 0.6);
  const tailLen = Math.max(0, usable - headLen);
  const cut = text.length - headLen - tailLen;
  const out = `${text.slice(0, headLen)}${marker}${cutNote(cut)}${text.slice(text.length - tailLen)}`;
  return neverGrow(text, out, targetLen);
}

/* ───────────────────── compaction circuit breaker ───────────────────── */

/**
 * Stops a failing turn from compacting over and over.
 *
 * THE LOOP THIS BREAKS (observed in 1.33):
 *
 *   retrying (1/3, 2/3, 3/3) · Connection error.
 *   ✗ gave up after 3 attempts
 *   ⚡ compacting context (was 161%)…
 *   ✓ compacted · usage refreshes on the next reply
 *   ⚡ compacting context (was 161%)…          ← forever
 *
 * Two things combine. `maybeTriggerCompaction` runs once per turn attempt,
 * BEFORE the prompt — so every retry of a failing turn compacts again. And the
 * displayed percentage never moves, because the context figure is derived from
 * the last assistant `usage`, which only refreshes on a SUCCESSFUL reply. With
 * the provider unreachable there is no successful reply, so the trigger sees
 * the same over-threshold estimate every time and fires again.
 *
 * Each compaction is a real summarization call against the provider — money and
 * latency — so an unbounded loop is not merely cosmetic.
 *
 * The rule: a session may compact a bounded number of times WITHOUT a
 * successful assistant reply in between. A reply proves the context actually
 * changed and resets the budget. Beyond the bound, refuse and let the turn fail
 * honestly — a connection error is not a context-overflow problem, and no
 * amount of compaction fixes a network.
 */
export const MAX_COMPACTIONS_WITHOUT_REPLY = 2;

/**
 * How long a closed guard stays closed with nothing else changing.
 *
 * The guard exists to stop a tight compact/fail/compact loop, and that loop
 * turns over in seconds. A session still blocked minutes later is no longer in
 * that loop — the provider outage that caused it has had time to end — and
 * refusing forever would leave the session permanently unable to compact.
 *
 * Chosen so the cost of a wrong re-open is bounded — the budget of
 * `MAX_COMPACTIONS_WITHOUT_REPLY` attempts, i.e. two summarization calls, per
 * cooldown window — while the cost of never re-opening is a session that can
 * never compact again. The second is far worse.
 */
export const COMPACTION_BREAKER_COOLDOWN_MS = 5 * 60_000;

export class CompactionBreaker {
	private readonly consecutive = new Map<string, number>();
	/** When each session's guard last closed, for the cooldown. */
	private readonly closedAt = new Map<string, number>();

	constructor(
		private readonly max = MAX_COMPACTIONS_WITHOUT_REPLY,
		private readonly cooldownMs = COMPACTION_BREAKER_COOLDOWN_MS,
		private readonly now: () => number = () => Date.now(),
		private readonly maxSessions = 2048,
	) {}

	/** May this session compact right now? */
	allow(sessionKey: string): boolean {
		if ((this.consecutive.get(sessionKey) ?? 0) < this.max) return true;
		// COOLDOWN. Without one the guard can only be cleared by the thing it is
		// blocking: `trip()` closes it mid-turn, that turn then fails (the context
		// is still over), so no successful reply ever lands, so `noteReply` is
		// never called — and the session can never compact again for the lifetime
		// of the process. A guard whose only exit is the action it forbids is a
		// deadlock, not a circuit breaker.
		const since = this.closedAt.get(sessionKey);
		if (since !== undefined && this.now() - since >= this.cooldownMs) {
			this.consecutive.delete(sessionKey);
			this.closedAt.delete(sessionKey);
			return true;
		}
		return false;
	}

	/**
	 * Bound on retained sessions, oldest-touched evicted first.
	 *
	 * Entries clear on a successful reply or once the cooldown elapses — but the
	 * cooldown is only checked inside `allow()`, which is never called again for
	 * a session that has died. A long-lived gateway would therefore accumulate
	 * one entry per abandoned session for the life of the process. Evicting the
	 * oldest is safe: losing a suppression record only means the next compaction
	 * for that session is allowed, which is the correct default anyway.
	 */
	private evictIfNeeded(): void {
		while (this.consecutive.size > this.maxSessions) {
			const oldest = this.consecutive.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.consecutive.delete(oldest);
			this.closedAt.delete(oldest);
		}
	}

	/** Record that a compaction ran. */
	noteCompaction(sessionKey: string): void {
		const next = (this.consecutive.get(sessionKey) ?? 0) + 1;
		// delete+set so the map stays in touch order and eviction drops the
		// least-recently-used session, not the first one ever seen.
		this.consecutive.delete(sessionKey);
		this.consecutive.set(sessionKey, next);
		if (next >= this.max) this.closedAt.set(sessionKey, this.now());
		this.evictIfNeeded();
	}

	/**
	 * A successful assistant reply landed — the context figure will refresh, so
	 * the budget resets. This is the ONLY thing that resets it: a compaction
	 * "succeeding" proves nothing, since that is exactly what the loop did.
	 */
	noteReply(sessionKey: string): void {
		this.consecutive.delete(sessionKey);
		this.closedAt.delete(sessionKey);
	}

	/** How many compactions have run without an intervening reply. */
	count(sessionKey: string): number {
		return this.consecutive.get(sessionKey) ?? 0;
	}

	/**
	 * Open the guard immediately, without waiting out the attempt budget.
	 *
	 * Used when a compaction demonstrably reclaimed nothing: a second attempt
	 * cannot do better, so spending another summarization call to prove it is
	 * pure waste.
	 */
	trip(sessionKey: string): void {
		// delete+set, like `noteCompaction`. A bare `set` on an existing key
		// PRESERVES insertion order in a JS Map, so a tripped session kept its
		// stale LRU position and was evicted first — losing the suppression on
		// precisely the session we most wanted suppressed. Eviction is tolerable
		// for a counting guard; it is not for a `trip()`, which exists because a
		// retry is known to be useless.
		this.consecutive.delete(sessionKey);
		this.consecutive.set(sessionKey, this.max);
		this.closedAt.set(sessionKey, this.now());
		this.evictIfNeeded();
	}

	/** Drop a session's state (session deleted / gateway shutdown). */
	forget(sessionKey: string): void {
		this.consecutive.delete(sessionKey);
		this.closedAt.delete(sessionKey);
	}

	get size(): number {
		return this.consecutive.size;
	}
}

/**
 * Rough context-token estimate over a message array (chars / 4).
 *
 * Shared so the compaction TRIGGER, the tool-result tier and the gateway's
 * after-measurement all use one convention — three different estimators would
 * disagree about whether a compaction helped, which is exactly the ambiguity
 * that let a no-progress loop keep reporting success.
 */
export function estimateContextTokensFromMessages(messages: readonly unknown[]): number {
	if (!Array.isArray(messages)) return 0;
	let chars = 0;
	for (const m of messages) {
		const content = (m as { content?: unknown })?.content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const block of content) {
				const b = block as { text?: unknown; thinking?: unknown };
				if (typeof b?.text === "string") chars += b.text.length;
				if (typeof b?.thinking === "string") chars += b.thinking.length;
			}
		}
	}
	return Math.ceil(chars / 4);
}

/* ─────────────────────── compaction outcome ─────────────────────── */

/** What a compaction actually achieved. */
export interface CompactionOutcome {
	tokensBefore: number;
	tokensAfter: number;
	/** Tokens reclaimed. Never negative — a compaction that grew the context
	 *  reports 0 freed and `madeProgress: false`. */
	freedTokens: number;
	messagesBefore: number;
	messagesAfter: number;
	/** Share of the context reclaimed, 0..1. */
	freedRatio: number;
	/**
	 * Did this compaction meaningfully reduce the context?
	 *
	 * This is the honest answer to "should we try again". A compaction that
	 * reclaimed nothing has no reason to succeed on a second attempt, and
	 * repeating it is what turned a provider outage into an unbounded, paid
	 * compact/fail/compact cycle.
	 */
	madeProgress: boolean;
	/**
	 * True when the pre-compaction estimate EXCEEDED the context window — i.e.
	 * a figure above 100%. That is not a normal state: it means the estimate is
	 * stale or inflated (a cumulative usage figure being read as a context
	 * size), and it is worth saying out loud rather than rendering "161%" as if
	 * it were a measurement.
	 */
	wasOverWindow: boolean;
}

/** Below this share reclaimed, a compaction has not meaningfully helped. */
export const MIN_USEFUL_FREED_RATIO = 0.05;

export function summarizeCompactionOutcome(args: {
	tokensBefore: number;
	tokensAfter: number;
	messagesBefore: number;
	messagesAfter: number;
	contextWindowTokens?: number;
}): CompactionOutcome {
	const before = Math.max(0, Number.isFinite(args.tokensBefore) ? args.tokensBefore : 0);
	const after = Math.max(0, Number.isFinite(args.tokensAfter) ? args.tokensAfter : 0);
	const freedTokens = Math.max(0, before - after);
	const freedRatio = before > 0 ? freedTokens / before : 0;
	const window = args.contextWindowTokens;
	return {
		tokensBefore: before,
		tokensAfter: after,
		freedTokens,
		messagesBefore: args.messagesBefore,
		messagesAfter: args.messagesAfter,
		freedRatio,
		madeProgress: freedRatio >= MIN_USEFUL_FREED_RATIO,
		wasOverWindow: typeof window === "number" && window > 0 && before > window,
	};
}

/** `142 → 12 messages · freed 118k tokens (79%)`, for a log or a UI row. */
export function describeCompactionOutcome(o: CompactionOutcome): string {
	const freed =
		o.freedTokens >= 1000 ? `${(o.freedTokens / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(o.freedTokens);
	const pct = Math.round(o.freedRatio * 100);
	const core = `${o.messagesBefore} → ${o.messagesAfter} messages · freed ${freed} tokens (${pct}%)`;
	if (!o.madeProgress) return `${core} — no meaningful reduction`;
	return core;
}
