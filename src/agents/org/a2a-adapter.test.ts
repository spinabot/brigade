/**
 * Stage-C tests for `orgGraphAsA2APolicy`.
 *
 * Contract:
 *   - derived A2A allows escalation-up (caller → manager)
 *   - derived A2A allows assignment-down (manager → report)
 *   - derived A2A allows same-dept lateral (peer ↔ peer)
 *   - derived A2A allows topOrder broadcast (member ↔ top)
 *   - derived A2A CLOSES cross-dept lateral (peer1 ↔ peer2 different depts)
 *   - extraAllow OPENS edges that derivation closed
 *   - extraDeny CLOSES edges that derivation opened (deny wins last)
 *   - self → self is always allowed
 *   - non-members get refused both as caller and as target
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import { deriveOrgGraph } from "./derive-graph.js";
import { orgGraphAsA2APolicy } from "./a2a-adapter.js";

function policyFor(cfg: BrigadeConfig) {
  const graph = deriveOrgGraph(cfg);
  assert.ok(graph, "expected derived graph in test fixture");
  return orgGraphAsA2APolicy(graph);
}

describe("orgGraphAsA2APolicy: derived A2A", () => {
  it("allows escalation-up (caller → manager)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("eng1", "main"), true);
  });

  it("allows assignment-down (manager → report)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("main", "eng1"), true);
  });

  it("allows same-dept lateral (peer ↔ peer)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        eng2: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("eng1", "eng2"), true);
    assert.equal(p.isAllowed("eng2", "eng1"), true);
  });

  it("closes cross-dept lateral", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        ops1: { org: { department: "ops", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("eng1", "ops1"), false);
    assert.equal(p.isAllowed("ops1", "eng1"), false);
  });

  it("extraAllow OPENS edges that derivation closed", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        ops1: { org: { department: "ops", reportsTo: "main" } },
      },
      org: {
        topOrder: "main",
        a2a: {
          mode: "derived",
          extraAllow: [{ from: "eng1", to: "ops1", reason: "incident bridge" }],
        },
      },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("eng1", "ops1"), true);
    // Reverse direction is still closed (extraAllow is directional).
    assert.equal(p.isAllowed("ops1", "eng1"), false);
  });

  it("extraDeny CLOSES edges derivation opened (deny wins last)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        eng2: { org: { department: "eng", reportsTo: "main" } },
      },
      org: {
        topOrder: "main",
        a2a: {
          mode: "derived",
          extraDeny: [{ from: "eng1", to: "eng2", reason: "isolated" }],
        },
      },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("eng1", "eng2"), false);
    // Reverse direction wasn't denied — still allowed.
    assert.equal(p.isAllowed("eng2", "eng1"), true);
  });

  it("self → self is always allowed", () => {
    const cfg: BrigadeConfig = {
      agents: { main: { org: { department: "exec", reportsTo: null } } },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("main", "main"), true);
  });

  it("non-member callers are denied", () => {
    const cfg: BrigadeConfig = {
      agents: { main: { org: { department: "exec", reportsTo: null } } },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("ghost", "main"), false);
    assert.equal(p.isAllowed("main", "ghost"), false);
  });

  it("topOrder broadcast both directions (Rule iv)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.isAllowed("eng1", "main"), true);
    assert.equal(p.isAllowed("main", "eng1"), true);
  });

  it("enabled flag is true (matches legacy shape)", () => {
    const cfg: BrigadeConfig = {
      agents: { main: { org: { department: "exec", reportsTo: null } } },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const p = policyFor(cfg);
    assert.equal(p.enabled, true);
  });
});

describe("deriveOrgDisplayGraph: explicit mode no longer blanks DISPLAY surfaces", () => {
  // Production 2026-06-11: setting org.a2a.mode "explicit" (an A2A POLICY
  // choice) made the connect banner / org.snapshot / org show report a
  // full 4-tier hierarchy as "your crew is flat" — the model then rebuilt
  // org data that was never missing. Display derivation now ignores the
  // mode; policy derivation (deriveOrgGraph) keeps returning undefined.
  it("policy variant stays undefined under explicit; display variant returns the graph", async () => {
    const { deriveOrgDisplayGraph } = await import("./derive-graph.js");
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "explicit" } },
    };
    assert.equal(deriveOrgGraph(cfg), undefined, "policy consumers fall back to the allow matrix");
    const display = deriveOrgDisplayGraph(cfg);
    assert.ok(display, "display consumers still see the hierarchy");
    assert.equal(display.topOrder, "main");
    assert.ok(display.members.eng1, "members present for rendering");
  });
});
