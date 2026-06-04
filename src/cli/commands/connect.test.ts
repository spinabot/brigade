/**
 * Pure-unit tests for the `/org` TUI slash command — exercises the
 * shared helper module (`org-slash.ts`) that `connect.ts` consumes.
 *
 * The connect TUI itself sits behind Pi-TUI's editor + renderer which
 * are hard to drive without a live terminal, so we cover behaviour by
 * testing the helpers + a stub-driven flow that mirrors what the
 * `editor.onSubmit` handler does for `/org` (call gateway snapshot,
 * branch on parsed shape, render via the Pride template).
 *
 * NO openclaw / clawd / hermes / boop / paperclip / nanoclaw identifiers.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	BRIGADE_FOOTER_RULE,
	BRIGADE_TAUNT,
	PRIDE_CHART_FLAT_CREW_NOTE,
	computeExplain,
	filterGraphToSubtree,
	formatExplain,
	parseOrgSlash,
	renderDepartmentsOnly,
} from "./org-slash.js";
import { handleOrgSnapshot } from "../../core/server-methods/org.js";
import {
	renderPrideChartWithPins,
} from "../../agents/org/pride-template.js";
import {
	BRIGADE_FOOTER_RULES,
	BRIGADE_TAUNTS,
} from "../../agents/org/pride-taunts.js";
import type { OrgGraph } from "../../agents/org/types.js";

/* ─── Helpers ───────────────────────────────────────────────────────── */

function makePopulatedCfg() {
	return {
		agents: {
			main: {
				org: {
					department: "exec",
					reportsTo: null,
					role: "Chief of Staff",
				},
			},
			eng_lead: {
				org: {
					department: "engineering",
					reportsTo: "main",
					role: "Engineering Lead",
				},
			},
			eng_ic: {
				org: {
					department: "engineering",
					reportsTo: "eng_lead",
					role: "Engineer",
				},
			},
			ops_lead: {
				org: {
					department: "ops",
					reportsTo: "main",
					role: "Operations Lead",
				},
			},
		},
		org: {
			topOrder: "main",
			a2a: { mode: "derived" as const },
			departmentHeads: { engineering: "eng_lead", ops: "ops_lead" },
		},
	};
}

function makeFlatCfg() {
	// No cfg.org block → flat-crew redirect.
	return { agents: { main: {}, ops: {} } };
}

/* ─── parseOrgSlash ─────────────────────────────────────────────────── */

describe("parseOrgSlash", () => {
	it("empty args → kind: show", () => {
		assert.deepEqual(parseOrgSlash(""), { kind: "show" });
		assert.deepEqual(parseOrgSlash("   "), { kind: "show" });
	});

	it("--departments → kind: departments", () => {
		assert.deepEqual(parseOrgSlash("--departments"), { kind: "departments" });
	});

	it("--explain <from> <to> → kind: explain", () => {
		assert.deepEqual(parseOrgSlash("--explain main eng_lead"), {
			kind: "explain",
			from: "main",
			to: "eng_lead",
		});
	});

	it("single agent id → kind: subtree", () => {
		assert.deepEqual(parseOrgSlash("eng_lead"), {
			kind: "subtree",
			agentId: "eng_lead",
		});
	});

	it("--explain with wrong arity → error", () => {
		const out = parseOrgSlash("--explain main");
		assert.equal(out.kind, "error");
	});

	it("multi-token without flag → error", () => {
		const out = parseOrgSlash("main eng_lead");
		assert.equal(out.kind, "error");
	});

	it("unknown flag → error", () => {
		const out = parseOrgSlash("--something");
		assert.equal(out.kind, "error");
	});
});

/* ─── filterGraphToSubtree ───────────────────────────────────────────── */

