/**
 * Tests for the in-channel `/agent <id>` / `/agents` / `/whoami` slash
 * commands.
 *
 * Each test stamps a brigade.json into an isolated state dir (via
 * `BRIGADE_STATE_DIR`), invokes the command's handler with a synthesised
 * `ChannelCommandContext`, and verifies the on-disk binding shape +
 * confirmation string.
 *
 * The handlers go through `mutateConfigAtomic` for persistence, which
 * reads + writes the same `brigade.json`, so the assertions match the
 * literal on-disk JSON shape after each command runs.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetConfigParseCacheForTests } from "../../config/io.js";
import { loadConfig } from "../../core/config.js";
import { buildAgentSwitchCommands } from "./agent-switch-command.js";
import type { ChannelCommandContext } from "../extensions/types.js";
import { BRIGADE_FOOTER_RULES } from "../org/pride-taunts.js";

let stateDir: string;
let prevStateDir: string | undefined;

function writeConfig(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8")) as Record<string, unknown>;
}

let prevMode: string | undefined;
let prevConvexUrl: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-agentswitch-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	// Hermeticity: a stray BRIGADE_MODE/BRIGADE_CONVEX_URL in the dev shell
	// would make peekConvexMode see convex (no context, no tmpdir sentinel)
	// and the config writer fail closed. Same isolation as boot.test.ts.
	prevMode = process.env.BRIGADE_MODE;
	prevConvexUrl = process.env.BRIGADE_CONVEX_URL;
	delete process.env.BRIGADE_MODE;
	delete process.env.BRIGADE_CONVEX_URL;
	__resetConfigParseCacheForTests();
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	if (prevMode === undefined) delete process.env.BRIGADE_MODE;
	else process.env.BRIGADE_MODE = prevMode;
	if (prevConvexUrl === undefined) delete process.env.BRIGADE_CONVEX_URL;
	else process.env.BRIGADE_CONVEX_URL = prevConvexUrl;
	rmSync(stateDir, { recursive: true, force: true });
	__resetConfigParseCacheForTests();
});

/** Build a default ChannelCommandContext that mirrors a WhatsApp DM. */
function makeCtx(
	args: string,
	overrides: Partial<ChannelCommandContext> = {},
): ChannelCommandContext {
	return {
		channel: overrides.channel ?? "whatsapp",
		conversationId: overrides.conversationId ?? "+12025550100",
		from: overrides.from ?? "+12025550100",
		fromName: overrides.fromName ?? "Test User",
		args,
		config: overrides.config ?? loadConfig(),
		accountId: overrides.accountId ?? "default",
		isGroup: overrides.isGroup ?? false,
	};
}

async function runCommand(
	name: "agent" | "agents" | "whoami" | "org",
	args: string,
	ctxOverrides: Partial<ChannelCommandContext> = {},
): Promise<string> {
	const commands = buildAgentSwitchCommands();
	const cmd = commands.find((c) => c.name === name);
	assert.ok(cmd, `command ${name} not found`);
	const ctx = makeCtx(args, ctxOverrides);
	const out = await cmd.handler(ctx);
	return typeof out === "string" ? out : "";
}

