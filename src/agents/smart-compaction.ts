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
}

export interface TruncationOutcome {
  text: string;
  truncated: boolean;
  droppedChars: number;
}

export function truncateToolResultText(args: TruncateToolResultArgs): TruncationOutcome {
  const { text, maxChars } = args;
  if (typeof text !== "string" || text.length <= maxChars) {
    return { text, truncated: false, droppedChars: 0 };
  }

  // Reserve room for the truncation suffix so the suffix itself doesn't push
  // us back over the limit.
  const suffixSample = formatTruncationSuffix(text.length); // worst-case length
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
    const out = head + HEAD_TAIL_OMISSION_MARKER + tail + formatTruncationSuffix(droppedChars);
    return { text: out, truncated: true, droppedChars };
  }

  // No important tail signal: keep the head only.
  const head = text.slice(0, budget);
  const droppedChars = text.length - head.length;
  return {
    text: head + formatTruncationSuffix(droppedChars),
    truncated: true,
    droppedChars,
  };
}

export function formatTruncationSuffix(droppedChars: number): string {
  const n = Math.max(1, Math.floor(droppedChars));
  return `\n\n[… ${n} more characters truncated …]`;
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

import type { AgentMessage } from "@mariozechner/pi-agent-core";

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
  // Aggregate: 50% of context, capped + floored.
  const aggregateBudget =
    options.aggregateBudgetChars ??
    Math.max(MIN_AGGREGATE_CAP, Math.min(Math.floor(ctxChars * 0.5), DEFAULT_AGGREGATE_CAP));
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
    if (m?.role !== "toolResult" || !Array.isArray(m.content)) continue;
    for (let bi = 0; bi < m.content.length; bi++) {
      const block = m.content[bi];
      if (block?.type === "text" && typeof block.text === "string") {
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

  // PASS 2 — aggregate. If the SUM (using post-pass-1 lengths) still
  // exceeds the aggregate budget, shrink starting from NEWEST to OLDEST
  // (newer = higher mi) by the amount needed, with a minKeep floor.
  const lengthAfterPass1 = (s: Slot): number => targetLength.get(slotKey(s)) ?? s.len;
  let aggregate = slots.reduce((sum, s) => sum + lengthAfterPass1(s), 0);
  const aggregateReducibleChars = Math.max(0, aggregate - aggregateBudget);

  if (aggregate > aggregateBudget) {
    // Sort newest-first (higher message index first).
    const ordered = [...slots].sort((a, b) => b.mi - a.mi || b.bi - a.bi);
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
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      if (block.text.length <= target) return block;
      const original = block.text;
      const truncated = preserveTail && hasErrorPattern(original)
        ? headAndTail(original, target)
        : headOnly(original, target);
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

function headOnly(text: string, targetLen: number): string {
  const marker = "\n\n⚠️ [...truncated...]\n";
  const head = Math.max(0, targetLen - marker.length);
  const cut = text.length - head;
  return `${text.slice(0, head)}${marker} (${cut} chars removed)`;
}

function headAndTail(text: string, targetLen: number): string {
  const marker = "\n\n⚠️ [...middle truncated, tail preserved...]\n\n";
  // 60% head, 40% tail (after marker overhead).
  const usable = Math.max(0, targetLen - marker.length);
  const headLen = Math.floor(usable * 0.6);
  const tailLen = Math.max(0, usable - headLen);
  const cut = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}${marker}(${cut} chars removed)\n\n${text.slice(text.length - tailLen)}`;
}
