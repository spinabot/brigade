/**
 * Where background spend is booked.
 *
 * Brigade makes model calls that belong to no conversation — memory extraction,
 * consolidation, behaviour review, skill review, relationship relink. They run
 * on isolated sessions the main usage stream never sees, so until they were
 * metered every one of them was free as far as any figure could tell.
 *
 * Booking them is only half the problem; booking them CORRECTLY is the other.
 * The ledger is keyed `(agentId, sessionKey)`, and a consolidation sweep that
 * distils across every session has no natural session to charge.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { agentMaintenanceKey, isMaintenanceKey, sweepBillingKey } from "./maintenance-key.js";

test("agent-scoped work goes to the maintenance bucket, not a random thread", () => {
	// Charging a consolidation sweep to whichever thread happened to be open
	// blames a conversation that did not cause it.
	assert.equal(sweepBillingKey("main"), "agent:main:__maintenance");
	assert.equal(sweepBillingKey("main", undefined), agentMaintenanceKey("main"));
});

test("work a thread caused is billed to that thread", () => {
	// Pre-compaction extraction fires because a specific session is compacting.
	assert.equal(sweepBillingKey("main", "agent:main:main"), "agent:main:main");
	assert.equal(sweepBillingKey("main", "agent:main:thread:x"), "agent:main:thread:x");
});

test("a key belonging to a DIFFERENT agent is refused", () => {
	// Cross-agent attribution would put one agent's spend on another's bill.
	assert.equal(sweepBillingKey("main", "agent:other:main"), "agent:main:__maintenance");
});

test("a raw sessionId UUID is never accepted as a billing key", () => {
	// This is the specific mistake that lost compaction cost once already: a
	// UUID is not a routing key, and billing to one lands the spend on a row
	// nothing displays.
	assert.equal(
		sweepBillingKey("main", "3f8c1e2a-0b44-4c9e-9a11-77d2f0e5b6c3"),
		"agent:main:__maintenance",
	);
});

test("an empty key falls back to maintenance rather than producing a blank row", () => {
	assert.equal(sweepBillingKey("main", ""), agentMaintenanceKey("main"));
});

test("maintenance keys are recognisable, and real threads are not mistaken for them", () => {
	assert.equal(isMaintenanceKey(agentMaintenanceKey("main")), true);
	assert.equal(isMaintenanceKey("agent:main:main"), false);
	// A user-named thread cannot collide: real names never carry the `__` prefix.
	assert.equal(isMaintenanceKey("agent:main:thread:maintenance"), false);
});
