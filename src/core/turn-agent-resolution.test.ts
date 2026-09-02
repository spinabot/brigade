/**
 * Which agent a turn is billed to.
 *
 * `runGatewayTurn` picks the ledger row (and the reasoning tracker's, and the
 * frame ring's) from this. Getting it wrong splits one thread across two rows,
 * where every by-agent surface then shows half of it.
 *
 * The rule has THREE tiers and the order matters:
 *   1. an explicit `turn.agentId` from the caller
 *   2. the agent encoded in a canonical `agent:<id>:<rest>` session key
 *   3. the gateway's boot agent
 *
 * Tier 2 exists because `sessions.send` did not forward `agentId` while its
 * sibling `agent` handler did, so a cross-agent turn was billed to the boot
 * agent while the SAME thread's out-of-band spend — which resolves the agent
 * from the key — landed elsewhere.
 *
 * Tier 3 is the subtle one. `resolveAgentIdFromSessionKey` looks like the
 * natural helper for tier 2, but it never returns undefined — it substitutes
 * DEFAULT_AGENT_ID for anything that does not parse. Using it would make tier 3
 * unreachable, so a gateway booted as `ops` would bill every legacy or alias
 * key to `main`. Parsing directly keeps the tiers distinct.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveAgentIdFromSessionKey } from "../agents/routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

/** The exact expression `runGatewayTurn` uses. */
function billedAgent(
	explicitAgentId: string | undefined,
	sessionKey: string,
	bootAgentId: string,
): string {
	return explicitAgentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? bootAgentId;
}

describe("turn agent resolution", () => {
	it("an explicit agentId always wins", () => {
		assert.equal(billedAgent("ops", "agent:main:main", "boot"), "ops");
	});

	it("a canonical key bills the agent it names, not the boot agent", () => {
		// The sessions.send bug: this used to fall through to the boot agent.
		assert.equal(billedAgent(undefined, "agent:ops:main", "main"), "ops");
		assert.equal(
			billedAgent(undefined, "agent:main:whatsapp:direct:+15551234", "main"),
			"main",
		);
	});

	it("falls back to the BOOT agent for a key that encodes none", () => {
		// THE REGRESSION THIS PINS. A gateway booted as `ops` must keep billing
		// legacy/alias keys to `ops`.
		assert.equal(billedAgent(undefined, "legacy-session", "ops"), "ops");
		assert.equal(billedAgent(undefined, "", "ops"), "ops");
		assert.equal(billedAgent(undefined, "agent:", "ops"), "ops");
	});

	it("resolveAgentIdFromSessionKey would have broken that fallback", () => {
		// Documents why the helper is not used here: it substitutes the default
		// agent rather than reporting that the key encodes none, which silently
		// makes the boot-agent tier unreachable.
		assert.equal(resolveAgentIdFromSessionKey("legacy-session"), "main");
		assert.equal(parseAgentSessionKey("legacy-session")?.agentId, undefined);
	});
});
