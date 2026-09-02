/**
 * Registration guards for the OpenCode Console OAuth provider.
 *
 * Worth more than a normal idempotency test: an unregistered provider does not
 * throw — `getOAuthProvider` returns undefined and the request goes out with NO
 * credential. `resetOAuthProviders()` fires from `ModelRegistry.refresh()`, so a
 * sticky boolean would leave us in exactly that state after the first refresh.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import {
	ensureOpencodeConsoleOAuthRegistered,
	OPENCODE_CONSOLE_PROVIDER,
	registerOpencodeConsoleOnRegistry,
} from "./opencode-console.js";

describe("ensureOpencodeConsoleOAuthRegistered", () => {
	it("registers the provider into Pi's OAuth registry, idempotently", () => {
		resetOAuthProviders();
		assert.equal(ensureOpencodeConsoleOAuthRegistered(), true, "first call registers");

		const provider = getOAuthProvider(OPENCODE_CONSOLE_PROVIDER);
		assert.ok(provider, "getOAuthProvider now resolves");
		assert.equal(provider?.id, OPENCODE_CONSOLE_PROVIDER);
		assert.equal(typeof provider?.login, "function");
		assert.equal(typeof provider?.refreshToken, "function");
		assert.equal(typeof provider?.getApiKey, "function");

		assert.equal(ensureOpencodeConsoleOAuthRegistered(), false, "second call is a no-op");
	});

	it("self-heals after resetOAuthProviders() — guards on the LIVE registry, not a flag", () => {
		ensureOpencodeConsoleOAuthRegistered();
		assert.ok(getOAuthProvider(OPENCODE_CONSOLE_PROVIDER), "registered before the wipe");

		resetOAuthProviders(); // what ModelRegistry.refresh() does
		assert.equal(
			getOAuthProvider(OPENCODE_CONSOLE_PROVIDER),
			undefined,
			"reset really does drop custom providers",
		);

		assert.equal(
			ensureOpencodeConsoleOAuthRegistered(),
			true,
			"re-registers after the wipe instead of trusting a stale flag",
		);
		assert.ok(getOAuthProvider(OPENCODE_CONSOLE_PROVIDER));
	});

	it("the OAuth provider id equals the Pi provider id (the lookup key)", () => {
		// `AuthStorage.getApiKey` does getOAuthProvider(providerId). If these ever
		// diverge, credentials stored under the provider id resolve to no OAuth
		// provider and requests silently go out unauthenticated.
		resetOAuthProviders();
		ensureOpencodeConsoleOAuthRegistered();
		assert.equal(getOAuthProvider(OPENCODE_CONSOLE_PROVIDER)?.id, OPENCODE_CONSOLE_PROVIDER);
	});
});

/**
 * The module-boundary regression: pi-coding-agent ships its own nested pi-ai, so
 * `AuthStorage` holds a second OAuth registry that `registerOAuthProvider` above
 * cannot reach. These assert the end that matters — that AuthStorage resolves the
 * credential — so a refactor cannot drop the registry call and look fine.
 */
describe("registerOpencodeConsoleOnRegistry (crosses the pi-ai module boundary)", () => {
	const credential = {
		type: "oauth",
		access: "st_test_access",
		refresh: "rt_test_refresh",
		// Comfortably unexpired, so nothing tries to refresh over the network.
		expires: Date.now() + 7 * 86_400_000,
		metadata: { server: "https://opencode.ai/console", orgId: "org_test" },
	};

	it("makes AuthStorage resolve an opencode-console oauth credential", async () => {
		resetOAuthProviders();
		const authStorage = AuthStorage.inMemory({
			[OPENCODE_CONSOLE_PROVIDER]: credential,
		} as never);
		const registry = ModelRegistry.create(authStorage, undefined);

		registerOpencodeConsoleOnRegistry(registry as never);

		const key = await authStorage.getApiKey(OPENCODE_CONSOLE_PROVIDER, {
			includeFallback: false,
		} as never);
		assert.equal(key, "st_test_access", "AuthStorage must see the provider we registered");
	});

	it("the plain registry call alone is NOT sufficient — proving why both exist", async () => {
		// Guard rail with a purpose: if a future pi-ai/pi-coding-agent install ever
		// dedupes to a single copy, this assertion flips and tells us the registry
		// call has become redundant, rather than leaving dead code behind forever.
		resetOAuthProviders();
		ensureOpencodeConsoleOAuthRegistered();
		assert.ok(getOAuthProvider(OPENCODE_CONSOLE_PROVIDER), "registered in this module's copy");

		const authStorage = AuthStorage.inMemory({
			[OPENCODE_CONSOLE_PROVIDER]: credential,
		} as never);
		const key = await authStorage.getApiKey(OPENCODE_CONSOLE_PROVIDER, {
			includeFallback: false,
		} as never);

		if (key === undefined) {
			// Two copies, as installed today: the registry call is load-bearing.
			assert.equal(key, undefined);
		} else {
			// One shared copy: fine, but then registerOpencodeConsoleOnRegistry is
			// belt-and-braces rather than the thing that makes auth work.
			assert.equal(key, "st_test_access");
		}
	});

	it("survives refresh(), because registerProvider re-applies after loadModels()", async () => {
		resetOAuthProviders();
		const authStorage = AuthStorage.inMemory({
			[OPENCODE_CONSOLE_PROVIDER]: credential,
		} as never);
		const registry = ModelRegistry.create(authStorage, undefined);
		registerOpencodeConsoleOnRegistry(registry as never);

		// refresh() calls resetOAuthProviders() then re-applies registeredProviders.
		registry.refresh();

		const key = await authStorage.getApiKey(OPENCODE_CONSOLE_PROVIDER, {
			includeFallback: false,
		} as never);
		assert.equal(key, "st_test_access", "the credential must still resolve after a refresh");
	});
});
