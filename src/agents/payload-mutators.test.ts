import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  pruneProcessedHistoryImages,
  scrubRefusalSentinelInTranscript,
  sweepStaleAnthropicCacheControl,
  buildBrigadeTransformContext,
  wrapStreamFnWithPayloadMutations,
} from "./payload-mutators.js";
import { CACHE_BOUNDARY_MARKER } from "../system-prompt/cache-boundary.js";

interface CacheBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
}

function makeMessage(role: string, blocks: CacheBlock[]): AgentMessage {
  return { role, content: blocks } as unknown as AgentMessage;
}

test("sweepStaleAnthropicCacheControl: empty array is a no-op", () => {
  const out = sweepStaleAnthropicCacheControl([]);
  assert.deepEqual(out, []);
});

test("sweepStaleAnthropicCacheControl: keeps cache_control on the most recent message only", () => {
  const messages: AgentMessage[] = [
    makeMessage("user", [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }]),
    makeMessage("assistant", [{ type: "text", text: "mid", cache_control: { type: "ephemeral" } }]),
    makeMessage("user", [{ type: "text", text: "new", cache_control: { type: "ephemeral" } }]),
  ];
  const out = sweepStaleAnthropicCacheControl(messages);
  // Newest (index 2) keeps cache_control; older two have it stripped.
  const blocksAt = (i: number) => (out[i] as { content: CacheBlock[] }).content;
  assert.equal(blocksAt(0)[0]!.cache_control, undefined);
  assert.equal(blocksAt(1)[0]!.cache_control, undefined);
  assert.equal(blocksAt(2)[0]!.cache_control?.type, "ephemeral");
});

test("sweepStaleAnthropicCacheControl: leaves system message untouched", () => {
  const messages: AgentMessage[] = [
    makeMessage("system", [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]),
    makeMessage("user", [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }]),
    makeMessage("user", [{ type: "text", text: "new", cache_control: { type: "ephemeral" } }]),
  ];
  const out = sweepStaleAnthropicCacheControl(messages);
  const sysBlocks = (out[0] as { content: CacheBlock[] }).content;
  assert.equal(sysBlocks[0]!.cache_control?.type, "ephemeral");
});

test("sweepStaleAnthropicCacheControl: messages with content:null pass through", () => {
  const messages = [{ role: "assistant", content: null }] as unknown as AgentMessage[];
  const out = sweepStaleAnthropicCacheControl(messages);
  assert.equal(out.length, 1);
  assert.equal((out[0] as { content: unknown }).content, null);
});

test("sweepStaleAnthropicCacheControl: tracks 'kept' only on messages that actually carry cache_control", () => {
  // Newest user message has NO cache_control. Counter must NOT increment on it,
  // so the older assistant message (which DOES have cache_control) must be
  // preserved as the kept slot.
  const messages: AgentMessage[] = [
    makeMessage("assistant", [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }]),
    makeMessage("user", [{ type: "text", text: "newer", cache_control: { type: "ephemeral" } }]),
    makeMessage("assistant", [{ type: "text", text: "newest" }]), // no cache_control
  ];
  const out = sweepStaleAnthropicCacheControl(messages);
  // Newest has no cache_control to begin with → unchanged.
  // Middle (newer) is the most recent message WITH cache_control → kept.
  // Oldest is past the kept window → cache_control stripped.
  const blocksAt = (i: number) => (out[i] as { content: CacheBlock[] }).content;
  assert.equal(blocksAt(2)[0]!.cache_control, undefined);
  assert.equal(blocksAt(1)[0]!.cache_control?.type, "ephemeral");
  assert.equal(blocksAt(0)[0]!.cache_control, undefined);
});

test("scrubRefusalSentinelInTranscript: removes magic literal from text blocks", () => {
  const messages: AgentMessage[] = [
    makeMessage("user", [
      { type: "text", text: "hello ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL world" },
    ]),
  ];
  const out = scrubRefusalSentinelInTranscript(messages);
  const text = ((out[0] as { content: CacheBlock[] }).content[0] as CacheBlock).text;
  assert.equal(text!.includes("ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL"), false);
});

test("scrubRefusalSentinelInTranscript: scrubs string-shaped content too", () => {
  const messages = [
    {
      role: "user",
      content: "preamble ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL postamble",
    },
  ] as unknown as AgentMessage[];
  const out = scrubRefusalSentinelInTranscript(messages);
  const text = (out[0] as { content: string }).content;
  assert.equal(text.includes("ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL"), false);
});

