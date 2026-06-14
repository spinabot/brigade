/**
 * `brigade org <init|show|explain|doctor>` — Stage C CLI surface.
 *
 * Four read-mostly subcommands sitting in front of the org derivation
 * layer (src/agents/org/*):
 *
 *   - `init  --template <solo|family|company|custom>` — write a starter
 *     `cfg.org` block (templates from `./org-cmd.templates.ts`) and
 *     open $EDITOR on the brigade.json so the operator can fine-tune.
 *   - `show` — print an ASCII tree of the current org. Reads
 *     `deriveOrgDisplayGraph(cfg)`. Returns exit 1 + helpful prefix when
 *     `cfg.org` is absent.
 *   - `explain <from> <to>` — print the derivation chain (or denial
 *     reason) for a directed edge. Uses the same a2a-adapter that
 *     `sessions_send` uses, so the answer matches the runtime.
 *   - `doctor` — run the soft-warning lints (lints.ts) AND surface any
 *     hard-violation errors caught from `deriveOrgGraph` so the
 *     operator can fix config typos before chat sees them.
 *
 * STAGE-C CONTRACT
 * ----------------
 *   - `init` writes the merged starter into brigade.json via
 *     `saveConfig`, then spawns $EDITOR (or whatever
 *     `process.env.VISUAL`/`EDITOR` resolves to). Tests pass
 *     `skipEditor: true` to suppress the editor spawn so init can be
 *     exercised in CI.
 *   - All four commands return numeric exit codes (0 = success, 1 =
 *     soft failure, 2 = hard error) AND honour `--json` for machine-
 *     readable output. The shape mirrors other Brigade CLI commands.
 *
 * No openclaw / clawd / hermes / boop / paperclip / nanoclaw
 * identifiers are referenced from this file.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveConfigPath } from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { deriveOrgDisplayGraph } from "../../agents/org/derive-graph.js";
import { orgGraphAsA2APolicy } from "../../agents/org/a2a-adapter.js";
import { lintOrgGraph } from "../../agents/org/lints.js";
import {
  BrigadeOrgConfigError,
  type OrgGraph,
  type OrgLintWarning,
} from "../../agents/org/types.js";
import {
  getOrgTemplate,
  listOrgTemplateIds,
  type OrgTemplateId,
} from "./org-cmd.templates.js";

/* ─────────────────────── shared output helpers ─────────────────────── */

interface OutputOpts {
  json?: boolean;
  /** When true, write JSON to a captured array (testing). */
  capture?: { stdout: string[]; stderr: string[] };
}

function out(line: string, opts: OutputOpts): void {
  if (opts.capture) {
    opts.capture.stdout.push(line);
    return;
  }
  process.stdout.write(line + "\n");
}

function err(line: string, opts: OutputOpts): void {
  if (opts.capture) {
    opts.capture.stderr.push(line);
    return;
  }
  process.stderr.write(line + "\n");
}

function emitJson(payload: unknown, opts: OutputOpts): void {
  out(JSON.stringify(payload, null, 2), opts);
}

/* ───────────────────────────── init ───────────────────────────── */

export interface OrgInitOpts extends OutputOpts {
  template: string;
  /** Test-only: skip the $EDITOR spawn. */
  skipEditor?: boolean;
  /** Test-only override for the editor command (otherwise reads env). */
  editorCmd?: string;
}

/**
 * `brigade org init --template <id>`.
 *
 * 1. Look up the template.
 * 2. Merge `template.org` + `template.agents` into the current config.
 *    DOES NOT replace existing fields on already-configured agents —
 *    only fills missing `.org` blocks.
 * 3. Persist via `saveConfig`.
 * 4. Spawn $EDITOR on the brigade.json (skippable via `skipEditor`).
 */