describe("/agent <id> — pin path", () => {
	it("rejects empty args with a usage hint", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agent", "");
		assert.match(out, /Usage:/);
	});

	it("rejects an unknown agent id", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agent", "finance");
		assert.match(out, /Unknown agent "finance"/);
		assert.match(out, /Crew: main, ops/);
	});

	it("rejects a multi-token / non-simple agent id", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agent", "ops finance evening");
		assert.match(out, /Usage:/);
	});

	it("pins a direct DM peer to a known agent", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agent", "ops");
		assert.match(out, /Pinned \+12025550100 → agent:ops\. Tier: binding\.peer\./);

		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: unknown[] }).entries;
		assert.equal(entries.length, 1);
		const binding = entries[0] as {
			agentId: string;
			match: {
				channel: string;
				accountId: string;
				peer: { kind: string; id: string };
				boundBy: string;
				boundAt: string;
				source: string;
			};
		};
		assert.equal(binding.agentId, "ops");
		assert.equal(binding.match.channel, "whatsapp");
		assert.equal(binding.match.accountId, "default");
		assert.equal(binding.match.peer.kind, "direct");
		assert.equal(binding.match.peer.id, "+12025550100");
		assert.equal(binding.match.boundBy, "+12025550100");
		assert.equal(binding.match.source, "channel-command");
		assert.ok(binding.match.boundAt);
	});

	it("pins a group peer with peer.kind=group when isGroup=true", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agent", "ops", {
			from: "12025550100@g.us",
			conversationId: "12025550100@g.us",
			isGroup: true,
		});
		assert.match(out, /Pinned group:12025550100@g\.us → agent:ops/);

		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: unknown[] }).entries;
		const binding = entries[0] as { match: { peer: { kind: string } } };
		assert.equal(binding.match.peer.kind, "group");
	});

	it("refuses to override an existing pin owned by another agent without --force", async () => {
		writeConfig({
			agents: { main: {}, ops: {}, research: {} },
			bindings: {
				entries: [
					{
						agentId: "research",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		const out = await runCommand("agent", "ops");
		assert.match(out, /already pinned to agent:research/);
		assert.match(out, /--force/);

		// On-disk binding must NOT have changed.
		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: { agentId: string }[] }).entries;
		assert.equal(entries[0]?.agentId, "research");
	});

	it("overrides an existing pin when --force is supplied", async () => {
		writeConfig({
			agents: { main: {}, ops: {}, research: {} },
			bindings: {
				entries: [
					{
						agentId: "research",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		const out = await runCommand("agent", "ops --force");
		assert.match(out, /Pinned \+12025550100 → agent:ops/);
		assert.match(out, /overrode previous pin to agent:research/);

		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: { agentId: string }[] }).entries;
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.agentId, "ops");
	});

	it("survives a gateway restart — binding persists in brigade.json", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		await runCommand("agent", "ops");

		// Simulate gateway restart: re-read brigade.json from disk.
		__resetConfigParseCacheForTests();
		const reloaded = loadConfig();
		const entries = reloaded.bindings?.entries ?? [];
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.agentId, "ops");
		assert.equal(entries[0]?.match?.peer?.id, "+12025550100");
	});
});

describe("/agent main — reset path", () => {
	it("clears an existing peer pin", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			bindings: {
				entries: [
					{
						agentId: "ops",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		const out = await runCommand("agent", "main");
		assert.match(out, /Reset — future messages from \+12025550100 route to the default crew \(main\)/);

		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: unknown[] }).entries;
		assert.equal(entries.length, 0);
	});

	it("reports a no-op when no pin exists", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agent", "main");
		assert.match(out, /No pin to clear/);
	});

	it("treats the configured default agent id as the reset keyword", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			defaults: { agentId: "main" },
			bindings: {
				entries: [
					{
						agentId: "ops",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		// `main` is the resolved default agent — should clear the pin.
		const out = await runCommand("agent", "main");
		assert.match(out, /Reset/);
		const cfg = readConfig();
		assert.equal((cfg.bindings as { entries: unknown[] }).entries.length, 0);
	});
});

describe("/agents — list peer pins on this channel", () => {
	it("reports default-only when no pins exist", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("agents", "");
		assert.match(out, /No pins on whatsapp\./);
		assert.match(out, /default: agent:main/);
	});

	it("lists pins on this channel + marks the sender's own pin with '*'", async () => {
		writeConfig({
			agents: { main: {}, ops: {}, research: {} },
			bindings: {
				entries: [
					{
						agentId: "ops",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
							boundBy: "+12025550100",
							boundAt: "2026-06-04T11:23:00.000Z",
							source: "channel-command",
						},
					},
					{
						agentId: "research",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550200" },
						},
					},
					{
						agentId: "main",
						match: {
							channel: "telegram",
							accountId: "default",
							peer: { kind: "direct", id: "@somebody" },
						},
					},
				],
			},
		});
		const out = await runCommand("agents", "");
		assert.match(out, /Pins on whatsapp:/);
		// Both whatsapp pins surface
		assert.match(out, /agent:ops/);
		assert.match(out, /agent:research/);
		// The sender's own pin is marked with '*'
		assert.match(out, /\* agent:ops[^]*peer=direct:\+12025550100/);
		// Telegram pin must NOT appear
		assert.doesNotMatch(out, /telegram/);
		// Provenance surfaces
		assert.match(out, /pinned by \+12025550100/);
		assert.match(out, /2026-06-04T11:23:00\.000Z/);
		// Default agent renders
		assert.match(out, /default: agent:main/);
	});
});

