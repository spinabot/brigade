// Tool summaries used in the system prompt's `## Tooling` section.
//
// The summaries are short, action-oriented one-liners — they tell the model
// what each tool DOES, not how it works. Verbose docs belong in the model's
// own tool-schema introspection (Pi attaches the full ToolDefinition to the
// API request); the system prompt's job is to advertise the surface area
// so the model picks the right name on the first try and doesn't invent
// aliases like `cat` or `ls -la`.
//
// Short, action-oriented summaries by tool name. When Pi adds a tool name
// we don't recognise, the renderer falls back to "no summary" and lets
// the model rely on its tool schema.

export const BRIGADE_TOOL_SUMMARIES: Record<string, string> = {
  read: "Read file contents (text or binary).",
  write: "Create or overwrite a file with new content.",
  edit: "Make precise, targeted edits to an existing file.",
  bash: "Run a shell command in the agent's working directory.",
  grep: "Search file contents for a regex pattern (ripgrep-backed).",
  find: "Find files by name or glob pattern.",
  ls: "List the contents of a directory.",
  // Primitive #4 (Memory). Recall = search; read = bounded excerpt.
  // Writing memory uses `write_memory` for the structured fact store
  // (declarative facts, segmented + decay-aware); free-form long notes
  // append to `memory/<today>.md` via the regular `write`/`edit` tools.
  // Wording for `recall_memory` is deliberately scoped to remembered
  // CONTENT (preferences/decisions/people/dates/todos) — NOT live state
  // like which agents/channels/skills currently exist. Live state comes
  // from the corresponding inventory tools below; recall_memory is for
  // remembered facts about the past.
  recall_memory: "Search your durable memory for remembered preferences, decisions, people, dates, or todos. NOT for live inventory (use agents_list / skills / etc. for what currently exists).",
  read_memory: "Read a bounded excerpt of a memory file found via recall_memory.",
  write_memory: "Save a durable, declarative fact (preference, identity, correction) into structured memory.",
  // Agent + skill catalog tools. Summaries mirror the reference
  // implementation's terse one-liners — the structured behaviour (no
  // inline catalog → must call the tool) does the steering work; the
  // catalog is just the menu.
  agents_list:
    "List EVERY configured Brigade agent with canSpawn/canSend reachability flags. Call this — don't enumerate agents from memory.",
  manage_agent: "Owner-only: create, delete, or update an agent's identity. Use this for any agent-catalog mutation — never hand-edit brigade.json.",
  manage_skill: "Owner-only: create or delete a skill (agent-scoped or shared). Never write SKILL.md by hand; this tool handles the catalog atomically.",
  // Session / sub-agent surface — terse summaries mirroring the
  // reference codebase.
  sessions_list: "List other sessions (incl. sub-agents) with filters/last",
  sessions_send: "Send a message to another session/sub-agent",
  sessions_history: "Fetch history for another session/sub-agent",
  sessions_spawn: "Spawn an isolated sub-agent session",
  subagents: "List, steer, or kill sub-agent runs for this requester session",
  spawn_agent: "Spawn a one-shot sub-agent for an independent, parallelisable subtask. Returns its final reply synchronously.",
  spawn_agents: "Spawn multiple independent sub-agents in parallel (one task each); returns their replies.",
  // Channel + cron surface.
  send_message: "Send a message on a connected channel (WhatsApp, Slack, …). From a channel-routed turn just pass {text}; otherwise pass {channel, to, text}.",
  cron: "Schedule a task to run later — `at`/cron schedule routed through the same channel at fire time.",
  // Web surface. Catalog summaries are intentionally terse — the model
  // sees the full per-tool `description:` field at every tool-use
  // decision; the catalog is just the menu. Lifted verbatim from the
  // upstream reference's tool-catalog 1-liners (`Search the web` /
  // `Fetch and extract readable content from a URL` / `Control web
  // browser`).
  web_search: "Search the web",
  fetch_url: "Fetch and extract readable content from a URL",
  web_extract: "Extract content from a batch of URLs in one call",
  browser: "Control web browser",
  // Reserved for future Brigade additions — keep them documented even when
  // not yet wired so a single source-of-truth covers any tool name Pi
  // might surface via getActiveToolNames().
  apply_patch: "Apply a multi-file patch.",
  process: "Run a long-lived shell process in the background.",
  message: "Send a message on the active channel.",
};

// Resolve a one-line summary for the named tool. Falls back to a marker
// the renderer can choose to hide entirely (so unknown tools surface as
// just `- name` without a misleading invented description).
export function resolveToolSummary(name: string): string | undefined {
  const normalised = name.trim().toLowerCase();
  return BRIGADE_TOOL_SUMMARIES[normalised];
}
