import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BRIGADE_OPENROUTER_CATEGORIES,
  BRIGADE_OPENROUTER_REFERER,
  BRIGADE_OPENROUTER_TITLE,
  isOpenRouterModel,
  resolveOpenRouterAttributionHeaders,
} from "./provider-attribution.js";

test("isOpenRouterModel: matches provider id 'openrouter'", () => {
  assert.equal(isOpenRouterModel({ provider: "openrouter", id: "anthropic/claude" } as never), true);
  assert.equal(isOpenRouterModel({ provider: "OpenRouter", id: "x" } as never), true);
});

test("isOpenRouterModel: matches an openrouter.ai base URL on a generic provider", () => {
  assert.equal(
    isOpenRouterModel({ provider: "custom", id: "x", baseUrl: "https://openrouter.ai/api/v1" } as never),
    true,
  );
});

test("isOpenRouterModel: rejects non-OpenRouter providers", () => {
  assert.equal(isOpenRouterModel({ provider: "anthropic", id: "claude" } as never), false);
  assert.equal(isOpenRouterModel({ provider: "google", id: "gemini" } as never), false);
  assert.equal(isOpenRouterModel({ provider: "bedrock", id: "anthropic.claude" } as never), false);
  assert.equal(isOpenRouterModel(undefined), false);
  // A base URL that merely contains the substring elsewhere must NOT match.
  assert.equal(
    isOpenRouterModel({ provider: "custom", id: "x", baseUrl: "https://example.com/openrouter.ai-proxy" } as never),
    false,
  );
});

test("resolveOpenRouterAttributionHeaders: returns the three headers for OpenRouter", () => {
  const headers = resolveOpenRouterAttributionHeaders({ provider: "openrouter", id: "x" } as never);
  assert.deepEqual(headers, {
    "HTTP-Referer": BRIGADE_OPENROUTER_REFERER,
    "X-OpenRouter-Title": BRIGADE_OPENROUTER_TITLE,
    "X-OpenRouter-Categories": BRIGADE_OPENROUTER_CATEGORIES,
  });
  // Sanity: the identity is Brigade's, not Pi's default.
  assert.equal(headers!["X-OpenRouter-Title"], "Brigade");
  assert.equal(headers!["HTTP-Referer"], "https://brigade-agent.ai");
});

test("resolveOpenRouterAttributionHeaders: undefined for non-OpenRouter providers", () => {
  assert.equal(resolveOpenRouterAttributionHeaders({ provider: "anthropic", id: "claude" } as never), undefined);
  assert.equal(resolveOpenRouterAttributionHeaders({ provider: "google", id: "gemini" } as never), undefined);
  assert.equal(resolveOpenRouterAttributionHeaders(undefined), undefined);
});
