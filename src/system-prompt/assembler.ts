import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";
import { normalizeStructuredPromptSection } from "./cache-stability.js";
import { applyBudget, DEFAULT_BUDGET, type BudgetResult } from "./bootstrap-budget.js";
import { sanitizeForPromptLiteral } from "./sanitize.js";
import { formatRuntimeLine, type RuntimeParams } from "./runtime-params.js";
import {
  MEMORY_GUIDANCE,
  pickModelFamilyGuidance,
  REASONING_FORMAT_GUIDANCE,
  SKILLS_GUIDANCE,
  shouldUseReasoningFormat,
  WEB_TOOLS_GUIDANCE,
} from "./guidance.js";
import type { ContextFile } from "./types.js";
import type { BootstrapPhase } from "../workspace/state.js";

// Top-level assembler.
//
// Section order mirrors the reference layered-prompt design for every
// UNIVERSAL section that applies to Brigade today. Memory (Primitive #4) and
// Skills (Primitive #5) are now wired (## Memory / ## Skills below). Sections
// that depend on not-yet-shipped architecture are still deferred:
//
//   - Group Chat / Subagent Context (Primitive #6)
//   - Self-Update via gateway-RPC agent tools
//   - Sandbox (host-trust v1; sandbox is v3+ on the locked stack)
//   - Authorized Senders (Phase 2 multi-user)
//   - Output Directives / Messaging / Voice / Reactions / Silent Replies (Phase 3 channels)
//   - Documentation (when Brigade ships docs)
//   - Model Aliases (no alias system)
//
// Section order in this file (top to bottom):
//
//    1. Identity opener
//    2. ## Tooling
//    3. ## Tool Call Style
//    4. ## Execution Bias
//    5. ## Output Formatting           (markdown / fenced-code-block discipline)
//    6. ## Safety
//    7. ## Brigade CLI Quick Reference
//    8. ## Workspace
//    9. ## Reasoning Format            (conditional: thinking-on + non-native-reasoning model)
//   10. # Project Context              (persona files, sorted: agents, soul, identity, user, tools, bootstrap, memory)
//   11. <!-- CACHE BOUNDARY -->
//   12. # Dynamic Project Context      (HEARTBEAT.md)
//   13. # Per-turn Notes                (ephemeral suffix, when supplied)
//   14. ## Runtime                      (host / shell / model / channel / time)

export interface AssembleArgs {
  // Resolved per-turn runtime context (host, tz, model, channel, …).
  runtime: RuntimeParams;
  // Persona files loaded from <agentDir>/workspace/, in canonical order.
  personaFiles: ContextFile[];
  // HEARTBEAT.md content if present — goes below the cache boundary.
  heartbeatFile?: ContextFile;
  // Tool descriptions, ready to inject. Empty array → "no tools" line.
  toolDescriptions: ToolDescription[];
  // Optional per-turn additions (sub-agent task framing, ephemeral notes).
  // Lives below the cache boundary so it doesn't bust the prefix.
  ephemeralSuffix?: string;
  // Lifecycle phase from the workspace state file. The assembler does NOT
  // emit synthetic guidance based on this — first-turn behaviour comes
  // from BOOTSTRAP.md content alone (no per-turn branching here).
  bootstrapPhase?: BootstrapPhase;
  // Active model id. Drives `shouldUseReasoningFormat` gating for the
  // `## Reasoning Format` block. Aggregator-prefix tolerant
  // (`openrouter/openai/gpt-4o` works).
  modelId?: string;
  // Active thinking level. "off" / undefined → no reasoning format block.
  // Native-reasoning models (Claude w/ extended thinking, o1/o3) skip
  // the block regardless of level.
  thinkingLevel?: string;
  // Capability gates for conditional guidance. `memory` is WIRED
  // (Primitive #4) — when true the assembler emits the `## Memory`
  // section. `skills` (#5) is wired too. `subAgents` (#6) advertises that
  // `spawn_agent` is on the surface; `subagentMode` flips the prompt into
  // minimal-mode (we ARE the sub-agent, not the parent). Gates stay false
  // by default so the cached prefix stays small.
  capabilities?: {
    memory?: boolean;
    skills?: boolean;
    subAgents?: boolean;
    /**
     * When true, this assembled prompt is going INTO a sub-agent run. The
     * opener is swapped for the sub-agent banner; operator-only sections
     * (CLI quick reference, execution bias, memory, output formatting,
     * heartbeat, per-family identity override) are gated off; the persona
     * set is already filtered upstream to the minimal allowlist.
     */
    subagentMode?: boolean;
    /** Web tools (`fetch_url` and/or `web_search`) wired into this session.
     *  Gates the ## Web behavioural guidance + untrusted-content posture. */
    web?: boolean;
  };
  // Pre-rendered `<available_skills>` XML (Primitive #5). Discovered + filtered
  // + rendered upstream (agents/skills) and passed in; the assembler just
  // places it under `## Skills` when `capabilities.skills` is true. Lives in
  // the cached prefix — the skill list is stable within a session.
  skillsPromptBlock?: string;
}

