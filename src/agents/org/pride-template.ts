/**
 * Brigade Pride hierarchy template — the single source of truth for
 * org-chart rendering.
 *
 * Brigade taunt: "Run it like a pride, not a pyramid." The display is
 * deliberately flattened to THREE tiers regardless of how deep the
 * underlying org graph nests:
 *
 *   Tier 1 — Higher Office: the `topOrder` agent (exactly 1).
 *   Tier 2 — Department leads: direct reports of `topOrder` that are
 *            heads of a department (resolved via
 *            `cfg.org.departmentHeads` pin, OR computed as the most-
 *            senior member of each department — i.e. the member with
 *            the shortest manager-chain to `topOrder`, tiebroken
 *            alphabetically).
 *   Tier 3 — Team: every other member of each department, FLATTENED.
 *            Middle managers that sit between a department lead and a
 *            leaf agent are HIDDEN by display — the leaf appears
 *            directly under its lead. The derived A2A graph is NOT
 *            changed; only the chart is collapsed.
 *
 * Callers:
 *
 *   - TUI `/org` slash command
 *   - Channel handlers (WhatsApp, Slack, Discord — anywhere a
 *     monospace code block renders)
 *   - Model-facing `org({action:"show"})` tool
 *
 * All three call into the same `renderPrideChart` (or its channel
 * wrapper) so the chart shape can never drift between surfaces.
 *
 * NO breaking changes are introduced to the `/agents` slash command or
 * the `agents_list` tool — they keep their existing flat output. The
 * Pride chart is an ADDITIVE rendering layer.
 */

import { Chalk } from "chalk";

// A dedicated chalk instance with color forced ON, used when callers
// explicitly opt into ANSI (`ansi: true`). The default exported
// `chalk` autodetects TTY and disables itself under tests / pipes /
// non-TTY channels — which would silently drop styling for callers
// that asked for it. Forcing level=2 (256-color) gives us a stable
// escape sequence regardless of the runtime.
const ansiChalk = new Chalk({ level: 2 });

import type { OrgGraph } from "./types.js";
import {
  pickFooterRule,
  pickStory,
  pickTaunt,
  type PrideStory,
} from "./pride-taunts.js";

// ─── Brigade taunt strings (compat shims for prior callers) ─────────

/**
 * Legacy single-value constants — kept as compat shims so any caller
 * that imported the literal strings doesn't break. The chart itself
 * now rotates via `pickTaunt()` / `pickFooterRule()` from the bank in
 * `pride-taunts.ts` (145 taunts, 48 footer rules, 142 stories — all
 * M-word-banned, anonymised, internet-researched).
 *
 * Prefer the bank pickers for new code; these literals stay only so
 * older imports don't snap.
 */
export const BRIGADE_TAUNT = "Run it like a pride, not a pyramid.";
export const BRIGADE_FOOTER_RULE = "No managers, just leads and the team.";

/**
 * Note printed by `/org` when `cfg.org` is absent. Tests pin both the
 * `brigade org init` reference and the `/agents` redirect so neither
 * can be silently dropped.
 */
export const PRIDE_CHART_FLAT_CREW_NOTE = [
  "No virtual office is configured yet — your crew is flat.",
  "Run `brigade org init --template company` to scaffold a Pride hierarchy,",
  "or use `/agents` to see the flat roster as-is.",
].join("\n");

// ─── Public flatten + render API ────────────────────────────────────

/** One member entry inside a flattened department. */
export interface PrideMember {
  id: string;
  role?: string;
  bio?: string;
}

/** One department in the 3-tier flatten. */
export interface PrideDepartment {
  /** Slug of the department (matches `OrgGraph.departments` key). */
  slug: string;
  /** Department lead (resolved via pin or computed seniority). */
  lead: PrideMember;
  /**
   * Every other member of the department, FLATTENED. Middle managers
   * collapse: a leaf that reports to a middle manager still appears
   * here under the department lead. Order: alphabetical by id.
   */
  team: PrideMember[];
}

/** Result of `flattenToThreeTiers`. */
export interface PrideFlatten {
  /**
   * Tier 1: the Higher Office band. Length >= 1. Index 0 is always
   * the resolved top-of-org (kept stable for back-compat); subsequent
   * entries are c-suite members (Chief X Officer / CEO / CFO / COO /
   * CTO / CMO / CIO / CSO / CPO / CRO / CHRO / President) plus anyone
   * whose department slug is in the executive set ("executive",
   * "exec", "leadership", "higher-office", "office"), sorted by
   * manager-chain depth then alphabetically. C-suite agents that
   * were previously appearing as DEPARTMENT LEADS (e.g. CFO over
   * finance-lead) are now promoted here — which strictly REMOVES
   * a middle-manager render shape, not adds one (the Pride policy
   * "no managers, just leads and the team" is reinforced).
   */
  higherOffice: PrideMember[];
  /**
   * Tier 1 alias — `higherOffice[0]`. Kept so existing callers that
   * just want the single top-of-org agent (CLI flat-crew note path,
   * `org({action:"describe"})`, etc.) compile and work unchanged.
   */
  topOrder: PrideMember;
  /** Tier 2 + Tier 3 grouped by department slug. */
  departments: PrideDepartment[];
}

/**
 * Departments slugs that ARE the Higher Office (executive/leadership).
 * Members in these depts are auto-promoted to the Higher Office band
 * and their dept is suppressed from Tier 2 (it would otherwise
 * double-bill — the executive dept IS Higher Office).
 */
