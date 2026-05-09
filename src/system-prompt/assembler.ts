import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";
import { normalizeStructuredPromptSection } from "./cache-stability.js";
import { applyBudget, DEFAULT_BUDGET, type BudgetResult } from "./bootstrap-budget.js";
import { sanitizeForPromptLiteral } from "./sanitize.js";
import { formatRuntimeLine, type RuntimeParams } from "./runtime-params.js";
import {
	EXECUTION_BIAS_GUIDANCE,
	MEMORY_GUIDANCE,
	pickModelFamilyGuidance,
	SAFETY_GUARDRAILS_GUIDANCE,
	SKILLS_GUIDANCE,
	SUB_AGENTS_GUIDANCE,
	TOOL_CALL_STYLE_GUIDANCE,
	TOOL_USE_ENFORCEMENT_GUIDANCE,
} from "./guidance.js";
import type { ContextFile } from "./types.js";
import type { BootstrapPhase } from "../workspace/state.js";

// Top-level assembler.
//
// Builds the full system prompt as an array of `lines`, joins on \n at the
// end. The order is meaningful: stable identity → safety → tool guidance
// → workspace persona → cache boundary → dynamic suffix (heartbeat, time
// of turn, sub-agent context). Anthropic prompt-caching sees the boundary
// and caches everything above it; everything below changes per turn.

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
  // Lifecycle phase from the workspace state file. The assembler doesn't
  // currently emit synthetic guidance based on this — first-turn behaviour
  // is driven by AGENTS.md + BOOTSTRAP.md content alone — but it's
  // threaded through so future layers (e.g. provider-specific first-turn
  // hints) can branch on it without re-plumbing.
  bootstrapPhase?: BootstrapPhase;
  // Active model id. Used for per-model-family guidance + reasoning-format
  // gating. Aggregator-prefix tolerant (`openrouter/openai/gpt-4o` works).
  modelId?: string;
  // Active thinking level. Drives whether REASONING_FORMAT_GUIDANCE fires.
  // "off" / undefined → no reasoning format block. Native-reasoning models
  // (Claude w/ extended thinking, o1/o3) skip it regardless.
  thinkingLevel?: string;
  // Capability gates for conditional guidance. Each toggle includes the
  // matching guidance block iff true. Memory/skills/sub-agents arrive
  // alongside primitives #4-6 — until then the gates stay false and the
  // cached prefix stays small.
  capabilities?: {
    memory?: boolean;
    skills?: boolean;
    subAgents?: boolean;
  };
}

export interface ToolDescription {
  name: string;
  summary: string;
}

export interface AssembledPrompt {
  text: string;
  budget: BudgetResult;
}

