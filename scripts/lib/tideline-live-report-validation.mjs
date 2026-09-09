/** Project provider metadata onto a bounded report schema before writing it. */
// Sanity bounds for reporting; the caller separately enforces its request budget.
const MAX_TOKENS = 2_000_000;
const MAX_COST = 100;
const MAX_ANSWER_LENGTH = 16_384;
const FINISH_REASONS = ["stop", "length", "tool_calls", "function_call", "content_filter", "error"];

function invalid(field) {
  // Never put a rejected provider value in an error that the report may persist.
  throw new TypeError(`Invalid provider report field: ${field}`);
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value;
}

function amount(value, field, maximum, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isSafeInteger(value))) invalid(field);
  return value;
}

function allowed(value, candidates, field) {
  // Return the local canonical value, not an unchecked provider string.
  const match = candidates.find(candidate => candidate === value);
  if (match === undefined) invalid(field);
  return match;
}

function optionalAmounts(source, fields, maximum, integer, label) {
  const result = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) result[field] = amount(source[field], `${label}.${field}`, maximum, integer);
  }
  return result;
}

export function validateProviderReportMetadata(data, { models, providers }) {
  record(data, "response");
  if (typeof data.id !== "string" || data.id.length > 128 || !/^[A-Za-z0-9]/.test(data.id) || /[^A-Za-z0-9._:-]/.test(data.id)) invalid("id");
  const source = record(data.usage, "usage");
  const usage = {
    prompt_tokens: amount(source.prompt_tokens, "usage.prompt_tokens", MAX_TOKENS, true),
    completion_tokens: amount(source.completion_tokens, "usage.completion_tokens", MAX_TOKENS, true),
    cost: amount(source.cost, "usage.cost", MAX_COST),
    ...optionalAmounts(source, ["total_tokens"], MAX_TOKENS, true, "usage"),
  };
  if (Object.hasOwn(source, "is_byok")) {
    if (typeof source.is_byok !== "boolean") invalid("usage.is_byok");
    usage.is_byok = source.is_byok;
  }
  for (const [field, keys] of [
    ["prompt_tokens_details", ["cached_tokens", "cache_write_tokens", "audio_tokens", "video_tokens"]],
    ["completion_tokens_details", ["reasoning_tokens", "audio_tokens", "image_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"]],
  ]) {
    if (Object.hasOwn(source, field)) usage[field] = optionalAmounts(record(source[field], `usage.${field}`), keys, MAX_TOKENS, true, `usage.${field}`);
  }
  if (Object.hasOwn(source, "cost_details")) {
    usage.cost_details = optionalAmounts(record(source.cost_details, "usage.cost_details"),
      ["upstream_inference_cost", "upstream_inference_prompt_cost", "upstream_inference_completions_cost"], MAX_COST, false, "usage.cost_details");
  }
  return {
    generationId: data.id,
    returnedModel: allowed(data.model, models, "model"),
    provider: allowed(data.provider, providers, "provider"),
    usage,
    finishReason: allowed(data.choices?.[0]?.finish_reason, FINISH_REASONS, "finish_reason"),
  };
}

export function validateProviderAnswerText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > MAX_ANSWER_LENGTH) invalid("answer");
  return value;
}

export function providerReportErrorCategory(error) {
  return ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "AssertionError"]
    .find(name => name === error?.name) ?? "UnknownError";
}
