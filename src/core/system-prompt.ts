/**
 * Thin shim — replaces the 2400-line lifted `core/system-prompt.ts`.
 *
 * The lifted version reimplemented an entire system-prompt assembler that
 * F:\Brigade already had at `src/system-prompt/`. Audit-1 identified this
 * as redundant; this shim delegates the heavy lifting to the existing
 * infrastructure and only keeps the small utilities the lifted callers
 * (`core/agent.ts`, `core/server.ts`, `core/provider-payload-mutators.ts`,
 * `ui/onboarding.ts`) need.
 *
 * Public surface preserved:
 *   - `BRIGADE_CACHE_BOUNDARY`         — string constant (re-export)
 *   - `seedDefaultPrompts`             — workspace scaffolder
 *   - `refreshSessionSystemPrompt`     — assemble + pin (3-write hack)
 *   - `extractIdentityName`            — parse Name from IDENTITY.md
 *   - `isIdentityNameUnset`            — placeholder-Name detector
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { applyPersonaOverrideToSession } from "../system-prompt/pi-injection.js";
import { assembleSystemPrompt } from "../system-prompt/assembler.js";
import { CACHE_BOUNDARY_MARKER } from "../system-prompt/cache-boundary.js";
import { resolveRuntimeParams } from "../system-prompt/runtime-params.js";
import {
  loadHeartbeatFile,
  loadWorkspaceContextFiles,
} from "../system-prompt/workspace-loader.js";
import { bootstrapWorkspace } from "../workspace/bootstrap.js";
import { resolveToolSummary } from "../agents/tool-summaries.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir } from "../config/paths.js";

// The cache marker the lifted code referenced. F:\Brigade's existing
// `src/system-prompt/cache-boundary.ts` exports `CACHE_BOUNDARY_MARKER`
// (`"\n<!-- BRIGADE_CACHE_BOUNDARY -->\n"` — exact same bytes); we
// re-export under the lifted callers' name.
export const BRIGADE_CACHE_BOUNDARY = CACHE_BOUNDARY_MARKER;

/**
 * Idempotently scaffold the 7 workspace persona files (AGENTS.md, SOUL.md,
 * IDENTITY.md, USER.md, TOOLS.md, BOOTSTRAP.md, HEARTBEAT.md) from F:\Brigade's
 * `templates/workspace/` into the agent's workspace dir. Existing files are
 * never overwritten — users own their edits. The lifted callers (`buildAgent`,
 * the onboarding wizard) call this on first boot to ensure the templates are
 * available; subsequent calls are no-ops.
 *
 * Delegates to F:\Brigade's `bootstrapWorkspace`, which is the
 * Primitive #2-era scaffolder.
 */
export async function seedDefaultPrompts(workspaceDir?: string): Promise<void> {
  const dir = workspaceDir ?? resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
  await bootstrapWorkspace(dir);
}

/**
 * Per-turn refresh options. All fields optional — defaults match v1
 * single-user single-agent behaviour. Callers (chat.ts main loop, gateway,
 * sub-agent dispatcher in Primitive #6) layer in capabilities + ephemeral
 * task-framing as those primitives land.
 */
export interface RefreshSessionSystemPromptOptions {
  /** Working directory for the runtime line. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Per-turn-only addition pinned BELOW the cache boundary so it never busts
   * the cached prefix. Sub-agents (Primitive #6) use this to inject the
   * task brief; ephemeral system messages use it for one-shot directives.
   * Empty / undefined → omitted entirely.
   */
  ephemeralSuffix?: string;
  /**
   * Capability gates — turn on the matching guidance block when the session
   * has the corresponding tool wired in. Off-by-default keeps the cached
   * prefix small until primitives #4-6 ship.
   */
  capabilities?: {
    memory?: boolean;
    skills?: boolean;
    subAgents?: boolean;
  };
}

/**
 * Re-assemble the full system prompt and pin it to the Pi session via the
 * 3-write hack so subsequent turns don't get clobbered by Pi's natural
 * re-assembly. Used by the lifted TUI's per-turn refresh hook.
 *
 * Workspace files (AGENTS.md, SOUL.md, etc.) are re-read every call so a
 * mid-session edit (e.g., the user updates IDENTITY.md after onboarding)
 * lands on the next turn.
 *
 * `cwdOrOpts` accepts the legacy `string` form (just the cwd) OR the new
 * options-bag form so existing call-sites don't have to change.
 */
