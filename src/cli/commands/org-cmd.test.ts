/**
 * Stage-C tests for `brigade org <init|show|explain|doctor>`.
 *
 * Contract:
 *   - `init --template solo` writes a starter to brigade.json without
 *     spawning $EDITOR when `skipEditor: true`. The on-disk cfg.org
 *     matches the solo template.
 *   - `init --template <family|company|custom>` produces the expected
 *     shape.
 *   - `init` with an unknown template returns exit 2.
 *   - `init` refuses to overwrite an existing cfg.org block (exit 2).
 *   - `show` prints an ASCII tree.
 *   - `explain a b` prints ALLOWED for a derived edge.
 *   - `explain` prints DENIED + structured reason for a cross-dept edge.
 *   - `doctor` reports the lints from Stage A.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  runOrgDoctor,
  runOrgExplain,
  runOrgInit,
  runOrgShow,
} from "./org-cmd.js";

let stateDir: string;
let prevStateDir: string | undefined;
let configPath: string;

function writeCfg(cfg: unknown): void {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function readCfg(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "brigade-org-cmd-"));
  mkdirSync(join(stateDir, "agents"), { recursive: true });
  prevStateDir = process.env.BRIGADE_STATE_DIR;
  process.env.BRIGADE_STATE_DIR = stateDir;
  configPath = join(stateDir, "brigade.json");
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
  else process.env.BRIGADE_STATE_DIR = prevStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

function capture() {
  return { stdout: [] as string[], stderr: [] as string[] };
}

describe("brigade org init", () => {
  it("--template solo writes the expected cfg.org block", async () => {
    writeCfg({ agents: {} });
    const cap = capture();
    const code = await runOrgInit({ template: "solo", skipEditor: true, json: true, capture: cap });
    assert.equal(code, 0, cap.stderr.join("\n"));
    const next = readCfg();
    assert.ok(next.org, "cfg.org should be written");
    const org = next.org as Record<string, unknown>;
    assert.equal(org["topOrder"], "main");
    const agents = next.agents as Record<string, Record<string, unknown>>;
    const mainOrg = agents["main"]?.["org"] as Record<string, unknown>;
    assert.equal(mainOrg["department"], "office");
    assert.equal(mainOrg["role"], "Chief of Staff");
  });

  it("--template family writes 3 household agents", async () => {
    writeCfg({ agents: {} });
    const code = await runOrgInit({ template: "family", skipEditor: true, capture: capture() });
    assert.equal(code, 0);
    const next = readCfg();
    const agents = next.agents as Record<string, Record<string, unknown>>;
    assert.ok(agents["main"]);
    assert.ok(agents["helper"]);
    assert.ok(agents["scheduler"]);
    const helperOrg = agents["helper"]?.["org"] as Record<string, unknown>;
    assert.equal(helperOrg["department"], "household");
  });

  it("--template company seeds the departmentHeads pin", async () => {
    writeCfg({ agents: {} });
    const code = await runOrgInit({ template: "company", skipEditor: true, capture: capture() });
    assert.equal(code, 0);
    const next = readCfg();
    const org = next.org as Record<string, unknown>;
    const heads = org["departmentHeads"] as Record<string, string>;
    assert.equal(heads["engineering"], "eng_lead");
    assert.equal(heads["ops"], "ops_lead");
  });

  it("--template custom writes empty agents map", async () => {
    writeCfg({ agents: {} });
    const code = await runOrgInit({ template: "custom", skipEditor: true, capture: capture() });
    assert.equal(code, 0);
    const next = readCfg();
    const agents = next.agents as Record<string, Record<string, unknown>>;
    // Only the agents the template touches. Custom touches none, so
    // `agents` retains whatever pre-existed (just the empty seed).
    assert.equal(Object.keys(agents).filter((k) => k !== "defaults").length, 0);
  });

  it("unknown template returns exit 2", async () => {
    writeCfg({ agents: {} });
    const code = await runOrgInit({ template: "bogus", skipEditor: true, capture: capture() });
    assert.equal(code, 2);
  });

  it("refuses to overwrite an existing cfg.org block (exit 2)", async () => {
    writeCfg({
      agents: { main: { org: { department: "exec", reportsTo: null } } },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    });
    const cap = capture();
    const code = await runOrgInit({ template: "solo", skipEditor: true, capture: cap });
    assert.equal(code, 2);
  });
});

describe("brigade org show", () => {
  it("prints ASCII tree of a derived org", async () => {
    writeCfg({
      agents: {
        main: { org: { department: "exec", reportsTo: null, role: "Chief of Staff" } },
        eng1: { org: { department: "eng", reportsTo: "main", role: "Engineer" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    });
    const cap = capture();
    const code = await runOrgShow({ capture: cap });
    assert.equal(code, 0);
    const out = cap.stdout.join("\n");
    assert.match(out, /main/);
    assert.match(out, /eng1/);
    assert.match(out, /Departments:/);
  });

  it("prints the no-org banner when cfg.org is absent and no agents exist", async () => {
    // Empty agents map — auto-derive returns undefined (no members),
    // so the tree falls through to the "no cfg.org" banner.
    writeCfg({ agents: {} });
    const cap = capture();
    const code = await runOrgShow({ capture: cap });
    assert.equal(code, 0);
    assert.match(cap.stdout.join("\n"), /no cfg\.org/);
  });

  it("renders auto-derived solo graph when single agent + no cfg.org", async () => {
    writeCfg({ agents: { main: {} } });
    const cap = capture();
    const code = await runOrgShow({ capture: cap });
    assert.equal(code, 0);
    // Auto-derive synthesises "main" in office department with Chief
    // of Staff role — show prints that, NOT the no-org banner.
    assert.match(cap.stdout.join("\n"), /main/);
    assert.match(cap.stdout.join("\n"), /office/);
  });
});

describe("brigade org explain", () => {
  it("prints ALLOWED for a derived escalation edge", async () => {
    writeCfg({
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    });
    const cap = capture();
    const code = await runOrgExplain({ from: "eng1", to: "main", capture: cap });
    assert.equal(code, 0);
    const out = cap.stdout.join("\n");
    assert.match(out, /ALLOWED/);
  });

  it("prints DENIED + structured reason for a cross-dept edge", async () => {
    writeCfg({
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        ops1: { org: { department: "ops", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    });
    const cap = capture();
    const code = await runOrgExplain({ from: "eng1", to: "ops1", capture: cap });
    assert.equal(code, 0);
    const out = cap.stdout.join("\n");
    assert.match(out, /DENIED/);
    assert.match(out, /cross-department/);
  });
});

describe("brigade org doctor", () => {
  it("reports zero warnings on a healthy two-peer-dept org", async () => {
    // Two members per department → no ORG_SINGLE_MEMBER_DEPARTMENT lint.
    writeCfg({
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        coo: { org: { department: "exec", reportsTo: "main" } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        eng2: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    });
    const cap = capture();
    const code = await runOrgDoctor({ json: true, capture: cap });
    assert.equal(code, 0);
    const out = JSON.parse(cap.stdout.join("\n")) as { status: string; warnings: unknown[] };
    assert.equal(out.status, "ok");
    assert.equal(out.warnings.length, 0, JSON.stringify(out.warnings));
  });

  it("flags an extraAllow no-op as a soft warning", async () => {
    writeCfg({
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        eng2: { org: { department: "eng", reportsTo: "main" } },
      },
      org: {
        topOrder: "main",
        a2a: {
          mode: "derived",
          // eng1 → eng2 is already derived as lateral-peer, so this
          // is a no-op operator override.
          extraAllow: [{ from: "eng1", to: "eng2", reason: "redundant" }],
        },
      },
    });
    const cap = capture();
    const code = await runOrgDoctor({ json: true, capture: cap });
    assert.equal(code, 0);
    const out = JSON.parse(cap.stdout.join("\n")) as {
      status: string;
      warnings: Array<{ code: string }>;
    };
    assert.ok(out.warnings.some((w) => w.code === "ORG_EXTRA_ALLOW_NO_OP"));
  });
});

describe("brigade org explain — explicit mode (audit P1 fix)", () => {
	// Under a2a mode "explicit" runtime allow/deny comes from the flat
	// session.agentToAgent.allow matrix; explain must NOT print edge-based
	// ALLOWED/DENIED verdicts that contradict sessions_send. It shows org
	// SHAPE, clearly labelled.
	it("prints the structure-only note instead of an ALLOWED verdict", async () => {
		writeCfg({
			agents: {
				main: { org: { department: "exec", reportsTo: null } },
				eng1: { org: { department: "eng", reportsTo: "main" } },
			},
			org: { topOrder: "main", a2a: { mode: "explicit" } },
		});
		const cap = capture();
		const code = await runOrgExplain({ from: "eng1", to: "main", capture: cap });
		assert.equal(code, 0);
		const out = cap.stdout.join("\n");
		assert.match(out, /runtime allow\/deny comes from session\.agentToAgent\.allow/);
		assert.match(out, /org shape eng1 → main: connected/);
		assert.doesNotMatch(out, /: ALLOWED/);
		assert.doesNotMatch(out, /: DENIED/);
	});
});
