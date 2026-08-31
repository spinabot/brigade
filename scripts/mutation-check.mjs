#!/usr/bin/env node
// scripts/mutation-check.mjs — does the suite actually defend what we claim?
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// A passing test suite is not evidence that a feature works. It is evidence
// that the tests pass. Those are the same thing only when a broken feature
// would make a test fail — and twice now that was not true here:
//
//   • `transformContext` was passed to `createAgentSession`, which does not
//     read it. Brigade's ENTIRE message-transform chain never executed in
//     production. Every unit test passed, because each called the chain
//     directly and asserted the function does what it says. None asserted
//     that Pi ever calls it.
//
//   • The MCP tool-plane skipped `prepareArguments`, so `edit` failed on the
//     claude-cli harness for two shapes real models emit and succeeded
//     natively. The first test written for the fix re-implemented the plane's
//     logic inside the test — it proved the concept and nothing about the
//     wiring, and this harness caught that within a minute.
//
// So: break each claim on purpose, run its tests, and see whether anything
// notices. A claim nothing notices is a claim with no evidence behind it.
//
// ─────────────────────────────────────────────────────────────────────────────
// READING THE OUTPUT
// ─────────────────────────────────────────────────────────────────────────────
//   CAUGHT          the suite failed when the feature broke — the claim is defended.
//   MISSED          the suite passed with the feature broken — no evidence. Fix
//                   the TEST, not the code.
//   ANCHOR-MISSING  the code moved; update the mutation below or delete it.
//
// A MISSED is not automatically a bug. `neverGrow` is deliberately unreachable
// under current limits — a guard rail, not a branch — and is annotated as such.
// But every MISSED must be explained, not tolerated by default.
//
// Usage:  node scripts/mutation-check.mjs [substring-filter]
// This is a diagnostic, not part of `npm test`: it runs the suite once per
// mutation and takes minutes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * Each entry: a claim, the single edit that falsifies it, and the tests that
 * should notice. Keep `find` anchored on something semantically load-bearing —
 * a mutation that only breaks a comment proves nothing.
 *
 * `expectMissed` marks a mutation that provably CANNOT be killed, with the
 * reason. Use it sparingly and never to paper over a real gap.
 */
