/**
 * Channel-security registry — the process-wide lookup behind "does channel
 * <id> ship a SUPPLEMENTARY DM-policy / audit opinion?".
 *
 * Mirrors `channel-messaging-registry.ts` exactly: a dynamic registration seam
 * keyed by lowercased channel id, resolved through one process-global singleton
 * so a hot reload (or CLI + gateway in one process) shares a single slot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THIS IS — and what it is NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The AUTHORITATIVE access-control engine lives in `access-control/*` +
 * `inbound-pipeline.ts` (store+config allow-from merge, owner bootstrap,
 * `/start`/`/pending`/`/approve`/`/deny`, the per-message `evaluateAccess`
 * decision). That engine is NOT replaced by anything here.
 *
 * This registry adds the OPTIONAL author-facing `ChannelSecurityAdapter`
 * surface on TOP of that engine:
 *
 *   1. `security.resolveDmPolicy` — a channel plugin MAY register a
 *      supplementary DM-policy opinion. The pipeline consults it right AFTER
 *      its own local `resolveDmPolicy(cfg, adapter.id)` read. PRECEDENCE is
 *      strict: the central config stays authoritative, and a registered
 *      adapter may only ever TIGHTEN the effective policy (owner-only > allow-
 *      list > open), NEVER loosen it. See {@link reconcileDmPolicy}.
 *   2. `security.collectWarnings` / `security.collectAuditFindings` — surfaced
 *      by {@link collectChannelSecurityAudit} for `brigade doctor`.
 *
 * A channel with NO `security` adapter simply never registers; the pipeline's
 * local policy then stands UNCHANGED, so back-compat is preserved by
 * construction.
 */

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { DmPolicy } from "./access-control/types.js";
import type {
	ChannelSecurityAdapter,
	ChannelSecurityAuditFinding,
	ChannelSecurityContext,
	ChannelSecurityDmPolicy,
} from "./types.adapters.js";

/** Process-global slot so a hot reload (or CLI+gateway in one process) shares one registry. */
const REGISTRY_STATE_KEY = Symbol.for("brigade.channelSecurityRegistry.state");

interface ChannelSecurityRegistryState {
	/** Dynamically-registered security adapters, keyed by lowercased channel id. */
	byChannelId: Map<string, ChannelSecurityAdapter>;
}

function createState(): ChannelSecurityRegistryState {
	return { byChannelId: new Map() };
}

function getState(): ChannelSecurityRegistryState {
	return resolveGlobalSingleton<ChannelSecurityRegistryState>(REGISTRY_STATE_KEY, createState);
}

/**
 * Register (or replace) a channel's SUPPLEMENTARY security adapter. The plugin
 * engine calls this when a channel module that declares `plugin.security`
 * registers, so the inbound pipeline can consult it as an optional consult on
 * top of the central access-control engine. Last registration per id wins.
 * No-ops on an empty/unusable id.
 */
export function registerChannelSecurityAdapter(
	channelId: string | null | undefined,
	adapter: ChannelSecurityAdapter,
): void {
	const id = normalizeOptionalLowercaseString(channelId);
	if (!id) return;
	getState().byChannelId.set(id, adapter);
}

/**
 * Bulk-register every security adapter declared on a plugin list (skipping
 * plugins that omit the slot). The gateway bootstrap calls this once with its
 * `bundledChannelPlugins` — parallel to `syncChannelMessagingAdaptersFromPlugins`
 * — so the pipeline can consult a per-channel security opinion. Plugins WITHOUT
 * a `security` adapter are simply skipped, leaving the central policy unchanged.
 */
export function syncChannelSecurityAdaptersFromPlugins(
	plugins: ReadonlyArray<{ id: string; security?: ChannelSecurityAdapter }>,
): void {
	for (const plugin of plugins) {
		if (plugin.security) registerChannelSecurityAdapter(plugin.id, plugin.security);
	}
}

/** Test-only — drop every dynamically-registered security adapter. */
export function resetChannelSecurityRegistryForTests(): void {
	getState().byChannelId.clear();
}

