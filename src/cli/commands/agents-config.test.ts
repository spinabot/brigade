import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";

let stateDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-agcfg-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("agents-config: listAgentEntries", () => {
	it("returns empty when cfg.agents is missing", async () => {
		const { listAgentEntries } = await import("./agents-config.js");
		assert.deepEqual(listAgentEntries({}), []);
		assert.deepEqual(listAgentEntries(null), []);
	});

	it("skips the reserved 'defaults' key", async () => {
		const { listAgentEntries } = await import("./agents-config.js");
		const cfg: BrigadeConfig = {
			agents: {
				defaults: { provider: "anthropic" },
				main: { name: "Main" },
				scout: { name: "Scout" },
			} as BrigadeConfig["agents"],
		};
		const ids = listAgentEntries(cfg).map((e) => e.id);
		assert.deepEqual(ids.sort(), ["main", "scout"]);
	});
});

describe("agents-config: applyAgentConfig", () => {
	it("inserts a brand-new entry", async () => {
		const { applyAgentConfig } = await import("./agents-config.js");
		const next = applyAgentConfig(
			{ agents: {} },
			{ agentId: "scout", name: "Scout", workspace: "/tmp/scout-ws" },
		);
		const agents = next.agents as Record<string, { name?: string; workspace?: string }>;
		assert.equal(agents.scout?.name, "Scout");
		assert.equal(agents.scout?.workspace, "/tmp/scout-ws");
	});

	it("deep-merges identity on an existing entry", async () => {
		const { applyAgentConfig } = await import("./agents-config.js");
		const cfg: BrigadeConfig = {
			agents: {
				scout: { name: "Scout", identity: { name: "Scout", emoji: "🛡️" } },
			} as BrigadeConfig["agents"],
		};
		const next = applyAgentConfig(cfg, {
			agentId: "scout",
			identity: { theme: "warm" },
		});
		const agents = next.agents as Record<string, { identity?: Record<string, string> }>;
		assert.equal(agents.scout?.identity?.name, "Scout");
		assert.equal(agents.scout?.identity?.emoji, "🛡️");
		assert.equal(agents.scout?.identity?.theme, "warm");
	});

	it("preserves the default agent when upserting a different id into an empty map", async () => {
		const { applyAgentConfig, DEFAULT_AGENT_ID } = await import("./agents-config.js");
		const next = applyAgentConfig({ agents: {} }, { agentId: "scout", name: "Scout" });
		const agents = next.agents as Record<string, unknown>;
		assert.ok(DEFAULT_AGENT_ID in agents, "default agent stub should exist");
		assert.ok("scout" in agents, "scout entry should exist");
	});

	it("does NOT create a default stub when the upserted id IS the default", async () => {
		const { applyAgentConfig, DEFAULT_AGENT_ID } = await import("./agents-config.js");
		const next = applyAgentConfig({ agents: {} }, { agentId: DEFAULT_AGENT_ID, name: "Main" });
		const agents = next.agents as Record<string, unknown>;
		assert.equal(Object.keys(agents).length, 1);
	});

	it("wraps a bare model string as {primary} so server boot can read entry.model.primary", async () => {
		const { applyAgentConfig } = await import("./agents-config.js");
		const next = applyAgentConfig({ agents: {} }, { agentId: "foo", model: "gpt-5" });
		const agents = next.agents as Record<string, { model?: { primary?: string } }>;
		assert.deepEqual(agents.foo?.model, { primary: "gpt-5" });
	});

	it("passes an existing model object through unchanged", async () => {
		const { applyAgentConfig } = await import("./agents-config.js");
		const next = applyAgentConfig(
			{ agents: {} },
			{ agentId: "foo", model: { primary: "claude-opus-4-7", fallbacks: ["gpt-5"] } },
		);
		const agents = next.agents as Record<
			string,
			{ model?: { primary?: string; fallbacks?: string[] } }
		>;
		assert.equal(agents.foo?.model?.primary, "claude-opus-4-7");
		assert.deepEqual(agents.foo?.model?.fallbacks, ["gpt-5"]);
	});
});

