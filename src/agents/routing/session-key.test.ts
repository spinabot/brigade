/**
 * dmScope matrix + identityLinks coverage for the session-key builder.
 *
 * Mirrors the upstream reference codebase's `src/routing/session-key.test.ts`
 * shape — table-driven matrix over dmScope × peerKind × accountId × thread.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildAgentPeerSessionKey,
	buildBrigadeMainSessionKey,
	buildGroupHistoryKey,
	classifySessionKeyShape,
	isValidAgentId,
	normalizeAgentId,
	resolveAgentIdFromSessionKey,
	resolveThreadSessionKeys,
	toAgentRequestSessionKey,
	toAgentStoreSessionKey,
} from "./session-key.js";

describe("buildAgentPeerSessionKey — dmScope matrix (direct DM)", () => {
	const peerId = "+15551234567";
	const channel = "whatsapp";
	const accountId = "acc-1";

	it('"main" (default) collapses every DM into the agent main session', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel,
			accountId,
			peerKind: "direct",
			peerId,
		});
		assert.equal(got, "agent:main:main");
	});

	it('explicit "main" matches the default behaviour', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel,
			accountId,
			peerKind: "direct",
			peerId,
			dmScope: "main",
		});
		assert.equal(got, "agent:main:main");
	});

	it('"per-peer" drops the channel, keeps the peer', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel,
			accountId,
			peerKind: "direct",
			peerId,
			dmScope: "per-peer",
		});
		assert.equal(got, "agent:main:direct:+15551234567");
	});

	it('"per-channel-peer" keeps the channel but drops the account', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel,
			accountId,
			peerKind: "direct",
			peerId,
			dmScope: "per-channel-peer",
		});
		assert.equal(got, "agent:main:whatsapp:direct:+15551234567");
	});

	it('"per-account-channel-peer" keeps account + channel + peer', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel,
			accountId,
			peerKind: "direct",
			peerId,
			dmScope: "per-account-channel-peer",
		});
		assert.equal(got, "agent:main:whatsapp:acc-1:direct:+15551234567");
	});

	it('"per-account-channel-peer" without accountId falls back to "default"', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel,
			peerKind: "direct",
			peerId,
			dmScope: "per-account-channel-peer",
		});
		assert.equal(got, "agent:main:whatsapp:default:direct:+15551234567");
	});
});

describe("buildAgentPeerSessionKey — group + channel peers", () => {
	it("group keys ignore dmScope and use channel:group:peerId", () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel: "slack",
			peerKind: "group",
			peerId: "G123",
		});
		assert.equal(got, "agent:main:slack:group:g123");
	});

	it("channel keys ignore dmScope and use channel:channel:peerId", () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel: "discord",
			peerKind: "channel",
			peerId: "C-456",
		});
		assert.equal(got, "agent:main:discord:channel:c-456");
	});

	it('"per-account-channel-peer" injects accountId into the GROUP key', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel: "slack",
			accountId: "team-99",
			peerKind: "group",
			peerId: "G123",
			dmScope: "per-account-channel-peer",
		});
		assert.equal(got, "agent:main:slack:team-99:group:g123");
	});
});

describe("buildAgentPeerSessionKey — identityLinks cross-channel collapse", () => {
	const identityLinks = {
		kartheek: ["whatsapp:+91111", "telegram:222222"],
	};

	it('"per-peer" collapses cross-channel peers to the canonical id', () => {
		const wa = buildAgentPeerSessionKey({
			agentId: "main",
			channel: "whatsapp",
			peerKind: "direct",
			peerId: "+91111",
			identityLinks,
			dmScope: "per-peer",
		});
		const tg = buildAgentPeerSessionKey({
			agentId: "main",
			channel: "telegram",
			peerKind: "direct",
			peerId: "222222",
			identityLinks,
			dmScope: "per-peer",
		});
		assert.equal(wa, "agent:main:direct:kartheek");
		assert.equal(tg, "agent:main:direct:kartheek");
	});

	it('"main" scope ignores identityLinks (every DM collapses anyway)', () => {
		const got = buildAgentPeerSessionKey({
			agentId: "main",
			channel: "whatsapp",
			peerKind: "direct",
			peerId: "+91111",
			identityLinks,
			dmScope: "main",
		});
		assert.equal(got, "agent:main:main");
	});
});

describe("session-key roundtrip helpers", () => {
	it("toAgentStoreSessionKey + toAgentRequestSessionKey roundtrip", () => {
		const store = toAgentStoreSessionKey({
			agentId: "main",
			requestKey: "whatsapp:direct:+91111",
		});
		assert.equal(store, "agent:main:whatsapp:direct:+91111");
		assert.equal(toAgentRequestSessionKey(store), "whatsapp:direct:+91111");
	});

	it("toAgentStoreSessionKey treats empty / 'main' as the main session", () => {
		assert.equal(
			toAgentStoreSessionKey({ agentId: "main", requestKey: "" }),
			"agent:main:main",
		);
		assert.equal(
			toAgentStoreSessionKey({ agentId: "main", requestKey: "main" }),
			"agent:main:main",
		);
	});

	it("buildBrigadeMainSessionKey honours custom mainKey", () => {
		assert.equal(
			buildBrigadeMainSessionKey({ agentId: "main" }),
			"agent:main:main",
		);
		assert.equal(
			buildBrigadeMainSessionKey({ agentId: "ops", mainKey: "primary" }),
			"agent:ops:primary",
		);
	});

	it("resolveAgentIdFromSessionKey extracts the agent id", () => {
		assert.equal(
			resolveAgentIdFromSessionKey("agent:research:whatsapp:direct:+1"),
			"research",
		);
		assert.equal(resolveAgentIdFromSessionKey(""), "main");
		assert.equal(resolveAgentIdFromSessionKey(undefined), "main");
	});

	it("classifySessionKeyShape covers every shape", () => {
		assert.equal(classifySessionKeyShape(""), "missing");
		assert.equal(classifySessionKeyShape("agent:main:main"), "agent");
		assert.equal(classifySessionKeyShape("agent::broken"), "malformed_agent");
		assert.equal(classifySessionKeyShape("main"), "legacy_or_alias");
	});
});

describe("agent-id sanitiser", () => {
	it("isValidAgentId accepts [a-z0-9][a-z0-9_-]{0,63}", () => {
		assert.equal(isValidAgentId("main"), true);
		assert.equal(isValidAgentId("my-research_01"), true);
		assert.equal(isValidAgentId("a".repeat(64)), true);
	});
	it("isValidAgentId rejects long / empty / pathy strings", () => {
		assert.equal(isValidAgentId(""), false);
		assert.equal(isValidAgentId("../etc/passwd"), false);
		assert.equal(isValidAgentId("a".repeat(65)), false);
	});
	it("normalizeAgentId lowercases + replaces invalid runs with '-'", () => {
		assert.equal(normalizeAgentId("MyAgent"), "myagent");
		assert.equal(normalizeAgentId("hi mom!"), "hi-mom");
		assert.equal(normalizeAgentId(""), "main");
	});
});

describe("group history key builder", () => {
	it("includes channel + account + peerKind + peerId", () => {
		assert.equal(
			buildGroupHistoryKey({
				channel: "slack",
				accountId: "team-99",
				peerKind: "group",
				peerId: "G123",
			}),
			"slack:team-99:group:g123",
		);
	});
	it("collapses missing account to 'default'", () => {
		assert.equal(
			buildGroupHistoryKey({
				channel: "telegram",
				peerKind: "channel",
				peerId: "c-1",
			}),
			"telegram:default:channel:c-1",
		);
	});
});

describe("resolveThreadSessionKeys", () => {
	it("appends :thread:<id> when a threadId is provided", () => {
		const got = resolveThreadSessionKeys({
			baseSessionKey: "agent:main:slack:channel:general",
			threadId: "1699999999.0001",
		});
		assert.equal(got.sessionKey, "agent:main:slack:channel:general:thread:1699999999.0001");
	});
	it("returns the base key unchanged when threadId is empty", () => {
		const got = resolveThreadSessionKeys({
			baseSessionKey: "agent:main:slack:channel:general",
			threadId: "",
		});
		assert.equal(got.sessionKey, "agent:main:slack:channel:general");
	});
	it("respects useSuffix=false (thread-flat conversation)", () => {
		const got = resolveThreadSessionKeys({
			baseSessionKey: "agent:main:slack:channel:general",
			threadId: "T-1",
			useSuffix: false,
		});
		assert.equal(got.sessionKey, "agent:main:slack:channel:general");
	});
});
