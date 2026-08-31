// Provider quirks and payload mutators.
//
// Per-provider tweaks that have to happen between Pi's message-array and the
// HTTPS body the provider expects. Pi 0.70.x exposes two relevant hook
// surfaces we can use without monkey-patching its internal streamFn:
//
//   • `transformContext(messages, signal)` — runs at the AgentMessage layer
//     before `convertToLlm`. Right place for message-level cleanup like
//     stale cache_control sweeps.
//   • `streamFn` — Pi installs an auth-aware wrapper at session creation
//     time; do NOT replace it (a Brigade-side memory captures the failure
//     mode — every provider call breaks silently). We COMPOSE on top of it
//     instead (`wrapStreamFnWithPayloadMutations` below), which gives us both
//     the outbound payload (`onPayload`) and the request `headers` field of
//     Pi's `SimpleStreamOptions` — enough for payload-shape mutations AND
//     OpenRouter app-attribution headers without any Pi fork.
//
// What ships here today: the safe message-level mutations that fit
// `transformContext`'s contract (must not throw, must return the original or
// a safe fallback), PLUS the streamFn-composed payload mutators and OpenRouter
// attribution-header injection.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { PI_TOOL_CALL, PI_TOOL_RESULT, WIRE_TOOL_RESULT } from "./pi-dialect.js";
import type { Api, Model, ProviderResponse, ThinkingLevel } from "@earendil-works/pi-ai";
import { recordLimitsFromHeaders } from "./usage/limits.js";

import { scrubAnthropicRefusalSentinel } from "./error-classifier.js";
import { sanitizeMessages } from "./sanitize-surrogates.js";
import { smartCompactToolResults } from "./smart-compaction.js";
import { sanitizeToolUseResultPairing } from "../sessions/transcript-repair.js";

// ─────────────────────────────────────────────────────────────────────────────
// History-image prune.
//
// Long sessions with screenshots or uploaded images blow up the context
// window even after the model has "seen" them. After 3 completed user→
// assistant turns, the older images can be replaced with a placeholder
// without losing meaningful context — the model already incorporated them
// into the running summary it builds on each turn.
// ─────────────────────────────────────────────────────────────────────────────

const PRESERVE_RECENT_COMPLETED_TURNS = 3;
const PRUNED_HISTORY_IMAGE_MARKER =
  "[image data removed — already processed by model in earlier turn]";

export function pruneProcessedHistoryImages<M extends AgentMessage>(messages: M[]): M[] {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  if (pruneBeforeIndex <= 0) return messages;

  let mutated = false;
  const out = messages.map((m, i) => {
    if (i >= pruneBeforeIndex) return m;
    if (!m) return m;
    const role = (m as { role?: string }).role;
    if (role !== "user" && role !== PI_TOOL_RESULT) return m;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    let blockMutated = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: string };
      if (b.type !== "image") return block;
      blockMutated = true;
      return { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER };
    });
    if (blockMutated) {
      mutated = true;
      return { ...(m as object), content: nextContent } as M;
    }
    return m;
  });
  return mutated ? out : messages;
}

function resolvePruneBeforeIndex<M extends AgentMessage>(messages: M[]): number {
  // Walk backwards counting user→assistant pairs. Once we've seen
  // PRESERVE_RECENT_COMPLETED_TURNS such pairs, return the index — every
  // message before that index is eligible for image pruning.
  let pairs = 0;
  let lastSeenRole: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = (m as { role?: string }).role;
    if (role === "assistant" && lastSeenRole !== "assistant") {
      lastSeenRole = "assistant";
    } else if (role === "user" && lastSeenRole === "assistant") {
      pairs++;
      lastSeenRole = "user";
      if (pairs >= PRESERVE_RECENT_COMPLETED_TURNS) {
        return i;
      }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic prompt cache hygiene.
//
// Anthropic enforces at most 4 cache_control breakpoints per request. If the
// transcript carries cache_control on every assistant message (because each
// turn appended one), the next turn fails with a 400 "too many cache
// breakpoints" error.
//
// The sweep walks the message array and clears cache_control from every
// content block EXCEPT the latest two: the assembled system prompt's stable
// prefix and the most-recent message tail. The system prompt's cache_control
// is set by the assembler, not us, so we leave the system message untouched
// and only sweep user/assistant turns.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CACHE_CONTROLS_KEPT_IN_TURNS = 1;

interface ContentBlockWithCacheControl {
  cache_control?: unknown;
  type?: string;
  [key: string]: unknown;
}

export function sweepStaleAnthropicCacheControl<M extends AgentMessage>(messages: M[]): M[] {
  // Walk from newest → oldest. Keep cache_control on the first
  // MAX_CACHE_CONTROLS_KEPT_IN_TURNS messages encountered (i.e. the most
  // recent ones); strip it from the rest.
  let kept = 0;
  const out: M[] = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as M;
    if (!m) continue;
    const role = (m as { role?: string }).role;
    // Don't touch the system prompt — the assembler owns its cache markers.
    if (role === "system") {
      out[i] = m;
      continue;
    }
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      out[i] = m;
      continue;
    }
    let mutated = false;
    let nextContent = content;
    if (kept < MAX_CACHE_CONTROLS_KEPT_IN_TURNS) {
      const hasCacheControl = content.some(
        (b) => b && typeof b === "object" && "cache_control" in (b as object),
      );
      if (hasCacheControl) kept++;
      out[i] = m;
      continue;
    }
    // Past the kept window — strip cache_control from every block.
    nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as ContentBlockWithCacheControl;
      if (!("cache_control" in b)) return block;
      const { cache_control: _drop, ...rest } = b;
      mutated = true;
      return rest;
    });
    out[i] = mutated ? ({ ...(m as object), content: nextContent } as M) : m;
  }
  // If the loop ran nothing was assigned for some indices (rare): backfill.
  for (let i = 0; i < messages.length; i++) {
    if (out[i] === undefined) {
      const m = messages[i];
      if (m !== undefined) out[i] = m;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic refusal-sentinel scrub on user content.
//
// The refusal magic literal is also stripped at the prompt-build site for
// fresh inputs (see agent-loop.ts). This pass catches the same literal in
// session replays where the prior transcript carried it across — Pi
// re-sends the full message history, so a poisoned earlier turn would
// otherwise re-trigger refusal indefinitely.
// ─────────────────────────────────────────────────────────────────────────────

export function scrubRefusalSentinelInTranscript<M extends AgentMessage>(messages: M[]): M[] {
  let mutated = false;
  const out = messages.map((m) => {
    if (!m) return m;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      const next = scrubAnthropicRefusalSentinel(content);
      if (next !== content) {
        mutated = true;
        return { ...(m as object), content: next } as M;
      }
      return m;
    }
    if (!Array.isArray(content)) return m;
    let blockMutated = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        const next = scrubAnthropicRefusalSentinel(b.text);
        if (next !== b.text) {
          blockMutated = true;
          return { ...b, text: next };
        }
      }
      return block;
    });
    if (blockMutated) {
      mutated = true;
      return { ...(m as object), content: nextContent } as M;
    }
    return m;
  });
  return mutated ? out : messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// composed transformContext for Pi.