export async function runOrgInit(opts: OrgInitOpts): Promise<number> {
  const template = getOrgTemplate(opts.template);
  if (!template) {
    const valid = listOrgTemplateIds().join(", ");
    if (opts.json) {
      emitJson(
        {
          status: "error",
          error: `unknown template "${opts.template}"`,
          valid: listOrgTemplateIds(),
        },
        opts,
      );
    } else {
      err(`brigade org init: unknown template "${opts.template}" (valid: ${valid})`, opts);
    }
    return 2;
  }

  const cfg = loadConfig();
  // Refuse to overwrite an existing cfg.org block — that's destructive
  // and the operator should hand-edit instead. Tests + future re-init
  // flows can pass `--force`, but for now we keep the surface tight.
  if (cfg.org) {
    if (opts.json) {
      emitJson(
        {
          status: "error",
          error: "cfg.org already present — refusing to overwrite (edit brigade.json directly)",
        },
        opts,
      );
    } else {
      err(
        "brigade org init: cfg.org already present in brigade.json — edit it directly to make changes.",
        opts,
      );
    }
    return 2;
  }

  // Merge template.org + template.agents into cfg.
  const nextCfg = mergeTemplateIntoCfg(cfg, template.id, template);
  saveConfig(nextCfg);

  const configPath = resolveConfigPath();
  if (opts.json) {
    emitJson(
      {
        status: "ok",
        template: template.id,
        configPath,
        org: nextCfg.org,
        agents: filterTemplateAgents(nextCfg, template),
      },
      opts,
    );
  } else {
    out(`brigade org init: wrote starter (template=${template.id}) to ${configPath}`, opts);
  }

  if (opts.skipEditor === true) return 0;
  spawnEditor(configPath, opts);
  return 0;
}

function mergeTemplateIntoCfg(
  cfg: ReturnType<typeof loadConfig>,
  templateId: OrgTemplateId,
  template: NonNullable<ReturnType<typeof getOrgTemplate>>,
): ReturnType<typeof loadConfig> {
  // Avoid silencing the unused param — used by tests to introspect.
  void templateId;
  const next = { ...cfg };
  next.org = template.org;
  const agents = { ...(next.agents ?? {}) } as Record<string, unknown>;
  for (const [id, block] of Object.entries(template.agents)) {
    const existing = (agents[id] ?? {}) as Record<string, unknown>;
    agents[id] = { ...existing, org: block };
  }
  next.agents = agents as never;
  return next;
}

function filterTemplateAgents(
  cfg: ReturnType<typeof loadConfig>,
  template: NonNullable<ReturnType<typeof getOrgTemplate>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(template.agents)) {
    out[id] = (cfg.agents as Record<string, unknown> | undefined)?.[id];
  }
  return out;
}

function spawnEditor(configPath: string, opts: OrgInitOpts): void {
  const cmd = opts.editorCmd ?? process.env.VISUAL ?? process.env.EDITOR ?? "";
  if (!cmd.trim()) {
    out(
      `(set $EDITOR / $VISUAL to auto-open the file; brigade.json: ${configPath})`,
      opts,
    );
    return;
  }
  try {
    spawnSync(cmd, [configPath], { stdio: "inherit", shell: true });
  } catch {
    err(`brigade org init: failed to spawn editor ${JSON.stringify(cmd)}`, opts);
  }
}

/* ───────────────────────────── show ───────────────────────────── */

export interface OrgShowOpts extends OutputOpts {}

/**
 * `brigade org show` — print an ASCII tree of the current org. Leaf
 * agents indent under their managers; same-dept peers are grouped.
 */
export async function runOrgShow(opts: OrgShowOpts): Promise<number> {
  const cfg = loadConfig();
  let graph: OrgGraph | undefined;
  try {
    graph = deriveOrgDisplayGraph(cfg);
  } catch (e) {
    if (e instanceof BrigadeOrgConfigError) {
      if (opts.json) {
        emitJson({ status: "error", code: e.code, error: e.message, detail: e.detail }, opts);
      } else {
        err(`brigade org show: ${e.code}: ${e.message}`, opts);
      }
      return 2;
    }
    throw e;
  }
  if (!graph) {
    if (opts.json) {
      emitJson({ status: "no-org", note: "cfg.org is absent — run `brigade org init`" }, opts);
    } else {
      out("(no cfg.org block — run `brigade org init` to create one)", opts);
    }
    return 0;
  }

  if (opts.json) {
    emitJson({ status: "ok", graph }, opts);
    return 0;
  }

  // ASCII tree: print topOrder, then recurse into direct reports.
  const lines = renderOrgTree(graph);
  for (const line of lines) out(line, opts);
  return 0;
}

