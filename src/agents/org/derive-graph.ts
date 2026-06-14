/**
 * Brigade virtual-office layer — graph derivation (Stage A).
 *
 * `deriveOrgGraph(cfg)` is the SINGLE entry point Stages B/C/D will
 * use to read the org topology. It returns:
 *
 *   - `undefined` when `cfg.org` is absent (legacy mode).
 *   - `undefined` when `cfg.org.a2a.mode === "explicit"` (operator
 *     wants the legacy `cfg.session.agentToAgent.allow` matrix; the
 *     org block is purely cosmetic in that mode at Stage A).
 *   - `undefined` when no agents are members AND auto-derive cannot
 *     synthesize a solo graph (defensive — shouldn't happen in practice).
 *   - An `OrgGraph` otherwise.
 *
 * STAGE-A CONTRACT: This function is referenced ONLY by Stage-A tests
 * and by the audit helper. NO existing runtime path calls it.
 */

import type { BrigadeConfig } from "../../config/io.js";

import type {
  EdgeRecord,
  OrgEdgeReason,
  OrgGraph,
} from "./types.js";
import { autoDeriveSoloGraph } from "./auto-derive.js";
import { validateOrgConfig } from "./validate.js";

/**
 * WeakMap cache keyed on the cfg object identity. Stage-A runtime
 * never mutates a cfg after handing it to derive, so we can safely
 * memoise. Cfg objects produced by `{ ...cfg }` re-derive, which is
 * fine: derivation is O(members + edges).
 */
const CACHE = new WeakMap<object, OrgGraph | undefined>();

export function deriveOrgGraph(cfg: BrigadeConfig): OrgGraph | undefined {
  // Cache hit short-circuits any other branch. WeakMap key is the
  // cfg reference itself — callers that pass a fresh clone bypass.
  if (cfg && typeof cfg === "object") {
    if (CACHE.has(cfg as object)) return CACHE.get(cfg as object);
  }

  const result = deriveImpl(cfg);
  if (cfg && typeof cfg === "object") CACHE.set(cfg as object, result);
  return result;
}

/** Separate memo for the display variant — same cfg key, different answer. */
const DISPLAY_CACHE = new WeakMap<object, OrgGraph | undefined>();

/**
 * Display-surface variant: identical derivation, but `a2a.mode: "explicit"`
 * does NOT blank the graph. Explicit mode is an A2A POLICY choice (use the
 * flat allow matrix instead of graph edges) — it was never meant to make
 * the org chart / connect banner / agents_list metadata / prompt org blocks
 * claim "your crew is flat" while a full hierarchy sits in config.
 *
 * Use THIS from anything that renders or describes the org. POLICY
 * consumers (the A2A adapter in agent-loop, org.delegate, sessions_send
 * remedies) must keep `deriveOrgGraph` — they self-gate on the mode and
 * fall back to the legacy allow matrix when it's "explicit".
 */
export function deriveOrgDisplayGraph(cfg: BrigadeConfig): OrgGraph | undefined {
  if (cfg && typeof cfg === "object") {
    if (DISPLAY_CACHE.has(cfg as object)) return DISPLAY_CACHE.get(cfg as object);
  }
  const result = deriveImpl(cfg, { includeExplicitMode: true });
  if (cfg && typeof cfg === "object") DISPLAY_CACHE.set(cfg as object, result);
  return result;
}

function deriveImpl(
  cfg: BrigadeConfig,
  opts?: { includeExplicitMode?: boolean },
): OrgGraph | undefined {
  if (!cfg || typeof cfg !== "object") return undefined;

  const org = cfg.org;

  // ── BRANCH 1: `cfg.org` absent. Legacy mode for every consumer.
  // Single-agent installs MAY auto-derive an in-memory solo graph so
  // future Stage-B prompt rendering can talk about "you are the Chief
  // of Staff" without an explicit org block. The auto-deriver returns
  // undefined for multi-agent installs (no synth without an opt-in).
  if (!org) {
    return autoDeriveSoloGraph(cfg);
  }

  // ── BRANCH 2: `mode === "explicit"`. Operator wants the legacy A2A
  // allow matrix; we return undefined so Stage-C/D POLICY consumers fall
  // back to it. (The cfg.org block is still validated by Stage A even in
  // explicit mode, to catch typos / cycles before they bite later.)
  //
  // Display surfaces must NOT use this function's undefined as "no org" —
  // see `deriveOrgDisplayGraph` below. Production 2026-06-11: the operator
  // set mode "explicit" to widen A2A and every display surface (connect
  // banner, org.snapshot, org show/describe) reported a 14-agent 4-tier
  // hierarchy as "your crew is flat"; the model then "rebuilt" org data
  // that was never missing and bash-edited brigade.json chasing the ghost.
  if (org.a2a?.mode === "explicit" && !opts?.includeExplicitMode) {
    // Still validate so cfg-level bugs are surfaced eagerly.
    validateOrgConfig(cfg);
    return undefined;
  }

  // ── BRANCH 3: derived / open mode. Validate, then build the graph.
  validateOrgConfig(cfg);

  // Stamp the graph with the cfg's REAL mode. "explicit" only reaches here
  // via the display variant (the policy path returned undefined above) —
  // stamping it keeps `--json` / tool `show` output truthful instead of
  // labelling an explicit-mode install "derived", and lets diagnostic
  // surfaces (explain / describe) caveat themselves off `graph.mode`.
  const mode =
    org.a2a?.mode === "open"
      ? "open"
      : org.a2a?.mode === "explicit"
        ? "explicit"
        : "derived";
  const topOrder = resolveTopOrder(cfg);
  const members = collectMembers(cfg);
  const departments = invertDepartments(members);

  // Open mode short-circuits the seven rules: every member can talk to
  // every other member. Used by tests and operator-debug installs.
  let edges: EdgeRecord[];
  if (mode === "open") {
    edges = openModeEdges(members);
  } else {
    edges = applyDerivationRules({
      members,
      departments,
      topOrder,
    });
  }

  // Rule (vi): extraAllow UNION + extraDeny REMOVE. Deny wins last
  // when both reference the same (from, to) edge.
  edges = applyExtras(edges, org);

  return {
    topOrder,
    members,
    departments,
    edges,
    mode,
  };
}

