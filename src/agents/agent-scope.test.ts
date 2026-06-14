import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveDefaultAgentId } from "./agent-scope.js";
import type { BrigadeConfig } from "../config/types.js";

describe("resolveDefaultAgentId", () => {
	it("honours an operator-pinned defaults.agentId", () => {
		const cfg = { defaults: { agentId: "cfo" }, agents: { accountant: {}, main: {} } };
		assert.equal(resolveDefaultAgentId(cfg as unknown as BrigadeConfig), "cfo");
	});

	it("trims a pinned id", () => {
		const cfg = { defaults: { agentId: "  cfo  " } };
		assert.equal(resolveDefaultAgentId(cfg as unknown as BrigadeConfig), "cfo");
	});

	it("defaults to main when nothing is pinned — even with an org of agents (regression)", () => {
		// Production 2026-06-13: a 20-agent org made `accountant` (first key) the
		// boot/default agent. main must win over any arbitrary cfg.agents key.
		const cfg = {
			agents: {
				accountant: { org: { department: "finance" } },
				"biz-dev": {},
				ceo: {},
				main: {},
			},
		};
		assert.equal(resolveDefaultAgentId(cfg as unknown as BrigadeConfig), "main");
	});

	it("defaults to main even when there is NO explicit main agent block", () => {
		// `main` is the implicit default (backed by agents.defaults), so it wins
		// even when the only explicit blocks are org agents.
		const cfg = { agents: { accountant: {}, "biz-dev": {} } };
		assert.equal(resolveDefaultAgentId(cfg as unknown as BrigadeConfig), "main");
	});

	it("blank / non-string pin falls through to main", () => {
		assert.equal(resolveDefaultAgentId({ defaults: { agentId: "   " } } as unknown as BrigadeConfig), "main");
		assert.equal(resolveDefaultAgentId({ defaults: { agentId: 42 } } as unknown as BrigadeConfig), "main");
	});

	it("undefined / null config → main", () => {
		assert.equal(resolveDefaultAgentId(undefined), "main");
		assert.equal(resolveDefaultAgentId(null), "main");
	});
});
