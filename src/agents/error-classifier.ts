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
  | "subscription_limit" // plan usage window exhausted (Claude Max/Pro, ChatGPT) — resets on wall clock; fail fast + fallback chain
  | "timeout"          // network/connect/read timeout — retry transient
  | "context_overflow" // input + output exceeds context — compact then retry, don't burn fallbacks
  | "model_not_found"  // provider doesn't know this model — rotate to fallback
  | "session_expired"  // upstream session/conversation expired — fail fast or refresh
  | "auth_recovered"   // an auth failure we REPAIRED in place (e.g. cleared a stale
                       // macOS keychain shadow) — the credential is known-good now,
                       // so retry the SAME path immediately; never rotate away
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

// Subscription-plan usage-window exhaustion. Distinct from `billing` (missing
// API credits — needs a top-up) AND from `rate_limit` (seconds-to-minutes
// backoff): the plan's 5-hour / weekly window is used up and resets on its own
// wall clock, hours away. Retrying the same model is pointless; the right
// moves are the model-fallback chain (a different provider may be configured)
// or waiting for the reset. Observed surfaces:
//   • Anthropic (Claude Max/Pro via OAuth): 400 invalid_request_error
//     "You're out of extra usage. Add more at claude.ai/settings/usage and
//     keep going." — plan window exhausted AND extra usage disabled/spent.
//   • Anthropic: "Claude usage limit reached. Your limit will reset at …"
//     (sometimes a 429 — the message must win over the bare status).
//   • OpenAI subscription (Codex): "You've hit your usage limit",
//     usage_limit_reached / usage_not_included error codes.
const SUBSCRIPTION_LIMIT_PATTERNS: RegExp[] = [
  /out of extra usage/i,
  /claude\.ai\/settings\/usage/i,
  /(?:claude|plan|subscription) usage limit/i,
  /usage limit (?:reached|hit|exceeded)/i,
  /hit your usage limit/i,
  /usage_limit_reached/i,
  /usage_not_included/i,
  /limit will reset at/i,
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
  /connection dropped|ended without a final response/i, // Ollama native stream cut mid-generation
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
  /truncating\s+input.*too\s+long/i, // Ollama native /api/chat overflow phrasing
];

// Endpoint mismatch — the model exists, but not on the API surface we asked
// for. GitHub Copilot is the loud case: it serves GPT-5+ / codex ONLY on
// `/responses` and answers `421 Misdirected Request` (or a 400 "not accessible
// via the /chat/completions endpoint") for a chat-completions request, and it
// answers 421 just the same when a business/enterprise token is pointed at the
// individual API host. Retrying the identical request is guaranteed to re-fail,
// so this must NOT collapse into `unknown` (2 pointless retries, "last
// reason=unknown" in the TUI) — it's a model-routing problem, so it rides the
// `model_not_found` policy: fail fast, advance to the fallback chain.
// (The bare status code is deliberately NOT matched here — `421` can appear in
// an unrelated message as a token count. The status path below catches it.)
//
// The "via <surface>" wordings are the ones GitHub actually returns — verified
// against the live API: `model gpt-4.1 is not supported via Responses API.`
// The `/chat/completions endpoint` phrasing (from github/copilot-cli#4337) is
// real too, so both stay.
export const ENDPOINT_MISMATCH_PATTERNS: RegExp[] = [
  /misdirected request/i,
  /not (?:accessible|supported) via (?:the )?\/?\S+(?: api| endpoint)?\./i,
  /not accessible via the \/\S+ endpoint/i,
  /not supported (?:on|by) (?:the )?\/\S+ endpoint/i,
];

// Plan entitlement — the seat cannot run this model on ANY surface. Verified on
// a `free_limited_copilot` Copilot seat, where `gpt-5-mini` and
// `claude-haiku-4.5` both fail this way despite `/models` advertising them for
// every plan. Retrying is useless and switching endpoints is useless; the only
// move is a different model, so say that.
const PLAN_ENTITLEMENT_PATTERNS: RegExp[] = [
  /the requested model is not supported/i,
  /model is not (?:supported|available) (?:for|on) (?:your|this) (?:plan|subscription|account)/i,
];

const MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /model[_ ]?not[_ ]?found/i,
  /unknown model/i,
  /model .*?(?:does not exist|is not available)/i,
  /no such model/i,
  /\bmodel \S+ is not supported\b/i, // OpenCode's wording; PLAN_ENTITLEMENT needs "the requested"
  ...ENDPOINT_MISMATCH_PATTERNS,
  ...PLAN_ENTITLEMENT_PATTERNS,
];

// OpenCode answers 401 for every gateway refusal — bad key, unknown model, spent
// credits, blocked region — and resolves the model before checking auth, so the
// status says nothing. The discriminator is the `error.type` in the body:
//   {"type":"error","error":{"type":"CreditsError","message":"…"}}
// Left unread, all of them land in `auth` and the loop rotates auth profiles
// instead of advancing the fallback chain. Matched on the quoted type token so no
// other provider's 401 can move.
// `cls` is carried alongside `reason` because ErrorClass has no `billing` bucket;
// the detailed ladder already routes a 402 to auth_permanent, so credits match.
const OPENCODE_ERRORS: ReadonlyArray<{ re: RegExp; reason: RetryReason; cls: ErrorClass }> = [
  { re: /"type"\s*:\s*"ModelError"/, reason: "model_not_found", cls: "model_not_found" },
  { re: /"type"\s*:\s*"CreditsError"/, reason: "billing", cls: "auth_permanent" },
  { re: /"type"\s*:\s*"RateLimitError"/, reason: "rate_limit", cls: "rate_limit" },
  {
    re: /"type"\s*:\s*"(?:MonthlyLimitError|UserLimitError|FreeUsageLimitError|GoUsageLimitError|BlackUsageLimitError)"/,
    reason: "subscription_limit",
    cls: "subscription_limit",
  },
  { re: /"type"\s*:\s*"(?:RegionError|DataPolicyError)"/, reason: "auth_permanent", cls: "auth_permanent" },
];