//
// Plug into AgentSession's `transformContext`. The contract is "must not
// throw" — wrap each step in try/catch and fall back to the prior messages
// on any unexpected failure rather than letting the turn explode.
// ─────────────────────────────────────────────────────────────────────────────

/** Share of the window at which tool-result shrinking engages. Below this the
 *  chain is a pass-through so the prompt prefix stays byte-stable for caching. */
const TOOL_RESULT_TRIGGER_RATIO = 0.7;
/** Same chars-per-token convention the compaction trigger uses, so the two
 *  agree about when the transcript is "large". */
const APPROX_CHARS_PER_TOKEN = 4;

/** Rough token estimate over a message array. Cheap, deterministic, no I/O. */
function estimateMessagesTokens(messages: AgentMessage[]): number {
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
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

export interface BrigadeTransformContextOptions {
  // True when the active model is on Anthropic; controls whether the
  // cache_control sweep runs. Defaults to true because the sweep is a
  // safe no-op on transcripts without cache_control.
  applyAnthropicSweep?: boolean;
  // Strip image blocks from messages older than 3 completed turns. Defaults
  // to true — the prune is a safe no-op on text-only transcripts and saves
  // tens of thousands of tokens on image-heavy sessions.
  pruneOldImages?: boolean;
  // Active model for this turn. When provided, the message-level provider
  // quirks (Mistral tool-id sanitiser, OpenAI-Responses reasoning-pair
  // downgrade, Anthropic thinking-block strip) gate themselves on the model
  // so non-matching providers stay untouched. When undefined the quirks
  // run defensively (strip-everything mode) — safe but more aggressive.
  activeModel?: Model<any>;
  /**
   * Shrink oversized TOOL RESULTS once the transcript approaches the context
   * window. Off unless a context window is supplied.
   *
   * This is the cheapest compaction there is. A coding transcript is dominated
   * by tool output — file reads, command logs, search results — not by prose,
   * and truncating an old 40 KB `read` costs nothing semantically while
   * reclaiming more context than summarizing the entire conversation would.
   * `smartCompactToolResults` (two-pass, keeps the tail of anything that looks
   * like an error so stack traces survive) has existed and been unwired.
   *
   * GATED ON THRESHOLD, deliberately. Running it on every request would
   * re-shrink older results as newer ones consume the aggregate budget, so the
   * prompt prefix would differ turn to turn and invalidate prompt caching — on
   * Anthropic that trades a 10%-of-input cache read for a 125% cache write,
   * every turn. Below the threshold this is a pass-through and the prefix is
   * byte-stable; above it, we were about to pay for a summarization anyway and
   * the cache is lost regardless.
   */
  toolResultContextWindow?: number;
  /** Fraction of the window at which tool-result shrinking engages. */
  toolResultTriggerRatio?: number;
  /**
   * MID-TURN COMPACTION — pause, compact, continue.
   *
   * Built by `createMidTurnCompactor` and supplied by the caller, which owns
   * the model/auth plumbing the summarization needs. Absent by default: a turn
   * with no compactor behaves exactly as it did before.
   *
   * Runs AFTER the tool-result shrink, deliberately. Truncating an old 40 KB
   * `read` is free and often enough on its own; a summarization costs a model
   * call and several seconds. Cheapest reduction first, and the summarizer
   * only sees history the free pass could not fix.
   *
   * It never throws and never returns fewer messages than it was given on any
   * failure path, so the worst case is the behaviour without it.
   */
  midTurnCompactor?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
}

export interface BrigadeTransformContextHooks {
  // Notified once per turn if the transcript-pairing repair had to act.
  // Useful for surfacing "we synthesised N missing tool_result blocks" up
  // through the loop's logger.
  onTranscriptRepaired?: (info: {
    syntheticToolResultsAdded: number;
    orphanedToolResultsDropped: number;
    unmatchedToolUseIds: string[];
  }) => void;
}

export function buildBrigadeTransformContext(
  options: BrigadeTransformContextOptions = {},
  hooks: BrigadeTransformContextHooks = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const applyAnthropicSweep = options.applyAnthropicSweep ?? true;
  const pruneOldImages = options.pruneOldImages ?? true;
  // The signal is Pi's per-request AbortSignal. It was declared in the return
  // type and then dropped on the floor; mid-turn compaction is the first pass
  // that can BLOCK, so it is the first one that has to honour a Ctrl+C.
  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    let working = messages;
    try {
      working = scrubRefusalSentinelInTranscript(working);
    } catch {
      // safe fallback per Pi contract
    }
    // Transcript-level pairing repair runs BEFORE image prune and cache
    // sweep so any synthesised tool_result blocks are themselves swept by
    // those passes. Critical for power-loss recovery: an orphan tool_use
    // (valid JSON but no matching tool_result on disk) survives the
    // file-level repair and would otherwise crash Pi on the next request.
    try {
      const repair = sanitizeToolUseResultPairing(working as unknown as { role: string; content?: unknown }[]);
      if (repair.report.mutated && hooks.onTranscriptRepaired) {
        hooks.onTranscriptRepaired({
          syntheticToolResultsAdded: repair.report.syntheticToolResultsAdded,
          orphanedToolResultsDropped: repair.report.orphanedToolResultsDropped,
          unmatchedToolUseIds: repair.report.unmatchedToolUseIds,
        });
      }
      working = repair.messages as unknown as AgentMessage[];
    } catch {
      // safe fallback
    }
    if (pruneOldImages) {
      try {
        working = pruneProcessedHistoryImages(working);
      } catch {
        // safe fallback
      }
    }
    if (applyAnthropicSweep) {
      try {
        working = sweepStaleAnthropicCacheControl(working);
      } catch {
        // safe fallback per Pi contract
      }
    }
    // Message-level provider quirks. Each pass is a pure function over the
    // message array and gated on the active model — safe no-op when the
    // provider doesn't match. Order:
    //   - dropAnthropicThinkingBlocks: strip stale thinking from history,
    //     preserving the latest assistant's thinking ONLY on Anthropic for
    //     prompt-cache continuity.
    //   - sanitizeMistralToolCallIds: rewrite toolu_/call_ ids to Mistral's
    //     9-char format when active model is Mistral.
    //   - downgradeOpenAIResponsesReasoningPairs: drop thinking from any
    //     assistant message that ALSO carries a toolCall, when active model
    //     uses OpenAI's Responses API.
    // Tool-result shrink, BEFORE the provider quirks so their passes see the
    // already-reduced payload. Engages only near the window (see the option's
    // comment on prompt-cache stability).
    const trWindow = options.toolResultContextWindow;
    if (typeof trWindow === "number" && Number.isFinite(trWindow) && trWindow > 0) {
      try {
        const ratio = options.toolResultTriggerRatio ?? TOOL_RESULT_TRIGGER_RATIO;
        const approxTokens = estimateMessagesTokens(working);
        if (approxTokens >= trWindow * ratio) {
          const shrunk = smartCompactToolResults(working, { contextWindowTokens: trWindow });
          if (shrunk.stats.totalSavedChars > 0) working = shrunk.messages;
        }
      } catch {
        // safe fallback per Pi contract
      }
    }
    // MID-TURN COMPACTION. The free reduction above has already run; if the
    // transcript is STILL over the trigger, summarize the older prefix and
    // continue the turn rather than sending a request we know will be rejected.
    //
    // This is the only pass here that can block, and it blocks at most once per
    // turn — the compactor caches its result and reuses it for the rest of the
    // tool loop. Wrapped like every other pass: on any failure `working` is
    // untouched and the turn proceeds exactly as it would have.
    if (options.midTurnCompactor) {
      try {
        const reduced = await options.midTurnCompactor(working, signal);
        if (Array.isArray(reduced) && reduced.length > 0) working = reduced;
      } catch {
        // safe fallback per Pi contract — the compactor is not supposed to
        // throw, but a transform that takes down the turn is the one outcome
        // worse than not compacting.
      }
    }
    try {
      working = dropAnthropicThinkingBlocks(working, options.activeModel);
    } catch {
      // safe fallback
    }
    if (isMistralModel(options.activeModel)) {
      try {
        working = sanitizeMistralToolCallIds(working);
      } catch {
        // safe fallback
      }
    }
    if (isOpenAIResponsesModel(options.activeModel)) {
      try {
        working = downgradeOpenAIResponsesReasoningPairs(working);
      } catch {
        // safe fallback
      }
    }
    // Surrogate sanitization runs LAST so any text written by earlier
    // passes (synthesised tool_result blocks, etc.) is also cleaned.
    // Lone UTF-16 surrogate halves crash Anthropic / OpenAI intake with
    // 400 "Invalid Unicode escape"; the most common source is bash tool
    // output that was tail-truncated mid-codepoint. Two-pass strip; only
    // unpaired halves removed, valid surrogate pairs preserved.
    try {
      working = sanitizeMessages(working);
    } catch {
      // safe fallback per Pi contract
    }
    return working;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-shape mutations that need outbound-HTTP access.
//
// These are documented as the next layer of the quirks pack. They do NOT
// run today because Pi 0.70.x doesn't expose a public `wrapStreamFn` and
// overwriting `session.agent.streamFn` would break Pi's auth-aware wrapper.
// When the wiring lands (either via a Pi PR or a Brigade-side gateway
// proxy), the implementations below plug in unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Historic compatibility marker. The `parked` items below have all been
 * unparked — the streamFn wrap landed via `wrapStreamFnWithPayloadMutations`
 * (folded in below from `src/core/provider-payload-mutators.ts` on 2026-05-08).
 * Keeping the constant exported because external code may have referenced it.
 */
export const PROVIDER_QUIRKS_PARKED = {
  openrouterCacheHeaders: "shipped: applyAnthropicSystemCacheHints",
  geminiThinkingExtract: "shipped: sanitizeGeminiThinkingPayload",
  siliconflowReasoningRemap: "shipped: normalizeSiliconFlowThinking",
  minimaxFastModeSwitch: "shipped: disableMinimaxThinking",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE-LEVEL PROVIDER QUIRKS (folded in from src/core/provider-quirks.ts).
//
// Each fix is a pure function over `AgentMessage[]`, gated on the active
// model so we don't pessimize providers that don't need them. Wired via
// `buildAgent`'s `transformContext` chain. The chain runs every LLM call
// so the fixes apply to BOTH initial requests and resumed sessions.
//
// Quirks:
//   1. dropAnthropicThinkingBlocks       — strip stale thinking blocks in history
//   2. sanitizeMistralToolCallIds        — rewrite IDs to Mistral's 9-char format
//   3. downgradeOpenAIResponsesPairs     — drop thinking when paired with toolCall
//   4. decodeXaiToolCallArgs (factory)   — decode HTML entities in xAI tool args
//
// All previously lived in `src/core/provider-quirks.ts`; folded here so a
// single file is the source of truth for provider-side mutations.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { CACHE_BOUNDARY_MARKER } from "../system-prompt/cache-boundary.js";
import { resolveOpenRouterAttributionHeaders } from "./provider-attribution.js";

/* ─────────────────────────── 1. Strip stale thinking blocks ─────────────────────────── */

/**
 * Strip `thinking` content blocks from assistant messages in history.
 * Always-on defensive cleanup with one nuance:
 *
 *   - When the ACTIVE model is Anthropic-compatible, the LATEST assistant
 *     message keeps its thinking block — Anthropic uses the signature for
 *     prompt-cache continuity on the next turn.
 *   - For every other active model (Gemini, OpenAI, Mistral, etc.) we strip
 *     ALL thinking blocks. They have no continuity reason to keep them and
 *     would otherwise reject `{type:"thinking"}` as an unknown content type.
 *
 * `activeModel` is optional — passing `undefined` means "I don't know the
 * provider; strip everything to be safe." That's the correct default if
 * the caller can't reach session.model for any reason.
 *
 * The cross-provider strip (vs. unconditional Anthropic-shaped strip) is
 * what makes mid-conversation /model switches work cleanly.
 */
export function dropAnthropicThinkingBlocks(
  messages: AgentMessage[],
  activeModel?: Model<any>,
): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Only preserve the latest assistant's thinking when the active model is
  // Anthropic-flavored (cache continuity matters). For any other model
  // — including no model at all — strip every thinking block.
  const anthropicLike = isAnthropicLikeModel(activeModel);
  const preserveLatestIdx = anthropicLike ? findLastAssistantIndex(messages) : -1;

  let touched = false;
  const out = messages.map((msg, i) => {
    const m = msg as any;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return msg;
    if (i === preserveLatestIdx) return msg; // preserve the last one for Anthropic cache
    // KEEP SIGNED THINKING FOR THE SAME PROVIDER, wherever it sits.
    //
    // Anthropic's interleaved-thinking beta is ON by default in Pi
    // (`anthropic.js:326`, `options?.interleavedThinking ?? true`) and requires
    // thinking blocks to be passed back across every step of a tool loop. Pi's
    // own converter honours that — it keeps any block carrying a
    // `thinkingSignature` for the same model, "needed for replay"
    // (`transform-messages.js:75-78`) — and a `redacted` block stores its
    // opaque payload in the same field for multi-turn continuity.
    //
    // Stripping everything but the LAST assistant therefore diverged from Pi
    // the moment this chain went live: a 3-iteration tool loop went out with
    // the first two turns' signed thinking removed. Unsigned blocks are still
    // dropped — they carry no replay value and other providers reject them.
    const filtered = m.content.filter((b: any) => {
      if (b?.type !== "thinking") return true;
      // A SIGNED block is kept for EVERY provider, not just Anthropic.
      //
      // The signature is the provider's own replay handle and Pi knows what to
      // do with each: OpenAI Responses parses it back into the `{type:
      // "reasoning", encrypted_content}` item the API requires alongside a
      // `function_call`; openai-completions replays it as `reasoning_content`;
      // cross-model, Pi converts thinking to plain text so the reasoning
      // survives as prose. Pi's `transformMessages` runs AFTER this chain, so
      // stripping here destroys information it was about to use correctly.
      //
      // This pass previously dropped every thinking block on every
      // non-Anthropic provider. That was harmless only because the chain never
      // executed; making it live turned it into a real regression — on the
      // Responses API a `function_call` whose paired reasoning item is missing
      // is the "provided without its required following item" class of 400.
      //
      // Unsigned blocks are still dropped: they carry no replay value, and a
      // provider that does not understand `{type:"thinking"}` rejects them.
      return typeof b.thinkingSignature === "string" && b.thinkingSignature !== "";
    });
    if (filtered.length === m.content.length) return msg; // nothing changed
    touched = true;
    // Anthropic rejects an assistant message with EMPTY content too.
    // Replace with a single empty text block if dropping thinking left
    // the message bare.
    const content = filtered.length > 0 ? filtered : [{ type: "text", text: "" }];
    return { ...m, content };
  });

  return touched ? out : messages;
}

function findLastAssistantIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role === "assistant" && Array.isArray(m.content)) return i;
  }
  return -1;
}