export async function refreshSessionSystemPrompt(
  session: AgentSession,
  cwdOrOpts?: string | RefreshSessionSystemPromptOptions,
): Promise<void> {
  const opts: RefreshSessionSystemPromptOptions =
    typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts } : (cwdOrOpts ?? {});
  const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
  const personaFiles = await loadWorkspaceContextFiles(workspaceDir);
  const heartbeatFile = await loadHeartbeatFile(workspaceDir);
  const sessionAny = session as unknown as {
    model?: { provider?: string; id?: string; modelId?: string };
    thinkingLevel?: string;
  };
  const provider = sessionAny.model?.provider ?? "unknown";
  // Pi's `Model` exposes the model id as `.id`, NOT `.modelId`. Reading only
  // `.modelId` (the prior bug) yielded "unknown", which broke BOTH the
  // per-family identity override (pickModelFamilyGuidance("unknown") → null,
  // so `gemma4:e2b` kept replying "I am Gemma 4") AND the reasoning-format
  // gate (shouldUseReasoningFormat saw "unknown"). Prefer `.id`, fall back to
  // `.modelId` for any Pi version that surfaced it differently.
  const modelId = sessionAny.model?.id ?? sessionAny.model?.modelId ?? "unknown";
  const thinkingLevel = sessionAny.thinkingLevel ?? "off";
  const runtime = resolveRuntimeParams({
    agentId: DEFAULT_AGENT_ID,
    workspaceDir,
    cwd: opts.cwd ?? process.cwd(),
    modelLabel: `${provider}/${modelId}`,
    thinkingLevel,
  });
  // Derive tool descriptions + capability gates from the session's LIVE
  // tool set so the `## Tooling` and `## Memory` sections reflect what's
  // actually wired (recall_memory / read_memory, etc.). The previous shim
  // hard-coded `toolDescriptions: []` and only honoured an explicit
  // `opts.capabilities`, so the interactive path advertised no tools and
  // never emitted the memory section. Reading from the session keeps every
  // refresh (initial + per-turn) accurate without threading data through.
  const liveToolNames = (
    (session as unknown as { agent?: { state?: { tools?: Array<{ name?: string }> } } }).agent
      ?.state?.tools ?? []
  )
    .map((t) => (typeof t?.name === "string" ? t.name : ""))
    .filter((n): n is string => n.length > 0);
  const toolDescriptions = liveToolNames.map((name) => ({
    name,
    summary: resolveToolSummary(name) ?? "",
  }));
  const capabilities = opts.capabilities ?? {
    memory: liveToolNames.includes("recall_memory"),
  };
  const assembled = assembleSystemPrompt({
    runtime,
    personaFiles,
    heartbeatFile,
    toolDescriptions,
    modelId,
    thinkingLevel,
    capabilities,
    ephemeralSuffix: opts.ephemeralSuffix,
  });
  applyPersonaOverrideToSession(session, assembled.text);
}

/**
 * Returns true when the IDENTITY.md `**Name:**` field is missing, blank, or
 * still holds the template placeholder `*(pick something you like)*`.
 *
 * Lifted verbatim from the published v0.1.3 implementation — the parsing
 * rules are intricate (handles inline / next-line / blank-line / next-bullet
 * / EOF cases) and the Brigade onboarding wizard relies on the exact
 * behaviour to decide whether to launch the name-discovery flow.
 */
export function isIdentityNameUnset(identityText: string): boolean {
  if (!identityText || identityText.trim().length === 0) return true;
  const lines = identityText.split(/\r?\n/);
  let nameLineIdx = -1;
  let inlineValue = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^\s*[-*]?\s*\*\*\s*Name\s*:\s*\*\*(.*)$/i);
    if (m) {
      nameLineIdx = i;
      inlineValue = (m[1] ?? "").trim();
      break;
    }
  }
  if (nameLineIdx === -1) return true;
  // Placeholder pattern accepts BOTH italic flavours so the wizard correctly
  // detects an un-personalised IDENTITY.md regardless of which markdown
  // emphasis the template uses:
  //   *(pick something you like)*  — asterisks (the lifted v0.1.3 detector)
  //   _(pick something you like)_  — underscores (the in-tree template form)
  // Without this, the underscore form skips name-discovery, the placeholder
  // leaks into the system prompt, and the agent ends up echoing the literal
  // `_(...)_` markdown in chat replies (Pi-TUI doesn't render `_..._`).
  if (inlineValue.length > 0 && !/^[*_]\([^)]*\)[*_]$/.test(inlineValue)) {
    return false;
  }
  for (let j = nameLineIdx + 1; j < lines.length; j++) {
    const next = (lines[j] ?? "").trim();
    if (next.length === 0) continue;
    if (/^[*_]\([^)]*\)[*_]$/.test(next)) return true;
    if (/^[-*]?\s*\*\*[^*]+:\*\*/.test(next)) return true;
    if (/^---+$/.test(next) || /^#/.test(next)) return true;
    return false;
  }
  return true;
}

/**
 * Pull the agent's chosen Name out of an IDENTITY.md file. Returns the
 * trimmed name string when set, or `undefined` when the Name field is
 * blank, missing, or a template placeholder.
 *
 * Mirror of `isIdentityNameUnset` but returns the value instead of a
 * boolean. Lifted verbatim from v0.1.3 — used by the gateway's state
 * snapshot so the connect TUI can label the assistant by name.
 */
export function extractIdentityName(identityText: string): string | undefined {
  if (!identityText || identityText.trim().length === 0) return undefined;
  const re = /(^|\n)[ \t]*[-*]?[ \t]*\*\*Name:\*\*[ \t]*(.*)/i;
  const match = re.exec(identityText);
  if (!match) return undefined;
  const inline = (match[2] ?? "").trim();
  if (inline.length > 0) {
    // Strip both italic flavours from leading/trailing positions so a value
    // like `_Brigade_` or `*Brigade*` reads as "Brigade", not as a placeholder.
    const cleaned = inline.replace(/^[*_]+|[*_]+$/g, "").trim();
    if (
      cleaned.length > 0 &&
      !/^\(.*\)$/.test(cleaned) &&
      !/^[*_]\(.*\)[*_]$/.test(cleaned)
    ) {
      return cleaned;
    }
  }
  const after = identityText.slice((match.index ?? 0) + match[0].length);
  const lines = after.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Placeholder match — same dual-flavour rule as isIdentityNameUnset above
    // so we don't leak `_(pick something you like)_` back to callers.
    if (/^[*_]\([^)]*\)[*_]$/.test(line)) return undefined;
    if (/^[-*]?[ \t]*\*\*[^*]+:\*\*/.test(line)) return undefined;
    if (/^---+$/.test(line) || /^#/.test(line)) return undefined;
    const cleaned = line.replace(/^[*_]+|[*_]+$/g, "").trim();
    return cleaned.length > 0 ? cleaned : undefined;
  }
  return undefined;
}
