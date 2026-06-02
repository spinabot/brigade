/**
 * dmScope collapse-risk detection tests.
 *
 * The default `dmScope: "main"` silently shares transcript + memory across
 * peers. The boot-time scanner warns when bindings reference >= 2 peers on
 * any one channel without the operator picking an explicit scope.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/types.js";
import {
	detectDmScopeCollapseRisk,
	formatDmScopeWarning,
} from "./dm-scope-warning.js";

describe("detectDmScopeCollapseRisk — no warning paths", () => {
	it("returns [] when there are no bindings", () => {
		assert.deepEqual(detectDmScopeCollapseRisk({} as BrigadeConfig), []);
		assert.deepEqual(detectDmScopeCollapseRisk(null), []);
		assert.deepEqual(detectDmScopeCollapseRisk(undefined), []);
	});

	it("returns [] when the operator picked an explicit dmScope", () => {
		const cfg = {
			session: { dmScope: "per-peer" },
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+2" } } },
				],
			},
		} as unknown as BrigadeConfig;
		assert.deepEqual(detectDmScopeCollapseRisk(cfg), []);
	});

	it("returns [] when only one peer is bound on the channel", () => {
		const cfg = {
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
				],
			},
		} as unknown as BrigadeConfig;
		assert.deepEqual(detectDmScopeCollapseRisk(cfg), []);
	});

	it("ignores '*' wildcards when counting peers", () => {
		const cfg = {
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "*" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
				],
			},
		} as unknown as BrigadeConfig;
		assert.deepEqual(detectDmScopeCollapseRisk(cfg), []);
	});
});

describe("detectDmScopeCollapseRisk — warning paths", () => {
	it("warns when >= 2 distinct peers are bound on one channel without dmScope", () => {
		const cfg = {
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+2" } } },
				],
			},
		} as unknown as BrigadeConfig;
		const got = detectDmScopeCollapseRisk(cfg);
		assert.equal(got.length, 1);
		assert.equal(got[0]!.channel, "whatsapp");
		assert.equal(got[0]!.peerCount, 2);
	});

	it("emits one warning per affected channel", () => {
		const cfg = {
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+2" } } },
					{ agentId: "carol", match: { channel: "telegram", peer: { kind: "direct", id: "100" } } },
					{ agentId: "dave", match: { channel: "telegram", peer: { kind: "direct", id: "200" } } },
				],
			},
		} as unknown as BrigadeConfig;
		const got = detectDmScopeCollapseRisk(cfg);
		const channels = got.map((w) => w.channel).sort();
		assert.deepEqual(channels, ["telegram", "whatsapp"]);
	});

	it("samples at most 3 peers in the warning record", () => {
		const cfg = {
			bindings: {
				entries: Array.from({ length: 5 }, (_, i) => ({
					agentId: `a${i}`,
					match: { channel: "whatsapp", peer: { kind: "direct", id: `+${i + 1}` } },
				})),
			},
		} as unknown as BrigadeConfig;
		const got = detectDmScopeCollapseRisk(cfg);
		assert.equal(got.length, 1);
		assert.equal(got[0]!.peerCount, 5);
		assert.equal(got[0]!.samplePeers.length, 3);
	});

	it("treats empty-string and whitespace dmScope as unset", () => {
		const cfg = {
			session: { dmScope: "  " },
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+2" } } },
				],
			},
		} as unknown as BrigadeConfig;
		assert.equal(detectDmScopeCollapseRisk(cfg).length, 1);
	});
});

describe("formatDmScopeWarning", () => {
	it("produces a one-line message mentioning the channel + remediation", () => {
		const msg = formatDmScopeWarning({
			channel: "whatsapp",
			peerCount: 2,
			samplePeers: ["+1", "+2"],
		});
		assert.match(msg, /whatsapp/);
		assert.match(msg, /per-peer/);
		assert.match(msg, /brigade\.json/);
	});
});
