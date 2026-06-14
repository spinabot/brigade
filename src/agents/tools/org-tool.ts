/**
 * `org` tool — consolidated virtual-office surface.
 *
 * One tool, many actions. Replaces the previous two-tool surface
 * (`org_describe` + `delegate_to_department`) with a single
 * action-dispatching tool so the model sees a single coherent
 * org-shaped surface instead of having to remember which verb
 * lives behind which name.
 *
 * Actions:
 *   - `describe`  — caller-scoped position + reachable peers (the
 *                   former `org_describe` shape, BIT-FOR-BIT).
 *   - `show`      — ASCII tree of the entire org for grounding
 *                   multi-step planning.
 *   - `delegate`  — cross-dept delegation (the former
 *                   `delegate_to_department` shape, BIT-FOR-BIT).
 *   - `init`      — bootstrap a `cfg.org` block from one of the
 *                   four starter templates (mirrors `brigade org init`).
 *   - `set`       — update an existing agent's org block (does NOT
 *                   create agents — that's `manage_agent`'s job).
 *   - `explain`   — print whether a directed edge exists and why,
 *                   mirroring `brigade org explain`.
 *   - `plan`      — reserved action slot. Currently throws "not yet
 *                   implemented" so the action surface is forward-
 *                   compatible.
 *
 * REGISTRATION CONTRACT
 * ---------------------
 *   - Surfaced to the model ONLY when `cfg.org` is present (registry
 *     gate). When `cfg.org` is absent the tool does not exist for
 *     the model — every existing pre-org install sees the legacy
 *     tool list bit-for-bit unchanged.
 *   - Per-action capability checks happen INSIDE the execute body:
 *       - `delegate` additionally requires
 *         `cfg.session.agentToAgent.enabled === true` (legacy Stage-D
 *         gate). The registry gate now surfaces the tool whenever
 *         cfg.org is present; the delegate action itself refuses
 *         closed when A2A is off.
 *       - `init` refuses when cfg.org is ALREADY present (mirrors the
 *         `brigade org init` CLI posture — destructive overwrites
 *         must go through hand-edit, not the LLM).
 *       - `set` refuses when the targeted agent does not exist
 *         (points the model at `manage_agent` to create it first).
 *
 * No openclaw / clawd / hermes / boop / paperclip / nanoclaw
 * identifiers are referenced from this file.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import crypto from "node:crypto";
import path from "node:path";
import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import {
  getOrgTemplate,
  listOrgTemplateIds,
} from "../../cli/commands/org-cmd.templates.js";
import {
  mutateConfigAtomic,
  type BrigadeConfig,
} from "../../config/io.js";
import { deriveOrgDisplayGraph, deriveOrgGraph } from "../org/derive-graph.js";
import {
  encodeDeliveryKindContextKey,
  isDeliveryKind,
  type DeliveryKind,
} from "../org/delivery-kind.js";
import {
  PRIDE_CHART_FLAT_CREW_NOTE,
  renderPrideChartWithPins,
  renderPrideColumnsWithPins,
  renderPrideTreeWithPins,
} from "../org/pride-template.js";
import { markTransientImage, saveOrgChartImage } from "../org/pride-image.js";
import type { OrgGraph } from "../org/types.js";
import { callGateway } from "../gateway-call.js";
import { nestedLane } from "../../process/lanes.js";
import {
  buildBrigadeMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import { enqueueSystemEvent } from "../session-inbox.js";
import { jsonResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

/* ─────────────────────────── schema ─────────────────────────── */

const OrgParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("describe"),
      Type.Literal("show"),
      Type.Literal("delegate"),
      Type.Literal("init"),
      Type.Literal("set"),
      Type.Literal("explain"),
      Type.Literal("plan"),
    ],
    {
      description:
        "describe: caller-scoped position + reachable peers. show: the Pride hierarchy chart (🦁 Higher Office / 🏛 Departments / Team — flattened to 3 tiers). delegate: hand work to a department head. init: bootstrap cfg.org from a starter template. set: update an existing agent's org block. explain: why this edge exists (or does not). plan: reserved — not yet implemented.",
    },
  ),
  // delegate
  department: Type.Optional(
    Type.String({
      description:
        "Target department slug (delegate). The tool resolves the canonical head from the derived graph.",
      minLength: 1,
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Message body (delegate).",
      minLength: 1,
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Delegate: when true, the caller plans to poll the head's session for a reply on the next turn. Defaults to false (fire-and-forget; reply lands in the head's session).",
    }),
  ),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("delegation"),
        Type.Literal("escalation"),
        Type.Literal("review"),
      ],
      {
        description:
          "Delegate framing verb: 'delegation' (own the work), 'escalation' (up the chain), or 'review' (feedback only). Default: delegation.",
      },
    ),
  ),
  // init
  template: Type.Optional(
    Type.String({
      description:
        "init: starter template id (solo / family / company / custom).",
      minLength: 1,
    }),
  ),
  // set
  agentId: Type.Optional(
    Type.String({
      description: "set: id of the existing agent whose org block to update.",
      minLength: 1,
    }),
  ),
  reportsTo: Type.Optional(
    Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
      description:
        "set: new reportsTo (agent id, or null to mark as top-of-org).",
    }),
  ),
  role: Type.Optional(
    Type.String({ description: "set: human role label (cosmetic)." }),
  ),
  bio: Type.Optional(
    Type.String({ description: "set: short bio surfaced in org-aware prompts." }),
  ),
  // explain
  from: Type.Optional(
    Type.String({ description: "explain: source agent id.", minLength: 1 }),
  ),
  to: Type.Optional(
    Type.String({ description: "explain: target agent id.", minLength: 1 }),
  ),
  // plan
  task: Type.Optional(
    Type.String({
      description: "plan (reserved): task description.",
      minLength: 1,
    }),
  ),
  // show
  format: Type.Optional(
    Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("tree"),
        Type.Literal("columns"),
        Type.Literal("image"),
      ],
      {
        description:
          "show: render style. 'list' (default, LLM-friendly) — the tight 3-section list. 'tree' — vertical indent tree with branch connectors. 'columns' — horizontal org-chart with boxes + spine (best on wide terminals). 'image' — render the same as a PNG (or SVG fallback) on disk; result includes `imagePath` the model can hand to a channel's send-media tool. ASCII chart is still returned for the model's own grounding.",
      },
    ),
  ),
});

