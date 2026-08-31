/**
 * Pure helpers for the `/org` slash command — shared by:
 *
 *   - the TUI surface (`connect.ts`)
 *   - the channel surface (`agent-switch-command.ts` → `/org` ChannelCommand)
 *
 * Both call into the SAME parse + filter + render functions so the chart
 * shape can never drift between surfaces. The gateway `org.snapshot` RPC
 * already pre-renders `charts.tui / channel / ascii` for the unfiltered
 * happy path; when an operator asks for a SUB-CHART (`/org <agent-id>`,
 * `/org --departments`, `/org --explain <from> <to>`) we re-render
 * client-side against the same Pride template using the `graph` field
 * returned in the snapshot.
 *
 * NO external agent-codebase identifiers.
 */

import type { OrgGraph } from "../../agents/org/types.js";
import {
  BRIGADE_FOOTER_RULE,
  BRIGADE_TAUNT,
  PRIDE_CHART_FLAT_CREW_NOTE,
  flattenToThreeTiersWithPins,
  renderPrideChartWithPins,
  type RenderPrideChartOptions,
} from "../../agents/org/pride-template.js";

/* ─── Parse ─────────────────────────────────────────────────────────── */

/** Discriminated union of `/org` invocation shapes. */
export type ParsedOrgCommand =
  | { kind: "show" }
  | { kind: "departments" }
  | { kind: "subtree"; agentId: string }
  | { kind: "explain"; from: string; to: string }
  | { kind: "error"; message: string };

/**
 * Parse the args portion of `/org <...>` (everything AFTER the literal
 * `/org` word). Trims, splits, and matches a small grammar.
 *
 *   /org                               → { kind: "show" }
 *   /org --departments                 → { kind: "departments" }
 *   /org --explain <from> <to>         → { kind: "explain", from, to }
 *   /org <agent-id>                    → { kind: "subtree", agentId }
 *
 * Any other shape returns `{ kind: "error", message }` so the caller can
 * print a usage hint.
 */
export function parseOrgSlash(rawArgs: string): ParsedOrgCommand {
  const trimmed = (rawArgs ?? "").trim();
  if (trimmed.length === 0) return { kind: "show" };

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "show" };

  const first = tokens[0] ?? "";

  if (first === "--departments" || first === "-d") {
    if (tokens.length !== 1) {
      return {
        kind: "error",
        message: "Usage: /org --departments",
      };
    }
    return { kind: "departments" };
  }

  if (first === "--explain" || first === "-e") {
    if (tokens.length !== 3) {
      return {
        kind: "error",
        message: "Usage: /org --explain <from> <to>",
      };
    }
    const from = (tokens[1] ?? "").trim();
    const to = (tokens[2] ?? "").trim();
    if (!from || !to) {
      return {
        kind: "error",
        message: "Usage: /org --explain <from> <to>",
      };
    }
    return { kind: "explain", from, to };
  }

  if (first.startsWith("-")) {
    return {
      kind: "error",
      message:
        "Usage: /org [<agent-id>] | /org --departments | /org --explain <from> <to>",
    };
  }

  if (tokens.length !== 1) {
    return {
      kind: "error",
      message:
        "Usage: /org [<agent-id>] | /org --departments | /org --explain <from> <to>",
    };
  }
  return { kind: "subtree", agentId: first };
}

/* ─── Subtree filter ─────────────────────────────────────────────────── */

/**
 * Filter an OrgGraph to a subtree rooted at `agentId`:
 *
 *   - Keep `topOrder` (so the chart still anchors at Higher Office).
 *   - Keep `agentId` and every transitive descendant (via `reportsTo` —
 *     a member B is a descendant of A iff walking B's `reportsTo` chain
 *     reaches A).
 *   - Recompute the `departments` inverse index so unreferenced
 *     department slugs vanish.
 *
 * Returns the filtered graph. When `agentId` is unknown, the result is
 * `undefined` so the caller can print a friendly error.
 */
export function filterGraphToSubtree(
  graph: OrgGraph,
  agentId: string,
): OrgGraph | undefined {
  if (!graph.members[agentId]) return undefined;
  const keep = new Set<string>([graph.topOrder, agentId]);

  // For every member, walk its reportsTo chain. If we reach `agentId`,
  // the member is a descendant.
  for (const id of Object.keys(graph.members)) {
    if (keep.has(id)) continue;
    let cursor: string | null = id;
    const seen = new Set<string>();
    let steps = 0;
    while (cursor && !seen.has(cursor) && steps < 1024) {
      seen.add(cursor);
      const m: OrgGraph["members"][string] | undefined = graph.members[cursor];
      if (!m) break;
      if (cursor === agentId) {
        // The member walked up to agentId — it's a descendant.
        keep.add(id);
        break;
      }
      cursor = m.reportsTo;
      steps += 1;
    }
  }

  const members: OrgGraph["members"] = {};
  for (const id of keep) {
    const m = graph.members[id];
    if (m) members[id] = m;
  }

  const departments: Record<string, string[]> = {};
  for (const [id, m] of Object.entries(members)) {
    const bucket = departments[m.department] ?? [];
    bucket.push(id);
    departments[m.department] = bucket;
  }
  for (const key of Object.keys(departments)) {
    const b = departments[key];
    if (b) b.sort();
  }

  return {
    topOrder: graph.topOrder,
    members,
    departments,
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    mode: graph.mode,
  };
}