/** Whether the active model is Anthropic-flavored (direct, Bedrock, Vertex, OpenRouter→Anthropic). */
export function isAnthropicLikeModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  const api = (model.api ?? "").toLowerCase();
  if (provider === "anthropic") return true;
  if (api === "anthropic-messages") return true;
  if (provider === "openrouter" && /claude|anthropic/i.test(model.id ?? "")) return true;
  if (provider === "bedrock" || provider === "vertex") return /claude|anthropic/i.test(model.id ?? "");
  return false;
}

/* ─────────────────────────── 2. Mistral tool-call ID format ─────────────────────────── */

/**
 * Mistral's tool-call API requires IDs matching `[a-zA-Z0-9]{9}` exactly.
 * Pi/Anthropic emit `toolu_01a2b3c...` (longer, with underscores); OpenAI
 * emits `call_xyz...`. Mistral rejects both.
 *
 * The fix: rewrite IDs in BOTH the assistant's `toolCall` blocks AND the
 * matching `toolResult` messages, keeping the mapping consistent within
 * a single transformContext pass.
 *
 * The 9-char ID is generated deterministically from the original ID so the
 * mapping is stable across re-sends — same input, same output.
 */
export function sanitizeMistralToolCallIds(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const idMap = new Map<string, string>();
  const mapId = (orig: string): string => {
    const cached = idMap.get(orig);
    if (cached) return cached;
    // Deterministic 9-char id derived from the original. Hash → base36 → pad/slice.
    let h = 0;
    for (let i = 0; i < orig.length; i++) {
      h = ((h << 5) - h + orig.charCodeAt(i)) | 0;
    }
    const positive = h < 0 ? h + 0x80000000 : h;
    const id = positive.toString(36).padStart(9, "0").slice(-9);
    idMap.set(orig, id);
    return id;
  };

  const valid = /^[a-zA-Z0-9]{9}$/;

  let touched = false;
  const out = messages.map((msg) => {
    const m = msg as any;

    // toolResult messages carry the id at the message level.
    if (m?.role === PI_TOOL_RESULT && typeof m.toolCallId === "string" && !valid.test(m.toolCallId)) {
      touched = true;
      return { ...m, toolCallId: mapId(m.toolCallId) };
    }

    // Assistant messages may carry toolCall blocks with ids inside content.
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      let blockTouched = false;
      const newContent = m.content.map((block: any) => {
        if (block?.type === PI_TOOL_CALL && typeof block.id === "string" && !valid.test(block.id)) {
          blockTouched = true;
          return { ...block, id: mapId(block.id) };
        }
        return block;
      });
      if (blockTouched) {
        touched = true;
        return { ...m, content: newContent };
      }
    }
    return msg;
  });

  return touched ? out : messages;
}