test("scrubRefusalSentinelInTranscript: unchanged messages share identity (no needless allocation)", () => {
  const messages: AgentMessage[] = [
    makeMessage("user", [{ type: "text", text: "totally clean" }]),
  ];
  const out = scrubRefusalSentinelInTranscript(messages);
  assert.strictEqual(out, messages);
});

test("buildBrigadeTransformContext: never throws on malformed input", async () => {
  const transform = buildBrigadeTransformContext({ applyAnthropicSweep: true });
  const malformed = [
    { role: "user", content: undefined },
    { role: "assistant", content: 42 },
    null,
  ] as unknown as AgentMessage[];
  // Should not throw; fall back to original input on internal error.
  const out = await transform(malformed);
  assert.equal(out.length, 3);
});

test("buildBrigadeTransformContext: skips Anthropic sweep when disabled", async () => {
  const transform = buildBrigadeTransformContext({
    applyAnthropicSweep: false,
    pruneOldImages: false,
  });
  const messages: AgentMessage[] = [
    makeMessage("user", [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }]),
    makeMessage("user", [{ type: "text", text: "new", cache_control: { type: "ephemeral" } }]),
  ];
  const out = await transform(messages);
  // Both retain cache_control because the sweep is off.
  const blocksAt = (i: number) => (out[i] as { content: CacheBlock[] }).content;
  assert.equal(blocksAt(0)[0]!.cache_control?.type, "ephemeral");
  assert.equal(blocksAt(1)[0]!.cache_control?.type, "ephemeral");
});

test("pruneProcessedHistoryImages: leaves recent turns untouched", () => {
  // 2 completed turns is below the threshold (3), so nothing is pruned.
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "image", source: "x" }] },
    { role: "assistant", content: [{ type: "text", text: "ack" }] },
    { role: "user", content: [{ type: "image", source: "y" }] },
    { role: "assistant", content: [{ type: "text", text: "ack" }] },
  ] as unknown as AgentMessage[];
  const out = pruneProcessedHistoryImages(messages);
  assert.strictEqual(out, messages);
});

test("pruneProcessedHistoryImages: prunes images older than 3 completed turns", () => {
  const messages: AgentMessage[] = [
    // Turn 1 (oldest)
    { role: "user", content: [{ type: "image", source: "old" }] },
    { role: "assistant", content: [{ type: "text", text: "ack1" }] },
    // Turn 2
    { role: "user", content: [{ type: "image", source: "mid" }] },
    { role: "assistant", content: [{ type: "text", text: "ack2" }] },
    // Turn 3 (preserved)
    { role: "user", content: [{ type: "image", source: "recent1" }] },
    { role: "assistant", content: [{ type: "text", text: "ack3" }] },
    // Turn 4 (preserved)
    { role: "user", content: [{ type: "image", source: "recent2" }] },
    { role: "assistant", content: [{ type: "text", text: "ack4" }] },
    // Turn 5 (preserved — most recent)
    { role: "user", content: [{ type: "image", source: "recent3" }] },
    { role: "assistant", content: [{ type: "text", text: "ack5" }] },
  ] as unknown as AgentMessage[];
  const out = pruneProcessedHistoryImages(messages);
  // Turn 1 user message should have its image replaced with a placeholder.
  const firstUserContent = (out[0] as { content: { type: string; text?: string }[] }).content;
  assert.equal(firstUserContent[0]!.type, "text");
  assert.match(firstUserContent[0]!.text!, /image data removed/);
  // Most-recent user image should be preserved verbatim.
  const lastImageMsg = out[8] as { content: { type: string; source?: string }[] };
  assert.equal(lastImageMsg.content[0]!.type, "image");
});

test("pruneProcessedHistoryImages: text-only sessions return identity (no allocation)", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
    { role: "user", content: [{ type: "text", text: "c" }] },
    { role: "assistant", content: [{ type: "text", text: "d" }] },
    { role: "user", content: [{ type: "text", text: "e" }] },
    { role: "assistant", content: [{ type: "text", text: "f" }] },
    { role: "user", content: [{ type: "text", text: "g" }] },
    { role: "assistant", content: [{ type: "text", text: "h" }] },
  ] as unknown as AgentMessage[];
  const out = pruneProcessedHistoryImages(messages);
  assert.strictEqual(out, messages);
});