describe("filterGraphToSubtree", () => {
	it("keeps topOrder + agent + descendants, drops the rest", () => {
		const cfg = makePopulatedCfg();
		const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
		assert.equal(snap.ok, true);
		if (snap.ok !== true) return;
		const filtered = filterGraphToSubtree(snap.graph as OrgGraph, "eng_lead");
		assert.ok(filtered, "subtree filter must succeed for known agent");
		const ids = Object.keys(filtered.members).sort();
		// topOrder + eng_lead + eng_ic should remain; ops_lead dropped.
		assert.deepEqual(ids, ["eng_ic", "eng_lead", "main"]);
		assert.equal(filtered.members["ops_lead"], undefined);
	});

	it("returns undefined for an unknown agent", () => {
		const cfg = makePopulatedCfg();
		const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
		if (snap.ok !== true) return;
		const filtered = filterGraphToSubtree(snap.graph as OrgGraph, "ghost");
		assert.equal(filtered, undefined);
	});
});

/* ─── renderDepartmentsOnly ──────────────────────────────────────────── */

describe("renderDepartmentsOnly", () => {
	it("omits the Higher Office section but keeps the footer rule", () => {
		const cfg = makePopulatedCfg();
		const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
		if (snap.ok !== true) return;
		const body = renderDepartmentsOnly(snap.graph as OrgGraph, undefined, {
			emoji: true,
			ansi: false,
			// Suppress the optional story footer so the assertion below
			// pins ONLY the footer-rule line. With story:"auto" the rng
			// can interleave a story block between the rule and the next
			// expected token, which is fine functionally but noisy for a
			// regression-guard like this.
			story: "never",
		});
		// Assert the SECTION HEADING (`▌ Higher Office`) is gone — not
		// the phrase itself, because a few footer rules in the taunt
		// bank legitimately contain the words "Higher Office".
		assert.doesNotMatch(body, /▌\s*Higher Office/);
		assert.match(body, /Departments/);
		// Footer rule now rotates from BRIGADE_FOOTER_RULES bank.
		assert.ok(
			BRIGADE_FOOTER_RULES.some((f) => body.includes(f)),
			"departments-only body must contain a footer rule from the bank",
		);
	});
});

/* ─── computeExplain + formatExplain ─────────────────────────────────── */

describe("computeExplain + formatExplain", () => {
	it("derives an allowed edge from main → eng_lead (assignment-down)", () => {
		const cfg = makePopulatedCfg();
		const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
		if (snap.ok !== true) return;
		const out = computeExplain(snap.graph as OrgGraph, "main", "eng_lead");
		assert.equal(out.status, "allowed");
		assert.ok(out.chain && out.chain.length > 0);
		const formatted = formatExplain(out);
		assert.match(formatted, /main → eng_lead: ALLOWED/);
	});

	it("denies cross-department edges with rule (v) reason", () => {
		const cfg = makePopulatedCfg();
		const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
		if (snap.ok !== true) return;
		const out = computeExplain(snap.graph as OrgGraph, "eng_ic", "ops_lead");
		assert.equal(out.status, "denied");
		assert.match(out.reason ?? "", /cross-department/);
		const formatted = formatExplain(out);
		assert.match(formatted, /DENIED/);
		assert.match(formatted, /cross-department/);
	});

	it("flags unknown members", () => {
		const cfg = makePopulatedCfg();
		const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
		if (snap.ok !== true) return;
		const out = computeExplain(snap.graph as OrgGraph, "ghost", "main");
		assert.equal(out.status, "unknown-member");
		assert.equal(out.unknown, "ghost");
		const formatted = formatExplain(out);
		assert.match(formatted, /UNKNOWN/);
	});
});

/* ─── End-to-end TUI flow (stub-driven) ──────────────────────────────── */

/**
 * Mirror of what `connect.ts`'s `/org` slash branch does. The TUI itself
 * routes the rendered string into `insertBeforeEditor(new Text(...))`,
 * but the rendering logic is the bit worth pinning — and it lives in
 * the shared helpers + the gateway snapshot handler. This stub captures
 * the strings the TUI would print so we can pin them.
 */
