import assert from "node:assert/strict";
import { test } from "node:test";

import { PROVIDERS } from "../../providers/catalog.js";
import { classifyBillingMode, classifyBillingModeWithAuth, describeBillingMode, shouldRenderCost } from "./billing-mode.js";

/**
 * The billing mode each catalog entry MUST classify as. Brigade is a
 * model-agnostic harness, so this table is the contract: adding a provider
 * without deciding how it charges is a bug, not an omission, and this test is
 * what makes that fail loudly instead of silently rendering "$0.0000".
 */
const EXPECTED: Record<string, ReturnType<typeof classifyBillingMode>> = {
	anthropic: "metered",
	"claude-code": "subscription",
	"claude-cli": "subscription",
	openai: "metered",
	google: "metered",
	openrouter: "metered",
	// BYOK gateway — passes each provider's published rate through.
	orcarouter: "metered",
	groq: "metered",
	cerebras: "metered",
	xai: "metered",
	deepseek: "metered",
	mistral: "metered",
	"openai-codex": "subscription",
	"github-copilot": "subscription",
	glm: "subscription",
	kimi: "metered",
	qwen: "metered",
	"minimax-sub": "subscription",
	"deepseek-sub": "subscription",
	"nvidia-nim": "metered",
	ollama: "local",
	custom: "unknown",
};

test("every catalog provider declares a billing mode", () => {
	for (const p of PROVIDERS) {
		assert.ok(
			["metered", "subscription", "local", "unknown"].includes(p.billing),
			`provider "${p.id}" has no valid billing mode`,
		);
	}
});

test("the classifier agrees with the catalog for EVERY provider", () => {
	// Catches both directions of drift: a provider added to the catalog without
	// an entry here, and one whose declared mode changed underneath us.
	const seen = new Set<string>();
	for (const p of PROVIDERS) {
		seen.add(p.id);
		const expected = EXPECTED[p.id];
		assert.ok(expected !== undefined, `provider "${p.id}" is not covered by this test — decide how it bills`);
		assert.equal(classifyBillingMode({ provider: p.id }), expected, `provider "${p.id}"`);
	}
	for (const id of Object.keys(EXPECTED)) {
		assert.ok(seen.has(id), `"${id}" is expected here but no longer in the catalog`);
	}
});

test("claude-cli is subscription even though the catalog marks it local:true", () => {
	// `local: true` on that entry means "skip key entry, validate the binary",
	// NOT "runs on your hardware". Inferring billing from it would report a
	// Claude subscription turn as free local inference.
	const entry = PROVIDERS.find((p) => p.id === "claude-cli");
	assert.equal(entry?.local, true, "precondition: the entry really is marked local");
	assert.equal(classifyBillingMode({ provider: "claude-cli" }), "subscription");
});

test("an unpriced model is unknown, never free", () => {
	// The failure this prevents: a model newer than the bundled catalog gets a
	// zeroed price card, every turn computes 0 x tokens = $0, and the operator
	// reads "free" while being billed normally.
	assert.equal(classifyBillingMode({ provider: "some-new-provider" }), "unknown");
	assert.equal(classifyBillingMode({ provider: "some-new-provider", cost: { input: 0, output: 0 } }), "unknown");
	assert.equal(shouldRenderCost("unknown"), false, "a UI must render unknown as an absence, not $0");
});

test("a pi-ai negative price sentinel does not read as a real price", () => {
	// `openrouter/auto` carries input: -1000000 as a sentinel.
	assert.equal(classifyBillingMode({ provider: "unlisted", cost: { input: -1_000_000 } }), "unknown");
});

test("a transport-reported cost outranks a missing price card", () => {
	assert.equal(classifyBillingMode({ provider: "unlisted", costKnown: true }), "metered");
});

test("an oauth credential narrows a metered provider to subscription", () => {
	// Onboarding resolves `providerId ?? id`, so a "Claude (browser OAuth)" login
	// is stored under `anthropic` — the provider id alone cannot tell a Pro/Max
	// subscription turn from a metered API-key turn. The credential type can.
	assert.equal(classifyBillingModeWithAuth({ provider: "anthropic", authType: "api_key" }), "metered");
	assert.equal(classifyBillingModeWithAuth({ provider: "anthropic", authType: "oauth" }), "subscription");
	assert.equal(classifyBillingModeWithAuth({ provider: "anthropic", authType: "token" }), "subscription");
	assert.equal(classifyBillingModeWithAuth({ provider: "anthropic" }), "metered", "no auth info keeps the catalog answer");
});

test("auth type only ever narrows metered — it never overrides local or unknown", () => {
	assert.equal(classifyBillingModeWithAuth({ provider: "ollama", authType: "oauth" }), "local");
	assert.equal(classifyBillingModeWithAuth({ provider: "claude-cli", authType: "api_key" }), "subscription");
	assert.equal(classifyBillingModeWithAuth({ provider: "unlisted", authType: "oauth" }), "unknown");
});

test("only metered turns render a dollar figure", () => {
	assert.equal(shouldRenderCost("metered"), true);
	assert.equal(shouldRenderCost("subscription"), false);
	assert.equal(shouldRenderCost("local"), false);
	assert.equal(shouldRenderCost("unknown"), false);
});

test("every mode has a human explanation for the missing-cost case", () => {
	for (const mode of ["metered", "subscription", "local", "unknown"] as const) {
		assert.ok(describeBillingMode(mode).length > 0);
	}
});