const HIGHER_OFFICE_DEPT_SLUGS: ReadonlySet<string> = new Set([
  "executive",
  "exec",
  "leadership",
  "higher-office",
  "office",
]);

/**
 * Role-name regex matching the C-suite. Word-boundary anchored so
 * "Chief of Staff" matches, "Engineering Lead" does NOT, and
 * "President of Sales" matches. Case-insensitive.
 */
const C_SUITE_ROLE_RE =
  /^\s*(chief\b|ceo\b|cfo\b|coo\b|cto\b|cio\b|cmo\b|cso\b|cpo\b|cro\b|chro\b|president\b)/i;

/**
 * Determine whether a member belongs in the Higher Office tier.
 *
 * Rules (in evaluation order):
 *   1. The graph's `topOrder` is ALWAYS in Higher Office (even if its
 *      dept/role doesn't match the rules below — defensive).
 *   2. Department slug is in the executive set
 *      (`HIGHER_OFFICE_DEPT_SLUGS`).
 *   3. Role matches the C-suite regex
 *      (`Chief X Officer` / `CEO` / `CFO` / `COO` / `CTO` / `CIO`
 *      / `CMO` / `CSO` / `CPO` / `CRO` / `CHRO` / `President`).
 *
 * Tests pin: changing this rule changes the chart shape, so the rule
 * is exported for direct unit testing.
 */
export function isHigherOfficeMember(
  id: string,
  topOrderId: string,
  member: { department: string; role?: string } | undefined,
): boolean {
  if (id === topOrderId) return true;
  if (!member) return false;
  const slug = (member.department ?? "").toLowerCase().trim();
  if (HIGHER_OFFICE_DEPT_SLUGS.has(slug)) return true;
  if (member.role && C_SUITE_ROLE_RE.test(member.role)) return true;
  return false;
}

/** Options for `renderPrideChart`. */
export interface RenderPrideChartOptions {
  /** Crew name to print after the lion in the header. */
  crewName?: string;
  /** Emoji decoration. When false, ASCII fallback tokens are used. */
  emoji?: boolean;
  /** ANSI color escapes. When false, the result is plain text. */
  ansi?: boolean;
  /**
   * Random number generator for picking taunt / footer / story from the
   * `pride-taunts.ts` bank. Defaults to a fresh-per-call live RNG so
   * every render rotates. Tests pass a seeded RNG (see
   * `createSeededRng(seed)`) to pin output.
   */
  rng?: () => number;
  /**
   * Story footer behaviour:
   *   - undefined / "auto" (default): include a random story ~50% of
   *     renders, gated by `rng()`. Keeps the chart from feeling cluttered
   *     while making most views feel fresh.
   *   - "always": render a story on every chart (good for /org --story).
   *   - "never": suppress the story footer entirely (good for /org --no-story
   *     or tests that want a deterministic chart-only render).
   */
  story?: "auto" | "always" | "never";
}

/**
 * Flatten an OrgGraph to the 3-tier Pride shape.
 *
 * Rules (re-stated for clarity):
 *   1. Tier 1 is always exactly `graph.topOrder` (or, defensively, the
 *      first member when the topOrder reference is broken).
 *   2. For each department, the lead is resolved by, in order:
 *        a. Operator pin (`cfg.org.departmentHeads[slug]`) — but the
 *           graph type doesn't carry that pin, so callers that have it
 *           should pre-resolve and call `flattenToThreeTiersWithPins`;
 *           the bare flatten falls through to (b) when no pin map is
 *           supplied. See `flattenToThreeTiers` below — the bare form
 *           uses (b) only.
 *        b. Most-senior member: shortest manager-chain length to
 *           `topOrder`. Tiebroken alphabetically by id.
 *        c. If neither (a) nor (b) yield a member, the first
 *           alphabetical member of the department is the implicit
 *           lead.
 *   3. Every other member of the department is placed in `team`,
 *      ALPHABETICAL by id. Middle managers and sub-middle managers
 *      collapse — they appear as ordinary team members under the
 *      lead.
 *   4. A member whose manager-chain does NOT terminate at `topOrder`
 *      (orphaned) is folded into the closest department: walk up the
 *      reportsTo chain until an ancestor that IS a department lead is
 *      reached, and place the member in that lead's department. If no
 *      such ancestor exists, the member's own `member.department`
 *      bucket is used. If even that fails, the bucket "unassigned" is
 *      synthesised.
 */
export function flattenToThreeTiers(graph: OrgGraph): PrideFlatten {
  return flattenToThreeTiersWithPins(graph, undefined);
}

/**
 * Same as `flattenToThreeTiers`, but allows the caller (CLI / TUI /
 * channel) to supply the `cfg.org.departmentHeads` pin map so the
 * lead-resolution rule can honour operator-authored pins.
 */