/**
 * Look up a channel's registered security adapter by id (or alias the caller
 * already normalized). Returns `undefined` when the channel registered none —
 * the caller then leaves its local policy untouched. Case-insensitive.
 */
export function getChannelSecurityAdapter(
	channelId: string | null | undefined,
): ChannelSecurityAdapter | undefined {
	const key = normalizeOptionalLowercaseString(channelId);
	if (!key) return undefined;
	return getState().byChannelId.get(key);
}

/** Snapshot the registered (channelId) keys — diagnostics only. */
export function listChannelSecurityAdapters(): string[] {
	return [...getState().byChannelId.keys()].sort();
}

/* -------------------------------------------------------------------------
 * DM-policy vocabulary reconciliation (the adapter enum ⇄ the pipeline enum)
 *
 * The adapter's `ChannelSecurityDmPolicy` is the AUTHOR-FACING vocabulary
 * ("who may DM this account"); the pipeline's `DmPolicy` is the engine's
 * vocabulary. They are DIFFERENT alphabets on purpose — a channel author thinks
 * in "owner / allow-from / all", the engine thinks in "pairing / allowlist /
 * open / disabled". This module owns the ONE total, documented mapping between
 * them so neither side has to know the other's words.
 *
 * The mapping rides a single TIGHTNESS LADDER (0 = loosest, 3 = tightest):
 *
 *   adapter "all"        ⇄ pipeline "open"       — rank 0  (anyone may DM)
 *   adapter "allow-from" ⇄ pipeline "allowlist"  — rank 1  (only listed senders)
 *   adapter "owner"      ⇄ pipeline "pairing"    — rank 2  (owner + approved; strangers must pair)
 *   adapter "disabled"   ⇄ pipeline "disabled"   — rank 3  (every DM dropped)
 *
 * `"owner"` maps to `"pairing"` because pairing IS the owner-bootstrap state:
 * the owner (and anyone they approve) gets in, every stranger is challenged —
 * i.e. "owner-gated". It is strictly TIGHTER than a static `allowlist` (an
 * un-approved stranger is challenged, not silently let in by a pre-seeded list)
 * yet looser than a full `disabled` lockdown.
 * --------------------------------------------------------------------- */

/**
 * Tightness rank of a pipeline {@link DmPolicy}: higher = more restrictive.
 * The ladder the precedence rule compares on.
 */
export function dmPolicyTightness(policy: DmPolicy): number {
	switch (policy) {
		case "open":
			return 0;
		case "allowlist":
			return 1;
		case "pairing":
			return 2;
		case "disabled":
			return 3;
	}
}

/**
 * Translate an author-facing {@link ChannelSecurityDmPolicy} into the pipeline's
 * {@link DmPolicy} vocabulary. Total over the enum; the mapping is the single
 * source of truth documented above.
 */
export function securityDmPolicyToDmPolicy(policy: ChannelSecurityDmPolicy): DmPolicy {
	switch (policy) {
		case "all":
			return "open";
		case "allow-from":
			return "allowlist";
		case "owner":
			return "pairing";
		case "disabled":
			return "disabled";
	}
}

/**
 * Reconcile a channel's supplementary security verdict with the central policy.
 *
 * PRECEDENCE (the whole point): the central `base` policy is AUTHORITATIVE. A
 * registered security adapter may only ever TIGHTEN — it returns the more-
 * restrictive of (base, adapter-opinion) on the tightness ladder. It can NEVER
 * loosen: an adapter that says "open" while the config says "pairing" is
 * ignored (the config wins). A `null`/absent opinion ("channel takes no
 * opinion; defer to the gateway default") leaves `base` exactly as-is.
 *
 * @returns the effective `DmPolicy` (always === `base` or strictly tighter).
 */
export function reconcileDmPolicy(
	base: DmPolicy,
	opinion: ChannelSecurityDmPolicy | null | undefined,
): DmPolicy {
	if (opinion == null) return base;
	const adapterPolicy = securityDmPolicyToDmPolicy(opinion);
	// Tighten-only: keep whichever sits higher on the tightness ladder.
	return dmPolicyTightness(adapterPolicy) > dmPolicyTightness(base) ? adapterPolicy : base;
}