const MUTATIONS = [
  // ── Pi boundary: the class of bug that shipped dead features twice ──
  {
    claim: "the transform chain is installed on Pi at all",
    file: "src/agents/payload-mutators.ts",
    find: "  const piOwn = agent.transformContext;",
    replace: "  const piOwn = agent.transformContext; if (1) return;",
    tests: "src/agents/transform-context-install.test.ts",
  },
  {
    claim: "Brigade's tool guard composes with Pi's extension bridge",
    file: "src/agents/pi-hooks.ts",
    find: "\t\tif (!piOwn) return verdict;",
    replace: "\t\tif (piOwn === undefined || true) return verdict;",
    tests: "src/agents/pi-hooks.test.ts",
  },
  {
    claim: "a blocked call never reaches extension code",
    file: "src/agents/pi-hooks.ts",
    find: "\t\tif ((verdict as { block?: boolean } | undefined)?.block) return verdict;",
    replace: "\t\tif (false) return verdict;",
    tests: "src/agents/pi-hooks.test.ts",
  },
  {
    claim: "the MCP plane prepares tool args before validating",
    file: "src/agents/mcp/route.ts",
    find: "\t\t\tconst prepared = prepareToolCallArguments(tool, args);",
    replace: "\t\t\tconst prepared = args;",
    tests: "src/agents/mcp/route.prepare.test.ts",
  },

  {
    claim: "the transcript repair understands Pi's tool-call shape",
    file: "src/sessions/transcript-repair.ts",
    find: '  if (b.type !== WIRE_TOOL_USE && b.type !== "toolUse" && b.type !== PI_TOOL_CALL) return null;',
    replace: '  if (b.type !== WIRE_TOOL_USE && b.type !== "toolUse") return null;',
    tests: "src/agents/transform-chain-safety.test.ts",
  },
  {
    // Pi DELETES aborted/errored assistants before sending. Synthesising a
    // result for their tool calls orphans it — a hard 400 on every provider,
    // permanently, from a single Ctrl+C.
    claim: "an interrupted turn does not orphan a synthetic tool result",
    file: "src/sessions/transcript-repair.ts",
    find: '      if (stopReason === "error" || stopReason === "aborted") continue;',
    replace: "      void stopReason;",
    tests: "src/agents/transform-chain-safety.test.ts",
  },
  {
    claim: "a repaired transcript is emitted in Pi's dialect, not Anthropic's",
    file: "src/sessions/transcript-repair.ts",
    find: '        if (isToolCall(block)) {',
    replace: "        if (false) {",
    tests: "src/agents/transform-chain-safety.test.ts",
  },
  {
    // `Agent.state.messages` IS the live transcript. While the chain was dead,
    // an in-place edit was harmless; running on every request it would corrupt
    // the session permanently. This mutation makes one pass write through.
    claim: "the transform chain never mutates the live transcript",
    file: "src/agents/payload-mutators.ts",
    // Anchored on the surrounding line: `return { ...m, content };` appears
    // twice in this file (thinking-strip and the OpenAI-Responses downgrade),
    // and a bare string replace silently hits only the first.
    find: "    // the message bare.\n    const content = filtered.length > 0 ? filtered : [{ type: \"text\", text: \"\" }];\n    return { ...m, content };",
    replace: "    // the message bare.\n    const content = filtered.length > 0 ? filtered : [{ type: \"text\", text: \"\" }];\n    Object.assign(m, { content }); return m;",
    tests: "src/agents/transform-chain-safety.test.ts",
  },

  {
    // Anthropic's interleaved-thinking beta requires signed thinking blocks to
    // be replayed across every step of a tool loop; Pi's own converter keeps
    // them for the same model.
    claim: "signed thinking blocks survive a tool loop on Anthropic",
    file: "src/agents/payload-mutators.ts",
    find: "      return typeof b.thinkingSignature === \"string\" && b.thinkingSignature !== \"\";",
    replace: "      return false;",
    tests: "src/agents/transform-chain-safety.test.ts",
  },

  {
    // Shipped as opt-OUT: every client got `message.content` stripped unless it
    // knew to say `deltas: false`. Anyone who had never heard of deltas — the
    // desktop app, the watch app, npm consumers — rendered empty streaming text.
    claim: "delta frames are opt-IN, so existing clients are unaffected",
    file: "src/core/delta-mode.ts",
    find: "\treturn d.optedIn;",
    replace: "\treturn true;",
    tests: "src/core/delta-stream.test.ts",
  },
  {
    claim: "every live slash alias still submits on one Enter",
    file: "src/ui/editor.ts",
    find: '\t"clip", // alias of /clipboard — no arg',
    replace: "",
    tests: "src/ui/editor.test.ts",
  },

  {
    claim: "subscription scope opt-out restores pre-narrowing breadth",
    file: "src/core/ws-subscription-filter.ts",
    find: '\tif (scope === "session" && narrowedForThisAgent && sessionId) return inSessionSubs(sessionId);',
    replace: "\tif (narrowedForThisAgent && sessionId) return inSessionSubs(sessionId);",
    tests: "src/core/ws-subscription-filter.test.ts",
  },
  {
    // Pi drops every field outside its fixed seven. A BrigadeTool field that is
    // neither carried by Pi nor consumed by Brigade vanishes with no symptom.
    claim: "a new BrigadeTool field cannot silently cross the Pi boundary",
    file: "src/agents/tools/pi-tool-boundary.ts",
    find: '\treturn fieldsPiWillDrop(tool).filter((k) => !local.has(k));',
    replace: "\treturn [];",
    tests: "src/agents/tools/pi-tool-boundary.test.ts",
  },
  {
    // A sessionId UUID is not a routing key; billing to one lands spend on a
    // row nothing displays. That mistake lost compaction cost once already.
    claim: "background sweep spend is billed to a real key, never a UUID",
    file: "src/agents/usage/maintenance-key.ts",
    find: "	if (causedBySessionKey && causedBySessionKey.startsWith(`agent:${agentId}:`)) {",
    replace: "	if (causedBySessionKey) {",
    tests: "src/agents/usage/maintenance-key.test.ts",
  },

  {
    // Brigade was alone in shrinking newest-first. Every other harness protects
    // the newest result — the one the model is about to reason about.
    claim: "the newest tool result is protected; the oldest is shrunk first",
    file: "src/agents/smart-compaction.ts",
    find: "    const ordered = [...slots].sort((a, b) => a.mi - b.mi || a.bi - b.bi);",
    replace: "    const ordered = [...slots].sort((a, b) => b.mi - a.mi || b.bi - a.bi);",
    tests: "src/agents/smart-compaction.test.ts",
  },
  {
    // Rewriting an old result busts the prompt-cache prefix. Doing it for a
    // trivial saving is a bad trade every time.
    claim: "a trivial reclaim does not bust the prompt cache",
    file: "src/agents/smart-compaction.ts",
    find: "  const worthReclaiming = aggregateReducibleChars >= MIN_AGGREGATE_RECLAIM_CHARS;",
    replace: "  const worthReclaiming = true;",
    tests: "src/agents/smart-compaction.test.ts",
  },
  {
    // A flat 64KB ceiling left a 1M-token model ~2.5% of its window for tool
    // output — effectively "delete everything" on the roomiest models.
    claim: "the aggregate budget scales with the context window",
    file: "src/agents/smart-compaction.ts",
    find: "  if (ctxTokens >= 500_000) return 512_000;",
    replace: "  if (ctxTokens >= 500_000) return DEFAULT_AGGREGATE_CAP;",
    tests: "src/agents/smart-compaction.test.ts",
  },
  {
    // Re-summarizing a summary is the telephone game — each cycle paraphrases a
    // paraphrase until the exact paths and error strings are gone.
    claim: "a prior summary is never re-summarized",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "\t\tconst { priorSummary: markerSummary, rest } = splitPriorSummary(",
    replace: "\t\tconst markerSummary = undefined; const rest = messages.slice(0, keptFromIndex); void splitPriorSummary(",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },

  {
    // Steering injects into a turn in flight; queueing waits for a boundary.
    // The irreversible one must not be on the reflex key.
    claim: "a plain Enter mid-turn queues rather than steering",
    file: "src/core/steer-delivery.ts",
    find: '\treturn deliverAs === "followUp" ? "followUp" : "steer";',
    replace: '\treturn "steer";',
    tests: "src/core/server-steer.test.ts",
  },
  {
    claim: "Ctrl+Enter is the only key that can steer",
    file: "src/ui/editor.ts",
    find: '\t\t\t(matchesKey(data, "ctrl+enter") || matchesKey(data, "super+enter"))',
    replace: '\t\t\t(matchesKey(data, "enter") || matchesKey(data, "ctrl+enter"))',
    tests: "src/ui/editor.test.ts",
  },

  {
    // `clearQueue()` has already emptied Pi, so anything not yet re-delivered
    // exists only in a local array. Dropping it silently destroys the
    // operator's messages.
    claim: "a failed queue flush restores what it could not deliver",
    file: "src/core/flush-queue.ts",
    find: "\t\t\t\tawait session.followUp(text);",
    replace: "\t\t\t\tvoid text;",
    tests: "src/core/flush-queue.test.ts",
  },
  {
    claim: "explicit steering keeps its head start over promoted follow-ups",
    file: "src/core/flush-queue.ts",
    find: "\tconst promoted = [...drained.steering, ...drained.followUp];",
    replace: "\tconst promoted = [...drained.followUp, ...drained.steering];",
    tests: "src/core/flush-queue.test.ts",
  },

  {
    // An export is built from raw tool output — `env`, a read `.env`, a curl
    // with an Authorization header — and is a file people attach to tickets.
    claim: "exported transcripts are redacted before they hit disk",
    file: "src/ui/transcript-redact.ts",
    find: "\t\tif (hits > 0) counts[rule.name] = hits;",
    replace: "\t\tif (hits > 0) counts[rule.name] = hits;\n\t\tout = text;",
    tests: "src/ui/transcript-redact.test.ts",
  },
  {
    // The filename is joined to a directory and the session key is
    // caller-influenced.
    claim: "an export filename cannot traverse out of its directory",
    file: "src/ui/transcript-export.ts",
    find: '\t\t.replace(/[^\\w-]+/g, "-")',
    replace: '\t\t.replace(/[^\\w.-]+/g, "-")',
    tests: "src/ui/transcript-export.test.ts",
  },
  {
    claim: "thinking is excluded from an export by default",
    file: "src/ui/transcript-export.ts",
    find: "\t\t\tif (opts.includeThinking && thinking.length > 0) {",
    replace: "\t\t\tif (thinking.length > 0) {",
    tests: "src/ui/transcript-export.test.ts",
  },

  {
    // Claude Code's rewind loses multi-day sessions because its compaction
    // boundary has no parent link — measured at 21.4% of history reachable
    // instead of 96.4%. Brigade refuses rather than showing a truncated view.
    claim: "a severed compaction blocks rewind instead of truncating history",
    file: "src/sessions/rewind.ts",
    find: "\t\tif (!isFirst && (e.parentId === null || e.parentId === undefined)) return e;",
    replace: "\t\tvoid isFirst;",
    tests: "src/sessions/rewind.test.ts",
  },
  {
    claim: "rewind reports files it did not revert",
    file: "src/sessions/rewind.ts",
    find: "\t\t\tif (typeof p === \"string\" && p.trim()) files.add(p.trim());",
    replace: "\t\t\tvoid p;",
    tests: "src/sessions/rewind.test.ts",
  },
  {
    claim: "the rewind picker offers only the operator's own messages",
    file: "src/sessions/rewind.ts",
    find: "\t\tconst isUser = e.role === \"user\" || e.type === \"user\";",
    replace: "\t\tconst isUser = true;",
    tests: "src/sessions/rewind.test.ts",
  },

  {
    // A turn used to compact AT MOST ONCE, ever — so the long tool loop this
    // feature exists for overflowed anyway on its second fill.
    claim: "a second overflow in the same turn compacts again",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "\t\t\tif (!stillOver.should || disabled) {",
    replace: "\t\t\tif (true) {",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },
  {
    // The rolling slot was unreachable: the summary lives in a request-time
    // view that never re-enters `messages`, so a marker scan found nothing.
    claim: "a repeat compaction folds the previous summary forward",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "\t\tconst priorSummary = carriedSummary ?? markerSummary;",
    replace: "\t\tconst priorSummary = markerSummary;",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },

  // ── PDF font embedding ──
  {
    claim: "a PDF that cannot subset its font still saves",
    file: "src/agents/tools/doc-shared.ts",
    find: "\tconst subset = await canSubsetFont(ttf, fontkit);\n\treturn pdf.embedFont(new Uint8Array(ttf), { subset });",
    replace: "\treturn pdf.embedFont(new Uint8Array(ttf), { subset: true });",
    tests: "src/agents/tools/make-document-tool.test.ts",
  },

  // ── Pi/Anthropic dialect boundary ──
  {
    claim: "the Pi and Anthropic tool dialects stay distinct",
    file: "src/agents/pi-dialect.ts",
    find: "\treturn isObject(block) && block.type === TOOL_CALL_TYPE;",
    replace: "\treturn isObject(block) && (block.type === TOOL_CALL_TYPE || block.type === WIRE_TOOL_USE);",
    tests: "src/agents/pi-dialect.test.ts",
  },
  {
    claim: "a hand-rolled dialect cast cannot be reintroduced silently",
    file: "src/agents/pi-dialect.lint.test.ts",
    find: "\t\tif (!source.includes(\"pi-dialect.js\")) {",
    replace: "\t\tif (false) {",
    tests: "src/agents/pi-dialect.lint.test.ts",
    expectMissed: true,
    reason: "self-referential: the claim IS the test, so disabling it cannot fail it. Verified by hand instead — a new file using \"tool_use\" without the import fails the rule by name.",
  },

  // ── Mid-turn compaction ──
  {
    claim: "mid-turn compaction fires inside a tool loop",
    file: "src/agents/compaction/mid-turn.ts",
    find: '\t\tif (m?.role !== PI_TOOL_RESULT && blockResultIds.length === 0) continue;',
    replace: '\t\tif (m?.role !== "user") continue;',
    tests: "src/agents/compaction/mid-turn.test.ts",
  },
  {
    claim: "the cut never orphans a tool result from its call",
    file: "src/agents/compaction/mid-turn.ts",
    find: "\t\tfor (let j = k + 1; j <= i && j < unsafe.length; j += 1) unsafe[j] = true;",
    replace: "\t\tvoid k;",
    tests: "src/agents/compaction/mid-turn.test.ts",
  },
  {
    claim: "a compaction that reclaims almost nothing is declined",
    file: "src/agents/compaction/mid-turn.ts",
    find: "\tif (total > 0 && replaced / total < MIN_RECLAIM_RATIO) {",
    replace: "\tif (false) {",
    tests: "src/agents/compaction/mid-turn.test.ts",
  },
  {
    claim: "a rewritten history invalidates the cached compaction",
    file: "src/agents/compaction/mid-turn.ts",
    find: "\treturn fingerprintBoundary(messages, compaction.keptFromIndex) === compaction.boundaryFingerprint;",
    replace: "\treturn true;",
    tests: "src/agents/compaction/mid-turn.test.ts",
  },
  {
    claim: "the summary never creates two consecutive user turns",
    file: "src/agents/compaction/mid-turn.ts",
    find: '\tif (first?.role === "user" && Array.isArray(first.content)) {',
    replace: "\tif (false) {",
    tests: "src/agents/compaction/mid-turn.test.ts",
  },
  {
    claim: "a synthesised header carries a timestamp",
    file: "src/agents/compaction/mid-turn.ts",
    find: "\t\ttimestamp: compaction.at,",
    replace: "",
    tests: "src/agents/compaction/mid-turn.test.ts",
  },
  {
    claim: "tool-call arguments reach the summarizer",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "const rawArgs = anyDialectToolArguments(b) ?? b?.args;",
    replace: "const rawArgs = b?.args;",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },
  {
    claim: "recovered ground truth is stripped of markdown/injection structure",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: '\t\t.replace(/[`<>#*_[\\]]/g, "")',
    replace: "",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },
  {
    claim: "the recovery block is count-bounded",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "const MAX_RECOVERED_PATHS = 40;",
    replace: "const MAX_RECOVERED_PATHS = 100000;",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },
  {
    claim: "transcript elision is surrogate-safe",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "\tconst head = sanitizeSurrogates(full.slice(0, half));\n\tconst tail = sanitizeSurrogates(full.slice(full.length - half));",
    replace: "\tconst head = full.slice(0, half);\n\tconst tail = full.slice(full.length - half);",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },
  {
    claim: "a failed summarization falls back to a deterministic reduction",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "\tconst useFallback = options.deterministicFallback ?? true;",
    replace: "\tconst useFallback = false;",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },
  {
    claim: "the summarization timeout default is sane",
    file: "src/agents/compaction/mid-turn-runner.ts",
    find: "export const MID_TURN_TIMEOUT_MS_DEFAULT = 120_000;",
    replace: "export const MID_TURN_TIMEOUT_MS_DEFAULT = 999_999_999;",
    tests: "src/agents/compaction/mid-turn-runner.test.ts",
  },

  // ── Event routing and metering ──
  {
    claim: "compaction frames are tagged with the session KEY, not the transcript uuid",
    file: "src/agents/compaction/mid-turn-envelope.ts",
    find: "\t\tsessionId: args.sessionKey,",
    replace: '\t\tsessionId: "3f8c1e2a-0b44-4c9e-9a11-77d2f0e5b6c3",',
    tests: "src/agents/compaction/mid-turn-envelope.test.ts",
  },
  {
    claim: "compaction frames are marked synthetic so the bus forwards them",
    file: "src/agents/compaction/mid-turn-envelope.ts",
    find: "\t\tsynthetic: true,",
    replace: "\t\tsynthetic: false as true,",
    tests: "src/agents/compaction/mid-turn-envelope.test.ts",
  },
  {
    claim: "zero cost with tokens spent is UNKNOWN, never free",
    file: "src/agents/memory/extract.ts",
    find: "\t\tcostKnown: cost > 0 || input + output === 0,",
    replace: "\t\tcostKnown: true,",
    tests: "src/agents/memory/isolated-usage.test.ts",
  },

  // ── Tool-result compaction ──
  {
    claim: "a hostile tool name cannot escape the truncation marker",
    file: "src/agents/smart-compaction.ts",
    find: '  return trimmed.replace(/[^\\w.:-]/g, "").slice(0, MAX_TOOL_NAME_CHARS);',
    replace: "  return trimmed;",
    tests: "src/agents/smart-compaction.test.ts",
  },
  {
    claim: "the compaction breaker cannot latch permanently",
    file: "src/agents/smart-compaction.ts",
    find: "\t\tif (since !== undefined && this.now() - since >= this.cooldownMs) {",
    replace: "\t\tif (false) {",
    tests: "src/agents/smart-compaction.breaker.test.ts",
  },
  {
    claim: "truncation never returns more than it was given",
    file: "src/agents/smart-compaction.ts",
    find: "  if (truncated.length <= original.length) return truncated;",
    replace: "  if (true) return truncated;",
    tests: "src/agents/smart-compaction.test.ts",
    // UNKILLABLE BY CONSTRUCTION, and that is the point. Reaching this branch
    // needs the built output to exceed the ORIGINAL, i.e. a result shorter than
    // the ~79-char marker while also longer than `targetLen` — but `targetLen`
    // is floored at 200 by `resolveToolResultMaxChars`, and the one input that
    // used to reach it (a 50 KB tool name) is now cut off upstream by
    // `safeToolName`. Kept as a guard rail against a future caller lowering the
    // floor or growing the marker. Do not build behaviour on top of it.
    expectMissed: "unreachable under current limits; deliberate guard rail",
  },
];