/* ─────────────────────────── result shapes ─────────────────────────── */

export type OrgDescribeReachableReason =
  | "direct-report"
  | "direct-manager"
  | "dept-peer"
  | "topOrder-escalation"
  | "topOrder-broadcast"
  | "extra-allow"
  | "inherited-spawn";

export interface OrgDescribeReachableEntry {
  to: string;
  reason: OrgDescribeReachableReason;
}

export interface OrgDescribeResult {
  caller: string;
  role?: string;
  department?: string;
  reportsTo?: string | null;
  bio?: string;
  reports: string[];
  deptPeers: string[];
  topOrder: string;
  otherDepartments: string[];
  reachable: OrgDescribeReachableEntry[];
  notAMember?: true;
  /** Present under a2a mode "explicit": `reachable` describes org STRUCTURE
   *  only — runtime permissions come from the flat session.agentToAgent.allow
   *  matrix, so a structurally-reachable peer may still be denied. */
  note?: string;
}

export interface OrgShowResult {
  status?: "ok" | "no-org";
  /** Present when cfg.org is configured — the rendered Pride chart string. */
  chart?: string;
  /**
   * Render style used. `"list"` is the tight 3-section list (default,
   * LLM-friendly), `"tree"` the vertical branch-connector tree,
   * `"columns"` the horizontal org-chart with boxes + spine, `"image"`
   * is image mode (chart still returned in ASCII for grounding;
   * `imagePath`/`mimeType` fields carry the file). The legacy tag
   * `"pride-template"` is no longer emitted.
   */
  format?: "list" | "tree" | "columns" | "image";
  /** `true` on success, omitted/false when cfg.org is absent (flat crew). */
  ok?: boolean;
  /** Friendly redirect note printed when cfg.org is absent. */
  redirect?: string;
  /** Raw OrgGraph for downstream re-rendering / agent grounding. */
  graph?: OrgGraph;
  /**
   * (image mode) Absolute path to the rendered PNG (or SVG fallback)
   * on disk. The model can hand this path to a channel's send-media
   * tool (e.g. WhatsApp, iMessage, Discord) to attach the chart inline.
   */
  imagePath?: string;
  /** (image mode) `image/png` when rasterized, `image/svg+xml` for SVG fallback. */
  mimeType?: "image/png" | "image/svg+xml";
  /**
   * (image mode) `true` when `@resvg/resvg-js` produced PNG, `false`
   * when SVG fallback was used (install missing or rasterizer error).
   * Channels can downgrade gracefully: PNG previews inline; SVG sends
   * as a file attachment.
   */
  rasterized?: boolean;
  /** (image mode) Pixel width of the rendered image. */
  imageWidth?: number;
  /** (image mode) Pixel height of the rendered image. */
  imageHeight?: number;
  /**
   * Channel-turn-only nudge for the model — present when the tool was
   * called on a channel-routed turn. Tells the LLM to dispatch via
   * `send_media` (success) or `send_message` (image-render failure).
   * Numbered-list format so smaller models follow the steps in order.
   * Empty / undefined for TUI / CLI / sub-agent turns.
   */
  instructions?: string;
}

export interface OrgDelegateResult {
  status: "accepted" | "ok" | "forbidden" | "error";
  department?: string;
  targetAgentId?: string;
  targetSessionKey?: string;
  kind?: DeliveryKind;
  idempotencyKey?: string;
  reply?: string;
  error?: string;
}

export interface OrgInitResult {
  ok: boolean;
  template?: string;
  written?: unknown;
  error?: string;
  valid?: string[];
}

export interface OrgSetResult {
  ok: boolean;
  agentId?: string;
  org?: unknown;
  error?: string;
}