/** Whether the active model is Mistral. */
export function isMistralModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "mistral" || provider === "mistralai") return true;
  if (provider === "openrouter" && /mistral|mixtral|codestral/i.test(model.id ?? "")) return true;
  return false;
}

/* ─────────────────────────── 3. OpenAI Responses API downgrade ─────────────────────────── */

/**
 * OpenAI's Responses API rejects assistant messages that contain BOTH a
 * reasoning block AND a function_call (tool_call) in the same message.
 *
 * The full fix is to strip the reasoning signature from the toolCall id
 * (the `fc_` prefix that pairs it with the reasoning) so OpenAI accepts
 * the call alone.
 *
 * Simpler approximation here: when a message has BOTH thinking AND toolCall,
 * drop the thinking block (the reasoning is gone, but the tool call lives).
 * This costs cache continuity but unblocks the call. Acceptable trade for v1.
 */
export function downgradeOpenAIResponsesReasoningPairs(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  let touched = false;
  const out = messages.map((msg) => {
    const m = msg as any;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return msg;
    const hasThinking = m.content.some((b: any) => b?.type === "thinking");
    const hasToolCall = m.content.some((b: any) => b?.type === PI_TOOL_CALL);
    if (!hasThinking || !hasToolCall) return msg;
    touched = true;
    const filtered = m.content.filter((b: any) => b?.type !== "thinking");
    const content = filtered.length > 0 ? filtered : [{ type: "text", text: "" }];
    return { ...m, content };
  });

  return touched ? out : messages;
}

