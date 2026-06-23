/**
 * Tests for the channel-security registry — the SUPPLEMENTARY DM-policy consult
 * + audit-collection seam (Item #6).
 *
 * The whole point is PRECEDENCE: a registered security adapter may only ever
 * TIGHTEN the central (authoritative) DM policy, NEVER loosen it. These tests
 * pin the tighten-only rule across the full tightness ladder, the back-compat
 * default (no adapter / null opinion → policy unchanged), the enum⇄enum mapping,
 * and the audit collection.
 *
 * The registry is a process-global singleton; each case clears its dynamic
 * registrations in afterEach so they don't bleed across tests.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	clearChannelSecurityRegistry,
	collectChannelSecurityAudit,
	consultChannelDmPolicy,
	dmPolicyTightness,
	getChannelSecurityAdapter,
	listChannelSecurityAdapters,
	reconcileDmPolicy,
	registerChannelSecurityAdapter,
	resetChannelSecurityRegistryForTests,
	securityDmPolicyToDmPolicy,
	syncChannelSecurityAdaptersFromPlugins,
} from "./channel-security-registry.js";
import {
	clearChannelMessagingRegistry,
	resetChannelMessagingRegistryForTests,
	resolveOutboundTarget,
	syncChannelMessagingAdaptersFromPlugins,
} from "./channel-messaging-registry.js";
import type { DmPolicy } from "./access-control/types.js";
import type { BrigadeConfig } from "../../config/types.js";
import type {
	ChannelMessagingAdapter,
	ChannelSecurityAdapter,
	ChannelSecurityContext,
	ChannelSecurityDmPolicy,
} from "./types.adapters.js";

afterEach(() => {
	resetChannelSecurityRegistryForTests();
	resetChannelMessagingRegistryForTests();
});

const CFG = {} as BrigadeConfig;
function ctx(over: Partial<ChannelSecurityContext> = {}): ChannelSecurityContext {
	return { account: undefined, accountId: "", cfg: CFG, ...over };
}

/* ─────────────────────────── register / lookup ─────────────────────────── */

describe("registerChannelSecurityAdapter / getChannelSecurityAdapter", () => {
	it("registers and looks up by id (case-insensitive)", () => {
		const adapter: ChannelSecurityAdapter = { resolveDmPolicy: () => "owner" };
		registerChannelSecurityAdapter("telegram", adapter);
		assert.equal(getChannelSecurityAdapter("telegram"), adapter);
		assert.equal(getChannelSecurityAdapter("TELEGRAM"), adapter);
		assert.equal(getChannelSecurityAdapter("  Telegram "), adapter);
	});

	it("returns undefined for an unregistered / nullish channel", () => {
		assert.equal(getChannelSecurityAdapter("signal"), undefined);
		assert.equal(getChannelSecurityAdapter(""), undefined);
		assert.equal(getChannelSecurityAdapter(null), undefined);
		assert.equal(getChannelSecurityAdapter(undefined), undefined);
	});

	it("last registration per id wins + no-ops on an unusable id", () => {
		const a: ChannelSecurityAdapter = { resolveDmPolicy: () => "all" };
		const b: ChannelSecurityAdapter = { resolveDmPolicy: () => "owner" };
		registerChannelSecurityAdapter("x", a);
		registerChannelSecurityAdapter("x", b);
		assert.equal(getChannelSecurityAdapter("x"), b);
		registerChannelSecurityAdapter("   ", a);
		assert.equal(getChannelSecurityAdapter("   "), undefined);
	});

	it("syncChannelSecurityAdaptersFromPlugins registers only plugins that declare a security adapter", () => {
		const sec: ChannelSecurityAdapter = { resolveDmPolicy: () => "owner" };
		syncChannelSecurityAdaptersFromPlugins([
			{ id: "telegram", security: sec },
			{ id: "whatsapp" /* no security slot */ },
		]);
		assert.equal(getChannelSecurityAdapter("telegram"), sec);
		assert.equal(getChannelSecurityAdapter("whatsapp"), undefined);
		assert.deepEqual(listChannelSecurityAdapters(), ["telegram"]);
	});
});

/* ─────────────────────────── enum mapping + tightness ─────────────────────────── */