/**
 * Consult the channel's registered security adapter (if any) for a DM-policy
 * opinion and reconcile it with the central `base` policy under the strict
 * TIGHTEN-ONLY precedence rule. Returns `base` UNCHANGED when no adapter is
 * registered, the adapter omits `resolveDmPolicy`, it returns `null`, or it
 * throws — so a channel that doesn't opt in (or a buggy one) leaves the
 * authoritative policy byte-identical to today. NEVER throws.
 */
export function consultChannelDmPolicy(params: {
	channelId: string;
	base: DmPolicy;
	ctx: ChannelSecurityContext;
}): DmPolicy {
	const { channelId, base, ctx } = params;
	const adapter = getChannelSecurityAdapter(channelId);
	if (!adapter || typeof adapter.resolveDmPolicy !== "function") return base;
	try {
		const opinion = adapter.resolveDmPolicy(ctx);
		return reconcileDmPolicy(base, opinion);
	} catch {
		// A misbehaving adapter must never break inbound gating — keep the
		// authoritative central policy.
		return base;
	}
}

/* -------------------------------------------------------------------------
 * Security audit collection (the doctor surface)
 * --------------------------------------------------------------------- */

/** One channel's findings, grouped under its id, from {@link collectChannelSecurityAudit}. */
export interface ChannelSecurityAuditGroup {
	channelId: string;
	findings: ChannelSecurityAuditFinding[];
}

/**
 * Iterate every registered security adapter and collect its structured audit
 * findings (`checkId`/`severity`/`title`/`detail`/`remediation`) plus its
 * free-text warnings (folded into `info` findings so a single rendering path
 * covers both). Used by `brigade doctor`'s per-channel security section.
 *
 * Total + defensive: an adapter that omits both methods contributes nothing; an
 * adapter that throws is skipped (its failure can never break `doctor`). The
 * per-call {@link ChannelSecurityContext} is built from the supplied config +
 * the ordered account ids the caller resolved.
 */
export async function collectChannelSecurityAudit(params: {
	/** The Brigade super-config the audit reads (passed through verbatim). */
	cfg: ChannelSecurityContext["cfg"];
	/**
	 * Resolve the ordered account ids to audit for a channel. When omitted, the
	 * audit runs once per channel with an empty account scope (`accountId: ""`)
	 * — enough for channels whose findings are config-global.
	 */
	resolveAccountIds?: (channelId: string) => string[];
}): Promise<ChannelSecurityAuditGroup[]> {
	const { cfg, resolveAccountIds } = params;
	const out: ChannelSecurityAuditGroup[] = [];
	for (const channelId of listChannelSecurityAdapters()) {
		const adapter = getChannelSecurityAdapter(channelId);
		if (!adapter) continue;
		const findings: ChannelSecurityAuditFinding[] = [];
		const accountIds = resolveAccountIds?.(channelId) ?? [""];
		const orderedAccountIds = accountIds.length > 0 ? accountIds : [""];
		for (const accountId of orderedAccountIds) {
			const ctx: ChannelSecurityContext = { account: undefined, accountId, cfg };
			// Structured findings.
			if (typeof adapter.collectAuditFindings === "function") {
				try {
					const got = await adapter.collectAuditFindings({
						...ctx,
						sourceConfig: cfg,
						orderedAccountIds,
					});
					if (Array.isArray(got)) findings.push(...got);
				} catch {
					/* a broken adapter never breaks the audit */
				}
			}
			// Free-text warnings → folded into `info` findings so doctor renders
			// one shape. Keyed by account so multi-account warnings don't collide.
			if (typeof adapter.collectWarnings === "function") {
				try {
					const warnings = await adapter.collectWarnings(ctx);
					if (Array.isArray(warnings)) {
						for (const w of warnings) {
							if (typeof w === "string" && w.trim()) {
								findings.push({
									checkId: `${channelId}.warning`,
									severity: "warn",
									title: "Channel security warning",
									detail: w.trim(),
								});
							}
						}
					}
				} catch {
					/* a broken adapter never breaks the audit */
				}
			}
		}
		if (findings.length > 0) out.push({ channelId, findings });
	}
	return out;
}