/** Whether the active model uses OpenAI's Responses API. */
export function isOpenAIResponsesModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  const api = (model.api ?? "").toLowerCase();
  if (api === "openai-responses" || api === "responses") return true;
  // Models whose ids hint at the Responses API (o1, o3 reasoning models route through it).
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "openai" && /^o[13](?:-|$)/i.test(model.id ?? "")) return true;
  return false;
}

/* ─────────────────────────── 4. xAI tool-call argument decode ─────────────────────────── */

const HTML_ENTITY_MAP: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const HTML_NUMERIC_HEX = /&#x([0-9a-fA-F]+);/g;
const HTML_NUMERIC_DEC = /&#(\d+);/g;
const HTML_NAMED = /&(?:quot|amp|lt|gt|apos|nbsp|#39);/g;

/**
 * Decode HTML entities from a single string. Only fires when the input
 * actually contains entities — the no-entity fast path returns the input
 * unchanged with no allocations.
 */
export function decodeHtmlEntities(s: string): string {
  if (typeof s !== "string" || s.indexOf("&") < 0) return s;
  let out = s.replace(HTML_NAMED, (m) => HTML_ENTITY_MAP[m] ?? m);
  out = out.replace(HTML_NUMERIC_HEX, (_m, hex) => {
    const code = parseInt(hex as string, 16);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m;
  });
  out = out.replace(HTML_NUMERIC_DEC, (_m, dec) => {
    const code = parseInt(dec as string, 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m;
  });
  return out;
}

/** Recursively decode every string value in a tool-args object. */
export function decodeXaiToolCallArgs<T>(args: T): T {
  if (typeof args === "string") return decodeHtmlEntities(args) as any;
  if (Array.isArray(args)) return args.map((v) => decodeXaiToolCallArgs(v)) as any;
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = decodeXaiToolCallArgs(v);
    }
    return out as any;
  }
  return args;
}

/** Whether the active model is xAI / Grok (or routed via OpenRouter to Grok). */
export function isXaiModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "xai" || provider === "x-ai") return true;
  if (provider === "openrouter" && /grok|xai|x-ai/i.test(model.id ?? "")) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD-LEVEL PROVIDER MUTATORS (folded in from src/core/provider-payload-mutators.ts).
//
// Fire INSIDE Pi's `onPayload` hook to mutate the assembled provider-specific
// JSON right before it ships over HTTP.
//
// Pi's wrapping order is:
//   session.prompt → Pi's auth wrapper → provider adapter → buildPayload
//      → options.onPayload?.(payload, model)         ← we hook here
//      → HTTP request
//
// We wrap `session.agent.streamFn` (preserving Pi's existing auth wrapper)
// to inject our own `onPayload` callback. The callback delegates to any
// caller-supplied `onPayload` first, then walks the provider mutators in
// order. Each mutator is a pure-ish function gated on the active model;
// no-ops when the provider doesn't match.
//
// Four payload quirks are handled here:
//   - Anthropic system-prompt cache hints (with BRIGADE_CACHE_BOUNDARY split)
//   - Universal cache-boundary marker strip (every provider)
//   - Google Gemini thinking-config payload reformat (Pi's level → Google's enum)
//   - SiliconFlow `thinking: "off"` → `thinking: null` swap
//   - Minimax force-disable thinking (Anthropic-shaped Messages endpoint)
//
// NOT a replacement for Pi's auth wrapper — strictly additive. The wrapped
// streamFn calls `originalStreamFn(model, context, options)` underneath.
// ─────────────────────────────────────────────────────────────────────────────

/* ─────────────────────────── 5. Anthropic system-prompt cache hints ─────────────────────────── */