export interface OrgExplainResult {
  status: "allowed" | "denied" | "no-org" | "error";
  from?: string;
  to?: string;
  allowed?: boolean;
  reason?: string;
  chain?: Array<{ reason: string; note?: string }>;
  error?: string;
}

export interface OrgPlanResult {
  ok: false;
  error: "not yet implemented";
  suggest: string;
}

export type OrgToolResult =
  | OrgDescribeResult
  | OrgShowResult
  | OrgDelegateResult
  | OrgInitResult
  | OrgSetResult
  | OrgExplainResult
  | OrgPlanResult
  | { status: "error"; error: string };

/* ─────────────────────────── factory ─────────────────────────── */

export interface MakeOrgToolOptions {
  /** Caller's agent id — drives caller-scoped views and delegate `from` tag. */
  requesterAgentId?: string;
  /**
   * Caller's session key — used to set `spawnedBy` when delegate dispatches
   * the peer turn. Optional because the delegate action can still enqueue
   * the inbox event without a session-key prefix.
   */
  agentSessionKey?: string;
  /**
   * Channel-routed turn context. When present, the `show` action
   * auto-defaults `format` to `"image"` and emits a strong "now call
   * send_media" instruction in the tool result so a chat user gets a
   * picture instead of an ASCII code block. Pass-through TUI / CLI
   * turns leave this undefined and keep the default `format:"list"`.
   */
  channelContext?: ChannelApprovalRoute;
}

interface OrgToolParams {
  action:
    | "describe"
    | "show"
    | "delegate"
    | "init"
    | "set"
    | "explain"
    | "plan";
  department?: string;
  message?: string;
  wait?: boolean;
  kind?: string;
  template?: string;
  agentId?: string;
  reportsTo?: string | null;
  role?: string;
  bio?: string;
  from?: string;
  to?: string;
  task?: string;
  format?: "list" | "tree" | "columns" | "image";
}

/**
 * Build the consolidated `org` tool. The factory captures the caller's
 * metadata at registration time; the graph itself is resolved on every
 * call so brigade.json edits during the same session take effect on
 * the next turn.
 */
export function makeOrgTool(
  opts: MakeOrgToolOptions = {},
): BrigadeTool<typeof OrgParams, OrgToolResult> {
  const requesterAgentId = normalizeAgentId(
    opts.requesterAgentId ?? DEFAULT_AGENT_ID,
  );
  return {
    name: "org",
    label: "Org",
    description:
      "Virtual-office surface. Single tool, many actions: `describe` (your position + reachable peers), `show` (the Pride hierarchy chart — 🦁 The Pride · Higher Office / Departments / Team, flattened to 3 tiers; `format:'list'` default = tight LLM-friendly chart, `'tree'` = vertical branch tree, `'columns'` = horizontal org-chart with boxes, `'image'` = render to PNG/SVG on disk and return `imagePath` for the channel's send-media tool — call with `format:'image'` when a chat user asks to *see* the org), `delegate` (cross-dept hand-off), `init` (bootstrap cfg.org from a template), `set` (update an existing agent's org block), `explain` (why this edge exists or doesn't), `plan` (reserved). Only surfaced when an org config is present.",
    parameters: OrgParams,
    execute: async (
      _toolCallId: string,
      params: OrgToolParams,
    ): Promise<AgentToolResult<OrgToolResult>> => {
      const action = params.action;
      switch (action) {
        case "describe":
          return executeDescribe(requesterAgentId);
        case "show":
          return executeShow(params, opts.channelContext);
        case "delegate":
          return executeDelegate(params, requesterAgentId, opts.agentSessionKey);
        case "init":
          return executeInit(params);
        case "set":
          return executeSet(params);
        case "explain":
          return executeExplain(params);
        case "plan":
          return executePlan();
        default:
          return jsonResult({
            status: "error",
            error: `org: unknown action ${JSON.stringify(action)}`,
          }) as AgentToolResult<OrgToolResult>;
      }
    },
  };
}

/* ─────────────────────────── describe ─────────────────────────── */

function executeDescribe(
  requesterAgentId: string,
): AgentToolResult<OrgToolResult> {
  const cfg = loadConfig();
  const graph = deriveOrgDisplayGraph(cfg as never);
  if (!graph) {
    // Defensive: registry gate prevents the tool from surfacing when
    // cfg.org is absent. If a test / internal caller reaches here, emit
    // an empty envelope rather than throwing.
    return jsonResult(
      buildEmptyDescribeResult(requesterAgentId),
    ) as AgentToolResult<OrgToolResult>;
  }

  const member = graph.members[requesterAgentId];
  if (!member) {
    const result: OrgDescribeResult = {
      ...buildEmptyDescribeResult(requesterAgentId),
      topOrder: graph.topOrder,
      otherDepartments: Object.keys(graph.departments).sort(),
      notAMember: true,
    };
    return jsonResult(result) as AgentToolResult<OrgToolResult>;
  }

  const reports = collectReports(graph, requesterAgentId);
  const deptPeers = collectDeptPeers(graph, requesterAgentId);
  const otherDepartments = Object.keys(graph.departments)
    .filter((d) => d !== member.department)
    .sort();
  const reachable = collectReachable(graph, requesterAgentId);

  const result: OrgDescribeResult = {
    caller: requesterAgentId,
    ...(member.role ? { role: member.role } : {}),
    department: member.department,
    reportsTo: member.reportsTo,
    ...(member.bio ? { bio: member.bio } : {}),
    reports,
    deptPeers,
    topOrder: graph.topOrder,
    otherDepartments,
    reachable,
    ...(graph.mode === "explicit"
      ? {
          note:
            'a2a mode is "explicit" — messaging permissions come from session.agentToAgent.allow; ' +
            "`reachable` describes org structure only, not what sessions_send will allow.",
        }
      : {}),
  };
  return jsonResult(result) as AgentToolResult<OrgToolResult>;
}

