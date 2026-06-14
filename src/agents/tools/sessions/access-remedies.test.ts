/**
 * Self-documenting refusal regression tests.
 *
 * Production 2026-06-11: with bare refusal strings ("cross-agent visibility
 * not enabled") the model invented wrong causes ("hot-reload issue") instead
 * of naming the real config knob. The remedies now ride IN the refusal text
 * — these tests pin that each gate names its exact knob so a future copy
 * edit can't silently drop the self-documentation.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkSessionToolAccess, createAgentToAgentPolicy } from "./shared.js";

const REQ = "agent:main:main";
const TARGET = "agent:marketing-lead:main";

describe("cross-agent refusals carry the exact operator remedy", () => {
	it("visibility gate points at manage_access (visibility) + the unasked guardrail", () => {
		const res = checkSessionToolAccess({
			action: "send",
			requesterSessionKey: REQ,
			targetSessionKey: TARGET,
			visibility: "self",
			a2aPolicy: createAgentToAgentPolicy({ enabled: true, allow: [] }),
		});
		assert.equal(res.allowed, false);
		assert.match(("error" in res ? res.error : ""), /manage_access set \{visibility: "all"\}/);
		assert.match(("error" in res ? res.error : ""), /Do NOT change it unasked/);
	});

	it("A2A gate points at manage_access (a2aEnabled)", () => {
		const res = checkSessionToolAccess({
			action: "send",
			requesterSessionKey: REQ,
			targetSessionKey: TARGET,
			visibility: "all",
			a2aPolicy: createAgentToAgentPolicy({ enabled: false, allow: [] }),
		});
		assert.equal(res.allowed, false);
		assert.match(("error" in res ? res.error : ""), /manage_access set \{a2aEnabled: true\}/);
	});

	it("policy gate explains org-graph edges + manage_access (a2aMode) escape hatch", () => {
		const policy = createAgentToAgentPolicy({ enabled: true, allow: ["main"] });
		const res = checkSessionToolAccess({
			action: "send",
			requesterSessionKey: REQ,
			targetSessionKey: TARGET,
			visibility: "all",
			a2aPolicy: policy,
		});
		assert.equal(res.allowed, false);
		assert.match(("error" in res ? res.error : ""), /manage_access set \{a2aMode: "explicit"\}/);
		assert.match(("error" in res ? res.error : ""), /cross-department lateral is closed/);
	});

	it("an allowed cross-agent send still passes untouched", () => {
		const res = checkSessionToolAccess({
			action: "send",
			requesterSessionKey: REQ,
			targetSessionKey: TARGET,
			visibility: "all",
			a2aPolicy: createAgentToAgentPolicy({ enabled: true, allow: [] }),
		});
		assert.equal(res.allowed, true);
	});
});