describe("securityDmPolicyToDmPolicy + dmPolicyTightness", () => {
	it("maps each author-facing value onto the pipeline vocabulary", () => {
		const pairs: Array<[ChannelSecurityDmPolicy, DmPolicy]> = [
			["all", "open"],
			["allow-from", "allowlist"],
			["owner", "pairing"],
			["disabled", "disabled"],
		];
		for (const [author, pipeline] of pairs) {
			assert.equal(securityDmPolicyToDmPolicy(author), pipeline);
		}
	});

	it("orders the tightness ladder open < allowlist < pairing < disabled", () => {
		assert.ok(dmPolicyTightness("open") < dmPolicyTightness("allowlist"));
		assert.ok(dmPolicyTightness("allowlist") < dmPolicyTightness("pairing"));
		assert.ok(dmPolicyTightness("pairing") < dmPolicyTightness("disabled"));
	});
});

/* ─────────────────────────── PRECEDENCE: tighten-only ─────────────────────────── */

describe("reconcileDmPolicy — tighten-only precedence", () => {
	it("TIGHTENS when the adapter is stricter than the base", () => {
		// base open, adapter owner(=pairing) → pairing.
		assert.equal(reconcileDmPolicy("open", "owner"), "pairing");
		// base allowlist, adapter disabled → disabled.
		assert.equal(reconcileDmPolicy("allowlist", "disabled"), "disabled");
		// base open, adapter allow-from(=allowlist) → allowlist.
		assert.equal(reconcileDmPolicy("open", "allow-from"), "allowlist");
	});

	it("CANNOT loosen — a looser adapter opinion is ignored, base wins", () => {
		// base pairing, adapter all(=open) → stays pairing (adapter can't loosen).
		assert.equal(reconcileDmPolicy("pairing", "all"), "pairing");
		// base disabled, adapter owner(=pairing) → stays disabled.
		assert.equal(reconcileDmPolicy("disabled", "owner"), "disabled");
		// base allowlist, adapter all(=open) → stays allowlist.
		assert.equal(reconcileDmPolicy("allowlist", "all"), "allowlist");
	});

	it("leaves base UNCHANGED on a null / undefined opinion (no opinion)", () => {
		assert.equal(reconcileDmPolicy("pairing", null), "pairing");
		assert.equal(reconcileDmPolicy("open", undefined), "open");
		assert.equal(reconcileDmPolicy("allowlist", null), "allowlist");
	});

	it("equal tightness keeps the base (idempotent)", () => {
		assert.equal(reconcileDmPolicy("allowlist", "allow-from"), "allowlist");
		assert.equal(reconcileDmPolicy("pairing", "owner"), "pairing");
	});
});

describe("consultChannelDmPolicy — registry-driven tighten-only consult", () => {
	it("back-compat: NO adapter registered → base policy unchanged", () => {
		assert.equal(
			consultChannelDmPolicy({ channelId: "whatsapp", base: "open", ctx: ctx() }),
			"open",
		);
	});

	it("back-compat: adapter without resolveDmPolicy → base unchanged", () => {
		registerChannelSecurityAdapter("telegram", { collectWarnings: () => [] });
		assert.equal(
			consultChannelDmPolicy({ channelId: "telegram", base: "open", ctx: ctx() }),
			"open",
		);
	});

	it("a registered adapter TIGHTENS the effective policy", () => {
		registerChannelSecurityAdapter("telegram", { resolveDmPolicy: () => "owner" });
		assert.equal(
			consultChannelDmPolicy({ channelId: "telegram", base: "open", ctx: ctx() }),
			"pairing",
		);
	});

	it("a registered adapter CANNOT loosen the effective policy", () => {
		// Config says pairing; adapter says "all" (open) → must stay pairing.
		registerChannelSecurityAdapter("telegram", { resolveDmPolicy: () => "all" });
		assert.equal(
			consultChannelDmPolicy({ channelId: "telegram", base: "pairing", ctx: ctx() }),
			"pairing",
		);
	});

	it("a null opinion leaves the base untouched", () => {
		registerChannelSecurityAdapter("telegram", { resolveDmPolicy: () => null });
		assert.equal(
			consultChannelDmPolicy({ channelId: "telegram", base: "allowlist", ctx: ctx() }),
			"allowlist",
		);
	});

	it("never throws — a buggy adapter degrades to the base policy", () => {
		registerChannelSecurityAdapter("telegram", {
			resolveDmPolicy: () => {
				throw new Error("boom");
			},
		});
		assert.equal(
			consultChannelDmPolicy({ channelId: "telegram", base: "pairing", ctx: ctx() }),
			"pairing",
		);
	});

	it("passes the per-call context through to the adapter", () => {
		let seen: ChannelSecurityContext | undefined;
		registerChannelSecurityAdapter("telegram", {
			resolveDmPolicy: (c) => {
				seen = c;
				return "owner";
			},
		});
		consultChannelDmPolicy({
			channelId: "telegram",
			base: "open",
			ctx: ctx({ accountId: "acct-1", peerId: "123", peerKind: "direct" }),
		});
		assert.equal(seen?.accountId, "acct-1");
		assert.equal(seen?.peerId, "123");
		assert.equal(seen?.peerKind, "direct");
	});
});

