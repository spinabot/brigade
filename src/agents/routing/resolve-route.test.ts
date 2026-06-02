/**
 * 8-tier precedence tests for `resolveAgentRoute`.
 *
 * Mirrors the upstream reference codebase's `src/routing/resolve-route.test.ts`
 * shape — each tier is asserted to win over every lower tier. Also covers
 * the channel-default Tier-7.5 fallback the upstream lift introduced.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/types.js";
import { resolveAgentRoute } from "./resolve-route.js";

function cfg(entries: BrigadeConfig["bindings"] extends infer T ? T : never): BrigadeConfig {
	return {
		defaults: { agentId: "main" },
		agents: { list: [{ id: "main" }, { id: "ops" }, { id: "alice" }, { id: "bob" }, { id: "charlie" }] },
		bindings: entries,
	} as unknown as BrigadeConfig;
}

describe("resolveAgentRoute — tier precedence (8-tier waterfall)", () => {
	it("default fallback when no bindings exist", () => {
		const route = resolveAgentRoute({
			cfg: {} as BrigadeConfig,
			channel: "whatsapp",
			accountId: null,
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.agentId, "main");
		assert.equal(route.matchedBy, "default");
		assert.equal(route.sessionKey, "agent:main:main");
	});

	it("Tier 1: binding.peer (exact peer) beats binding.channel (wildcard)", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "ops", match: { channel: "whatsapp", accountId: "*" } },
					{
						agentId: "alice",
						match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } },
					},
				],
			}),
			channel: "whatsapp",
			accountId: null,
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.peer");
	});

	it("Tier 2: parent-peer match (thread inheritance) when peer doesn't match", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{
						agentId: "alice",
						match: { channel: "slack", peer: { kind: "channel", id: "C-parent" } },
					},
				],
			}),
			channel: "slack",
			accountId: null,
			peer: { kind: "channel", id: "C-thread-99" },
			parentPeer: { kind: "channel", id: "C-parent" },
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.peer.parent");
	});

	it("Tier 3: peer-wildcard ('*' id) beats binding.guild + binding.account", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "ops", match: { channel: "discord", accountId: "*" } },
					{ agentId: "alice", match: { channel: "discord", guildId: "g-1", accountId: "*" } },
					{
						agentId: "bob",
						match: {
							channel: "discord",
							accountId: "*",
							peer: { kind: "direct", id: "*" },
						},
					},
				],
			}),
			channel: "discord",
			accountId: "acc-1",
			guildId: "g-1",
			peer: { kind: "direct", id: "user-1" },
		});
		assert.equal(route.agentId, "bob");
		assert.equal(route.matchedBy, "binding.peer.wildcard");
	});

	it("Tier 4: guild + roles beats guild-only when member has the role", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "ops", match: { channel: "discord", guildId: "g-1" } },
					{
						agentId: "alice",
						match: { channel: "discord", guildId: "g-1", roles: ["mod"] },
					},
				],
			}),
			channel: "discord",
			accountId: null,
			guildId: "g-1",
			memberRoleIds: ["mod"],
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.guild+roles");
	});

	it("Tier 5: guild-only matches when guild+roles tier doesn't apply", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "alice", match: { channel: "discord", guildId: "g-1" } },
				],
			}),
			channel: "discord",
			accountId: null,
			guildId: "g-1",
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.guild");
	});

	it("Tier 6: team (Slack) beats account + channel", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "ops", match: { channel: "slack", accountId: "*" } },
					{ agentId: "alice", match: { channel: "slack", accountId: "*", teamId: "T1" } },
				],
			}),
			channel: "slack",
			accountId: null,
			teamId: "T1",
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.team");
	});

	it("Tier 7: account (explicit) beats channel-wildcard", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "ops", match: { channel: "whatsapp", accountId: "*" } },
					{ agentId: "alice", match: { channel: "whatsapp", accountId: "acc-1" } },
				],
			}),
			channel: "whatsapp",
			accountId: "acc-1",
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.account");
	});

	it("Tier 8: channel-wildcard (accountId: '*') when no narrower binding matches", () => {
		const route = resolveAgentRoute({
			cfg: cfg({
				entries: [
					{ agentId: "ops", match: { channel: "telegram", accountId: "*" } },
				],
			}),
			channel: "telegram",
			accountId: null,
		});
		assert.equal(route.agentId, "ops");
		assert.equal(route.matchedBy, "binding.channel");
	});
});

describe("resolveAgentRoute — channel.defaultAgentId (Tier 7.5)", () => {
	it("returns channels.<id>.defaultAgentId when no binding matches", () => {
		const route = resolveAgentRoute({
			cfg: {
				defaults: { agentId: "main" },
				agents: { list: [{ id: "main" }, { id: "charlie" }] },
				channels: { telegram: { defaultAgentId: "charlie" } },
			} as unknown as BrigadeConfig,
			channel: "telegram",
			accountId: null,
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.agentId, "charlie");
		assert.equal(route.matchedBy, "default");
	});

	it("binding.peer beats channel.defaultAgentId", () => {
		const route = resolveAgentRoute({
			cfg: {
				defaults: { agentId: "main" },
				agents: { list: [{ id: "main" }, { id: "alice" }, { id: "charlie" }] },
				channels: { telegram: { defaultAgentId: "charlie" } },
				bindings: {
					entries: [
						{
							agentId: "alice",
							match: { channel: "telegram", peer: { kind: "direct", id: "+1" } },
						},
					],
				},
			} as unknown as BrigadeConfig,
			channel: "telegram",
			accountId: null,
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.agentId, "alice");
		assert.equal(route.matchedBy, "binding.peer");
	});
});

describe("resolveAgentRoute — session key derives from resolved route + dmScope", () => {
	it('"main" dmScope (default) returns the agent main session', () => {
		const route = resolveAgentRoute({
			cfg: {
				defaults: { agentId: "main" },
				agents: { list: [{ id: "main" }] },
			} as unknown as BrigadeConfig,
			channel: "whatsapp",
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.sessionKey, "agent:main:main");
		assert.equal(route.mainSessionKey, "agent:main:main");
		assert.equal(route.lastRoutePolicy, "main");
	});

	it('"per-peer" dmScope produces per-peer session keys', () => {
		const route = resolveAgentRoute({
			cfg: {
				defaults: { agentId: "main" },
				agents: { list: [{ id: "main" }] },
				session: { dmScope: "per-peer" },
			} as unknown as BrigadeConfig,
			channel: "whatsapp",
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.sessionKey, "agent:main:direct:+1");
		assert.equal(route.lastRoutePolicy, "session");
	});

	it('"per-channel-peer" dmScope produces per-(channel,peer) session keys', () => {
		const route = resolveAgentRoute({
			cfg: {
				defaults: { agentId: "main" },
				agents: { list: [{ id: "main" }] },
				session: { dmScope: "per-channel-peer" },
			} as unknown as BrigadeConfig,
			channel: "telegram",
			peer: { kind: "direct", id: "+1" },
		});
		assert.equal(route.sessionKey, "agent:main:telegram:direct:+1");
	});
});
