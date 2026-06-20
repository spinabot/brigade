// Error classifier for the Brigade agent loop.
//
// Single responsibility: take any thrown value and bucket it into one of the
// retry-policy categories below. Everything that decides "retry / cool down /
// fail fast / rotate model" reads from `classifyError`.
//
// The taxonomy is deliberately small. Ten categories cover the failure modes
// the loop has to react to differently; anything else collapses into
// "unknown" and inherits the unknown-class retry policy.
//
// Inputs we have to classify across:
//   • HTTP status codes (most providers surface them on the error)
//   • Provider-shape error codes (e.g. ZAI 1311 = quota, 1113 = key revoked)
//   • Free-text messages — vendors disagree on phrasing for the same root
//     cause, so the regex set must cast a wide net per category
//   • Native runtime errors (TimeoutError, AbortError, ECONNRESET, …)
//   • Already-classified BrigadeRetryError thrown from a prior layer

export type RetryReason =
  | "auth"             // bad/expired credential — try a different profile, not retry-in-place
  | "auth_permanent"   // key disabled/revoked — never retry this profile
  | "format"           // request shape rejected — retrying with the same body is useless
  | "rate_limit"       // 429 / quota — backoff + cooldown + rotate profile
  | "overloaded"       // 503 / 529 / "high demand" — backoff, then probe
  | "billing"          // 402 / insufficient credits — semi-persistent, may need user action
  | "timeout"          // network/connect/read timeout — retry transient
  | "context_overflow" // input + output exceeds context — compact then retry, don't burn fallbacks
  | "model_not_found"  // provider doesn't know this model — rotate to fallback
  | "session_expired"  // upstream session/conversation expired — fail fast or refresh
  | "unknown";         // catch-all; treated as transient at the policy layer

export interface ClassificationContext {
  provider?: string;
  model?: string;
}

// Classified error wrapper. Throw this from anywhere in the loop to commit to
// a category without re-running the heuristics. The retry policy reads
// `reason` directly without re-classifying.
export class BrigadeRetryError extends Error {
  readonly reason: RetryReason;
  readonly status?: number;
  readonly code?: string;
  readonly provider?: string;
  readonly model?: string;

  constructor(args: {
    message: string;
    reason: RetryReason;
    status?: number;
    code?: string;
    provider?: string;
    model?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause as Error } : undefined);
    this.name = "BrigadeRetryError";
    this.reason = args.reason;
    this.status = args.status;
    this.code = args.code;
    this.provider = args.provider;
    this.model = args.model;
  }
}

export function isBrigadeRetryError(value: unknown): value is BrigadeRetryError {
  if (!value || typeof value !== "object") return false;
  const v = value as { name?: unknown; reason?: unknown };
  return v.name === "BrigadeRetryError" && typeof v.reason === "string";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern sets — lifted from observed provider error surfaces. The same root
// cause shows up under different phrasings across Anthropic, OpenAI, Gemini,
// Groq, OpenRouter, Ollama, ZAI, Together, Fireworks, etc. Cast a wide net.
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_ ]limit/i,
  /too many (?:concurrent )?requests/i,
  /throttling(?:exception)?/i,
  /\b429\b/,
  /\bmodel_cooldown\b/i,
  /exceeded your current quota/i,
  /resource has been exhausted/i,
  /\bquota exceeded\b/i,
  /\bresource_exhausted\b/i,
  /\btpm\b/i,
  /tokens per (?:minute|day)/i,
  /requests per (?:minute|day)/i,
];

const OVERLOADED_PATTERNS: RegExp[] = [
  /overloaded_error/i,
  /"type"\s*:\s*"overloaded_error"/i,
  /\boverloaded\b/i,
  /service[_ ]unavailable.*(?:overload|capacity|high[_ ]demand)/i,
  /\bhigh demand\b/i,
  /\b529\b/,
];

const BILLING_PATTERNS: RegExp[] = [
  /\b402\b/,
  /payment required/i,
  /insufficient credits/i,
  /insufficient[_ ]quota/i,
  /credit balance/i,
  /plans? & billing/i,
  /insufficient balance/i,
  /upgrade (?:your )?plan/i,
  /"code"\s*:\s*1311\b/, // ZAI quota
];