function buildEmptyDescribeResult(caller: string): OrgDescribeResult {
  return {
    caller,
    reports: [],
    deptPeers: [],
    topOrder: caller,
    otherDepartments: [],
    reachable: [],
  };
}

function collectReports(graph: OrgGraph, callerAgentId: string): string[] {
  const out: string[] = [];
  for (const [id, m] of Object.entries(graph.members)) {
    if (m.reportsTo === callerAgentId) out.push(id);
  }
  out.sort();
  return out;
}

function collectDeptPeers(graph: OrgGraph, callerAgentId: string): string[] {
  const caller = graph.members[callerAgentId];
  if (!caller) return [];
  const out: string[] = [];
  for (const [id, m] of Object.entries(graph.members)) {
    if (id === callerAgentId) continue;
    if (m.department === caller.department) out.push(id);
  }
  out.sort();
  return out;
}

function collectReachable(
  graph: OrgGraph,
  callerAgentId: string,
): OrgDescribeReachableEntry[] {
  const out: OrgDescribeReachableEntry[] = [];
  const seen = new Set<string>();
  const isTopOrder = callerAgentId === graph.topOrder;
  for (const edge of graph.edges) {
    if (edge.from !== callerAgentId) continue;
    if (seen.has(edge.to)) continue;
    seen.add(edge.to);
    out.push({
      to: edge.to,
      reason: mapReason(edge.reason, edge.to, graph, isTopOrder),
    });
  }
  out.sort((a, b) => a.to.localeCompare(b.to));
  return out;
}

function mapReason(
  reason: OrgGraph["edges"][number]["reason"],
  toAgentId: string,
  graph: OrgGraph,
  callerIsTopOrder: boolean,
): OrgDescribeReachableReason {
  if (reason === "assignment-down") return "direct-report";
  if (reason === "escalation-up") {
    if (toAgentId === graph.topOrder && !callerIsTopOrder)
      return "topOrder-escalation";
    return "direct-manager";
  }
  if (reason === "lateral-peer") return "dept-peer";
  if (reason === "topOrder-broadcast") {
    return callerIsTopOrder ? "topOrder-broadcast" : "topOrder-escalation";
  }
  if (reason === "extra-allow") return "extra-allow";
  if (reason === "subagent-inherited") return "inherited-spawn";
  return "topOrder-broadcast";
}

/* ─────────────────────────── show ─────────────────────────── */

/**
 * Render the model-facing org chart. Branches on `format`:
 *   - "list"    (default) — tight 3-section list (LLM-friendly,
 *                           narrow-channel-safe, the original shape).
 *   - "tree"    — vertical indent tree with ├── / └── connectors.
 *   - "columns" — horizontal org-chart with boxes + branching spine
 *                 (the "real org chart" look; wide-terminal best).
 *   - "image"   — render once + write to disk as PNG (or SVG
 *                 fallback), returning a file path the model can hand
 *                 to a channel's send-media tool. The ASCII chart is
 *                 also returned so the model still has the org in
 *                 textual form for grounding subsequent reasoning.
 *
 * ANSI is OFF in every branch so the model sees clean monospace; the
 * TUI re-renders with `ansi: true` separately. When cfg.org is absent
 * the model sees the same friendly redirect note an operator would
 * see on `/org` — never a crash, never a flat-list fallback that
 * pretends a pyramid was rendered.
 */