function matchOpenCodeError(message: string): (typeof OPENCODE_ERRORS)[number] | null {
  // Cheap bail so every other provider's message costs one indexOf, not five regexes.
  if (!message.includes('"type"')) return null;
  return OPENCODE_ERRORS.find((entry) => entry.re.test(message)) ?? null;
}

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
      return (
        matchOpenCodeError(message)?.reason ??
        (matchAny(message, AUTH_PERMANENT_PATTERNS) ? "auth_permanent" : "auth")
      );
    case 402:
      // 402 is overloaded with meanings — providers use it for both "you owe
      // money" and "you've hit the daily cap, try again". Inspect the body.
      if (matchAny(message, SUBSCRIPTION_LIMIT_PATTERNS)) return "subscription_limit";
      if (matchAny(message, RATE_LIMITED_402_HINTS)) return "rate_limit";
      return "billing";
    case 404:
      return matchAny(message, MODEL_NOT_FOUND_PATTERNS) ? "model_not_found" : null;
    case 408:
      return "timeout";
    case 410:
      return matchAny(message, SESSION_EXPIRED_PATTERNS) ? "session_expired" : "timeout";
    case 421:
      // Misdirected Request — the request reached a host/endpoint that won't
      // serve this model (GitHub Copilot: GPT-5+ is `/responses`-only; a
      // business/enterprise token must use its own API host). Same request,
      // same result — fail fast and let the model-fallback chain move on.
      return "model_not_found";
    case 422:
      return matchAny(message, FORMAT_PATTERNS) ? "format" : null;
    case 429:
      // A 429 carrying a plan-window message ("Claude usage limit reached …
      // resets at …") is a subscription limit, not a transient rate spike —
      // a 30s backoff can't fix a window that resets hours from now.
      if (matchAny(message, SUBSCRIPTION_LIMIT_PATTERNS)) return "subscription_limit";
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
  const openCode = matchOpenCodeError(message);
  if (openCode) return openCode.reason;
  if (matchAny(message, AUTH_PERMANENT_PATTERNS)) return "auth_permanent";
  // Subscription-window exhaustion MUST be checked before billing and
  // rate_limit: its phrasings ("out of extra usage", "usage limit reached")
  // overlap both sets, and the recovery differs (wall-clock reset + fallback
  // chain, not top-up or a 30s backoff).
  if (matchAny(message, SUBSCRIPTION_LIMIT_PATTERNS)) return "subscription_limit";
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
  | "subscription_limit"
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
  // Entitlement + endpoint patterns are tested EARLIER in classifyErrorDetailed,
  // so this can't steal Copilot's plan message or the Responses-API wording.
  /\bmodel\b[^.\n]{0,80}is\s+not\s+supported/i,
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

  // Subscription-window exhaustion — checked BEFORE the status block because
  // providers ship it under conflicting statuses (Anthropic: 400 "out of
  // extra usage"; sometimes 429 "usage limit reached"). Same-model retry is
  // useless (the window resets on wall clock); advance to fallback.
  if (SUBSCRIPTION_LIMIT_PATTERNS.some((p) => p.test(message))) {
    return { class: "subscription_limit", message, retryableOnSameModel: false };
  }

  // Also BEFORE the status block: OpenCode's envelope is self-describing, and Pi
  // does not always surface a parseable status alongside it. Left inside the
  // 401/403 arm, a CreditsError with no status fell through to `unknown` and the
  // loop burned the whole fallback chain instead of reporting the balance.
  const openCodeEarly = matchOpenCodeError(message);
  if (openCodeEarly) {
    return {
      class: openCodeEarly.cls,
      message,
      // Only a transient rate spike is worth re-trying the same model.
      retryableOnSameModel: openCodeEarly.reason === "rate_limit",
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
    if (status === 421) {
      // Misdirected Request — right credential, wrong endpoint/host for this
      // model. Retrying the identical request re-fails; advance to fallback.
      return { class: "model_not_found", message: endpointMismatchMessage(message), retryableOnSameModel: false };
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
  // Entitlement BEFORE endpoint: a plan rejection names no surface, so it must
  // not be mistaken for a routing problem the loop could retry around.
  if (PLAN_ENTITLEMENT_PATTERNS.some((p) => p.test(message))) {
    return {
      class: "model_not_found",
      message: planEntitlementMessage(message),
      retryableOnSameModel: false,
    };
  }
  if (ENDPOINT_MISMATCH_PATTERNS.some((p) => p.test(message))) {
    return {
      class: "model_not_found",
      message: endpointMismatchMessage(message),
      retryableOnSameModel: false,
    };
  }
  if (MODEL_NOT_FOUND_PATTERNS_DETAILED.some((p) => p.test(message))) {
    return { class: "model_not_found", message, retryableOnSameModel: false };
  }

  return { class: "unknown", message, retryableOnSameModel: false };
}

/**
 * Operator-facing text for an endpoint/host mismatch. A bare "421 Misdirected
 * Request" tells the user nothing and reads like a network blip they should
 * retry; this names the actual cause and the two things that fix it.
 */
/**
 * Operator-facing text for a plan-entitlement rejection. The raw provider line
 * ("The requested model is not supported.") reads like a bug in the client, so
 * it sends people looking in the wrong place — name the real cause and the one
 * action that resolves it.
 */
function planEntitlementMessage(message: string): string {
  return (
    `${message} — your subscription doesn't include this model, so no retry or endpoint change ` +
    `will help. Pick a different one with /model. (On GitHub Copilot, the plan's model list is ` +
    `narrower than what \`/models\` advertises — a Free seat typically has gpt-4.1 and gpt-4o only.)`
  );
}

function endpointMismatchMessage(message: string): string {
  return (
    `${message} — the provider won't serve this model on the endpoint/host the request used. ` +
    `On GitHub Copilot this means the model is served only on a different API surface ` +
    `(GPT-5+/codex are \`/responses\`-only) or your Copilot seat is on a business/enterprise ` +
    `host. Pick another model with /model, or re-run \`brigade login copilot\` to refresh the ` +
    `account's endpoint.`
  );
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
    // 421 included: Pi surfaces a Copilot endpoint/host mismatch as a bare
    // `421 Misdirected Request` with no `status` field to read.
    if ([401, 403, 404, 421, 429, 500, 502, 503, 504].includes(n)) return n;
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