describe("/whoami — debug aid", () => {
	it("reports the default agent + tier=default when no pin exists", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("whoami", "");
		assert.match(out, /Agent:\s+main/);
		assert.match(out, /Tier:\s+default/);
	});

	it("reports the pinned agent + tier=binding.peer after /agent <id>", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			bindings: {
				entries: [
					{
						agentId: "ops",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		const out = await runCommand("whoami", "");
		assert.match(out, /Peer:\s+\+12025550100/);
		assert.match(out, /Agent:\s+ops/);
		assert.match(out, /Tier:\s+binding\.peer/);
	});
});

describe("/org channel command — Pride chart over channels", () => {
	it("/org appears in the bundled command set", () => {
		const commands = buildAgentSwitchCommands();
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("org"), "buildAgentSwitchCommands must surface /org");
	});

	it("/org with cfg.org absent → channel reply has the redirect (not an empty chart)", async () => {
		writeConfig({ agents: { main: {}, ops: {} } });
		const out = await runCommand("org", "");
		// Redirect surfaces verbatim — points at `brigade org init` AND `/agents`.
		assert.match(out, /brigade org init/);
		assert.match(out, /\/agents/);
		// Specifically must NOT be a chart frame — no triple-backtick / chart markers.
		assert.doesNotMatch(out, /Higher Office/);
		assert.doesNotMatch(out, /^```/);
	});

	it("/org with cfg.org present → channel reply contains the Brigade footer rule + is wrapped in triple-backtick", async () => {
		writeConfig({
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
			},
			org: {
				topOrder: "main",
				a2a: { mode: "derived" },
				departmentHeads: { engineering: "eng_lead" },
			},
		});
		const out = await runCommand("org", "");
		// Triple-backtick wrap for mobile monospace rendering.
		assert.match(out, /^```/);
		assert.match(out, /```$/);
		// Brigade footer rule survives the channel render. Bank rotates per-call,
		// so assert ANY footer rule from the bank rather than a frozen literal.
		assert.ok(
			BRIGADE_FOOTER_RULES.some((f) => out.includes(f)),
			"chart must contain a footer rule from the bank",
		);
		// Both Higher Office + Departments sections render.
		assert.match(out, /Higher Office/);
		assert.match(out, /Departments/);
	});

	it("/org <agent-id> filters the chart to the subtree", async () => {
		writeConfig({
			agents: {
				main: {
					org: { department: "exec", reportsTo: null, role: "Chief of Staff" },
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
				a2a: { mode: "derived" },
			},
		});
		const out = await runCommand("org", "eng_lead");
		assert.match(out, /eng_lead/);
		assert.match(out, /eng_ic/);
		// ops_lead is NOT in the engineering subtree.
		assert.doesNotMatch(out, /ops_lead/);
	});

	it("/org --explain <from> <to> returns a plain-text explain (no chart wrapper)", async () => {
		writeConfig({
			agents: {
				main: {
					org: { department: "exec", reportsTo: null, role: "Chief of Staff" },
				},
				eng_lead: {
					org: {
						department: "engineering",
						reportsTo: "main",
						role: "Engineering Lead",
					},
				},
			},
			org: { topOrder: "main", a2a: { mode: "derived" } },
		});
		const out = await runCommand("org", "--explain main eng_lead");
		assert.match(out, /main → eng_lead: ALLOWED/);
		// Explain is NOT wrapped in backticks (it's prose, not a chart).
		assert.doesNotMatch(out, /^```/);
	});
});

describe("/agent: route resolution prefers binding.peer over default after pin", () => {
	it("the just-pinned agent wins tier 1 over the configured default", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			defaults: { agentId: "main" },
		});
		await runCommand("agent", "ops");

		// Re-read config + re-resolve route to confirm tier=binding.peer wins.
		__resetConfigParseCacheForTests();
		const cfg = loadConfig();
		const { resolveAgentRoute } = await import("../routing/resolve-route.js");
		const route = resolveAgentRoute({
			cfg,
			channel: "whatsapp",
			accountId: "default",
			peer: { kind: "direct", id: "+12025550100" },
		});
		assert.equal(route.agentId, "ops");
		assert.equal(route.matchedBy, "binding.peer");
	});

	it("/agent main clears the pin → resolver falls back to the default agent", async () => {
		writeConfig({
			agents: { main: {}, ops: {} },
			defaults: { agentId: "main" },
			bindings: {
				entries: [
					{
						agentId: "ops",
						match: {
							channel: "whatsapp",
							accountId: "default",
							peer: { kind: "direct", id: "+12025550100" },
						},
					},
				],
			},
		});
		await runCommand("agent", "main");

		__resetConfigParseCacheForTests();
		const cfg = loadConfig();
		const { resolveAgentRoute } = await import("../routing/resolve-route.js");
		const route = resolveAgentRoute({
			cfg,
			channel: "whatsapp",
			accountId: "default",
			peer: { kind: "direct", id: "+12025550100" },
		});
		assert.equal(route.agentId, "main");
		assert.equal(route.matchedBy, "default");
	});
});