// Substrings inside a 402 message that flip "billing" → "rate_limit" because
// the provider is using the 402 status to indicate a daily/weekly cap rather
// than missing funds. Probing again on a fresh window will succeed.
const RATE_LIMITED_402_HINTS: RegExp[] = [
  /(?:daily|weekly|monthly)\s*(?:rate\s*)?limit/i,
  /try (?:again|later)/i,
  /retry after/i,
  /cool[ -]?down/i,
];

const AUTH_PERMANENT_PATTERNS: RegExp[] = [
  /api[_ ]?key[_ ]?(?:revoked|deactivated|deleted)/i,
  /key (?:has been|was) (?:disabled|revoked|deactivated)/i,
  /account (?:has been|was) deactivated/i,
  /not allowed for this organi[sz]ation/i,
  /"code"\s*:\s*1113\b/, // ZAI key revoked
];

const AUTH_PATTERNS: RegExp[] = [
  /incorrect api key/i,
  /invalid (?:token|api[_ ]?key|credential)/i,
  /authenticat(?:ion|e)/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /access denied/i,
  /insufficient permissions/i,
  /\b(?:401|403)\b/,
  /token (?:has |was )?expired/i,
  /oauth token refresh failed/i,
];

const TIMEOUT_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bdeadline exceeded\b/i,
  /\beconn(?:refused|reset|aborted)\b/i,
  /\betimedout\b/i,
  /without sending (?:any )?chunks?/i,
  /\bstop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
  /\bfinish_reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
  /socket hang up/i,
  /network error/i,
];

const FORMAT_PATTERNS: RegExp[] = [
  /string should match pattern/i,
  /tool_use\.id/i,
  /tool_use_id/i,
  /invalid request format/i,
  /tool call id was.*must be/i,
  /messages\.\d+\.content\.\d+\.tool_use\.id/i,
];

// Context-overflow patterns. Tool calls (especially `bash` / `read` on large
// files / `grep` returning many matches) flood the context window faster
// than any other surface. Without a dedicated bucket these errors fall into
// `format` (terminal, no retry) or `unknown` (retries with the same body
// that just exceeded the limit) — both wrong. The right response is to run
// smart compaction and retry. Mirrors the detailed classifier's
// CONTEXT_OVERFLOW_PATTERNS_DETAILED set so the two stay aligned.
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context\s+(?:length|size|window)/i,
  /maximum\s+context/i,
  /token\s+limit/i,
  /too\s+many\s+tokens/i,
  /reduce\s+the\s+length/i,
  /exceeds?\s+the\s+(?:limit|maximum)/i,
  /prompt\s+is\s+too\s+long/i,
  /context_window_exceeded/i,
  /context_length_exceeded/i,
];

const MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /model[_ ]?not[_ ]?found/i,
  /unknown model/i,
  /model .*?(?:does not exist|is not available)/i,
  /no such model/i,
];