async function executeShow(
  params: OrgToolParams,
  channelContext?: MakeOrgToolOptions["channelContext"],
): Promise<AgentToolResult<OrgToolResult>> {
  const cfg = loadConfig() as {
    org?: { departmentHeads?: Record<string, string> };
  };
  const graph = deriveOrgDisplayGraph(cfg as never);
  if (!graph) {
    return jsonResult({
      ok: false,
      status: "no-org",
      redirect: PRIDE_CHART_FLAT_CREW_NOTE,
    }) as AgentToolResult<OrgToolResult>;
  }
  const pins = cfg.org?.departmentHeads;
  // Channel auto-default: when the turn was routed in via a chat
  // channel (WhatsApp / Slack / Telegram / Discord) AND the caller
  // didn't pin a format explicitly, pick "image" — chat users want a
  // picture, not an ASCII code block. TUI / CLI turns leave
  // channelContext undefined and keep the default "list".
  const format =
    params.format ?? (channelContext ? "image" : "list");
  const baseOpts = { emoji: true, ansi: false } as const;

  if (format === "tree") {
    const chart = renderPrideTreeWithPins(graph, pins, baseOpts);
    return jsonResult({
      ok: true,
      status: "ok",
      chart,
      format: "tree",
      graph,
    }) as AgentToolResult<OrgToolResult>;
  }

  if (format === "columns") {
    const chart = renderPrideColumnsWithPins(graph, pins, baseOpts);
    return jsonResult({
      ok: true,
      status: "ok",
      chart,
      format: "columns",
      graph,
    }) as AgentToolResult<OrgToolResult>;
  }

  if (format === "image") {
    const chart = renderPrideColumnsWithPins(graph, pins, baseOpts);
    try {
      // Force-fresh render on channel turns so the user gets a new
      // random theme + new taunt + new footer rule every time —
      // cached PNGs from earlier turns are bypassed. Also marks the
      // file as transient so `send_media` unlinks it after dispatch
      // (the chart is delivered ONCE; after that we don't want stale
      // copies cluttering the cache or being served to a future
      // channel turn where the org may have changed).
      // TUI / CLI / sub-agent turns keep the content-hash cache —
      // they re-render the same chart many times in a session and
      // benefit from reuse.
      const saved = await saveOrgChartImage(graph, pins, {
        force: channelContext !== undefined,
      });
      if (channelContext) {
        markTransientImage(saved.filePath);
      }
      // On a channel turn we want the LLM to dispatch the image via
      // `send_media` without leaving a paste-able ASCII chart in its
      // context. Two reinforcing mechanisms:
      //   1. STUB the `chart` field — a populated ASCII block in the
      //      same result is too tempting for mid-tier models to paste
      //      either alongside send_media OR in the post-send
      //      confirmation turn (the original ASCII would still be in
      //      context). We replace it with a short marker.
      //   2. Numbered `instructions` field — line-broken steps follow
      //      Anthropic's prompting guidance for instruction-following.
      // TUI / CLI turns still get the full ASCII for direct read.
      if (channelContext) {
        // Posix-form the path so it round-trips through the LLM
        // unchanged. The LLM sees this string twice (in the
        // `imagePath` field and inside the `instructions` text); on
        // Windows, native backslashes get mangled when the model
        // copies them out of a string that LOOKS like a function-call
        // template. Forward slashes survive any stringification and
        // Node's fs accepts them on Windows.
        const posixPath = saved.filePath.split(path.sep).join("/");
        // CRITICAL: do NOT embed the path inside a JSON-shape template
        // (like `Call send_media({path: "..."})`). Mid-tier models
        // copy the template character-for-character and mangle
        // backslashes. Instead instruct the model to use the
        // `imagePath` field VERBATIM — that field is JSON-stringified
        // by `jsonResult` so its escapes are model-safe.
        const instructions = [
          `1. You are on channel "${channelContext.channelId}", conversation "${channelContext.conversationId}".`,
          `2. Call send_media now. For the "path" argument, copy the value of the imagePath field in this tool result VERBATIM (do not retype it, do not modify slashes or escapes).`,
          `3. Pass deleteAfterSend:true to send_media so the temp PNG is cleaned up after dispatch — the chart is transient (re-rendered fresh on every request), this file should not linger.`,
          `4. Pick a caption that answers the user's specific question; do not use a generic "Here's the org chart" if the user asked something specific.`,
          `5. Do NOT include the org structure in any text reply — the image IS the reply.`,
          `6. If send_media fails, call send_message with a short acknowledgement and tell the user to view the image directly.`,
        ].join("\n");
        return jsonResult({
          ok: true,
          status: "ok",
          chart:
            "[delivered as image via send_media — do not paste this field; the image is the deliverable]",
          format: "image",
          graph,
          imagePath: posixPath,
          mimeType: saved.mimeType,
          rasterized: saved.rasterized,
          imageWidth: saved.width,
          imageHeight: saved.height,
          instructions,
        } satisfies OrgShowResult) as AgentToolResult<OrgToolResult>;
      }
      // Non-channel image render (TUI explicit format:"image", sub-agent,
      // etc.) — keep the ASCII alongside since the LLM may need it for
      // direct text rendering and there's no send_media auto-route.
      return jsonResult({
        ok: true,
        status: "ok",
        chart,
        format: "image",
        graph,
        imagePath: saved.filePath,
        mimeType: saved.mimeType,
        rasterized: saved.rasterized,
        imageWidth: saved.width,
        imageHeight: saved.height,
      } satisfies OrgShowResult) as AgentToolResult<OrgToolResult>;
    } catch (err) {
      // Image render failed (disk full, missing playwright-core,
      // browser launch failure, etc.). On a channel turn we still must
      // not let the LLM paste the ASCII inline — instruct it to call
      // send_message with the chart text as the message body so the
      // chat user gets a deliverable. Off-channel, the model can render
      // the ASCII inline as usual.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (channelContext) {
        const instructions = [
          `1. Image render FAILED ("${errMsg}"). You are still on channel "${channelContext.channelId}".`,
          `2. Call send_message({text: <the chart field, verbatim, wrapped in a triple-backtick code block>}) so the user gets the ASCII fallback in their chat.`,
          `3. Do NOT include the chart in any other text — send_message is the ONLY deliverable.`,
          `4. After send_message succeeds, optionally apologise once for the missing image; do not retry the image render this turn.`,
        ].join("\n");
        return jsonResult({
          ok: true,
          status: "ok",
          chart,
          format: "columns",
          graph,
          instructions,
        } satisfies OrgShowResult) as AgentToolResult<OrgToolResult>;
      }
      return jsonResult({
        ok: true,
        status: "ok",
        chart: `${chart}\n\n[image render failed: ${errMsg}]`,
        format: "columns",
        graph,
      } satisfies OrgShowResult) as AgentToolResult<OrgToolResult>;
    }
  }

  // format === "list" (default)
  const chart = renderPrideChartWithPins(graph, pins, baseOpts);
  return jsonResult({
    ok: true,
    status: "ok",
    chart,
    format: "list",
    graph,
  }) as AgentToolResult<OrgToolResult>;
}

