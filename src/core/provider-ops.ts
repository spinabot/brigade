/**
 * Provider-key removal behind the `provider.remove` gateway RPC.
 *
 * The genuine gap: `add-provider` adds a key, but there was NO way to REMOVE one
 * over the gateway — keys live in `auth-profiles.json` (not config, so config.set
 * can't reach them) and no tool exposes removal. This closes it. Operator-scoped
 * per-agent (no per-session guard — allowlisted).
 */

import { readProfiles, writeProfiles } from "../auth/profiles.js";
import { DEFAULT_AGENT_ID } from "../config/paths.js";

export interface ProviderRemoveResult {
	ok: boolean;
	providerId: string;
	agentId: string;
	removed: number;
	reason?: string;
}
export function handleProviderRemove(params: unknown): ProviderRemoveResult {
	const p = (params ?? {}) as { providerId?: string; agentId?: string };
	const providerId = (p.providerId ?? "").trim().toLowerCase();
	const agentId = (p.agentId ?? "").trim() || DEFAULT_AGENT_ID;
	if (!providerId) return { ok: false, providerId, agentId, removed: 0, reason: "missing 'providerId'" };
	const file = readProfiles(agentId);
	let removed = 0;
	for (const [key, profile] of Object.entries(file.profiles)) {
		if ((profile.provider ?? "").trim().toLowerCase() === providerId) {
			delete file.profiles[key];
			removed++;
		}
	}
	if (removed > 0) writeProfiles(agentId, file);
	return { ok: removed > 0, providerId, agentId, removed, ...(removed === 0 ? { reason: "no key found for that provider" } : {}) };
}