export function flattenToThreeTiersWithPins(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
): PrideFlatten {
  const memberEntries = Object.entries(graph.members);

  // ── Tier 1 — resolve top order. Fall back to first alphabetical
  // member when the graph's `topOrder` reference is broken (defensive;
  // shouldn't happen for a validated graph, but the render path must
  // never crash on a stale read).
  let topOrderId = graph.topOrder;
  if (!graph.members[topOrderId]) {
    const sorted = memberEntries.map(([id]) => id).sort();
    topOrderId = sorted[0] ?? topOrderId;
  }
  const topMember = graph.members[topOrderId];
  const topOrder: PrideMember = topMember
    ? {
        id: topOrderId,
        ...(topMember.role !== undefined ? { role: topMember.role } : {}),
        ...(topMember.bio !== undefined ? { bio: topMember.bio } : {}),
      }
    : { id: topOrderId };

  // Single-member org → no departments, no co-execs to promote.
  if (memberEntries.length <= 1) {
    return { higherOffice: [topOrder], topOrder, departments: [] };
  }

  // ── Tier 1 (multi-member) — promote c-suite to Higher Office.
  // Pre-compute depth-to-topOrder so we can stable-sort co-execs.
  const depth = computeDepthToTopOrder(graph, topOrderId);
  const promotedIds = new Set<string>([topOrderId]);
  for (const [id, m] of memberEntries) {
    if (id === topOrderId) continue;
    if (isHigherOfficeMember(id, topOrderId, m)) {
      promotedIds.add(id);
    }
  }
  const coExecIds = [...promotedIds]
    .filter((id) => id !== topOrderId)
    .sort((a, b) => {
      const da = depth[a] ?? Number.POSITIVE_INFINITY;
      const db = depth[b] ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.localeCompare(b);
    });
  const higherOffice: PrideMember[] = [
    topOrder,
    ...coExecIds.map((id) => toPrideMember(graph, id)),
  ];

  // ── Tier 2 + Tier 3 — bucket every NON-PROMOTED member into a
  // department, then resolve the lead. Members already in Higher
  // Office (CEO + c-suite) are excluded so they don't double-bill as
  // department leads (which was the structural middle-manager-render
  // bug that promoted them existed to fix).
  const buckets: Record<string, string[]> = {};
  const ensureBucket = (slug: string): string[] => {
    const existing = buckets[slug];
    if (existing) return existing;
    const created: string[] = [];
    buckets[slug] = created;
    return created;
  };

  // Seed buckets from the inverse index. Skip (a) promoted members
  // (they're in Higher Office now) and (b) executive-dept slugs
  // themselves (they ARE Higher Office; rendering as Tier 2 would
  // double-bill). Stragglers under exec slugs (a rare config — a
  // non-c-suite member parked in dept=executive) fold into
  // "unassigned" so they still surface somewhere.
  for (const [slug, ids] of Object.entries(graph.departments)) {
    const isExecSlug = HIGHER_OFFICE_DEPT_SLUGS.has(slug.toLowerCase().trim());
    if (isExecSlug) {
      // Re-bucket non-promoted members of an exec slug to "unassigned"
      // — they're orphans of the new tier rule.
      for (const id of ids) {
        if (promotedIds.has(id)) continue;
        ensureBucket("unassigned").push(id);
      }
      continue;
    }
    ensureBucket(slug);
    for (const id of ids) {
      if (promotedIds.has(id)) continue;
      ensureBucket(slug).push(id);
    }
  }

  // Members whose own department isn't in the inverse index (shouldn't
  // happen, but defensive) are folded into an "unassigned" bucket.
  for (const [id, m] of memberEntries) {
    if (promotedIds.has(id)) continue;
    const rawSlug = m.department || "unassigned";
    const slug = HIGHER_OFFICE_DEPT_SLUGS.has(rawSlug.toLowerCase().trim())
      ? "unassigned"
      : rawSlug;
    const bucket = buckets[slug];
    if (!bucket) {
      ensureBucket(slug).push(id);
    } else if (!bucket.includes(id)) {
      bucket.push(id);
    }
  }

  // Sort every bucket alphabetically — the Pride chart is order-stable.
  for (const slug of Object.keys(buckets)) {
    const b = buckets[slug];
    if (b) b.sort();
  }

  // Build the dept records.
  const departments: PrideDepartment[] = [];
  const slugs = Object.keys(buckets).sort();

  for (const slug of slugs) {
    const ids = buckets[slug] ?? [];
    if (ids.length === 0) continue;

    // Resolve the lead.
    let leadId: string | undefined;

    // (a) Operator pin.
    const pinned = departmentHeads?.[slug];
    if (pinned && ids.includes(pinned)) {
      leadId = pinned;
    }

    // (b) Most-senior member: minimum depth-to-topOrder, tiebroken
    // alphabetically (ids are already sorted, so the linear scan picks
    // the alphabetical winner on a tie).
    if (!leadId) {
      let bestDepth = Number.POSITIVE_INFINITY;
      for (const id of ids) {
        const d = depth[id] ?? Number.POSITIVE_INFINITY;
        if (d < bestDepth) {
          bestDepth = d;
          leadId = id;
        }
      }
    }

    // (c) Fallback: first alphabetical member.
    if (!leadId) leadId = ids[0];
    if (!leadId) continue;

    const teamIds = ids.filter((id) => id !== leadId);

    departments.push({
      slug,
      lead: toPrideMember(graph, leadId),
      team: teamIds.map((id) => toPrideMember(graph, id)),
    });
  }

  return { higherOffice, topOrder, departments };
}

/**
 * Render the Pride chart as a single string. Default opts are
 * `{ emoji: true, ansi: true }`.
 */
export function renderPrideChart(
  graph: OrgGraph,
  opts: RenderPrideChartOptions = {},
): string {
  return renderPrideChartWithPins(graph, undefined, opts);
}

/**
 * Render variant that accepts the operator pin map. Use this from the
 * TUI / CLI / channel layer where `cfg.org.departmentHeads` is
 * already in scope.
 */