export interface ToolDescription {
  name: string;
  summary: string;
}

export interface AssembledPrompt {
  text: string;
  budget: BudgetResult;
}

// Canonical persona file order. Files NOT in this list keep their
// original caller order at the end.
const PERSONA_CANONICAL_ORDER = [
  "agents.md",
  "soul.md",
  "identity.md",
  "user.md",
  "tools.md",
  "bootstrap.md",
  "memory.md",
];

function sortPersonaFiles(files: ContextFile[]): ContextFile[] {
  const rank = new Map(PERSONA_CANONICAL_ORDER.map((n, i) => [n, i]));
  return [...files].sort((a, b) => {
    const ra = rank.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

export function assembleSystemPrompt(args: AssembleArgs): AssembledPrompt {
  const lines: string[] = [];
  const isSubagentMode = args.capabilities?.subagentMode === true;

  // 1. Identity opener.
  // Eight words. One brand mention. No marketing nouns. An earlier
  // verbose form ("You are the user's Brigade assistant — a personal AI
  // inside their Brigade crew. Defer to the workspace persona files…")
  // taught the model to parrot "your Brigade assistant" / "personal AI
  // running inside your Brigade workspace" in conversational replies —
  // exactly the corporate-coded tone we want to avoid. Persona refinement
  // (voice, values, identity, behavioural rules) lives in IDENTITY.md /
  // SOUL.md / AGENTS.md inside `# Project Context` below — those don't
  // need to be advertised here.
  //
  // Sub-agent mode (Primitive #6): swap the opener for a banner that
  // re-frames the model as a delegated worker, not the operator-facing
  // parent. The persona files in `# Project Context` carry voice/identity;
  // the banner sets role + boundaries (return one bounded reply, do NOT try
  // to be the parent, do NOT spawn further sub-agents) AND the behavioural
  // rules that load-bear on sub-agent quality (don't initiate, be ephemeral,
  // recover from truncated output, follow the output format).
  if (isSubagentMode) {
    lines.push("# Sub-agent Context");
    lines.push("");
    lines.push("You are a SUB-AGENT running inside Brigade.");
    lines.push("");
    lines.push(
      "Your job: complete the bounded task you were spawned for, then return a single concise reply. " +
      "Your reply becomes a tool result for the parent — keep it focused on the answer, no preamble " +
      "or sign-off. The parent agent (not the user) is your caller; the user does NOT see your " +
      "intermediate output, only your final reply via the parent.",
    );
    lines.push("");
    lines.push("## Rules");
    lines.push(
      "1. **Stay focused** — do the assigned task and nothing else. No side quests, no proactive " +
      "follow-ups, no questions back to the user.",
    );
    lines.push(
      "2. **Complete the task** — your final assistant message IS the deliverable. The parent reads " +
      "it as a tool result and decides what to do next.",
    );
    lines.push(
      "3. **Don't initiate** — no greetings, no heartbeats, no \"would you like me to also …\" " +
      "questions, no proactive memory writes. You are not in a conversation; you are filling a slot.",
    );
    lines.push(
      "4. **Be ephemeral** — your session ends when you reply. Don't plan for follow-up turns; " +
      "don't promise actions you can't finish in this turn.",
    );
    lines.push(
      "5. **No further sub-agents** — even if `spawn_agent` is available, your depth has already " +
      "reached the cap. Finish the work yourself.",
    );
    lines.push(
      "6. **Recover from truncated tool output** — if you see a notice like `[... N more " +
      "characters truncated]`, prior output was reduced. Re-read only what you need using smaller " +
      "chunks (`read` with `offset` and `limit`, or targeted `grep`), not a full re-read of the file.",
    );
    lines.push(
      "7. **Don't poll** — there is no async backplane. After a tool call, the next assistant " +
      "message is the result; you don't need to wait, list, or status-check.",
    );
    lines.push("");
    lines.push("## Output Format");
    lines.push(
      "Your final reply should answer in this order: (a) what you accomplished or found, " +
      "(b) the specific details the parent needs (file:line, exact value, decision), (c) any " +
      "caveats the parent should know about. Plain prose for short results; a fenced block when " +
      "you're returning structured data (json, code). Skip the meta — no \"I'll now\", \"as " +
      "requested\", \"hope this helps\".",
    );
    lines.push("");
  } else {
    lines.push("You are a personal assistant running inside Brigade.");
    lines.push("");
  }

  // No first-turn synthetic guidance — first-turn behaviour comes from
  // BOOTSTRAP.md content alone. The earlier `**First turn: ... verbatim**`
  // nudge regressed both gpt-5.4 (over-literal bullet dumps) and Claude
  // (auto-write USER.md without asking). `bootstrapPhase` is still threaded
  // through for future per-model-family hints if a smaller model needs one.
  void args.bootstrapPhase;

  // 2. ## Tooling.
  // Tool list + universal trailing rules: TOOLS.md disclaimer, anti-poll
  // closer. The empty-list path uses Brigade's terser permissive line
  // (Pi's 14-tool hardcoded fallback bakes in tool names that may not
  // match what Brigade actually wires).
  lines.push("## Tooling");
  if (args.toolDescriptions.length === 0) {
    lines.push(
      "Tools are wired into this turn. When the user asks you to do something that needs filesystem, shell, or search access, USE the tools you have — do not tell the user you can't.",
    );
  } else {
    lines.push("Tool availability (filtered by policy):");
    for (const t of args.toolDescriptions) {
      const summary = t.summary?.trim();
      lines.push(summary ? `- ${t.name}: ${summary}` : `- ${t.name}`);
    }
    // Universal trailing rules.
    lines.push(
      "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    );
    lines.push(
      "Do not poll status/list tools in a loop; only check on demand.",
    );
  }
  lines.push("");

  // 3. ## Tool Call Style.
  // Narration rules; what we synthesise vs what we show the play-by-play
  // of. Three universal lines (keep narration brief / plain language /
  // prefer tools over CLI suggestions) were previously missing — added back.
  lines.push("## Tool Call Style");
  lines.push(
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
  );
  lines.push(
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
  );
  lines.push(
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
  );
  lines.push(
    "Use plain human language for narration unless in a technical context.",
  );
  lines.push(
    "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
  );
  lines.push("");

  // 4. ## Execution Bias.
  // "If the user asks you to do the work, start doing it" — no preambles,
  // no commentary-only turns. Previously this block quoted forbidden
  // example phrases ("I'll now read the file…", "Let me check the
  // docs…") — quoting the bad pattern gave the model permission to emit
  // it, which is the opposite of what we want. Phrased as a rule now,
  // not a quote-list.
  //
  // Tone lines (default-short / no preamble / skip-recap-on-approval)
  // are lifted from the reference's per-provider OPENAI overlay — the
  // model that needs them most. Promoting to a universal block because
  // every model benefits from "no walls of text" and the cost is just
  // four prompt lines.
  //
  // Skipped in sub-agent mode: the sub-agent has a single-shot task; it
  // doesn't field operator approvals or send "progress updates", and the
  // banner already sets the "return a focused reply" bias.
  if (!isSubagentMode) {
    lines.push("## Execution Bias");
    lines.push(
      "If the user asks you to do the work, start doing it in the same turn.",
    );
    lines.push(
      "Use a real tool call or concrete action first when the task is actionable; do not stop at a plan or promise-to-act reply.",
    );
    lines.push(
      "Commentary-only turns are incomplete when tools are available and the next action is clear.",
    );
    lines.push(
      "If the work will take multiple steps or a while to finish, send one short progress update before or while acting.",
    );
    lines.push(
      "Default to short natural replies unless the user asks for depth. Avoid walls of text, long preambles, and repetitive restatement. Friendly does not mean verbose.",
    );
    lines.push(
      "If the latest user message is a short approval like \"ok do it\" or \"go ahead\", skip the recap and start acting.",
    );
    lines.push("");
  }

  // 5. ## Output Formatting.
  // Markdown formatting rules — load-bearing for TUI rendering quality.
  // The TUI parses fenced blocks with a `highlightCode` hook that
  // syntax-colours bash / json / typescript / etc. The model gets the
  // nice rendering for free IF it emits proper fences (lang tag on its
  // own line, body on subsequent lines, closing fence). Compact single-
  // line emit like ` ```json {…} ``` ` is parsed as inline code and
  // renders flat — same content, ugly UX.
  //
  // Skipped in sub-agent mode: the sub-agent's reply becomes a tool
  // result the parent receives as plain text, so fence discipline isn't
  // load-bearing there. The parent's prompt still carries the rules and
  // the parent decides how to render the final answer.
  if (!isSubagentMode) {
    lines.push("## Output Formatting");
    lines.push(
      "For any code, JSON, shell command, configuration, or tool output longer than ~20 chars, use a fenced Markdown code block with a language tag.",
    );
    lines.push(
      "The opening fence + language tag goes on its own line; the body goes on the next line(s); the closing fence goes on its own line. NEVER put the opening fence, language, body, and closing fence on the same line.",
    );
    lines.push(
      "Use these language tags: `bash` (shell), `json`, `typescript` / `ts`, `javascript` / `js`, `python`, `sql`, `yaml`, `html`, `css`, `diff`, `text` (plain). Default to `text` when uncertain.",
    );
    lines.push(
      "Pretty-print JSON across multiple lines with 2-space indent unless the user asks for compact output — single-line `{\"a\":1,\"b\":2}` is harder to read in a chat UI.",
    );
    lines.push(
      "Inline backticks (` `x` `) are for short identifiers / file names / single-word references INSIDE a sentence — never for multi-token data like a full JSON object, a multi-flag command, or a path with a value.",
    );
    lines.push(
      "Example, correct:\n```json\n{\n  \"name\": \"…\",\n  \"value\": 42\n}\n```\nExample, wrong: `json {\"name\":\"…\",\"value\":42}`.",
    );
    lines.push("");
  }

  // 6. ## Safety.
  // Constitution-style anti-self-preservation rules. The previous
  // Brigade-shape three bullets (credentials, destructive ops, untrusted
  // content) were operator-protection rules that overlap with the
  // exec-gate already enforced at the tool layer; the lines below are
  // AI-alignment rules that the gate can't enforce and that ALL frontier
  // model providers reference in their published policies. Operator-
  // protection rules can land in TOOLS.md / USER.md when needed —
  // they're persona-scope, not always-on prompt scope.
  lines.push("## Safety");
  lines.push(
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
  );
  lines.push(
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
  );
  lines.push(
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
  );
  lines.push("");

  // 5b. Per-model-family identity override.
  // Gemini and GPT routinely identify themselves as "Gemini" / "ChatGPT"
  // until told otherwise — the family blocks at `guidance.ts:207-241`
  // explicitly override that baseline identity. We pick based on the
  // model id (raw, no provider prefix — `pickModelFamilyGuidance` handles
  // the prefix stripping). Conditional: returns null for Claude (native
  // identity is "Claude", already aligned with Anthropic) and for
  // unknown / niche models.
  //
  // Skipped in sub-agent mode: the sub-agent's identity is already
  // anchored by the persona files (SOUL/IDENTITY) + the SUB-AGENT banner.
  // It will not be addressing the user directly, so the "you are not
  // Gemini / ChatGPT" reframing isn't load-bearing.
  if (!isSubagentMode) {
    const familyBlock = pickModelFamilyGuidance(args.modelId);
    if (familyBlock) {
      lines.push(familyBlock);
      lines.push("");
    }
  }

  // 7. ## Brigade CLI Quick Reference.
  // Gateway-lifecycle only, plus a fallback line pointing at `brigade
  // help`. The earlier version enumerated eight subcommands, which
  // trained the model to suggest `brigade <foo>` in conversational
  // replies about unrelated topics. Operator-critical commands stay
  // (gateway, onboard, doctor); the rest is reachable via help-text
  // the model can ask the user to run.
  //
  // Skipped in sub-agent mode: managing the gateway daemon, onboarding,
  // and health checks are operator concerns — the sub-agent is task-
  // scoped and never needs to invoke these.
  if (!isSubagentMode) {
    lines.push("## Brigade CLI Quick Reference");
    lines.push("Brigade is controlled via subcommands. Do not invent commands.");
    lines.push("To manage the Gateway daemon (start/stop/restart):");
    lines.push("- `brigade gateway` — start the gateway in the foreground");
    lines.push("- `brigade gateway status` — probe a running gateway");
    lines.push("- `brigade gateway stop` — stop the running gateway");
    lines.push("- `brigade onboard` — interactive provider/model setup");
    lines.push("- `brigade doctor` — health checks");
    lines.push("If unsure, ask the user to run `brigade --help` (or `brigade gateway --help`) and paste the output.");
    lines.push("");
  }

  // 8. ## Workspace.
  // Deliberately terse: a long section here teaches the model to PARROT
  // the word "workspace" back at the operator in conversational replies
  // ("running inside your Brigade workspace…", "beyond the workspace
  // setup…"). Pi's session cwd already defaults to this dir so the model
  // doesn't need explicit absolute-path coaching here; the per-family
  // guidance block (guidance.ts:GOOGLE_FAMILY_GUIDANCE) handles model-
  // specific absolute-path nudges where they're actually needed. The
  // persona files themselves are injected as Project Context — listing
  // them here too is redundant noise.
  lines.push("## Workspace");
  lines.push(`Your working directory is: ${args.runtime.workspaceDir}`);
  lines.push(
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
  );
  lines.push("");

  // 7b. ## Memory (conditional on the memory capability).
  // Primitive #4. Emitted only when the session has the memory tools
  // (recall_memory / read_memory) wired — gated on `capabilities.memory`.
  // The model is told to search memory BEFORE answering and how durable
  // facts are stored. MEMORY.md itself is injected separately as a
  // persona file in `# Project Context` below — this section is the
  // behavioural wrapper.
  //
  // Skipped in sub-agent mode: long-term memory is the operator/parent's
  // concern. The sub-agent shouldn't write to it (its task is bounded)
  // and shouldn't recall from it (the parent already injected whatever
  // context the task needs as the first user message).
  if (args.capabilities?.memory && !isSubagentMode) {
    lines.push(MEMORY_GUIDANCE);
    lines.push("");
  }

  // 7c. ## Skills (conditional on the skills capability).
  // Primitive #5. Emitted only when at least one eligible skill was discovered
  // (`capabilities.skills`). SKILLS_GUIDANCE is the behavioural wrapper (scan
  // before replying, load the matching skill, patch it if wrong); the
  // pre-rendered `<available_skills>` block that follows is the actual list of
  // names + descriptions + read-tool locations. Brigade owns this render
  // (rather than Pi's auto-injection) because the persona pin replaces Pi's
  // prompt-build hook, so the assembled prompt carries the skills section.
  //
  // Skipped in sub-agent mode: skills are operator-workspace metadata and add
  // significant token bloat. The parent already injected whatever context the
  // sub-agent needs as the first user message; a scoped task gets the answer
  // through its bounded tool surface, not the full skill index.
  if (args.capabilities?.skills && !isSubagentMode) {
    lines.push(SKILLS_GUIDANCE);
    lines.push("");
    if (args.skillsPromptBlock && args.skillsPromptBlock.trim().length > 0) {
      lines.push(args.skillsPromptBlock.trim());
      lines.push("");
    }
  }

  // 7d. ## Web (conditional on web tools being wired this turn).
  // Three-layer steering: rich per-tool `description:` fields carry the
  // bulk of the decision tree (visible every turn in the tool-use
  // schema); the universal `## Tool Call Style` rule reinforces
  // "use first-class tools directly"; this block adds the loop budget,
  // untrusted-content posture, and skip patterns. The combination is
  // belt-and-suspenders — caught a real "model picks web_search instead
  // of browser" regression we saw on the Coimbatore / Srikakulam runs.
  if (args.capabilities?.web) {
    lines.push(WEB_TOOLS_GUIDANCE);
    lines.push("");
  }

  // 9. ## Reasoning Format.
  // ONLY emitted when `thinkingLevel` is on AND the model isn't a
  // native-reasoning family (Claude w/ extended thinking, o1/o3 — those
  // manage reasoning natively and adding tag rules would conflict).
  if (shouldUseReasoningFormat(args.modelId, args.thinkingLevel)) {
    lines.push(REASONING_FORMAT_GUIDANCE);
    lines.push("");
  }

  // 10. # Project Context — STABLE persona files (above the cache boundary).
  // The previous Brigade version ("...canonical description of the
  // agent's identity, values, and ways of working.") taught the model to
  // echo those four nouns in replies; the current preamble is bland on
  // purpose. The SOUL.md tone-nudge fires only when soul.md is in the
  // persona set; smaller models tend to skim past SOUL.md without it.
  // Sort canonically so cache-hits stay stable across turns even if the
  // loader's order varies.
  if (args.personaFiles.length > 0) {
    lines.push("# Project Context");
    lines.push("The following project context files have been loaded:");
    const hasSoulFile = args.personaFiles.some(
      (f) => f.name.toLowerCase() === "soul.md",
    );
    if (hasSoulFile) {
      lines.push(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
      );
    }
    lines.push("");

    const sorted = sortPersonaFiles(args.personaFiles);
    const budget = applyBudget(sorted, DEFAULT_BUDGET);
    for (const file of budget.files) {
      // Strip the trailing `.md` so headings read `## AGENTS` rather than
      // the typo-looking `## AGENTS.MD`. The source path comment retains
      // the full filename for traceability.
      const heading = file.name.replace(/\.md$/i, "").toUpperCase();
      lines.push(`## ${heading}`);
      lines.push(`<!-- source: ${file.path} -->`);
      lines.push(normalizeStructuredPromptSection(file.content));
      lines.push("");
    }

    // 10. CACHE BOUNDARY.
    // Everything above here is stable and gets prompt-cache-hit on
    // Anthropic. Below, every-turn dynamic stuff (heartbeat, ephemeral
    // notes, runtime line).
    lines.push(CACHE_BOUNDARY_MARKER_LINE);
    lines.push("");

    // 11. # Dynamic Project Context — HEARTBEAT.md (below boundary).
    // HEARTBEAT.md changes per cycle so it's deliberately below the
    // cache marker. Skipped in sub-agent mode: heartbeat is the parent's
    // cycle state (last operator activity, mode, time-since), which
    // doesn't belong in a task-scoped child's context.
    if (args.heartbeatFile && !isSubagentMode) {
      lines.push("# Dynamic Project Context");
      lines.push("");
      lines.push("## HEARTBEAT");
      lines.push(`<!-- source: ${args.heartbeatFile.path} -->`);
      lines.push(normalizeStructuredPromptSection(args.heartbeatFile.content));
      lines.push("");
    }

    // 12. # Per-turn Notes — sub-agent task framing or ephemeral context.
    // Brigade-specific addition for single-user v1 (a group/subagent
    // context section would serve the same niche). Stays below the
    // cache marker.
    if (args.ephemeralSuffix && args.ephemeralSuffix.trim()) {
      lines.push("# Per-turn Notes");
      lines.push(sanitizeForPromptLiteral(args.ephemeralSuffix));
      lines.push("");
    }

    // 13. ## Runtime.
    // The trailing `Reasoning:` line lets the model know whether its
    // <think> output will be visible to the operator. Brigade omits the
    // `/thinking` and `/status` slash mentions because the TUI header
    // already exposes the level.
    lines.push("## Runtime");
    lines.push(formatRuntimeLine(args.runtime));
    lines.push(
      `Reasoning: ${args.thinkingLevel} (hidden unless on/stream).`,
    );

    return {
      text: lines.join("\n"),
      budget,
    };
  }

  // Fallback: no persona files. Still emit the cache boundary + runtime
  // so prompt caching works on the (very small) stable prefix.
  lines.push(CACHE_BOUNDARY_MARKER_LINE);
  lines.push("");
  if (args.heartbeatFile && !isSubagentMode) {
    lines.push("# Dynamic Project Context");
    lines.push("");
    lines.push("## HEARTBEAT");
    lines.push(normalizeStructuredPromptSection(args.heartbeatFile.content));
    lines.push("");
  }
  if (args.ephemeralSuffix && args.ephemeralSuffix.trim()) {
    lines.push("# Per-turn Notes");
    lines.push(sanitizeForPromptLiteral(args.ephemeralSuffix));
    lines.push("");
  }
  lines.push("## Runtime");
  lines.push(formatRuntimeLine(args.runtime));

  return {
    text: lines.join("\n"),
    budget: { files: [], diagnostics: [], totalChars: 0 },
  };
}
