/**
 * Gateway RPC handler — `org.snapshot`.
 *
 * Returns the derived org graph plus every rendered chart format so an
 * operator-side caller (CLI, TUI, channel, web UI) can pick whichever
 * surface it needs without re-rendering. The Pride chart shape is owned
 * by `pride-template.ts` — this handler is a thin adapter that snapshots
 * the current config + asks the template for each surface variant.
 *
 * Three render variants live in the response:
 *
 *   - `tui`     — ANSI + emoji (terminals that render colour and unicode).
 *   - `channel` — emoji + plain text, wrapped in a triple-backtick code
 *                 block so WhatsApp / Slack / Discord render monospace.
 *   - `ascii`  — plain ASCII (no emoji, no ANSI) for legacy SMS gateways
 *                 and `TERM=dumb` consoles.
 *   - `json`   — the raw `OrgGraph` for callers that want to re-render
 *                 client-side (web UI, custom dashboards).
 *
 * When `cfg.org` is absent the handler returns the friendly flat-crew
 * redirect note — never a crash, never a pretend-flat-list fallback.
 *
 * INVARIANT: this handler is OPERATOR-ONLY. The gateway boot path scopes
 * the registration as `operator.read` so only callers carrying that
 * scope reach the body. Today every WebSocket connection inherits the
 * full operator scope set (localhost-only); Phase 2 multi-user will
 * narrow this without any code change here.
 *
 * Brand-scrub: no openclaw / clawd / hermes / boop / paperclip / nanoclaw
 * identifiers referenced in this file.
 */

import { deriveOrgGraph } from "../../agents/org/derive-graph.js";
import {
  PRIDE_CHART_FLAT_CREW_NOTE,
  renderPrideChartWithPins,
  renderPrideColumnsWithPins,
  renderPrideTreeWithPins,
} from "../../agents/org/pride-template.js";
import type { OrgGraph } from "../../agents/org/types.js";

/** Shape of the loaded config slice the handler reads. */
interface OrgSnapshotConfig {
  org?: {
    departmentHeads?: Record<string, string>;
  };
}

/** Dependencies — injected so tests don't need to stub the global cfg loader. */
export interface OrgSnapshotDeps {
  /** Returns the current Brigade config (sync — `loadConfig` is sync today). */
  loadConfig: () => OrgSnapshotConfig;
}

/** Per-format chart bundle returned when cfg.org is present. */
export interface OrgSnapshotCharts {
  /**
   * ANSI + emoji — for the TUI. NEW default since the "fancy" body
   * shipped: a horizontal columnar org-chart with box-drawing
   * connectors (┌─┐│└─┘├┬┴), one Higher Office box at top, lead
   * boxes in a row with a branching spine, team bullets per
   * column. The `/org` slash command renders this verbatim.
   */
  tui: string;
  /**
   * Legacy compact list (Higher Office / Departments tier headings,
   * leads + team bullets). Kept available so the few internal sites
   * that depend on the old shape can opt in.
   */
  list: string;
  /**
   * Vertical indent tree (├── / └── connectors) — good for narrow
   * terminals (<60 cols) where the columnar variant wraps.
   */
  tree: string;
  /** Emoji + plain text wrapped in a triple-backtick code block. */
  channel: string;
  /** Plain ASCII (no emoji, no ANSI). */
  ascii: string;
  /** Raw OrgGraph for downstream re-rendering. */
  json: OrgGraph;
}

/** OK response — cfg.org is present, every chart format is rendered. */
export interface OrgSnapshotOkResult {
  ok: true;
  graph: OrgGraph;
  charts: OrgSnapshotCharts;
}

/** Refusal — cfg.org is absent. The caller renders the redirect note. */
export interface OrgSnapshotFlatCrewResult {
  ok: false;
  reason: "flat-crew";
  redirect: string;
}

export type OrgSnapshotResult =
  | OrgSnapshotOkResult
  | OrgSnapshotFlatCrewResult;

/** Params type (current shape: no params; reserved for future filtering). */
export type OrgSnapshotParams = Record<string, never> | undefined;

/**
 * Handle the `org.snapshot` RPC. Pure: reads cfg through the injected
 * loader, derives the graph, asks the Pride template for each format.
 */
export function handleOrgSnapshot(
  _params: OrgSnapshotParams,
  deps: OrgSnapshotDeps,
): OrgSnapshotResult {
  const cfg = deps.loadConfig();
  const graph = deriveOrgGraph(cfg as never);
  if (!graph) {
    return {
      ok: false,
      reason: "flat-crew",
      redirect: PRIDE_CHART_FLAT_CREW_NOTE,
    };
  }
  const pins = cfg.org?.departmentHeads;
  // TUI form: fancy columnar org-chart with box-drawing connectors +
  // emoji + ANSI colour. This is what `/org` shows in the connect
  // TUI — the "Higher Office box on top, lead boxes in a horizontal
  // row with branching spine, team bullets under each column" look
  // the operator asked for after seeing the legacy compact list.
  const tui = renderPrideColumnsWithPins(graph, pins, {
    emoji: true,
    ansi: true,
  });
  // Vertical indent tree alternative for narrow terminals.
  const tree = renderPrideTreeWithPins(graph, pins, {
    emoji: true,
    ansi: true,
  });
  // Legacy compact list — kept for back-compat (a handful of internal
  // sites still pin the original section-bar layout).
  const list = renderPrideChartWithPins(graph, pins, {
    emoji: true,
    ansi: true,
  });
  const ascii = renderPrideChartWithPins(graph, pins, {
    emoji: false,
    ansi: false,
  });
  // Channel form: emoji on, ANSI off, wrapped in a triple-backtick
  // block so WhatsApp / Slack / Discord render it as monospace. Uses
  // the LIST shape (not columnar) because chat clients on mobile are
  // often <40 cols wide and the columnar variant wraps badly.
  const channelInner = renderPrideChartWithPins(graph, pins, {
    emoji: true,
    ansi: false,
  });
  const channel = ["```", channelInner, "```"].join("\n");
  return {
    ok: true,
    graph,
    charts: {
      tui,
      list,
      tree,
      channel,
      ascii,
      json: graph,
    },
  };
}