export function renderPrideChartWithPins(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
  opts: RenderPrideChartOptions = {},
): string {
  const emoji = opts.emoji ?? true;
  const ansi = opts.ansi ?? true;
  const crewName = (opts.crewName ?? "").trim();
  // Bank pickers rotate per-call. Default RNG is live; tests pin via
  // `createSeededRng(seed)`. One `rng` reference is reused for taunt,
  // footer-rule, story selection AND the story-inclusion coin-flip so
  // the same seed yields the same chart deterministically.
  const rng = opts.rng ?? Math.random;
  const storyMode = opts.story ?? "auto";

  const flat = flattenToThreeTiersWithPins(graph, departmentHeads);

  const tokens = pickTokens(emoji);
  const paint = makePainter(ansi);

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────
  const headerLabel = "The Pride";
  const headerCrew = crewName ? ` · ${crewName}` : "";
  lines.push(`  ${paint.lion(tokens.lion)} ${paint.heading(headerLabel)}${headerCrew}`);
  lines.push(`     ${paint.taunt(pickTaunt(rng))}`);
  lines.push("");

  // ── Higher Office ──────────────────────────────────────────────
  // Renders every Higher Office member, not just topOrder. Index 0
  // (topOrder) keeps the 👑 glyph; co-execs get the smaller ✦
  // marker. The Pride policy still holds (no middle managers) — c-suite
  // members appear here BECAUSE they're peers of the top, not below.
  lines.push(`  ${paint.bar(SECTION_BAR)}${paint.section("Higher Office")}`);
  flat.higherOffice.forEach((member, idx) => {
    const glyph = idx === 0 ? tokens.crown : tokens.coExec;
    lines.push(
      `     ${paint.crown(glyph)} ${paint.id(member.id)}${
        member.role ? ` · ${paint.role(member.role)}` : ""
      }`,
    );
    if (member.bio) {
      lines.push(`        ${paint.bio(member.bio)}`);
    }
  });
  lines.push("");

  // ── Departments ─────────────────────────────────────────────────
  if (flat.departments.length > 0) {
    lines.push(`  ${paint.bar(SECTION_BAR)}${paint.section("Departments")}`);
    lines.push("");
    for (const dept of flat.departments) {
      lines.push(`    ${paint.dept(tokens.dept)} ${paint.deptSlug(dept.slug)}`);
      lines.push(
        `       Lead: ${paint.id(dept.lead.id)}${
          dept.lead.role ? ` · ${paint.role(dept.lead.role)}` : ""
        }`,
      );
      if (dept.team.length > 0) {
        lines.push(`       Team:`);
        for (const member of dept.team) {
          lines.push(
            `         · ${paint.id(member.id)}${
              member.role ? ` · ${paint.role(member.role)}` : ""
            }`,
          );
        }
      }
      lines.push("");
    }
  }

  // ── Footer ──────────────────────────────────────────────────────
  lines.push(`  ${paint.rule("──")}`);
  lines.push(`  ${paint.bolt(tokens.bolt)} ${paint.footer(pickFooterRule(rng))}`);

  // ── Story (optional) ────────────────────────────────────────────
  // `auto`: 50% chance of including a story, gated by rng().
  // `always`: include unconditionally.
  // `never`: skip the story footer entirely.
  // Drawing the gate AFTER the taunt + footer picks so seeded tests
  // get a stable include/skip decision per seed.
  const includeStory =
    storyMode === "always" ||
    (storyMode === "auto" && rng() < 0.5);
  if (includeStory) {
    const story: PrideStory = pickStory(rng);
    lines.push("");
    lines.push(
      `  ${paint.bookmark(emoji ? "📖" : ">")} ${paint.storyHead(`${story.name} · ${story.role}`)}`,
    );
    // Story body indented under the headline. Wraps naturally at the
    // 240-char cap that pride-taunts enforces, so we don't need to
    // soft-wrap here.
    lines.push(`     ${paint.story(story.story)}`);
  }

  return lines.join("\n");
}

// ─── Tree render (org-chart style with connector glyphs) ───────────

/**
 * Render the Pride chart as a TREE with branch connectors (`├──`, `└──`,
 * vertical-line continuation). Same data + same taunt/footer/story bank
 * as `renderPrideChart`, but a more visual layout suited to wide
 * monospace terminals (TUI default). Channels keep the tight list form
 * because tree connectors look noisy on narrow mobile screens.
 *
 * Layout:
 *
 *     🦁 The Pride
 *        <taunt>
 *
 *     👑 alex · Chief Executive Officer
 *     │
 *     ├── 🏛 engineering · priya · Engineering Lead
 *     │   ├── keshav · Inventory Specialist
 *     │   └── jordan · Senior Engineer
 *     │
 *     ├── 🏛 ops · rex · Operations Lead
 *     │   └── zen · Logistics
 *     │
 *     └── 🏛 strategy · demand-planner · Strategy Lead
 *
 *     ──
 *     ⚡ <footer rule>
 *
 *     📖 <name> · <role>     (optional, 50% gated)
 *        <story>
 *
 * ASCII fallback (emoji:false) swaps connectors to `|--` / `'--` / `|`
 * for terminals that don't render box-drawing chars.
 */
export function renderPrideTree(
  graph: OrgGraph,
  opts: RenderPrideChartOptions = {},
): string {
  return renderPrideTreeWithPins(graph, undefined, opts);
}