export function assembleSystemPrompt(args: AssembleArgs): AssembledPrompt {
  const lines: string[] = [];

  // Identity opener — kept short so it doesn't dominate the cached prefix.
  // Lead with "Brigade assistant" as the role identifier so the model picks
  // it up as the primary noun phrase when introducing itself. The user's
  // IDENTITY.md / SOUL.md / AGENTS.md files in `# Project Context` (below)
  // can override or refine this — that's where domain, name, voice, and
  // behavioural rules live. Domain-neutral here on purpose: pinning a
  // role like "engineering work" at the system level would shadow the
  // user's own framing on every turn.
  lines.push(
    "You are the user's Brigade assistant — a personal AI inside their " +
      "Brigade crew. Defer to the workspace persona files below for your " +
      "specific identity, values, and behavioural rules.",
  );
  lines.push("");

  // First-turn nudge. Smaller models (gpt-4o-mini, llama-3.1-8b, etc.)
  // don't reliably follow the implicit "First Run" pointer in AGENTS.md
  // without a system-level anchor — they default to a stock greeting and
  // skip BOOTSTRAP.md entirely. One-line nudge here is enough to redirect
  // attention; the actual greeting wording stays under the user's control
  // via BOOTSTRAP.md content.
  if (args.bootstrapPhase === "first-turn") {
    lines.push(
      "**First turn:** read the `## BOOTSTRAP` section below and follow its " +
        "first-run script verbatim. Do not produce a generic greeting.",
    );
    lines.push("");
  }

  // Always-on guidance blocks. Six load-bearing sections that always live in
  // the cached prefix (cheap on every turn, rewrite-stable across edits).
  // Order: Safety baseline → Execution bias → Tool-call style → Tool-use
  // discipline → (conditional) Reasoning format → Per-model family extras.
  //
  // Tool-use enforcement is the SINGLE most important block for Primitive #3
  // — without it, smaller / cheaper models describe tool calls in prose
  // instead of firing them. Always included regardless of model family.
  lines.push(SAFETY_GUARDRAILS_GUIDANCE);
  lines.push("");
  lines.push(EXECUTION_BIAS_GUIDANCE);
  lines.push("");
  lines.push(TOOL_CALL_STYLE_GUIDANCE);
  lines.push("");
  lines.push(TOOL_USE_ENFORCEMENT_GUIDANCE);
  lines.push("");

  // No `<think>...</think>` tag instructions — mirrors OpenClaw, which has
  // no equivalent guidance. Reasoning lives in Pi's structured `block.type
  // === "thinking"` content, never as inline tags in text. Telling
  // non-native-reasoning models to wrap thinking in `<think>` tags caused
  // the tags to leak through into the rendered chat output (the user
  // explicitly objected to seeing raw `<think>` markup). The chat
  // renderer also strips any stray `<think>...</think>` blocks
  // defensively in case a model still emits them from its own training.

  // Per-model family extras. OpenAI gets a verbose execution-discipline
  // block; Google gets path-absolutism + parallel-tool guidance. Claude
  // and unknown providers fall through to no extras.
  const familyGuidance = pickModelFamilyGuidance(args.modelId);
  if (familyGuidance) {
    lines.push(familyGuidance);
    lines.push("");
  }

  // Conditional capability guidance — gated on tool registration. Each
  // block lands in the cached prefix only when the corresponding tool is
  // wired into this session, so a "tools-light" run doesn't pay the token
  // cost.
  if (args.capabilities?.memory) {
    lines.push(MEMORY_GUIDANCE);
    lines.push("");
  }
  if (args.capabilities?.skills) {
    lines.push(SKILLS_GUIDANCE);
    lines.push("");
  }
  if (args.capabilities?.subAgents) {
    lines.push(SUB_AGENTS_GUIDANCE);
    lines.push("");
  }

  // Tooling block.
  //
  // Brigade pins this whole prompt over Pi's natural system-prompt
  // assembly (3-write hack), which means Pi's own tool-section never
  // reaches the model. The model only knows about the tools we list HERE.
  // When `toolDescriptions` is non-empty we enumerate every tool by name
  // + summary so the model picks exact names on the first try and doesn't
  // invent aliases like `cat` / `ls -la`. The "case-sensitive" note is
  // load-bearing — without it some models lower-case tool names from
  // habit and the call fails. Empty list = sub-agent / scoped-tools
  // run, render a permissive line so the model still trusts whatever Pi
  // wired into the API request.
  lines.push("## Tooling");
  if (args.toolDescriptions.length === 0) {
    lines.push(
      "Tools are wired into this turn. When the user asks you to do " +
        "something that needs filesystem, shell, or search access, USE the " +
        "tools you have — do not tell the user you can't.",
    );
  } else {
    lines.push("Tool availability (you may call any of these):");
    lines.push("Tool names are case-sensitive. Call tools exactly as listed.");
    for (const t of args.toolDescriptions) {
      const summary = t.summary?.trim();
      lines.push(summary ? `- ${t.name}: ${summary}` : `- ${t.name}`);
    }
  }
  lines.push("");

  // Workspace context section header. Persona files come from the user's
  // ~/.brigade/agents/<id>/workspace/ tree.
  if (args.personaFiles.length > 0) {
    lines.push("# Project Context");
    lines.push(
      "The files below are authored by the user. Treat them as the canonical " +
        "description of the agent's identity, values, and ways of working.",
    );
    lines.push("");

    const budget = applyBudget(args.personaFiles, DEFAULT_BUDGET);
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

    // Cache boundary.
    lines.push(CACHE_BOUNDARY_MARKER_LINE);

    // Below-boundary dynamic content.
    lines.push("");
    if (args.heartbeatFile) {
      lines.push("# Heartbeat (current cycle)");
      lines.push(`<!-- source: ${args.heartbeatFile.path} -->`);
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
      budget,
    };
  }

  // No persona files at all — emit cache boundary + runtime so prompt
  // caching still works on the (very small) stable prefix.
  lines.push(CACHE_BOUNDARY_MARKER_LINE);
  lines.push("");
  if (args.heartbeatFile) {
    lines.push("# Heartbeat (current cycle)");
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
