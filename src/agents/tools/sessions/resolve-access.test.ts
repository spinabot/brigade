/**
 * resolveSessionAccessPolicy tests.
 *
 * Pins the derivation extracted from agent-loop (2026-06-11) so the per-turn
 * build and the sessions_send live re-check stay identical, and pins the
 * mid-run-enable behavior the live re-check restores: a config that flips
 * from blocked → allowed must produce a policy that grants the send.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveSessionAccessPolicy } from "./resolve-access.js";
import { checkSessionToolAccess } from "./shared.js";

const MAIN = "agent:main:main";
const ML = "agent:marketing-lead:main";

function canSend(cfg: unknown): boolean {
	const { visibility, a2aPolicy } = resolveSessionAccessPolicy(cfg);
	return checkSessionToolAccess({
		action: "send",
		requesterSessionKey: MAIN,
		targetSessionKey: ML,
		visibility,
		a2aPolicy,
	}).allowed;
}

describe("resolveSessionAccessPolicy — derivation", () => {
	it("defaults (empty config) → visibility self, A2A disabled, send blocked", () => {
		const { visibility, a2aPolicy } = resolveSessionAccessPolicy({});
		assert.equal(visibility, "self");
		assert.equal(a2aPolicy.enabled, false);
		assert.equal(canSend({}), false);
	});

	it("flat allow-all + visibility all + enabled (no org) → send allowed", () => {
		const cfg = {
			session: {
				sessionTools: { visibility: "all" },
				agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] },
			},
		};
		assert.equal(canSend(cfg), true);
	});

	// CONTRACT CHANGE (2026-06-12, operator-demanded): the orchestrator —
	// the operator's DEFAULT agent — now BYPASSES the org chart in derived
	// mode. This file previously pinned "main (non-member) cannot reach
	// marketing-lead", which meant the agent the operator actually talks to
	// couldn't message its own crew out of the box ("ask eng-lead if they're
	// up for work" → forbidden) and the model offered to flip the WHOLE org
	// to explicit mode as a workaround. Member↔member traffic stays
	// graph-governed; `org.a2a.restrictDefaultAgent: true` restores the old
	// strict behaviour for lockdown installs.
	const ORG_CFG = {
		session: {
			sessionTools: { visibility: "all" },
			agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] },
		},
		org: {
			topOrder: "ceo-agent",
			a2a: { mode: "derived" },
			// main is NOT a member; marketing-lead reports to cmo-agent.
		},
		agents: {
			main: {},
			"ceo-agent": { org: { department: "exec", reportsTo: null } },
			"cmo-agent": { org: { department: "marketing", reportsTo: "ceo-agent" } },
			"marketing-lead": { org: { department: "marketing", reportsTo: "cmo-agent" } },
			"eng-lead": { org: { department: "engineering", reportsTo: "ceo-agent" } },
		},
	};

	it("derived mode: the DEFAULT agent (orchestrator) bypasses the chart", () => {
		assert.equal(canSend(ORG_CFG), true, "main reaches marketing-lead out of the box");
		// And the reverse — members can report back to the orchestrator.
		const { visibility, a2aPolicy } = resolveSessionAccessPolicy(ORG_CFG);
		assert.equal(visibility, "all");
		assert.equal(a2aPolicy.isAllowed("marketing-lead", "main"), true);
	});

	it("derived mode: member↔member traffic stays graph-governed (cross-dept lateral blocked)", () => {
		const { a2aPolicy } = resolveSessionAccessPolicy(ORG_CFG);
		assert.equal(
			a2aPolicy.isAllowed("marketing-lead", "eng-lead"),
			false,
			"cross-department lateral between members is still chart-governed",
		);
	});

	it("derived mode: a NON-default ad-hoc non-member is still blocked", () => {
		const { a2aPolicy } = resolveSessionAccessPolicy(ORG_CFG);
		assert.equal(
			a2aPolicy.isAllowed("rogue-agent", "marketing-lead"),
			false,
			"the bypass is for the operator's default agent ONLY",
		);
	});

	it("org.a2a.restrictDefaultAgent: true restores the strict members-only contract", () => {
		const strict = {
			...ORG_CFG,
			org: { ...ORG_CFG.org, a2a: { mode: "derived", restrictDefaultAgent: true } },
		};
		assert.equal(canSend(strict), false, "lockdown opt-out: main blocked again");
	});

	it("explicit mode still bypasses the graph entirely (flat allow matrix)", () => {
		const explicit = {
			...ORG_CFG,
			org: { topOrder: "ceo-agent", a2a: { mode: "explicit" } },
		};
		assert.equal(canSend(explicit), true, "manage_access set explicit keeps working");
	});
});