export function renderPrideTreeWithPins(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
  opts: RenderPrideChartOptions = {},
): string {
  const emoji = opts.emoji ?? true;
  const ansi = opts.ansi ?? true;
  const crewName = (opts.crewName ?? "").trim();
  const rng = opts.rng ?? Math.random;
  const storyMode = opts.story ?? "auto";

  const flat = flattenToThreeTiersWithPins(graph, departmentHeads);
  const tokens = pickTokens(emoji);
  const paint = makePainter(ansi);
  const connectors = pickConnectors(emoji);

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────
  const headerLabel = "The Pride";
  const headerCrew = crewName ? ` · ${crewName}` : "";
  lines.push(`  ${paint.lion(tokens.lion)} ${paint.heading(headerLabel)}${headerCrew}`);
  lines.push(`     ${paint.taunt(pickTaunt(rng))}`);
  lines.push("");

  // ── Higher Office (Tier 1) ──────────────────────────────────────
  // Top-of-org first with 👑, then any c-suite co-execs (CFO/COO/etc.)
  // as sibling lines with the ✦ marker. Pride policy is reinforced:
  // c-suite members are PEERS of the top, not middle managers of a
  // dept they happened to be tagged with.
  flat.higherOffice.forEach((member, idx) => {
    const glyph = idx === 0 ? tokens.crown : tokens.coExec;
    lines.push(
      `  ${paint.crown(glyph)} ${paint.id(member.id)}${
        member.role ? ` · ${paint.role(member.role)}` : ""
      }`,
    );
  });
  // Vertical drop-down to the first department branch, only when
  // there ARE departments below.
  if (flat.departments.length > 0) {
    lines.push(`  ${paint.tree(connectors.vertical)}`);
  }

  // ── Departments + their team members ────────────────────────────
  flat.departments.forEach((dept, deptIdx) => {
    const isLastDept = deptIdx === flat.departments.length - 1;
    const deptBranch = isLastDept ? connectors.lastBranch : connectors.branch;
    // Children indent: empty 4-char slot under last branch, `│   ` under
    // non-last so the vertical line continues alongside the dept's team.
    const childPrefix = isLastDept ? connectors.lastIndent : connectors.indent;

    const deptHeader =
      `  ${paint.tree(deptBranch)} ${paint.dept(tokens.dept)} ${paint.deptSlug(dept.slug)}` +
      ` · ${paint.id(dept.lead.id)}` +
      (dept.lead.role ? ` · ${paint.role(dept.lead.role)}` : "");
    lines.push(deptHeader);

    // Team members under the lead, with their own ├── / └── connectors.
    dept.team.forEach((member, memberIdx) => {
      const isLastMember = memberIdx === dept.team.length - 1;
      const memberBranch = isLastMember ? connectors.lastBranch : connectors.branch;
      lines.push(
        `  ${paint.tree(childPrefix)}${paint.tree(memberBranch)} ${paint.id(member.id)}${
          member.role ? ` · ${paint.role(member.role)}` : ""
        }`,
      );
    });

    // Blank-line separator between departments — except after the last
    // dept (the `──` footer follows).
    if (!isLastDept) {
      lines.push(`  ${paint.tree(connectors.continuation)}`);
    }
  });

  // ── Footer ──────────────────────────────────────────────────────
  lines.push("");
  lines.push(`  ${paint.rule("──")}`);
  lines.push(`  ${paint.bolt(tokens.bolt)} ${paint.footer(pickFooterRule(rng))}`);

  // ── Story (optional) ────────────────────────────────────────────
  const includeStory =
    storyMode === "always" || (storyMode === "auto" && rng() < 0.5);
  if (includeStory) {
    const story: PrideStory = pickStory(rng);
    lines.push("");
    lines.push(
      `  ${paint.bookmark(emoji ? "📖" : ">")} ${paint.storyHead(`${story.name} · ${story.role}`)}`,
    );
    lines.push(`     ${paint.story(story.story)}`);
  }

  return lines.join("\n");
}

interface TreeConnectors {
  /** `│` continuation glyph (or `|` in ASCII) */
  vertical: string;
  /** `├──` non-last branch */
  branch: string;
  /** `└──` last branch */
  lastBranch: string;
  /** `│   ` indent slot for children under a non-last branch */
  indent: string;
  /** `    ` indent slot for children under a last branch */
  lastIndent: string;
  /** `│` blank-line separator between siblings */
  continuation: string;
}

function pickConnectors(emoji: boolean): TreeConnectors {
  if (emoji) {
    return {
      vertical: "│",
      branch: "├──",
      lastBranch: "└──",
      indent: "│   ",
      lastIndent: "    ",
      continuation: "│",
    };
  }
  return {
    vertical: "|",
    branch: "|--",
    lastBranch: "'--",
    indent: "|   ",
    lastIndent: "    ",
    continuation: "|",
  };
}

// ─── Columnar render (horizontal org-chart with boxes + spine) ──────

/**
 * Render the Pride chart as a HORIZONTAL org-chart with boxes and a
 * branching spine — the "real org chart" look from common BI tools.
 * Top-of-org sits centered above the spine; department leads sit in a
 * row below; team members listed as bullets under each lead.
 *
 *                  🦁 The Pride
 *                  <taunt>
 *
 *                 ┌─────────────────────┐
 *                 │   👑 alex           │
 *                 │ Chief of Staff      │
 *                 └──────────┬──────────┘
 *                            │
 *           ┌────────────────┼────────────────┐
 *           │                │                │
 *  ┌────────┴────────┐ ┌─────┴───────────┐ ┌──┴──────────────┐
 *  │ 🏛 eng          │ │ 🏛 ops          │ │ 🏛 strat        │
 *  │ priya           │ │ rex             │ │ planner         │
 *  │ Eng Lead        │ │ Ops Lead        │ │ Strat Lead      │
 *  └─────────────────┘ └─────────────────┘ └─────────────────┘
 *    • keshav            • zen               (no team)
 *      Inv Specialist      Logistics
 *    • jordan
 *      QA
 *
 *  ──
 *  ⚡ <footer rule>
 *
 * Uses box-drawing glyphs (┌─┐│└─┘├┤┬┴┼) with emoji enabled, falls
 * back to ASCII (+ - |) otherwise. Same 3-tier flatten, same taunt +
 * footer bank as `renderPrideChart` / `renderPrideTree`.
 *
 * Width: ~57 chars for 3 departments at COL_WIDTH=17, fits in standard
 * 80-col terminals. For >4 departments the horizontal layout starts to
 * exceed common widths; callers should prefer `renderPrideTree` (vertical)
 * or `renderPrideChart` (list) when `process.stdout.columns < width`.
 */