function resolveTopOrder(cfg: BrigadeConfig): string {
  // Required when cfg.org is present — `validateOrgConfig` enforces.
  const fromCfg = cfg.org?.topOrder?.trim();
  if (fromCfg && fromCfg.length > 0) return fromCfg;
  const fromDefaults = cfg.defaults?.agentId?.trim();
  if (fromDefaults && fromDefaults.length > 0) return fromDefaults;
  return "main";
}

function collectMembers(cfg: BrigadeConfig): OrgGraph["members"] {
  const out: OrgGraph["members"] = {};
  const agents = cfg.agents ?? {};
  for (const [id, value] of Object.entries(agents)) {
    if (id === "defaults") continue;
    if (!value || typeof value !== "object") continue;
    const agentLike = value as { org?: { department?: string; reportsTo?: string | null; role?: string; bio?: string } };
    const orgMeta = agentLike.org;
    if (!orgMeta || typeof orgMeta.department !== "string") continue;
    out[id] = {
      department: orgMeta.department,
      reportsTo: orgMeta.reportsTo ?? null,
      role: orgMeta.role,
      bio: orgMeta.bio,
      source: "explicit",
    };
  }
  return out;
}

function invertDepartments(members: OrgGraph["members"]): Record<string, string[]> {
  const inv: Record<string, string[]> = {};
  for (const [id, m] of Object.entries(members)) {
    const bucket = inv[m.department] ?? [];
    bucket.push(id);
    inv[m.department] = bucket;
  }
  for (const key of Object.keys(inv)) {
    const bucket = inv[key];
    if (bucket) bucket.sort();
  }
  return inv;
}

interface DeriveCtx {
  members: OrgGraph["members"];
  departments: Record<string, string[]>;
  topOrder: string;
}

function applyDerivationRules(ctx: DeriveCtx): EdgeRecord[] {
  const edges: EdgeRecord[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, reason: OrgEdgeReason): void => {
    if (from === to) return; // self-loops are nonsense
    const key = `${from}|${to}|${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, reason });
  };

  // Rules (i) + (ii): manager chain. For each member with a reportsTo,
  // emit two directed edges (escalation-up + assignment-down).
  for (const [id, m] of Object.entries(ctx.members)) {
    if (m.reportsTo) {
      push(id, m.reportsTo, "escalation-up");
      push(m.reportsTo, id, "assignment-down");
    }
  }

  // Rule (iii): same-department peers. Cross-product within each dept,
  // omit self-loops, both directions.
  for (const ids of Object.values(ctx.departments)) {
    if (ids.length < 2) continue;
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        push(a, b, "lateral-peer");
      }
    }
  }

  // Rule (iv): topOrder broadcast. Every member <-> topOrder.
  for (const id of Object.keys(ctx.members)) {
    if (id === ctx.topOrder) continue;
    push(id, ctx.topOrder, "topOrder-broadcast");
    push(ctx.topOrder, id, "topOrder-broadcast");
  }

  // Rule (v): cross-dept lateral is intentionally NOT emitted. The
  // absence of code here is the implementation.

  return edges;
}

function openModeEdges(members: OrgGraph["members"]): EdgeRecord[] {
  const ids = Object.keys(members);
  const out: EdgeRecord[] = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      out.push({ from: a, to: b, reason: "open-mode" });
    }
  }
  return out;
}

function applyExtras(
  edges: EdgeRecord[],
  org: NonNullable<BrigadeConfig["org"]>,
): EdgeRecord[] {
  const allow = org.a2a?.extraAllow ?? [];
  const deny = org.a2a?.extraDeny ?? [];

  // UNION: append extraAllow entries that aren't already present (by
  // from/to pair — duplicate reasons are dropped so we don't emit
  // double-edges with different `reason` tags).
  let next = [...edges];
  const present = new Set(edges.map((e) => `${e.from}|${e.to}`));
  for (const a of allow) {
    if (!a?.from || !a?.to) continue;
    const key = `${a.from}|${a.to}`;
    if (present.has(key)) continue;
    next.push({
      from: a.from,
      to: a.to,
      reason: "extra-allow",
      note: a.reason,
    });
    present.add(key);
  }

  // REMOVE: deny wins last. Filter out any edge whose (from, to) is
  // in the deny set, regardless of reason.
  const denied = new Set<string>();
  for (const d of deny) {
    if (!d?.from || !d?.to) continue;
    denied.add(`${d.from}|${d.to}`);
  }
  if (denied.size > 0) next = next.filter((e) => !denied.has(`${e.from}|${e.to}`));

  return next;
}