function renderOrgTree(graph: OrgGraph): string[] {
  const lines: string[] = [];
  const top = graph.members[graph.topOrder];
  lines.push(`${graph.topOrder}${top?.role ? `  [${top.role}]` : ""}  (${top?.department ?? "?"})`);
  // Build child-index: manager → reports[].
  const childIndex: Record<string, string[]> = {};
  for (const [id, m] of Object.entries(graph.members)) {
    if (!m.reportsTo) continue;
    const bucket = childIndex[m.reportsTo] ?? [];
    bucket.push(id);
    childIndex[m.reportsTo] = bucket;
  }
  // Walk children depth-first.
  const visit = (id: string, prefix: string): void => {
    const children = (childIndex[id] ?? []).slice().sort();
    children.forEach((childId, idx) => {
      const isLast = idx === children.length - 1;
      const branch = isLast ? "└─ " : "├─ ";
      const continuation = isLast ? "   " : "│  ";
      const child = graph.members[childId];
      lines.push(
        `${prefix}${branch}${childId}${child?.role ? `  [${child.role}]` : ""}  (${child?.department ?? "?"})`,
      );
      visit(childId, prefix + continuation);
    });
  };
  visit(graph.topOrder, "");
  // Append a footer with departments.
  lines.push("");
  lines.push("Departments:");
  for (const dept of Object.keys(graph.departments).sort()) {
    const members = graph.departments[dept]?.slice().sort() ?? [];
    lines.push(`  ${dept}: ${members.join(", ")}`);
  }
  return lines;
}

/* ───────────────────────────── explain ───────────────────────────── */

export interface OrgExplainOpts extends OutputOpts {
  from: string;
  to: string;
}

/**
 * `brigade org explain <from> <to>` — print whether the edge is allowed,
 * the derivation chain when it is, OR the denial reason when it's not.
 * Mirrors what `sessions_send` would do at runtime (same a2a-adapter).
 */
export async function runOrgExplain(opts: OrgExplainOpts): Promise<number> {
  const cfg = loadConfig();
  let graph: OrgGraph | undefined;
  try {
    graph = deriveOrgDisplayGraph(cfg);
  } catch (e) {
    if (e instanceof BrigadeOrgConfigError) {
      if (opts.json) {
        emitJson({ status: "error", code: e.code, error: e.message, detail: e.detail }, opts);
      } else {
        err(`brigade org explain: ${e.code}: ${e.message}`, opts);
      }
      return 2;
    }
    throw e;
  }
  if (!graph) {
    if (opts.json) {
      emitJson({ status: "no-org" }, opts);
    } else {
      out("(no cfg.org block — derived A2A is not in effect)", opts);
    }
    return 0;
  }

  // Explicit mode: runtime allow/deny comes from the flat
  // `session.agentToAgent.allow` matrix, NOT org edges — printing an
  // edge-based ALLOWED/DENIED here would contradict what sessions_send
  // actually does at runtime. Show the org SHAPE between the pair instead,
  // clearly labelled as structure-only.
  if (graph.mode === "explicit") {
    const shapeEdges = graph.edges.filter((e) => e.from === opts.from && e.to === opts.to);
    const note =
      'a2a mode is "explicit" — runtime allow/deny comes from session.agentToAgent.allow; ' +
      "the org edges below describe structure only.";
    if (opts.json) {
      emitJson(
        {
          status: "explicit-mode",
          from: opts.from,
          to: opts.to,
          note,
          orgShapeEdges: shapeEdges,
        },
        opts,
      );
    } else {
      out(note, opts);
      out(
        `org shape ${opts.from} → ${opts.to}: ${shapeEdges.length > 0 ? "connected" : "not connected"}`,
        opts,
      );
      for (const e of shapeEdges) {
        out(`  reason: ${e.reason}${e.note ? ` (${e.note})` : ""}`, opts);
      }
    }
    return 0;
  }

  // Mirror the runtime's orchestrator bypass (resolve-access.ts) so
  // `org explain main <member>` reports what sessions_send actually does.
  const orgA2a = (cfg as { org?: { a2a?: { restrictDefaultAgent?: unknown } } }).org?.a2a;
  const policy = orgGraphAsA2APolicy(
    graph,
    orgA2a?.restrictDefaultAgent === true ? {} : { orchestratorId: resolveDefaultAgentId(cfg) },
  );
  const allowed = policy.isAllowed(opts.from, opts.to);
  if (allowed) {
    const edges = graph.edges.filter((e) => e.from === opts.from && e.to === opts.to);
    if (opts.json) {
      emitJson({ status: "allowed", from: opts.from, to: opts.to, edges }, opts);
    } else {
      out(`${opts.from} → ${opts.to}: ALLOWED`, opts);
      for (const e of edges) {
        out(`  reason: ${e.reason}${e.note ? ` (${e.note})` : ""}`, opts);
      }
    }
    return 0;
  }
  // Denied — compute structured reason.
  const reason = computeDenialReason(graph, opts.from, opts.to);
  if (opts.json) {
    emitJson({ status: "denied", from: opts.from, to: opts.to, reason }, opts);
  } else {
    out(`${opts.from} → ${opts.to}: DENIED`, opts);
    out(`  reason: ${reason}`, opts);
  }
  return 0;
}

