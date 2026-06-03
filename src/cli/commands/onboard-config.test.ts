/**
 * Onboarding session-defaults tests.
 *
 * The secure default `session.dmScope = "per-channel-peer"` is seeded
 * exactly once when `brigade onboard` finishes. Operator-explicit values
 * must pass through untouched so re-onboarding never silently flips a
 * deliberate `"main"` (or anything else) back to the default.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/types.js";
import { applyOnboardingSessionDefaults, ONBOARDING_DEFAULT_DM_SCOPE } from "./onboard-config.js";

describe("applyOnboardingSessionDefaults", () => {
	it("seeds the default when session is absent", () => {
		const cfg = {} as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, ONBOARDING_DEFAULT_DM_SCOPE);
	});

	it("seeds the default when session.dmScope is undefined", () => {
		const cfg = { session: {} } as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, ONBOARDING_DEFAULT_DM_SCOPE);
	});

	it("seeds the default when session.dmScope is an empty string", () => {
		const cfg = { session: { dmScope: "" } } as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, ONBOARDING_DEFAULT_DM_SCOPE);
	});

	it("seeds the default when session.dmScope is only whitespace", () => {
		const cfg = { session: { dmScope: "  " } } as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, ONBOARDING_DEFAULT_DM_SCOPE);
	});

	it("preserves an explicit 'main' choice", () => {
		const cfg = { session: { dmScope: "main" } } as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, "main");
	});

	it("preserves an explicit 'per-peer' choice", () => {
		const cfg = { session: { dmScope: "per-peer" } } as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, "per-peer");
	});

	it("preserves an explicit 'per-account-channel-peer' choice", () => {
		const cfg = {
			session: { dmScope: "per-account-channel-peer" },
		} as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.equal(out.session?.dmScope, "per-account-channel-peer");
	});

	it("does not clobber other session fields", () => {
		const cfg = {
			session: { identityLinks: { kartheek: ["whatsapp:+91"] } },
		} as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.deepEqual(out.session?.identityLinks, { kartheek: ["whatsapp:+91"] });
		assert.equal(out.session?.dmScope, ONBOARDING_DEFAULT_DM_SCOPE);
	});

	it("returns a new top-level object (does not mutate input)", () => {
		const cfg = { session: {} } as unknown as BrigadeConfig;
		const out = applyOnboardingSessionDefaults(cfg);
		assert.notEqual(out, cfg);
		// Input's session must be untouched.
		assert.equal((cfg.session as { dmScope?: unknown }).dmScope, undefined);
	});

	it("ONBOARDING_DEFAULT_DM_SCOPE is 'per-channel-peer'", () => {
		// Pinned so a future refactor doesn't silently flip the secure
		// default — this is the contract Brigade promises operators.
		assert.equal(ONBOARDING_DEFAULT_DM_SCOPE, "per-channel-peer");
	});
});