/* ─────────────────────────── delegate ─────────────────────────── */

function executeDelegate(
  params: OrgToolParams,
  requesterAgentId: string,
  agentSessionKey: string | undefined,
): AgentToolResult<OrgToolResult> {
  const department = (params.department ?? "").trim();
  const message = (params.message ?? "").trim();
  const wait = params.wait === true;
  const kindRaw = (params.kind ?? "delegation").trim();
  const kind: DeliveryKind = isDeliveryKind(kindRaw)
    ? (kindRaw as DeliveryKind)
    : "delegation";

  if (!department) {
    return errorEnvelope("org.delegate: `department` is required");
  }
  if (!message) {
    return errorEnvelope("org.delegate: `message` is required");
  }

  let cfg: {
    org?: { a2a?: { mode?: string }; departmentHeads?: Record<string, string> };
    agents?: Record<string, unknown>;
    session?: { agentToAgent?: { enabled?: boolean } };
  };
  try {
    cfg = loadConfig() as never;
  } catch (err) {
    return errorEnvelope(
      `org.delegate: config load failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!cfg?.org) {
    return forbiddenEnvelope(
      "org.delegate: org layer is not configured (cfg.org absent)",
    );
  }
  // Per-action capability: A2A must be enabled. Mirrors the old Stage-D
  // registry gate, now enforced inside the action body since the registry
  // surfaces the consolidated tool whenever cfg.org is present.
  if (cfg.session?.agentToAgent?.enabled !== true) {
    return forbiddenEnvelope(
      "org.delegate: agent-to-agent messaging is disabled (cfg.session.agentToAgent.enabled !== true)",
    );
  }
  if (cfg.org.a2a?.mode === "explicit") {
    return forbiddenEnvelope(
      "org.delegate: org.a2a.mode is 'explicit'; use sessions_send with an explicitly-allowed peer",
    );
  }

  const graph = deriveOrgGraph(cfg as never);
  if (!graph) {
    return forbiddenEnvelope(
      "org.delegate: org graph could not be derived",
    );
  }

  const headAgentId = resolveDepartmentHead(
    graph,
    cfg.org.departmentHeads,
    department,
  );
  if (!headAgentId) {
    return forbiddenEnvelope(
      `org.delegate: department "${department}" is not in the org graph`,
    );
  }

  if (headAgentId === requesterAgentId) {
    return forbiddenEnvelope(
      `org.delegate: caller is already the head of "${department}" — would self-DM`,
    );
  }

  const targetSessionKey = buildBrigadeMainSessionKey({ agentId: headAgentId });

  const callerMember = graph.members[requesterAgentId];
  const contextKey =
    encodeDeliveryKindContextKey({
      kind,
      fromAgentId: requesterAgentId,
      ...(callerMember?.role ? { fromRole: callerMember.role } : {}),
      ...(callerMember?.department
        ? { fromDepartment: callerMember.department }
        : {}),
    }) ?? `delegate:from:${requesterAgentId}`;

  const idempotencyKey = crypto.randomUUID();
  const lane = nestedLane(agentSessionKey);

  enqueueSystemEvent(
    `A2A from ${requesterAgentId} (${department} delegation): ${message}`,
    {
      sessionKey: targetSessionKey,
      contextKey,
      trusted: true,
    },
  );

  const dispatchTimeoutSec = wait ? 60 : 30;
  try {
    void callGateway({
      method: "agent",
      params: {
        message,
        sessionKey: targetSessionKey,
        deliver: false,
        lane,
        idempotencyKey,
        spawnedBy: agentSessionKey ?? requesterAgentId,
        timeout: dispatchTimeoutSec,
      },
      timeoutMs: Math.max(10_000, dispatchTimeoutSec * 1_000 + 5_000),
    }).catch(() => {
      // Failures surface to the caller via the next turn's inbox peek.
    });
  } catch (err) {
    return errorEnvelope(err instanceof Error ? err.message : String(err));
  }

  const result: OrgDelegateResult = {
    status: "accepted",
    department,
    targetAgentId: headAgentId,
    targetSessionKey,
    kind,
    idempotencyKey,
  };
  return jsonResult(result) as AgentToolResult<OrgToolResult>;
}

function resolveDepartmentHead(
  graph: OrgGraph,
  departmentHeads: Record<string, string> | undefined,
  department: string,
): string | undefined {
  const pin = departmentHeads?.[department];
  if (pin && graph.members[pin]?.department === department) {
    return pin;
  }
  const members = graph.departments[department];
  if (!members || members.length === 0) return undefined;
  return members[0];
}

function errorEnvelope(message: string): AgentToolResult<OrgToolResult> {
  return jsonResult({
    status: "error",
    error: message,
  } satisfies OrgDelegateResult) as AgentToolResult<OrgToolResult>;
}

function forbiddenEnvelope(
  message: string,
): AgentToolResult<OrgToolResult> {
  return jsonResult({
    status: "forbidden",
    error: message,
  } satisfies OrgDelegateResult) as AgentToolResult<OrgToolResult>;
}

/* ─────────────────────────── init ─────────────────────────── */

async function executeInit(
  params: OrgToolParams,
): Promise<AgentToolResult<OrgToolResult>> {
  const templateId = (params.template ?? "").trim();
  if (!templateId) {
    return jsonResult({
      ok: false,
      error: "org.init: `template` is required",
      valid: listOrgTemplateIds(),
    } satisfies OrgInitResult) as AgentToolResult<OrgToolResult>;
  }
  const template = getOrgTemplate(templateId);
  if (!template) {
    return jsonResult({
      ok: false,
      error: `org.init: unknown template "${templateId}"`,
      valid: listOrgTemplateIds(),
    } satisfies OrgInitResult) as AgentToolResult<OrgToolResult>;
  }

  const cfgPeek = loadConfig() as { org?: unknown };
  if (cfgPeek.org) {
    return jsonResult({
      ok: false,
      error:
        "org.init: cfg.org already present — refusing to overwrite. Use `org` action=\"set\" to adjust an agent's org block; for top-level org changes (topOrder, a2a.mode), tell the operator the exact brigade.json edit — the model cannot hand-edit config.",
    } satisfies OrgInitResult) as AgentToolResult<OrgToolResult>;
  }

  try {
    const next = await mutateConfigAtomic((current: BrigadeConfig) => {
      const merged: BrigadeConfig = { ...current };
      merged.org = template.org;
      const agents = { ...((merged.agents ?? {}) as Record<string, unknown>) };
      for (const [id, block] of Object.entries(template.agents)) {
        const existing = (agents[id] ?? {}) as Record<string, unknown>;
        agents[id] = { ...existing, org: block };
      }
      merged.agents = agents as never;
      return merged;
    });
    return jsonResult({
      ok: true,
      template: template.id,
      written: { org: next.org, agents: filterTemplateAgents(next, template) },
    } satisfies OrgInitResult) as AgentToolResult<OrgToolResult>;
  } catch (err) {
    return jsonResult({
      ok: false,
      error: `org.init: write failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    } satisfies OrgInitResult) as AgentToolResult<OrgToolResult>;
  }
}

