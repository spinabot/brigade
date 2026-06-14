/**
 * Org-hierarchy skill visibility (Primitive #5 × the virtual-office layer).
 *
 * Resolves which OTHER agents' workspace skills a given agent may see, by
 * walking the org graph's `reportsTo` relationships. Off unless
 * `skills.orgAccess.enabled` is set. Uses the POLICY graph (`deriveOrgGraph`),
 * so an `org.a2a.mode: "explicit"` install — where the operator opted into the
 * flat allow-matrix instead of graph edges — turns this off, exactly like A2A.
 *
 * The agent's OWN skills never come through here (they're discovered from its
 * workspace root directly); this is purely the cross-agent surface.
 */

import type { BrigadeConfig, BrigadeSkillsOrgAccessConfig } from "../../config/io.js";
import { deriveOrgGraph } from "../org/derive-graph.js";

/** Minimal shape we read off the org graph members map. */
type MembersLike = Record<string, { reportsTo?: string | null } | undefined>;

const CHAIN_GUARD_MAX = 64;

/**
 * The set of other agent ids whose workspace skills `agentId` may see.
 *
 *   - `down` (default): agents that report to `agentId` (its subordinates).
 *     Direct reports only unless `transitive` (then the whole sub-tree).
 *   - `up`: `agentId`'s manager chain (direct manager only unless `transitive`).
 *   - `both`: union of the two.
 *
 * Returns `[]` when the feature is off, no policy graph exists (legacy /
 * explicit mode), the agent isn't an org member, or it has no eligible peers.
 * The agent's own id is never included.
 */
export function resolveOrgVisibleSkillAgents(
	config: BrigadeConfig,
	agentId: string | undefined,
	access: BrigadeSkillsOrgAccessConfig | undefined,
): string[] {
	if (!access?.enabled) return [];
	const id = (agentId ?? "").trim();
	if (!id) return [];

	const graph = deriveOrgGraph(config);
	if (!graph) return [];
	const members = graph.members as MembersLike;
	if (!members[id]) return []; // the agent isn't part of the org

	const direction = access.direction ?? "down";
	const transitive = access.transitive === true;
	const visible = new Set<string>();

	if (direction === "down" || direction === "both") {
		for (const candidate of Object.keys(members)) {
			if (candidate === id) continue;
			if (reportsToReaches(members, candidate, id, transitive)) visible.add(candidate);
		}
	}

	if (direction === "up" || direction === "both") {
		// Walk the agent's own manager chain upward.
		const guard = new Set<string>([id]);
		let cursor = members[id]?.reportsTo ?? null;
		let steps = 0;
		while (cursor && !guard.has(cursor) && steps < CHAIN_GUARD_MAX) {
			if (members[cursor]) visible.add(cursor);
			guard.add(cursor);
			if (!transitive) break; // direct manager only
			cursor = members[cursor]?.reportsTo ?? null;
			steps += 1;
		}
	}

	visible.delete(id);
	return [...visible].sort();
}

/** True when `candidate`'s reportsTo chain reaches `target` (one hop unless transitive). */
function reportsToReaches(
	members: MembersLike,
	candidate: string,
	target: string,
	transitive: boolean,
): boolean {
	const direct = members[candidate]?.reportsTo ?? null;
	if (direct === target) return true;
	if (!transitive) return false;
	const guard = new Set<string>([candidate]);
	let cursor = direct;
	let steps = 0;
	while (cursor && !guard.has(cursor) && steps < CHAIN_GUARD_MAX) {
		if (cursor === target) return true;
		guard.add(cursor);
		cursor = members[cursor]?.reportsTo ?? null;
		steps += 1;
	}
	return false;
}