/**
 * Apply Anthropic prompt-cache markers to the system field. Three cases:
 *
 *   A. SYSTEM PROMPT CONTAINS CACHE_BOUNDARY_MARKER
 *      Split the system text at the marker into two `{ type: "text" }`
 *      blocks. Apply `cache_control: { type: "ephemeral" }` to the FIRST
 *      block only (the static prefix). The SECOND block (dynamic suffix —
 *      runtime info, model id, etc.) gets no marker, so it doesn't break
 *      the cache when it varies per turn.
 *
 *   B. NO MARKER, SYSTEM IS A STRING
 *      Convert to a single text block WITH cache_control. Whole prompt is
 *      cached. (This is the legacy behavior of `applyOpenRouterAnthropicCacheHints`.)
 *
 *   C. NO MARKER, SYSTEM IS ALREADY AN ARRAY
 *      Mark the last text block with cache_control. (Same legacy behavior.)
 *
 * Then mark the LAST USER MESSAGE'S last content block with cache_control
 * — this is the second of Anthropic's up-to-4 breakpoints (we use 2: system
 * prefix + last user message).
 *
 * Only fires when `isAnthropicFlavored(model)` — direct Anthropic, OpenRouter
 * routing to Claude, Anthropic-compat APIs (Bedrock, Vertex, Minimax). For
 * non-Anthropic providers, see `stripCacheBoundaryFromPayload` below — the
 * marker is stripped so the model never sees it.
 */
export function applyAnthropicSystemCacheHints(payload: unknown, model: Model<any>): void {
  if (!isAnthropicFlavored(model)) return;
  if (!payload || typeof payload !== "object") return;

  const p = payload as any;
  const cacheMarker = { type: "ephemeral" } as const;

  applyCacheToSystem(p, cacheMarker);
  applyCacheToLastUserMessage(p, cacheMarker);
}

function applyCacheToSystem(payload: any, cacheMarker: { type: "ephemeral" }): void {
  if (typeof payload.system === "string") {
    payload.system = splitOrWrap(payload.system, cacheMarker);
    return;
  }
  if (Array.isArray(payload.system)) {
    payload.system = applyCacheToBlocks(payload.system, cacheMarker);
    return;
  }
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (msg?.role !== "system" && msg?.role !== "developer") continue;
    if (typeof msg.content === "string") {
      msg.content = splitOrWrap(msg.content, cacheMarker);
    } else if (Array.isArray(msg.content)) {
      msg.content = applyCacheToBlocks(msg.content, cacheMarker);
    }
  }
}

function splitOrWrap(
  text: string,
  cacheMarker: { type: "ephemeral" },
): Array<{ type: string; text: string; cache_control?: { type: "ephemeral" } }> {
  const idx = text.indexOf(CACHE_BOUNDARY_MARKER);
  if (idx === -1) {
    return [{ type: "text", text, cache_control: cacheMarker }];
  }
  const stablePrefix = text.slice(0, idx).replace(/\s+$/, "");
  const dynamicSuffix = text.slice(idx + CACHE_BOUNDARY_MARKER.length).replace(/^\s+/, "");
  const blocks: Array<{ type: string; text: string; cache_control?: { type: "ephemeral" } }> = [];
  if (stablePrefix.length > 0) {
    blocks.push({ type: "text", text: stablePrefix, cache_control: cacheMarker });
  }
  if (dynamicSuffix.length > 0) {
    blocks.push({ type: "text", text: dynamicSuffix });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function applyCacheToBlocks(
  blocks: any[],
  cacheMarker: { type: "ephemeral" },
): any[] {
  let foundBoundary = false;
  const result: any[] = [];
  for (const block of blocks) {
    if (
      !foundBoundary &&
      block &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.includes(CACHE_BOUNDARY_MARKER)
    ) {
      const split = splitOrWrap(block.text, cacheMarker);
      for (const newBlock of split) {
        const merged: any = { ...block, ...newBlock };
        if (newBlock.cache_control === undefined) {
          delete merged.cache_control;
        }
        result.push(merged);
      }
      foundBoundary = true;
    } else {
      result.push(block);
    }
  }

  if (!foundBoundary) {
    for (let i = result.length - 1; i >= 0; i--) {
      const block = result[i];
      if (block && typeof block === "object" && block.type !== "thinking") {
        if (block.cache_control === undefined) {
          block.cache_control = cacheMarker;
        }
        break;
      }
    }
  }

  return result;
}

function applyCacheToLastUserMessage(payload: any, cacheMarker: { type: "ephemeral" }): void {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Sweep: clear cache_control from EVERY user/tool_result block in EVERY
  // message except the last one. Prevents the 4-breakpoint cap from being
  // exceeded as conversations grow.
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block.type === "text" ||
          block.type === "image" ||
          block.type === WIRE_TOOL_RESULT) &&
        block.cache_control !== undefined
      ) {
        delete block.cache_control;
      }
    }
  }

  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object" || last.role !== "user") return;

  if (Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1];
    if (
      lastBlock &&
      typeof lastBlock === "object" &&
      (lastBlock.type === "text" ||
        lastBlock.type === "image" ||
        lastBlock.type === WIRE_TOOL_RESULT)
    ) {
      if (lastBlock.cache_control === undefined) {
        lastBlock.cache_control = cacheMarker;
      }
    }
  } else if (typeof last.content === "string") {
    last.content = [
      { type: "text", text: last.content, cache_control: cacheMarker },
    ];
  }
}

/**
 * Whether the model is Anthropic-flavored — direct Anthropic, OpenRouter→
 * Claude, or any provider whose API field is `anthropic-messages`. Used to
 * gate `applyAnthropicSystemCacheHints`. Wider than `isAnthropicLikeModel`
 * above (also matches `api === "anthropic"` and Minimax-as-Anthropic).
 */
export function isAnthropicFlavored(model: Model<any>): boolean {
  if (!model) return false;
  const api = (model.api ?? "").toLowerCase();
  if (api === "anthropic" || api === "anthropic-messages") return true;
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "anthropic") return true;
  if (provider === "minimax" && api === "anthropic-messages") return true;
  if (provider === "openrouter" && /(?:^|\/)(?:anthropic|claude)/i.test(model.id ?? "")) {
    return true;
  }
  if (provider === "bedrock" || provider === "vertex") {
    return /claude|anthropic/i.test(model.id ?? "");
  }
  return false;
}

/**
 * Backwards-compat aliases. The old names (`isOpenRouterAnthropic`,
 * `applyOpenRouterAnthropicCacheHints`) are too narrow now that the cache
 * mutator handles direct Anthropic + Bedrock + Vertex + Minimax too. Kept
 * exported under the old names so external callers continue to compile.
 *
 * @deprecated use `isAnthropicFlavored` / `applyAnthropicSystemCacheHints`.
 */