function filterTemplateAgents(
  cfg: BrigadeConfig,
  template: NonNullable<ReturnType<typeof getOrgTemplate>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(template.agents)) {
    out[id] = (cfg.agents as Record<string, unknown> | undefined)?.[id];
  }
  return out;
}

/* ─────────────────────────── set ─────────────────────────── */

async function executeSet(
  params: OrgToolParams,
): Promise<AgentToolResult<OrgToolResult>> {
  const agentId = (params.agentId ?? "").trim();
  if (!agentId) {
    return jsonResult({
      ok: false,
      error: "org.set: `agentId` is required",
    } satisfies OrgSetResult) as AgentToolResult<OrgToolResult>;
  }

  const cfgPeek = loadConfig() as {
    org?: unknown;
    agents?: Record<string, unknown>;
  };
  if (!cfgPeek.org) {
    return jsonResult({
      ok: false,
      error:
        "org.set: cfg.org is absent — run org({action:'init', template:'…'}) first",
    } satisfies OrgSetResult) as AgentToolResult<OrgToolResult>;
  }
  const existingAgent = cfgPeek.agents?.[agentId] as
    | Record<string, unknown>
    | undefined;
  if (!existingAgent) {
    return jsonResult({
      ok: false,
      error: `org.set: agent "${agentId}" does not exist — use manage_agent({action:'add', id:'${agentId}', …}) to create it first`,
    } satisfies OrgSetResult) as AgentToolResult<OrgToolResult>;
  }

  // No-op shortcut: at least one mutable field must be present.
  if (
    params.department === undefined &&
    params.reportsTo === undefined &&
    params.role === undefined &&
    params.bio === undefined
  ) {
    return jsonResult({
      ok: false,
      error:
        "org.set: nothing to update — pass at least one of department / reportsTo / role / bio",
    } satisfies OrgSetResult) as AgentToolResult<OrgToolResult>;
  }

  // Normalise the LLM's freeform inputs BEFORE we write them. The
  // schema's `Type.Union([Type.String(), Type.Null()])` on reportsTo
  // accepts ANY string including `""`, but an empty string is never
  // a valid agent id and writing it produces an org config that fails
  // `validate.ts` for every subsequent turn (the gateway then bricks
  // until the file is hand-repaired). Treating `""` as "no parent"
  // (i.e. null) matches the LLM's intent and prevents the regression.
  // Same hardening for department/role/bio: empty string → undefined.
  const normDept =
    params.department !== undefined
      ? params.department.trim() || undefined
      : undefined;
  let normReportsTo: string | null | undefined;
  if (params.reportsTo === null) {
    normReportsTo = null;
  } else if (typeof params.reportsTo === "string") {
    const t = params.reportsTo.trim();
    normReportsTo = t.length > 0 ? t : null;
  } else {
    normReportsTo = undefined;
  }
  const normRole =
    params.role !== undefined ? params.role.trim() || undefined : undefined;
  const normBio =
    params.bio !== undefined ? params.bio.trim() || undefined : undefined;

  try {
    const next = await mutateConfigAtomic((current: BrigadeConfig) => {
      const merged: BrigadeConfig = { ...current };
      const agents = { ...((merged.agents ?? {}) as Record<string, unknown>) };
      const target = { ...((agents[agentId] ?? {}) as Record<string, unknown>) };
      const prevOrg =
        (target.org as Record<string, unknown> | undefined) ?? {};
      const nextOrg: Record<string, unknown> = { ...prevOrg };
      if (normDept !== undefined) nextOrg.department = normDept;
      if (normReportsTo !== undefined) nextOrg.reportsTo = normReportsTo;
      if (normRole !== undefined) nextOrg.role = normRole;
      if (normBio !== undefined) nextOrg.bio = normBio;
      target.org = nextOrg;
      agents[agentId] = target;
      merged.agents = agents as never;
      return merged;
    });
    const writtenAgent = (next.agents as Record<string, unknown> | undefined)?.[
      agentId
    ] as Record<string, unknown> | undefined;
    return jsonResult({
      ok: true,
      agentId,
      org: writtenAgent?.org,
    } satisfies OrgSetResult) as AgentToolResult<OrgToolResult>;
  } catch (err) {
    return jsonResult({
      ok: false,
      error: `org.set: write failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    } satisfies OrgSetResult) as AgentToolResult<OrgToolResult>;
  }
}

/* ─────────────────────────── explain ─────────────────────────── */

function executeExplain(
  params: OrgToolParams,
): AgentToolResult<OrgToolResult> {
  const from = (params.from ?? "").trim();
  const to = (params.to ?? "").trim();
  if (!from || !to) {
    return jsonResult({
      status: "error",
      error: "org.explain: both `from` and `to` are required",
    } satisfies OrgExplainResult) as AgentToolResult<OrgToolResult>;
  }
  const cfg = loadConfig();
  const graph = deriveOrgGraph(cfg as never);
  if (!graph) {
    return jsonResult({
      status: "no-org",
      from,
      to,
    } satisfies OrgExplainResult) as AgentToolResult<OrgToolResult>;
  }
  const edges = graph.edges.filter((e) => e.from === from && e.to === to);
  if (edges.length > 0) {
    return jsonResult({
      status: "allowed",
      from,
      to,
      allowed: true,
      chain: edges.map((e) => ({
        reason: e.reason,
        ...(e.note ? { note: e.note } : {}),
      })),
    } satisfies OrgExplainResult) as AgentToolResult<OrgToolResult>;
  }
  return jsonResult({
    status: "denied",
    from,
    to,
    allowed: false,
    reason: computeDenialReason(graph, from, to),
  } satisfies OrgExplainResult) as AgentToolResult<OrgToolResult>;
}

function computeDenialReason(
  graph: OrgGraph,
  from: string,
  to: string,
): string {
  const f = graph.members[from];
  const t = graph.members[to];
  if (!f) return `caller ${JSON.stringify(from)} is not a member of the org`;
  if (!t) return `target ${JSON.stringify(to)} is not a member of the org`;
  if (f.department !== t.department) {
    return `cross-department edge ${JSON.stringify(
      f.department,
    )} → ${JSON.stringify(t.department)} is closed by rule (v)`;
  }
  return `no direct edge in derived graph`;
}

/* ─────────────────────────── plan (reserved) ─────────────────────────── */

function executePlan(): AgentToolResult<OrgToolResult> {
  return jsonResult({
    ok: false,
    error: "not yet implemented",
    suggest:
      "use manage_agent (to add an agent) + org({action:'delegate', …}) (to hand work over)",
  } satisfies OrgPlanResult) as AgentToolResult<OrgToolResult>;
}
