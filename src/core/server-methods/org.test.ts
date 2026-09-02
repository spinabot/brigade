/**
 * org.snapshot gateway RPC handler tests.
 *
 * Pure-handler tests — the `handleOrgSnapshot` function takes its config
 * through an injected dependency, so we never touch `~/.brigade` and
 * never need a tempdir. Two cases pin the contract:
 *
 *   - cfg.org ABSENT → `{ ok:false, reason:"flat-crew", redirect:<note> }`
 *     where the redirect points the operator at `brigade org init` AND
 *     the legacy `/agents` surface (the same note `/org` would print).
 *   - cfg.org PRESENT → `{ ok:true, graph, charts: { tui, channel, ascii,
 *     json } }` where the four formats are non-empty, DISTINCT strings/
 *     objects so a caller can tell them apart.
 *
 * No external agent-codebase identifiers
 * appear in this file.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BRIGADE_FOOTER_RULES, BRIGADE_TAUNTS } from "../../agents/org/pride-taunts.js";

import { handleOrgSnapshot } from "./org.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a populated cfg.org with two departments + one head pin. */
function makePopulatedCfg() {
  return {
    agents: {
      defaults: { provider: "openrouter" },
      main: {
        org: {
          department: "exec",
          reportsTo: null,
          role: "Chief of Staff",
          bio: "Routes work across the org.",
        },
      },
      logistics: {
        org: {
          department: "logistics",
          reportsTo: "main",
          role: "Head of Logistics",
        },
      },
      inventory: {
        org: {
          department: "logistics",
          reportsTo: "logistics",
          role: "Inventory Lead",
        },
      },
      marketing: {
        org: {
          department: "marketing",
          reportsTo: "main",
          role: "Head of Marketing",
        },
      },
    },
    org: {
      topOrder: "main",
      a2a: { mode: "derived" as const },
      departmentHeads: { logistics: "logistics", marketing: "marketing" },
    },
    session: { agentToAgent: { enabled: true, allow: ["*"] } },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("org.snapshot RPC handler — cfg.org absent (flat-crew redirect)", () => {
  it("returns { ok:false, reason:'flat-crew', redirect:<note> }", () => {
    const out = handleOrgSnapshot(undefined, {
      loadConfig: () => ({ agents: {} } as never),
    });
    assert.equal(out.ok, false);
    if (out.ok === false) {
      assert.equal(out.reason, "flat-crew");
      // Redirect points the operator at the two follow-up surfaces.
      assert.match(out.redirect, /brigade org init/);
      assert.match(out.redirect, /\/agents/);
      assert.ok(out.redirect.length > 0, "redirect note must be non-empty");
    }
  });
});

describe("org.snapshot RPC handler — cfg.org present (every chart format)", () => {
  it("returns { ok:true, graph, charts:{ tui, channel, ascii, json } } with four distinct formats", () => {
    const cfg = makePopulatedCfg();
    const out = handleOrgSnapshot(undefined, {
      loadConfig: () => cfg as never,
    });
    assert.equal(out.ok, true);
    if (out.ok === true) {
      // graph echo
      assert.equal(out.graph.topOrder, "main");
      assert.ok(out.graph.members["main"] !== undefined, "graph must include topOrder member");

      // Every chart format present + non-empty.
      const { tui, channel, ascii, json } = out.charts;
      assert.equal(typeof tui, "string");
      assert.ok(tui.length > 0, "tui chart must be non-empty");
      assert.equal(typeof channel, "string");
      assert.ok(channel.length > 0, "channel chart must be non-empty");
      assert.equal(typeof ascii, "string");
      assert.ok(ascii.length > 0, "ascii chart must be non-empty");
      assert.equal(typeof json, "object");
      assert.ok(json !== null, "json chart must be a non-null OrgGraph object");

      // The four formats are DISTINCT — tui has ANSI escapes, channel is
      // code-block-wrapped, ascii is plain emoji-less text, json is the
      // raw OrgGraph. Pinning that none of them are byte-equal catches the
      // accidental "all three formats are the same string" regression.
      assert.notEqual(tui, channel, "tui and channel must differ (ANSI vs code block)");
      assert.notEqual(tui, ascii, "tui and ascii must differ (ANSI + emoji vs plain ASCII)");
      assert.notEqual(channel, ascii, "channel and ascii must differ (emoji vs no emoji)");

      // Format-specific markers.
      // TUI: ANSI escape sequence (ESC [).
      assert.match(tui, /\x1b\[/, "tui chart must include ANSI escape sequences");
      // TUI: emoji glyphs (🦁 / 👑 / 🏛).
      assert.match(tui, /\u{1f981}/u);
      // Channel: triple-backtick wrapper for monospace rendering.
      assert.match(channel, /^```/, "channel chart must start with triple backticks");
      assert.match(channel, /```$/, "channel chart must end with triple backticks");
      // Channel: emoji on, ANSI off.
      assert.match(channel, /\u{1f981}/u, "channel chart must include emoji");
      assert.doesNotMatch(channel, /\x1b\[/, "channel chart must not include ANSI escapes");
      // ASCII: no emoji, no ANSI — Pride tokens degrade to *, [TOP], [DEPT].
      assert.doesNotMatch(ascii, /\u{1f981}/u, "ascii chart must omit lion emoji");
      assert.doesNotMatch(ascii, /\u{1f451}/u, "ascii chart must omit crown emoji");
      assert.doesNotMatch(ascii, /\x1b\[/, "ascii chart must omit ANSI escapes");
      assert.match(ascii, /\[TOP\]/, "ascii chart must mark topOrder with [TOP]");
      assert.match(ascii, /\[DEPT\]/, "ascii chart must mark departments with [DEPT]");

      // Brigade taunt + footer must surface in every text format. The
      // chart rotates entries from the 145-taunt / 48-footer bank in
      // `pride-taunts.ts` on each render, so we can't assert specific
      // literals — instead we assert AT LEAST ONE entry from each bank
      // appears in each rendered format.
      for (const chart of [tui, channel, ascii]) {
        assert.ok(
          BRIGADE_TAUNTS.some((t) => chart.includes(t)),
          "chart must contain a taunt from the bank",
        );
        assert.ok(
          BRIGADE_FOOTER_RULES.some((f) => chart.includes(f)),
          "chart must contain a footer rule from the bank",
        );
      }
    }
  });

  it("graph echo === charts.json reference (single object, no double-derive)", () => {
    const cfg = makePopulatedCfg();
    const out = handleOrgSnapshot(undefined, {
      loadConfig: () => cfg as never,
    });
    assert.equal(out.ok, true);
    if (out.ok === true) {
      // Same graph reference — the handler must not derive twice.
      assert.strictEqual(
        out.graph,
        out.charts.json,
        "charts.json must reference the same OrgGraph as the top-level graph echo",
      );
    }
  });
});