const SESSION_EXPIRED_PATTERNS: RegExp[] = [
  /session not found/i,
  /session (?:has )?expired/i,
  /conversation not found/i,
  /session id not found/i,
  /conversation id not found/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Status-code → reason. Where the message is informative the message wins
// (e.g. a 422 with "string should match pattern" is format, not rate_limit).
// ─────────────────────────────────────────────────────────────────────────────

function classifyByStatus(status: number, message: string): RetryReason | null {
  switch (status) {
    case 401:
    case 403:
      return matchAny(message, AUTH_PERMANENT_PATTERNS) ? "auth_permanent" : "auth";
    case 402:
      // 402 is overloaded with meanings — providers use it for both "you owe
      // money" and "you've hit the daily cap, try again". Inspect the body.
      if (matchAny(message, RATE_LIMITED_402_HINTS)) return "rate_limit";
      return "billing";
    case 404:
      return matchAny(message, MODEL_NOT_FOUND_PATTERNS) ? "model_not_found" : null;
    case 408:
      return "timeout";
    case 410:
      return matchAny(message, SESSION_EXPIRED_PATTERNS) ? "session_expired" : "timeout";
    case 422:
      return matchAny(message, FORMAT_PATTERNS) ? "format" : null;
    case 429:
      return "rate_limit";
    case 499:
      // Cloudflare "client closed request" — sometimes reported by edge
      // proxies during overload. Inspect message; default to timeout.
      return matchAny(message, OVERLOADED_PATTERNS) ? "overloaded" : "timeout";
    case 500:
    case 502:
    case 504:
      return "timeout";
    case 503:
      return matchAny(message, OVERLOADED_PATTERNS) ? "overloaded" : "timeout";
    case 529:
      return "overloaded";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level entry point. Walk the error chain (cause/reason) in case the
// status/message lives one or two layers deep — common for fetch wrappers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RetryReason classifier. Returns one of the 11 retry-policy categories so
 * `getRetryPolicy(reason)` can pick the right backoff / rotation strategy.
 *
 * NOTE: there is a SECOND classifier in this file (`classifyErrorDetailed`)
 * that returns a richer object shape used by the lifted v0.1.3 wrappers in
 * `core/agent.ts`. They are NOT interchangeable — the names differ
 * deliberately so a future careless edit can't swap them silently.
 *
 * For an alias view, `core/agent.ts` imports `classifyErrorDetailed as
 * classifyError` — that's its OWN file's local name, not the one exported
 * here. This file's `classifyError` always returns a string RetryReason.
 */
export function classifyErrorReason(value: unknown, _ctx?: ClassificationContext): RetryReason {
  if (isBrigadeRetryError(value)) return value.reason;
  if (value === null || value === undefined) return "unknown";

  const visited = new Set<unknown>();
  const stack: unknown[] = [value];
  let firstStatus: number | undefined;
  let firstMessage = "";

  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || cur === undefined) continue;
    if (typeof cur !== "object") {
      const msg = String(cur);
      if (!firstMessage) firstMessage = msg;
      const byPattern = classifyByMessage(msg);
      if (byPattern) return byPattern;
      continue;
    }
    if (visited.has(cur)) continue;
    visited.add(cur);

    const obj = cur as {
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
      reason?: unknown;
      name?: unknown;
      code?: unknown;
    };

    // AbortError / TimeoutError surface as native error names.
    if (obj.name === "AbortError") return "unknown";
    if (obj.name === "TimeoutError") return "timeout";

    const status = readNumeric(obj.status) ?? readNumeric(obj.statusCode) ?? readNumeric(obj.response?.status);
    if (status !== undefined && firstStatus === undefined) firstStatus = status;

    const message = typeof obj.message === "string" ? obj.message : "";
    if (message && !firstMessage) firstMessage = message;

    if (status !== undefined) {
      const byStatus = classifyByStatus(status, message);
      if (byStatus) return byStatus;
    }
    if (message) {
      const byPattern = classifyByMessage(message);
      if (byPattern) return byPattern;
    }

    // ECONNRESET / ETIMEDOUT bubble up as `code` on Node fetch errors.
    const code = typeof obj.code === "string" ? obj.code : "";
    if (code) {
      if (/^E(?:CONN(?:RESET|REFUSED|ABORTED)|TIMEDOUT|HOSTUNREACH|NETUNREACH|PIPE)$/i.test(code)) {
        return "timeout";
      }
    }

    if (obj.cause !== undefined && obj.cause !== cur) stack.push(obj.cause);
    if (obj.reason !== undefined && obj.reason !== cur) stack.push(obj.reason);
  }

  // Last-resort: if we collected a status with no message-based hit, classify
  // by status alone.
  if (firstStatus !== undefined) {
    const byStatus = classifyByStatus(firstStatus, firstMessage);
    if (byStatus) return byStatus;
  }
  return "unknown";
}

function classifyByMessage(message: string): RetryReason | null {
  if (!message) return null;
  if (matchAny(message, AUTH_PERMANENT_PATTERNS)) return "auth_permanent";
  if (matchAny(message, BILLING_PATTERNS)) {
    return matchAny(message, RATE_LIMITED_402_HINTS) ? "rate_limit" : "billing";
  }
  if (matchAny(message, RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (matchAny(message, OVERLOADED_PATTERNS)) return "overloaded";
  if (matchAny(message, AUTH_PATTERNS)) return "auth";
  if (matchAny(message, MODEL_NOT_FOUND_PATTERNS)) return "model_not_found";
  if (matchAny(message, SESSION_EXPIRED_PATTERNS)) return "session_expired";
  // context_overflow MUST be checked before format. A "prompt is too long"
  // error often arrives with a 400 status that would otherwise hit FORMAT
  // patterns first. Wrong classification here drops compaction recovery.
  if (matchAny(message, CONTEXT_OVERFLOW_PATTERNS)) return "context_overflow";
  if (matchAny(message, FORMAT_PATTERNS)) return "format";
  if (matchAny(message, TIMEOUT_PATTERNS)) return "timeout";
  return null;
}

function matchAny(haystack: string, patterns: RegExp[]): boolean {
  for (const p of patterns) if (p.test(haystack)) return true;
  return false;
}

function readNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic refusal-token defense. A specific magic literal can be embedded
// in user content to coerce Anthropic models into refusing the next turn.
// Strip it before any prompt assembly and after any session replay so the
// transcript itself can't carry the payload across turns.
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_REFUSAL_SENTINEL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_REFUSAL_SENTINEL_REDACTED = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

export function scrubAnthropicRefusalSentinel(text: string): string {
  if (!text || !text.includes(ANTHROPIC_REFUSAL_SENTINEL)) return text;
  return text.replaceAll(ANTHROPIC_REFUSAL_SENTINEL, ANTHROPIC_REFUSAL_SENTINEL_REDACTED);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: format an error for a single-line log/diagnostic. Kept short —
// the full error chain still goes to the structured logger fields.
// ─────────────────────────────────────────────────────────────────────────────

export function summariseError(value: unknown): string {
  if (isBrigadeRetryError(value)) {
    const status = value.status !== undefined ? ` status=${value.status}` : "";
    const provider = value.provider ? ` provider=${value.provider}` : "";
    return `${value.reason}${provider}${status}: ${value.message}`;
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAILED CLASSIFIER + RETRY POLICY (folded in from src/core/error-classifier.ts).
//
// `classifyError` above returns a string `RetryReason`. The lifted v0.1.3
// agent loop wants a richer ClassifiedError OBJECT with retry-after timing
// and a `retryableOnSameModel` boolean, plus a `decideRetry` policy
// function with backoff ladders. Rather than duplicating two parallel files,
// we keep BOTH APIs in this single module:
//
//   • classifyError(value, ctx?)        → RetryReason       (Brigade-native, primitive #1)
//   • classifyErrorDetailed(err)        → ClassifiedError   (lifted v0.1.3, used by core/agent.ts)
//   • decideRetry(c, opts)              → RetryDecision     (lifted retry-policy ladder)
//
// The two classifiers are taxonomy-compatible where it matters (rate_limit /
// auth / auth_permanent / model_not_found / unknown all overlap); the
// detailed one adds context_overflow / server_5xx / network / content_filter
// distinctions the retry policy needs to pick the right backoff.
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorClass =
  | "rate_limit"
  | "server_5xx"
  | "network"
  | "timeout"
  | "context_overflow"
  | "auth"
  | "auth_permanent"
  | "content_filter"
  | "model_not_found"
  | "unknown";

export interface ClassifiedError {
  /** The class. Drives which recovery the loop attempts. */
  class: ErrorClass;
  /** Retry-After delay in ms, parsed from the message if the provider included one. */
  retryAfterMs?: number;
  /** Original error message, for logging. */
  message: string;
  /** True if the same MODEL might succeed on retry; false → advance to fallback. */
  retryableOnSameModel: boolean;
}

/* ─────────── pattern tables for classifyErrorDetailed ─────────── */
// (Renamed from the originals to avoid collision with the RetryReason
// classifier's own pattern tables above. Detailed-suffix is a tag, not a
// behaviour difference.)

const NETWORK_ERROR_CODES_DETAILED = new Set<string>([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETRESET",
  "EPIPE",
  "EAI_AGAIN",
]);

const SERVER_5XX_CODES_DETAILED = new Set([499, 500, 502, 503, 504, 521, 522, 523, 524, 529]);

const CONTEXT_OVERFLOW_PATTERNS_DETAILED = [
  /context\s+(?:length|size|window)/i,
  /maximum\s+context/i,
  /token\s+limit/i,
  /too\s+many\s+tokens/i,
  /reduce\s+the\s+length/i,
  /exceeds?\s+the\s+limit/i,
  /prompt\s+is\s+too\s+long/i,
  /context_window_exceeded/i,
];

const RATE_LIMIT_PATTERNS_DETAILED = [
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /requests\s+per\s+(?:minute|hour|day|second)/i,
  /quota/i,
  /throttl(?:ed|ing)/i,
  /\b429\b/,
  /tokens?\s+per\s+day/i,
  /overloaded/i,
];

const AUTH_PATTERNS_DETAILED = [
  /invalid\s+api\s+key/i,
  /(?:un)?authenticat/i,
  /unauthor[is]z/i,
  /forbidden/i,
  /invalid\s+token/i,
  /access\s+denied/i,
  /token\s+expired/i,
  /token\s+revoked/i,
  /incorrect\s+api\s+key/i,
];

const AUTH_PERMANENT_PATTERNS_DETAILED = [
  /billing/i,
  /payment\s+required/i,
  /insufficient\s+(?:funds|credit|quota)/i,
  /account\s+(?:disabled|suspended|terminated)/i,
];

const CONTENT_FILTER_PATTERNS_DETAILED = [
  /content\s+filter/i,
  /content\s+policy/i,
  /safety/i,
  /\b(?:cannot|can(?:'|’)?t|unable\s+to|won(?:'|’)?t)\s+(?:to\s+)?(?:respond|comply|assist|help|provide|do\s+that|continue)/i,
  /refus(?:al|ed)/i,
];

const MODEL_NOT_FOUND_PATTERNS_DETAILED = [
  /model\s+(?:not|does\s+not)\s+(?:found|exist|available)/i,
  /\bmodel\b[^.\n]{0,80}(?:does\s+not\s+exist|not\s+(?:found|available)|is\s+(?:invalid|deprecated))/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /\b404\b.*model/i,
];

/**
 * Detailed classifier (object return) used by the retry-policy ladder.
 * Returns `{class, retryAfterMs?, message, retryableOnSameModel}` —
 * `decideRetry` reads these fields to pick a backoff strategy.
 *
 * Use `classifyError` (above) when you only need the category string.
 */
export function classifyErrorDetailed(err: unknown): ClassifiedError {
  const message = extractMessageDetailed(err);
  const code = extractCodeDetailed(err);
  const status = extractStatusDetailed(err);

  // A model that can't use tools (e.g. OpenRouter routed to a non-function-calling model like
  // gemma-2) is a model CHOICE problem — classify it BEFORE the status block (the message may or
  // may not carry a parseable 404) so memory/recall users get a clear next step and NO 3× retry.
  // retryableOnSameModel:false advances to the tool-capable fallback.
  if (/no endpoints found that support tool|support tool use|does not support tool/i.test(message)) {
    return {
      class: "model_not_found",
      message:
        "This model can't use tools, so memory / recall (and any tool call) won't work. Switch to a tool-capable model — e.g. Claude, GPT, or a Gemini *-pro — with /model.",
      retryableOnSameModel: false,
    };
  }

  if (code && NETWORK_ERROR_CODES_DETAILED.has(code)) {
    return {
      class: code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNABORTED"
        ? "timeout"
        : "network",
      message,
      retryableOnSameModel: true,
    };
  }

  if (typeof status === "number") {
    if (status === 429) {
      return {
        class: "rate_limit",
        message,
        retryAfterMs: parseRetryAfter(err),
        retryableOnSameModel: true,
      };
    }
    if (SERVER_5XX_CODES_DETAILED.has(status)) {
      return { class: "server_5xx", message, retryableOnSameModel: true };
    }
    if (status === 401 || status === 403) {
      const isPermanent = AUTH_PERMANENT_PATTERNS_DETAILED.some((p) => p.test(message));
      return {
        class: isPermanent ? "auth_permanent" : "auth",
        message,
        retryableOnSameModel: false,
      };
    }
    if (status === 402) {
      return { class: "auth_permanent", message, retryableOnSameModel: false };
    }
    if (status === 404) {
      return { class: "model_not_found", message, retryableOnSameModel: false };
    }
  }

  if (CONTEXT_OVERFLOW_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return { class: "context_overflow", message, retryableOnSameModel: true };
  }
  if (RATE_LIMIT_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return {
      class: "rate_limit",
      message,
      retryAfterMs: parseRetryAfter(err),
      retryableOnSameModel: true,
    };
  }
  if (AUTH_PERMANENT_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return { class: "auth_permanent", message, retryableOnSameModel: false };
  }
  if (AUTH_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return { class: "auth", message, retryableOnSameModel: false };
  }
  if (CONTENT_FILTER_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return { class: "content_filter", message, retryableOnSameModel: false };
  }
  if (MODEL_NOT_FOUND_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return { class: "model_not_found", message, retryableOnSameModel: false };
  }

  return { class: "unknown", message, retryableOnSameModel: false };
}

/* ─────────────────────────── retry policy ─────────────────────────── */

export interface RetryDecision {
  /** True → caller should retry on the same model after the given delay. */
  retry: boolean;
  /** Delay before retry in ms. Always >= 0. Ignored when retry=false. */
  delayMs: number;
  /** Reason string for logging / UI. */
  reason: string;
}

export interface RetryPolicyOptions {
  /** Which attempt number is this (1-indexed). Starts at 1 for the FIRST retry. */
  attempt: number;
  /** Hard cap on total retries before giving up on the same model. */
  maxAttempts?: number;
  /** Cap on total wait per single retry. */
  maxDelayMs?: number;
}

/**
 * Decide what to do with a classified error. Returns the next backoff and
 * whether to retry on the same model. Cooldown ladder: 30s → 60s → 5min.
 *
 * `context_overflow` is special: caller should run smart compaction BEFORE
 * retrying — delay is 0 because we're not waiting on the network, we're
 * waiting on local work.
 */
export function decideRetry(c: ClassifiedError, opts: RetryPolicyOptions): RetryDecision {
  const max = opts.maxAttempts ?? 3;
  const maxDelay = opts.maxDelayMs ?? 60_000;

  if (!c.retryableOnSameModel) {
    return { retry: false, delayMs: 0, reason: `${c.class} — advance to fallback` };
  }
  if (opts.attempt > max) {
    return { retry: false, delayMs: 0, reason: `${c.class} — exhausted retries on this model` };
  }

  switch (c.class) {
    case "rate_limit": {
      const ladder = [30_000, 60_000, 5 * 60_000];
      const fromLadder = ladder[Math.min(opts.attempt - 1, ladder.length - 1)]!;
      const delay = c.retryAfterMs
        ? Math.min(c.retryAfterMs, maxDelay)
        : Math.min(fromLadder, maxDelay);
      return { retry: true, delayMs: delay, reason: `rate-limited — waiting ${delay}ms (attempt ${opts.attempt}/${max})` };
    }
    case "server_5xx": {
      const base = 1000 * 2 ** (opts.attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(base + jitter, maxDelay);
      return { retry: true, delayMs: delay, reason: `server error — retrying in ${delay}ms (attempt ${opts.attempt}/${max})` };
    }
    case "network":
    case "timeout": {
      const ladder = [200, 1_000, 3_000];
      const delay = ladder[Math.min(opts.attempt - 1, ladder.length - 1)]!;
      return { retry: true, delayMs: delay, reason: `${c.class} — quick retry in ${delay}ms` };
    }
    case "context_overflow": {
      return { retry: true, delayMs: 0, reason: `context overflow — compact then retry` };
    }
    default:
      return { retry: false, delayMs: 0, reason: `${c.class} — not retryable on same model` };
  }
}

/* ─────────────────────────── helpers (Detailed) ─────────────────────────── */

function extractMessageDetailed(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) return String((err as any).message);
  return String(err);
}

function extractCodeDetailed(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as any).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function extractStatusDetailed(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as any;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (e.response && typeof e.response.status === "number") return e.response.status;

  const msg = extractMessageDetailed(err);
  const httpMatch = msg.match(/\b(?:HTTP|status)\s*(?::|\s)\s*(\d{3})\b/i);
  if (httpMatch) {
    const n = Number(httpMatch[1]);
    if (n >= 100 && n < 600) return n;
  }
  const bareMatch = msg.match(/\b([45]\d{2})\b/);
  if (bareMatch) {
    const n = Number(bareMatch[1]);
    if ([401, 403, 404, 429, 500, 502, 503, 504].includes(n)) return n;
  }
  return undefined;
}

/**
 * Parse Retry-After. Providers express this as either a delta-seconds integer
 * or an HTTP-date string per RFC 7231; we accept both. Exported so callers
 * (tests, the model-fallback orchestrator) can read the same hint.
 */
export function parseRetryAfter(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as any;

  const fromHeader =
    e.headers?.["retry-after"] ??
    e.response?.headers?.["retry-after"] ??
    e.response?.headers?.get?.("retry-after");
  if (fromHeader) {
    const seconds = Number(fromHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
    const date = Date.parse(String(fromHeader));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  const msg = extractMessageDetailed(err);
  const m = msg.match(/(?:retry|try again)\s+(?:after|in)\s+(\d+)\s*s(?:ec)?/i);
  if (m) return Number(m[1]) * 1000;
  return undefined;
}
