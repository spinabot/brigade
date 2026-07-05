/**
 * Tests for the subscription-refresh health classifier + warning formatter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifySubscriptionRefresh, formatUnrefreshableWarning } from "./auth-health.js";

test("api_key holding an sk-ant-oat subscription token is flagged", () => {
	const reason = classifySubscriptionRefresh({ type: "api_key", key: "sk-ant-oat01-abcdef" });
	assert.ok(reason && /static key/.test(reason));
});

test("a real sk-ant-api API key is healthy (does not expire)", () => {
	assert.equal(classifySubscriptionRefresh({ type: "api_key", key: "sk-ant-api03-xyz" }), null);
});

test("token type (no refresh) is flagged", () => {
	assert.ok(classifySubscriptionRefresh({ type: "token", token: "sk-ant-oat01-abc" }));
});

test("oauth without a refresh token is flagged; with one it's healthy", () => {
	assert.ok(classifySubscriptionRefresh({ type: "oauth", access: "a" }));
	assert.equal(classifySubscriptionRefresh({ type: "oauth", access: "a", refresh: "r" }), null);
	// A refresh stored as a ref also counts as healthy.
	assert.equal(classifySubscriptionRefresh({ type: "oauth", access: "a", refreshRef: { source: "env", id: "X" } }), null);
});

test("formatter lists each provider + the brigade login fix; empty → empty string", () => {
	const msg = formatUnrefreshableWarning([
		{ provider: "anthropic", label: "Claude Code", reason: "expired" },
	]);
	assert.match(msg, /Claude Code/);
	assert.match(msg, /brigade login/);
	assert.equal(formatUnrefreshableWarning([]), "");
});

// ─── decideCliLoginAdoption (split-brain guard for borrowed CLI logins) ───

import { decideCliLoginAdoption } from "./auth-health.js";

const cli = { access: "sk-ant-oat01-NEW", refresh: "sk-ant-ort01-NEW", expires: 2_000 };

test("adoption: stamped profile with older tokens adopts the CLI's newer ones", () => {
	const prof = {
		access: "sk-ant-oat01-OLD",
		refresh: "sk-ant-ort01-OLD",
		expires: 1_000,
		metadata: { importedFrom: "claude-cli" },
	};
	assert.equal(decideCliLoginAdoption(prof, cli), "adopt");
});

test("adoption: pre-stamp profile holding the identical token is stamped, not adopted", () => {
	const prof = { access: cli.access, refresh: cli.refresh, expires: cli.expires };
	assert.equal(decideCliLoginAdoption(prof, cli), "stamp");
});

test("adoption: matching refresh token alone links the family (access already rotated)", () => {
	const prof = { access: "sk-ant-oat01-STALE", refresh: cli.refresh, expires: 1_000 };
	assert.equal(decideCliLoginAdoption(prof, cli), "adopt");
});

test("adoption: an independent `brigade login` grant is never touched", () => {
	const prof = { access: "sk-ant-oat01-OWN", refresh: "sk-ant-ort01-OWN", expires: 1 };
	assert.equal(decideCliLoginAdoption(prof, cli), "none");
});

test("adoption: stamped profile that is FRESHER than the CLI file is left alone", () => {
	// Brigade refreshed while the CLI sat idle — don't clobber the newer tokens.
	const prof = {
		access: "sk-ant-oat01-FRESH",
		refresh: "sk-ant-ort01-FRESH",
		expires: 3_000,
		metadata: { importedFrom: "claude-cli" },
	};
	assert.equal(decideCliLoginAdoption(prof, cli), "none");
});

test("adoption: missing/garbage expiries coerce to 0 (equal → no adopt loop)", () => {
	const prof = { access: cli.access, refresh: cli.refresh, metadata: { importedFrom: "claude-cli" } };
	assert.equal(decideCliLoginAdoption(prof, { ...cli, expires: undefined }), "none");
});

test("adoption: empty-string tokens never link a family", () => {
	const prof = { access: "", refresh: "", expires: 0 };
	assert.equal(decideCliLoginAdoption(prof, { access: "", refresh: "", expires: 9 }), "none");
});

// ─── healDeadSubscriptionLogin (dead-grant recovery: refresh-probe → adopt) ───

import { healDeadSubscriptionLogin } from "./auth-health.js";
import { initAuthProfiles, upsertOAuthProfile, readProfiles, __resetAuthCachesForTests } from "./profiles.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function withTempAgent(fn: (agentId: string) => Promise<void>): Promise<void> {
	const prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = mkdtempSync(path.join(tmpdir(), "brigade-heal-"));
	__resetAuthCachesForTests();
	const agentId = "main";
	initAuthProfiles(agentId);
	return fn(agentId).finally(() => {
		if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prev;
		__resetAuthCachesForTests();
	});
}

test("healDeadSubscriptionLogin: unexpired profile → no-op (no network)", async () => {
	await withTempAgent(async (agentId) => {
		upsertOAuthProfile(agentId, {
			provider: "anthropic",
			access: "sk-ant-oat01-live",
			refresh: "sk-ant-ort01-live",
			expires: Date.now() + 3_600_000, // an hour out — not expired
		});
		let refreshCalled = false;
		const res = await healDeadSubscriptionLogin(agentId, {
			refreshFn: async () => {
				refreshCalled = true;
				return null;
			},
			cliRead: () => null,
		});
		assert.equal(res, "none");
		assert.equal(refreshCalled, false, "must not hit the network for a live token");
	});
});

test("healDeadSubscriptionLogin: expired but refresh still works → refreshed in place", async () => {
	await withTempAgent(async (agentId) => {
		upsertOAuthProfile(agentId, {
			provider: "anthropic",
			access: "sk-ant-oat01-stale",
			refresh: "sk-ant-ort01-stale",
			expires: Date.now() - 10_000, // expired
		});
		const res = await healDeadSubscriptionLogin(agentId, {
			refreshFn: async () => ({ access: "sk-ant-oat01-fresh", refresh: "sk-ant-ort01-fresh", expires: Date.now() + 3_600_000 }),
			cliRead: () => null,
		});
		assert.equal(res, "refreshed");
		const prof = Object.values((readProfiles(agentId) as any).profiles).find((p: any) => p.provider === "anthropic") as any;
		assert.equal(prof.access, "sk-ant-oat01-fresh");
		assert.equal(prof.refresh, "sk-ant-ort01-fresh");
	});
});

test("healDeadSubscriptionLogin: expired + dead refresh → adopts the live CLI login", async () => {
	await withTempAgent(async (agentId) => {
		upsertOAuthProfile(agentId, {
			provider: "anthropic",
			access: "sk-ant-oat01-dead",
			refresh: "sk-ant-ort01-dead",
			expires: Date.now() - 10_000,
		});
		const res = await healDeadSubscriptionLogin(agentId, {
			refreshFn: async () => null, // grant is dead
			cliRead: () => ({ provider: "anthropic", type: "oauth", access: "sk-ant-oat01-cli", refresh: "sk-ant-ort01-cli", expires: Date.now() + 7_200_000 }),
		});
		assert.equal(res, "adopted");
		const prof = Object.values((readProfiles(agentId) as any).profiles).find((p: any) => p.provider === "anthropic") as any;
		assert.equal(prof.access, "sk-ant-oat01-cli");
		assert.equal(prof.metadata?.importedFrom, "claude-cli");
	});
});

test("healDeadSubscriptionLogin: no oauth profile → none", async () => {
	await withTempAgent(async (agentId) => {
		const res = await healDeadSubscriptionLogin(agentId, { refreshFn: async () => null, cliRead: () => null });
		assert.equal(res, "none");
	});
});