async function renderTuiOrg(args: string, cfg: unknown): Promise<string> {
	const parsed = parseOrgSlash(args);
	if (parsed.kind === "error") return parsed.message;
	const snap = handleOrgSnapshot(undefined, { loadConfig: () => cfg as never });
	if (snap.ok === false) return snap.redirect;
	const graph = snap.graph as OrgGraph;
	if (parsed.kind === "show") return snap.charts.tui;
	if (parsed.kind === "explain") {
		return formatExplain(computeExplain(graph, parsed.from, parsed.to));
	}
	if (parsed.kind === "subtree") {
		const filtered = filterGraphToSubtree(graph, parsed.agentId);
		if (!filtered) {
			return `Unknown agent "${parsed.agentId}". Run /org to see the full chart.`;
		}
		return renderPrideChartWithPins(filtered, undefined, {
			emoji: true,
			ansi: true,
		});
	}
	return renderDepartmentsOnly(graph, undefined, { emoji: true, ansi: true });
}

describe("connect /org slash command (TUI flow)", () => {
	it("(1) /org with cfg.org absent prints the redirect AND mentions `brigade org init`", async () => {
		const cfg = makeFlatCfg();
		const out = await renderTuiOrg("", cfg);
		assert.equal(out, PRIDE_CHART_FLAT_CREW_NOTE);
		assert.match(out, /brigade org init/);
		assert.match(out, /\/agents/);
	});

	it("(2) /org with cfg.org present prints the chart with the Brigade footer rule", async () => {
		const cfg = makePopulatedCfg();
		const out = await renderTuiOrg("", cfg);
		// The TUI /org chart is now the FANCY columnar render
		// (box-drawing connectors + Higher Office box centered + lead
		// boxes in a row + team bullets). It no longer prints the
		// legacy "Higher Office" / "Departments" section-bar headings
		// because the columnar layout makes the tier implicit
		// (visually).
		assert.match(out, /🦁 The Pride/);
		// Top-of-org agent name present.
		assert.match(out, /main/);
		// Dept slugs present in the column headers.
		assert.match(out, /engineering/);
		assert.match(out, /ops/);
		// Box-drawing connectors (the visual hierarchy).
		assert.match(out, /[┌┐└┘├┤┬┴┼─│]/);
		// Taunt + footer rotate from the bank.
		assert.ok(
			BRIGADE_TAUNTS.some((t) => out.includes(t)),
			"chart must contain a taunt from the bank",
		);
		assert.ok(
			BRIGADE_FOOTER_RULES.some((f) => out.includes(f)),
			"chart must contain a footer rule from the bank",
		);
	});

	it("(3) /org <agent-id> filters to the subtree", async () => {
		const cfg = makePopulatedCfg();
		const out = await renderTuiOrg("eng_lead", cfg);
		// Should contain eng_lead + eng_ic, NOT ops_lead.
		assert.match(out, /eng_lead/);
		assert.match(out, /eng_ic/);
		assert.doesNotMatch(out, /ops_lead/);
	});

	it("(4) /org --departments omits the Higher Office section", async () => {
		const cfg = makePopulatedCfg();
		const out = await renderTuiOrg("--departments", cfg);
		// Strip ANSI before matching so the test runs with both colour modes.
		const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
		// Assert the SECTION HEADING (`▌ Higher Office`) is gone — not the
		// phrase itself, because a few footer rules in the taunt bank
		// legitimately contain the words "Higher Office".
		assert.doesNotMatch(plain, /▌\s*Higher Office/);
		assert.match(plain, /Departments/);
	});

	it("(5) /org --explain <from> <to> prints the derivation outcome", async () => {
		const cfg = makePopulatedCfg();
		const out = await renderTuiOrg("--explain main eng_lead", cfg);
		assert.match(out, /main → eng_lead: ALLOWED/);
	});

	it("(6) /org <unknown-agent> prints a friendly error, not an empty chart", async () => {
		const cfg = makePopulatedCfg();
		const out = await renderTuiOrg("ghost", cfg);
		assert.match(out, /Unknown agent "ghost"/);
	});
});