export const isOpenRouterAnthropic = isAnthropicFlavored;
export const applyOpenRouterAnthropicCacheHints = applyAnthropicSystemCacheHints;

/**
 * Strip the CACHE_BOUNDARY_MARKER from any system field. Universal pre-pass —
 * runs for ALL providers (Anthropic too) so the marker never escapes
 * Brigade. For Anthropic, the marker has already been used by
 * `applyAnthropicSystemCacheHints` to split the prompt; stripping leftovers
 * is defensive in case the splitter missed one. For non-Anthropic providers,
 * this is the ONLY thing that touches the system field.
 */
export function stripCacheBoundaryFromPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as any;

  if (typeof p.system === "string") {
    p.system = p.system.split(CACHE_BOUNDARY_MARKER).join("\n").trim();
  } else if (Array.isArray(p.system)) {
    for (const block of p.system) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        block.text = block.text.split(CACHE_BOUNDARY_MARKER).join("\n").trim();
      }
    }
  }

  const messages = p.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg?.role !== "system" && msg?.role !== "developer") continue;
      if (typeof msg.content === "string") {
        msg.content = msg.content.split(CACHE_BOUNDARY_MARKER).join("\n").trim();
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && typeof block.text === "string") {
            block.text = block.text.split(CACHE_BOUNDARY_MARKER).join("\n").trim();
          }
        }
      }
    }
  }
}

/* ─────────────────────────── 6. Google Gemini thinking payload ─────────────────────────── */

export function sanitizeGeminiThinkingPayload(payload: unknown, model: Model<any>): void {
  if (!isGoogleGeminiModel(model)) return;
  if (!payload || typeof payload !== "object") return;

  const cfg = (payload as any).config;
  if (!cfg || typeof cfg !== "object") return;
  const tc = cfg.thinkingConfig;
  if (!tc || typeof tc !== "object") return;

  const raw = tc.thinkingLevel ?? tc.thinking_level;
  if (typeof raw !== "string") return;

  const mapped = mapPiThinkingToGemini(raw as ThinkingLevel | string);
  if (mapped === undefined) {
    delete cfg.thinkingConfig;
    return;
  }
  tc.thinkingLevel = mapped;
  if ("thinking_level" in tc) tc.thinking_level = mapped;
}

function mapPiThinkingToGemini(level: string): string | undefined {
  switch (level.toLowerCase()) {
    case "off":
      return undefined;
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

export function isGoogleGeminiModel(model: Model<any>): boolean {
  if (!model) return false;
  const api = (model.api ?? "").toLowerCase();
  if (api === "google-generative-ai" || api === "google-gemini" || api === "google") return true;
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "google" || provider === "gemini" || provider === "google-vertex" || provider === "vertex") {
    return true;
  }
  if (provider === "openrouter" && /gemini|google/i.test(model.id ?? "")) return true;
  return false;
}

/* ─────────────────────────── 7. SiliconFlow thinking-off normalization ─────────────────────────── */

export function normalizeSiliconFlowThinking(payload: unknown, model: Model<any>): void {
  if (!isSiliconFlowModel(model)) return;
  if (!payload || typeof payload !== "object") return;
  const p = payload as any;
  if (p.thinking === "off") {
    p.thinking = null;
  }
}

export function isSiliconFlowModel(model: Model<any>): boolean {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "siliconflow" || provider === "silicon-flow") return true;
  const baseUrl = (model as any).baseUrl ?? "";
  if (typeof baseUrl === "string" && /siliconflow/i.test(baseUrl)) return true;
  return false;
}

/* ─────────────────────────── 8. Minimax force-disable thinking ─────────────────────────── */

export function disableMinimaxThinking(payload: unknown, model: Model<any>): void {
  if (!isMinimaxAnthropicModel(model)) return;
  if (!payload || typeof payload !== "object") return;
  const p = payload as any;
  if (p.thinking === undefined) {
    p.thinking = { type: "disabled" };
  }
}

export function isMinimaxAnthropicModel(model: Model<any>): boolean {
  if (!model) return false;
  const api = (model.api ?? "").toLowerCase();
  if (api !== "anthropic-messages" && api !== "anthropic") return false;
  const provider = (model.provider ?? "").toLowerCase();
  return provider === "minimax" || provider === "minimax-portal";
}

/* ─────────────────────────── composition ─────────────────────────── */

/**
 * Run every applicable mutator against the payload. Each mutator self-gates
 * on the active model — no-ops when the provider doesn't match — so calling
 * `applyAll` for every request is cheap.
 *
 * Order matters:
 *   1. Anthropic system-prompt cache hints — splits at the boundary marker
 *      and applies cache_control. Must run BEFORE the universal strip.
 *   2. Universal boundary strip — removes any leftover marker so it never
 *      reaches the model regardless of provider.
 *   3. Provider-specific mutators (Gemini thinking, SiliconFlow, Minimax) —
 *      operate on fields other than `system`, no ordering interaction with
 *      the cache work above.
 */
export function applyAllPayloadMutations(payload: unknown, model: Model<any>): void {
  if (!model || !payload) return;
  applyAnthropicSystemCacheHints(payload, model);
  stripCacheBoundaryFromPayload(payload);
  sanitizeGeminiThinkingPayload(payload, model);
  normalizeSiliconFlowThinking(payload, model);
  disableMinimaxThinking(payload, model);
}

/**
 * Wrap `session.agent.streamFn` so every request gets `applyAllPayloadMutations`
 * fired against its assembled payload.
 *
 * SAFE TO CALL ONCE per session — preserves Pi's existing auth-aware streamFn
 * by composing on top of it.
 */
