/**
 * Tests for org-hierarchy skill visibility (resolveOrgVisibleSkillAgents).
 * Pure-logic; builds a small cfg.org and asserts which peers each agent sees.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveOrgVisibleSkillAgents } from "./org-access.js";
import type { BrigadeConfig } from "../../config/io.js";

/** ceo ← cfo ← accountant ; ceo ← eng-lead ← dev. */
function orgCfg(mode: "derived" | "explicit" | "open" = "derived"): BrigadeConfig {
	return {
		org: { topOrder: "ceo", a2a: { mode } },
		agents: {
			ceo: { org: { department: "exec", reportsTo: null, role: "CEO" } },
			cfo: { org: { department: "finance", reportsTo: "ceo", role: "CFO" } },
			accountant: { org: { department: "finance", reportsTo: "cfo", role: "Accountant" } },
			"eng-lead": { org: { department: "eng", reportsTo: "ceo", role: "Eng Lead" } },
			dev: { org: { department: "eng", reportsTo: "eng-lead", role: "Dev" } },
		},
	} as unknown as BrigadeConfig;
}

describe("resolveOrgVisibleSkillAgents", () => {
	it("returns [] when access is undefined or disabled", () => {
		assert.deepEqual(resolveOrgVisibleSkillAgents(orgCfg(), "cfo", undefined), []);
		assert.deepEqual(resolveOrgVisibleSkillAgents(orgCfg(), "cfo", { enabled: false }), []);
	});

	it("down (default): direct reports only", () => {
		// cfo's direct report is accountant; ceo is its manager (not down).
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg(), "cfo", { enabled: true }),
			["accountant"],
		);
		// ceo's direct reports are cfo + eng-lead (NOT accountant/dev without transitive).
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg(), "ceo", { enabled: true, direction: "down" }),
			["cfo", "eng-lead"],
		);
	});

	it("down + transitive: the whole sub-tree", () => {
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg(), "ceo", {
				enabled: true,
				direction: "down",
				transitive: true,
			}),
			["accountant", "cfo", "dev", "eng-lead"],
		);
	});

	it("up: direct manager only, or the whole chain when transitive", () => {
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg(), "accountant", { enabled: true, direction: "up" }),
			["cfo"],
		);
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg(), "accountant", {
				enabled: true,
				direction: "up",
				transitive: true,
			}),
			["ceo", "cfo"],
		);
	});

	it("both: union of reports and managers", () => {
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg(), "cfo", { enabled: true, direction: "both" }),
			["accountant", "ceo"],
		);
	});

	it("never includes the agent's own id", () => {
		const out = resolveOrgVisibleSkillAgents(orgCfg(), "cfo", {
			enabled: true,
			direction: "both",
			transitive: true,
		});
		assert.ok(!out.includes("cfo"));
	});

	it("explicit mode turns the feature off (policy graph is blank)", () => {
		assert.deepEqual(
			resolveOrgVisibleSkillAgents(orgCfg("explicit"), "cfo", { enabled: true }),
			[],
		);
	});

	it("returns [] when there is no org block at all", () => {
		const cfg = { agents: { cfo: {} } } as unknown as BrigadeConfig;
		assert.deepEqual(resolveOrgVisibleSkillAgents(cfg, "cfo", { enabled: true }), []);
	});

	it("returns [] when the agent is not an org member", () => {
		assert.deepEqual(resolveOrgVisibleSkillAgents(orgCfg(), "stranger", { enabled: true }), []);
	});
});