/* ─────────────────────────── audit collection ─────────────────────────── */

describe("collectChannelSecurityAudit", () => {
	it("returns nothing when no adapters are registered", async () => {
		const groups = await collectChannelSecurityAudit({ cfg: CFG });
		assert.deepEqual(groups, []);
	});

	it("collects structured findings from collectAuditFindings", async () => {
		registerChannelSecurityAdapter("telegram", {
			collectAuditFindings: () => [
				{
					checkId: "telegram.open-dm",
					severity: "critical",
					title: "DM policy is open",
					detail: "Anyone can DM the bot.",
					remediation: "Set channels.telegram.dmPolicy to pairing.",
				},
			],
		});
		const groups = await collectChannelSecurityAudit({ cfg: CFG });
		assert.equal(groups.length, 1);
		assert.equal(groups[0]!.channelId, "telegram");
		assert.equal(groups[0]!.findings.length, 1);
		assert.equal(groups[0]!.findings[0]!.checkId, "telegram.open-dm");
		assert.equal(groups[0]!.findings[0]!.severity, "critical");
		assert.equal(groups[0]!.findings[0]!.remediation, "Set channels.telegram.dmPolicy to pairing.");
	});

	it("folds free-text collectWarnings into warn-severity findings", async () => {
		registerChannelSecurityAdapter("slack", {
			collectWarnings: () => ["Bot token has admin scope.", "  ", ""],
		});
		const groups = await collectChannelSecurityAudit({ cfg: CFG });
		assert.equal(groups.length, 1);
		// Only the non-blank warning becomes a finding.
		assert.equal(groups[0]!.findings.length, 1);
		assert.equal(groups[0]!.findings[0]!.severity, "warn");
		assert.equal(groups[0]!.findings[0]!.detail, "Bot token has admin scope.");
		assert.equal(groups[0]!.findings[0]!.checkId, "slack.warning");
	});

	it("supports async finding/warning methods + honors resolveAccountIds ordering", async () => {
		const seenAccounts: string[] = [];
		registerChannelSecurityAdapter("telegram", {
			collectAuditFindings: async (c) => {
				seenAccounts.push(c.accountId);
				return c.accountId === "a1"
					? [{ checkId: "t.x", severity: "info", title: "t", detail: "d" }]
					: [];
			},
		});
		const groups = await collectChannelSecurityAudit({
			cfg: CFG,
			resolveAccountIds: () => ["a1", "a2"],
		});
		assert.deepEqual(seenAccounts, ["a1", "a2"]);
		assert.equal(groups[0]!.findings.length, 1);
	});

	it("a throwing adapter never breaks the audit (skipped, others still collected)", async () => {
		registerChannelSecurityAdapter("telegram", {
			collectAuditFindings: () => {
				throw new Error("boom");
			},
		});
		registerChannelSecurityAdapter("slack", {
			collectAuditFindings: () => [{ checkId: "s.ok", severity: "info", title: "s", detail: "d" }],
		});
		const groups = await collectChannelSecurityAudit({ cfg: CFG });
		// telegram threw → contributes nothing; slack still collected.
		assert.equal(groups.length, 1);
		assert.equal(groups[0]!.channelId, "slack");
	});
});