/* ─── Departments-only render ───────────────────────────────────────── */

/**
 * Render the Pride chart with Higher Office section omitted. Uses the
 * same template engine so headers, footers, and the Brigade taunt all
 * remain consistent — we just strip the Higher Office block from the
 * output.
 *
 * Implementation note: rather than fork the template, we run the full
 * render and surgically excise the Higher Office block by line markers.
 * The template's section header is the literal string `Higher Office`
 * preceded by the section bar; we drop from that line through (and
 * including) the trailing blank line before the next section bar.
 */
export function renderDepartmentsOnly(
  graph: OrgGraph,
  pins: Record<string, string> | undefined,
  opts: RenderPrideChartOptions = {},
): string {
  const full = renderPrideChartWithPins(graph, pins, opts);
  // Match a contiguous "Higher Office" section: from the line containing
  // "Higher Office" until the next blank line that precedes a non-blank
  // line. Drop the matched block entirely.
  const lines = full.split("\n");
  const out: string[] = [];
  let i = 0;
  // Anchor to the section-bar glyph `▌` so we don't accidentally strip
  // footer rules / taunts / stories that mention "Higher Office"
  // verbatim (the bank has a few such entries).
  const HEADING_RE = /^\s*▌\s*Higher Office\b/;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Strip ANSI before matching so the test runs with both colour modes.
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (HEADING_RE.test(stripped)) {
      // Skip lines until we hit a blank then a non-blank section bar/heading.
      i += 1;
      // Eat the topOrder member line(s) + optional bio + trailing blank.
      while (i < lines.length) {
        const peek = lines[i] ?? "";
        const peekStripped = peek.replace(/\x1b\[[0-9;]*m/g, "");
        if (peekStripped.trim() === "") {
          // Consume the blank line and stop — next iteration resumes at
          // the next section.
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

/* ─── Explain ────────────────────────────────────────────────────────── */

/** Result of `formatExplain` — pure data so callers can render to fit. */
export interface ExplainOutcome {
  from: string;
  to: string;
  status: "allowed" | "denied" | "no-org" | "unknown-member";
  /** Edge-by-edge reasons when allowed. */
  chain?: { reason: string; note?: string }[];
  /** Denial reason when denied. */
  reason?: string;
  /** Identifier of the unknown member when status === "unknown-member". */
  unknown?: string;
}

/**
 * Compute the explain outcome for a directed `from → to` edge against
 * the supplied OrgGraph. Mirrors `org_explain` tool semantics so the
 * TUI / channel surfaces match what an agent would see when calling
 * `org({action:"explain", from, to})`.
 */
export function computeExplain(
  graph: OrgGraph,
  from: string,
  to: string,
): ExplainOutcome {
  const f = graph.members[from];
  const t = graph.members[to];
  if (!f) {
    return { from, to, status: "unknown-member", unknown: from };
  }
  if (!t) {
    return { from, to, status: "unknown-member", unknown: to };
  }
  const edges = graph.edges.filter((e) => e.from === from && e.to === to);
  if (edges.length > 0) {
    return {
      from,
      to,
      status: "allowed",
      chain: edges.map((e) => ({
        reason: e.reason,
        ...(e.note ? { note: e.note } : {}),
      })),
    };
  }
  let denial: string;
  if (f.department !== t.department) {
    denial = `cross-department edge ${JSON.stringify(
      f.department,
    )} → ${JSON.stringify(t.department)} is closed by rule (v)`;
  } else {
    denial = "no direct edge in derived graph";
  }
  return { from, to, status: "denied", reason: denial };
}

/**
 * Format an ExplainOutcome as a plain-text block for printing in either
 * the TUI or a channel reply. The output is intentionally compact (one
 * line per fact) and ASCII-only so channel renderers don't mangle it.
 */
export function formatExplain(outcome: ExplainOutcome): string {
  const lines: string[] = [];
  if (outcome.status === "unknown-member") {
    lines.push(
      `${outcome.from} → ${outcome.to}: UNKNOWN`,
    );
    lines.push(
      `  ${JSON.stringify(outcome.unknown ?? "")} is not a member of the org`,
    );
    return lines.join("\n");
  }
  if (outcome.status === "no-org") {
    lines.push(
      "(no cfg.org block — derived A2A is not in effect)",
    );
    return lines.join("\n");
  }
  if (outcome.status === "allowed") {
    lines.push(`${outcome.from} → ${outcome.to}: ALLOWED`);
    for (const e of outcome.chain ?? []) {
      lines.push(`  reason: ${e.reason}${e.note ? ` (${e.note})` : ""}`);
    }
    return lines.join("\n");
  }
  lines.push(`${outcome.from} → ${outcome.to}: DENIED`);
  if (outcome.reason) lines.push(`  reason: ${outcome.reason}`);
  return lines.join("\n");
}

/* ─── Constants ──────────────────────────────────────────────────────── */

/** Re-export so consumers can import the redirect from one place. */
export { PRIDE_CHART_FLAT_CREW_NOTE, BRIGADE_TAUNT, BRIGADE_FOOTER_RULE };

/** Re-export the pin-aware flatten for callers that need raw structure. */
export { flattenToThreeTiersWithPins };