const filter = process.argv[2];
const selected = filter
  ? MUTATIONS.filter((m) => m.claim.toLowerCase().includes(filter.toLowerCase()))
  : MUTATIONS;

if (selected.length === 0) {
  console.error(`No claim matches ${JSON.stringify(filter)}.`);
  process.exit(2);
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runOne(m) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");
  const before = sha(path);
  if (!original.includes(m.find)) return "ANCHOR-MISSING";
  try {
    writeFileSync(path, original.replace(m.find, m.replace), "utf8");
    const r = spawnSync("npx", ["tsx", "--test", ...m.tests.split(/\s+/)], {
      cwd: ROOT,
      shell: true,
      encoding: "utf8",
      stdio: "pipe",
    });
    return r.status !== 0 ? "CAUGHT" : "MISSED";
  } finally {
    // ALWAYS restore, then prove it. A harness that can corrupt the tree it is
    // auditing is worse than no harness.
    writeFileSync(path, original, "utf8");
    if (sha(path) !== before) {
      console.error(`\nFATAL: failed to restore ${m.file}. Check your working tree.`);
      process.exit(3);
    }
  }
}

const results = [];
for (const m of selected) {
  const status = runOne(m);
  results.push({ ...m, status });
  const expected = status === "CAUGHT" || (status === "MISSED" && m.expectMissed);
  console.log(`${expected ? " " : "!"} ${status.padEnd(15)} ${m.claim}`);
}

const unexpected = results.filter(
  (r) => r.status !== "CAUGHT" && !(r.status === "MISSED" && r.expectMissed),
);
const defended = results.filter((r) => r.status === "CAUGHT").length;

console.log("\n" + "=".repeat(72));
console.log(`${defended}/${results.length} claims defended by tests`);
for (const r of results.filter((x) => x.expectMissed && x.status === "MISSED")) {
  console.log(`  (expected) ${r.claim} — ${r.expectMissed}`);
}
for (const r of unexpected) {
  console.log(`  ${r.status}: ${r.claim}  (${r.file} → ${r.tests})`);
}
if (unexpected.length > 0) {
  console.log("\nA MISSED means the tests pass while the feature is broken.");
  console.log("Fix the TEST, not the code — the code is already right.");
}
process.exit(unexpected.length > 0 ? 1 : 0);
