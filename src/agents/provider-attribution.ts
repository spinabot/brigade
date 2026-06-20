// OpenRouter app attribution.
//
// OpenRouter groups requests into an "app" (shown in its Logs/Activity "App"
// column and the public App Showcase) by reading two documented HTTP headers
// off each request:
//
//   • HTTP-Referer        — the app's unique identifier. OpenRouter auto-creates
//                            the app entry the first time it sees the URL; no
//                            registration, ownership check, or live site is
//                            required. The favicon of this URL becomes the app's
//                            logo once the site serves one.
//   • X-OpenRouter-Title  — the display NAME in the "App" column (back-compat
//                            alias: X-Title). Does nothing without HTTP-Referer.
//   • X-OpenRouter-Categories — optional marketplace categories (comma-separated,
//                            lowercase).
//
// Docs: https://openrouter.ai/docs/app-attribution
//
// Without this, Brigade's OpenRouter requests inherit the Pi SDK's default
// referrer and show up as "pi". This module mirrors proviuder attribution approach
// (src/agents/provider-attribution.ts → createOpenRouterWrapper): a tiny policy
// resolved per request and merged into Pi's `SimpleStreamOptions.headers`,
// gated so the headers ONLY attach to OpenRouter — never Anthropic, Google
// Vertex, Bedrock, or OpenAI (which either don't read them or reject custom
// headers).

import type { Model } from "@mariozechner/pi-ai";

/** Brigade's canonical app identity reported to OpenRouter. */
export const BRIGADE_OPENROUTER_REFERER = "https://brigade.spinabot.com";
export const BRIGADE_OPENROUTER_TITLE = "Brigade";
export const BRIGADE_OPENROUTER_CATEGORIES = "cli-agent";

/**
 * Whether the active model routes through OpenRouter. We match on the provider
 * id Pi assigns; an OpenRouter base URL is the secondary signal for keys that
 * point a generic provider at openrouter.ai.
 */
export function isOpenRouterModel(model: Model<any> | undefined): boolean {
  if (!model) return false;
  const provider = (model.provider ?? "").toLowerCase();
  if (provider === "openrouter") return true;
  const baseUrl = (model as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl === "string" && /(?:^|\/\/|\.)openrouter\.ai(?:[/:]|$)/i.test(baseUrl)) {
    return true;
  }
  return false;
}

/**
 * Resolve the OpenRouter app-attribution headers for a request, or `undefined`
 * when the model does not route through OpenRouter (so non-OpenRouter providers
 * are never touched). The caller merges these into Pi's stream options with
 * caller-wins precedence — a user-supplied header overrides the default.
 */
export function resolveOpenRouterAttributionHeaders(
  model: Model<any> | undefined,
): Record<string, string> | undefined {
  if (!isOpenRouterModel(model)) return undefined;
  return {
    "HTTP-Referer": BRIGADE_OPENROUTER_REFERER,
    "X-OpenRouter-Title": BRIGADE_OPENROUTER_TITLE,
    "X-OpenRouter-Categories": BRIGADE_OPENROUTER_CATEGORIES,
  };
}