export function renderPrideColumns(
  graph: OrgGraph,
  opts: RenderPrideChartOptions = {},
): string {
  return renderPrideColumnsWithPins(graph, undefined, opts);
}

export function renderPrideColumnsWithPins(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
  opts: RenderPrideChartOptions = {},
): string {
  const emoji = opts.emoji ?? true;
  const ansi = opts.ansi ?? true;
  const crewName = (opts.crewName ?? "").trim();
  const rng = opts.rng ?? Math.random;
  const storyMode = opts.story ?? "auto";

  const flat = flattenToThreeTiersWithPins(graph, departmentHeads);
  const tokens = pickTokens(emoji);
  const paint = makePainter(ansi);
  const bx = pickBoxChars(emoji);

  // Layout geometry — deterministic. Fits 3 depts in ~57 cols.
  const COL_WIDTH = 17;
  const GUTTER = 3;
  const N = flat.departments.length;
  const totalWidth = N === 0 ? COL_WIDTH : N * COL_WIDTH + (N - 1) * GUTTER;
  const topBoxWidth = Math.min(totalWidth, COL_WIDTH + 4);
  const topPad = Math.max(0, Math.floor((totalWidth - topBoxWidth) / 2));
  const topBoxCenterX = topPad + Math.floor(topBoxWidth / 2);

  const colCenters: number[] = [];
  for (let i = 0; i < N; i++) {
    colCenters.push(i * (COL_WIDTH + GUTTER) + Math.floor(COL_WIDTH / 2));
  }

  const lines: string[] = [];

  // Header
  const headerLabel = "The Pride";
  const headerCrew = crewName ? ` · ${crewName}` : "";
  lines.push(
    centerInWidth(
      `${tokens.lion} ${headerLabel}${headerCrew}`,
      totalWidth,
      paint.lion,
    ),
  );
  lines.push(centerInWidth(pickTaunt(rng), totalWidth, paint.taunt));
  lines.push("");

  // Top-of-org box. Now houses the entire Higher Office band: CEO
  // first with 👑, then any c-suite co-execs (CFO/COO/etc.) on
  // their own line with the ✦ marker. The box grows taller as the
  // org adds c-suite members; spine drop still anchors to the
  // bottom-center so dept connections stay aligned.
  const topInner: string[] = [
    `${tokens.crown} ${flat.topOrder.id}`,
    flat.topOrder.role ?? "",
  ];
  for (let i = 1; i < flat.higherOffice.length; i++) {
    const ce = flat.higherOffice[i];
    if (!ce) continue;
    topInner.push(`${tokens.coExec} ${ce.id}${ce.role ? ` · ${ce.role}` : ""}`);
  }
  const topBox = renderBoxLines(topInner, topBoxWidth, bx, paint, {
    bottomCenterChar: N > 0 ? bx.t : undefined,
  });
  for (const ln of topBox) {
    lines.push(" ".repeat(topPad) + ln);
  }

  if (N > 0) {
    // Vertical drop from top-box bottom into the spine row
    lines.push(" ".repeat(topBoxCenterX) + paint.tree(bx.v));

    // Horizontal spine: ┌─┬──...──┬─┐ with ┼ where top-drop meets a dept center
    lines.push(buildSpineLine(colCenters, topBoxCenterX, totalWidth, bx, paint));

    // Drops from spine to each dept-box top
    const drops: string[] = [];
    let lastEnd = 0;
    for (const x of colCenters) {
      drops.push(" ".repeat(x - lastEnd));
      drops.push(paint.tree(bx.v));
      lastEnd = x + 1;
    }
    lines.push(drops.join(""));

    // Dept boxes side by side. Top edge of each box gets a ┴ where the drop
    // lands, so the spine + box connect cleanly.
    const deptBoxes = flat.departments.map((d) =>
      renderBoxLines(
        [
          `${tokens.dept} ${d.slug}`,
          d.lead.id,
          d.lead.role ?? "",
        ],
        COL_WIDTH,
        bx,
        paint,
        { topCenterChar: bx.bottomT },
      ),
    );
    const boxHeight = deptBoxes[0]?.length ?? 0;
    for (let row = 0; row < boxHeight; row++) {
      const parts: string[] = [];
      for (let i = 0; i < N; i++) {
        if (i > 0) parts.push(" ".repeat(GUTTER));
        const box = deptBoxes[i];
        parts.push(box?.[row] ?? "");
      }
      lines.push(parts.join(""));
    }

    // Team members under each column. Two visual lines per member: bullet+id
    // then a faint role line indented two more. Columns with no team show
    // "(no team)" once on row 0; columns shorter than maxTeam pad with blanks.
    const maxTeam = Math.max(
      0,
      ...flat.departments.map((d) => d.team.length),
    );
    for (let row = 0; row < maxTeam; row++) {
      const bulletParts: string[] = [];
      const roleParts: string[] = [];
      let anyRoleThisRow = false;
      for (let i = 0; i < N; i++) {
        if (i > 0) {
          bulletParts.push(" ".repeat(GUTTER));
          roleParts.push(" ".repeat(GUTTER));
        }
        const dept = flat.departments[i];
        const m = dept?.team[row];
        if (m) {
          bulletParts.push(padRight(`  • ${m.id}`, COL_WIDTH));
          if (m.role) {
            roleParts.push(padRight(`    ${m.role}`, COL_WIDTH));
            anyRoleThisRow = true;
          } else {
            roleParts.push(" ".repeat(COL_WIDTH));
          }
        } else if (row === 0 && dept && dept.team.length === 0) {
          bulletParts.push(padRight("  (no team)", COL_WIDTH));
          roleParts.push(" ".repeat(COL_WIDTH));
        } else {
          bulletParts.push(" ".repeat(COL_WIDTH));
          roleParts.push(" ".repeat(COL_WIDTH));
        }
      }
      lines.push(bulletParts.join(""));
      if (anyRoleThisRow) lines.push(roleParts.join(""));
    }
    // Edge: every dept empty AND maxTeam=0 → render a single "(no team)"
    // row so the operator sees that explicitly rather than a blank gap.
    if (maxTeam === 0 && N > 0) {
      const parts: string[] = [];
      for (let i = 0; i < N; i++) {
        if (i > 0) parts.push(" ".repeat(GUTTER));
        parts.push(padRight("  (no team)", COL_WIDTH));
      }
      lines.push(parts.join(""));
    }
  }

  // Footer
  lines.push("");
  lines.push(`  ${paint.rule("──")}`);
  lines.push(`  ${paint.bolt(tokens.bolt)} ${paint.footer(pickFooterRule(rng))}`);

  // Optional story
  const includeStory =
    storyMode === "always" || (storyMode === "auto" && rng() < 0.5);
  if (includeStory) {
    const story: PrideStory = pickStory(rng);
    lines.push("");
    lines.push(
      `  ${paint.bookmark(emoji ? "📖" : ">")} ${paint.storyHead(`${story.name} · ${story.role}`)}`,
    );
    lines.push(`     ${paint.story(story.story)}`);
  }

  return lines.join("\n");
}

