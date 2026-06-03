/**
 * Onboarding-time defaults applied to brigade.json when the wizard finishes.
 *
 * The runtime fallbacks in src/agents/routing/session-key.ts and
 * src/agents/routing/resolve-route.ts coalesce a missing `session.dmScope`
 * to `"main"`, which silently collapses every DM into the agent's single
 * `agent:<id>:main` lane (shared transcript + memory across peers). That's
 * the wrong default for any install with >= 2 DM senders, so the secure
 * default is seeded HERE at onboarding time — operator-explicit values are
 * preserved (nullish-coalesce semantics).
 */

import type { BrigadeConfig, DmScope } from "../../config/types.js";

/** Default DM session scope seeded by `brigade onboard`. */
export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";

/**
 * Stamp the secure DM-scope default onto a brigade.json mutation if (and
 * only if) the operator hasn't already chosen one. Mirrors upstream
 * `applyLocalSetupWorkspaceConfig` — explicit `main` / `per-peer` /
 * `per-channel-peer` / `per-account-channel-peer` values pass through
 * untouched.
 */
export function applyOnboardingSessionDefaults(cfg: BrigadeConfig): BrigadeConfig {
	const session = cfg.session ?? {};
	const existing = typeof session.dmScope === "string" ? session.dmScope.trim() : "";
	const dmScope: DmScope = existing.length > 0 ? (session.dmScope as DmScope) : ONBOARDING_DEFAULT_DM_SCOPE;
	return {
		...cfg,
		session: {
			...session,
			dmScope,
		},
	};
}