export function wrapStreamFnWithPayloadMutations(session: AgentSession): void {
  const original = session.agent.streamFn as StreamFn | undefined;
  if (!original) return;

  const wrapped: StreamFn = (model, context, options) => {
    const userOnPayload = options?.onPayload;
    const userOnResponse = options?.onResponse;
    // OpenRouter app attribution: when (and only when) this request routes
    // through OpenRouter, merge Brigade's HTTP-Referer / X-OpenRouter-Title
    // headers into Pi's `SimpleStreamOptions.headers`. Caller-supplied headers
    // win (last-wins precedence) so an
    // explicit override is never clobbered. Non-OpenRouter providers get
    // `undefined` back and are left untouched.
    const attribution = resolveOpenRouterAttributionHeaders(model);
    const callerHeaders =
      options && typeof options.headers === "object" && options.headers
        ? (options.headers as Record<string, string>)
        : undefined;
    const mergedHeaders =
      attribution || callerHeaders
        ? { ...(attribution ?? {}), ...(callerHeaders ?? {}) }
        : undefined;
    const augmented = {
      ...(options ?? {}),
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      onPayload: async (payload: unknown, m: Model<Api>) => {
        const userResult = userOnPayload ? await userOnPayload(payload, m) : undefined;
        const next = userResult !== undefined ? userResult : payload;
        applyAllPayloadMutations(next, m);
        return next;
      },
      // RATE-LIMIT HEADERS, FOR EVERY PROVIDER.
      //
      // Pi hands back `ProviderResponse { status, headers }` on every provider
      // call (`pi-ai types.d.ts:64`), and EVERY backend Pi drives goes through
      // this one `streamFn`. So observing here — rather than in any single
      // provider's adapter — is what makes "how much have I got left?"
      // provider-agnostic instead of an Anthropic-only feature.
      //
      // `recordLimitsFromHeaders` already reads both conventions in use
      // (`anthropic-ratelimit-*` and `x-ratelimit-*`) and skips absent families
      // rather than recording them as zero, because "no data" and "none left"
      // are opposites and a UI must never confuse them.
      //
      // Strictly an observer: it reads headers, records, and returns. It never
      // alters the response, and it is wrapped so a malformed header can never
      // take down a turn — telemetry must not be able to break the request it
      // is describing.
      onResponse: async (response: ProviderResponse, m: Model<Api>) => {
        try {
          if (response && typeof response === "object" && response.headers) {
            const provider = typeof m?.provider === "string" ? m.provider : "unknown";
            recordLimitsFromHeaders(provider, response.headers);
          }
        } catch {
          /* telemetry is never allowed to fail a turn */
        }
        if (userOnResponse) await userOnResponse(response, m);
      },
    };
    return original(model, context, augmented);
  };
  session.agent.streamFn = wrapped as any;
}

// Loose StreamFn signature — Pi's exact type uses generics we don't need
// here; structural typing is enough for the wrap.
type StreamFn = (
  model: Model<any>,
  context: unknown,
  options?: {
    onPayload?: (payload: unknown, m: Model<any>) => unknown | Promise<unknown>;
    onResponse?: (response: ProviderResponse, m: Model<any>) => void | Promise<void>;
    headers?: Record<string, string>;
  } & Record<string, unknown>,
) => unknown;

// ─────────────────────────────────────────────────────────────────────────────
// INSTALLING the transform chain onto Pi's Agent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wire Brigade's `transformContext` chain into a live Pi session.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade used to pass `transformContext` to `createAgentSession(...)`.
 * `createAgentSession` does not accept it. It reads exactly sixteen options —
 * `cwd, agentDir, authStorage, modelRegistry, settingsManager, sessionManager,
 * model, thinkingLevel, tools, noTools, excludeTools, scopedModels,
 * customTools, resourceLoader, sessionStartEvent, settingsManager` — and
 * installs a `transformContext` of its OWN that forwards to the extension
 * runner (`pi-coding-agent/dist/core/sdk.js:219-224`). The property Brigade
 * passed was silently dropped, and an `as never` cast on the options object
 * meant the compiler never said so.
 *
 * The whole chain was therefore dead in production: the tool-result shrink, the
 * surrogate sanitizer, the transcript pairing repair, the Anthropic
 * thinking-strip, the Mistral tool-id rewrite, the cache-control sweep and
 * mid-turn compaction. Every one of them had passing unit tests, because the
 * tests called `buildBrigadeTransformContext` directly and asserted that the
 * function does what it says — never that Pi calls it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ASSIGNING AFTER CONSTRUCTION IS SOUND
 * ─────────────────────────────────────────────────────────────────────────
 * `Agent.transformContext` is a public, mutable field (`pi-agent-core`
 * `agent.d.ts:36`), and `createLoopConfig()` re-reads `this.transformContext`
 * on EVERY run (`agent.js:294`, called from `runPromptMessages` and
 * `runContinuation`). So an assignment made once, here, applies to every
 * subsequent prompt and every tool-loop iteration within them.
 *
 * COMPOSE, never replace: Pi's own transform is what runs extension `context`
 * hooks, and overwriting it would silently disable every extension. Pi's runs
 * FIRST so Brigade's chain sees the final message array — an extension that
 * adds content must not be able to grow a request after we reduced it.
 */
export function installBrigadeTransformContext(
  session: AgentSession,
  transform: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
): void {
  const agent = (session as unknown as {
    agent?: {
      transformContext?: (
        messages: AgentMessage[],
        signal?: AbortSignal,
      ) => Promise<AgentMessage[]>;
    };
  }).agent;
  if (!agent) return;

  const piOwn = agent.transformContext;
  agent.transformContext = async (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> => {
    let working = messages;
    // Pi's extension hook first. It is not ours and may throw; a failing
    // extension must not take down the turn, and must not skip OUR passes —
    // the pairing repair and surrogate sanitizer are what keep malformed
    // history from 400-ing the provider.
    if (piOwn) {
      try {
        const afterExtensions = await piOwn(messages, signal);
        if (Array.isArray(afterExtensions) && afterExtensions.length > 0) {
          working = afterExtensions;
        }
      } catch {
        /* extension failure falls back to the untransformed array */
      }
    }
    try {
      const out = await transform(working, signal);
      // Pi does not guard this call site at all (`agent-loop.js:175-177`): a
      // throw becomes a failed turn, and an empty array becomes a
      // zero-message provider request and a 400. Both are ours to prevent.
      if (Array.isArray(out) && out.length > 0) return out;
      return working;
    } catch {
      return working;
    }
  };
}