interface BoxChars {
  tl: string; tr: string; bl: string; br: string;
  h: string; v: string;
  t: string; bottomT: string; leftT: string; rightT: string;
  cross: string;
}

function pickBoxChars(emoji: boolean): BoxChars {
  if (emoji) {
    return {
      tl: "┌", tr: "┐", bl: "└", br: "┘",
      h: "─", v: "│",
      t: "┬", bottomT: "┴", leftT: "├", rightT: "┤",
      cross: "┼",
    };
  }
  return {
    tl: "+", tr: "+", bl: "+", br: "+",
    h: "-", v: "|",
    t: "+", bottomT: "+", leftT: "+", rightT: "+",
    cross: "+",
  };
}

interface BoxOpts {
  topCenterChar?: string;
  bottomCenterChar?: string;
}

function renderBoxLines(
  innerLines: string[],
  width: number,
  bx: BoxChars,
  paint: Painter,
  opts: BoxOpts = {},
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const centerIdx = Math.floor(width / 2);
  const lines: string[] = [];

  const topEdge = bx.tl + bx.h.repeat(innerWidth) + bx.tr;
  const topRendered =
    opts.topCenterChar && centerIdx > 0 && centerIdx < width - 1
      ? topEdge.slice(0, centerIdx) + opts.topCenterChar + topEdge.slice(centerIdx + 1)
      : topEdge;
  lines.push(paint.tree(topRendered));

  for (const ln of innerLines) {
    const visible = ln.length <= innerWidth ? ln : ln.slice(0, innerWidth);
    const padded = visible + " ".repeat(Math.max(0, innerWidth - visible.length));
    lines.push(paint.tree(bx.v) + padded + paint.tree(bx.v));
  }

  const botEdge = bx.bl + bx.h.repeat(innerWidth) + bx.br;
  const botRendered =
    opts.bottomCenterChar && centerIdx > 0 && centerIdx < width - 1
      ? botEdge.slice(0, centerIdx) + opts.bottomCenterChar + botEdge.slice(centerIdx + 1)
      : botEdge;
  lines.push(paint.tree(botRendered));
  return lines;
}

function buildSpineLine(
  colCenters: number[],
  topX: number,
  totalWidth: number,
  bx: BoxChars,
  paint: Painter,
): string {
  if (colCenters.length === 0) return "";
  const minX = colCenters[0]!;
  const maxX = colCenters[colCenters.length - 1]!;

  if (colCenters.length === 1) {
    const arr = new Array(totalWidth).fill(" ");
    arr[minX] = bx.bottomT;
    return paint.tree(arr.join(""));
  }

  const chars: string[] = new Array(totalWidth).fill(" ");
  for (let x = minX; x <= maxX; x++) chars[x] = bx.h;
  chars[minX] = bx.tl;
  chars[maxX] = bx.tr;
  for (let i = 1; i < colCenters.length - 1; i++) {
    chars[colCenters[i]!] = bx.t;
  }
  if (topX > minX && topX < maxX) {
    chars[topX] = colCenters.includes(topX) ? bx.cross : bx.bottomT;
  } else if (topX === minX) {
    chars[minX] = bx.leftT;
  } else if (topX === maxX) {
    chars[maxX] = bx.rightT;
  }
  return paint.tree(chars.join(""));
}

