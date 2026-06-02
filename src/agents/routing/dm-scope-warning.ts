/**
 * Boot-time `dmScope` default-collapse warning.
 *
 * Brigade preserves the upstream reference codebase's default of
 * `dmScope: "main"` for back-compat — every DM on every channel collapses
 * into the agent's single `agent:<id>:main` session, sharing transcript +
 * memory. That's the right default for a one-peer install, but silently
 * the wrong choice the moment the operator has two distinct peers on the
 * same channel: their conversations cross-pollinate.
 *
 * This helper inspects the loaded config and emits a single warn-level log
 * when both conditions hold:
 *
 *   1. `cfg.session.dmScope` is unset / null / empty (operator never picked).
 *   2. At least one channel's bindings reference >= 2 distinct peer ids.
 *
 * The fix message points the operator at `session.dmScope: "per-peer"`
 * (cross-channel collapse via `identityLinks`) or the more granular
 * `per-channel-peer` / `per-account-channel-peer` scopes.
 */

import type { BrigadeConfig } from "../../config/types.js";
import { listBindings } from "./bindings.js";

export interface DmScopeWarning {
	channel: string;
	peerCount: number;
	samplePeers: string[];
}

/** Scan bindings; return warning records (one per channel that trips the heuristic). */
export function detectDmScopeCollapseRisk(cfg: BrigadeConfig | undefined | null): DmScopeWarning[] {
	const dmScope = (cfg?.session as { dmScope?: unknown } | undefined)?.dmScope;
	if (typeof dmScope === "string" && dmScope.trim().length > 0) {
		// Operator already picked an explicit scope — no warning needed.
		return [];
	}
	const bindings = listBindings(cfg ?? null);
	if (bindings.length === 0) return [];
	const peersByChannel = new Map<string, Set<string>>();
	for (const entry of bindings) {
		const channel = (entry.match?.channel ?? "").trim().toLowerCase();
		const peerId = ((entry.match?.peer as { id?: unknown } | undefined)?.id ?? "")
			.toString()
			.trim();
		if (!channel || !peerId || peerId === "*") continue;
		let set = peersByChannel.get(channel);
		if (!set) {
			set = new Set<string>();
			peersByChannel.set(channel, set);
		}
		set.add(peerId);
	}
	const warnings: DmScopeWarning[] = [];
	for (const [channel, peers] of peersByChannel.entries()) {
		if (peers.size >= 2) {
			warnings.push({
				channel,
				peerCount: peers.size,
				samplePeers: [...peers].slice(0, 3),
			});
		}
	}
	return warnings;
}

/** Format a single warning record into a one-line operator-facing string. */
export function formatDmScopeWarning(w: DmScopeWarning): string {
	const peerList = w.samplePeers.join(", ");
	return (
		`channel "${w.channel}" has ${w.peerCount} peer bindings (e.g. ${peerList}) but ` +
		`session.dmScope is unset — every DM will collapse into the agent's main session, ` +
		`sharing transcript + memory across peers. Set session.dmScope to "per-peer" ` +
		`(cross-channel collapse via identityLinks), "per-channel-peer", or ` +
		`"per-account-channel-peer" in brigade.json to isolate sessions.`
	);
}
