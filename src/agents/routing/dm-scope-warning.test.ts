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

	it("still warns when only one peer is bound on the channel (Wave N3 — bug #5)", () => {
		// Wave N3 widened the heuristic: any wired channel + unset dmScope
		// is risky because the moment a second peer messages the channel,
		// both transcripts merge silently into `main`. We surface the
		// remediation now, not after the merge happens.
		const cfg = {
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
				],
			},
		} as unknown as BrigadeConfig;
		const got = detectDmScopeCollapseRisk(cfg);
		assert.equal(got.length, 1);
		assert.equal(got[0]!.kind, "unset-with-channel-bindings");
	});

	it("warns on '*' wildcard channel bindings too (channel is wired)", () => {
		// Wildcards prove the channel is wired even though there's no
		// distinct second peer to count. Same remediation, different kind.
		const cfg = {
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "*" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
				],
			},
		} as unknown as BrigadeConfig;
		const got = detectDmScopeCollapseRisk(cfg);
		assert.equal(got.length, 1);
		assert.equal(got[0]!.kind, "unset-with-channel-bindings");
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
		assert.equal(got[0]!.kind, "unset-multi-peer");
	});

	it("warns when dmScope is explicitly \"main\" and any channel is wired (Wave N3)", () => {
		const cfg = {
			session: { dmScope: "main" },
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
				],
			},
		} as unknown as BrigadeConfig;
		const got = detectDmScopeCollapseRisk(cfg);
		assert.equal(got.length, 1);
		assert.equal(got[0]!.kind, "explicit-main-with-channel-bindings");
	});

	it("stays silent when dmScope is per-channel-peer regardless of bindings", () => {
		const cfg = {
			session: { dmScope: "per-channel-peer" },
			bindings: {
				entries: [
					{ agentId: "alice", match: { channel: "whatsapp", peer: { kind: "direct", id: "+1" } } },
					{ agentId: "bob", match: { channel: "whatsapp", peer: { kind: "direct", id: "+2" } } },
				],
			},
		} as unknown as BrigadeConfig;
		assert.deepEqual(detectDmScopeCollapseRisk(cfg), []);
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
			kind: "unset-multi-peer",
		});
		assert.match(msg, /whatsapp/);
		assert.match(msg, /per-peer/);
		assert.match(msg, /brigade\.json/);
	});

	it("calls out single-peer wired-channel risk with the configured-channel kind", () => {
		const msg = formatDmScopeWarning({
			channel: "whatsapp",
			peerCount: 1,
			samplePeers: ["+1"],
			kind: "unset-with-channel-bindings",
		});
		assert.match(msg, /whatsapp/);
		assert.match(msg, /configured/);
		assert.match(msg, /per-channel-peer/);
	});

	it("calls out explicit-main configs", () => {
		const msg = formatDmScopeWarning({
			channel: "whatsapp",
			peerCount: 1,
			samplePeers: ["+1"],
			kind: "explicit-main-with-channel-bindings",
		});
		assert.match(msg, /session\.dmScope/);
		assert.match(msg, /main/);
		assert.match(msg, /per-channel-peer/);
	});
});
