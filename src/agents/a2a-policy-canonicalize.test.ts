/**
 * Tests for the shared A2A-policy canonicaliser.
 *
 * Mirrors the existing `applyAutoEnableA2AOnAgentCreate` state-matrix tests
 * (in `manage-agent-tool.test.ts`) and pins:
 *
 *   - boot variant + add-variant share semantics by gate-flag injection
 *   - the four states (missing / boolean-true / enabled:false /
 *     enabled:true) coerce or no-op identically
 *   - the named gate flag is the only opt-out lever (one variant's flag
 *     does NOT silence the other)
 *   - operator-authored `allow` entries survive the enabled:false flip
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../config/io.js";
import {
	applyAutoEnableA2AAtBoot,
	applyAutoEnableA2AOnAgentCreate,
	canonicalizeA2APolicy,
} from "./a2a-policy-canonicalize.js";

type SessionRaw = Record<string, unknown>;

function readA2A(cfg: BrigadeConfig): unknown {
	return (cfg.session as SessionRaw | undefined)?.["agentToAgent"];
}

describe("a2a-policy-canonicalize: state matrix (both gates)", () => {
	for (const gateFlag of [
		"autoEnableA2AOnAgentCreate",
		"autoEnableA2AAtBoot",
	] as const) {
		describe(`gateFlag=${gateFlag}`, () => {
			it("(1) missing agentToAgent → canonical {enabled:true, allow:[{from:*,to:*}]}", () => {
				const cfg: BrigadeConfig = { agents: { main: {} } };
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.deepEqual(readA2A(next), {
					enabled: true,
					allow: [{ from: "*", to: "*" }],
				});
			});

			it("(2) boolean-true legacy shape → coerce to canonical object", () => {
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: { agentToAgent: true } as never,
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.deepEqual(readA2A(next), {
					enabled: true,
					allow: [{ from: "*", to: "*" }],
				});
			});

			it("(3) enabled:false object → flip enabled, preserve allow + extra fields", () => {
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: {
						agentToAgent: {
							enabled: false,
							allow: [{ from: "alice", to: "bob" }],
							maxPingPongTurns: 7,
						},
					},
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				const a2a = readA2A(next) as {
					enabled: boolean;
					allow: Array<{ from: string; to: string }>;
					maxPingPongTurns: number;
				};
				assert.equal(a2a.enabled, true);
				assert.deepEqual(a2a.allow, [{ from: "alice", to: "bob" }]);
				assert.equal(a2a.maxPingPongTurns, 7);
			});

			it("(4) enabled:true AND visibility:all already → idempotent no-op (same ref)", () => {
				// Fully canonical = agentToAgent enabled AND sessionTools
				// visibility "all". Both must be present for the no-op, since
				// the canonicaliser now also seeds visibility.
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: {
						agentToAgent: {
							enabled: true,
							allow: [{ from: "*", to: "*" }],
						},
						sessionTools: { visibility: "all" },
					},
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.strictEqual(next, cfg);
			});

			it("(4b) enabled:true but visibility UNSET → seeds visibility:all (the half-on bug)", () => {
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: { agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] } },
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.notStrictEqual(next, cfg, "must produce a new cfg — visibility needed seeding");
				const vis = (next.session as { sessionTools?: { visibility?: string } } | undefined)
					?.sessionTools?.visibility;
				assert.equal(vis, "all", "A2A out-of-the-box requires visibility all");
				// agentToAgent untouched (already enabled).
				assert.deepEqual(readA2A(next), { enabled: true, allow: [{ from: "*", to: "*" }] });
			});

			it("(4c) explicit visibility:self is RESPECTED (deliberate lockdown not overridden)", () => {
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: {
						agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] },
						sessionTools: { visibility: "self" },
					},
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.strictEqual(next, cfg, "operator's explicit visibility choice must survive");
			});

			it("(4d) missing agentToAgent ALSO seeds visibility:all in one pass", () => {
				const cfg: BrigadeConfig = { agents: { main: {} } };
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.deepEqual(readA2A(next), { enabled: true, allow: [{ from: "*", to: "*" }] });
				const vis = (next.session as { sessionTools?: { visibility?: string } } | undefined)
					?.sessionTools?.visibility;
				assert.equal(vis, "all");
			});

			it(`(5) ${gateFlag}=false → bypass canonicalisation entirely`, () => {
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: { [gateFlag]: false } as never,
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.strictEqual(next, cfg, "must be a reference no-op");
				assert.equal(
					readA2A(next),
					undefined,
					"agentToAgent stays absent when operator opts out",
				);
			});

			it("(6) sibling gate flag does NOT silence the active gate", () => {
				const otherFlag =
					gateFlag === "autoEnableA2AOnAgentCreate"
						? "autoEnableA2AAtBoot"
						: "autoEnableA2AOnAgentCreate";
				const cfg: BrigadeConfig = {
					agents: { main: {} },
					session: { [otherFlag]: false } as never,
				};
				const next = canonicalizeA2APolicy(cfg, { gateFlag });
				assert.deepEqual(readA2A(next), {
					enabled: true,
					allow: [{ from: "*", to: "*" }],
				});
			});
		});
	}
});

describe("a2a-policy-canonicalize: thin wrappers", () => {
	it("applyAutoEnableA2AOnAgentCreate gates on autoEnableA2AOnAgentCreate", () => {
		const optedOut: BrigadeConfig = {
			agents: { main: {} },
			session: { autoEnableA2AOnAgentCreate: false } as never,
		};
		assert.strictEqual(applyAutoEnableA2AOnAgentCreate(optedOut), optedOut);

		// The OTHER flag must NOT silence this wrapper.
		const otherOpted: BrigadeConfig = {
			agents: { main: {} },
			session: { autoEnableA2AAtBoot: false } as never,
		};
		const next = applyAutoEnableA2AOnAgentCreate(otherOpted);
		assert.deepEqual(readA2A(next), {
			enabled: true,
			allow: [{ from: "*", to: "*" }],
		});
	});

	it("applyAutoEnableA2AAtBoot gates on autoEnableA2AAtBoot", () => {
		const optedOut: BrigadeConfig = {
			agents: { main: {} },
			session: { autoEnableA2AAtBoot: false } as never,
		};
		assert.strictEqual(applyAutoEnableA2AAtBoot(optedOut), optedOut);

		// The OTHER flag must NOT silence this wrapper.
		const otherOpted: BrigadeConfig = {
			agents: { main: {} },
			session: { autoEnableA2AOnAgentCreate: false } as never,
		};
		const next = applyAutoEnableA2AAtBoot(otherOpted);
		assert.deepEqual(readA2A(next), {
			enabled: true,
			allow: [{ from: "*", to: "*" }],
		});
	});
});

describe("a2a-policy-canonicalize: operator-authored allow survives boot canonicalise", () => {
	it("preserves a narrow operator-authored allow on flip from enabled:false", () => {
		const cfg: BrigadeConfig = {
			agents: { main: {} },
			session: {
				agentToAgent: {
					enabled: false,
					allow: [
						{ from: "alice", to: "bob" },
						{ from: "ops", to: "main" },
					],
				},
			},
		};
		const next = applyAutoEnableA2AAtBoot(cfg);
		const a2a = readA2A(next) as {
			enabled: boolean;
			allow: Array<{ from: string; to: string }>;
		};
		assert.equal(a2a.enabled, true);
		assert.deepEqual(a2a.allow, [
			{ from: "alice", to: "bob" },
			{ from: "ops", to: "main" },
		]);
	});
});
