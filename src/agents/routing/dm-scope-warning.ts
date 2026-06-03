/**
 * Boot-time `dmScope` default-collapse warning.
 *
 * Brigade preserves the upstream reference codebase's runtime fallback of
 * `dmScope: "main"` for back-compat — every DM on every channel collapses
 * into the agent's single `agent:<id>:main` session, sharing transcript +
 * memory. That's the right default for a one-peer install, but silently
 * the wrong choice the moment the operator has two distinct peers on the
 * same channel: their conversations cross-pollinate.
 *
 * `brigade onboard` (since Wave N3) seeds `session.dmScope =
 * "per-channel-peer"` automatically. This helper warns operators who skipped
 * onboarding or upgraded from a pre-default install. Three trip points:
 *
 *   1. Multi-peer collapse (high signal): `cfg.session.dmScope` unset AND
 *      at least one channel has >= 2 distinct peer bindings.
 *   2. Configured-channel collapse (medium signal — Wave N3, bug #5): unset
 *      AND any channel binding exists at all. Catches the "user just wired
 *      WhatsApp, hasn't sent a second peer yet, but every future DM will
 *      land in `main`" scenario before the data crosses streams.
 *   3. Explicit-main with DM bindings: operator opted into "main" but has
 *      DM-capable channel bindings present. Same risk as above; surface
 *      the remediation now rather than letting transcripts merge silently.
 */

import type { BrigadeConfig } from "../../config/types.js";
import { listBindings } from "./bindings.js";

export type DmScopeWarningKind =
	| "unset-multi-peer"
	| "unset-with-channel-bindings"
	| "explicit-main-with-channel-bindings";

export interface DmScopeWarning {
	channel: string;
	peerCount: number;
	samplePeers: string[];
	kind: DmScopeWarningKind;
}

/** Scan bindings; return warning records (one per channel that trips the heuristic). */
export function detectDmScopeCollapseRisk(cfg: BrigadeConfig | undefined | null): DmScopeWarning[] {
	const rawDmScope = (cfg?.session as { dmScope?: unknown } | undefined)?.dmScope;
	const dmScope = typeof rawDmScope === "string" ? rawDmScope.trim() : "";
	const isUnset = dmScope.length === 0;
	const isExplicitMain = dmScope === "main";
	if (!isUnset && !isExplicitMain) {
		// Operator already picked a safe explicit scope — no warning needed.
		return [];
	}
	const bindings = listBindings(cfg ?? null);
	if (bindings.length === 0) return [];
	const peersByChannel = new Map<string, Set<string>>();
	for (const entry of bindings) {
		const channel = (entry.match?.channel ?? "").trim().toLowerCase();
		if (!channel) continue;
		const peerId = ((entry.match?.peer as { id?: unknown } | undefined)?.id ?? "")
			.toString()
			.trim();
		let set = peersByChannel.get(channel);
		if (!set) {
			set = new Set<string>();
			peersByChannel.set(channel, set);
		}
		// Wildcards count toward "channel is wired" but not toward unique-peer counts.
		if (peerId && peerId !== "*") set.add(peerId);
	}
	if (peersByChannel.size === 0) return [];
	const warnings: DmScopeWarning[] = [];
	for (const [channel, peers] of peersByChannel.entries()) {
		const distinctPeers = peers.size;
		if (isUnset && distinctPeers >= 2) {
			warnings.push({
				channel,
				peerCount: distinctPeers,
				samplePeers: [...peers].slice(0, 3),
				kind: "unset-multi-peer",
			});
			continue;
		}
		if (isUnset) {
			warnings.push({
				channel,
				peerCount: distinctPeers,
				samplePeers: [...peers].slice(0, 3),
				kind: "unset-with-channel-bindings",
			});
			continue;
		}
		if (isExplicitMain) {
			warnings.push({
				channel,
				peerCount: distinctPeers,
				samplePeers: [...peers].slice(0, 3),
				kind: "explicit-main-with-channel-bindings",
			});
		}
	}
	return warnings;
}

/** Format a single warning record into a one-line operator-facing string. */
export function formatDmScopeWarning(w: DmScopeWarning): string {
	const peerList = w.samplePeers.join(", ");
	const tail =
		`Set session.dmScope to "per-peer" (cross-channel collapse via identityLinks), ` +
		`"per-channel-peer", or "per-account-channel-peer" in brigade.json ` +
		`(or run \`brigade onboard\` to seed the secure default) to isolate sessions.`;
	switch (w.kind) {
		case "unset-multi-peer":
			return (
				`channel "${w.channel}" has ${w.peerCount} peer bindings (e.g. ${peerList}) but ` +
				`session.dmScope is unset — every DM will collapse into the agent's main session, ` +
				`sharing transcript + memory across peers. ${tail}`
			);
		case "unset-with-channel-bindings":
			return (
				`channel "${w.channel}" is configured but session.dmScope is unset — every DM on ` +
				`this channel will collapse into the agent's main session, sharing transcript + ` +
				`memory across peers as soon as a second peer messages. ${tail}`
			);
		case "explicit-main-with-channel-bindings":
			return (
				`session.dmScope="main" with channel "${w.channel}" bindings present — every DM ` +
				`on this channel shares one session/transcript/memory across peers. ${tail}`
			);
	}
}