function computeDenialReason(graph: OrgGraph, from: string, to: string): string {
  const f = graph.members[from];
  const t = graph.members[to];
  if (!f) return `caller ${JSON.stringify(from)} is not a member of the org`;
  if (!t) return `target ${JSON.stringify(to)} is not a member of the org`;
  if (f.department !== t.department) {
    return `cross-department edge ${JSON.stringify(f.department)} → ${JSON.stringify(t.department)} is closed by rule (v)`;
  }
  return `no direct edge in derived graph`;
}

/* ───────────────────────────── doctor ───────────────────────────── */

export interface OrgDoctorOpts extends OutputOpts {}

/**
 * `brigade org doctor` — run the lints from Stage A. Surfaces both hard
 * errors (when `deriveOrgGraph` throws) and soft warnings (the lints).
 */
export async function runOrgDoctor(opts: OrgDoctorOpts): Promise<number> {
  const cfg = loadConfig();
  let graph: OrgGraph | undefined;
  try {
    graph = deriveOrgDisplayGraph(cfg);
  } catch (e) {
    if (e instanceof BrigadeOrgConfigError) {
      if (opts.json) {
        emitJson(
          {
            status: "error",
            code: e.code,
            error: e.message,
            detail: e.detail,
            warnings: [],
          },
          opts,
        );
      } else {
        err(`brigade org doctor: HARD ERROR — ${e.code}: ${e.message}`, opts);
      }
      return 2;
    }
    throw e;
  }
  if (!graph) {
    if (opts.json) {
      emitJson({ status: "no-org", warnings: [] }, opts);
    } else {
      out("(no cfg.org block — nothing to lint)", opts);
    }
    return 0;
  }
  const lints: OrgLintWarning[] = lintOrgGraph(cfg, graph);
  if (opts.json) {
    emitJson({ status: "ok", warnings: lints }, opts);
  } else {
    if (lints.length === 0) {
      out(`brigade org doctor: 0 warnings.`, opts);
    } else {
      out(`brigade org doctor: ${lints.length} warning(s).`, opts);
      for (const w of lints) {
        out(`  [${w.code}] ${w.message}`, opts);
      }
    }
  }
  // Soft warnings DO NOT fail the command — the operator should fix
  // them, but the install is still usable.
  return 0;
}

/* ───────────── test-only helper: write fake brigade.json ────────── */

/** Test helper: stamp a brigade.json into the current state dir. */
export function _writeBrigadeJsonForTest(path: string, cfg: unknown): void {
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
}
