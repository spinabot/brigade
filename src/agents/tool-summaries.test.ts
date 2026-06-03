import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BRIGADE_TOOL_SUMMARIES, resolveToolSummary } from "./tool-summaries.js";

describe("BRIGADE_TOOL_SUMMARIES — wake-word coverage", () => {
	// Tool summaries land in the `## Tooling` block of the system prompt.
	// Mirrors the reference codebase's terse one-liners — the structured
	// behaviour (no inline catalog → must call the tool) does the steering
	// work; the catalog is just the menu.

	it("agents_list summary steers the model to ALWAYS call (enumerate-every-agent contract)", () => {
		const s = resolveToolSummary("agents_list");
		assert.ok(s, "agents_list must have a summary");
		assert.match(s!, /EVERY configured Brigade agent/);
		assert.match(s!, /canSpawn\/canSend/);
		assert.match(s!, /don't enumerate agents from memory/);
	});

	it("manage_agent + manage_skill are advertised (mutation surface)", () => {
		assert.ok(resolveToolSummary("manage_agent"));
		assert.ok(resolveToolSummary("manage_skill"));
		assert.match(resolveToolSummary("manage_agent")!, /Owner-only/);
		assert.match(resolveToolSummary("manage_skill")!, /Owner-only/);
	});

	it("session + spawn surface is advertised (delegation / sub-agents)", () => {
		assert.ok(resolveToolSummary("sessions_list"));
		assert.ok(resolveToolSummary("sessions_send"));
		assert.ok(resolveToolSummary("sessions_history"));
		assert.ok(resolveToolSummary("sessions_spawn"));
		assert.ok(resolveToolSummary("subagents"));
		assert.ok(resolveToolSummary("spawn_agent"));
		assert.ok(resolveToolSummary("spawn_agents"));
	});

	it("channel + cron tools are advertised", () => {
		assert.ok(resolveToolSummary("send_message"));
		assert.ok(resolveToolSummary("cron"));
	});

	it("recall_memory summary scopes recall away from live inventory", () => {
		// Tightened from the old generic "search durable memory" — the new
		// summary explicitly says NOT for live inventory, matching the
		// MEMORY_GUIDANCE block + the agents_list wake-word.
		const s = resolveToolSummary("recall_memory");
		assert.ok(s);
		assert.match(s!, /remembered preferences, decisions, people, dates, or todos/i);
		assert.match(s!, /NOT for live inventory/i);
		assert.match(s!, /agents_list/);
	});

	it("write_memory has a summary (was a bare-name renderer regression)", () => {
		const s = resolveToolSummary("write_memory");
		assert.ok(s);
		assert.match(s!, /durable, declarative fact/);
	});

	it("unknown tool names fall through to undefined (renderer emits bare line)", () => {
		assert.equal(resolveToolSummary("not_a_real_tool"), undefined);
	});

	it("normalises casing on lookup", () => {
		// The renderer can be called with any casing — the lookup must
		// case-fold so a Pi-surfaced `Read` finds the summary too.
		assert.equal(resolveToolSummary("READ"), BRIGADE_TOOL_SUMMARIES.read);
		assert.equal(resolveToolSummary("Agents_List"), BRIGADE_TOOL_SUMMARIES.agents_list);
	});
});
