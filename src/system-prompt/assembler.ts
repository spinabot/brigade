import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";
import { normalizeStructuredPromptSection } from "./cache-stability.js";
import { applyBudget, DEFAULT_BUDGET, type BudgetResult } from "./bootstrap-budget.js";
import { sanitizeForPromptLiteral } from "./sanitize.js";
import { formatRuntimeLine, type RuntimeParams } from "./runtime-params.js";
import {
  DELEGATION_CASCADE_GUIDANCE,
  MEDIA_GUIDANCE,
  MEMORY_GUIDANCE,
  ORG_AWARENESS_GUIDANCE,
  pickModelFamilyGuidance,
  REASONING_FORMAT_GUIDANCE,
  SKILLS_GUIDANCE,
  shouldUseReasoningFormat,
  SUB_AGENTS_GUIDANCE,
  TIME_GROUNDING_GUIDANCE,
  WEB_TOOLS_GUIDANCE,
} from "./guidance.js";
import { renderOrgBlock } from "./org/render-org-block.js";
import { resolveOutputFormattingDirective } from "./identity-defaults.js";
import type { ContextFile } from "./types.js";
import type { BootstrapPhase } from "../workspace/state.js";
import type { OrgGraph } from "../agents/org/types.js";

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
    /**
     * When true, this assembled prompt is going INTO a cron-triggered run.
     * Same operator-only section gating as `subagentMode`, but uses a
     * different opener so the model knows it's running unattended on a
     * schedule (not delegated by a parent). The two flags are mutually
     * exclusive in practice — a cron-fired turn won't also be a sub-agent.
     */
    cronMode?: boolean;
    /** Web tools (`fetch_url` and/or `web_search`) wired into this session.
     *  Gates the ## Web behavioural guidance + untrusted-content posture. */
    web?: boolean;
  };
  // Pre-rendered `<available_skills>` XML (Primitive #5). Discovered + filtered
  // + rendered upstream (agents/skills) and passed in; the assembler just
  // places it under `## Skills` when `capabilities.skills` is true. Lives in
  // the cached prefix — the skill list is stable within a session.
  skillsPromptBlock?: string;
  /**
   * Active channel surface for this turn. When the gateway has started
   * channel adapters (WhatsApp, Slack, Telegram, …), the agent needs to
   * SEE that list in the system prompt — otherwise asked "send a WhatsApp
   * to +91…" it falls back to bash-probing `brigade doctor` like the user
   * caught it doing. The assembler emits a `## Channels` block listing
   * each started channel by id; the `send_message` tool's `channel` enum
   * is what the model actually invokes from there.
   *
   * `currentChannel` (when set) marks "this turn came IN through this
   * channel" so the model knows what reply-in-place means (and `send_message`
   * auto-fills accordingly).
   *
   * Empty list / undefined → no `## Channels` section emitted (cron-mode
   * and sub-agent-mode also skip this section regardless — they get a
   * scoped tool surface, not the operator's full channel directory).
   */
  channels?: {
    /** Channel ids currently started + ready to send. */
    started: readonly string[];
    /**
     * Channels that are REGISTERED (bundled adapters) but NOT currently
     * connected — i.e. the operator COULD connect them via `connect_channel`.
     * Reflects real config state: `connectable` true means the adapter is
     * available to wire up. Surfaced in the `## Messaging` block so the model
     * knows it can OFFER to connect e.g. Telegram (instead of claiming it
     * can't message there). Skipped for channels already in `started`.
     */
    available?: ReadonlyArray<{
      channelId: string;
      label: string;
      /** True when the channel can be connected right now (registered + not started). */
      connectable: boolean;
    }>;
    /** Linked self-account per started channel (adapter `selfId()`), when
     *  connected. For personal channels (WhatsApp) the linked account IS
     *  the operator's own number — surfaced so "send me a text" resolves
     *  without the model asking the operator for a number it already has.
     *  Digits-only E.164 for WhatsApp; channel-native id elsewhere. */
    linked?: ReadonlyArray<{
      channelId: string;
      selfId: string;
    }>;
    /** Channels that started but are currently in a degraded state (logged-
     *  out, disconnected, etc.). Surfaced in the `## Messaging` block so
     *  the model warns the operator BEFORE picking one — without this, the
     *  model picks WhatsApp confidently, `send_message` refuses with an
     *  opaque error, and the operator wonders why nothing arrived. Each
     *  entry carries the operator-facing reason + an optional remediation
     *  CLI hint. */
    degraded?: ReadonlyArray<{
      channelId: string;
      reason: string;
      remediation?: string;
    }>;
    /** When the inbound came from a channel, which channel + peer. Used
     *  to phrase the per-turn "you are responding to <channel>" context. */
    currentChannel?: {
      channelId: string;
      conversationId?: string;
      threadId?: string;
    };
  };
  /**
   * Stage-B virtual-office layer. The derived org graph from
   * `deriveOrgGraph(cfg)` — UNDEFINED in legacy mode (cfg.org absent),
   * in which case the assembler emits ZERO new bytes. When defined,
   * the assembler renders a `## Org` section (or, in sub-agent mode,
   * a one-line anchor inside the ephemeral suffix) so the model knows
   * its place in the operator's org chart.
   *
   * The graph is computed UPSTREAM (in agent-loop.ts) so the assembler
   * stays pure — no config-reads inside the render path. When the
   * caller passes `orgGraph: undefined`, this is a zero-cost no-op
   * (the additive-conditional invariant the Stage-B contract pins).
   */
  orgGraph?: OrgGraph;
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
  const isCronMode = args.capabilities?.cronMode === true;
  // Both modes share the operator-only-sections-gate-off shape. The opener
  // differs (sub-agent vs cron banner); everything else collapses to one
  // "minimal mode" check so the gates below don't need to know which kind
  // triggered the minimal layout.
  const isMinimalMode = isSubagentMode || isCronMode;

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
      "5. **Sub-agents below you** — the `spawn_agent` and `spawn_agents` tools may be available if " +
      "your depth is still below the cap. Use them sparingly: nest only when the work decomposes " +
      "into INDEPENDENT sub-tasks. If `spawn_agent`/`spawn_agents` are missing from your tool list, " +
      "you've reached the cap — finish the work yourself.",
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
  } else if (isCronMode) {
    lines.push("# Scheduled Task Context");
    lines.push("");
    lines.push("You are a SCHEDULED TASK running unattended inside Brigade.");
    lines.push("");
    lines.push(
      "Your job: complete the task as defined by your first user message, then return a final " +
      "assistant reply. The operator is NOT online — your reply is captured to the run log and " +
      "(when delivery is configured) sent to the operator's channel. No one is on the other end " +
      "to answer questions or approve mid-run prompts.",
    );
    lines.push("");
    lines.push("## Rules");
    lines.push(
      "1. **Do the work, then stop** — the task message tells you exactly what to do. Don't " +
      "expand scope, don't add nice-to-haves, don't ask for confirmation.",
    );
    lines.push(
      "2. **No questions back** — there is no human to answer. If something is ambiguous, pick " +
      "the most sensible interpretation and proceed; explain the choice in your final reply.",
    );
    lines.push(
      "3. **Stay in your tool surface** — this run is unattended, so owner-only tools (e.g. " +
      "`composio`) are REFUSED at call time unless the schedule was created with `runAsOwner:true`. " +
      "If you hit such a refusal, don't retry — surface it in your reply and suggest the remedy: " +
      "recreate the cron with `runAsOwner:true`, or run the task from the operator's main session.",
    );
    lines.push(
      "4. **Be self-contained** — no \"I'll follow up next time\". This run ends when you reply. " +
      "If the work isn't finished, summarise what's done and what's left.",
    );
    lines.push(
      "5. **No retries by speculation** — if a tool fails, treat the error as a real result. " +
      "Don't loop. Surface the failure in your reply.",
    );
    lines.push("");
    lines.push("## Output Format");
    lines.push(
      "Your final reply IS the deliverable. Lead with the outcome (succeeded / partial / blocked + " +
      "why), then the specifics the operator needs (results, file paths, error messages). Plain " +
      "prose for short results; fenced code blocks for structured data. Skip the conversational " +
      "wrapper — no greetings, no sign-offs, no \"hope this helps\".",
    );
    lines.push("");
  } else {
    lines.push("You are a personal assistant running inside Brigade.");
    lines.push("");
  }

  // 1a. ## Voice — the BASELINE tone block. Lands here, immediately after the
  // identity opener and BEFORE the technical sections (Tooling, Tool Call
  // Style, Execution Bias, Safety, …), so the model absorbs the voice
  // before it sees pages of imperative instructions. Persona files in
  // `# Project Context` below refine + override this; the baseline ensures
  // a sane default even when SOUL.md / IDENTITY.md are empty or operator-
  // edited templates the model has never seen.
  //
  // Kept SHORT on purpose. Long tone blocks paradoxically make the model
  // sound MORE robotic because it treats them as content to acknowledge.
  // Six lines, each cuts one specific failure mode:
  //   1. Human voice    — anti-corporate, anti-marketing
  //   2. Brief default  — anti-wall-of-text
  //   3. No filler      — anti "Sure! Here's…" / "Great question!"
  //   4. No plumbing    — anti JID/sessionKey/conversation-id leakage
  //   5. Outcome first  — anti "the trick was X" recovery diaries
  //   6. Match the user — anti rigid-corporate when user is casual
  //
  // Skipped in sub-agent / cron mode — those have their own focused output
  // contracts (return a tool result, not a chat reply); a chatty-voice block
  // would conflict.
  if (!isMinimalMode) {
    lines.push("## Voice");
    lines.push("Talk like a person. Direct, casual, sometimes warm — never corporate, marketing-speak, or robotic.");
    lines.push("Brief by default. A short prose sentence beats a section with headings and bullets. Save structure for code, tables, or genuinely structured data the user asked for.");
    lines.push("No filler openers (`Sure!`, `Of course!`, `Great question!`, `Happy to help!`). No filler closers (`Hope this helps!`, `Let me know if…`). Just answer.");
    lines.push("Don't expose internal plumbing in replies: JIDs (`917…@s.whatsapp.net`), sessionKeys, conversation ids, tool argument shapes, adapter / channel / module / hash internals. The operator wants the outcome (\"Sent! 👋\"), not the mechanism.");
    lines.push("After a tool succeeds, confirm the outcome in human language. Don't narrate \"the trick was X\" or replay debugging steps the operator didn't see — they just want to know it worked.");
    lines.push("Match the user's tone. Casual when they're casual (\"hey send hi to mom\" → \"Sent! 👋\"). Technical when they ask for technical detail (\"explain why that failed\" → walk through it).");
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
    lines.push("Tool names are case-sensitive. Call tools exactly as listed.");
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
  // Tone rules (voice / casual default / no internal plumbing / outcome-not-
  // mechanism) live in the `## Voice` block above, not here. `## Tool Call
  // Style` is scoped to NARRATION discipline only — when and how to talk
  // about a tool call, not the broader voice rules.
  // Windows-specific bash hygiene: bash.exe / sh interpret backslashes as
  // escape characters, so `ls F:\Brigade\src` runs as `ls F:Brigadesrc` and
  // the operator sees a confusing "no such file" error AFTER they already
  // approved the (visually correct) command. Single-quoting the path bypasses
  // the escape interpreter. Always-on for top-level + sub-agent — the rule
  // is harmless on POSIX (where bash paths don't carry backslashes).
  if (args.runtime.platform === "win32") {
    lines.push(
      "On Windows: when a bash command argument contains a backslash path " +
      "(e.g. `C:\\path\\to\\project\\src`), single-quote it — `wc -l 'C:\\path\\to\\project\\package.json'` — " +
      "or bash will interpret `\\B`, `\\s`, etc. as escape sequences and strip them, " +
      "running the command against a mangled path.",
    );
  }
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
  // Lifted verbatim from the reference implementation — 4 lines, no
  // additions. Brigade previously had two extra lines ("default to short
  // natural replies", "skip the recap on `ok do it`") that overlap with
  // the new `## Voice` block above; the duplication trained the model
  // toward MORE rigid responses, not less. Trusting the reference's
  // tighter shape.
  if (!isMinimalMode) {
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
  // Output Formatting section REMOVED to mirror the reference implementation,
  // which doesn't carry an always-on fence-discipline block. The reference
  // ships fence guidance only via per-provider overlays for models that
  // need it (e.g. OpenAI prompt extras). Trusting Claude / Sonnet to fence
  // code correctly without an explicit always-on rule keeps the prompt
  // leaner. If a specific model regresses on fence formatting, add
  // targeted per-family guidance in `guidance.ts` rather than restoring
  // the always-on block.
  //
  // FIX 9 — per-channel markdown gate (additive). The block stays absent for
  // markdown-capable channels, the CLI/TUI, unknown channels, and non-channel
  // turns (markdown-on remains the implicit default — no regression). It is
  // emitted ONLY when THIS turn came in over a channel whose declared meta says
  // `markdownCapable: false`, in which case the model is told to reply in plain
  // text so the user doesn't see literal `**markup**`. Skipped in minimal mode
  // (sub-agent / cron) — their reply is a tool result / log line, not a
  // channel-rendered message, so channel markdown capability is irrelevant.
  if (!isMinimalMode) {
    const directive = resolveOutputFormattingDirective(
      args.channels?.currentChannel?.channelId,
    );
    if (directive) {
      lines.push(directive);
      lines.push("");
    }
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
  if (!isMinimalMode) {
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
  if (!isMinimalMode) {
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

  // 8b. ## Time (always-on).
  // The Runtime line carries `now=` in operator-local form already; this
  // block tells the model to READ that form directly instead of converting
  // UTC math in its head (the failure mode that caused the "11:18 AM IST
  // when it was 3:46 PM IST" hallucination). Cheap (~3 sentences) and
  // applies to every turn — including sub-agent / cron runs that consume
  // UTC ms timestamps from tools.
  lines.push(TIME_GROUNDING_GUIDANCE);
  lines.push("");

  // 8c. ## Organization (always-on awareness).
  // Tells the model that Brigade has an OPTIONAL virtual-office / org
  // layer, when to suggest enabling it, and the natural-language patterns
  // that signal org intent ("agent X reports to Y", "co-founder", "CEO",
  // etc.). The block is short (~14 lines) — small token cost in exchange
  // for the model knowing the org concept exists even on installs that
  // have NEVER opted in (cfg.org absent).
  //
  // The branching inside the block ("if ## Org is visible above ... else
  // ...") covers both opt-in states without needing the assembler to fork
  // here. Sub-agent / cron modes still get the awareness — they may need
  // to refuse hand-editing brigade.json or surface the org concept when
  // delegating.
  lines.push(ORG_AWARENESS_GUIDANCE);
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
  if (args.capabilities?.memory && !isMinimalMode) {
    lines.push(MEMORY_GUIDANCE);
    lines.push("");
  }

  // 7b'. ## Delegation (conditional on the `spawn_agent` tool being wired).
  // ONE conservative line, mirroring the reference's heuristic — the default
  // is "do it yourself in this session" (`## Execution Bias` enforces that
  // earlier in the prompt). Spawning is the EXCEPTION, reserved for tasks
  // that are genuinely longer-running or complex. An earlier verbose version
  // of this block over-encouraged spawning; the model either ignored it (no
  // change in behaviour) or — worse — would have spawned for trivial work.
  // Skipped in sub-agent mode since the sub-agent can't spawn further.
  if (args.capabilities?.subAgents && !isMinimalMode) {
    lines.push("## Delegation");
    lines.push(
      "If a task is more complex or takes longer, spawn a sub-agent with `spawn_agent`. " +
      "Otherwise, do the work in this session.",
    );
    lines.push("");
  }

  // 7b'''. # Sub-agents guidance (conditional on `subAgents` capability).
  //
  // SUB_AGENTS_GUIDANCE carries the load-bearing rule the model needs:
  // "Use `agents_list` to see what peer agents are configured before
  // referring to one." Mirrors OC's "use the tool, not memory" nudge for
  // delegation + inventory questions. Rendered BEFORE `## Agent & Skill
  // Management` (the operator-facing mutation surface).
  if (args.capabilities?.subAgents && !isMinimalMode) {
    lines.push(SUB_AGENTS_GUIDANCE);
    lines.push("");
  }

  // 7b''''. ## Delegating to peer agents (conditional on the actual tool surface).
  //
  // Fires when BOTH `sessions_send` AND `sessions_spawn` are visible to the
  // model THIS turn — keyed on the tool surface, not a capability flag, so
  // the cascade only renders when the model actually has both rungs to climb.
  // Skipped in minimal mode (sub-agent / cron) — those scoped runs don't
  // delegate to peers; the parent already framed the task.
  if (!isMinimalMode) {
    const toolNames = new Set(args.toolDescriptions.map((t) => t.name));
    if (toolNames.has("sessions_send") && toolNames.has("sessions_spawn")) {
      lines.push(DELEGATION_CASCADE_GUIDANCE);
      lines.push("");
    }
  }

  // 7b'''. ## Agent & Skill Management (always-on, non-minimal).
  // This block is the explicit "use the tool, NEVER hand-edit" wedge.
  // Without it the model knows that `manage_agent` / `manage_skill` exist
  // (via Pi's tool-schema injection) but doesn't know that the alternative
  // — raw `write` / `edit` against `brigade.json` or `<install>/skills/` —
  // is now blocked by the path-write guard. Telling it here saves a
  // turn-of-tool-failure-and-recovery every time it tries the old path.
  //
  // Why ALWAYS render (not gated on peer count): the model still needs
  // this even with zero peers — that's exactly when it's most likely to
  // be asked to ADD an agent. Minimal mode (sub-agent / cron) skips it
  // because those scoped runs shouldn't mutate the agent catalog.
  if (!isMinimalMode) {
    lines.push("## Agent & Skill Management");
    lines.push(
      "Use the dedicated tools below — Brigade's path-write guard will REFUSE direct `write` / `edit` to protected paths (brigade.json, `~/.brigade/agents/<id>/agent/`, the install tree's `skills/` dir) and tell you to come back here.",
    );
    lines.push("");
    lines.push("**Agents** — `manage_agent` (owner-only). Actions:");
    lines.push(
      "- `manage_agent({ action: \"add\", id: \"<name>\" })` — creates the agent with workspace + all 7 persona files seeded; atomic rollback on partial failure. Optional `workspace`, `provider`, `model` params.",
    );
    lines.push(
      "- `manage_agent({ action: \"delete\", id: \"<id>\" })` — soft-delete to `.brigade-trash/<id>-<timestamp>/` (recoverable).",
    );
    lines.push(
      "- `manage_agent({ action: \"set-identity\", id: \"<id>\", name, emoji, theme, avatar })` — update display fields only.",
    );
    lines.push(
      "- The gateway hot-reloads within ~500ms; the new/updated agent shows up in `agents_list` immediately, no restart needed.",
    );
    lines.push(
      "- NEVER `bash mkdir` + `write` + `edit brigade.json` to fake agent state — that produces orphan dirs, missing persona files, and config schema mismatches.",
    );
    lines.push("");
    lines.push("**Skills** — `manage_skill` (owner-only). Two scopes, pick deliberately:");
    lines.push(
      "- `manage_skill({ action: \"create\", scope: \"agent\", agentId: \"<id>\", name: \"<skill-name>\", description: \"<one-line>\", body: \"<markdown>\" })` — per-agent skill at `~/.brigade/agents/<id>/workspace/skills/<skill-name>/SKILL.md` (or `~/.brigade/workspace/skills/<skill-name>/` for the default agent `main`). Only that agent sees it. This is the default when the user says \"make a skill FOR agent X\".",
    );
    lines.push(
      "- `manage_skill({ action: \"create\", scope: \"managed\", name: \"<skill-name>\", description: \"<one-line>\", body: \"<markdown>\" })` — shared skill at `~/.brigade/skills/<skill-name>/SKILL.md`. Every agent sees it (subject to each agent's `cfg.agents.<id>.skills` allowlist).",
    );
    lines.push(
      "- `agentId` defaults to the calling agent. `description` is what future-you reads to decide whether the skill applies — make it specific. `body` is the actual skill content.",
    );
    lines.push(
      "- To delete: `manage_skill({ action: \"delete\", scope: \"agent\"|\"managed\", name: \"<skill-name>\", agentId: \"<id>\" })`.",
    );
    lines.push(
      "- NEVER run `scripts/init_skill.py`, NEVER `bash mkdir` + `write SKILL.md`, NEVER target the install tree's `skills/` directory — that path is bundled+read-only and wiped on reinstall.",
    );
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
  if (args.capabilities?.skills && !isMinimalMode) {
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

  // 7d'. ## Media & documents (conditional on the `analyze_media` tool).
  // Keyed on the tool NAME (like the delegation cascade), not a capability
  // flag — it only renders when the model actually has `analyze_media` to
  // call. Closes the broken chain where an inbound `[attached … → <path>]`
  // note arrived but the model ignored it / asked the user to paste the
  // contents instead of calling the tool. NOT gated on minimal mode: a cron
  // / sub-agent turn handed a file path needs this exactly as much, and the
  // tool is in its surface only if it was wired.
  if (args.toolDescriptions.some((t) => t.name === "analyze_media")) {
    lines.push(MEDIA_GUIDANCE);
    lines.push("");
  }

  // 7e. ## Messaging (conditional on at least one started channel adapter).
  // Patterned on the reference implementation's `## Messaging` block —
  // tells the model what channels are connected, when to use `send_message`,
  // and the anti-pattern of shelling out to a curl / API CLI for channel
  // messaging. Without this section the model has no idea WhatsApp is
  // connected and bash-probes `brigade doctor` to find out. Skipped in
  // minimal mode (cron / sub-agent runs) — those get a scoped tool
  // surface that already tells them what they can use without needing
  // the directory.
  // Connectable channels = registered adapters not currently started. Computed
  // once so both the render gate and the "you can connect" line use the same set.
  const connectableChannels =
    !isMinimalMode && args.channels
      ? (args.channels.available ?? []).filter((c) => c.connectable)
      : [];
  if (
    !isMinimalMode &&
    args.channels &&
    (args.channels.started.length > 0 || connectableChannels.length > 0)
  ) {
    const hasStarted = args.channels.started.length > 0;
    lines.push("## Messaging");
    if (hasStarted) {
      const channelList = args.channels.started.join(", ");
      lines.push(
        `You can message the operator (or anyone they ask you to) on: ${channelList}.`,
      );
    } else {
      // Nothing connected yet — but channels are available to wire up.
      lines.push(
        "No messaging channel is connected yet. You can connect one when the operator asks.",
      );
    }
    if (hasStarted) {
      // Linked self-accounts — for personal channels the linked account IS
      // the operator. Without this line the model asks "what's your number?"
      // for a number the adapter already knows.
      if (args.channels.linked && args.channels.linked.length > 0) {
        for (const l of args.channels.linked) {
          lines.push(
            `- ${l.channelId} is linked to the operator's own account: \`${l.selfId}\`. "Text me" / "send me a message" means \`send_message({channel: "${l.channelId}", to: "${l.selfId}", text})\` — never ask the operator for their number on a linked channel.`,
          );
        }
      }
      lines.push("- To send now: `send_message`. From a channel-routed turn, just pass `{text}` — it replies in place. Otherwise pass `{channel, to, text}`.");
      lines.push("- To send later (\"in 2 minutes\", \"daily at 9am\"): `cron` with a future `at` / cron schedule — it routes through the same channel at fire time.");
      lines.push("- Never use `bash` / curl to send messages. Always go through `send_message` or `cron`.");
    }
    // Available-but-not-connected channels — tell the model it can OFFER to
    // connect them. `connect_channel` is owner-gated, so the model proposes it
    // and the operator confirms; for token channels (Telegram) it needs the
    // token, for QR channels (WhatsApp) it points at `brigade channels link`.
    if (connectableChannels.length > 0) {
      const names = connectableChannels.map((c) => c.label).join(", ");
      lines.push(
        `- Available to connect (not yet connected): ${names}. If the operator wants one, use \`connect_channel({action:"connect", channel, token?})\` — owner-only; for Telegram pass the @BotFather token, for WhatsApp it links by QR. Offer this instead of saying you can't message there.`,
      );
    }
    // Surface degraded adapters so the model warns the operator BEFORE
    // attempting a send that will fail. Phrased in human language —
    // "WhatsApp is offline" not "channel adapter is in a degraded state".
    if (hasStarted && args.channels.degraded && args.channels.degraded.length > 0) {
      lines.push("");
      lines.push("**Right now, these aren't working:**");
      for (const d of args.channels.degraded) {
        const fix = d.remediation ? ` Fix: ${d.remediation}` : "";
        lines.push(`- ${d.channelId} — ${d.reason}${fix}`);
      }
      lines.push(
        "If the operator asks you to send via one of these, tell them what's wrong + the fix command. Don't try to send — it will fail.",
      );
    }
    if (hasStarted && args.channels.currentChannel) {
      lines.push("");
      lines.push(
        `This turn came in from ${args.channels.currentChannel.channelId}. \`send_message({text})\` (no other args) replies right back here.`,
      );
    }
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

  // 9b. Org anchor (virtual-office layer — conditional).
  // ADDITIVE-CONDITIONAL gate. When `args.orgGraph` is undefined (the
  // default for every install without `cfg.org`), this block emits ZERO
  // bytes — the assembled prompt is byte-identical to the pre-org-layer
  // shape. When defined, `renderOrgBlock` returns a SINGLE-LINE anchor
  // ("Org: you are <id>, <role> in <dept>, reports to <Y>. Call
  // org({action:\"describe\"}) for peers + reachability.") pointing the
  // model at the consolidated `org` tool for the full peer / reachability
  // picture; the prompt itself stays lean.
  //
  // Skipped in minimal mode (sub-agent / cron). Sub-agent runs get a
  // ONE-LINE anchor injected via `ephemeralSuffix` upstream so their
  // cached prefix stays identical to the legacy sub-agent prompt.
  if (!isMinimalMode && args.orgGraph) {
    const block = renderOrgBlock(args.orgGraph, args.runtime.agentId);
    if (block) {
      lines.push(block);
      lines.push("");
    }
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
    // ## Workspace Files (injected) — heads the persona context block so
    // the model knows these are USER-EDITABLE files (operator's identity,
    // tools, heartbeat) and treats edits to them as durable persona
    // mutation rather than ephemeral scratch. Mirrors the reference
    // codebase's header at the same boundary.
    lines.push("## Workspace Files (injected)");
    lines.push(
      "The block below contains the operator's editable persona files. Treat them as the source of truth for your identity, allowed tools, and current context. When the operator asks you to update SOUL/IDENTITY/TOOLS/etc., edit the file directly — those changes persist across sessions.",
    );
    lines.push("");
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
    if (args.heartbeatFile && !isMinimalMode) {
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
  if (args.heartbeatFile && !isMinimalMode) {
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