/* ─────────────────────────── clear-on-reload (the stale-slot-leak fix) ───────────────────────────
 *
 * BUG this proves: `startExtensions()` syncs the messaging + security registries
 * with a `.set()`-only seam that NEVER removes a slot. So when an operator
 * removed/edited a slot-bearing channel and issued `system.reload`, the gateway's
 * `stopExtensions()` used to leave the STALE adapter in place: a stale security
 * adapter kept TIGHTENING DM policy (security-relevant) and a stale messaging
 * adapter kept rewriting outbound targets. The fix has `stopExtensions()` clear
 * all three registries on teardown — modeled here as `clear*Registry()`.
 *
 * This case reproduces the exact reload sequence on the registries directly
 * (sync from a slot-bearing plugin list → clear → re-sync from the CHANGED/empty
 * list) and asserts the removed adapter no longer participates.
 */
describe("clear-on-reload: a removed slot-bearing channel does not leak across a reload", () => {
	// A messaging adapter that ALWAYS rewrites the outbound target (so a leak is
	// detectable: a passthrough means the adapter is gone).
	function rewritingMessaging(): ChannelMessagingAdapter {
		return {
			parseExplicitTarget: () => null,
			normalizeTarget: () => "rewritten-by-stale-adapter",
		};
	}

	it("security: a removed adapter no longer tightens; messaging: outbound passes through raw", async () => {
		// (1) Initial boot — a "fancychat" channel ships BOTH a security adapter
		//     (owner = pairing, i.e. tightens an open base) and a messaging adapter
		//     (rewrites every target). `startExtensions()` syncs from the plugin list.
		const securityAdapter: ChannelSecurityAdapter = { resolveDmPolicy: () => "owner" };
		syncChannelSecurityAdaptersFromPlugins([{ id: "fancychat", security: securityAdapter }]);
		syncChannelMessagingAdaptersFromPlugins([{ id: "fancychat", messaging: rewritingMessaging() }]);

		// Sanity: while loaded, the security adapter TIGHTENS open → pairing and the
		// messaging adapter rewrites the outbound target.
		assert.equal(
			consultChannelDmPolicy({ channelId: "fancychat", base: "open", ctx: ctx() }),
			"pairing",
		);
		assert.deepEqual(listChannelSecurityAdapters(), ["fancychat"]);
		const before = await resolveOutboundTarget({ channelId: "fancychat", to: "Alex" });
		assert.equal(before.to, "rewritten-by-stale-adapter");
		assert.equal(before.usedAdapter, true);

		// (2) Operator removes "fancychat" and reloads. `stopExtensions()` now CLEARS
		//     the process-wide slot registries (the fix under test) …
		clearChannelSecurityRegistry();
		clearChannelMessagingRegistry();
		//     … then `startExtensions()` re-syncs from the NEW channel list, which no
		//     longer contains "fancychat" (modeled as an empty list).
		syncChannelSecurityAdaptersFromPlugins([]);
		syncChannelMessagingAdaptersFromPlugins([]);

		// (3) The removed adapters must be GONE: the registry no longer carries them.
		assert.deepEqual(listChannelSecurityAdapters(), []);
		assert.equal(getChannelSecurityAdapter("fancychat"), undefined);

		// Security: `consultChannelDmPolicy(base)` returns base — NO stale tighten.
		assert.equal(
			consultChannelDmPolicy({ channelId: "fancychat", base: "open", ctx: ctx() }),
			"open",
		);
		// Messaging: `resolveOutboundTarget` passes the raw `to` through, byte-for-byte.
		const after = await resolveOutboundTarget({ channelId: "fancychat", to: "Alex" });
		assert.equal(after.to, "Alex");
		assert.equal(after.usedAdapter, false);
	});

	it("clear functions are idempotent + total (safe to call on shutdown with nothing registered)", () => {
		// No registrations — clearing must not throw and leaves the registries empty.
		clearChannelSecurityRegistry();
		clearChannelMessagingRegistry();
		assert.deepEqual(listChannelSecurityAdapters(), []);
		assert.equal(getChannelSecurityAdapter("anything"), undefined);
	});
});