function centerInWidth(
  text: string,
  width: number,
  paint: (s: string) => string,
): string {
  const len = text.length;
  if (len >= width) return paint(text);
  const left = Math.floor((width - len) / 2);
  return " ".repeat(left) + paint(text);
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

/**
 * Channel-safe variant: forces `emoji: true, ansi: false` and wraps
 * the output in a triple-backtick monospace code block. WhatsApp,
 * Slack, and Discord all render this as a monospace block.
 */
export function renderPrideChartForChannel(
  graph: OrgGraph,
  opts: Omit<RenderPrideChartOptions, "emoji" | "ansi"> = {},
): string {
  const inner = renderPrideChart(graph, { ...opts, emoji: true, ansi: false });
  return ["```", inner, "```"].join("\n");
}

// ─── Internals ──────────────────────────────────────────────────────

const SECTION_BAR = "▌"; // ▌

interface DisplayTokens {
  lion: string;
  crown: string;
  /**
   * Co-executive marker — used for Higher Office members other than
   * the resolved topOrder (CFO/COO/CTO/etc. alongside the CEO).
   * Visually distinguishable from the crown so the top-of-org stays
   * unambiguous when there are multiple c-suite agents in Tier 1.
   */
  coExec: string;
  dept: string;
  bolt: string;
}

function pickTokens(emoji: boolean): DisplayTokens {
  if (emoji) {
    return {
      lion: "\u{1f981}", // 🦁
      crown: "\u{1f451}", // 👑
      coExec: "✦", // ✦ — four-pointed star, visually below the crown
      dept: "\u{1f3db}", // 🏛
      bolt: "⚡", // ⚡
    };
  }
  return {
    lion: "*",
    crown: "[TOP]",
    coExec: "[CXO]",
    dept: "[DEPT]",
    bolt: "!",
  };
}

interface Painter {
  lion: (s: string) => string;
  heading: (s: string) => string;
  taunt: (s: string) => string;
  bar: (s: string) => string;
  section: (s: string) => string;
  crown: (s: string) => string;
  id: (s: string) => string;
  role: (s: string) => string;
  bio: (s: string) => string;
  dept: (s: string) => string;
  deptSlug: (s: string) => string;
  rule: (s: string) => string;
  bolt: (s: string) => string;
  footer: (s: string) => string;
  bookmark: (s: string) => string;
  storyHead: (s: string) => string;
  story: (s: string) => string;
  /** Box-drawing connectors (tree branches, columnar spines). */
  tree: (s: string) => string;
}

function makePainter(ansi: boolean): Painter {
  if (!ansi) {
    const passthrough = (s: string): string => s;
    return {
      lion: passthrough,
      heading: passthrough,
      taunt: passthrough,
      bar: passthrough,
      section: passthrough,
      crown: passthrough,
      id: passthrough,
      role: passthrough,
      bio: passthrough,
      dept: passthrough,
      deptSlug: passthrough,
      rule: passthrough,
      bolt: passthrough,
      footer: passthrough,
      bookmark: passthrough,
      storyHead: passthrough,
      story: passthrough,
      tree: passthrough,
    };
  }
  return {
    lion: (s) => ansiChalk.yellow(s),
    heading: (s) => ansiChalk.bold.yellow(s),
    taunt: (s) => ansiChalk.dim(s),
    bar: (s) => ansiChalk.yellow(s),
    section: (s) => ansiChalk.bold(s),
    crown: (s) => ansiChalk.yellow(s),
    id: (s) => ansiChalk.cyan(s),
    role: (s) => ansiChalk.white(s),
    bio: (s) => ansiChalk.dim(s),
    dept: (s) => ansiChalk.yellow(s),
    deptSlug: (s) => ansiChalk.bold.cyan(s),
    rule: (s) => ansiChalk.dim(s),
    bolt: (s) => ansiChalk.yellow(s),
    footer: (s) => ansiChalk.dim(s),
    bookmark: (s) => ansiChalk.magenta(s),
    storyHead: (s) => ansiChalk.bold.magenta(s),
    story: (s) => ansiChalk.italic.dim(s),
    tree: (s) => ansiChalk.dim(s),
  };
}

function toPrideMember(graph: OrgGraph, id: string): PrideMember {
  const m = graph.members[id];
  return {
    id,
    ...(m?.role !== undefined ? { role: m.role } : {}),
    ...(m?.bio !== undefined ? { bio: m.bio } : {}),
  };
}

/**
 * For every member, compute the manager-chain length to `topOrder`.
 * Members whose chain doesn't terminate at `topOrder` get `Infinity`.
 * topOrder itself has depth 0.
 */
function computeDepthToTopOrder(
  graph: OrgGraph,
  topOrderId: string,
): Record<string, number> {
  const depth: Record<string, number> = {};
  for (const id of Object.keys(graph.members)) {
    depth[id] = computeOne(graph, id, topOrderId);
  }
  return depth;
}

function computeOne(graph: OrgGraph, id: string, topOrderId: string): number {
  if (id === topOrderId) return 0;
  let steps = 0;
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) return Number.POSITIVE_INFINITY; // cycle defense
    seen.add(cursor);
    const m: OrgGraph["members"][string] | undefined = graph.members[cursor];
    if (!m) return Number.POSITIVE_INFINITY;
    if (cursor === topOrderId) return steps;
    cursor = m.reportsTo;
    steps += 1;
    if (steps > 1024) return Number.POSITIVE_INFINITY; // runaway defense
  }
  return Number.POSITIVE_INFINITY;
}