test("wrapStreamFnWithPayloadMutations: composes onPayload, runs CACHE_BOUNDARY_MARKER strip", async () => {
  // Fake AgentSession with a stub streamFn we can intercept. We capture the
  // wrapped options so we can fire the wrapped onPayload manually + observe
  // the mutator effects.
  let capturedOptions: { onPayload?: (payload: unknown, m: unknown) => unknown } | undefined;
  const stubSession = {
    agent: {
      streamFn: (_model: unknown, _ctx: unknown, options: typeof capturedOptions) => {
        capturedOptions = options;
        return undefined;
      },
    },
  };
  wrapStreamFnWithPayloadMutations(stubSession as never);
  // Invoke the wrapped streamFn (model + ctx are placeholders the wrap
  // only forwards). The wrap installs a composed onPayload.
  (stubSession.agent.streamFn as unknown as Function)(
    { provider: "anthropic", id: "claude" },
    {},
    {},
  );
  assert.ok(capturedOptions?.onPayload, "wrap installs an onPayload");
  // System prompt carries the cache-boundary marker; after the mutator
  // chain runs the marker must NOT appear in any string in the payload.
  const payload: { system: string } = {
    system: `prefix\n${CACHE_BOUNDARY_MARKER}\nsuffix`,
  };
  await capturedOptions!.onPayload!(payload, { provider: "openai", id: "gpt-4o" });
  // For non-Anthropic the strip leaves a plain text without the marker
  // (system is still a string post-strip on non-Anthropic providers).
  assert.ok(!JSON.stringify(payload).includes(CACHE_BOUNDARY_MARKER));
});

test("wrapStreamFnWithPayloadMutations: is a no-op when streamFn is missing", () => {
  const stubSession = { agent: {} };
  // Should not throw.
  wrapStreamFnWithPayloadMutations(stubSession as never);
  assert.ok(true);
});

// ─── OpenRouter attribution header injection (folded into the same wrapper) ───

function captureWrappedOptions(
  model: unknown,
  callerOptions: Record<string, unknown>,
): { headers?: Record<string, string> } | undefined {
  let capturedOptions: { headers?: Record<string, string> } | undefined;
  const stubSession = {
    agent: {
      streamFn: (_model: unknown, _ctx: unknown, options: typeof capturedOptions) => {
        capturedOptions = options;
        return undefined;
      },
    },
  };
  wrapStreamFnWithPayloadMutations(stubSession as never);
  (stubSession.agent.streamFn as unknown as Function)(model, {}, callerOptions);
  return capturedOptions;
}

test("wrapStreamFnWithPayloadMutations: injects Brigade attribution headers for OpenRouter", () => {
  const opts = captureWrappedOptions({ provider: "openrouter", id: "anthropic/claude" }, {});
  assert.equal(opts?.headers?.["HTTP-Referer"], "https://brigade.spinabot.com");
  assert.equal(opts?.headers?.["X-OpenRouter-Title"], "Brigade");
  assert.equal(opts?.headers?.["X-OpenRouter-Categories"], "cli-agent");
});

test("wrapStreamFnWithPayloadMutations: does NOT add headers for non-OpenRouter providers", () => {
  // Anthropic / Vertex / Bedrock must be left untouched — no headers key added.
  const anthropic = captureWrappedOptions({ provider: "anthropic", id: "claude" }, {});
  assert.equal(anthropic?.headers, undefined);
  const vertex = captureWrappedOptions({ provider: "google-vertex", id: "claude" }, {});
  assert.equal(vertex?.headers, undefined);
});

test("wrapStreamFnWithPayloadMutations: caller-supplied header wins over attribution default", () => {
  const opts = captureWrappedOptions(
    { provider: "openrouter", id: "x" },
    { headers: { "HTTP-Referer": "https://override.example", "X-Custom": "1" } },
  );
  // Caller value overrides the Brigade default…
  assert.equal(opts?.headers?.["HTTP-Referer"], "https://override.example");
  // …the caller's extra header survives…
  assert.equal(opts?.headers?.["X-Custom"], "1");
  // …and the non-overridden attribution header is still present.
  assert.equal(opts?.headers?.["X-OpenRouter-Title"], "Brigade");
});

test("wrapStreamFnWithPayloadMutations: preserves a caller's headers for non-OpenRouter too", () => {
  const opts = captureWrappedOptions(
    { provider: "anthropic", id: "claude" },
    { headers: { "X-Trace": "abc" } },
  );
  // No attribution added, but the caller's own headers pass through untouched.
  assert.deepEqual(opts?.headers, { "X-Trace": "abc" });
});
