/**
 * Tests for the Pride hierarchy template — the single source of truth
 * for Brigade's 3-tier org-chart rendering.
 *
 * Contract pinned by these tests:
 *
 *   - flattenToThreeTiers collapses any deeper-than-3-tier org into
 *     exactly 3 display tiers (the Brigade taunt: "no managers, just
 *     leads and the team")
 *   - renderPrideChart honours emoji + ansi toggles
 *   - renderPrideChartForChannel wraps in a triple-backtick block so
 *     WhatsApp / Slack / Discord render monospace
 *   - the operator-pin path beats the seniority-computation path when
 *     both apply
 *   - the flat-crew note for `cfg.org`-absent installs points at the
 *     right next step (`brigade org init` AND `/agents`)
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { OrgGraph } from "./types.js";
import {
  BRIGADE_FOOTER_RULE,
  BRIGADE_TAUNT,
  PRIDE_CHART_FLAT_CREW_NOTE,
  flattenToThreeTiers,
  flattenToThreeTiersWithPins,
  renderPrideChart,
  renderPrideChartForChannel,
} from "./pride-template.js";
import {
  BRIGADE_FOOTER_RULES,
  BRIGADE_TAUNTS,
  PRIDE_STORIES,
  createSeededRng,
} from "./pride-taunts.js";

// ── Test helpers ────────────────────────────────────────────────────

interface MemberSpec {
  department: string;
  reportsTo: string | null;
  role?: string;
  bio?: string;
}

function makeGraph(spec: {
  topOrder: string;
  members: Record<string, MemberSpec>;
}): OrgGraph {
  const members: OrgGraph["members"] = {};
  const departments: Record<string, string[]> = {};
  for (const [id, m] of Object.entries(spec.members)) {
    members[id] = {
      department: m.department,
      reportsTo: m.reportsTo,
      source: "explicit",
      ...(m.role !== undefined ? { role: m.role } : {}),
      ...(m.bio !== undefined ? { bio: m.bio } : {}),
    };
    const bucket = departments[m.department] ?? [];
    bucket.push(id);
    departments[m.department] = bucket;
  }
  for (const key of Object.keys(departments)) {
    const b = departments[key];
    if (b) b.sort();
  }
  return {
    topOrder: spec.topOrder,
    members,
    departments,
    edges: [],
    mode: "derived",
  };
}

// ── flattenToThreeTiers tests ───────────────────────────────────────

describe("flattenToThreeTiers", () => {
  it("(1) single-agent org → only Higher Office, no departments", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: { main: { department: "office", reportsTo: null, role: "Chief of Staff" } },
    });
    const flat = flattenToThreeTiers(graph);
    assert.equal(flat.topOrder.id, "main");
    assert.equal(flat.topOrder.role, "Chief of Staff");
    assert.deepEqual(flat.departments, []);
    // higherOffice exists, contains [topOrder] as a back-compat alias
    assert.equal(flat.higherOffice.length, 1);
    assert.equal(flat.higherOffice[0]?.id, "main");
    assert.equal(flat.higherOffice[0], flat.topOrder);
  });

  it("(c-suite) Chief X Officer roles AND executive dept members are promoted to Higher Office, NOT shown as dept leads", () => {
    const graph = makeGraph({
      topOrder: "ceo",
      members: {
        ceo: { department: "executive", reportsTo: null, role: "Chief Executive Officer" },
        cfo: { department: "finance", reportsTo: "ceo", role: "Chief Financial Officer" },
        coo: { department: "operations", reportsTo: "ceo", role: "Chief Operating Officer" },
        cos: { department: "executive", reportsTo: "ceo", role: "Chief of Staff" },
        finance_lead: { department: "finance", reportsTo: "cfo", role: "Finance Lead" },
        eng_lead: { department: "engineering", reportsTo: "coo", role: "Engineering Lead" },
        ic: { department: "engineering", reportsTo: "eng_lead", role: "Engineer" },
      },
    });
    const flat = flattenToThreeTiers(graph);
    // Higher Office must contain ALL 4: topOrder (ceo), the 2 chief
    // officers reporting to ceo (cfo + coo), AND the executive-dept
    // member (cos). topOrder always at index 0.
    const ids = flat.higherOffice.map((m) => m.id).sort();
    assert.deepEqual(ids, ["ceo", "cfo", "coo", "cos"]);
    assert.equal(flat.higherOffice[0]?.id, "ceo");
    // Dept leads must NOT be the promoted c-suite members — finance
    // lead is finance_lead (not cfo); engineering lead is eng_lead
    // (not coo); executive dept is OMITTED from Tier 2 entirely.
    const deptsBySlug: Record<string, { lead: string; team: string[] }> = {};
    for (const d of flat.departments) {
      deptsBySlug[d.slug] = {
        lead: d.lead.id,
        team: d.team.map((m) => m.id),
      };
    }
    assert.equal(deptsBySlug["finance"]?.lead, "finance_lead");
    assert.equal(deptsBySlug["engineering"]?.lead, "eng_lead");
    assert.equal(
      deptsBySlug["executive"],
      undefined,
      "executive dept must be suppressed from Tier 2",
    );
    // Promoted members must NOT also appear in any dept team.
    for (const d of flat.departments) {
      for (const m of d.team) {
        assert.ok(
          !["ceo", "cfo", "coo", "cos"].includes(m.id),
          `${m.id} should not appear in ${d.slug} team`,
        );
      }
      assert.ok(
        !["ceo", "cfo", "coo", "cos"].includes(d.lead.id),
        `${d.lead.id} should not appear as ${d.slug} lead`,
      );
    }
  });

  it("(c-suite back-compat) higherOffice[0] === topOrder for ALL configs (single + multi-c-suite)", () => {
    // Single c-suite
    const single = flattenToThreeTiers(
      makeGraph({
        topOrder: "main",
        members: {
          main: { department: "office", reportsTo: null, role: "CEO" },
          a: { department: "x", reportsTo: "main", role: "Worker" },
        },
      }),
    );
    assert.equal(single.higherOffice[0]?.id, single.topOrder.id);
    // Multi c-suite
    const multi = flattenToThreeTiers(
      makeGraph({
        topOrder: "ceo",
        members: {
          ceo: { department: "executive", reportsTo: null, role: "CEO" },
          cto: { department: "engineering", reportsTo: "ceo", role: "CTO" },
        },
      }),
    );
    assert.equal(multi.higherOffice[0]?.id, multi.topOrder.id);
    assert.equal(multi.higherOffice[0]?.id, "ceo");
  });

  it("(2) top-order + 2 depts + 3 members each → 1 topOrder, 2 leads, 6 team", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null, role: "CEO" },
        eng_lead: { department: "eng", reportsTo: "main", role: "Eng Lead" },
        eng_a: { department: "eng", reportsTo: "eng_lead" },
        eng_b: { department: "eng", reportsTo: "eng_lead" },
        eng_c: { department: "eng", reportsTo: "eng_lead" },
        ops_lead: { department: "ops", reportsTo: "main", role: "Ops Lead" },
        ops_a: { department: "ops", reportsTo: "ops_lead" },
        ops_b: { department: "ops", reportsTo: "ops_lead" },
        ops_c: { department: "ops", reportsTo: "ops_lead" },
      },
    });
    const flat = flattenToThreeTiers(graph);
    assert.equal(flat.topOrder.id, "main");
    // Only 2 non-empty depts (`office` is empty after topOrder is removed,
    // so it's pruned from the render).
    const renderedDepts = flat.departments.filter((d) => d.slug !== "office");
    assert.equal(renderedDepts.length, 2);
    const teamCount = renderedDepts.reduce((acc, d) => acc + d.team.length, 0);
    assert.equal(teamCount, 6, "exactly 6 flattened team members across both depts");
    // Leads are pinned correctly via shortest-chain-to-topOrder.
    const eng = renderedDepts.find((d) => d.slug === "eng");
    const ops = renderedDepts.find((d) => d.slug === "ops");
    assert.ok(eng);
    assert.ok(ops);
    assert.equal(eng.lead.id, "eng_lead");
    assert.equal(ops.lead.id, "ops_lead");
  });

  it("(3) 4-level chain: leaf appears under dept lead, middles HIDDEN", () => {
    const graph = makeGraph({
      topOrder: "ceo",
      members: {
        ceo: { department: "office", reportsTo: null, role: "CEO" },
        // dept-lead reports to topOrder
        eng_lead: { department: "eng", reportsTo: "ceo", role: "VP Eng" },
        // middle manager
        eng_mid: { department: "eng", reportsTo: "eng_lead", role: "Director" },
        // sub-middle manager
        eng_sub: { department: "eng", reportsTo: "eng_mid", role: "Manager" },
        // leaf
        eng_leaf: { department: "eng", reportsTo: "eng_sub", role: "IC" },
      },
    });
    const flat = flattenToThreeTiers(graph);
    const eng = flat.departments.find((d) => d.slug === "eng");
    assert.ok(eng);
    assert.equal(eng.lead.id, "eng_lead", "shortest chain to topOrder wins");
    // The Brigade taunt: middle + sub-middle + leaf are ALL in Team. No
    // separate tier exists for the middle managers.
    const teamIds = eng.team.map((m) => m.id).sort();
    assert.deepEqual(teamIds, ["eng_leaf", "eng_mid", "eng_sub"]);
    // And critically: there is NO additional tier between leads and team.
    // The PrideDepartment shape only has `lead` + `team` — verified by
    // the type system, asserted here by counting unique keys.
    assert.deepEqual(Object.keys(eng).sort(), ["lead", "slug", "team"]);
  });

  it("(4) member that reports to topOrder but is NOT a dept head → folds into own dept", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null },
        // floater: reports to topOrder, but lives in `eng` with two
        // others, one of which has shorter overall chain via membership.
        eng_lead: { department: "eng", reportsTo: "main", role: "Lead" },
        floater: { department: "eng", reportsTo: "main", role: "Special" },
        eng_a: { department: "eng", reportsTo: "eng_lead" },
      },
    });
    const flat = flattenToThreeTiers(graph);
    const eng = flat.departments.find((d) => d.slug === "eng");
    assert.ok(eng);
    // Both eng_lead AND floater are depth-1 (direct reports of main).
    // Alphabetical tiebreak picks "eng_lead". `floater` lands in Team.
    assert.equal(eng.lead.id, "eng_lead");
    const teamIds = eng.team.map((m) => m.id).sort();
    assert.deepEqual(teamIds, ["eng_a", "floater"]);
  });

  it("(5) dept with no pin + no clear senior → first alphabetical wins", () => {
    // Two co-equal members, both reporting directly to topOrder. Lead
    // resolution falls through to alphabetical.
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null },
        zeta: { department: "eng", reportsTo: "main" },
        alpha: { department: "eng", reportsTo: "main" },
      },
    });
    const flat = flattenToThreeTiers(graph);
    const eng = flat.departments.find((d) => d.slug === "eng");
    assert.ok(eng);
    assert.equal(eng.lead.id, "alpha", "alphabetical tiebreak");
    assert.deepEqual(eng.team.map((m) => m.id), ["zeta"]);
  });

  it("(5b) operator-pin beats seniority computation", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null },
        senior: { department: "eng", reportsTo: "main" },
        junior: { department: "eng", reportsTo: "senior" },
      },
    });
    const flat = flattenToThreeTiersWithPins(graph, { eng: "junior" });
    const eng = flat.departments.find((d) => d.slug === "eng");
    assert.ok(eng);
    assert.equal(eng.lead.id, "junior", "pin wins over depth-1 senior");
  });
});

// ── renderPrideChart tests ──────────────────────────────────────────

describe("renderPrideChart", () => {
  const SAMPLE: OrgGraph = makeGraph({
    topOrder: "main",
    members: {
      main: { department: "office", reportsTo: null, role: "Chief of Staff", bio: "the boss" },
      eng_lead: { department: "eng", reportsTo: "main", role: "Eng Lead" },
      eng_ic: { department: "eng", reportsTo: "eng_lead", role: "IC" },
    },
  });

  it("(6) emoji:true ansi:false → contains lion, crown, dept emoji and footer", () => {
    // Pin a seeded RNG + suppress the optional story footer so this
    // structural test stays deterministic. The bank picker rotates
    // taunt + footer per-call; the seed used here also happens to
    // pick a known-good entry from BRIGADE_TAUNTS / BRIGADE_FOOTER_RULES.
    const rng = createSeededRng(1);
    const out = renderPrideChart(SAMPLE, {
      emoji: true,
      ansi: false,
      rng,
      story: "never",
    });
    assert.ok(out.includes("\u{1f981}"), "lion emoji");
    assert.ok(out.includes("\u{1f451}"), "crown emoji");
    assert.ok(out.includes("\u{1f3db}"), "dept emoji");
    // Taunt + footer come from the rotating bank, so we assert the
    // chart contains AT LEAST ONE taunt from BRIGADE_TAUNTS and AT
    // LEAST ONE footer rule from BRIGADE_FOOTER_RULES. We can't pin
    // a specific literal because the test would snap whenever the bank
    // is refreshed.
    assert.ok(
      BRIGADE_TAUNTS.some((t) => out.includes(t)),
      "chart must contain a taunt from the bank",
    );
    assert.ok(
      BRIGADE_FOOTER_RULES.some((f) => out.includes(f)),
      "chart must contain a footer rule from the bank",
    );
  });

  it("(6b) story=never suppresses the story footer", () => {
    const rng = createSeededRng(42);
    const out = renderPrideChart(SAMPLE, {
      emoji: true,
      ansi: false,
      rng,
      story: "never",
    });
    // No bookmark glyph in the rendered output when story is suppressed.
    assert.ok(!out.includes("\u{1f4d6}"), "no bookmark when story:never");
    // None of the bank stories should appear verbatim.
    const anyStoryPresent = PRIDE_STORIES.some((s) => out.includes(s.story));
    assert.ok(!anyStoryPresent, "no story body when story:never");
  });

  it("(6c) story=always renders a story footer (deterministic via seed)", () => {
    const rng = createSeededRng(42);
    const out = renderPrideChart(SAMPLE, {
      emoji: true,
      ansi: false,
      rng,
      story: "always",
    });
    assert.ok(out.includes("\u{1f4d6}"), "bookmark glyph present");
    // One of the bank stories must appear verbatim under the bookmark.
    assert.ok(
      PRIDE_STORIES.some((s) => out.includes(s.story)),
      "a story from PRIDE_STORIES must be embedded",
    );
  });

  it("(6d) different seeds → different taunts (rotation actually rotates)", () => {
    const chartA = renderPrideChart(SAMPLE, {
      emoji: false,
      ansi: false,
      rng: createSeededRng(1),
      story: "never",
    });
    const chartB = renderPrideChart(SAMPLE, {
      emoji: false,
      ansi: false,
      rng: createSeededRng(7),
      story: "never",
    });
    const chartC = renderPrideChart(SAMPLE, {
      emoji: false,
      ansi: false,
      rng: createSeededRng(42),
      story: "never",
    });
    // At least 2 of the 3 should differ — guards against accidentally
    // freezing the RNG to a constant value.
    const unique = new Set([chartA, chartB, chartC]);
    assert.ok(unique.size >= 2, "three different seeds produce at least two distinct charts");
  });

  it("(7) emoji:false → uses *, [TOP], [DEPT] instead of emoji", () => {
    const out = renderPrideChart(SAMPLE, { emoji: false, ansi: false });
    assert.ok(out.includes("* "), "ASCII lion star");
    assert.ok(out.includes("[TOP]"), "ASCII top marker");
    assert.ok(out.includes("[DEPT]"), "ASCII dept marker");
    // Emoji must NOT appear.
    assert.ok(!out.includes("\u{1f981}"));
    assert.ok(!out.includes("\u{1f451}"));
    assert.ok(!out.includes("\u{1f3db}"));
  });

  it("(8) ansi:true → contains ANSI escape sequences", () => {
    const out = renderPrideChart(SAMPLE, { emoji: true, ansi: true });
    // chalk emits `\x1b[` (ESC[) for every styled token.
    assert.ok(out.includes("\x1b["), "ANSI escape present");
  });

  it("(9) shape: Higher Office section appears BEFORE Departments section", () => {
    const out = renderPrideChart(SAMPLE, { emoji: true, ansi: false });
    const hoIdx = out.indexOf("Higher Office");
    const deptIdx = out.indexOf("Departments");
    assert.ok(hoIdx >= 0, "Higher Office section present");
    assert.ok(deptIdx >= 0, "Departments section present");
    assert.ok(hoIdx < deptIdx, "Higher Office precedes Departments");
  });

  it("(10) bio is included when set, omitted when not", () => {
    const withBio = renderPrideChart(SAMPLE, { emoji: true, ansi: false });
    assert.ok(withBio.includes("the boss"), "bio rendered when set");

    const sampleNoBio = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null, role: "Chief of Staff" },
        eng_lead: { department: "eng", reportsTo: "main" },
      },
    });
    const withoutBio = renderPrideChart(sampleNoBio, { emoji: true, ansi: false });
    assert.ok(!withoutBio.includes("the boss"));
    // Sanity: rendering still works without a bio.
    assert.ok(withoutBio.includes("main"));
  });
});

// ── channel + constants tests ───────────────────────────────────────

describe("renderPrideChartForChannel", () => {
  it("(11) wraps in triple-backtick code block (monospace for WA/Slack/Discord)", () => {
    const graph = makeGraph({
      topOrder: "main",
      members: {
        main: { department: "office", reportsTo: null },
        eng_a: { department: "eng", reportsTo: "main" },
      },
    });
    const out = renderPrideChartForChannel(graph);
    assert.ok(out.startsWith("```"), "starts with triple backtick");
    assert.ok(out.endsWith("```"), "ends with triple backtick");
    // No ANSI inside the block — channels render plain text.
    assert.ok(!out.includes("\x1b["));
    // Emoji ARE present (the WA/Slack/Discord clients render unicode).
    assert.ok(out.includes("\u{1f981}"));
  });
});

describe("PRIDE_CHART_FLAT_CREW_NOTE", () => {
  it("(12) mentions `brigade org init` AND `/agents`", () => {
    assert.ok(
      PRIDE_CHART_FLAT_CREW_NOTE.includes("brigade org init"),
      "points operator at scaffolding command",
    );
    assert.ok(
      PRIDE_CHART_FLAT_CREW_NOTE.includes("/agents"),
      "points operator at the legacy flat roster",
    );
  });
});