describe("agents-config: pruneAgentConfig", () => {
	it("removes the entry plus its bindings", async () => {
		const { pruneAgentConfig } = await import("./agents-config.js");
		const cfg: BrigadeConfig = {
			agents: {
				main: { name: "Main" },
				scout: { name: "Scout" },
			} as BrigadeConfig["agents"],
			bindings: {
				entries: [
					{ agentId: "main", match: { channel: "whatsapp" } },
					{ agentId: "scout", match: { channel: "discord" } },
					{ agentId: "scout", match: { channel: "slack", accountId: "team-a" } },
				],
			},
		};
		const result = pruneAgentConfig(cfg, "scout");
		const agents = result.config.agents as Record<string, unknown>;
		assert.ok(!("scout" in agents), "scout should be removed");
		assert.ok("main" in agents, "main should remain");
		assert.equal(result.removedBindings, 2);
		const remaining = result.config.bindings?.entries ?? [];
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0]?.agentId, "main");
	});

	it("removes agentToAgent.allow pairs where the id appears on either side", async () => {
		const { pruneAgentConfig } = await import("./agents-config.js");
		const cfg: BrigadeConfig = {
			agents: {
				main: { name: "Main" },
				scout: { name: "Scout" },
			} as BrigadeConfig["agents"],
			session: {
				agentToAgent: {
					allow: [
						{ from: "main", to: "scout" },
						{ from: "scout", to: "main" },
						{ from: "main", to: "main" },
					],
				},
			},
		};
		const result = pruneAgentConfig(cfg, "scout");
		assert.equal(result.removedAllow, 2);
		const allow =
			(result.config.session?.agentToAgent as { allow?: unknown[] } | undefined)?.allow ?? [];
		assert.equal(allow.length, 1);
	});

	it("preserves wildcard allow pairs on delete", async () => {
		// `{ from: "*", to: "*" }` is the canonical wide-open seed written by
		// `applyAutoEnableA2AOnAgentCreate`. Deleting any agent must NOT remove
		// it — wildcards stay regardless of which id is being deleted.
		const { pruneAgentConfig } = await import("./agents-config.js");
		const cfg: BrigadeConfig = {
			agents: {
				main: { name: "Main" },
				scout: { name: "Scout" },
			} as BrigadeConfig["agents"],
			session: {
				agentToAgent: {
					allow: [
						{ from: "*", to: "*" },
						{ from: "main", to: "scout" },
						{ from: "scout", to: "*" },
						{ from: "*", to: "scout" },
					],
				},
			},
		};
		const result = pruneAgentConfig(cfg, "scout");
		const allow =
			((result.config.session?.agentToAgent as { allow?: Array<{ from: string; to: string }> } | undefined)
				?.allow) ?? [];
		// The two pairs naming "scout" on the non-wildcard side are gone; the
		// pure-wildcard pair survives.
		assert.deepEqual(allow, [{ from: "*", to: "*" }]);
		assert.equal(result.removedAllow, 3);
	});
});

describe("agents-config: buildAgentSummaries", () => {
	it("returns the default agent stub when no agents are configured", async () => {
		const { buildAgentSummaries, DEFAULT_AGENT_ID } = await import("./agents-config.js");
		const summaries = buildAgentSummaries({ agents: {} });
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0]?.id, DEFAULT_AGENT_ID);
		assert.equal(summaries[0]?.isDefault, true);
	});

	it("counts bindings per agent", async () => {
		const { buildAgentSummaries } = await import("./agents-config.js");
		const cfg: BrigadeConfig = {
			agents: {
				main: { name: "Main" },
				scout: { name: "Scout" },
			} as BrigadeConfig["agents"],
			bindings: {
				entries: [
					{ agentId: "main", match: { channel: "whatsapp" } },
					{ agentId: "main", match: { channel: "discord" } },
					{ agentId: "scout", match: { channel: "slack" } },
				],
			},
		};
		const summaries = buildAgentSummaries(cfg);
		const main = summaries.find((s) => s.id === "main");
		const scout = summaries.find((s) => s.id === "scout");
		assert.equal(main?.bindings, 2);
		assert.equal(scout?.bindings, 1);
	});

	it("reads identity from IDENTITY.md when present", async () => {
		const { buildAgentSummaries } = await import("./agents-config.js");
		// Default agent uses <stateDir>/workspace/. Seed an IDENTITY.md there.
		const workspace = join(stateDir, "workspace");
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			join(workspace, "IDENTITY.md"),
			"# IDENTITY\n- Name: TestPersona\n- Emoji: 🦁\n",
		);
		const summaries = buildAgentSummaries({ agents: {} });
		assert.equal(summaries[0]?.identityName, "TestPersona");
		assert.equal(summaries[0]?.identityEmoji, "🦁");
		assert.equal(summaries[0]?.identitySource, "identity");
	});
});

describe("agents-config: parseIdentityMarkdown", () => {
	it("extracts the standard fields", async () => {
		const { parseIdentityMarkdown } = await import("./agents-config.js");
		const md = [
			"# IDENTITY",
			"- Name: Sentinel",
			"- Emoji: 🦁",
			"- Theme: warm-and-sharp",
			"- Creature: lion",
			"- Vibe: alert",
			"- Avatar: ./avatar.png",
		].join("\n");
		const id = parseIdentityMarkdown(md);
		assert.equal(id.name, "Sentinel");
		assert.equal(id.emoji, "🦁");
		assert.equal(id.theme, "warm-and-sharp");
		assert.equal(id.creature, "lion");
		assert.equal(id.vibe, "alert");
		assert.equal(id.avatar, "./avatar.png");
	});

	it("skips known placeholder values", async () => {
		const { parseIdentityMarkdown } = await import("./agents-config.js");
		const md = "- Name: pick something you like\n- Emoji: 🦁\n";
		const id = parseIdentityMarkdown(md);
		assert.equal(id.name, undefined);
		assert.equal(id.emoji, "🦁");
	});
});
